//! Push subscription endpoints — ports of `/api/push/*` from `proxy/server.js`.

use std::collections::HashSet;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::push::Subscriber;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/push/vapid-key", get(vapid_key))
        .route("/api/push/subscribe", post(subscribe))
        .route("/api/push/unsubscribe", post(unsubscribe))
}

async fn vapid_key(State(st): State<AppState>) -> impl IntoResponse {
    Json(json!({ "publicKey": st.cfg.vapid_public }))
}

async fn subscribe(State(st): State<AppState>, Json(body): Json<Value>) -> impl IntoResponse {
    let subscription = body.get("subscription").cloned();
    let user_id = body.get("userId").and_then(|v| v.as_str()).map(String::from);
    let list_type = body.get("listType").and_then(|v| v.as_str()).unwrap_or("1").to_string();

    let (Some(subscription), Some(user_id)) = (subscription.filter(|s| !s.is_null()), user_id) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "subscription and userId required" }))).into_response();
    };
    let Some(endpoint) = subscription.get("endpoint").and_then(|v| v.as_str()).map(String::from) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "subscription and userId required" }))).into_response();
    };

    // Preserve any existing lastAlertKeys for this endpoint.
    let prior: HashSet<String> = st.subscribers.get(&endpoint).map(|s| s.last_alert_keys.clone()).unwrap_or_default();
    st.subscribers.insert(
        endpoint.clone(),
        Subscriber { subscription: subscription.clone(), user_id: user_id.clone(), list_type: list_type.clone(), last_alert_keys: prior },
    );

    if let Some(db) = &st.db {
        if let Err(e) = db.upsert_push_subscription(&endpoint, &user_id, &list_type, &subscription).await {
            tracing::error!("Push subscribe DB write failed: {e}");
        }
    }
    tracing::info!("📬 Push subscription added for user {user_id} ({} total)", st.subscribers.len());
    Json(json!({ "ok": true })).into_response()
}

async fn unsubscribe(State(st): State<AppState>, Json(body): Json<Value>) -> impl IntoResponse {
    if let Some(endpoint) = body.get("endpoint").and_then(|v| v.as_str()) {
        st.subscribers.remove(endpoint);
        if let Some(db) = &st.db {
            if let Err(e) = db.delete_push_subscription(endpoint).await {
                tracing::error!("Push unsubscribe DB delete failed: {e}");
            }
        }
    }
    Json(json!({ "ok": true }))
}
