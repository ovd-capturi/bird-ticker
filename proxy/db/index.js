const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
const ssl = process.env.PGSSL === "false" ? false : { rejectUnauthorized: false };

let pool = null;
let enabled = false;

if (connectionString) {
  pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? false : ssl,
    max: 8,
    idleTimeoutMillis: 30000,
  });
  pool.on("error", (err) => console.error("pg pool error:", err.message));
  enabled = true;
}

async function query(text, params) {
  if (!pool) throw new Error("DB not configured (DATABASE_URL missing)");
  return pool.query(text, params);
}

function isEnabled() {
  return enabled;
}

async function close() {
  if (pool) await pool.end();
}

// ── Push subscriptions ────────────────────────────────────────────────
async function upsertPushSubscription({ endpoint, userId, listType, subscription }) {
  await query(
    `INSERT INTO push_subscriptions (endpoint, user_id, list_type, subscription_json, last_seen_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           list_type = EXCLUDED.list_type,
           subscription_json = EXCLUDED.subscription_json,
           last_seen_at = now()`,
    [endpoint, String(userId), String(listType || "1"), JSON.stringify(subscription)]
  );
}

async function deletePushSubscription(endpoint) {
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

async function loadAllPushSubscriptions() {
  const { rows } = await query(
    `SELECT endpoint, user_id, list_type, subscription_json, last_alert_keys
     FROM push_subscriptions`
  );
  return rows.map((r) => ({
    endpoint: r.endpoint,
    userId: r.user_id,
    listType: r.list_type,
    subscription: r.subscription_json,
    lastAlertKeys: new Set(Array.isArray(r.last_alert_keys) ? r.last_alert_keys : []),
  }));
}

async function updateLastAlertKeys(endpoint, keys) {
  await query(
    `UPDATE push_subscriptions SET last_alert_keys = $1::jsonb WHERE endpoint = $2`,
    [JSON.stringify(Array.from(keys)), endpoint]
  );
}

// ── User prefs ───────────────────────────────────────────────────────
async function getUserPrefs(userId) {
  const { rows } = await query(
    `SELECT user_id, list_type, location_lat, location_lng, settings, updated_at
     FROM user_prefs WHERE user_id = $1`,
    [String(userId)]
  );
  return rows[0] || null;
}

async function upsertUserPrefs({ userId, listType, lat, lng, settings }) {
  await query(
    `INSERT INTO user_prefs (user_id, list_type, location_lat, location_lng, settings, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE
       SET list_type = COALESCE(EXCLUDED.list_type, user_prefs.list_type),
           location_lat = COALESCE(EXCLUDED.location_lat, user_prefs.location_lat),
           location_lng = COALESCE(EXCLUDED.location_lng, user_prefs.location_lng),
           settings = COALESCE(EXCLUDED.settings, user_prefs.settings),
           updated_at = now()`,
    [
      String(userId),
      listType || null,
      lat ?? null,
      lng ?? null,
      settings ? JSON.stringify(settings) : null,
    ]
  );
}

// ── Observations ─────────────────────────────────────────────────────
async function upsertObservations(date, observations) {
  if (!observations?.length) return 0;
  const values = [];
  const params = [];
  observations.forEach((o, i) => {
    const base = i * 11;
    params.push(
      date,
      o.species || o.name || "",
      o.latin || "",
      o.location || null,
      o.loknr || null,
      o.lat ?? null,
      o.lng ?? null,
      o.observer || null,
      o.count ?? null,
      o.behaviour || null,
      JSON.stringify(o)
    );
    values.push(
      `($${base + 1}::date, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}::jsonb)`
    );
  });
  const sql = `INSERT INTO observations
    (obs_date, species, latin, location, loknr, lat, lng, observer, count, behaviour, raw)
    VALUES ${values.join(", ")}
    ON CONFLICT (obs_date, latin, loknr, observer, behaviour) DO NOTHING`;
  const res = await query(sql, params);
  await query(
    `INSERT INTO scrape_log (obs_date, fetched_at, row_count)
     VALUES ($1, now(), $2)
     ON CONFLICT (obs_date) DO UPDATE SET fetched_at = now(), row_count = EXCLUDED.row_count`,
    [date, observations.length]
  );
  return res.rowCount;
}

async function getObservationsByDate(date) {
  const { rows } = await query(
    `SELECT species, latin, location, loknr, lat, lng, observer, count, behaviour, raw
     FROM observations WHERE obs_date = $1`,
    [date]
  );
  return rows.map((r) => ({
    species: r.species,
    latin: r.latin,
    location: r.location,
    loknr: r.loknr,
    lat: r.lat,
    lng: r.lng,
    observer: r.observer,
    count: r.count,
    behaviour: r.behaviour,
    ...(r.raw || {}),
  }));
}

async function getRelevantObsForMonth({ year, month, latinList, lat, lng, radiusKm }) {
  if (!latinList?.length) return [];
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = new Date(year, month, 0).toISOString().slice(0, 10);
  const radiusDegLat = radiusKm / 111;
  const radiusDegLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  const { rows } = await query(
    `SELECT to_char(obs_date, 'YYYY-MM-DD') AS obs_date,
            species, latin, location, loknr, lat, lng, count,
            behaviour, raw
       FROM observations
      WHERE obs_date BETWEEN $1 AND $2
        AND lower(latin) = ANY($3)
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND lat BETWEEN $4 AND $5
        AND lng BETWEEN $6 AND $7`,
    [
      start, end,
      latinList.map((s) => s.toLowerCase()),
      lat - radiusDegLat, lat + radiusDegLat,
      lng - radiusDegLng, lng + radiusDegLng,
    ]
  );
  return rows.map((r) => ({
    date: r.obs_date,
    species: r.species,
    latin: r.latin,
    location: r.location,
    loknr: r.loknr,
    lat: r.lat,
    lng: r.lng,
    count: r.count,
    behaviour: r.behaviour,
    rare: r.raw?.rare,
  }));
}

async function getDatesWithScrape(startDate, endDate) {
  const { rows } = await query(
    `SELECT to_char(obs_date, 'YYYY-MM-DD') AS obs_date
       FROM scrape_log WHERE obs_date BETWEEN $1 AND $2`,
    [startDate, endDate]
  );
  return new Set(rows.map((r) => r.obs_date));
}

async function embedMissingForDate(date, embedFn, pgvectorLiteral) {
  const { rows } = await query(
    `SELECT id, species, latin, location, behaviour
       FROM observations
      WHERE obs_date = $1 AND embedding IS NULL
      LIMIT 200`,
    [date]
  );
  if (!rows.length) return 0;
  const texts = rows.map((r) =>
    [r.species, r.latin, r.location || "", r.behaviour || ""].filter(Boolean).join(" | ")
  );
  const vecs = await embedFn(texts);
  for (let i = 0; i < rows.length; i++) {
    await query(
      `UPDATE observations SET embedding = $1::vector WHERE id = $2`,
      [pgvectorLiteral(vecs[i]), rows[i].id]
    );
  }
  return rows.length;
}

async function getScrapeAge(date) {
  const { rows } = await query(
    `SELECT fetched_at, row_count FROM scrape_log WHERE obs_date = $1`,
    [date]
  );
  if (!rows[0]) return null;
  return {
    fetchedAt: new Date(rows[0].fetched_at).getTime(),
    rowCount: rows[0].row_count,
  };
}

module.exports = {
  pool,
  isEnabled,
  query,
  close,
  upsertPushSubscription,
  deletePushSubscription,
  loadAllPushSubscriptions,
  updateLastAlertKeys,
  getUserPrefs,
  upsertUserPrefs,
  upsertObservations,
  getObservationsByDate,
  getRelevantObsForMonth,
  getDatesWithScrape,
  embedMissingForDate,
  getScrapeAge,
};
