const db = require("../db");
const { performance } = require("perf_hooks");

const DEFAULT_WEIGHTS = {
  freq: 1.0,
  recency: 0.6,
  countWeight: 0.3,
  distanceDecay: 0.4,
};

const TAU_DAYS = 14;
const DISTANCE_D0_KM = 30;
const TOP_K_CANDIDATES = 60;
const LOOKBACK_YEARS = 3;

function distanceKm(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function wrapWeekSet(targetWeek, span) {
  const set = new Set();
  for (let i = -span; i <= span; i++) {
    let w = targetWeek + i;
    if (w < 1) w += 53;
    if (w > 53) w -= 53;
    set.add(w);
  }
  return [...set];
}

async function aggregateBySite({ latinList, weekSet, fromDate }) {
  const { rows } = await db.query(
    `
    WITH relevant AS (
      SELECT
        o.id, o.latin, o.loknr, o.location, o.species,
        o.lat, o.lng, o.obs_date, o.count, o.observer, o.behaviour
      FROM observations o
      WHERE lower(o.latin) = ANY($1)
        AND EXTRACT(week FROM o.obs_date)::int = ANY($2)
        AND o.obs_date >= $3::date
    )
    SELECT
      latin,
      lower(latin) AS latin_key,
      max(species) AS species,
      loknr,
      max(location) AS location,
      avg(lat) FILTER (WHERE lat IS NOT NULL) AS lat,
      avg(lng) FILTER (WHERE lng IS NOT NULL) AS lng,
      count(*)::int AS freq,
      max(obs_date) AS last_obs,
      avg(coalesce(count, 1))::float AS avg_count
    FROM relevant
    GROUP BY latin, lower(latin), loknr
    HAVING count(*) >= 1
    ORDER BY freq DESC
    LIMIT 800
    `,
    [latinList.map((s) => s.toLowerCase()), weekSet, fromDate]
  );
  return rows;
}

async function fetchEvidence({ latinList, loknrList, weekSet, fromDate }) {
  if (!latinList.length || !loknrList.length) return new Map();
  const { rows } = await db.query(
    `
    SELECT
      o.latin, o.loknr, o.location, o.species,
      to_char(o.obs_date, 'YYYY-MM-DD') AS obs_date,
      o.count, o.observer, o.behaviour, o.raw
    FROM observations o
    WHERE lower(o.latin) = ANY($1)
      AND o.loknr = ANY($2)
      AND EXTRACT(week FROM o.obs_date)::int = ANY($3)
      AND o.obs_date >= $4::date
    ORDER BY o.obs_date DESC
    `,
    [
      latinList.map((s) => s.toLowerCase()),
      loknrList,
      weekSet,
      fromDate,
    ]
  );
  const map = new Map();
  for (const r of rows) {
    const key = `${r.latin.toLowerCase()}|${r.loknr || ""}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      date: r.obs_date,
      location: r.location,
      count: r.count,
      observer: r.observer,
      behaviour: r.behaviour,
      rare: r.raw?.rare,
    });
  }
  return map;
}

function scoreCandidate(row, { weights, userLat, userLng, useDistance }) {
  const freqScore = Math.log1p(row.freq) / Math.log1p(50);
  const daysSince =
    row.last_obs == null
      ? 999
      : Math.max(
          0,
          Math.floor((Date.now() - new Date(row.last_obs).getTime()) / 86400000)
        );
  const recency = Math.exp(-daysSince / TAU_DAYS);
  const countWeight = Math.log1p(row.avg_count || 1) / Math.log1p(50);
  let distanceDecay = 1;
  let distKm = null;
  if (useDistance && row.lat != null && row.lng != null) {
    distKm = distanceKm(userLat, userLng, row.lat, row.lng);
    distanceDecay = distKm == null ? 0.5 : Math.exp(-distKm / DISTANCE_D0_KM);
  }

  const score =
    weights.freq * freqScore +
    weights.recency * recency +
    weights.countWeight * countWeight +
    (useDistance ? weights.distanceDecay * distanceDecay : 0);

  return {
    latin: row.latin,
    species: row.species,
    loknr: row.loknr,
    location: row.location,
    lat: row.lat,
    lng: row.lng,
    freq: row.freq,
    avgCount: row.avg_count,
    daysSince,
    distKm: distKm == null ? null : Math.round(distKm * 10) / 10,
    score,
    components: { freqScore, recency, countWeight, distanceDecay },
  };
}

async function rankCandidatesForDay({
  lat,
  lng,
  missingLatins,
  today = new Date(),
  weights = DEFAULT_WEIGHTS,
  topK = TOP_K_CANDIDATES,
  timings = null,
}) {
  if (!missingLatins?.length) return [];
  const targetWeek = isoWeek(today);
  let weekSet = wrapWeekSet(targetWeek, 1);
  // Anchor to Jan 1 of (year - LOOKBACK_YEARS) so the date-based filters used
  // by the evidence/aggregate fallback queries cover the same calendar span as
  // the bucket query's `iso_year >= fromYear` filter — otherwise Jan-* of the
  // earliest year is silently trimmed from evidence.
  const fromDate = new Date(Date.UTC(today.getFullYear() - LOOKBACK_YEARS, 0, 1));

  const fromDateStr = fromDate.toISOString().slice(0, 10);

  let bucketMs = 0;
  let aggregateMs = 0;
  const t0 = performance.now();
  let rows = await db.getBucketWeekCandidates({
    latinList: missingLatins,
    weekSet,
    fromDate: fromDateStr,
  });

  if (rows.length === 0) {
    weekSet = wrapWeekSet(targetWeek, 2);
    rows = await db.getBucketWeekCandidates({
      latinList: missingLatins,
      weekSet,
      fromDate: fromDateStr,
    });
  }
  bucketMs = performance.now() - t0;

  // Fallback to live aggregate if bucket store has nothing yet (e.g. before
  // first backfill finishes for a species).
  if (rows.length === 0) {
    const tAgg = performance.now();
    rows = await aggregateBySite({
      latinList: missingLatins,
      weekSet,
      fromDate: fromDateStr,
    });
    aggregateMs = performance.now() - tAgg;
  }

  if (timings) {
    timings.bucket = Math.round(bucketMs);
    if (aggregateMs) timings.aggregate = Math.round(aggregateMs);
  }

  if (rows.length === 0) return [];

  const scored = rows
    .map((r) =>
      scoreCandidate(r, {
        weights,
        userLat: lat,
        userLng: lng,
        useDistance: true,
      })
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const tEv = performance.now();
  const evidence = await fetchEvidence({
    latinList: [...new Set(scored.map((s) => s.latin))],
    loknrList: [...new Set(scored.map((s) => s.loknr).filter(Boolean))],
    weekSet,
    fromDate: fromDate.toISOString().slice(0, 10),
  });
  if (timings) timings.evidence = Math.round(performance.now() - tEv);

  for (const c of scored) {
    const key = `${c.latin.toLowerCase()}|${c.loknr || ""}`;
    c.evidence = evidence.get(key) || [];
  }

  return scored;
}

async function rankCandidatesForCalendar({
  month,
  missingLatins,
  weights = DEFAULT_WEIGHTS,
  topK = TOP_K_CANDIDATES,
}) {
  if (!missingLatins?.length) return [];
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return [];
  const targetYear = parseInt(m[1], 10);
  const targetMonth = parseInt(m[2], 10);

  const firstOfMonth = new Date(Date.UTC(targetYear, targetMonth - 1, 1));
  const lastOfMonth = new Date(Date.UTC(targetYear, targetMonth, 0));
  const weekSet = new Set();
  for (let d = new Date(firstOfMonth); d <= lastOfMonth; d.setUTCDate(d.getUTCDate() + 3)) {
    weekSet.add(isoWeek(d));
  }
  const fromDate = new Date(Date.UTC(targetYear - LOOKBACK_YEARS, targetMonth - 1, 1))
    .toISOString()
    .slice(0, 10);

  let rows = await db.getBucketMonthCandidates({
    latinList: missingLatins,
    year: targetYear,
    month: targetMonth,
    lookbackYears: LOOKBACK_YEARS,
  });

  if (rows.length === 0) {
    rows = await aggregateBySite({
      latinList: missingLatins,
      weekSet: [...weekSet],
      fromDate,
    });
  }
  if (rows.length === 0) return [];

  const scored = rows
    .map((r) =>
      scoreCandidate(r, {
        weights,
        useDistance: false,
      })
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const evidence = await fetchEvidence({
    latinList: [...new Set(scored.map((s) => s.latin))],
    loknrList: [...new Set(scored.map((s) => s.loknr).filter(Boolean))],
    weekSet: [...weekSet],
    fromDate,
  });

  for (const c of scored) {
    const key = `${c.latin.toLowerCase()}|${c.loknr || ""}`;
    c.evidence = evidence.get(key) || [];
  }

  return scored;
}

module.exports = {
  rankCandidatesForDay,
  rankCandidatesForCalendar,
  isoWeek,
  DEFAULT_WEIGHTS,
};
