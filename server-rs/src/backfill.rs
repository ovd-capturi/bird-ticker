//! Historical observation seeder — port of `proxy/backfill.js`. Walks the last
//! N years of dates not already scraped and fetches each with polite delays and
//! consecutive-failure backoff.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{Datelike, NaiveDate};

use crate::push::refresh_observations_for_date;
use crate::AppState;

const BASE_DELAY_MS: u64 = 2000;
const JITTER_MS: u64 = 750;

fn enumerate_dates(start: NaiveDate, end: NaiveDate) -> Vec<String> {
    let mut out = Vec::new();
    let mut d = start;
    while d <= end {
        out.push(d.format("%Y-%m-%d").to_string());
        d += chrono::Duration::days(1);
    }
    out
}

/// Small deterministic-ish jitter without pulling in a RNG crate.
fn jitter() -> u64 {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    (nanos as u64) % JITTER_MS
}

pub async fn run_backfill(st: AppState, years: i32, abort: Arc<AtomicBool>) {
    let Some(db) = st.db.clone() else {
        tracing::info!("backfill: DB not configured, skipping");
        return;
    };

    let today = chrono::Utc::now().date_naive();
    let yesterday = today - chrono::Duration::days(1);
    // year - N, same month/day (clamp Feb 29 → Feb 28).
    let start = NaiveDate::from_ymd_opt(today.year() - years, today.month(), today.day())
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(today.year() - years, today.month(), 28).unwrap());

    let start_str = start.format("%Y-%m-%d").to_string();
    let end_str = yesterday.format("%Y-%m-%d").to_string();

    let scraped = match db.get_dates_with_scrape(&start_str, &end_str).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("backfill: scrape-log read failed: {e}");
            return;
        }
    };
    let all = enumerate_dates(start, yesterday);
    let missing: Vec<String> = all.iter().filter(|d| !scraped.contains(*d)).cloned().collect();

    tracing::info!("backfill: {}/{} dates to fetch ({start_str} → {end_str})", missing.len(), all.len());
    if missing.is_empty() {
        return;
    }

    let mut consecutive_failures = 0u32;
    let mut processed = 0usize;

    for date in &missing {
        if abort.load(Ordering::Relaxed) {
            tracing::info!("backfill: aborted after {processed} dates");
            return;
        }
        match refresh_observations_for_date(&st, Some(date.clone())).await {
            Ok(_) => consecutive_failures = 0,
            Err(e) => {
                consecutive_failures += 1;
                tracing::warn!("backfill {date} failed: {e}");
                if consecutive_failures >= 20 {
                    tracing::warn!("backfill: aborting after {consecutive_failures} consecutive failures (DOFbasen blocking?)");
                    return;
                }
                if consecutive_failures >= 5 {
                    let backoff = (5000u64 * 2u64.pow(consecutive_failures - 5)).min(60000);
                    tracing::warn!("backfill: backing off {}s after {consecutive_failures} consecutive failures", backoff / 1000);
                    tokio::time::sleep(Duration::from_millis(backoff)).await;
                }
            }
        }
        processed += 1;
        if processed % 50 == 0 {
            tracing::info!("backfill: {processed}/{} done", missing.len());
        }
        tokio::time::sleep(Duration::from_millis(BASE_DELAY_MS + jitter())).await;
    }

    tracing::info!("backfill: complete — processed {processed} dates");
}
