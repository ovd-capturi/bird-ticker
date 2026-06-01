//! Bird Ticker backend — Rust port of `proxy/server.js`.
//!
//! Serves the existing `public/` PWA as static files and the `/api/*` surface,
//! runs the background push poller, prewarms today's observations, and seeds
//! history via backfill. State (config, optional Postgres pool, push
//! subscribers) is shared with handlers via axum's `State` extractor.

mod backfill;
mod chat_tools;
mod config;
mod db;
mod dedupe;
mod llm;
mod predictor;
mod push;
mod routes;
mod scrape;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, Method, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::get,
    Router,
};
use dashmap::DashMap;
use tower_http::{compression::CompressionLayer, cors::CorsLayer, services::ServeDir};

use config::Config;
use db::Db;
use dedupe::SingleFlight;
use push::Subscribers;

/// Shared application state. `db` is `None` when `DATABASE_URL` is unset.
#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: Option<Db>,
    pub http: reqwest::Client,
    pub subscribers: Subscribers,
    /// Single-flight guard so concurrent refreshers share one DOFbasen scrape.
    pub refresh_flight: Arc<SingleFlight<Result<u64, String>>>,
    /// Cached `index.html` for the SPA fallback.
    pub index_html: Arc<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = Config::from_env();
    let port = cfg.port;

    let db = match &cfg.database_url {
        Some(url) => match Db::connect(url).await {
            Ok(db) => {
                if let Err(e) = db.migrate().await {
                    tracing::error!("migrations failed: {e}");
                    std::process::exit(1);
                }
                Some(db)
            }
            Err(e) => {
                tracing::error!("DB connect failed: {e}");
                std::process::exit(1);
            }
        },
        None => {
            tracing::warn!("⚠️  DATABASE_URL not set — running without DB");
            None
        }
    };

    // PUBLIC_DIR lets the container point at an absolute path; defaults to the
    // sibling `public/` for local dev. index.html is cached for the SPA fallback.
    let public_dir = std::env::var("PUBLIC_DIR").unwrap_or_else(|_| "../public".to_string());
    let index_html = std::fs::read_to_string(format!("{public_dir}/index.html")).unwrap_or_default();

    let state = AppState {
        cfg: Arc::new(cfg),
        db,
        http: reqwest::Client::new(),
        subscribers: Arc::new(DashMap::new()),
        refresh_flight: Arc::new(SingleFlight::new()),
        index_html: Arc::new(index_html),
    };

    // Restore persisted push subscriptions into the in-memory map.
    if let Some(db) = &state.db {
        match db.load_all_push_subscriptions().await {
            Ok(subs) => {
                for s in &subs {
                    state.subscribers.insert(
                        s.endpoint.clone(),
                        push::Subscriber {
                            subscription: s.subscription.clone(),
                            user_id: s.user_id.clone(),
                            list_type: s.list_type.clone(),
                            last_alert_keys: s.last_alert_keys.clone(),
                        },
                    );
                }
                tracing::info!("💾 Loaded {} push subscription(s) from DB", subs.len());
            }
            Err(e) => tracing::error!("load push subscriptions failed: {e}"),
        }
    }

    spawn_background_tasks(&state);

    // Static files; the SPA fallback (unmatched GET → index.html 200) is applied
    // in `spa_and_cache` so it can't clobber legitimate handler 404s under /api.
    let static_service = ServeDir::new(&public_dir);

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(routes::api_router())
        .fallback_service(static_service)
        .layer(middleware::from_fn_with_state(state.clone(), spa_and_cache))
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("🐦 bird-app listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.expect("failed to bind PORT");
    axum::serve(listener, app).await.expect("server error");
}

/// Prewarm, the 5-minute push poller, and (optionally) the backfill seeder.
fn spawn_background_tasks(state: &AppState) {
    // Prewarm today's observations (network).
    let st = state.clone();
    tokio::spawn(async move {
        match push::refresh_observations_for_date(&st, None).await {
            Ok(n) => tracing::info!("🔥 Prewarmed observations: {n} obs"),
            Err(e) => tracing::error!("Prewarm failed: {e}"),
        }
    });

    // Push checker every 5 minutes.
    let st = state.clone();
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs(5 * 60));
        iv.tick().await; // consume the immediate first tick (setInterval semantics)
        loop {
            iv.tick().await;
            push::check_and_notify(&st).await;
        }
    });
    tracing::info!("📬 Push checker running every 300s");

    // Backfill, unless disabled.
    let abort = Arc::new(AtomicBool::new(false));
    if state.db.is_some() && std::env::var("BACKFILL_DISABLED").as_deref() != Ok("true") {
        let st = state.clone();
        let ab = abort.clone();
        let years = std::env::var("BACKFILL_YEARS").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
        tokio::spawn(async move { backfill::run_backfill(st, years, ab).await });
    }
    // Abort backfill on shutdown signal.
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        abort.store(true, Ordering::Relaxed);
    });
}

/// SPA fallback + static cache policy. Unmatched non-API GETs (404 from
/// ServeDir) return `index.html` with 200 so the PWA's client routing works on
/// deep links (mirrors the Express `app.get("*")`). Legitimate handler 404s
/// under `/api` are left untouched. Otherwise: binary assets cached a day,
/// everything else `no-cache`.
async fn spa_and_cache(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let mut res = next.run(req).await;

    if res.status() == StatusCode::NOT_FOUND && method == Method::GET && !path.starts_with("/api") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(st.index_html.as_str().to_owned()))
            .unwrap();
    }

    let is_binary = matches!(
        path.rsplit('.').next().map(str::to_ascii_lowercase).as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "woff" | "woff2")
    );
    let value = if is_binary { "public, max-age=86400" } else { "no-cache" };
    if let Ok(v) = header::HeaderValue::from_str(value) {
        res.headers_mut().insert(header::CACHE_CONTROL, v);
    }
    res
}
