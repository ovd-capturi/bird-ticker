//! Web Push subscriptions + the background alert poller. Ports the push
//! endpoints, `checkAndNotify`, `matchAlerts`, and `refreshObservationsForDate`
//! from `proxy/server.js`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use dashmap::DashMap;
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;
use web_push::{
    ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushClient, WebPushError,
    WebPushMessageBuilder,
};

use crate::scrape::{dofbasen, Observation};
use crate::AppState;

#[derive(Clone)]
pub struct Subscriber {
    pub subscription: Value,
    pub user_id: String,
    pub list_type: String,
    pub last_alert_keys: HashSet<String>,
}

pub type Subscribers = Arc<DashMap<String, Subscriber>>;

fn normalize_name(name: &str) -> String {
    name.to_lowercase().trim().split_whitespace().collect::<Vec<_>>().join(" ").nfc().collect()
}

struct Alert {
    species: String,
    location: String,
    count: i32,
    key: String,
}

/// Match missing (un-ticked) birds against today's observations by latin name.
fn match_alerts(birds: &[Value], observations: &[Value]) -> Vec<Alert> {
    let mut missing: HashMap<String, ()> = HashMap::new();
    for b in birds {
        let ticked = b.get("ticked").and_then(|v| v.as_bool()) == Some(true);
        if let Some(latin) = b.get("latin").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            if !ticked {
                missing.insert(normalize_name(latin), ());
            }
        }
    }

    let mut alerts = Vec::new();
    let mut seen = HashSet::new();
    for obs in observations {
        let latin = obs.get("latin").and_then(|v| v.as_str()).unwrap_or("");
        if missing.contains_key(&normalize_name(latin)) {
            let location = obs.get("location").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let key = format!("{}|{}", latin, location);
            if seen.insert(key.clone()) {
                alerts.push(Alert {
                    species: obs.get("species").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    location,
                    count: obs.get("count").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                    key,
                });
            }
        }
    }
    alerts
}

/// Network refresher: scrape DOFbasen for `date`, resolve missing coords, and
/// upsert. De-duplicated so concurrent callers share one scrape.
pub async fn refresh_observations_for_date(st: &AppState, date: Option<String>) -> anyhow::Result<u64> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let effective = date.clone().unwrap_or_else(|| today.clone());
    let key = format!("refresh-obs-{effective}");

    let http = st.http.clone();
    let db = st.db.clone();
    let eff = effective.clone();
    let date_opt = date.clone();

    let result = st
        .refresh_flight
        .run(&key, move || async move {
            let mut obs = dofbasen::fetch_observations(&http, date_opt.as_deref())
                .await
                .map_err(|e| e.to_string())?;
            if let Some(db) = &db {
                resolve_coords(db, &http, &mut obs).await;
                db.upsert_observations(&eff, &obs).await.map_err(|e| e.to_string())?;
            }
            Ok::<u64, String>(obs.len() as u64)
        })
        .await;

    result.map_err(|e| anyhow::anyhow!(e))
}

/// Fill missing coords from the DB, then DOFbasen's poplok.php (batched).
async fn resolve_coords(db: &crate::db::Db, http: &reqwest::Client, obs: &mut [Observation]) {
    let need: Vec<String> = obs
        .iter()
        .filter(|o| o.lat.is_none())
        .filter_map(|o| o.loknr.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if need.is_empty() {
        return;
    }

    let mut lok: HashMap<String, (Option<f64>, Option<f64>)> = HashMap::new();
    if let Ok(map) = db.get_locality_coords(&need).await {
        for (k, v) in map {
            lok.insert(k, (v.lat, v.lng));
        }
    }

    let still: Vec<String> = need
        .iter()
        .filter(|id| lok.get(*id).map(|c| c.0.is_none()).unwrap_or(true))
        .cloned()
        .collect();

    for batch in still.chunks(20) {
        let fetched = futures::future::join_all(
            batch.iter().map(|loknr| async move { (loknr.clone(), dofbasen::fetch_locality_coords(http, loknr).await) }),
        )
        .await;
        for (loknr, coords) in fetched {
            lok.insert(loknr, coords);
        }
    }

    for o in obs.iter_mut() {
        if o.lat.is_none() {
            if let Some(loknr) = &o.loknr {
                if let Some((lat, lng)) = lok.get(loknr) {
                    o.lat = *lat;
                    o.lng = *lng;
                }
            }
        }
    }
}

/// Poller: match each subscriber's missing species against today's stored
/// observations, send newly-matching ones, prune expired subscriptions. Runs
/// *after* `refresh_observations_for_date` has upserted today, so it matches
/// against exactly the data the app reads from `/api/observations` — a bird can
/// never be notified without also appearing in the app.
pub async fn check_and_notify(st: &AppState) {
    if st.subscribers.is_empty() {
        return;
    }
    let Some(db) = st.db.clone() else { return };

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let observations = match db.get_observations_by_date(&today).await {
        Ok(o) => o,
        Err(e) => {
            tracing::error!("Push obs DB read error: {e}");
            return;
        }
    };

    let endpoints: Vec<String> = st.subscribers.iter().map(|e| e.key().clone()).collect();
    for sub_key in endpoints {
        let Some(sub) = st.subscribers.get(&sub_key).map(|s| s.clone()) else { continue };

        let birds = match crate::scrape::netfugl::fetch_ticklist(&st.http, &sub.user_id, &sub.list_type).await {
            Ok(Some(b)) => b,
            _ => continue,
        };
        let birds_json: Vec<Value> = birds.iter().map(|b| serde_json::to_value(b).unwrap()).collect();

        // Persist the freshly scraped ticklist (mirrors fetchTickListData).
        let _ = db.upsert_ticklist(&sub.user_id, &sub.list_type, &json!(birds_json)).await;

        let alerts = match_alerts(&birds_json, &observations);
        let current_keys: HashSet<String> = alerts.iter().map(|a| a.key.clone()).collect();
        let new_alerts: Vec<&Alert> = alerts.iter().filter(|a| !sub.last_alert_keys.contains(&a.key)).collect();

        if !new_alerts.is_empty() {
            let payload = build_payload(&new_alerts);
            match send_push(&st.cfg, &sub.subscription, &payload).await {
                Ok(()) => tracing::info!("📬 Sent push to user {} ({} new obs)", sub.user_id, new_alerts.len()),
                Err(WebPushError::EndpointNotValid) | Err(WebPushError::EndpointNotFound) => {
                    tracing::info!("🗑️ Removing expired subscription for user {}", sub.user_id);
                    st.subscribers.remove(&sub_key);
                    let _ = db.delete_push_subscription(&sub_key).await;
                    continue;
                }
                Err(e) => tracing::error!("Push error for user {}: {e}", sub.user_id),
            }
        }

        if let Some(mut s) = st.subscribers.get_mut(&sub_key) {
            s.last_alert_keys = current_keys.clone();
        }
        let _ = db.update_last_alert_keys(&sub_key, &current_keys).await;
    }
}

/// Group new alerts by species and render the notification title/body.
fn build_payload(new_alerts: &[&Alert]) -> Value {
    struct Group {
        species: String,
        locations: Vec<String>,
        total: i32,
    }
    let mut groups: Vec<Group> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for a in new_alerts {
        let key = if a.species.is_empty() { a.location.clone() } else { a.species.clone() };
        let i = *index.entry(key).or_insert_with(|| {
            groups.push(Group { species: a.species.clone(), locations: vec![], total: 0 });
            groups.len() - 1
        });
        if !a.location.is_empty() {
            groups[i].locations.push(a.location.clone());
        }
        groups[i].total += a.count;
    }
    let species_count = groups.len();

    let title = if species_count == 1 {
        format!("🐦 {} spottet!", groups[0].species)
    } else {
        format!("🐦 {species_count} manglende arter spottet!")
    };

    let mut lines: Vec<String> = groups.iter().take(5).map(|g| {
        let mut parts = vec![g.species.clone()];
        let locs: Vec<&String> = {
            let mut seen = HashSet::new();
            g.locations.iter().filter(|l| seen.insert((*l).clone())).collect()
        };
        if locs.len() == 1 {
            parts.push(format!("📍 {}", locs[0]));
        } else if locs.len() > 1 {
            parts.push(format!("📍 {} lok.", locs.len()));
        }
        if g.total != 0 {
            parts.push(format!("{} stk", g.total));
        }
        parts.join(" — ")
    }).collect();
    if species_count > 5 {
        lines.push(format!("...og {} mere", species_count - 5));
    }

    json!({
        "title": title,
        "body": lines.join("\n"),
        "data": { "url": "/", "alertCount": species_count },
    })
}

/// Send one Web Push message via VAPID.
async fn send_push(cfg: &crate::config::Config, subscription: &Value, payload: &Value) -> Result<(), WebPushError> {
    let endpoint = subscription.get("endpoint").and_then(|v| v.as_str()).unwrap_or("");
    let keys = subscription.get("keys");
    let p256dh = keys.and_then(|k| k.get("p256dh")).and_then(|v| v.as_str()).unwrap_or("");
    let auth = keys.and_then(|k| k.get("auth")).and_then(|v| v.as_str()).unwrap_or("");

    let info = SubscriptionInfo::new(endpoint, p256dh, auth);
    let sig = VapidSignatureBuilder::from_base64(&cfg.vapid_private, web_push::URL_SAFE_NO_PAD, &info)?.build()?;

    let body = serde_json::to_vec(payload).unwrap_or_default();
    let mut builder = WebPushMessageBuilder::new(&info);
    builder.set_payload(ContentEncoding::Aes128Gcm, &body);
    builder.set_vapid_signature(sig);

    let client = web_push::IsahcWebPushClient::new()?;
    client.send(builder.build()?).await
}
