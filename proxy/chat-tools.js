// Tool implementations exposed to the chat LLM via OpenAI-style function
// calling. Each tool reads from the local DB or predictor module — no
// external network calls (DOFbasen is already mirrored locally).
const fs = require("fs");
const path = require("path");
const db = require("./db");
const predictor = require("./predictor");

// ── Static species facts (pre-scraped from dofbasen) ──────────────────
const SPECIES_FACTS_PATH = path.join(__dirname, "data", "species-facts.json");
let speciesFactsByArt = new Map();
let speciesFactsByLatin = new Map();
let speciesFactsByName = new Map();
try {
  const arr = JSON.parse(fs.readFileSync(SPECIES_FACTS_PATH, "utf8"));
  for (const r of arr) {
    speciesFactsByArt.set(String(r.artId), r);
    if (r.latin) speciesFactsByLatin.set(r.latin.toLowerCase(), r);
    if (r.name) speciesFactsByName.set(r.name.toLowerCase(), r);
  }
  console.log(`Loaded ${arr.length} species facts`);
} catch (err) {
  console.warn(`Species facts not loaded: ${err.message}`);
}

function nameMap(tickList) {
  const m = new Map();
  for (const b of tickList?.birds || []) {
    if (b.latin && b.name) m.set(b.latin.toLowerCase(), b.name);
  }
  return m;
}

function missingFromTickList(tickList) {
  return (tickList?.birds || []).filter((b) => !b.ticked && b.latin);
}

// ── Tool: predictor dataset (day or calendar mode) ────────────────────
async function tool_get_predictor_dataset(args, ctx) {
  const mode = args.mode === "calendar" ? "calendar" : "day";
  const month = args.month;
  if (mode === "calendar" && !/^\d{4}-\d{2}$/.test(month || "")) {
    return { error: "month (YYYY-MM) required for mode=calendar" };
  }
  if (mode === "day" && (ctx.lat == null || ctx.lng == null)) {
    return { error: "User location unknown; ask the user to enable location, or use mode=calendar." };
  }

  const missing = missingFromTickList(ctx.tickList);
  if (!missing.length) {
    return { mode, candidates: [], note: "User has no missing species." };
  }

  const ranked = mode === "day"
    ? await predictor.rankForDay({ lat: ctx.lat, lng: ctx.lng, missingBirds: missing, today: new Date() })
    : await predictor.rankForCalendar({ month, missingBirds: missing });

  const names = nameMap(ctx.tickList);

  if (mode === "day") {
    return {
      mode,
      candidates: ranked.items.map((it) => ({
        latin: it.latin,
        name: names.get(it.latin.toLowerCase()) || it.species,
        band: it.band,
        score: Math.round(it.scoreNorm * 100) / 100,
        cluster: { name: it.cluster.name, loknr: it.cluster.loknr },
        evidenceCount: (it.evidence || []).length,
        evidenceSample: (it.evidence || []).slice(0, 5).map((e) => ({
          date: e.date, location: e.location, count: e.count, behaviour: e.behaviour,
        })),
      })),
    };
  }

  return {
    mode,
    month,
    locations: ranked.items.map((it) => ({
      name: it.cluster.name,
      loknr: it.cluster.loknr,
      speciesCount: it.species.length,
      species: it.species.map((s) => ({
        latin: s.latin,
        name: names.get(s.latin.toLowerCase()) || s.species,
        band: s.band,
        score: Math.round((s.scoreNorm || 0) * 100) / 100,
        evidenceCount: (s.evidence || []).length,
        evidenceSample: (s.evidence || []).slice(0, 3).map((e) => ({
          date: e.date, location: e.location, count: e.count, behaviour: e.behaviour,
        })),
      })),
    })),
  };
}

// ── Tool: lookup recent observations for a species ────────────────────
async function tool_lookup_species(args, _ctx) {
  const latin = String(args.latin || "").trim();
  if (!latin) return { error: "latin required" };
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 100);

  const { rows } = await db.query(
    `SELECT to_char(obs_date, 'YYYY-MM-DD') AS date,
            species, latin, location, loknr, count, behaviour, observer
       FROM observations
      WHERE lower(latin) = lower($1)
      ORDER BY obs_date DESC, id DESC
      LIMIT $2`,
    [latin, limit]
  );

  const monthly = await db.query(
    `SELECT month, sum(n_obs)::int AS n
       FROM obs_bucket_month
      WHERE lower(latin) = lower($1)
      GROUP BY month ORDER BY month`,
    [latin]
  );

  return {
    latin,
    recent: rows,
    monthlyHistogram: monthly.rows.map((r) => ({ month: r.month, observations: r.n })),
  };
}

// ── Tool: lookup recent observations at a locality ────────────────────
async function tool_lookup_locality(args, _ctx) {
  const loknr = args.loknr ? String(args.loknr) : null;
  const nameQuery = args.name ? String(args.name).trim() : null;
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), 100);
  if (!loknr && !nameQuery) return { error: "loknr or name required" };

  let where = "";
  const params = [];
  if (loknr) {
    params.push(loknr);
    where = `loknr = $${params.length}`;
  } else {
    params.push(`%${nameQuery}%`);
    where = `location ILIKE $${params.length}`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT to_char(obs_date, 'YYYY-MM-DD') AS date,
            species, latin, location, loknr, count, behaviour
       FROM observations
      WHERE ${where}
      ORDER BY obs_date DESC, id DESC
      LIMIT $${params.length}`,
    params
  );

  const speciesAgg = await db.query(
    `SELECT latin, max(species) AS species, count(*)::int AS n,
            max(obs_date) AS last_seen
       FROM observations
      WHERE ${where.replace("$2", "$1")}
      GROUP BY latin
      ORDER BY n DESC
      LIMIT 30`,
    [params[0]]
  );

  return {
    query: loknr ? { loknr } : { name: nameQuery },
    observations: rows,
    speciesAtLocation: speciesAgg.rows.map((r) => ({
      latin: r.latin,
      species: r.species,
      observations: r.n,
      lastSeen: r.last_seen ? new Date(r.last_seen).toISOString().slice(0, 10) : null,
    })),
  };
}

// ── Tool: ticklist summary ────────────────────────────────────────────
async function tool_get_ticklist_summary(_args, ctx) {
  const birds = ctx.tickList?.birds || [];
  const ticked = birds.filter((b) => b.ticked);
  const missing = birds.filter((b) => !b.ticked);
  const missingSU = missing.filter((b) => b.isSU);
  return {
    total: birds.length,
    ticked: ticked.length,
    missing: missing.length,
    missingSU: missingSU.length,
    sampleMissing: missing.slice(0, 40).map((b) => ({ name: b.name, latin: b.latin, isSU: b.isSU })),
  };
}

// ── Tool: recent observations (whole list) ────────────────────────────
async function tool_get_recent_observations(args, _ctx) {
  const date = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : null;
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 40, 1), 100);

  if (date) {
    const obs = await db.getObservationsByDate(date);
    return {
      date,
      count: obs.length,
      observations: obs.slice(0, limit).map((o) => ({
        species: o.species, latin: o.latin, location: o.location, loknr: o.loknr,
        count: o.count, behaviour: o.behaviour,
      })),
    };
  }

  const { rows } = await db.query(
    `SELECT to_char(obs_date, 'YYYY-MM-DD') AS date,
            species, latin, location, loknr, count, behaviour
       FROM observations
      ORDER BY obs_date DESC, id DESC
      LIMIT $1`,
    [limit]
  );
  return { observations: rows };
}

// ── Tool: species facts (dofbasen) ────────────────────────────────────
async function tool_lookup_species_facts(args, _ctx) {
  const artId = args.artId ? String(args.artId).padStart(5, "0") : null;
  const latin = args.latin ? String(args.latin).trim().toLowerCase() : null;
  const name = args.name ? String(args.name).trim().toLowerCase() : null;

  let record = null;
  if (artId && speciesFactsByArt.has(artId)) record = speciesFactsByArt.get(artId);
  if (!record && latin && speciesFactsByLatin.has(latin)) record = speciesFactsByLatin.get(latin);
  if (!record && name && speciesFactsByName.has(name)) record = speciesFactsByName.get(name);

  if (!record) {
    // Fuzzy match by name prefix
    if (name) {
      for (const [k, v] of speciesFactsByName) {
        if (k.startsWith(name) || name.startsWith(k)) { record = v; break; }
      }
    }
  }

  if (!record) {
    return {
      error: "No species facts found",
      hint: "Try a different latin/name, or use lookup_species for raw observations.",
    };
  }

  return {
    artId: record.artId,
    name: record.name,
    latin: record.latin,
    description: record.description,
    habitat: record.habitat,
    diet: record.diet,
    population: record.population,
    protection: record.protection,
    breeding: record.breeding,
    facts: record.facts,
    image: record.image,
    sourceUrl: record.sourceUrl,
  };
}

const TOOLS = {
  get_predictor_dataset: tool_get_predictor_dataset,
  lookup_species: tool_lookup_species,
  lookup_locality: tool_lookup_locality,
  get_ticklist_summary: tool_get_ticklist_summary,
  get_recent_observations: tool_get_recent_observations,
  lookup_species_facts: tool_lookup_species_facts,
};

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "get_predictor_dataset",
      description: "Returns ranked candidate locations/species for the user's missing birds, based on historical DOFbasen observations near the user (mode=day) or for an upcoming month (mode=calendar).",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["day", "calendar"], description: "'day' uses user location; 'calendar' uses month aggregates." },
          month: { type: "string", description: "Required for mode=calendar. Format YYYY-MM." },
        },
        required: ["mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_species",
      description: "Returns recent local observations for a single species (latin name) plus a monthly observation histogram across all years.",
      parameters: {
        type: "object",
        properties: {
          latin: { type: "string", description: "Latin name, e.g. 'Pandion haliaetus'." },
          limit: { type: "integer", description: "Max recent observations (1-100, default 25)." },
        },
        required: ["latin"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_locality",
      description: "Returns recent observations and per-species totals at a locality. Provide either loknr (DOFbasen locality id) or a name fragment.",
      parameters: {
        type: "object",
        properties: {
          loknr: { type: "string", description: "DOFbasen locality number." },
          name: { type: "string", description: "Locality name fragment (case-insensitive)." },
          limit: { type: "integer", description: "Max observations (1-100, default 30)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_ticklist_summary",
      description: "Returns counts for the user's Netfugl tick list (total, ticked, missing, missing SU) plus a sample of missing species.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_species_facts",
      description: "Returns curated DOFbasen species facts (beskrivelse, levested, føde, bestand, beskyttelse, yngleudbredelse) plus a hero image path for a Danish bird species. Use this when the user asks about a specific species. The returned 'image' field is a local path you can show in the answer via markdown image syntax ![navn](sti).",
      parameters: {
        type: "object",
        properties: {
          latin: { type: "string", description: "Latin name (preferred)." },
          name: { type: "string", description: "Danish common name." },
          artId: { type: "string", description: "5-digit DOFbasen art id." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_observations",
      description: "Returns recent DOFbasen observations, optionally filtered by date (YYYY-MM-DD). Without a date, returns the most recent observations across the country.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD (optional)." },
          limit: { type: "integer", description: "Max rows (1-100, default 40)." },
        },
      },
    },
  },
];

async function runTool(name, args, ctx) {
  const fn = TOOLS[name];
  if (!fn) return { error: `Unknown tool ${name}` };
  try {
    return await fn(args || {}, ctx);
  } catch (err) {
    console.error(`Tool ${name} failed:`, err.message);
    return { error: err.message };
  }
}

module.exports = { TOOL_SCHEMAS, runTool };
