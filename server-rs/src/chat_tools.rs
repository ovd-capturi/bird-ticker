//! Chat tool implementations + OpenAI-style schemas — port of
//! `proxy/chat-tools.js`. All tools read local DB / predictor data only.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{json, Value};

use crate::predictor;
use crate::AppState;

/// Context threaded into every tool call.
pub struct ChatCtx {
    pub birds: Vec<Value>,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
}

// ── Embedded species facts, indexed at first use ───────────────────────────
static FACTS_JSON: &str = include_str!("../data/species-facts.json");

struct Facts {
    by_art: HashMap<String, Value>,
    by_latin: HashMap<String, Value>,
    by_name: HashMap<String, Value>,
}

static FACTS: LazyLock<Facts> = LazyLock::new(|| {
    let mut f = Facts { by_art: HashMap::new(), by_latin: HashMap::new(), by_name: HashMap::new() };
    if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(FACTS_JSON) {
        for r in arr {
            if let Some(art) = r.get("artId") {
                let art = art.as_str().map(String::from).unwrap_or_else(|| art.to_string());
                f.by_art.insert(art, r.clone());
            }
            if let Some(latin) = r.get("latin").and_then(|v| v.as_str()) {
                f.by_latin.insert(latin.to_lowercase(), r.clone());
            }
            if let Some(name) = r.get("name").and_then(|v| v.as_str()) {
                f.by_name.insert(name.to_lowercase(), r.clone());
            }
        }
    }
    f
});

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn missing_latins(birds: &[Value]) -> Vec<String> {
    birds
        .iter()
        .filter(|b| b.get("ticked").and_then(|v| v.as_bool()) != Some(true))
        .filter_map(|b| b.get("latin").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from))
        .collect()
}

fn name_map(birds: &[Value]) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for b in birds {
        if let (Some(latin), Some(name)) = (
            b.get("latin").and_then(|v| v.as_str()).filter(|s| !s.is_empty()),
            b.get("name").and_then(|v| v.as_str()),
        ) {
            m.insert(latin.to_lowercase(), name.to_string());
        }
    }
    m
}

fn valid_month(m: &str) -> bool {
    m.len() == 7 && m.as_bytes()[4] == b'-' && m[0..4].bytes().all(|c| c.is_ascii_digit()) && m[5..7].bytes().all(|c| c.is_ascii_digit())
}

fn clamp_limit(args: &Value, default: i64) -> i64 {
    let v = args.get("limit").and_then(|x| x.as_i64().or_else(|| x.as_str().and_then(|s| s.parse().ok()))).unwrap_or(default);
    v.clamp(1, 100)
}

fn evidence_sample(evidence: &[crate::db::Evidence], n: usize) -> Vec<Value> {
    evidence.iter().take(n).map(|e| json!({
        "date": e.date, "location": e.location, "count": e.count, "behaviour": e.behaviour,
    })).collect()
}

/// Dispatch a tool call. Errors are returned as `{ "error": ... }` (mirrors the
/// JS `runTool` try/catch), never propagated.
pub async fn run_tool(st: &AppState, ctx: &ChatCtx, name: &str, args: &Value) -> Value {
    let result = match name {
        "get_predictor_dataset" => tool_predictor_dataset(st, ctx, args).await,
        "lookup_species" => tool_lookup_species(st, args).await,
        "lookup_locality" => tool_lookup_locality(st, args).await,
        "get_ticklist_summary" => Ok(tool_ticklist_summary(ctx)),
        "get_recent_observations" => tool_recent_observations(st, args).await,
        "lookup_species_facts" => Ok(tool_species_facts(args)),
        _ => return json!({ "error": format!("Unknown tool {name}") }),
    };
    match result {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("Tool {name} failed: {e}");
            json!({ "error": e.to_string() })
        }
    }
}

async fn tool_predictor_dataset(st: &AppState, ctx: &ChatCtx, args: &Value) -> anyhow::Result<Value> {
    let db = st.db.as_ref().ok_or_else(|| anyhow::anyhow!("DB not configured"))?;
    let mode = if args.get("mode").and_then(|v| v.as_str()) == Some("calendar") { "calendar" } else { "day" };
    let month = args.get("month").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if mode == "calendar" && !valid_month(&month) {
        return Ok(json!({ "error": "month (YYYY-MM) required for mode=calendar" }));
    }
    if mode == "day" && (ctx.lat.is_none() || ctx.lng.is_none()) {
        return Ok(json!({ "error": "User location unknown; ask the user to enable location, or use mode=calendar." }));
    }

    let missing = missing_latins(&ctx.birds);
    if missing.is_empty() {
        return Ok(json!({ "mode": mode, "candidates": [], "note": "User has no missing species." }));
    }
    let names = name_map(&ctx.birds);

    if mode == "day" {
        let items = predictor::rank_for_day(db, ctx.lat.unwrap(), ctx.lng.unwrap(), &missing).await?;
        let candidates: Vec<Value> = items.iter().map(|it| json!({
            "latin": it.latin,
            "name": names.get(&it.latin.to_lowercase()).cloned().or_else(|| it.species.clone()),
            "band": it.band,
            "score": round2(it.score_norm),
            "cluster": { "name": it.cluster.name, "loknr": it.cluster.loknr },
            "evidenceCount": it.evidence.len(),
            "evidenceSample": evidence_sample(&it.evidence, 5),
        })).collect();
        Ok(json!({ "mode": mode, "candidates": candidates }))
    } else {
        let items = predictor::rank_for_calendar(db, &month, &missing).await?;
        let locations: Vec<Value> = items.iter().map(|it| json!({
            "name": it.cluster.name,
            "loknr": it.cluster.loknr,
            "speciesCount": it.species.len(),
            "species": it.species.iter().map(|s| json!({
                "latin": s.latin,
                "name": names.get(&s.latin.to_lowercase()).cloned().or_else(|| s.species.clone()),
                "band": s.band,
                "score": round2(s.score_norm),
                "evidenceCount": s.evidence.len(),
                "evidenceSample": evidence_sample(&s.evidence, 3),
            })).collect::<Vec<_>>(),
        })).collect();
        Ok(json!({ "mode": mode, "month": month, "locations": locations }))
    }
}

async fn tool_lookup_species(st: &AppState, args: &Value) -> anyhow::Result<Value> {
    let db = st.db.as_ref().ok_or_else(|| anyhow::anyhow!("DB not configured"))?;
    let latin = args.get("latin").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if latin.is_empty() {
        return Ok(json!({ "error": "latin required" }));
    }
    let limit = clamp_limit(args, 25);
    let recent = db.chat_recent_for_species(&latin, limit).await?;
    let monthly = db.chat_species_monthly(&latin).await?;
    let histogram: Vec<Value> = monthly.iter().map(|r| json!({
        "month": r.get("month"), "observations": r.get("n"),
    })).collect();
    Ok(json!({ "latin": latin, "recent": recent, "monthlyHistogram": histogram }))
}

async fn tool_lookup_locality(st: &AppState, args: &Value) -> anyhow::Result<Value> {
    let db = st.db.as_ref().ok_or_else(|| anyhow::anyhow!("DB not configured"))?;
    let loknr = args.get("loknr").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).filter(|s| !s.is_empty());
    let name_query = args.get("name").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let limit = clamp_limit(args, 30);
    if loknr.is_none() && name_query.is_none() {
        return Ok(json!({ "error": "loknr or name required" }));
    }

    let (observations, species_agg, query) = if let Some(loknr) = &loknr {
        (db.chat_obs_by_loknr(loknr, limit).await?, db.chat_species_at_loknr(loknr).await?, json!({ "loknr": loknr }))
    } else {
        let like = format!("%{}%", name_query.as_ref().unwrap());
        (db.chat_obs_by_name(&like, limit).await?, db.chat_species_at_name(&like).await?, json!({ "name": name_query }))
    };

    let species_at: Vec<Value> = species_agg.iter().map(|r| json!({
        "latin": r.get("latin"),
        "species": r.get("species"),
        "observations": r.get("n"),
        "lastSeen": r.get("last_seen"),
    })).collect();
    Ok(json!({ "query": query, "observations": observations, "speciesAtLocation": species_at }))
}

fn tool_ticklist_summary(ctx: &ChatCtx) -> Value {
    let birds = &ctx.birds;
    let is_ticked = |b: &&Value| b.get("ticked").and_then(|v| v.as_bool()) == Some(true);
    let ticked = birds.iter().filter(is_ticked).count();
    let missing: Vec<&Value> = birds.iter().filter(|b| !is_ticked(b)).collect();
    let missing_su = missing.iter().filter(|b| b.get("isSU").and_then(|v| v.as_bool()) == Some(true)).count();
    let sample: Vec<Value> = missing.iter().take(40).map(|b| json!({
        "name": b.get("name"), "latin": b.get("latin"), "isSU": b.get("isSU"),
    })).collect();
    json!({
        "total": birds.len(), "ticked": ticked, "missing": missing.len(),
        "missingSU": missing_su, "sampleMissing": sample,
    })
}

async fn tool_recent_observations(st: &AppState, args: &Value) -> anyhow::Result<Value> {
    let db = st.db.as_ref().ok_or_else(|| anyhow::anyhow!("DB not configured"))?;
    let date = args.get("date").and_then(|v| v.as_str()).filter(|d| d.len() == 10 && d.as_bytes()[4] == b'-');
    let limit = clamp_limit(args, 40);

    if let Some(date) = date {
        let obs = db.get_observations_by_date(date).await?;
        let trimmed: Vec<Value> = obs.iter().take(limit as usize).map(|o| json!({
            "species": o.get("species"), "latin": o.get("latin"), "location": o.get("location"),
            "loknr": o.get("loknr"), "count": o.get("count"), "behaviour": o.get("behaviour"),
        })).collect();
        return Ok(json!({ "date": date, "count": obs.len(), "observations": trimmed }));
    }
    let rows = db.chat_recent_all(limit).await?;
    Ok(json!({ "observations": rows }))
}

fn tool_species_facts(args: &Value) -> Value {
    let art_id = args.get("artId").and_then(|v| v.as_str()).map(|s| format!("{:0>5}", s));
    let latin = args.get("latin").and_then(|v| v.as_str()).map(|s| s.trim().to_lowercase());
    let name = args.get("name").and_then(|v| v.as_str()).map(|s| s.trim().to_lowercase());

    let mut record: Option<&Value> = None;
    if let Some(a) = &art_id {
        record = FACTS.by_art.get(a);
    }
    if record.is_none() {
        if let Some(l) = &latin {
            record = FACTS.by_latin.get(l);
        }
    }
    if record.is_none() {
        if let Some(n) = &name {
            record = FACTS.by_name.get(n);
        }
    }
    // Fuzzy: name prefix either direction.
    if record.is_none() {
        if let Some(n) = &name {
            record = FACTS.by_name.iter().find(|(k, _)| k.starts_with(n.as_str()) || n.starts_with(k.as_str())).map(|(_, v)| v);
        }
    }

    let Some(record) = record else {
        return json!({
            "error": "No species facts found",
            "hint": "Try a different latin/name, or use lookup_species for raw observations.",
        });
    };

    // Return only the curated fields that exist (matches the JS object literal;
    // absent keys like `latin` are simply omitted).
    let mut out = serde_json::Map::new();
    for key in ["artId", "name", "latin", "description", "habitat", "diet", "population", "protection", "breeding", "facts", "image", "sourceUrl"] {
        if let Some(v) = record.get(key) {
            if !v.is_null() {
                out.insert(key.to_string(), v.clone());
            }
        }
    }
    Value::Object(out)
}

/// OpenAI-style tool schemas advertised to the model. Mirrors `TOOL_SCHEMAS`.
pub fn tool_schemas() -> Value {
    json!([
        { "type": "function", "function": {
            "name": "get_predictor_dataset",
            "description": "Returns ranked candidate locations/species for the user's missing birds, based on historical DOFbasen observations near the user (mode=day) or for an upcoming month (mode=calendar).",
            "parameters": { "type": "object", "properties": {
                "mode": { "type": "string", "enum": ["day", "calendar"], "description": "'day' uses user location; 'calendar' uses month aggregates." },
                "month": { "type": "string", "description": "Required for mode=calendar. Format YYYY-MM." }
            }, "required": ["mode"] }
        }},
        { "type": "function", "function": {
            "name": "lookup_species",
            "description": "Returns recent local observations for a single species (latin name) plus a monthly observation histogram across all years.",
            "parameters": { "type": "object", "properties": {
                "latin": { "type": "string", "description": "Latin name, e.g. 'Pandion haliaetus'." },
                "limit": { "type": "integer", "description": "Max recent observations (1-100, default 25)." }
            }, "required": ["latin"] }
        }},
        { "type": "function", "function": {
            "name": "lookup_locality",
            "description": "Returns recent observations and per-species totals at a locality. Provide either loknr (DOFbasen locality id) or a name fragment.",
            "parameters": { "type": "object", "properties": {
                "loknr": { "type": "string", "description": "DOFbasen locality number." },
                "name": { "type": "string", "description": "Locality name fragment (case-insensitive)." },
                "limit": { "type": "integer", "description": "Max observations (1-100, default 30)." }
            } }
        }},
        { "type": "function", "function": {
            "name": "get_ticklist_summary",
            "description": "Returns counts for the user's Netfugl tick list (total, ticked, missing, missing SU) plus a sample of missing species.",
            "parameters": { "type": "object", "properties": {} }
        }},
        { "type": "function", "function": {
            "name": "lookup_species_facts",
            "description": "Returns curated DOFbasen species facts (beskrivelse, levested, føde, bestand, beskyttelse, yngleudbredelse) plus a hero image path for a Danish bird species. Use this when the user asks about a specific species. The returned 'image' field is a local path you can show in the answer via markdown image syntax ![navn](sti).",
            "parameters": { "type": "object", "properties": {
                "latin": { "type": "string", "description": "Latin name (preferred)." },
                "name": { "type": "string", "description": "Danish common name." },
                "artId": { "type": "string", "description": "5-digit DOFbasen art id." }
            } }
        }},
        { "type": "function", "function": {
            "name": "get_recent_observations",
            "description": "Returns recent DOFbasen observations, optionally filtered by date (YYYY-MM-DD). Without a date, returns the most recent observations across the country.",
            "parameters": { "type": "object", "properties": {
                "date": { "type": "string", "description": "YYYY-MM-DD (optional)." },
                "limit": { "type": "integer", "description": "Max rows (1-100, default 40)." }
            } }
        }}
    ])
}
