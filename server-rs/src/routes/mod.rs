//! HTTP route handlers. Ported incrementally from `proxy/server.js`.
//!
//! This module currently covers the DB-backed read endpoints. Scraping,
//! predictions, push and chat are added in later steps.

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::json;

use crate::AppState;

mod chat;
mod predictions;
mod push;

/// Routes merged into the main router under their full `/api/...` paths.
pub fn api_router() -> Router<AppState> {
    Router::new()
        .route("/api/ticklist", get(ticklist))
        .route("/api/observations", get(observations))
        .route("/api/locality/:loknr", get(locality))
        .route("/api/localities", get(localities))
        .route("/api/species-map", get(species_map))
        .merge(predictions::router())
        .merge(push::router())
        .merge(chat::router())
}

fn list_name(list_type: &str) -> &'static str {
    match list_type {
        "1" => "Krydsliste DK",
        "2" => "Årsliste DK",
        "3" => "Livslisten DK",
        _ => "Krydsliste",
    }
}

fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(json!({ "error": msg })))
}

// ── GET /api/ticklist ──────────────────────────────────────────────────
async fn ticklist(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let list_type = q.get("listType").cloned().unwrap_or_else(|| "1".to_string());
    let Some(user_id) = q.get("userId").filter(|s| !s.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "userId is required").into_response();
    };
    let Some(db) = &st.db else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "DB not configured").into_response();
    };

    match db.get_ticklist(user_id, &list_type).await {
        Ok(None) => Json(json!({
            "userId": user_id,
            "listType": list_type,
            "listName": list_name(&list_type),
            "total": 0,
            "ticked": 0,
            "birds": [],
            "error": "No cached ticklist; seeded on next notification poll",
        }))
        .into_response(),
        Ok(Some(t)) => {
            let birds = t.birds.as_array().cloned().unwrap_or_default();
            let ticked = birds.iter().filter(|b| b.get("ticked").and_then(|v| v.as_bool()) == Some(true)).count();
            Json(json!({
                "userId": user_id,
                "listType": list_type,
                "listName": list_name(&list_type),
                "total": birds.len(),
                "ticked": ticked,
                "birds": birds,
            }))
            .into_response()
        }
        Err(e) => {
            tracing::error!("Ticklist read failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to read tick list", "detail": e.to_string() }))).into_response()
        }
    }
}

// ── GET /api/observations ──────────────────────────────────────────────
fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

async fn observations(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let date = q.get("date").filter(|d| valid_date(d)).cloned().unwrap_or_else(today);

    // DB-only reader: never scrapes. Returns whatever Postgres holds (empty if
    // unseeded or on read error), matching `readObservationsForDate`.
    let observations = match &st.db {
        Some(db) => db.get_observations_by_date(&date).await.unwrap_or_else(|e| {
            tracing::error!("DB obs read failed: {e}");
            Vec::new()
        }),
        None => Vec::new(),
    };

    Json(json!({ "date": date, "count": observations.len(), "observations": observations }))
}

// ── GET /api/locality/:loknr ───────────────────────────────────────────
async fn locality(State(st): State<AppState>, Path(loknr): Path<String>) -> impl IntoResponse {
    let empty = json!({ "loknr": loknr, "lat": null, "lng": null });
    let Some(db) = &st.db else { return Json(empty); };

    match db.get_locality_coords(&[loknr.clone()]).await {
        Ok(map) => {
            let c = map.get(&loknr).copied().unwrap_or(crate::db::LocalityCoord { lat: None, lng: None });
            Json(json!({ "loknr": loknr, "lat": c.lat, "lng": c.lng }))
        }
        Err(e) => {
            tracing::error!("Locality error: {e}");
            Json(empty)
        }
    }
}

// ── GET /api/localities?ids=a,b,c ──────────────────────────────────────
async fn localities(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let Some(ids) = q.get("ids").filter(|s| !s.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "ids parameter required (comma-separated loknr)").into_response();
    };
    let loknrs: Vec<String> = ids.split(',').filter(|s| !s.is_empty()).take(50).map(String::from).collect();

    let coords = match &st.db {
        Some(db) => match db.get_locality_coords(&loknrs).await {
            Ok(m) => m,
            Err(e) => {
                tracing::error!("Localities error: {e}");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to read localities", "detail": e.to_string() }))).into_response();
            }
        },
        None => loknrs.iter().map(|id| (id.clone(), crate::db::LocalityCoord { lat: None, lng: None })).collect(),
    };

    // Shape: { "<loknr>": { loknr, lat, lng } }
    let mut out = serde_json::Map::new();
    for (id, c) in coords {
        out.insert(id.clone(), json!({ "loknr": id, "lat": c.lat, "lng": c.lng }));
    }
    Json(serde_json::Value::Object(out)).into_response()
}

// ── GET /api/species-map ───────────────────────────────────────────────
// Always served from the in-memory cache refreshed by the background task in
// `main` (the underlying query is a slow full-table scan over `observations`).
// Only computes inline if the cache is still empty (boot prewarm not done).
async fn species_map(State(st): State<AppState>) -> impl IntoResponse {
    {
        let guard = st.species_map.read().await;
        if let Some((_, m)) = guard.as_ref() {
            return Json(json!({ "count": m.len(), "byName": m }));
        }
    }
    let Some(db) = st.db.clone() else { return Json(json!({ "count": 0, "byName": {} })); };
    match db.get_species_map().await {
        Ok(m) => {
            *st.species_map.write().await = Some((std::time::Instant::now(), m.clone()));
            Json(json!({ "count": m.len(), "byName": m }))
        }
        Err(e) => {
            tracing::error!("Species map error: {e}");
            Json(json!({ "count": 0, "byName": {} }))
        }
    }
}
