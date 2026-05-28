const express = require("express");
const compression = require("compression");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const webpush = require("web-push");
const path = require("path");
const { performance } = require("perf_hooks");
const db = require("./db");
const { runMigrations } = require("./db/migrate");
const predictor = require("./predictor");
const backfill = require("./backfill");
const chatTools = require("./chat-tools");

const app = express();
const PORT = process.env.PORT || 3000;

// VAPID keys for push notifications
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || "BCSf4An6NXJ55JAhdKchlCSrftouKF6D3G4Uhi5idkfIgMgNqJeOksh-NOS-QT7yqq3Hh_4c1IRsi7Xreq_dLVM";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "E99i35Z9VdS7HkqRPU2jCgpoju5K6lUWIbaVRaz0_Gg";

webpush.setVapidDetails(
  "mailto:bird-ticker@example.com",
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// In-flight request dedupe: parallel callers (during notification refresh or
// backfill) wait on the same upstream fetch instead of double-scraping.
const inflight = new Map();
function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Push subscription store: Map<subKey, { subscription, userId, listType, lastAlertKeys }>
const subscribers = new Map();

// JSON body parsing for push subscription
app.use(express.json());

// Gzip/brotli responses to cut bandwidth + perceived latency.
app.use(compression());

// Serve static frontend files. Assets are not fingerprinted, so HTML/JS/CSS
// must revalidate every request — iOS PWAs otherwise hold stale code across
// reloads. Long cache only for binary assets (icons/images).
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

// CORS for local dev
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// ─── Tick List Endpoint ───────────────────────────────────────────────
const LIST_NAMES = { "1": "Krydsliste DK", "2": "Årsliste DK", "3": "Livslisten DK" };

app.get("/api/ticklist", async (req, res) => {
  const { listType = "1", userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  if (!db.isEnabled()) {
    return res.status(503).json({ error: "DB not configured" });
  }

  try {
    const stored = await db.getTicklist(userId, listType);
    if (!stored) {
      return res.json({
        userId,
        listType,
        listName: LIST_NAMES[listType] || "Krydsliste",
        total: 0,
        ticked: 0,
        birds: [],
        error: "No cached ticklist; seeded on next notification poll",
      });
    }
    res.json({
      userId,
      listType,
      listName: LIST_NAMES[listType] || "Krydsliste",
      total: stored.birds.length,
      ticked: stored.birds.filter((b) => b.ticked).length,
      birds: stored.birds,
    });
  } catch (err) {
    console.error("Ticklist read failed:", err.message);
    res.status(500).json({ error: "Failed to read tick list", detail: err.message });
  }
});

// ─── Observations Endpoint ────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayStr = () => new Date().toISOString().slice(0, 10);

// DB-only reader. No scraping; returns whatever Postgres currently has for
// the date (empty payload if nothing seeded yet).
async function readObservationsForDate(date) {
  const effectiveDate = date || todayStr();
  if (!db.isEnabled()) {
    return { date: effectiveDate, count: 0, observations: [] };
  }
  try {
    const rows = await db.getObservationsByDate(effectiveDate);
    return { date: effectiveDate, count: rows.length, observations: rows };
  } catch (err) {
    console.error("DB obs read failed:", err.message);
    return { date: effectiveDate, count: 0, observations: [] };
  }
}

// Network refresher: scrape dofbasen for the given date and upsert.
// Only called from the notification poller, the boot prewarm, and the
// backfill seeder — never from a user-facing request.
async function refreshObservationsForDate(date) {
  const isToday = !date || date === todayStr();
  const effectiveDate = date || todayStr();
  const dedupeKey = `refresh-obs-${effectiveDate}`;

  return dedupe(dedupeKey, async () => {
    let response;
    if (isToday) {
      response = await fetch("https://dofbasen.dk/observationer/");
    } else {
      const body = new URLSearchParams({ idag: date, summering: "tur" });
      response = await fetch("https://dofbasen.dk/observationer/index.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    }
    if (!response.ok) throw new Error(`DOFbasen returned ${response.status}`);
    const data = await parseObservationsHtml(response, effectiveDate);

    if (db.isEnabled() && data?.observations?.length) {
      db.upsertObservations(effectiveDate, data.observations)
        .then((n) => {
          if (n) console.log(`💾 stored ${n} new obs for ${effectiveDate}`);
        })
        .catch((e) => console.error("DB obs upsert failed:", e.message));
    }
    return data;
  });
}

app.get("/api/observations", async (req, res) => {
  const date = DATE_RE.test(req.query.date || "") ? req.query.date : null;
  try {
    const data = await readObservationsForDate(date);
    res.json(data);
  } catch (err) {
    console.error("Observations error:", err.message);
    res.status(500).json({ error: "Failed to read observations", detail: err.message });
  }
});

async function parseObservationsHtml(response, dateLabel) {
  try {

    // DOFbasen uses ISO-8859-1
    const buffer = await response.arrayBuffer();
    const html = iconv.decode(Buffer.from(buffer), "iso-8859-1");

    const observations = [];
    const seen = new Set();

    const fullHtml = html;

    // Parse species blocks: each species has an <a> with class "arter" containing span, then tables
    // The link contains the art code in the href: search1.php?...&art=00120&...
    const speciesPattern =
      /<a[^>]*class="arter"[^>]*href="[^"]*art=(\d+)[^"]*"[^>]*title="Alle observationer af ([^"]+)"[^>]*><span class="(defaultart|subart|su|seasonart)">([^<]+)<\/span><\/a>\s*\(<i>([^<]+)<\/i>\):/g;

    let match;
    const speciesBlocks = [];
    while ((match = speciesPattern.exec(fullHtml)) !== null) {
      speciesBlocks.push({
        index: match.index,
        artId: match[1],
        fullTitle: match[2],
        cssClass: match[3],
        danishName: match[4].trim(),
        latinName: match[5].trim(),
      });
    }

    // For each species, find observation rows after it
    for (let i = 0; i < speciesBlocks.length; i++) {
      const species = speciesBlocks[i];
      const startIdx = species.index;
      const endIdx = i + 1 < speciesBlocks.length ? speciesBlocks[i + 1].index : fullHtml.length;
      const block = fullHtml.substring(startIdx, endIdx);

      // Parse observation tables within this block. Fragment mode (3rd arg
      // false) skips wrapping in <html>/<body>, cutting per-block memory.
      const $block = cheerio.load(block, null, false);
      $block("table tr").each((_, row) => {
        const cells = $block(row).find("td");
        if (cells.length < 10) return;

        // Extract count (column with align="right" that has a link)
        const countLink = $block(row).find('td[align="right"] a.arter');
        const countText = countLink.first().text().trim();
        const count = parseInt(countText, 10) || 0;

        // Extract location and locality ID
        const locationLink = $block(row).find("a.lokalitet");
        const location = locationLink.text().trim();
        let loknr = null;
        const lokOnclick = locationLink.attr("onclick") || "";
        const lokMatch = lokOnclick.match(/loknr=(\d+)/);
        if (lokMatch) loknr = lokMatch[1];

        // Extract bird position coordinates from map-marker link
        let lat = null, lng = null;
        const posLink = $block(row).find("a.position");
        if (posLink.length) {
          const posOnclick = posLink.attr("onclick") || "";
          const posMatch = posOnclick.match(/lng=([\d,]+)&lat=([\d,]+)/);
          if (posMatch) {
            lng = parseFloat(posMatch[1].replace(",", "."));
            lat = parseFloat(posMatch[2].replace(",", "."));
          }
        }

        // Extract observer
        const observerLinks = $block(row).find('td[align="right"] a').not(".arter").not(".lokalitet");
        let observer = "";
        observerLinks.each((_, el) => {
          const title = $block(el).attr("title") || "";
          if (title.startsWith("Information om")) return;
          const text = $block(el).text().trim();
          if (text && !observer) observer = text;
        });

        // Extract behavior
        const behaviorLinks = $block(row).find('a.arter[title]');
        let behavior = "";
        behaviorLinks.each((_, el) => {
          const title = $block(el).attr("title") || "";
          if (title && !title.startsWith("Alle observationer") && !title.startsWith("Mere information")) {
            behavior = title;
          }
        });

        // Extract time from clock icon
        const clockIcon = $block(row).find('i.fa-clock-o[title]');
        let time = "";
        if (clockIcon.length) {
          const timeTitle = clockIcon.first().attr("title") || "";
          time = timeTitle.replace("Ophold på lokaliteten: ", "").replace("Ophold p\u00e5 lokaliteten: ", "");
        }

        if (!location) return;

        // Deduplicate per species+location
        const key = `${species.danishName}-${location}`;
        if (seen.has(key)) return;
        seen.add(key);

        observations.push({
          species: species.danishName,
          latin: species.latinName,
          artId: species.artId,
          count,
          location,
          loknr,
          lat,
          lng,
          observer,
          behavior,
          time,
          rare: species.cssClass === "su",
          scarce: species.cssClass === "subart",
          seasonal: species.cssClass === "seasonart",
        });
      });
    }

    // Resolve missing coords from previously-seen observations in the DB before
    // falling back to dofbasen poplok.php. This whole code path only runs
    // inside the network-allowed refresher, so the dofbasen fallback is OK.
    const needLoknrs = [...new Set(
      observations.filter(o => o.lat == null && o.loknr).map(o => o.loknr)
    )];

    if (needLoknrs.length > 0) {
      let lokResults = {};
      if (db.isEnabled()) {
        try { lokResults = await db.getLocalityCoords(needLoknrs); }
        catch (e) { console.error("locality DB lookup failed:", e.message); }
      }
      const stillMissing = needLoknrs.filter(
        (id) => !lokResults[id] || lokResults[id].lat == null
      );

      for (let i = 0; i < stillMissing.length; i += 20) {
        const batch = stillMissing.slice(i, i + 20);
        await Promise.all(batch.map(async (loknr) => {
          try {
            const lokUrl = `https://dofbasen.dk/poplok.php?loknr=${loknr}`;
            const lokRes = await fetch(lokUrl);
            const lokBuf = await lokRes.arrayBuffer();
            const lokHtml = iconv.decode(Buffer.from(lokBuf), "iso-8859-1");
            const $lok = cheerio.load(lokHtml);
            const lonVal = parseFloat($lok("#lok_center_lon").text());
            const latVal = parseFloat($lok("#lok_center_lat").text());
            lokResults[loknr] = {
              loknr,
              lat: isNaN(lonVal) ? null : lonVal,
              lng: isNaN(latVal) ? null : latVal,
            };
          } catch {
            lokResults[loknr] = { loknr, lat: null, lng: null };
          }
        }));
      }

      for (const obs of observations) {
        if (obs.lat == null && obs.loknr && lokResults[obs.loknr]) {
          obs.lat = lokResults[obs.loknr].lat;
          obs.lng = lokResults[obs.loknr].lng;
        }
      }
    }

    return {
      date: dateLabel,
      count: observations.length,
      observations,
    };
  } catch (err) {
    console.error("Observations parse error:", err.message);
    throw err;
  }
}

// ─── Locality Coordinates Endpoint ────────────────────────────────────
// Coords are derived from observations stored in the DB. Cold loknrs (never
// observed) return null/null; they get filled once an obs with that loknr
// flows through the next notification refresh.
app.get("/api/locality/:loknr", async (req, res) => {
  const { loknr } = req.params;
  if (!db.isEnabled()) return res.json({ loknr, lat: null, lng: null });
  try {
    const map = await db.getLocalityCoords([loknr]);
    res.json(map[loknr] || { loknr, lat: null, lng: null });
  } catch (err) {
    console.error("Locality error:", err.message);
    res.status(500).json({ error: "Failed to read locality", detail: err.message });
  }
});

// ─── Species List (Danish name → artId, derived from observations) ───────────
// Only covers species ever seen in the local DB. Sufficient for UI lookups
// against birds the user is tracking; cold (never-observed) species return
// no mapping until they show up in an observation.
app.get("/api/species-map", async (req, res) => {
  if (!db.isEnabled()) return res.json({ count: 0, byName: {} });
  try {
    const byName = await db.getSpeciesMapFromObservations();
    res.json({ count: Object.keys(byName).length, byName });
  } catch (err) {
    console.error("Species map error:", err.message);
    res.status(500).json({ error: "Failed to read species map", detail: err.message });
  }
});

// ─── Batch Locality Coordinates ───────────────────────────────────────
app.get("/api/localities", async (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.status(400).json({ error: "ids parameter required (comma-separated loknr)" });

  const loknrs = ids.split(",").filter(Boolean).slice(0, 50); // max 50
  if (!db.isEnabled()) {
    const empty = {};
    for (const id of loknrs) empty[id] = { loknr: id, lat: null, lng: null };
    return res.json(empty);
  }

  try {
    const results = await db.getLocalityCoords(loknrs);
    res.json(results);
  } catch (err) {
    console.error("Localities error:", err.message);
    res.status(500).json({ error: "Failed to read localities", detail: err.message });
  }
});

// ─── AI Predictions Endpoint ──────────────────────────────────────────
const FOUNDRY_ENDPOINT = process.env.AZURE_FOUNDRY_ENDPOINT || "";
const FOUNDRY_KEY = process.env.AZURE_FOUNDRY_KEY || "";
const FOUNDRY_DEPLOYMENT = process.env.AZURE_FOUNDRY_DEPLOYMENT || "";
const FOUNDRY_API_VERSION = process.env.AZURE_FOUNDRY_API_VERSION || "2024-08-01-preview";

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

app.get("/api/ai-predictions", async (req, res) => {
  if (!FOUNDRY_ENDPOINT || !FOUNDRY_KEY || !FOUNDRY_DEPLOYMENT) {
    return res.status(503).json({ error: "AI not configured. Set AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_KEY, AZURE_FOUNDRY_DEPLOYMENT." });
  }
  if (!db.isEnabled()) {
    return res.status(503).json({ error: "DB not configured. Predictor requires Postgres." });
  }

  const userId = req.query.userId;
  const listType = req.query.listType || "1";
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!userId || isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: "userId, lat, lng required" });
  }

  try {
    const tickList = await fetchTickListData(userId, listType);
    if (!tickList?.birds?.length) {
      return res.status(404).json({ error: "tickList not found" });
    }

    const missingBirds = tickList.birds.filter((b) => !b.ticked && b.latin);
    if (missingBirds.length === 0) {
      return res.json({ generatedAt: new Date().toISOString(), predictions: [], note: "Ingen manglende arter" });
    }

    const ranked = await predictor.rankForDay({
      lat,
      lng,
      missingBirds,
      today: new Date(),
    });

    if (!ranked.items.length) {
      return res.json({
        generatedAt: new Date().toISOString(),
        predictions: [],
        note: "Ingen historiske observationer for manglende arter i denne tid af året",
      });
    }

    const latinToName = new Map();
    for (const b of tickList.birds) {
      if (b.latin) latinToName.set(b.latin.toLowerCase(), b.name);
    }

    const nextDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      nextDates.push(d.toISOString().slice(0, 10));
    }

    const systemPrompt =
      "Du er ornitolog. Brugeren mangler at krydse arter af. " +
      "Du modtager en liste af kandidater hvor hver kandidat har et lokalitetsområde og evidens (faktiske historiske observationer fra DOFbasen). " +
      "Skriv kort dansk reasoning der ALENE er baseret på den givne evidens — opfind ikke lokaliteter, datoer eller observationer der ikke findes i evidens. " +
      "Brug danske fuglenavne. Brug feltet 'tillidsbånd' direkte som confidence (lav/mellem/høj). " +
      "Til suggestedDates: vælg 1-3 datoer fra listen 'mulige_datoer' baseret på årstid og evidens. Svar kun struktureret JSON.";

    const userPayload = {
      brugerLokation: { lat, lng },
      mulige_datoer: nextDates,
      kandidater: ranked.items.map((it) => ({
        latin: it.latin,
        navn: latinToName.get(it.latin.toLowerCase()) || it.species,
        omraade: {
          navn: it.cluster.name,
          loknr: it.cluster.loknr,
          naerliggende: it.cluster.nearby.map((n) => ({
            lokalitet: n.location,
            loknr: n.loknr,
            distKm: n.distKm,
          })),
        },
        tillidsbånd: it.band,
        score: Math.round(it.scoreNorm * 100) / 100,
        evidens: it.evidence.map((e) => ({
          date: e.date,
          lokalitet: e.location,
          antal: e.count,
          observatør: e.observer,
          adfærd: e.behaviour,
        })),
      })),
    };

    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "Predictions",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            predictions: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  species: { type: "string" },
                  latin: { type: "string" },
                  location: { type: "string" },
                  confidence: { type: "string", enum: ["lav", "mellem", "høj"] },
                  reasoning: { type: "string" },
                  suggestedDates: { type: "array", items: { type: "string" } },
                },
                required: ["species", "latin", "location", "confidence", "reasoning", "suggestedDates"],
              },
            },
          },
          required: ["predictions"],
        },
      },
    };

    const endpoint = FOUNDRY_ENDPOINT.replace(/\/$/, "");
    const isV1 = /\/openai\/v1$/.test(endpoint);
    const apiUrl = isV1
      ? `${endpoint}/chat/completions`
      : `${endpoint}/openai/deployments/${FOUNDRY_DEPLOYMENT}/chat/completions?api-version=${FOUNDRY_API_VERSION}`;

    const requestBody = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      response_format: responseFormat,
      temperature: 0.2,
    };
    if (isV1) requestBody.model = FOUNDRY_DEPLOYMENT;

    const aiRes = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": FOUNDRY_KEY,
        Authorization: `Bearer ${FOUNDRY_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`Foundry ${aiRes.status}: ${errText.slice(0, 300)}`);
    }
    const aiJson = await aiRes.json();
    const content = aiJson.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty AI response");
    const parsed = JSON.parse(content);

    res.json({
      generatedAt: new Date().toISOString(),
      predictions: parsed.predictions || [],
    });
  } catch (err) {
    console.error("AI predictions error:", err.message);
    res.status(500).json({ error: "Failed to generate predictions", detail: err.message });
  }
});

// ─── AI Calendar Endpoint ─────────────────────────────────────────────
// Returns monthly recommendations grouped by location: where to go in a
// given upcoming month to tick missing species, based on observations from
// the same month last year.

app.get("/api/ai-calendar", async (req, res) => {
  if (!FOUNDRY_ENDPOINT || !FOUNDRY_KEY || !FOUNDRY_DEPLOYMENT) {
    return res.status(503).json({ error: "AI not configured. Set AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_KEY, AZURE_FOUNDRY_DEPLOYMENT." });
  }
  if (!db.isEnabled()) {
    return res.status(503).json({ error: "DB not configured. Predictor requires Postgres." });
  }

  const userId = req.query.userId;
  const listType = req.query.listType || "1";
  const month = req.query.month;
  if (!userId || !/^\d{4}-\d{2}$/.test(month || "")) {
    return res.status(400).json({ error: "userId, month (YYYY-MM) required" });
  }

  try {
    const tickList = await fetchTickListData(userId, listType);
    if (!tickList?.birds?.length) {
      return res.status(404).json({ error: "tickList not found" });
    }

    const missingBirds = tickList.birds.filter((b) => !b.ticked && b.latin);
    const nameToLatin = new Map();
    for (const b of tickList.birds) {
      if (b.latin && b.name) nameToLatin.set(b.name.toLowerCase(), b.latin);
    }

    const ranked = await predictor.rankForCalendar({ month, missingBirds });

    if (!ranked.items.length) {
      return res.json({
        generatedAt: new Date().toISOString(),
        month,
        locations: [],
        note: "Ingen relevante observationer for manglende arter i denne måned",
      });
    }

    const monthNamesDa = ["januar","februar","marts","april","maj","juni","juli","august","september","oktober","november","december"];
    const targetMonthName = monthNamesDa[parseInt(month.slice(5,7),10) - 1];

    const systemPrompt =
      "Du er ornitolog. Brugeren planlægger fugleture i den kommende måned og mangler at krydse arter af. " +
      "Du modtager en liste af lokalitetsområder med tilknyttede arter og evidens (faktiske historiske observationer). " +
      "Skriv kort dansk reasoning ALENE baseret på evidens — opfind ikke lokaliteter, datoer eller observationer. " +
      "Brug danske fuglenavne. Brug feltet 'tillidsbånd' direkte som confidence (lav/mellem/høj). " +
      "Skriv også en kort summary pr. område. " +
      "Returnér områderne i samme rækkefølge som inputtet (sorteret efter antal manglende arter, dernæst score). " +
      "Svar kun med struktureret JSON.";

    const latinToName = new Map();
    for (const b of tickList.birds) {
      if (b.latin) latinToName.set(b.latin.toLowerCase(), b.name);
    }

    const userPayload = {
      maalMaaned: month,
      maalMaanedNavn: targetMonthName,
      omraader: ranked.items.map((it) => ({
        navn: it.cluster.name,
        loknr: it.cluster.loknr,
        naerliggende: it.cluster.nearby.map((n) => ({
          lokalitet: n.location,
          loknr: n.loknr,
          distKm: n.distKm,
        })),
        arter: it.species.map((s) => ({
          latin: s.latin,
          navn: latinToName.get(s.latin.toLowerCase()) || s.species,
          tillidsbånd: s.band,
          evidens: s.evidence.map((e) => ({
            date: e.date,
            lokalitet: e.location,
            antal: e.count,
            adfærd: e.behaviour,
          })),
        })),
      })),
    };

    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "CalendarMonth",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            locations: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string" },
                  summary: { type: "string" },
                  birds: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        species: { type: "string" },
                        confidence: { type: "string", enum: ["lav", "mellem", "høj"] },
                        reasoning: { type: "string" },
                      },
                      required: ["species", "confidence", "reasoning"],
                    },
                  },
                },
                required: ["name", "summary", "birds"],
              },
            },
          },
          required: ["locations"],
        },
      },
    };

    const endpoint = FOUNDRY_ENDPOINT.replace(/\/$/, "");
    const isV1 = /\/openai\/v1$/.test(endpoint);
    const apiUrl = isV1
      ? `${endpoint}/chat/completions`
      : `${endpoint}/openai/deployments/${FOUNDRY_DEPLOYMENT}/chat/completions?api-version=${FOUNDRY_API_VERSION}`;

    const requestBody = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      response_format: responseFormat,
      temperature: 0.2,
    };
    if (isV1) requestBody.model = FOUNDRY_DEPLOYMENT;

    const aiRes = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": FOUNDRY_KEY,
        Authorization: `Bearer ${FOUNDRY_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`Foundry ${aiRes.status}: ${errText.slice(0, 300)}`);
    }
    const aiJson = await aiRes.json();
    const content = aiJson.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty AI response");
    const parsed = JSON.parse(content);

    const locations = (parsed.locations || []).map((loc) => ({
      ...loc,
      birds: (loc.birds || []).map((b) => ({
        ...b,
        latin: nameToLatin.get((b.species || "").toLowerCase()) || "",
      })),
    }));

    res.json({
      generatedAt: new Date().toISOString(),
      month,
      locations,
    });
  } catch (err) {
    console.error("AI calendar error:", err.message);
    res.status(500).json({ error: "Failed to generate calendar", detail: err.message });
  }
});

// ─── Raw predictor dataset (pre-LLM) ──────────────────────────────────
// Returns the ranked candidate set that the AI endpoints feed to the LLM,
// without calling the LLM. Useful for inspecting what the ML pipeline
// produces before summarisation.
app.get("/api/predictor-dataset", async (req, res) => {
  if (!db.isEnabled()) {
    return res.status(503).json({ error: "DB not configured. Predictor requires Postgres." });
  }
  const userId = req.query.userId;
  const listType = req.query.listType || "1";
  const mode = req.query.mode === "calendar" ? "calendar" : "day";
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const month = req.query.month;

  if (!userId) return res.status(400).json({ error: "userId required" });
  if (mode === "day" && (isNaN(lat) || isNaN(lng))) {
    return res.status(400).json({ error: "lat, lng required for mode=day" });
  }
  if (mode === "calendar" && !/^\d{4}-\d{2}$/.test(month || "")) {
    return res.status(400).json({ error: "month (YYYY-MM) required for mode=calendar" });
  }

  const t0 = performance.now();
  const timings = {};
  try {
    const tTick = performance.now();
    const tickList = await fetchTickListData(userId, listType);
    timings.tick = Math.round(performance.now() - tTick);
    if (!tickList?.birds?.length) {
      return res.status(404).json({ error: "tickList not found" });
    }
    const missingBirds = tickList.birds.filter((b) => !b.ticked && b.latin);
    const latinToName = new Map();
    for (const b of tickList.birds) {
      if (b.latin) latinToName.set(b.latin.toLowerCase(), b.name);
    }

    const ranked = mode === "day"
      ? await predictor.rankForDay({ lat, lng, missingBirds, today: new Date(), timings })
      : await predictor.rankForCalendar({ month, missingBirds });

    const decorate = (latin, species) => ({
      latin,
      species,
      name: latinToName.get((latin || "").toLowerCase()) || species,
    });

    let candidates = [];
    if (mode === "day") {
      candidates = ranked.items.map((it) => {
        const d = decorate(it.latin, it.species);
        return {
          ...d,
          score: it.score,
          scoreNorm: it.scoreNorm,
          band: it.band,
          cluster: it.cluster,
          evidence: it.evidence,
        };
      });
    } else {
      candidates = ranked.items.map((it) => ({
        cluster: it.cluster,
        score: it.score,
        species: it.species.map((s) => ({
          ...decorate(s.latin, s.species),
          score: s.score,
          scoreNorm: s.scoreNorm,
          band: s.band,
          evidence: s.evidence,
        })),
      }));
    }

    timings.total = Math.round(performance.now() - t0);
    const parts = Object.entries(timings)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`predictor-dataset userId=${userId} mode=${mode} ${parts}`);
    res.setHeader(
      "Server-Timing",
      Object.entries(timings)
        .map(([k, v]) => `${k};dur=${v}`)
        .join(", ")
    );

    res.json({
      generatedAt: new Date().toISOString(),
      mode,
      month: mode === "calendar" ? month : undefined,
      candidates,
    });
  } catch (err) {
    console.error("Predictor dataset error:", err.message);
    res.status(500).json({ error: "Failed to build predictor dataset", detail: err.message });
  }
});

// ─── AI Chat (ornithologist) ──────────────────────────────────────────
// Stateful, per-device chat. The LLM can call tools that read the local
// observations/ticklist/predictor data. History persists in chat_messages
// keyed by deviceId (client-generated UUID).

const CHAT_MAX_TURNS = 6;
const CHAT_HISTORY_LIMIT = 40;

function foundryApiUrl() {
  const endpoint = FOUNDRY_ENDPOINT.replace(/\/$/, "");
  const isV1 = /\/openai\/v1$/.test(endpoint);
  return {
    isV1,
    url: isV1
      ? `${endpoint}/chat/completions`
      : `${endpoint}/openai/deployments/${FOUNDRY_DEPLOYMENT}/chat/completions?api-version=${FOUNDRY_API_VERSION}`,
  };
}

function historyToMessages(history) {
  const out = [];
  for (const m of history) {
    if (m.role === "user" || m.role === "system") {
      out.push({ role: m.role, content: m.content || "" });
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.content || "" };
      if (m.toolCalls) msg.tool_calls = m.toolCalls;
      out.push(msg);
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        name: m.toolName,
        content: m.content || "",
      });
    }
  }
  return out;
}

const CHAT_SYSTEM_PROMPT =
  "Du er en erfaren dansk ornitolog, der hjælper en birder med at krydse manglende arter på Netfugl. " +
  "Brugeren har en krydsliste, en seneste position, og du har adgang til lokale data fra DOFbasen via værktøjer. " +
  "Brug værktøjerne aktivt for at hente konkrete observationer, lokaliteter og predictor-data — opfind ALDRIG datoer, lokaliteter eller observationer. " +
  "Hvis du mangler kontekst (fx hvilke arter brugeren mangler), så start med get_ticklist_summary eller get_predictor_dataset. " +
  "Når brugeren spørger om en bestemt art (kendetegn, levested, føde, bestand, beskyttelse) — kald lookup_species_facts. " +
  "Hvis lookup_species_facts returnerer et 'image'-felt, så vis billedet i svaret via markdown-syntaksen ![navn](sti). " +
  "Brug danske fuglenavne i svar. Skriv kort, præcist og handlingsorienteret på dansk. " +
  "Når du anbefaler ture, så referér til den underliggende evidens (dato, lokalitet, antal).";

app.post("/api/ai-chat", async (req, res) => {
  if (!FOUNDRY_ENDPOINT || !FOUNDRY_KEY || !FOUNDRY_DEPLOYMENT) {
    return res.status(503).json({ error: "AI not configured." });
  }
  if (!db.isEnabled()) {
    return res.status(503).json({ error: "DB not configured." });
  }

  const { deviceId, userId, listType = "1", lat, lng, message } = req.body || {};
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "deviceId required" });
  }
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message required" });
  }

  try {
    const tickList = userId
      ? await fetchTickListData(userId, listType).catch(() => null)
      : null;
    const ctx = {
      tickList,
      lat: typeof lat === "number" ? lat : parseFloat(lat),
      lng: typeof lng === "number" ? lng : parseFloat(lng),
      userId,
      listType,
    };
    if (Number.isNaN(ctx.lat)) ctx.lat = null;
    if (Number.isNaN(ctx.lng)) ctx.lng = null;

    const history = await db.getChatHistory(deviceId, CHAT_HISTORY_LIMIT);
    await db.insertChatMessage({ deviceId, userId, listType, role: "user", content: message });

    const messages = [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      ...historyToMessages(history),
      { role: "user", content: message },
    ];

    const { isV1, url } = foundryApiUrl();
    const toolTrace = [];
    let finalContent = null;

    for (let turn = 0; turn < CHAT_MAX_TURNS; turn++) {
      const requestBody = {
        messages,
        tools: chatTools.TOOL_SCHEMAS,
        temperature: 0.2,
      };
      if (isV1) requestBody.model = FOUNDRY_DEPLOYMENT;

      const aiRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": FOUNDRY_KEY,
          Authorization: `Bearer ${FOUNDRY_KEY}`,
        },
        body: JSON.stringify(requestBody),
      });
      if (!aiRes.ok) {
        const errText = await aiRes.text();
        throw new Error(`Foundry ${aiRes.status}: ${errText.slice(0, 400)}`);
      }
      const aiJson = await aiRes.json();
      const msg = aiJson.choices?.[0]?.message;
      if (!msg) throw new Error("Empty AI response");

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        finalContent = msg.content || "";
        messages.push({ role: "assistant", content: finalContent });
        await db.insertChatMessage({
          deviceId, userId, listType, role: "assistant", content: finalContent,
        });
        break;
      }

      const assistantMsg = { role: "assistant", content: msg.content || "", tool_calls: toolCalls };
      messages.push(assistantMsg);
      await db.insertChatMessage({
        deviceId, userId, listType, role: "assistant",
        content: msg.content || "",
        toolCalls,
      });

      for (const call of toolCalls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || "{}"); } catch {}
        const name = call.function?.name;
        const result = await chatTools.runTool(name, args, ctx);
        const resultStr = JSON.stringify(result);
        toolTrace.push({ name, args, resultPreview: resultStr.slice(0, 400) });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: resultStr,
        });
        await db.insertChatMessage({
          deviceId, userId, listType, role: "tool",
          content: resultStr,
          toolName: name,
          toolCallId: call.id,
        });
      }
    }

    if (finalContent == null) {
      finalContent = "(Jeg nåede grænsen for værktøjskald uden at færdiggøre svaret. Prøv et mere fokuseret spørgsmål.)";
      await db.insertChatMessage({
        deviceId, userId, listType, role: "assistant", content: finalContent,
      });
    }

    res.json({ content: finalContent, toolTrace });
  } catch (err) {
    console.error("AI chat error:", err.message);
    res.status(500).json({ error: "Chat failed", detail: err.message });
  }
});

app.get("/api/ai-chat/history", async (req, res) => {
  if (!db.isEnabled()) return res.json({ messages: [] });
  const deviceId = req.query.deviceId;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const history = await db.getChatHistory(deviceId, CHAT_HISTORY_LIMIT);
    res.json({ messages: history });
  } catch (err) {
    console.error("Chat history error:", err.message);
    res.status(500).json({ error: "Failed to load chat history" });
  }
});

app.delete("/api/ai-chat", async (req, res) => {
  if (!db.isEnabled()) return res.json({ ok: true });
  const deviceId = req.query.deviceId;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    await db.clearChatHistory(deviceId);
    res.json({ ok: true });
  } catch (err) {
    console.error("Chat clear error:", err.message);
    res.status(500).json({ error: "Failed to clear chat" });
  }
});

// ─── Push: VAPID public key endpoint ──────────────────────────────────
app.get("/api/push/vapid-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// ─── Push: Subscribe ──────────────────────────────────────────────────
app.post("/api/push/subscribe", async (req, res) => {
  const { subscription, userId, listType } = req.body;
  if (!subscription || !userId) {
    return res.status(400).json({ error: "subscription and userId required" });
  }

  const subKey = subscription.endpoint;
  const existing = subscribers.get(subKey);
  subscribers.set(subKey, {
    subscription,
    userId,
    listType: listType || "1",
    lastAlertKeys: existing?.lastAlertKeys || new Set(),
  });

  if (db.isEnabled()) {
    try {
      await db.upsertPushSubscription({
        endpoint: subKey,
        userId,
        listType: listType || "1",
        subscription,
      });
    } catch (err) {
      console.error("Push subscribe DB write failed:", err.message);
    }
  }

  console.log(`📬 Push subscription added for user ${userId} (${subscribers.size} total)`);
  res.json({ ok: true });
});

// ─── Push: Unsubscribe ────────────────────────────────────────────────
app.post("/api/push/unsubscribe", async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) {
    subscribers.delete(endpoint);
    if (db.isEnabled()) {
      try { await db.deletePushSubscription(endpoint); }
      catch (err) { console.error("Push unsubscribe DB delete failed:", err.message); }
    }
  }
  res.json({ ok: true });
});


// ─── Push: Background alert checker ───────────────────────────────────
function normalizeName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");
}

function matchAlerts(tickList, observations) {
  if (!tickList?.birds || !observations?.observations) return [];

  const missingByLatin = new Map();
  for (const bird of tickList.birds) {
    if (!bird.ticked && bird.latin) {
      missingByLatin.set(normalizeName(bird.latin), bird);
    }
  }

  const alerts = [];
  const seen = new Set();
  for (const obs of observations.observations) {
    const latinKey = normalizeName(obs.latin);
    const matchedBird = missingByLatin.get(latinKey);
    if (matchedBird) {
      const key = matchedBird.latin + "|" + obs.location;
      if (!seen.has(key)) {
        seen.add(key);
        alerts.push({
          species: obs.species,
          latin: obs.latin,
          location: obs.location,
          count: obs.count,
          time: obs.time,
          rare: obs.rare,
          scarce: obs.scarce,
          key,
        });
      }
    }
  }
  return alerts;
}

// Read-only by default: returns whatever's in the DB. The notification poller
// passes { allowNetwork: true } so it can re-scrape netfugl when stale or
// missing. No other caller is allowed to scrape.
async function fetchTickListData(userId, listType, { allowNetwork = false } = {}) {
  if (db.isEnabled()) {
    try {
      const stored = await db.getTicklist(userId, listType);
      if (stored) return { birds: stored.birds };
    } catch (err) {
      console.error("DB ticklist read failed:", err.message);
    }
  }
  if (!allowNetwork) return null;

  const url = `https://netfugl.dk/ranking/${listType}/${userId}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const html = await response.text();
  const $ = cheerio.load(html);

  if ($("p").text().includes("Klik her for at vende tilbage")) {
    console.log(`User ${userId} not found for push check`);
    return { birds: [] };
  }

  const birds = [];
  $("table.datatable tbody tr").each((i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 4) return;
    const ticked = $(cells[1]).text().trim() === "X";
    const isSU = $(cells[2]).text().trim() === "*";
    const nameCell = $(cells[3]).text().trim();
    const latinMatch = nameCell.match(/\(([^)]+)\)/);
    const latin = latinMatch ? latinMatch[1].trim() : "";
    const name = nameCell.replace(/\([^)]+\)/, "").trim();
    if (name) birds.push({ name, latin, ticked, isSU });
  });
  if (birds.length === 0) return null;

  if (db.isEnabled()) {
    db.upsertTicklist(userId, listType, birds).catch((e) =>
      console.error("DB ticklist upsert failed:", e.message)
    );
  }
  return { birds };
}

// Notification-only scraper for today's observations. Called from
// checkAndNotify on its 5-minute interval — the one place we're allowed to
// hit dofbasen for a non-seed read.
async function fetchObsData() {
  try {
    const url = "https://dofbasen.dk/observationer/";
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const html = iconv.decode(Buffer.from(buffer), "iso-8859-1");

    const speciesPattern =
      /<a[^>]*class="arter"[^>]*href="[^"]*art=(\d+)[^"]*"[^>]*title="Alle observationer af ([^"]+)"[^>]*><span class="(defaultart|subart|su|seasonart)">([^<]+)<\/span><\/a>\s*\(<i>([^<]+)<\/i>\):/g;

    let match;
    const speciesBlocks = [];
    while ((match = speciesPattern.exec(html)) !== null) {
      speciesBlocks.push({
        index: match.index,
        cssClass: match[3],
        danishName: match[4].trim(),
        latinName: match[5].trim(),
      });
    }

    const observations = [];
    const seen = new Set();

    for (let i = 0; i < speciesBlocks.length; i++) {
      const species = speciesBlocks[i];
      const startIdx = species.index;
      const endIdx = i + 1 < speciesBlocks.length ? speciesBlocks[i + 1].index : html.length;
      const block = html.substring(startIdx, endIdx);
      const $block = cheerio.load(block, null, false);

      $block("table tr").each((_, row) => {
        const cells = $block(row).find("td");
        if (cells.length < 10) return;

        const locationLink = $block(row).find("a.lokalitet");
        const location = locationLink.text().trim();
        if (!location) return;

        const key = `${species.danishName}-${location}`;
        if (seen.has(key)) return;
        seen.add(key);

        const countText = $block(row).find('td[align="right"] a.arter').first().text().trim();
        const count = parseInt(countText, 10) || 0;

        const clockIcon = $block(row).find('i.fa-clock-o[title]');
        let time = "";
        if (clockIcon.length) {
          time = (clockIcon.first().attr("title") || "")
            .replace(/Ophold p.{1,2} lokaliteten: /, "");
        }

        observations.push({
          species: species.danishName,
          latin: species.latinName,
          location, count, time,
          rare: species.cssClass === "su",
          scarce: species.cssClass === "subart",
        });
      });
    }

    return { observations };
  } catch (err) {
    console.error("Push obs fetch error:", err.message);
    return null;
  }
}

async function checkAndNotify() {
  if (subscribers.size === 0) return;

  console.log(`🔍 Checking alerts for ${subscribers.size} subscriber(s)...`);

  const obs = await fetchObsData();
  if (!obs) return;

  for (const [subKey, sub] of subscribers.entries()) {
    try {
      const tickList = await fetchTickListData(sub.userId, sub.listType, { allowNetwork: true });
      if (!tickList) continue;

      const alerts = matchAlerts(tickList, obs);
      const currentKeys = new Set(alerts.map((a) => a.key));

      // Find NEW alerts (not seen before by this subscriber)
      const newAlerts = alerts.filter((a) => !sub.lastAlertKeys.has(a.key));

      if (newAlerts.length > 0) {
        const speciesGroups = new Map();
        for (const a of newAlerts) {
          const key = a.latin || a.species;
          if (!speciesGroups.has(key)) speciesGroups.set(key, { species: a.species, locations: [], totalCount: 0 });
          const g = speciesGroups.get(key);
          if (a.location) g.locations.push(a.location);
          g.totalCount += a.count || 0;
        }
        const speciesCount = speciesGroups.size;

        const title = speciesCount === 1
          ? `🐦 ${[...speciesGroups.values()][0].species} spottet!`
          : `🐦 ${speciesCount} manglende arter spottet!`;

        const lines = [...speciesGroups.values()].slice(0, 5).map((g) => {
          const parts = [g.species];
          const locs = [...new Set(g.locations)];
          if (locs.length === 1) parts.push(`📍 ${locs[0]}`);
          else if (locs.length > 1) parts.push(`📍 ${locs.length} lok.`);
          if (g.totalCount) parts.push(`${g.totalCount} stk`);
          return parts.join(" — ");
        });
        if (speciesCount > 5) lines.push(`...og ${speciesCount - 5} mere`);

        const payload = JSON.stringify({
          title,
          body: lines.join("\n"),
          data: { url: "/", alertCount: speciesCount },
        });

        await webpush.sendNotification(sub.subscription, payload);
        console.log(`📬 Sent push to user ${sub.userId}: ${speciesCount} new species (${newAlerts.length} obs)`);
      }

      // Update last seen alerts
      sub.lastAlertKeys = currentKeys;
      if (db.isEnabled()) {
        try { await db.updateLastAlertKeys(subKey, currentKeys); }
        catch (e) { console.error("lastAlertKeys persist failed:", e.message); }
      }
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired or invalid — remove it
        console.log(`🗑️ Removing expired subscription for user ${sub.userId}`);
        subscribers.delete(subKey);
        if (db.isEnabled()) {
          try { await db.deletePushSubscription(subKey); }
          catch (e) { console.error("expired sub DB delete failed:", e.message); }
        }
      } else {
        console.error(`Push error for user ${sub.userId}:`, err.message);
      }
    }
  }
}

// Check every 5 minutes
const PUSH_CHECK_INTERVAL = 5 * 60 * 1000;
let pushInterval;

// SPA fallback. Read index.html once at boot — avoids disk IO per hit.
const fs = require("fs");
const INDEX_HTML = fs.readFileSync(
  path.join(__dirname, "..", "public", "index.html")
);
app.get("*", (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.type("html").send(INDEX_HTML);
});

async function bootstrap() {
  if (db.isEnabled()) {
    try {
      await runMigrations();
      const persisted = await db.loadAllPushSubscriptions();
      for (const p of persisted) {
        subscribers.set(p.endpoint, {
          subscription: p.subscription,
          userId: p.userId,
          listType: p.listType,
          lastAlertKeys: p.lastAlertKeys,
        });
      }
      console.log(`💾 Loaded ${persisted.length} push subscription(s) from DB`);
    } catch (err) {
      console.error("DB bootstrap failed (continuing in memory-only mode):", err.message);
    }
  } else {
    console.log("⚠️  DATABASE_URL not set — running without persistence");
  }

  app.listen(PORT, () => {
    console.log(`🐦 Bird Ticker proxy running on http://localhost:${PORT}`);
    refreshObservationsForDate(null)
      .then((d) => console.log(`🔥 Prewarmed observations: ${d.count} obs`))
      .catch((e) => console.error("Prewarm failed:", e.message));
    pushInterval = setInterval(checkAndNotify, PUSH_CHECK_INTERVAL);
    console.log(`📬 Push checker running every ${PUSH_CHECK_INTERVAL / 1000}s`);

    if (db.isEnabled() && process.env.BACKFILL_DISABLED !== "true") {
      setImmediate(() => {
        backfill
          .runBackfill({
            years: parseInt(process.env.BACKFILL_YEARS || "3", 10),
            fetchOne: (date) => refreshObservationsForDate(date),
          })
          .catch((e) => console.error("Backfill failed:", e.message));
      });
    }
  });

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => backfill.abort());
  }
}

bootstrap();
