//! Statistical predictor — port of `proxy/predictor/{index,stats}.js`.
//!
//! Ranks missing species by a weighted blend of frequency, recency, typical
//! count and (for the day view) distance, then groups results into geographic
//! clusters. No ML inference — pure statistics over the observation buckets.

pub mod cluster;

use std::collections::{HashMap, HashSet};

use chrono::{Datelike, Duration, Local, NaiveDate};

use crate::db::{CandidateRow, Db, Evidence};
use cluster::{cluster_by_radius, distance_km, Cluster, CLUSTER_RADIUS_KM};

const TAU_DAYS: f64 = 14.0;
const DISTANCE_D0_KM: f64 = 30.0;
const TOP_K_CANDIDATES: usize = 60;
const LOOKBACK_YEARS: i32 = 3;

const DAY_OUTPUT_LIMIT: usize = 15;
const CALENDAR_OUTPUT_LIMIT: usize = 10;
const MAX_SPECIES_PER_CLUSTER: usize = 8;

struct Weights {
    freq: f64,
    recency: f64,
    count_weight: f64,
    distance_decay: f64,
}
const WEIGHTS: Weights = Weights { freq: 1.0, recency: 0.6, count_weight: 0.3, distance_decay: 0.4 };

/// A scored candidate site for a species, fed into clustering.
#[derive(Clone)]
pub struct Scored {
    pub latin: String,
    pub species: Option<String>,
    pub loknr: Option<String>,
    pub location: Option<String>,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub score: f64,
    pub evidence: Vec<Evidence>,
}

// ── Output shapes (serialized by the route handlers) ───────────────────────
pub struct NearbyOut {
    pub location: Option<String>,
    pub loknr: Option<String>,
    pub dist_km: Option<f64>,
    pub score: f64,
}
pub struct ClusterOut {
    pub name: Option<String>,
    pub loknr: Option<String>,
    pub centroid_lat: Option<f64>,
    pub centroid_lng: Option<f64>,
    pub nearby: Vec<NearbyOut>,
}
pub struct DayItem {
    pub latin: String,
    pub species: Option<String>,
    pub score: f64,
    pub score_norm: f64,
    pub band: &'static str,
    pub cluster: ClusterOut,
    pub evidence: Vec<Evidence>,
}
pub struct CalSpecies {
    pub latin: String,
    pub species: Option<String>,
    pub score: f64,
    pub score_norm: f64,
    pub band: &'static str,
    pub evidence: Vec<Evidence>,
}
pub struct CalItem {
    pub cluster: ClusterOut,
    pub score: f64,
    pub species: Vec<CalSpecies>,
}

fn band_from_score(score_norm: f64) -> &'static str {
    if score_norm >= 0.7 {
        "høj"
    } else if score_norm >= 0.4 {
        "mellem"
    } else {
        "lav"
    }
}

fn iso_week(d: NaiveDate) -> i32 {
    d.iso_week().week() as i32
}

fn wrap_week_set(target: i32, span: i32) -> Vec<i32> {
    let mut set = HashSet::new();
    for i in -span..=span {
        let mut w = target + i;
        if w < 1 {
            w += 53;
        }
        if w > 53 {
            w -= 53;
        }
        set.insert(w);
    }
    set.into_iter().collect()
}

fn cluster_out(cl: &Cluster, nearby_limit: usize) -> ClusterOut {
    ClusterOut {
        name: cl.name.clone(),
        loknr: cl.loknr.clone(),
        centroid_lat: cl.centroid_lat,
        centroid_lng: cl.centroid_lng,
        nearby: cl
            .nearby
            .iter()
            .take(nearby_limit)
            .map(|n| NearbyOut {
                location: n.location.clone(),
                loknr: n.loknr.clone(),
                dist_km: n.dist_km,
                score: n.score,
            })
            .collect(),
    }
}

fn score_candidate(row: CandidateRow, user: Option<(f64, f64)>, today: NaiveDate) -> Scored {
    let freq_score = (1.0 + row.freq as f64).ln() / 51.0_f64.ln();
    let days_since = match row.last_obs {
        None => 999,
        Some(d) => (today - d).num_days().max(0),
    };
    let recency = (-(days_since as f64) / TAU_DAYS).exp();
    let avg = match row.avg_count {
        Some(v) if v != 0.0 => v,
        _ => 1.0,
    };
    let count_weight = (1.0 + avg).ln() / 51.0_f64.ln();

    let mut distance_decay = 1.0;
    let use_distance = user.is_some();
    if let (Some((ulat, ulng)), Some(lat), Some(lng)) = (user, row.lat, row.lng) {
        let dist = distance_km(ulat, ulng, lat, lng);
        distance_decay = (-dist / DISTANCE_D0_KM).exp();
    }

    let score = WEIGHTS.freq * freq_score
        + WEIGHTS.recency * recency
        + WEIGHTS.count_weight * count_weight
        + if use_distance { WEIGHTS.distance_decay * distance_decay } else { 0.0 };

    Scored {
        latin: row.latin,
        species: row.species,
        loknr: row.loknr,
        location: row.location,
        lat: row.lat,
        lng: row.lng,
        score,
        evidence: Vec::new(),
    }
}

async fn attach_evidence(db: &Db, scored: &mut [Scored], week_set: &[i32], from_date: &str) -> anyhow::Result<()> {
    let latins: Vec<String> = scored.iter().map(|s| s.latin.clone()).collect::<HashSet<_>>().into_iter().collect();
    let loknrs: Vec<String> = scored.iter().filter_map(|s| s.loknr.clone()).collect::<HashSet<_>>().into_iter().collect();
    let map = db.fetch_evidence(&latins, &loknrs, week_set, from_date).await?;
    for c in scored.iter_mut() {
        let key = format!("{}|{}", c.latin.to_lowercase(), c.loknr.clone().unwrap_or_default());
        c.evidence = map.get(&key).cloned().unwrap_or_default();
    }
    Ok(())
}

fn jan_first_lookback(year: i32) -> String {
    NaiveDate::from_ymd_opt(year - LOOKBACK_YEARS, 1, 1).unwrap().format("%Y-%m-%d").to_string()
}

// ── Candidate ranking (stats.js) ───────────────────────────────────────────
async fn rank_candidates_for_day(db: &Db, lat: f64, lng: f64, missing: &[String]) -> anyhow::Result<Vec<Scored>> {
    if missing.is_empty() {
        return Ok(vec![]);
    }
    let today = Local::now().date_naive();
    let target_week = iso_week(today);
    let mut week_set = wrap_week_set(target_week, 1);
    let from_date = jan_first_lookback(today.year());

    let mut rows = db.get_bucket_week_candidates(missing, &week_set, &from_date).await?;
    if rows.is_empty() {
        week_set = wrap_week_set(target_week, 2);
        rows = db.get_bucket_week_candidates(missing, &week_set, &from_date).await?;
    }
    if rows.is_empty() {
        rows = db.aggregate_by_site(missing, &week_set, &from_date).await?;
    }
    if rows.is_empty() {
        return Ok(vec![]);
    }

    let mut scored: Vec<Scored> = rows.into_iter().map(|r| score_candidate(r, Some((lat, lng)), today)).collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(TOP_K_CANDIDATES);
    attach_evidence(db, &mut scored, &week_set, &from_date).await?;
    Ok(scored)
}

async fn rank_candidates_for_calendar(db: &Db, month: &str, missing: &[String]) -> anyhow::Result<Vec<Scored>> {
    if missing.is_empty() {
        return Ok(vec![]);
    }
    let Some((year, mon)) = parse_month(month) else { return Ok(vec![]) };

    let first = NaiveDate::from_ymd_opt(year, mon as u32, 1).unwrap();
    let last = last_of_month(year, mon);
    let mut week_set: HashSet<i32> = HashSet::new();
    let mut d = first;
    while d <= last {
        week_set.insert(iso_week(d));
        d += Duration::days(3);
    }
    let week_set: Vec<i32> = week_set.into_iter().collect();
    let from_date = NaiveDate::from_ymd_opt(year - LOOKBACK_YEARS, mon as u32, 1).unwrap().format("%Y-%m-%d").to_string();

    let mut rows = db.get_bucket_month_candidates(missing, year, mon, LOOKBACK_YEARS).await?;
    if rows.is_empty() {
        rows = db.aggregate_by_site(missing, &week_set, &from_date).await?;
    }
    if rows.is_empty() {
        return Ok(vec![]);
    }

    let today = Local::now().date_naive();
    let mut scored: Vec<Scored> = rows.into_iter().map(|r| score_candidate(r, None, today)).collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(TOP_K_CANDIDATES);
    attach_evidence(db, &mut scored, &week_set, &from_date).await?;
    Ok(scored)
}

fn parse_month(month: &str) -> Option<(i32, i32)> {
    let b = month.as_bytes();
    if b.len() != 7 || b[4] != b'-' {
        return None;
    }
    let y: i32 = month.get(0..4)?.parse().ok()?;
    let m: i32 = month.get(5..7)?.parse().ok()?;
    if !(1..=12).contains(&m) {
        return None;
    }
    Some((y, m))
}

fn last_of_month(year: i32, month: i32) -> NaiveDate {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(ny, nm as u32, 1).unwrap().pred_opt().unwrap()
}

// ── Public ranking (index.js) ──────────────────────────────────────────────
fn evidence_by_date_desc(mut ev: Vec<Evidence>) -> Vec<Evidence> {
    ev.sort_by(|a, b| b.date.cmp(&a.date));
    ev
}

pub async fn rank_for_day(db: &Db, lat: f64, lng: f64, missing: &[String]) -> anyhow::Result<Vec<DayItem>> {
    let candidates = rank_candidates_for_day(db, lat, lng, missing).await?;
    if candidates.is_empty() {
        return Ok(vec![]);
    }

    // Group by species, cluster each, keep the best cluster per species.
    let mut by_species: HashMap<String, Vec<Scored>> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for c in &candidates {
        let key = c.latin.to_lowercase();
        if !by_species.contains_key(&key) {
            order.push(key.clone());
        }
        by_species.entry(key).or_default().push(c.clone());
    }

    struct SpeciesItem {
        latin: String,
        species: Option<String>,
        cluster: ClusterOut,
        score: f64,
        evidence: Vec<Evidence>,
    }
    let mut items: Vec<SpeciesItem> = Vec::new();
    for key in &order {
        let per_species = &by_species[key];
        let clusters = cluster_by_radius(per_species, CLUSTER_RADIUS_KM);
        if clusters.is_empty() {
            continue;
        }
        let best = clusters.iter().max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal)).unwrap();
        let mut all_ev: Vec<Evidence> = Vec::new();
        for m in &best.members {
            all_ev.extend(m.cand.evidence.clone());
        }
        items.push(SpeciesItem {
            latin: per_species[0].latin.clone(),
            species: per_species[0].species.clone(),
            cluster: cluster_out(best, 5),
            score: best.score,
            evidence: evidence_by_date_desc(all_ev),
        });
    }

    items.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let max = items.iter().fold(0.0_f64, |m, x| m.max(x.score)).max(f64::MIN_POSITIVE);
    let max = if max <= 0.0 { 1.0 } else { max };

    Ok(items
        .into_iter()
        .take(DAY_OUTPUT_LIMIT)
        .map(|it| {
            let score_norm = it.score / max;
            DayItem {
                latin: it.latin,
                species: it.species,
                score: it.score,
                score_norm,
                band: band_from_score(score_norm),
                cluster: it.cluster,
                evidence: it.evidence,
            }
        })
        .collect())
}

pub async fn rank_for_calendar(db: &Db, month: &str, missing: &[String]) -> anyhow::Result<Vec<CalItem>> {
    let candidates = rank_candidates_for_calendar(db, month, missing).await?;
    if candidates.is_empty() {
        return Ok(vec![]);
    }
    let clusters = cluster_by_radius(&candidates, CLUSTER_RADIUS_KM);
    if clusters.is_empty() {
        return Ok(vec![]);
    }

    struct PreSpecies {
        latin: String,
        species: Option<String>,
        score: f64,
        evidence: Vec<Evidence>,
    }
    struct Pre {
        cluster: ClusterOut,
        score: f64,
        species: Vec<PreSpecies>,
    }

    let mut pre: Vec<Pre> = Vec::new();
    for cl in &clusters {
        // Best member per species, then top MAX_SPECIES_PER_CLUSTER by score.
        let mut best: HashMap<String, Scored> = HashMap::new();
        let mut sp_order: Vec<String> = Vec::new();
        for m in &cl.members {
            let key = m.cand.latin.to_lowercase();
            match best.get(&key) {
                Some(existing) if existing.score >= m.cand.score => {}
                _ => {
                    if !best.contains_key(&key) {
                        sp_order.push(key.clone());
                    }
                    best.insert(key, m.cand.clone());
                }
            }
        }
        let mut species_list: Vec<Scored> = sp_order.iter().map(|k| best[k].clone()).collect();
        species_list.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        species_list.truncate(MAX_SPECIES_PER_CLUSTER);

        let species: Vec<PreSpecies> = species_list
            .iter()
            .map(|s| {
                let mut samples: Vec<Evidence> = Vec::new();
                for m in &cl.members {
                    if m.cand.latin.to_lowercase() == s.latin.to_lowercase() {
                        samples.extend(m.cand.evidence.clone());
                    }
                }
                PreSpecies {
                    latin: s.latin.clone(),
                    species: s.species.clone(),
                    score: s.score,
                    evidence: evidence_by_date_desc(samples),
                }
            })
            .collect();

        pre.push(Pre { cluster: cluster_out(cl, 6), score: cl.score, species });
    }

    // Sort by species count desc, then cluster score desc.
    pre.sort_by(|a, b| {
        b.species.len().cmp(&a.species.len()).then(b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
    });
    pre.truncate(CALENDAR_OUTPUT_LIMIT);

    let species_max = pre
        .iter()
        .flat_map(|it| it.species.iter().map(|s| s.score))
        .fold(0.0_f64, f64::max);
    let species_max = if species_max <= 0.0 { 1.0 } else { species_max };

    Ok(pre
        .into_iter()
        .map(|it| CalItem {
            cluster: it.cluster,
            score: it.score,
            species: it
                .species
                .into_iter()
                .map(|s| {
                    let score_norm = s.score / species_max;
                    CalSpecies {
                        latin: s.latin,
                        species: s.species,
                        score: s.score,
                        score_norm,
                        band: band_from_score(score_norm),
                        evidence: s.evidence,
                    }
                })
                .collect(),
        })
        .collect())
}
