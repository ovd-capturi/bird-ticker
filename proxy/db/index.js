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

// ── Tick lists ───────────────────────────────────────────────────────
async function getTicklist(userId, listType) {
  const { rows } = await query(
    `SELECT birds, fetched_at FROM ticklists
      WHERE user_id = $1 AND list_type = $2`,
    [String(userId), String(listType)]
  );
  if (!rows[0]) return null;
  return {
    birds: rows[0].birds,
    fetchedAt: new Date(rows[0].fetched_at).getTime(),
  };
}

async function upsertTicklist(userId, listType, birds) {
  await query(
    `INSERT INTO ticklists (user_id, list_type, birds, fetched_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (user_id, list_type) DO UPDATE
       SET birds = EXCLUDED.birds, fetched_at = now()`,
    [String(userId), String(listType), JSON.stringify(birds)]
  );
}

// ── Observations ─────────────────────────────────────────────────────
async function upsertObservations(date, observations) {
  if (!observations?.length) {
    if (pool) {
      await query(
        `INSERT INTO scrape_log (obs_date, fetched_at, row_count)
         VALUES ($1, now(), 0)
         ON CONFLICT (obs_date) DO UPDATE SET fetched_at = now(), row_count = 0`,
        [date]
      );
    }
    return 0;
  }
  if (!pool) throw new Error("DB not configured (DATABASE_URL missing)");

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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const insertSql = `INSERT INTO observations
      (obs_date, species, latin, location, loknr, lat, lng, observer, count, behaviour, raw)
      VALUES ${values.join(", ")}
      ON CONFLICT (obs_date, latin, loknr, observer, behaviour) DO NOTHING
      RETURNING obs_date, latin, loknr, lat, lng, location, species, count`;
    const res = await client.query(insertSql, params);

    if (res.rows.length) {
      await applyBucketDeltas(client, res.rows);
    }

    await client.query(
      `INSERT INTO scrape_log (obs_date, fetched_at, row_count)
       VALUES ($1, now(), $2)
       ON CONFLICT (obs_date) DO UPDATE SET fetched_at = now(), row_count = EXCLUDED.row_count`,
      [date, observations.length]
    );
    await client.query("COMMIT");
    return res.rowCount;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

// PK columns can't be NULL, so loknr=NULL is stored as '' in bucket tables.
// Readers map '' back to null.
const NULL_LOKNR_SENTINEL = "";

function isoWeekParts(dateStr) {
  // Match Postgres EXTRACT(isoyear/week) — ISO 8601 week, Mon-start.
  const [yy, mm, dd] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(yy, mm - 1, dd));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
}

async function applyBucketDeltas(client, insertedRows) {
  const weekMap = new Map();
  const monthMap = new Map();
  for (const r of insertedRows) {
    const obsDate = r.obs_date instanceof Date
      ? r.obs_date.toISOString().slice(0, 10)
      : String(r.obs_date).slice(0, 10);
    if (!r.latin) continue;
    const loknrKey = r.loknr == null ? NULL_LOKNR_SENTINEL : String(r.loknr);
    const { isoYear, isoWeek } = isoWeekParts(obsDate);
    const year = Number(obsDate.slice(0, 4));
    const month = Number(obsDate.slice(5, 7));
    const eff = r.count == null ? 1 : Number(r.count);

    const wKey = `${r.latin}|${loknrKey}|${isoYear}|${isoWeek}`;
    let w = weekMap.get(wKey);
    if (!w) {
      w = { latin: r.latin, loknr: loknrKey, isoYear, isoWeek,
            n: 0, sum: 0, last: obsDate,
            lat: null, latN: 0, lng: null, lngN: 0,
            location: r.location || null, species: r.species || null };
      weekMap.set(wKey, w);
    }
    w.n += 1;
    w.sum += eff;
    if (obsDate > w.last) w.last = obsDate;
    if (r.lat != null) { w.lat = (w.lat ?? 0) + Number(r.lat); w.latN += 1; }
    if (r.lng != null) { w.lng = (w.lng ?? 0) + Number(r.lng); w.lngN += 1; }
    if (!w.location && r.location) w.location = r.location;
    if (!w.species && r.species) w.species = r.species;

    const mKey = `${r.latin}|${loknrKey}|${year}|${month}`;
    let m = monthMap.get(mKey);
    if (!m) {
      m = { latin: r.latin, loknr: loknrKey, year, month,
            n: 0, sum: 0, last: obsDate,
            lat: null, latN: 0, lng: null, lngN: 0,
            location: r.location || null, species: r.species || null };
      monthMap.set(mKey, m);
    }
    m.n += 1;
    m.sum += eff;
    if (obsDate > m.last) m.last = obsDate;
    if (r.lat != null) { m.lat = (m.lat ?? 0) + Number(r.lat); m.latN += 1; }
    if (r.lng != null) { m.lng = (m.lng ?? 0) + Number(r.lng); m.lngN += 1; }
    if (!m.location && r.location) m.location = r.location;
    if (!m.species && r.species) m.species = r.species;
  }

  if (weekMap.size) {
    const rows = [...weekMap.values()].map((b) => ({
      ...b,
      lat: b.latN ? b.lat / b.latN : null,
      lng: b.lngN ? b.lng / b.lngN : null,
    }));
    const placeholders = [];
    const params = [];
    rows.forEach((b, i) => {
      const o = i * 11;
      params.push(b.latin, b.loknr, b.isoYear, b.isoWeek, b.n, b.sum,
                  b.last, b.lat, b.lng, b.location, b.species);
      placeholders.push(
        `($${o+1}, $${o+2}, $${o+3}, $${o+4}, $${o+5}, $${o+6}::bigint, $${o+7}::date, $${o+8}, $${o+9}, $${o+10}, $${o+11})`
      );
    });
    await client.query(
      `INSERT INTO obs_bucket_week
         (latin, loknr, iso_year, iso_week, n_obs, sum_count, last_obs, lat, lng, location, species)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (latin, loknr, iso_year, iso_week) DO UPDATE SET
         n_obs     = obs_bucket_week.n_obs     + EXCLUDED.n_obs,
         sum_count = obs_bucket_week.sum_count + EXCLUDED.sum_count,
         last_obs  = GREATEST(obs_bucket_week.last_obs, EXCLUDED.last_obs),
         lat       = COALESCE(obs_bucket_week.lat, EXCLUDED.lat),
         lng       = COALESCE(obs_bucket_week.lng, EXCLUDED.lng),
         location  = COALESCE(obs_bucket_week.location, EXCLUDED.location),
         species   = COALESCE(obs_bucket_week.species, EXCLUDED.species)`,
      params
    );
  }

  if (monthMap.size) {
    const rows = [...monthMap.values()].map((b) => ({
      ...b,
      lat: b.latN ? b.lat / b.latN : null,
      lng: b.lngN ? b.lng / b.lngN : null,
    }));
    const placeholders = [];
    const params = [];
    rows.forEach((b, i) => {
      const o = i * 11;
      params.push(b.latin, b.loknr, b.year, b.month, b.n, b.sum,
                  b.last, b.lat, b.lng, b.location, b.species);
      placeholders.push(
        `($${o+1}, $${o+2}, $${o+3}, $${o+4}, $${o+5}, $${o+6}::bigint, $${o+7}::date, $${o+8}, $${o+9}, $${o+10}, $${o+11})`
      );
    });
    await client.query(
      `INSERT INTO obs_bucket_month
         (latin, loknr, year, month, n_obs, sum_count, last_obs, lat, lng, location, species)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (latin, loknr, year, month) DO UPDATE SET
         n_obs     = obs_bucket_month.n_obs     + EXCLUDED.n_obs,
         sum_count = obs_bucket_month.sum_count + EXCLUDED.sum_count,
         last_obs  = GREATEST(obs_bucket_month.last_obs, EXCLUDED.last_obs),
         lat       = COALESCE(obs_bucket_month.lat, EXCLUDED.lat),
         lng       = COALESCE(obs_bucket_month.lng, EXCLUDED.lng),
         location  = COALESCE(obs_bucket_month.location, EXCLUDED.location),
         species   = COALESCE(obs_bucket_month.species, EXCLUDED.species)`,
      params
    );
  }
}

// Bucket readers — return rows in the shape predictor/stats.aggregateBySite produces.
async function getBucketWeekCandidates({ latinList, weekSet, fromDate }) {
  if (!latinList?.length || !weekSet?.length) return [];
  const fromYear = Number(String(fromDate).slice(0, 4));
  const { rows } = await query(
    `
    SELECT
      latin,
      lower(latin) AS latin_key,
      max(species)  AS species,
      NULLIF(loknr, $4) AS loknr,
      max(location) AS location,
      avg(lat) FILTER (WHERE lat IS NOT NULL) AS lat,
      avg(lng) FILTER (WHERE lng IS NOT NULL) AS lng,
      sum(n_obs)::int AS freq,
      max(last_obs)   AS last_obs,
      CASE WHEN sum(n_obs) > 0
        THEN sum(sum_count)::float / sum(n_obs)::float
        ELSE 1.0
      END AS avg_count
    FROM obs_bucket_week
    WHERE lower(latin) = ANY($1)
      AND iso_week = ANY($2)
      AND iso_year >= $3
    GROUP BY latin, loknr
    HAVING sum(n_obs) >= 1
    ORDER BY freq DESC
    LIMIT 800
    `,
    [latinList.map((s) => s.toLowerCase()), weekSet, fromYear, NULL_LOKNR_SENTINEL]
  );
  return rows;
}

async function getBucketMonthCandidates({ latinList, year, month, lookbackYears }) {
  if (!latinList?.length) return [];
  const fromYear = year - (lookbackYears ?? 3);
  const { rows } = await query(
    `
    SELECT
      latin,
      lower(latin) AS latin_key,
      max(species)  AS species,
      NULLIF(loknr, $4) AS loknr,
      max(location) AS location,
      avg(lat) FILTER (WHERE lat IS NOT NULL) AS lat,
      avg(lng) FILTER (WHERE lng IS NOT NULL) AS lng,
      sum(n_obs)::int AS freq,
      max(last_obs)   AS last_obs,
      CASE WHEN sum(n_obs) > 0
        THEN sum(sum_count)::float / sum(n_obs)::float
        ELSE 1.0
      END AS avg_count
    FROM obs_bucket_month
    WHERE lower(latin) = ANY($1)
      AND month = $2
      AND year BETWEEN $3 AND $5
    GROUP BY latin, loknr
    HAVING sum(n_obs) >= 1
    ORDER BY freq DESC
    LIMIT 800
    `,
    [latinList.map((s) => s.toLowerCase()), month, fromYear, NULL_LOKNR_SENTINEL, year]
  );
  return rows;
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

async function getRelevantObsForMonth({ year, month, latinList }) {
  if (!latinList?.length) return [];
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = new Date(year, month, 0).toISOString().slice(0, 10);
  const { rows } = await query(
    `SELECT to_char(obs_date, 'YYYY-MM-DD') AS obs_date,
            species, latin, location, loknr, lat, lng, count,
            behaviour, raw
       FROM observations
      WHERE obs_date BETWEEN $1 AND $2
        AND lower(latin) = ANY($3)`,
    [start, end, latinList.map((s) => s.toLowerCase())]
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

async function getLocalityCoords(loknrs) {
  if (!loknrs?.length) return {};
  const ids = loknrs.map(String);
  const { rows } = await query(
    `SELECT loknr,
            avg(lat) FILTER (WHERE lat IS NOT NULL) AS lat,
            avg(lng) FILTER (WHERE lng IS NOT NULL) AS lng
       FROM observations
      WHERE loknr = ANY($1)
      GROUP BY loknr`,
    [ids]
  );
  const out = {};
  for (const id of ids) out[id] = { loknr: id, lat: null, lng: null };
  for (const r of rows) {
    out[r.loknr] = {
      loknr: r.loknr,
      lat: r.lat == null ? null : Number(r.lat),
      lng: r.lng == null ? null : Number(r.lng),
    };
  }
  return out;
}

async function getSpeciesMapFromObservations() {
  const { rows } = await query(
    `SELECT lower(species) AS name_key,
            max(species) AS species,
            max(raw->>'artId') AS art_id
       FROM observations
      WHERE species IS NOT NULL AND species <> ''
      GROUP BY lower(species)`
  );
  const byName = {};
  for (const r of rows) {
    if (r.art_id) byName[r.name_key] = r.art_id;
  }
  return byName;
}

// ── Chat history ─────────────────────────────────────────────────────
async function insertChatMessage({ deviceId, userId, listType, role, content, toolCalls, toolName, toolCallId }) {
  const { rows } = await query(
    `INSERT INTO chat_messages
       (device_id, user_id, list_type, role, content, tool_calls, tool_name, tool_call_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id, created_at`,
    [
      String(deviceId),
      userId ? String(userId) : null,
      listType ? String(listType) : null,
      role,
      content ?? null,
      toolCalls ? JSON.stringify(toolCalls) : null,
      toolName || null,
      toolCallId || null,
    ]
  );
  return rows[0];
}

async function getChatHistory(deviceId, limit = 50) {
  const { rows } = await query(
    `SELECT id, role, content, tool_calls, tool_name, tool_call_id, created_at
       FROM chat_messages
      WHERE device_id = $1
      ORDER BY id DESC
      LIMIT $2`,
    [String(deviceId), limit]
  );
  return rows.reverse().map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls,
    toolName: r.tool_name,
    toolCallId: r.tool_call_id,
    createdAt: r.created_at,
  }));
}

async function clearChatHistory(deviceId) {
  await query(`DELETE FROM chat_messages WHERE device_id = $1`, [String(deviceId)]);
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
  getTicklist,
  upsertTicklist,
  upsertObservations,
  getObservationsByDate,
  getRelevantObsForMonth,
  getDatesWithScrape,
  getScrapeAge,
  getBucketWeekCandidates,
  getBucketMonthCandidates,
  getLocalityCoords,
  getSpeciesMapFromObservations,
  insertChatMessage,
  getChatHistory,
  clearChatHistory,
};
