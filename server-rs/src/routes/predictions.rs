//! AI prediction endpoints — ports of `/api/ai-predictions`, `/api/ai-calendar`
//! and the LLM-free `/api/predictor-dataset` from `proxy/server.js`.

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};

use crate::predictor::{self, CalItem, ClusterOut, DayItem};
use crate::{llm, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/ai-predictions", get(ai_predictions))
        .route("/api/ai-calendar", get(ai_calendar))
        .route("/api/predictor-dataset", get(predictor_dataset))
}

fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<Value>) {
    (code, Json(json!({ "error": msg })))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// DB-only ticklist read (no network), mirroring `fetchTickListData(..)` with
/// `allowNetwork:false`. Returns the stored `birds` array.
async fn fetch_ticklist_birds(st: &AppState, user_id: &str, list_type: &str) -> Option<Vec<Value>> {
    let db = st.db.as_ref()?;
    match db.get_ticklist(user_id, list_type).await {
        Ok(Some(t)) => t.birds.as_array().cloned(),
        _ => None,
    }
}

fn is_missing(b: &Value) -> bool {
    b.get("ticked").and_then(|v| v.as_bool()) != Some(true)
        && b.get("latin").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty())
}

fn missing_latins(birds: &[Value]) -> Vec<String> {
    birds
        .iter()
        .filter(|b| is_missing(b))
        .filter_map(|b| b.get("latin").and_then(|v| v.as_str()).map(String::from))
        .collect()
}

/// lower(latin) → display name, from every bird on the list.
fn latin_to_name(birds: &[Value]) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for b in birds {
        if let Some(latin) = b.get("latin").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            if let Some(name) = b.get("name").and_then(|v| v.as_str()) {
                m.insert(latin.to_lowercase(), name.to_string());
            }
        }
    }
    m
}

fn cluster_json(c: &ClusterOut) -> Value {
    json!({
        "name": c.name,
        "loknr": c.loknr,
        "centroidLat": c.centroid_lat,
        "centroidLng": c.centroid_lng,
        "nearby": c.nearby.iter().map(|n| json!({
            "location": n.location,
            "loknr": n.loknr,
            "distKm": n.dist_km,
            "score": n.score,
        })).collect::<Vec<_>>(),
    })
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

// ── GET /api/ai-predictions ────────────────────────────────────────────
async fn ai_predictions(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    if !st.cfg.ai_configured() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "AI not configured. Set AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_KEY, AZURE_FOUNDRY_DEPLOYMENT.").into_response();
    }
    let Some(db) = st.db.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "DB not configured. Predictor requires Postgres.").into_response();
    };
    let (Some(user_id), Some(lat), Some(lng)) = (
        q.get("userId").filter(|s| !s.is_empty()),
        q.get("lat").and_then(|s| s.parse::<f64>().ok()),
        q.get("lng").and_then(|s| s.parse::<f64>().ok()),
    ) else {
        return err(StatusCode::BAD_REQUEST, "userId, lat, lng required").into_response();
    };
    let list_type = q.get("listType").cloned().unwrap_or_else(|| "1".to_string());

    let Some(birds) = fetch_ticklist_birds(&st, user_id, &list_type).await else {
        return err(StatusCode::NOT_FOUND, "tickList not found").into_response();
    };
    if birds.is_empty() {
        return err(StatusCode::NOT_FOUND, "tickList not found").into_response();
    }
    let missing = missing_latins(&birds);
    if missing.is_empty() {
        return Json(json!({ "generatedAt": now_iso(), "predictions": [], "note": "Ingen manglende arter" })).into_response();
    }

    let items = match predictor::rank_for_day(&db, lat, lng, &missing).await {
        Ok(it) => it,
        Err(e) => {
            tracing::error!("AI predictions error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to generate predictions", "detail": e.to_string() }))).into_response();
        }
    };
    if items.is_empty() {
        return Json(json!({
            "generatedAt": now_iso(), "predictions": [],
            "note": "Ingen historiske observationer for manglende arter i denne tid af året",
        })).into_response();
    }

    let names = latin_to_name(&birds);
    let next_dates: Vec<String> = (0..7)
        .map(|i| (chrono::Local::now().date_naive() + chrono::Duration::days(i)).format("%Y-%m-%d").to_string())
        .collect();

    let kandidater: Vec<Value> = items.iter().map(|it| day_payload_item(it, &names)).collect();
    let user_payload = json!({
        "brugerLokation": { "lat": lat, "lng": lng },
        "mulige_datoer": next_dates,
        "kandidater": kandidater,
    });

    let body = json!({
        "messages": [
            { "role": "system", "content": PRED_SYSTEM_PROMPT },
            { "role": "user", "content": user_payload.to_string() },
        ],
        "response_format": predictions_response_format(),
        "temperature": 0.2,
    });

    match call_and_extract(&st, body).await {
        Ok(parsed) => Json(json!({
            "generatedAt": now_iso(),
            "predictions": parsed.get("predictions").cloned().unwrap_or_else(|| json!([])),
        })).into_response(),
        Err(e) => {
            tracing::error!("AI predictions error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to generate predictions", "detail": e.to_string() }))).into_response()
        }
    }
}

fn day_payload_item(it: &DayItem, names: &HashMap<String, String>) -> Value {
    json!({
        "latin": it.latin,
        "navn": names.get(&it.latin.to_lowercase()).cloned().or_else(|| it.species.clone()),
        "omraade": {
            "navn": it.cluster.name,
            "loknr": it.cluster.loknr,
            "naerliggende": it.cluster.nearby.iter().map(|n| json!({
                "lokalitet": n.location, "loknr": n.loknr, "distKm": n.dist_km,
            })).collect::<Vec<_>>(),
        },
        "tillidsbånd": it.band,
        "score": round2(it.score_norm),
        "evidens": it.evidence.iter().map(|e| json!({
            "date": e.date, "lokalitet": e.location, "antal": e.count,
            "observatør": e.observer, "adfærd": e.behaviour,
        })).collect::<Vec<_>>(),
    })
}

// ── GET /api/ai-calendar ───────────────────────────────────────────────
async fn ai_calendar(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    if !st.cfg.ai_configured() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "AI not configured. Set AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_KEY, AZURE_FOUNDRY_DEPLOYMENT.").into_response();
    }
    let Some(db) = st.db.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "DB not configured. Predictor requires Postgres.").into_response();
    };
    let month = q.get("month").cloned().unwrap_or_default();
    let Some(user_id) = q.get("userId").filter(|s| !s.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "userId, month (YYYY-MM) required").into_response();
    };
    if !valid_month(&month) {
        return err(StatusCode::BAD_REQUEST, "userId, month (YYYY-MM) required").into_response();
    }
    let list_type = q.get("listType").cloned().unwrap_or_else(|| "1".to_string());

    let Some(birds) = fetch_ticklist_birds(&st, user_id, &list_type).await else {
        return err(StatusCode::NOT_FOUND, "tickList not found").into_response();
    };
    if birds.is_empty() {
        return err(StatusCode::NOT_FOUND, "tickList not found").into_response();
    }
    let missing = missing_latins(&birds);

    let items = match predictor::rank_for_calendar(&db, &month, &missing).await {
        Ok(it) => it,
        Err(e) => {
            tracing::error!("AI calendar error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to generate calendar", "detail": e.to_string() }))).into_response();
        }
    };
    if items.is_empty() {
        return Json(json!({
            "generatedAt": now_iso(), "month": month, "locations": [],
            "note": "Ingen relevante observationer for manglende arter i denne måned",
        })).into_response();
    }

    let names = latin_to_name(&birds);
    let month_names = ["januar","februar","marts","april","maj","juni","juli","august","september","oktober","november","december"];
    let mon_idx: usize = month[5..7].parse::<usize>().unwrap_or(1) - 1;

    let omraader: Vec<Value> = items.iter().map(|it| cal_payload_item(it, &names)).collect();
    let user_payload = json!({
        "maalMaaned": month,
        "maalMaanedNavn": month_names.get(mon_idx).copied().unwrap_or(""),
        "omraader": omraader,
    });

    let body = json!({
        "messages": [
            { "role": "system", "content": CAL_SYSTEM_PROMPT },
            { "role": "user", "content": user_payload.to_string() },
        ],
        "response_format": calendar_response_format(),
        "temperature": 0.2,
    });

    match call_and_extract(&st, body).await {
        Ok(parsed) => {
            // Backfill latin per bird from the species name → latin map.
            let name_to_latin: HashMap<String, String> = birds.iter().filter_map(|b| {
                let latin = b.get("latin").and_then(|v| v.as_str()).filter(|s| !s.is_empty())?;
                let name = b.get("name").and_then(|v| v.as_str())?;
                Some((name.to_lowercase(), latin.to_string()))
            }).collect();

            let locations: Vec<Value> = parsed.get("locations").and_then(|v| v.as_array()).cloned().unwrap_or_default()
                .into_iter().map(|mut loc| {
                    if let Some(birds_arr) = loc.get_mut("birds").and_then(|v| v.as_array_mut()) {
                        for b in birds_arr.iter_mut() {
                            let species = b.get("species").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                            let latin = name_to_latin.get(&species).cloned().unwrap_or_default();
                            if let Some(obj) = b.as_object_mut() {
                                obj.insert("latin".into(), Value::String(latin));
                            }
                        }
                    }
                    loc
                }).collect();

            Json(json!({ "generatedAt": now_iso(), "month": month, "locations": locations })).into_response()
        }
        Err(e) => {
            tracing::error!("AI calendar error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to generate calendar", "detail": e.to_string() }))).into_response()
        }
    }
}

fn cal_payload_item(it: &CalItem, names: &HashMap<String, String>) -> Value {
    json!({
        "navn": it.cluster.name,
        "loknr": it.cluster.loknr,
        "naerliggende": it.cluster.nearby.iter().map(|n| json!({
            "lokalitet": n.location, "loknr": n.loknr, "distKm": n.dist_km,
        })).collect::<Vec<_>>(),
        "arter": it.species.iter().map(|s| json!({
            "latin": s.latin,
            "navn": names.get(&s.latin.to_lowercase()).cloned().or_else(|| s.species.clone()),
            "tillidsbånd": s.band,
            "evidens": s.evidence.iter().map(|e| json!({
                "date": e.date, "lokalitet": e.location, "antal": e.count, "adfærd": e.behaviour,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

// ── GET /api/predictor-dataset (no LLM) ────────────────────────────────
async fn predictor_dataset(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let Some(db) = st.db.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "DB not configured. Predictor requires Postgres.").into_response();
    };
    let Some(user_id) = q.get("userId").filter(|s| !s.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "userId required").into_response();
    };
    let list_type = q.get("listType").cloned().unwrap_or_else(|| "1".to_string());
    let mode = if q.get("mode").map(|s| s.as_str()) == Some("calendar") { "calendar" } else { "day" };
    let lat = q.get("lat").and_then(|s| s.parse::<f64>().ok());
    let lng = q.get("lng").and_then(|s| s.parse::<f64>().ok());
    let month = q.get("month").cloned().unwrap_or_default();

    if mode == "day" && (lat.is_none() || lng.is_none()) {
        return err(StatusCode::BAD_REQUEST, "lat, lng required for mode=day").into_response();
    }
    if mode == "calendar" && !valid_month(&month) {
        return err(StatusCode::BAD_REQUEST, "month (YYYY-MM) required for mode=calendar").into_response();
    }

    let Some(birds) = fetch_ticklist_birds(&st, user_id, &list_type).await else {
        return err(StatusCode::NOT_FOUND, "tickList not found").into_response();
    };
    if birds.is_empty() {
        return err(StatusCode::NOT_FOUND, "tickList not found").into_response();
    }
    let missing = missing_latins(&birds);
    let names = latin_to_name(&birds);

    let decorate_name = |latin: &str, species: &Option<String>| -> Value {
        names.get(&latin.to_lowercase()).cloned().or_else(|| species.clone()).map(Value::String).unwrap_or(Value::Null)
    };

    let candidates: Vec<Value> = if mode == "day" {
        let items = match predictor::rank_for_day(&db, lat.unwrap(), lng.unwrap(), &missing).await {
            Ok(it) => it,
            Err(e) => return dataset_err(e),
        };
        items.iter().map(|it| json!({
            "latin": it.latin,
            "species": it.species,
            "name": decorate_name(&it.latin, &it.species),
            "score": it.score,
            "scoreNorm": it.score_norm,
            "band": it.band,
            "cluster": cluster_json(&it.cluster),
            "evidence": it.evidence,
        })).collect()
    } else {
        let items = match predictor::rank_for_calendar(&db, &month, &missing).await {
            Ok(it) => it,
            Err(e) => return dataset_err(e),
        };
        items.iter().map(|it| json!({
            "cluster": cluster_json(&it.cluster),
            "score": it.score,
            "species": it.species.iter().map(|s| json!({
                "latin": s.latin,
                "species": s.species,
                "name": decorate_name(&s.latin, &s.species),
                "score": s.score,
                "scoreNorm": s.score_norm,
                "band": s.band,
                "evidence": s.evidence,
            })).collect::<Vec<_>>(),
        })).collect()
    };

    let mut out = json!({ "generatedAt": now_iso(), "mode": mode, "candidates": candidates });
    if mode == "calendar" {
        out["month"] = Value::String(month);
    }
    Json(out).into_response()
}

fn dataset_err(e: anyhow::Error) -> axum::response::Response {
    tracing::error!("Predictor dataset error: {e}");
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to build predictor dataset", "detail": e.to_string() }))).into_response()
}

fn valid_month(m: &str) -> bool {
    m.len() == 7 && m.as_bytes()[4] == b'-'
        && m[0..4].bytes().all(|c| c.is_ascii_digit())
        && m[5..7].bytes().all(|c| c.is_ascii_digit())
}

/// POST a chat body to Foundry and parse the structured JSON content.
async fn call_and_extract(st: &AppState, body: Value) -> anyhow::Result<Value> {
    let resp = llm::chat_completion(&st.http, &st.cfg, body).await?;
    let content = resp
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| anyhow::anyhow!("Empty AI response"))?;
    Ok(serde_json::from_str(content)?)
}

const PRED_SYSTEM_PROMPT: &str = "Du er ornitolog. Brugeren mangler at krydse arter af. Du modtager en liste af kandidater hvor hver kandidat har et lokalitetsområde og evidens (faktiske historiske observationer fra DOFbasen). Skriv kort dansk reasoning der ALENE er baseret på den givne evidens — opfind ikke lokaliteter, datoer eller observationer der ikke findes i evidens. Brug danske fuglenavne. Brug feltet 'tillidsbånd' direkte som confidence (lav/mellem/høj). Til suggestedDates: vælg 1-3 datoer fra listen 'mulige_datoer' baseret på årstid og evidens. Svar kun struktureret JSON.";

const CAL_SYSTEM_PROMPT: &str = "Du er ornitolog. Brugeren planlægger fugleture i den kommende måned og mangler at krydse arter af. Du modtager en liste af lokalitetsområder med tilknyttede arter og evidens (faktiske historiske observationer). Skriv kort dansk reasoning ALENE baseret på evidens — opfind ikke lokaliteter, datoer eller observationer. Brug danske fuglenavne. Brug feltet 'tillidsbånd' direkte som confidence (lav/mellem/høj). Skriv også en kort summary pr. område. Returnér områderne i samme rækkefølge som inputtet (sorteret efter antal manglende arter, dernæst score). Svar kun med struktureret JSON.";

fn predictions_response_format() -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "Predictions", "strict": true,
            "schema": {
                "type": "object", "additionalProperties": false,
                "properties": { "predictions": { "type": "array", "items": {
                    "type": "object", "additionalProperties": false,
                    "properties": {
                        "species": { "type": "string" }, "latin": { "type": "string" },
                        "location": { "type": "string" },
                        "confidence": { "type": "string", "enum": ["lav", "mellem", "høj"] },
                        "reasoning": { "type": "string" },
                        "suggestedDates": { "type": "array", "items": { "type": "string" } },
                    },
                    "required": ["species", "latin", "location", "confidence", "reasoning", "suggestedDates"],
                }}},
                "required": ["predictions"],
            },
        },
    })
}

fn calendar_response_format() -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "CalendarMonth", "strict": true,
            "schema": {
                "type": "object", "additionalProperties": false,
                "properties": { "locations": { "type": "array", "items": {
                    "type": "object", "additionalProperties": false,
                    "properties": {
                        "name": { "type": "string" }, "summary": { "type": "string" },
                        "birds": { "type": "array", "items": {
                            "type": "object", "additionalProperties": false,
                            "properties": {
                                "species": { "type": "string" },
                                "confidence": { "type": "string", "enum": ["lav", "mellem", "høj"] },
                                "reasoning": { "type": "string" },
                            },
                            "required": ["species", "confidence", "reasoning"],
                        }},
                    },
                    "required": ["name", "summary", "birds"],
                }}},
                "required": ["locations"],
            },
        },
    })
}
