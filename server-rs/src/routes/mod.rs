//! HTTP route handlers. Ported incrementally from `proxy/server.js`.
//!
//! This module currently covers the DB-backed read endpoints. Scraping,
//! predictions, push and chat are added in later steps.

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::AppState;

mod chat;
mod predictions;
mod push;

/// Routes merged into the main router under their full `/api/...` paths.
pub fn api_router() -> Router<AppState> {
    Router::new()
        .route("/api/ticklist", get(ticklist))
        .route("/api/observations", get(observations))
        .route("/api/social-feed", get(social_feed))
        .route("/api/rescrape", post(rescrape))
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

// ── GET /api/social-feed ────────────────────────────────────────────────
/// Parse an opaque keyset cursor `"<YYYY-MM-DD>,<time>,<id>"` (the sort key of
/// the last item of the previous page). Returns `None` for any malformed input
/// — wrong field count, invalid date, or a non-numeric id — so a bad cursor
/// becomes a 400 rather than a panic or a silent full-table scan. The `time`
/// field may be empty (observations without a time sort as '').
fn parse_feed_cursor(s: &str) -> Option<(String, String, i64)> {
    let parts: Vec<&str> = s.split(',').collect();
    if parts.len() != 3 {
        return None;
    }
    let date = parts[0];
    if !valid_date(date) {
        return None;
    }
    let id: i64 = parts[2].parse().ok()?;
    Some((date.to_string(), parts[1].to_string(), id))
}

async fn social_feed(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let limit: i64 = q
        .get("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(30)
        .clamp(1, 100);

    let cursor = match q.get("cursor").filter(|s| !s.is_empty()) {
        Some(raw) => match parse_feed_cursor(raw) {
            Some(c) => Some(c),
            None => return err(StatusCode::BAD_REQUEST, "invalid cursor").into_response(),
        },
        None => None,
    };

    let items = match &st.db {
        Some(db) => match db.get_social_feed(limit, cursor).await {
            Ok(items) => items,
            Err(e) => {
                tracing::error!("Social feed read failed: {e}");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to read feed" }))).into_response();
            }
        },
        None => Vec::new(),
    };

    // A page shorter than `limit` means the feed is exhausted → no next cursor.
    let next_cursor = if (items.len() as i64) < limit {
        Value::Null
    } else {
        items
            .last()
            .map(|last| {
                let date = last.get("date").and_then(|v| v.as_str()).unwrap_or("");
                let time = last.get("time").and_then(|v| v.as_str()).unwrap_or("");
                let id = last.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                Value::from(format!("{date},{time},{id}"))
            })
            .unwrap_or(Value::Null)
    };

    Json(json!({ "count": items.len(), "items": items, "nextCursor": next_cursor })).into_response()
}

// ── POST /api/rescrape?date=YYYY-MM-DD ──────────────────────────────────
/// Manually re-scrape a single date and patch the parsed `note`/`pictures` into
/// existing rows' `raw` (see `refresh_observations_for_date`). Intentionally
/// unauthenticated, consistent with the rest of the app; the single-flight
/// guard in `refresh_observations_for_date` already coalesces concurrent calls.
async fn rescrape(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let Some(date) = q.get("date").filter(|d| valid_date(d)).cloned() else {
        return err(StatusCode::BAD_REQUEST, "valid date=YYYY-MM-DD required").into_response();
    };
    if date > today() {
        return err(StatusCode::BAD_REQUEST, "date must not be in the future").into_response();
    }
    if st.db.is_none() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "DB not configured").into_response();
    }

    match crate::push::refresh_observations_for_date(&st, Some(date.clone())).await {
        Ok(inserted) => Json(json!({ "date": date, "inserted": inserted })).into_response(),
        Err(e) => {
            tracing::error!("Rescrape failed for {date}: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Rescrape failed", "detail": e.to_string() }))).into_response()
        }
    }
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

#[cfg(test)]
mod tests {
    use super::parse_feed_cursor;

    #[test]
    fn feed_cursor_round_trips() {
        let c = parse_feed_cursor("2026-07-29,08:15,91422");
        assert_eq!(c, Some(("2026-07-29".to_string(), "08:15".to_string(), 91422)));
    }

    #[test]
    fn feed_cursor_allows_empty_time() {
        // Observations without a time sort as '' — that must round-trip.
        let c = parse_feed_cursor("2026-07-29,,91422");
        assert_eq!(c, Some(("2026-07-29".to_string(), String::new(), 91422)));
    }

    #[test]
    fn feed_cursor_rejects_malformed() {
        assert_eq!(parse_feed_cursor(""), None);
        assert_eq!(parse_feed_cursor("2026-07-29"), None); // too few fields
        assert_eq!(parse_feed_cursor("2026-07-29,08:15"), None); // too few fields
        assert_eq!(parse_feed_cursor("2026-07-29,08:15,91422,extra"), None); // too many
        assert_eq!(parse_feed_cursor("2026/07/29,08:15,91422"), None); // bad date format
        assert_eq!(parse_feed_cursor("not-a-date,08:15,91422"), None); // bad date
        assert_eq!(parse_feed_cursor("2026-07-29,08:15,abc"), None); // non-numeric id
    }
}
