//! Postgres access layer — Rust port of `proxy/db/index.js`.
//!
//! Uses sqlx runtime-checked queries (not the compile-time `query!` macro) so
//! the build needs no live database and the dynamically-built bulk inserts
//! (`upsert_observations`) stay expressible. The migration runner mirrors
//! `proxy/db/migrate.js`, including its "optional" handling for `azure_ai`.

use std::collections::{HashMap, HashSet};

use chrono::Datelike;
use include_dir::{include_dir, Dir};
use serde_json::{json, Value};
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::{QueryBuilder, Row};

use crate::scrape::Observation;

/// Embedded copy of `proxy/db/migrations/*.sql`, applied in filename order.
static MIGRATIONS: Dir = include_dir!("$CARGO_MANIFEST_DIR/migrations");

#[derive(Clone)]
pub struct Db {
    pub pool: PgPool,
}

pub struct Ticklist {
    pub birds: Value,
    pub fetched_at_ms: i64,
}

#[derive(Clone, Copy, serde::Serialize)]
pub struct LocalityCoord {
    pub lat: Option<f64>,
    pub lng: Option<f64>,
}

pub struct ScrapeAge {
    pub fetched_at_ms: i64,
    pub row_count: Option<i32>,
}

impl Db {
    /// Build the pool. Pool size is `PGPOOL_MAX` (default 16; the Node app used
    /// 8 — a larger pool lifts concurrent throughput). SSL is driven by the
    /// connection string's `sslmode` (Azure URL carries `sslmode=require`).
    pub async fn connect(database_url: &str) -> anyhow::Result<Self> {
        let max = std::env::var("PGPOOL_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(16);
        let pool = PgPoolOptions::new()
            .max_connections(max)
            .idle_timeout(std::time::Duration::from_secs(30))
            .connect(database_url)
            .await?;
        Ok(Db { pool })
    }

    /// Replays embedded migrations. `azure_ai` is optional: a failure there is
    /// logged and skipped (the extension is unavailable outside Azure), every
    /// other failure aborts startup — identical to `migrate.js`.
    pub async fn migrate(&self) -> anyhow::Result<()> {
        sqlx::raw_sql(
            "CREATE TABLE IF NOT EXISTS _migrations (
               name TEXT PRIMARY KEY,
               applied_at TIMESTAMPTZ DEFAULT now()
             )",
        )
        .execute(&self.pool)
        .await?;

        let mut files: Vec<_> = MIGRATIONS
            .files()
            .filter(|f| f.path().extension().is_some_and(|e| e == "sql"))
            .collect();
        files.sort_by_key(|f| f.path().to_path_buf());

        for file in files {
            let name = file.path().file_name().unwrap().to_string_lossy().to_string();

            let already: Option<i32> =
                sqlx::query_scalar("SELECT 1 FROM _migrations WHERE name = $1")
                    .bind(&name)
                    .fetch_optional(&self.pool)
                    .await?;
            if already.is_some() {
                continue;
            }

            let sql = file.contents_utf8().expect("migration is valid UTF-8");
            let optional = name.contains("azure_ai");

            match sqlx::raw_sql(sql).execute(&self.pool).await {
                Ok(_) => {
                    sqlx::query("INSERT INTO _migrations (name) VALUES ($1)")
                        .bind(&name)
                        .execute(&self.pool)
                        .await?;
                    tracing::info!("✅ migration {name}");
                }
                Err(e) if optional => {
                    let first = e.to_string().lines().next().unwrap_or("").to_string();
                    tracing::info!("⏭️  migration {name} skipped ({first})");
                }
                Err(e) => {
                    tracing::error!("❌ migration {name} failed: {e}");
                    return Err(e.into());
                }
            }
        }
        Ok(())
    }

    // ── Tick lists ───────────────────────────────────────────────────────
    pub async fn get_ticklist(&self, user_id: &str, list_type: &str) -> anyhow::Result<Option<Ticklist>> {
        let row = sqlx::query(
            "SELECT birds, fetched_at FROM ticklists WHERE user_id = $1 AND list_type = $2",
        )
        .bind(user_id)
        .bind(list_type)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| {
            let fetched: chrono::DateTime<chrono::Utc> = r.get("fetched_at");
            Ticklist {
                birds: r.get("birds"),
                fetched_at_ms: fetched.timestamp_millis(),
            }
        }))
    }

    pub async fn upsert_ticklist(&self, user_id: &str, list_type: &str, birds: &Value) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO ticklists (user_id, list_type, birds, fetched_at)
             VALUES ($1, $2, $3::jsonb, now())
             ON CONFLICT (user_id, list_type) DO UPDATE
               SET birds = EXCLUDED.birds, fetched_at = now()",
        )
        .bind(user_id)
        .bind(list_type)
        .bind(birds)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ── Observations (read) ────────────────────────────────────────────────
    /// Returns each observation as a JSON object: the typed columns with the
    /// stored `raw` blob merged on top (raw wins), matching the spread in
    /// `db.getObservationsByDate`.
    pub async fn get_observations_by_date(&self, date: &str) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT species, latin, location, loknr, lat, lng, observer, count, behaviour, raw
             FROM observations WHERE obs_date = $1::date",
        )
        .bind(date)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.iter().map(obs_row_to_json).collect())
    }

    /// Average coords per locality, derived from stored observations. Every
    /// requested loknr is present in the map (null/null if unseen).
    pub async fn get_locality_coords(&self, loknrs: &[String]) -> anyhow::Result<HashMap<String, LocalityCoord>> {
        let mut out: HashMap<String, LocalityCoord> = loknrs
            .iter()
            .map(|id| (id.clone(), LocalityCoord { lat: None, lng: None }))
            .collect();
        if loknrs.is_empty() {
            return Ok(out);
        }

        let rows = sqlx::query(
            "SELECT loknr,
                    avg(lat) FILTER (WHERE lat IS NOT NULL) AS lat,
                    avg(lng) FILTER (WHERE lng IS NOT NULL) AS lng
             FROM observations
             WHERE loknr = ANY($1)
             GROUP BY loknr",
        )
        .bind(loknrs)
        .fetch_all(&self.pool)
        .await?;

        for r in rows {
            let loknr: String = r.get("loknr");
            out.insert(
                loknr,
                LocalityCoord {
                    lat: r.try_get("lat").ok().flatten(),
                    lng: r.try_get("lng").ok().flatten(),
                },
            );
        }
        Ok(out)
    }

    /// Lowercased Danish name → artId, for species ever seen locally.
    pub async fn get_species_map(&self) -> anyhow::Result<HashMap<String, String>> {
        let rows = sqlx::query(
            "SELECT lower(species) AS name_key,
                    max(raw->>'artId') AS art_id
             FROM observations
             WHERE species IS NOT NULL AND species <> ''
             GROUP BY lower(species)",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut by_name = HashMap::new();
        for r in rows {
            let name: String = r.get("name_key");
            if let Ok(Some(art)) = r.try_get::<Option<String>, _>("art_id") {
                by_name.insert(name, art);
            }
        }
        Ok(by_name)
    }

    pub async fn get_scrape_age(&self, date: &str) -> anyhow::Result<Option<ScrapeAge>> {
        let row = sqlx::query("SELECT fetched_at, row_count FROM scrape_log WHERE obs_date = $1::date")
            .bind(date)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| {
            let fetched: chrono::DateTime<chrono::Utc> = r.get("fetched_at");
            ScrapeAge {
                fetched_at_ms: fetched.timestamp_millis(),
                row_count: r.try_get("row_count").ok().flatten(),
            }
        }))
    }
}

// ── Predictor candidate + evidence reads ──────────────────────────────────

/// One ranked-candidate row, shared by the bucket and live-aggregate queries.
#[derive(sqlx::FromRow, Clone)]
pub struct CandidateRow {
    pub latin: String,
    pub species: Option<String>,
    pub loknr: Option<String>,
    pub location: Option<String>,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub freq: i32,
    pub last_obs: Option<chrono::NaiveDate>,
    pub avg_count: Option<f64>,
}

/// A single historical sighting backing a candidate. `rare` is omitted when
/// absent in the stored `raw` blob (mirrors `r.raw?.rare` being `undefined`).
#[derive(serde::Serialize, Clone)]
pub struct Evidence {
    pub date: String,
    pub location: Option<String>,
    pub count: Option<i32>,
    pub observer: Option<String>,
    pub behaviour: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rare: Option<bool>,
}

const NULL_LOKNR_SENTINEL: &str = "";

impl Db {
    /// Pre-aggregated weekly buckets — the fast path for the day predictor.
    pub async fn get_bucket_week_candidates(
        &self,
        latin_list: &[String],
        week_set: &[i32],
        from_date: &str,
    ) -> anyhow::Result<Vec<CandidateRow>> {
        if latin_list.is_empty() || week_set.is_empty() {
            return Ok(vec![]);
        }
        let lowered: Vec<String> = latin_list.iter().map(|s| s.to_lowercase()).collect();
        let from_year: i32 = from_date.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0);

        let rows = sqlx::query_as::<_, CandidateRow>(
            "SELECT latin, lower(latin) AS latin_key, max(species) AS species,
                    NULLIF(loknr, $4) AS loknr, max(location) AS location,
                    avg(lat) FILTER (WHERE lat IS NOT NULL)::float8 AS lat,
                    avg(lng) FILTER (WHERE lng IS NOT NULL)::float8 AS lng,
                    sum(n_obs)::int AS freq, max(last_obs) AS last_obs,
                    CASE WHEN sum(n_obs) > 0
                      THEN sum(sum_count)::float / sum(n_obs)::float ELSE 1.0 END AS avg_count
             FROM obs_bucket_week
             WHERE lower(latin) = ANY($1) AND iso_week = ANY($2) AND iso_year >= $3
             GROUP BY latin, loknr HAVING sum(n_obs) >= 1
             ORDER BY freq DESC LIMIT 800",
        )
        .bind(&lowered)
        .bind(week_set)
        .bind(from_year)
        .bind(NULL_LOKNR_SENTINEL)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Pre-aggregated monthly buckets — the fast path for the calendar predictor.
    pub async fn get_bucket_month_candidates(
        &self,
        latin_list: &[String],
        year: i32,
        month: i32,
        lookback_years: i32,
    ) -> anyhow::Result<Vec<CandidateRow>> {
        if latin_list.is_empty() {
            return Ok(vec![]);
        }
        let lowered: Vec<String> = latin_list.iter().map(|s| s.to_lowercase()).collect();
        let from_year = year - lookback_years;

        let rows = sqlx::query_as::<_, CandidateRow>(
            "SELECT latin, lower(latin) AS latin_key, max(species) AS species,
                    NULLIF(loknr, $4) AS loknr, max(location) AS location,
                    avg(lat) FILTER (WHERE lat IS NOT NULL)::float8 AS lat,
                    avg(lng) FILTER (WHERE lng IS NOT NULL)::float8 AS lng,
                    sum(n_obs)::int AS freq, max(last_obs) AS last_obs,
                    CASE WHEN sum(n_obs) > 0
                      THEN sum(sum_count)::float / sum(n_obs)::float ELSE 1.0 END AS avg_count
             FROM obs_bucket_month
             WHERE lower(latin) = ANY($1) AND month = $2 AND year BETWEEN $3 AND $5
             GROUP BY latin, loknr HAVING sum(n_obs) >= 1
             ORDER BY freq DESC LIMIT 800",
        )
        .bind(&lowered)
        .bind(month)
        .bind(from_year)
        .bind(NULL_LOKNR_SENTINEL)
        .bind(year)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Live aggregation over raw `observations` — fallback when buckets are empty.
    pub async fn aggregate_by_site(
        &self,
        latin_list: &[String],
        week_set: &[i32],
        from_date: &str,
    ) -> anyhow::Result<Vec<CandidateRow>> {
        if latin_list.is_empty() || week_set.is_empty() {
            return Ok(vec![]);
        }
        let lowered: Vec<String> = latin_list.iter().map(|s| s.to_lowercase()).collect();

        let rows = sqlx::query_as::<_, CandidateRow>(
            "WITH relevant AS (
               SELECT o.id, o.latin, o.loknr, o.location, o.species,
                      o.lat, o.lng, o.obs_date, o.count, o.observer, o.behaviour
               FROM observations o
               WHERE lower(o.latin) = ANY($1)
                 AND EXTRACT(week FROM o.obs_date)::int = ANY($2)
                 AND o.obs_date >= $3::date
             )
             SELECT latin, lower(latin) AS latin_key, max(species) AS species, loknr,
                    max(location) AS location,
                    avg(lat) FILTER (WHERE lat IS NOT NULL) AS lat,
                    avg(lng) FILTER (WHERE lng IS NOT NULL) AS lng,
                    count(*)::int AS freq, max(obs_date) AS last_obs,
                    avg(coalesce(count, 1))::float AS avg_count
             FROM relevant
             GROUP BY latin, lower(latin), loknr HAVING count(*) >= 1
             ORDER BY freq DESC LIMIT 800",
        )
        .bind(&lowered)
        .bind(week_set)
        .bind(from_date)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Historical sightings for the scored candidates, keyed `latin|loknr`.
    pub async fn fetch_evidence(
        &self,
        latin_list: &[String],
        loknr_list: &[String],
        week_set: &[i32],
        from_date: &str,
    ) -> anyhow::Result<HashMap<String, Vec<Evidence>>> {
        let mut map: HashMap<String, Vec<Evidence>> = HashMap::new();
        if latin_list.is_empty() || loknr_list.is_empty() {
            return Ok(map);
        }
        let lowered: Vec<String> = latin_list.iter().map(|s| s.to_lowercase()).collect();

        let rows = sqlx::query(
            "SELECT o.latin, o.loknr, o.location, o.species,
                    to_char(o.obs_date, 'YYYY-MM-DD') AS obs_date,
                    o.count, o.observer, o.behaviour, o.raw
             FROM observations o
             WHERE lower(o.latin) = ANY($1) AND o.loknr = ANY($2)
               AND EXTRACT(week FROM o.obs_date)::int = ANY($3)
               AND o.obs_date >= $4::date
             ORDER BY o.obs_date DESC",
        )
        .bind(&lowered)
        .bind(loknr_list)
        .bind(week_set)
        .bind(from_date)
        .fetch_all(&self.pool)
        .await?;

        for r in rows {
            let latin: String = r.get("latin");
            let loknr: Option<String> = r.try_get("loknr").ok().flatten();
            let key = format!("{}|{}", latin.to_lowercase(), loknr.unwrap_or_default());
            let rare = r
                .try_get::<Option<Value>, _>("raw")
                .ok()
                .flatten()
                .and_then(|raw| raw.get("rare").and_then(|v| v.as_bool()));
            map.entry(key).or_default().push(Evidence {
                date: r.get("obs_date"),
                location: r.try_get("location").ok().flatten(),
                count: r.try_get("count").ok().flatten(),
                observer: r.try_get("observer").ok().flatten(),
                behaviour: r.try_get("behaviour").ok().flatten(),
                rare,
            });
        }
        Ok(map)
    }
}

// ── Push subscriptions ─────────────────────────────────────────────────────
pub struct PushSub {
    pub endpoint: String,
    pub user_id: String,
    pub list_type: String,
    pub subscription: Value,
    pub last_alert_keys: HashSet<String>,
}

// ── Chat history ───────────────────────────────────────────────────────────
#[derive(serde::Serialize, Clone)]
pub struct ChatMessage {
    pub id: i64,
    pub role: String,
    pub content: Option<String>,
    #[serde(rename = "toolCalls")]
    pub tool_calls: Option<Value>,
    #[serde(rename = "toolName")]
    pub tool_name: Option<String>,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

impl Db {
    pub async fn upsert_push_subscription(&self, endpoint: &str, user_id: &str, list_type: &str, subscription: &Value) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO push_subscriptions (endpoint, user_id, list_type, subscription_json, last_seen_at)
             VALUES ($1, $2, $3, $4::jsonb, now())
             ON CONFLICT (endpoint) DO UPDATE
               SET user_id = EXCLUDED.user_id, list_type = EXCLUDED.list_type,
                   subscription_json = EXCLUDED.subscription_json, last_seen_at = now()",
        )
        .bind(endpoint).bind(user_id).bind(list_type).bind(subscription)
        .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn delete_push_subscription(&self, endpoint: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1").bind(endpoint).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn load_all_push_subscriptions(&self) -> anyhow::Result<Vec<PushSub>> {
        let rows = sqlx::query(
            "SELECT endpoint, user_id, list_type, subscription_json, last_alert_keys FROM push_subscriptions",
        )
        .fetch_all(&self.pool).await?;
        Ok(rows.iter().map(|r| {
            let keys: Option<Value> = r.try_get("last_alert_keys").ok().flatten();
            let set = keys.and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())).unwrap_or_default();
            PushSub {
                endpoint: r.get("endpoint"),
                user_id: r.get("user_id"),
                list_type: r.get("list_type"),
                subscription: r.get("subscription_json"),
                last_alert_keys: set,
            }
        }).collect())
    }

    pub async fn update_last_alert_keys(&self, endpoint: &str, keys: &HashSet<String>) -> anyhow::Result<()> {
        let arr: Vec<&String> = keys.iter().collect();
        sqlx::query("UPDATE push_subscriptions SET last_alert_keys = $1::jsonb WHERE endpoint = $2")
            .bind(serde_json::to_value(arr)?).bind(endpoint)
            .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn insert_chat_message(&self, device_id: &str, user_id: Option<&str>, list_type: Option<&str>, role: &str, content: Option<&str>, tool_calls: Option<&Value>, tool_name: Option<&str>, tool_call_id: Option<&str>) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO chat_messages (device_id, user_id, list_type, role, content, tool_calls, tool_name, tool_call_id)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)",
        )
        .bind(device_id).bind(user_id).bind(list_type).bind(role).bind(content)
        .bind(tool_calls).bind(tool_name).bind(tool_call_id)
        .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn get_chat_history(&self, device_id: &str, limit: i64) -> anyhow::Result<Vec<ChatMessage>> {
        let rows = sqlx::query(
            "SELECT id, role, content, tool_calls, tool_name, tool_call_id, created_at
             FROM chat_messages WHERE device_id = $1 ORDER BY id DESC LIMIT $2",
        )
        .bind(device_id).bind(limit)
        .fetch_all(&self.pool).await?;
        let mut out: Vec<ChatMessage> = rows.iter().map(|r| {
            let created: chrono::DateTime<chrono::Utc> = r.get("created_at");
            ChatMessage {
                id: r.get("id"),
                role: r.get("role"),
                content: r.try_get("content").ok().flatten(),
                tool_calls: r.try_get("tool_calls").ok().flatten(),
                tool_name: r.try_get("tool_name").ok().flatten(),
                tool_call_id: r.try_get("tool_call_id").ok().flatten(),
                created_at: created.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            }
        }).collect();
        out.reverse();
        Ok(out)
    }

    pub async fn clear_chat_history(&self, device_id: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM chat_messages WHERE device_id = $1").bind(device_id).execute(&self.pool).await?;
        Ok(())
    }

    // ── Backfill support ─────────────────────────────────────────────────
    pub async fn get_dates_with_scrape(&self, start: &str, end: &str) -> anyhow::Result<HashSet<String>> {
        let rows = sqlx::query(
            "SELECT to_char(obs_date, 'YYYY-MM-DD') AS d FROM scrape_log WHERE obs_date BETWEEN $1::date AND $2::date",
        )
        .bind(start).bind(end)
        .fetch_all(&self.pool).await?;
        Ok(rows.iter().map(|r| r.get::<String, _>("d")).collect())
    }

    // ── Chat-tool reads (static SQL, rows returned as JSON objects) ───────
    pub async fn chat_recent_for_species(&self, latin: &str, limit: i64) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT to_char(obs_date, 'YYYY-MM-DD') AS date, species, latin, location, loknr, count, behaviour, observer
             FROM observations WHERE lower(latin) = lower($1) ORDER BY obs_date DESC, id DESC LIMIT $2",
        ).bind(latin).bind(limit).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(row_to_json).collect())
    }

    pub async fn chat_species_monthly(&self, latin: &str) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT month, sum(n_obs)::int AS n FROM obs_bucket_month
             WHERE lower(latin) = lower($1) GROUP BY month ORDER BY month",
        ).bind(latin).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(row_to_json).collect())
    }

    pub async fn chat_obs_by_loknr(&self, loknr: &str, limit: i64) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT to_char(obs_date, 'YYYY-MM-DD') AS date, species, latin, location, loknr, count, behaviour
             FROM observations WHERE loknr = $1 ORDER BY obs_date DESC, id DESC LIMIT $2",
        ).bind(loknr).bind(limit).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(row_to_json).collect())
    }

    pub async fn chat_obs_by_name(&self, name_like: &str, limit: i64) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT to_char(obs_date, 'YYYY-MM-DD') AS date, species, latin, location, loknr, count, behaviour
             FROM observations WHERE location ILIKE $1 ORDER BY obs_date DESC, id DESC LIMIT $2",
        ).bind(name_like).bind(limit).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(row_to_json).collect())
    }

    pub async fn chat_species_at_loknr(&self, loknr: &str) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT latin, max(species) AS species, count(*)::int AS n,
                    to_char(max(obs_date), 'YYYY-MM-DD') AS last_seen
             FROM observations WHERE loknr = $1 GROUP BY latin ORDER BY n DESC LIMIT 30",
        ).bind(loknr).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(row_to_json).collect())
    }

    pub async fn chat_species_at_name(&self, name_like: &str) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT latin, max(species) AS species, count(*)::int AS n,
                    to_char(max(obs_date), 'YYYY-MM-DD') AS last_seen
             FROM observations WHERE location ILIKE $1 GROUP BY latin ORDER BY n DESC LIMIT 30",
        ).bind(name_like).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(row_to_json).collect())
    }

    pub async fn chat_recent_all(&self, limit: i64) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT to_char(obs_date, 'YYYY-MM-DD') AS date, species, latin, location, loknr, count, behaviour
             FROM observations ORDER BY obs_date DESC, id DESC LIMIT $1",
        ).bind(limit).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(row_to_json).collect())
    }

    /// Insert scraped observations (dedup via ON CONFLICT) and fold the newly
    /// inserted rows into the week/month bucket tables. Port of
    /// `upsertObservations` + `applyBucketDeltas`.
    pub async fn upsert_observations(&self, date: &str, observations: &[Observation]) -> anyhow::Result<u64> {
        let obs_date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")?;

        if observations.is_empty() {
            sqlx::query(
                "INSERT INTO scrape_log (obs_date, fetched_at, row_count) VALUES ($1, now(), 0)
                 ON CONFLICT (obs_date) DO UPDATE SET fetched_at = now(), row_count = 0",
            )
            .bind(obs_date).execute(&self.pool).await?;
            return Ok(0);
        }

        let mut tx = self.pool.begin().await?;

        let mut qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
            "INSERT INTO observations (obs_date, species, latin, location, loknr, lat, lng, observer, count, behaviour, raw) ",
        );
        qb.push_values(observations, |mut b, o| {
            let species = if o.species.is_empty() { String::new() } else { o.species.clone() };
            b.push_bind(obs_date)
                .push_bind(species)
                .push_bind(o.latin.clone())
                .push_bind(none_if_empty(&o.location))
                .push_bind(o.loknr.clone())
                .push_bind(o.lat)
                .push_bind(o.lng)
                .push_bind(none_if_empty(&o.observer))
                .push_bind(o.count)
                .push_bind(None::<String>) // behaviour column — JS reads o.behaviour (undefined) → null
                .push_bind(serde_json::to_value(o).unwrap());
        });
        qb.push(
            " ON CONFLICT (obs_date, latin, loknr, observer, behaviour) DO NOTHING
              RETURNING obs_date, latin, loknr, lat, lng, location, species, count",
        );
        let inserted = qb.build().fetch_all(&mut *tx).await?;
        let n = inserted.len() as u64;

        if !inserted.is_empty() {
            apply_bucket_deltas(&mut tx, &inserted).await?;
        }

        sqlx::query(
            "INSERT INTO scrape_log (obs_date, fetched_at, row_count) VALUES ($1, now(), $2)
             ON CONFLICT (obs_date) DO UPDATE SET fetched_at = now(), row_count = EXCLUDED.row_count",
        )
        .bind(obs_date).bind(observations.len() as i32)
        .execute(&mut *tx).await?;

        tx.commit().await?;
        Ok(n)
    }
}

fn none_if_empty(s: &str) -> Option<String> {
    if s.is_empty() { None } else { Some(s.to_string()) }
}

fn row_to_json(r: &sqlx::postgres::PgRow) -> Value {
    use sqlx::Column;
    use sqlx::TypeInfo;
    let mut obj = serde_json::Map::new();
    for col in r.columns() {
        let name = col.name();
        let v: Value = match col.type_info().name() {
            "INT4" | "INT8" => r.try_get::<Option<i64>, _>(name).ok().flatten().map(|x| json!(x)).unwrap_or(Value::Null),
            "FLOAT8" | "NUMERIC" => r.try_get::<Option<f64>, _>(name).ok().flatten().map(|x| json!(x)).unwrap_or(Value::Null),
            "BOOL" => r.try_get::<Option<bool>, _>(name).ok().flatten().map(|x| json!(x)).unwrap_or(Value::Null),
            "JSONB" | "JSON" => r.try_get::<Option<Value>, _>(name).ok().flatten().unwrap_or(Value::Null),
            _ => r.try_get::<Option<String>, _>(name).ok().flatten().map(Value::String).unwrap_or(Value::Null),
        };
        obj.insert(name.to_string(), v);
    }
    Value::Object(obj)
}

// PK columns can't be NULL, so loknr=NULL is stored as '' in bucket tables.
async fn apply_bucket_deltas(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, inserted: &[sqlx::postgres::PgRow]) -> anyhow::Result<()> {
    // Accumulate week + month aggregates keyed by latin|loknr|period.
    struct Bucket {
        latin: String,
        loknr: String,
        period_a: i32, // iso_year | year
        period_b: i32, // iso_week | month
        n: i64,
        sum: i64,
        last: chrono::NaiveDate,
        lat_sum: f64,
        lat_n: i64,
        lng_sum: f64,
        lng_n: i64,
        location: Option<String>,
        species: Option<String>,
    }

    let mut week: HashMap<(String, String, i32, i32), Bucket> = HashMap::new();
    let mut month: HashMap<(String, String, i32, i32), Bucket> = HashMap::new();

    for r in inserted {
        let latin: Option<String> = r.try_get("latin").ok().flatten();
        let Some(latin) = latin.filter(|s| !s.is_empty()) else { continue };
        let obs_date: chrono::NaiveDate = r.get("obs_date");
        let loknr: String = r.try_get::<Option<String>, _>("loknr").ok().flatten().unwrap_or_default();
        let count: Option<i32> = r.try_get("count").ok().flatten();
        let eff = count.unwrap_or(1) as i64;
        let lat: Option<f64> = r.try_get("lat").ok().flatten();
        let lng: Option<f64> = r.try_get("lng").ok().flatten();
        let location: Option<String> = r.try_get("location").ok().flatten();
        let species: Option<String> = r.try_get("species").ok().flatten();

        let iso = obs_date.iso_week();
        let iso_year = iso.year();
        let iso_week = iso.week() as i32;
        let year = obs_date.year();
        let mon = obs_date.month() as i32;

        for (map, a, b) in [
            (&mut week, iso_year, iso_week),
            (&mut month, year, mon),
        ] {
            let key = (latin.clone(), loknr.clone(), a, b);
            let e = map.entry(key).or_insert_with(|| Bucket {
                latin: latin.clone(), loknr: loknr.clone(), period_a: a, period_b: b,
                n: 0, sum: 0, last: obs_date, lat_sum: 0.0, lat_n: 0, lng_sum: 0.0, lng_n: 0,
                location: location.clone(), species: species.clone(),
            });
            e.n += 1;
            e.sum += eff;
            if obs_date > e.last { e.last = obs_date; }
            if let Some(v) = lat { e.lat_sum += v; e.lat_n += 1; }
            if let Some(v) = lng { e.lng_sum += v; e.lng_n += 1; }
            if e.location.is_none() { e.location = location.clone(); }
            if e.species.is_none() { e.species = species.clone(); }
        }
    }

    {
        if !week.is_empty() {
            let mut qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
                "INSERT INTO obs_bucket_week (latin, loknr, iso_year, iso_week, n_obs, sum_count, last_obs, lat, lng, location, species) ",
            );
            qb.push_values(week.values(), |mut b, k| {
                b.push_bind(k.latin.clone()).push_bind(k.loknr.clone())
                    .push_bind(k.period_a).push_bind(k.period_b)
                    .push_bind(k.n as i32).push_bind(k.sum).push_bind(k.last)
                    .push_bind(if k.lat_n > 0 { Some(k.lat_sum / k.lat_n as f64) } else { None })
                    .push_bind(if k.lng_n > 0 { Some(k.lng_sum / k.lng_n as f64) } else { None })
                    .push_bind(k.location.clone()).push_bind(k.species.clone());
            });
            qb.push(
                " ON CONFLICT (latin, loknr, iso_year, iso_week) DO UPDATE SET
                   n_obs = obs_bucket_week.n_obs + EXCLUDED.n_obs,
                   sum_count = obs_bucket_week.sum_count + EXCLUDED.sum_count,
                   last_obs = GREATEST(obs_bucket_week.last_obs, EXCLUDED.last_obs),
                   lat = COALESCE(obs_bucket_week.lat, EXCLUDED.lat),
                   lng = COALESCE(obs_bucket_week.lng, EXCLUDED.lng),
                   location = COALESCE(obs_bucket_week.location, EXCLUDED.location),
                   species = COALESCE(obs_bucket_week.species, EXCLUDED.species)",
            );
            qb.build().execute(&mut **tx).await?;
        }

        if !month.is_empty() {
            let mut qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
                "INSERT INTO obs_bucket_month (latin, loknr, year, month, n_obs, sum_count, last_obs, lat, lng, location, species) ",
            );
            qb.push_values(month.values(), |mut b, k| {
                b.push_bind(k.latin.clone()).push_bind(k.loknr.clone())
                    .push_bind(k.period_a).push_bind(k.period_b)
                    .push_bind(k.n as i32).push_bind(k.sum).push_bind(k.last)
                    .push_bind(if k.lat_n > 0 { Some(k.lat_sum / k.lat_n as f64) } else { None })
                    .push_bind(if k.lng_n > 0 { Some(k.lng_sum / k.lng_n as f64) } else { None })
                    .push_bind(k.location.clone()).push_bind(k.species.clone());
            });
            qb.push(
                " ON CONFLICT (latin, loknr, year, month) DO UPDATE SET
                   n_obs = obs_bucket_month.n_obs + EXCLUDED.n_obs,
                   sum_count = obs_bucket_month.sum_count + EXCLUDED.sum_count,
                   last_obs = GREATEST(obs_bucket_month.last_obs, EXCLUDED.last_obs),
                   lat = COALESCE(obs_bucket_month.lat, EXCLUDED.lat),
                   lng = COALESCE(obs_bucket_month.lng, EXCLUDED.lng),
                   location = COALESCE(obs_bucket_month.location, EXCLUDED.location),
                   species = COALESCE(obs_bucket_month.species, EXCLUDED.species)",
            );
            qb.build().execute(&mut **tx).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Insert fixture observations (BIRD_UPSERT_JSON) for BIRD_UPSERT_DATE into
    /// DATABASE_URL after migrating — for comparing bucket deltas vs Node.
    #[tokio::test]
    async fn upsert_fixture() {
        let (Ok(json_path), Ok(date), Ok(url)) = (
            std::env::var("BIRD_UPSERT_JSON"),
            std::env::var("BIRD_UPSERT_DATE"),
            std::env::var("BIRD_UPSERT_DB"),
        ) else {
            return;
        };
        let obs: Vec<Observation> = serde_json::from_str(&std::fs::read_to_string(&json_path).unwrap()).unwrap();
        let db = Db::connect(&url).await.unwrap();
        db.migrate().await.unwrap();
        let n = db.upsert_observations(&date, &obs).await.unwrap();
        eprintln!("upserted {n} observations for {date}");
    }
}

/// Reproduce the Node reader's `{ ...columns, ...raw }` (raw wins on overlap).
///
/// Fast path: `raw` already contains every typed column except `behaviour`, so
/// when it's an object we start from it and only fill column keys it's missing —
/// decoding 1 column instead of 9 per row. Falls back to the full column build
/// for rows with null/non-object `raw`.
fn obs_row_to_json(r: &sqlx::postgres::PgRow) -> Value {
    let col_str = |k: &str| -> Value { r.try_get::<Option<String>, _>(k).ok().flatten().map(Value::from).unwrap_or(Value::Null) };
    let col_f64 = |k: &str| -> Value { r.try_get::<Option<f64>, _>(k).ok().flatten().map(Value::from).unwrap_or(Value::Null) };
    let col_i32 = |k: &str| -> Value { r.try_get::<Option<i32>, _>(k).ok().flatten().map(Value::from).unwrap_or(Value::Null) };

    match r.try_get::<Option<Value>, _>("raw") {
        Ok(Some(Value::Object(mut m))) => {
            // raw-wins: lazily decode + insert only column keys absent from raw
            // (usually just `behaviour`), avoiding 8 redundant decodes per row.
            let mut fill = |k: &str, decode: &dyn Fn(&str) -> Value| {
                if !m.contains_key(k) {
                    m.insert(k.to_string(), decode(k));
                }
            };
            for k in ["species", "latin", "location", "loknr", "observer", "behaviour"] {
                fill(k, &col_str);
            }
            fill("lat", &col_f64);
            fill("lng", &col_f64);
            fill("count", &col_i32);
            Value::Object(m)
        }
        _ => json!({
            "species": col_str("species"), "latin": col_str("latin"),
            "location": col_str("location"), "loknr": col_str("loknr"),
            "lat": col_f64("lat"), "lng": col_f64("lng"),
            "observer": col_str("observer"), "count": col_i32("count"),
            "behaviour": col_str("behaviour"),
        }),
    }
}
