//! AI chat endpoints — port of `/api/ai-chat`, `/api/ai-chat/history`, and the
//! DELETE handler from `proxy/server.js`. Implements the bounded tool-calling
//! agentic loop.

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::chat_tools::{self, ChatCtx};
use crate::{llm, AppState};

const CHAT_MAX_TURNS: usize = 6;
const CHAT_HISTORY_LIMIT: i64 = 40;

const CHAT_SYSTEM_PROMPT: &str = "Du er en erfaren dansk ornitolog, der hjælper en birder med at krydse manglende arter på Netfugl. Brugeren har en krydsliste, en seneste position, og du har adgang til lokale data fra DOFbasen via værktøjer. Brug værktøjerne aktivt for at hente konkrete observationer, lokaliteter og predictor-data — opfind ALDRIG datoer, lokaliteter eller observationer. Hvis du mangler kontekst (fx hvilke arter brugeren mangler), så start med get_ticklist_summary eller get_predictor_dataset. Når brugeren spørger om en bestemt art (kendetegn, levested, føde, bestand, beskyttelse) — kald lookup_species_facts. Hvis lookup_species_facts returnerer et 'image'-felt, så vis billedet i svaret via markdown-syntaksen ![navn](sti). Brug danske fuglenavne i svar. Skriv kort, præcist og handlingsorienteret på dansk. Når du anbefaler ture, så referér til den underliggende evidens (dato, lokalitet, antal).";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/ai-chat", post(ai_chat).delete(clear_chat))
        .route("/api/ai-chat/history", get(history))
}

fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<Value>) {
    (code, Json(json!({ "error": msg })))
}

/// Convert stored history rows into OpenAI chat messages.
fn history_to_messages(history: &[crate::db::ChatMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in history {
        match m.role.as_str() {
            "user" | "system" => out.push(json!({ "role": m.role, "content": m.content.clone().unwrap_or_default() })),
            "assistant" => {
                let mut msg = json!({ "role": "assistant", "content": m.content.clone().unwrap_or_default() });
                if let Some(tc) = &m.tool_calls {
                    msg["tool_calls"] = tc.clone();
                }
                out.push(msg);
            }
            "tool" => out.push(json!({
                "role": "tool",
                "tool_call_id": m.tool_call_id,
                "name": m.tool_name,
                "content": m.content.clone().unwrap_or_default(),
            })),
            _ => {}
        }
    }
    out
}

async fn ai_chat(State(st): State<AppState>, Json(body): Json<Value>) -> impl IntoResponse {
    if !st.cfg.ai_configured() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "AI not configured.").into_response();
    }
    let Some(db) = st.db.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "DB not configured.").into_response();
    };

    let device_id = body.get("deviceId").and_then(|v| v.as_str()).map(String::from);
    let Some(device_id) = device_id.filter(|s| !s.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "deviceId required").into_response();
    };
    let message = body.get("message").and_then(|v| v.as_str()).map(String::from);
    let Some(message) = message.filter(|s| !s.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "message required").into_response();
    };
    let user_id = body.get("userId").and_then(|v| v.as_str()).map(String::from);
    let list_type = body.get("listType").and_then(|v| v.as_str()).unwrap_or("1").to_string();
    let lat = body.get("lat").and_then(num);
    let lng = body.get("lng").and_then(num);

    match run_chat(&st, &db, &device_id, user_id.as_deref(), &list_type, lat, lng, &message).await {
        Ok(v) => v.into_response(),
        Err(e) => {
            tracing::error!("AI chat error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Chat failed", "detail": e.to_string() }))).into_response()
        }
    }
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

#[allow(clippy::too_many_arguments)]
async fn run_chat(
    st: &AppState,
    db: &crate::db::Db,
    device_id: &str,
    user_id: Option<&str>,
    list_type: &str,
    lat: Option<f64>,
    lng: Option<f64>,
    message: &str,
) -> anyhow::Result<Json<Value>> {
    // Context: DB-only ticklist read (best-effort).
    let birds = match user_id {
        Some(uid) => db.get_ticklist(uid, list_type).await.ok().flatten().and_then(|t| t.birds.as_array().cloned()).unwrap_or_default(),
        None => Vec::new(),
    };
    let ctx = ChatCtx { birds, lat, lng };

    let history = db.get_chat_history(device_id, CHAT_HISTORY_LIMIT).await?;
    db.insert_chat_message(device_id, user_id, Some(list_type), "user", Some(message), None, None, None).await?;

    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": CHAT_SYSTEM_PROMPT })];
    messages.extend(history_to_messages(&history));
    messages.push(json!({ "role": "user", "content": message }));

    let mut tool_trace: Vec<Value> = Vec::new();
    let mut final_content: Option<String> = None;

    for _turn in 0..CHAT_MAX_TURNS {
        let resp = llm::chat_completion(&st.http, &st.cfg, json!({
            "messages": messages,
            "tools": chat_tools::tool_schemas(),
            "temperature": 0.2,
        })).await?;

        let msg = resp.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).cloned()
            .ok_or_else(|| anyhow::anyhow!("Empty AI response"))?;
        let tool_calls = msg.get("tool_calls").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        if tool_calls.is_empty() {
            let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            messages.push(json!({ "role": "assistant", "content": content }));
            db.insert_chat_message(device_id, user_id, Some(list_type), "assistant", Some(&content), None, None, None).await?;
            final_content = Some(content);
            break;
        }

        let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
        messages.push(json!({ "role": "assistant", "content": content, "tool_calls": tool_calls }));
        db.insert_chat_message(device_id, user_id, Some(list_type), "assistant", Some(&content), Some(&json!(tool_calls)), None, None).await?;

        for call in &tool_calls {
            let func = call.get("function");
            let name = func.and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or("");
            let args: Value = func
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_else(|| json!({}));
            let call_id = call.get("id").and_then(|v| v.as_str()).unwrap_or("");

            let result = chat_tools::run_tool(st, &ctx, name, &args).await;
            let result_str = result.to_string();
            tool_trace.push(json!({
                "name": name, "args": args,
                "resultPreview": result_str.chars().take(400).collect::<String>(),
            }));
            messages.push(json!({ "role": "tool", "tool_call_id": call_id, "name": name, "content": result_str }));
            db.insert_chat_message(device_id, user_id, Some(list_type), "tool", Some(&result_str), None, Some(name), Some(call_id)).await?;
        }
    }

    let final_content = match final_content {
        Some(c) => c,
        None => {
            let c = "(Jeg nåede grænsen for værktøjskald uden at færdiggøre svaret. Prøv et mere fokuseret spørgsmål.)".to_string();
            db.insert_chat_message(device_id, user_id, Some(list_type), "assistant", Some(&c), None, None, None).await?;
            c
        }
    };

    Ok(Json(json!({ "content": final_content, "toolTrace": tool_trace })))
}

async fn history(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let Some(db) = &st.db else { return Json(json!({ "messages": [] })).into_response() };
    let Some(device_id) = q.get("deviceId").filter(|s| !s.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "deviceId required").into_response();
    };
    match db.get_chat_history(device_id, CHAT_HISTORY_LIMIT).await {
        Ok(msgs) => Json(json!({ "messages": msgs })).into_response(),
        Err(e) => {
            tracing::error!("Chat history error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to load chat history" }))).into_response()
        }
    }
}

async fn clear_chat(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let Some(db) = &st.db else { return Json(json!({ "ok": true })).into_response() };
    let Some(device_id) = q.get("deviceId").filter(|s| !s.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "deviceId required").into_response();
    };
    match db.clear_chat_history(device_id).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => {
            tracing::error!("Chat clear error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to clear chat" }))).into_response()
        }
    }
}
