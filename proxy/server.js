const express = require("express");
const compression = require("compression");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const webpush = require("web-push");
const path = require("path");

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

// Cache stores. Bounded LRU-ish: oldest entries evicted past MAX_CACHE_ENTRIES
// to prevent unbounded heap growth on long-running App Service container.
const cache = new Map();
const MAX_CACHE_ENTRIES = 500;

// In-flight request dedupe: parallel callers wait on the same upstream fetch.
// Without this, two concurrent cold requests both scrape DOFbasen.
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
const TICK_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const OBS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key, ttl) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttl) return entry.data;
  return null;
}

function setCache(key, data) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { data, time: Date.now() });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

// JSON body parsing for push subscription
app.use(express.json());

// Gzip/brotli responses to cut bandwidth + perceived latency.
app.use(compression());

// Serve static frontend files with browser caching. Service worker (sw.js)
// must NOT be long-cached or PWA updates stall.
app.use(express.static(path.join(__dirname, "..", "public"), {
  maxAge: "1d",
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("sw.js") || filePath.endsWith("manifest.json")) {
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
app.get("/api/ticklist", async (req, res) => {
  const { listType = "1", userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  const cacheKey = `tick-${listType}-${userId}`;
  const cached = getCached(cacheKey, TICK_CACHE_TTL);
  if (cached) return res.json(cached);

  try {
    const url = `https://netfugl.dk/ranking/${listType}/${userId}`;
    const response = await fetch(url);

    // Check if user not found (even before checking status)
    if (response.status !== 200) {
      console.log(`Netfugl returned ${response.status} for user ${userId}`);
      // Try to get HTML to see if it's the not found page
      const html = await response.text();
      const $ = cheerio.load(html);
      const noUserMsg = $("p").text().includes("Klik her for at vende tilbage");
      
      if (noUserMsg) {
        return res.json({
          userId,
          listType,
          listName: "Not found",
          total: 0,
          ticked: 0,
          birds: [],
          error: "User not found on Netfugl"
         });
      }
      
      throw new Error(`Netfugl returned ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Check if user not found (page contains "Klik her for at vende tilbage")
    const noUserMsg = $("p").text().includes("Klik her for at vende tilbage");
    if (noUserMsg) {
      console.log(`User ${userId} not found on Netfugl`);
      return res.json({
        userId,
        listType,
        listName: "Not found",
        total: 0,
        ticked: 0,
        birds: [],
        error: "User not found on Netfugl"
      });
    }
  
    const birds = [];

    $("table.datatable tbody tr").each((i, row) => {
      const cells = $(row).find("td");
      if (cells.length < 4) return;

      const number = parseInt($(cells[0]).text().trim(), 10);
const ticked = $(cells[1]).text().trim() === "X";
      const isSU = $(cells[2]).text().trim() === "*";
      const nameCell = $(cells[3]).text().trim();

      // Parse "Agerhøne (Perdix perdix)"
      const latinMatch = nameCell.match(/\(([^)]+)\)/);
      const latin = latinMatch ? latinMatch[1].trim() : "";
      const name = nameCell.replace(/\([^)]+\)/, "").trim();

      if (name) {
        birds.push({ number, name, latin, ticked, isSU });
      }
    });

    // Extract list name from page
    const listName = $("p.page-headline").text().trim() || "Krydsliste";

    // Check if no birds found (could be user not found page without the message)
    if (birds.length === 0) {
      console.log(`No birds found for user ${userId}`);
      return res.json({
        userId,
        listType,
        listName: "No data",
        total: 0,
        ticked: 0,
        birds: [],
        error: "User not found or no data"
       });
     }

    const data = {
      userId,
      listType,
      listName,
      total: birds.length,
      ticked: birds.filter((b) => b.ticked).length,
      birds,
    };

    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error("Ticklist error:", err.message);
    res.status(500).json({ error: "Failed to fetch tick list", detail: err.message });
  }
});

// ─── Observations Endpoint ────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayStr = () => new Date().toISOString().slice(0, 10);

async function fetchObservationsForDate(date) {
  const isToday = !date || date === todayStr();
  const cacheKey = `obs-all-${date || "today"}`;
  const ttl = isToday ? OBS_CACHE_TTL : 24 * 60 * 60 * 1000;
  const cached = getCached(cacheKey, ttl);
  if (cached) return cached;

  return dedupe(cacheKey, async () => {
    const cachedAfterWait = getCached(cacheKey, ttl);
    if (cachedAfterWait) return cachedAfterWait;

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
    return parseObservationsHtml(response, date || todayStr(), cacheKey);
  });
}

app.get("/api/observations", async (req, res) => {
  const date = DATE_RE.test(req.query.date || "") ? req.query.date : null;
  try {
    const data = await fetchObservationsForDate(date);
    res.json(data);
  } catch (err) {
    console.error("Observations error:", err.message);
    res.status(500).json({ error: "Failed to fetch observations", detail: err.message });
  }
});

async function parseObservationsHtml(response, dateLabel, cacheKey) {
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

    // Resolve coordinates for observations missing them via locality lookup
    const needLoknrs = [...new Set(
      observations.filter(o => o.lat == null && o.loknr).map(o => o.loknr)
    )];

    if (needLoknrs.length > 0) {
      const lokResults = {};
      // Fetch in parallel batches of 20 to be polite
      for (let i = 0; i < needLoknrs.length; i += 20) {
        const batch = needLoknrs.slice(i, i + 20);
        await Promise.all(batch.map(async (loknr) => {
          const lokCacheKey = `lok-${loknr}`;
          const lokCached = getCached(lokCacheKey, 24 * 60 * 60 * 1000);
          if (lokCached) {
            lokResults[loknr] = lokCached;
            return;
          }
          try {
            const lokUrl = `https://dofbasen.dk/poplok.php?loknr=${loknr}`;
            const lokRes = await fetch(lokUrl);
            const lokBuf = await lokRes.arrayBuffer();
            const lokHtml = iconv.decode(Buffer.from(lokBuf), "iso-8859-1");
            const $lok = cheerio.load(lokHtml);
            const lonVal = parseFloat($lok("#lok_center_lon").text());
            const latVal = parseFloat($lok("#lok_center_lat").text());
            const lokData = { lat: isNaN(lonVal) ? null : lonVal, lng: isNaN(latVal) ? null : latVal };
            setCache(lokCacheKey, lokData);
            lokResults[loknr] = lokData;
          } catch {
            lokResults[loknr] = { lat: null, lng: null };
          }
        }));
      }

      // Apply resolved coords
      for (const obs of observations) {
        if (obs.lat == null && obs.loknr && lokResults[obs.loknr]) {
          obs.lat = lokResults[obs.loknr].lat;
          obs.lng = lokResults[obs.loknr].lng;
        }
      }
    }

    const data = {
      date: dateLabel,
      count: observations.length,
      observations,
    };

    setCache(cacheKey, data);
    return data;
  } catch (err) {
    console.error("Observations parse error:", err.message);
    throw err;
  }
}

// ─── Locality Coordinates Endpoint ────────────────────────────────────
const LOK_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

app.get("/api/locality/:loknr", async (req, res) => {
  const { loknr } = req.params;
  const cacheKey = `lok-${loknr}`;
  const cached = getCached(cacheKey, LOK_CACHE_TTL);
  if (cached) return res.json(cached);

  try {
    const url = `https://dofbasen.dk/poplok.php?loknr=${loknr}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`DOFbasen returned ${response.status}`);

    const buffer = await response.arrayBuffer();
    const html = iconv.decode(Buffer.from(buffer), "iso-8859-1");

    // Extract coords: <span id="lok_center_lon">55.923598</span>/<span id="lok_center_lat">12.314231</span>
    // Note: DOFbasen labels are swapped — "lon" contains latitude, "lat" contains longitude
    const $ = cheerio.load(html);
    const lonVal = parseFloat($("#lok_center_lon").text());
    const latVal = parseFloat($("#lok_center_lat").text());

    if (isNaN(lonVal) || isNaN(latVal)) {
      return res.json({ loknr, lat: null, lng: null });
    }

    // DOFbasen has lon/lat labels swapped in the HTML
    const data = { loknr, lat: lonVal, lng: latVal };
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error("Locality error:", err.message);
    res.status(500).json({ error: "Failed to fetch locality", detail: err.message });
  }
});

// ─── Full Species List (DOFbasen art IDs) ────────────────────────────────────
const SPECIES_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

app.get("/api/species-map", async (req, res) => {
  const cacheKey = "species-map";
  const cached = getCached(cacheKey, SPECIES_CACHE_TTL);
  if (cached) return res.json(cached);

  try {
    const response = await fetch(
      "https://service.dofbasen.dk/DanmarksFugleBackend/api/home/alphabetically"
    );
    if (!response.ok) throw new Error(`DOFbasen species API returned ${response.status}`);

    const list = await response.json();
    // Build map: lowercased Danish name -> artId
    const byName = {};
    for (const item of list) {
      if (item.label && item.value && item.value !== "xxxxx") {
        byName[item.label.toLowerCase().trim()] = item.value;
      }
    }

    const data = { count: Object.keys(byName).length, byName };
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error("Species map error:", err.message);
    res.status(500).json({ error: "Failed to fetch species map", detail: err.message });
  }
});

// ─── Batch Locality Coordinates ───────────────────────────────────────
app.get("/api/localities", async (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.status(400).json({ error: "ids parameter required (comma-separated loknr)" });

  const loknrs = ids.split(",").filter(Boolean).slice(0, 50); // max 50
  const results = {};

  await Promise.all(
    loknrs.map(async (loknr) => {
      const cacheKey = `lok-${loknr}`;
      const cached = getCached(cacheKey, LOK_CACHE_TTL);
      if (cached) {
        results[loknr] = cached;
        return;
      }

      try {
        const url = `https://dofbasen.dk/poplok.php?loknr=${loknr}`;
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const html = iconv.decode(Buffer.from(buffer), "iso-8859-1");
        const $ = cheerio.load(html);
        const lonVal = parseFloat($("#lok_center_lon").text());
        const latVal = parseFloat($("#lok_center_lat").text());

        const data = { loknr, lat: isNaN(lonVal) ? null : lonVal, lng: isNaN(latVal) ? null : latVal };
        setCache(cacheKey, data);
        results[loknr] = data;
      } catch {
        results[loknr] = { loknr, lat: null, lng: null };
      }
    })
  );

  res.json(results);
});

// ─── AI Predictions Endpoint ──────────────────────────────────────────
const AI_CACHE_TTL = 60 * 60 * 1000; // 1h
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

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function dateOneYearAgo(dateStr) {
  const [y, m, dd] = dateStr.split("-").map(Number);
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

app.get("/api/ai-predictions", async (req, res) => {
  if (!FOUNDRY_ENDPOINT || !FOUNDRY_KEY || !FOUNDRY_DEPLOYMENT) {
    return res.status(503).json({ error: "AI not configured. Set AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_KEY, AZURE_FOUNDRY_DEPLOYMENT." });
  }

  const userId = req.query.userId;
  const listType = req.query.listType || "1";
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!userId || isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: "userId, lat, lng required" });
  }

  const cacheKey = `ai-${userId}-${listType}-${Math.round(lat * 10) / 10}-${Math.round(lng * 10) / 10}`;
  const cached = getCached(cacheKey, AI_CACHE_TTL);
  if (cached) return res.json(cached);

  try {
    const tickList = await fetchTickListData(userId, listType);
    if (!tickList?.birds?.length) {
      return res.status(404).json({ error: "tickList not found" });
    }

    const missing = new Map();
    for (const b of tickList.birds) {
      if (!b.ticked && b.latin) missing.set(b.latin.toLowerCase(), b);
    }

    // Reduced from 7 to 3 days. Each day = full DOFbasen scrape + locality
    // lookups (~9s cold). 7+7 days exceeded Azure's 230s gateway timeout.
    const dates = [];
    for (let i = 0; i < 3; i++) dates.push(dateNDaysAgo(i));
    const yearAgoDates = dates.map(dateOneYearAgo);

    // Limit concurrency to avoid OOM on small App Service plans.
    // Cheerio parsing of the full DOFbasen HTML is memory-heavy; 14 in parallel
    // exhausts Node's default heap on B1.
    async function mapLimit(items, limit, fn) {
      const out = new Array(items.length);
      let idx = 0;
      const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (idx < items.length) {
          const i = idx++;
          out[i] = await fn(items[i]).catch(() => null);
        }
      });
      await Promise.all(workers);
      return out;
    }

    const recent = await mapLimit(dates, 3, fetchObservationsForDate);
    const lastYear = await mapLimit(yearAgoDates, 3, fetchObservationsForDate);

    const filterRelevant = (daysList) => {
      const out = [];
      for (const day of daysList) {
        if (!day?.observations) continue;
        for (const obs of day.observations) {
          if (!obs.latin) continue;
          if (!missing.has(obs.latin.toLowerCase())) continue;
          const dist = distanceKm(lat, lng, obs.lat, obs.lng);
          if (dist == null || dist > 100) continue;
          out.push({
            species: obs.species,
            latin: obs.latin,
            date: day.date,
            location: obs.location,
            count: obs.count,
            distanceKm: Math.round(dist * 10) / 10,
            time: obs.time,
            rare: obs.rare,
          });
        }
      }
      return out;
    };

    const recentRelevant = filterRelevant(recent);
    const lastYearRelevant = filterRelevant(lastYear);

    // Top 10 species by recent obs count (tiebreak: closer distance)
    const speciesStats = new Map();
    for (const obs of recentRelevant) {
      const cur = speciesStats.get(obs.latin) || { count: 0, minDist: Infinity };
      cur.count += 1;
      cur.minDist = Math.min(cur.minDist, obs.distanceKm);
      speciesStats.set(obs.latin, cur);
    }
    const topSpecies = [...speciesStats.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[1].minDist - b[1].minDist)
      .slice(0, 10)
      .map(([latin]) => latin);

    if (topSpecies.length === 0) {
      const empty = {
        generatedAt: new Date().toISOString(),
        predictions: [],
        note: "Ingen relevante observationer indenfor 100 km",
      };
      setCache(cacheKey, empty);
      return res.json(empty);
    }

    const speciesSet = new Set(topSpecies);
    const trim = (list) => list.filter((o) => speciesSet.has(o.latin));

    const systemPrompt =
      "Du er en ekspert ornitolog og analytiker. Brugeren mangler at krydse en række fuglearter af. Givet observationsdata fra brugerens område (de seneste 7 dage og samme uge sidste år), forudsig hvor og hvornår brugeren har bedst chance for at se de manglende arter de næste dage. Brug mønstre fra historikken. Svar kun med struktureret JSON, på dansk.";

    const userPayload = {
      brugerLokation: { lat, lng },
      manglendeArter: topSpecies.map((latin) => ({
        latin,
        navn: missing.get(latin.toLowerCase())?.name,
      })),
      sidsteUge: trim(recentRelevant),
      sammeUgeSidsteAar: trim(lastYearRelevant),
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
      temperature: 0.4,
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

    const data = {
      generatedAt: new Date().toISOString(),
      predictions: parsed.predictions || [],
    };
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error("AI predictions error:", err.message);
    res.status(500).json({ error: "Failed to generate predictions", detail: err.message });
  }
});

// ─── AI Calendar Endpoint ─────────────────────────────────────────────
// Returns monthly recommendations grouped by location: where to go in a
// given upcoming month to tick missing species, based on observations from
// the same month last year.
const CAL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — monthly view changes slowly

function lastYearMonthSampleDates(monthStr) {
  // monthStr = "YYYY-MM" (target future month). Sample dates = same month, prev year, every 3rd day.
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr);
  if (!m) return [];
  const year = parseInt(m[1], 10) - 1;
  const month = parseInt(m[2], 10);
  const daysInMonth = new Date(year, month, 0).getDate();
  const out = [];
  for (let d = 1; d <= daysInMonth; d += 3) {
    out.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

app.get("/api/ai-calendar", async (req, res) => {
  if (!FOUNDRY_ENDPOINT || !FOUNDRY_KEY || !FOUNDRY_DEPLOYMENT) {
    return res.status(503).json({ error: "AI not configured. Set AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_KEY, AZURE_FOUNDRY_DEPLOYMENT." });
  }

  const userId = req.query.userId;
  const listType = req.query.listType || "1";
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const month = req.query.month;
  if (!userId || isNaN(lat) || isNaN(lng) || !/^\d{4}-\d{2}$/.test(month || "")) {
    return res.status(400).json({ error: "userId, lat, lng, month (YYYY-MM) required" });
  }

  const cacheKey = `ai-cal-${userId}-${listType}-${Math.round(lat * 10) / 10}-${Math.round(lng * 10) / 10}-${month}`;
  const cached = getCached(cacheKey, CAL_CACHE_TTL);
  if (cached) return res.json(cached);

  try {
    const tickList = await fetchTickListData(userId, listType);
    if (!tickList?.birds?.length) {
      return res.status(404).json({ error: "tickList not found" });
    }

    const missing = new Map();
    for (const b of tickList.birds) {
      if (!b.ticked && b.latin) missing.set(b.latin.toLowerCase(), b);
    }

    const sampleDates = lastYearMonthSampleDates(month);
    if (sampleDates.length === 0) {
      return res.status(400).json({ error: "invalid month" });
    }

    async function mapLimit(items, limit, fn) {
      const out = new Array(items.length);
      let idx = 0;
      const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (idx < items.length) {
          const i = idx++;
          out[i] = await fn(items[i]).catch(() => null);
        }
      });
      await Promise.all(workers);
      return out;
    }

    const days = await mapLimit(sampleDates, 3, fetchObservationsForDate);

    const relevant = [];
    for (const day of days) {
      if (!day?.observations) continue;
      for (const obs of day.observations) {
        if (!obs.latin) continue;
        if (!missing.has(obs.latin.toLowerCase())) continue;
        const dist = distanceKm(lat, lng, obs.lat, obs.lng);
        if (dist == null || dist > 100) continue;
        relevant.push({
          species: obs.species,
          latin: obs.latin,
          date: day.date,
          location: obs.location,
          loknr: obs.loknr,
          count: obs.count,
          distanceKm: Math.round(dist * 10) / 10,
          rare: obs.rare,
        });
      }
    }

    // Top 8 species by frequency (tiebreak: closer distance)
    const speciesStats = new Map();
    for (const obs of relevant) {
      const cur = speciesStats.get(obs.latin) || { count: 0, minDist: Infinity };
      cur.count += 1;
      cur.minDist = Math.min(cur.minDist, obs.distanceKm);
      speciesStats.set(obs.latin, cur);
    }
    const topSpecies = [...speciesStats.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[1].minDist - b[1].minDist)
      .slice(0, 8)
      .map(([latin]) => latin);

    if (topSpecies.length === 0) {
      const empty = {
        generatedAt: new Date().toISOString(),
        month,
        locations: [],
        note: "Ingen relevante observationer indenfor 100 km for denne måned sidste år",
      };
      setCache(cacheKey, empty);
      return res.json(empty);
    }

    const speciesSet = new Set(topSpecies);
    const trimmed = relevant.filter((o) => speciesSet.has(o.latin));

    const monthNamesDa = ["januar","februar","marts","april","maj","juni","juli","august","september","oktober","november","december"];
    const targetMonthName = monthNamesDa[parseInt(month.slice(5,7),10) - 1];

    const systemPrompt =
      "Du er en ekspert ornitolog. Brugeren planlægger fugleture og mangler at krydse en række arter af. " +
      "Givet observationer fra samme måned sidste år indenfor 100 km af brugerens position, anbefal de bedste lokaliteter at besøge i den kommende måned. " +
      "Gruppér anbefalinger pr. LOKALITET, ikke pr. art — hvert lokalitets-objekt skal liste de manglende arter brugeren har god chance for at se dér. " +
      "Sortér lokaliteter så dem hvor brugeren kan krydse flest manglende arter af kommer først. " +
      "Skriv kort dansk reasoning pr. art og pr. lokalitet. Svar kun med struktureret JSON.";

    const userPayload = {
      brugerLokation: { lat, lng },
      maalMaaned: month,
      maalMaanedNavn: targetMonthName,
      manglendeArter: topSpecies.map((latin) => ({
        latin,
        navn: missing.get(latin.toLowerCase())?.name,
      })),
      observationerSammeMaanedSidsteAar: trimmed,
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
                        latin: { type: "string" },
                        confidence: { type: "string", enum: ["lav", "mellem", "høj"] },
                        reasoning: { type: "string" },
                      },
                      required: ["species", "latin", "confidence", "reasoning"],
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
      temperature: 0.4,
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

    const data = {
      generatedAt: new Date().toISOString(),
      month,
      locations: parsed.locations || [],
    };
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error("AI calendar error:", err.message);
    res.status(500).json({ error: "Failed to generate calendar", detail: err.message });
  }
});

// ─── Push: VAPID public key endpoint ──────────────────────────────────
app.get("/api/push/vapid-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// ─── Push: Subscribe ──────────────────────────────────────────────────
app.post("/api/push/subscribe", (req, res) => {
  const { subscription, userId, listType } = req.body;
  if (!subscription || !userId) {
    return res.status(400).json({ error: "subscription and userId required" });
  }

  const subKey = subscription.endpoint;
  subscribers.set(subKey, {
    subscription,
    userId,
    listType: listType || "1",
    lastAlertKeys: new Set(),
  });

  console.log(`📬 Push subscription added for user ${userId} (${subscribers.size} total)`);
  res.json({ ok: true });
});

// ─── Push: Unsubscribe ────────────────────────────────────────────────
app.post("/api/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) subscribers.delete(endpoint);
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

async function fetchTickListData(userId, listType) {
  const cacheKey = `tick-${listType}-${userId}`;
  const cached = getCached(cacheKey, TICK_CACHE_TTL);
  if (cached) return cached;

  const url = `https://netfugl.dk/ranking/${listType}/${userId}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const html = await response.text();
  const $ = cheerio.load(html);
   
   // Check if user not found
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
     // Return null if no birds found
  if (birds.length === 0) return null;
     
  const data = { birds };
  setCache(cacheKey, data);
  return data;
}

async function fetchObsData() {
  const cacheKey = "obs-push";
  const cached = getCached(cacheKey, OBS_CACHE_TTL);
  if (cached) return cached;

  // Reuse the main observations cache if available
  const mainCached = getCached("obs-all", OBS_CACHE_TTL);
  if (mainCached) {
    setCache(cacheKey, mainCached);
    return mainCached;
  }

  // Fetch fresh
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

    const data = { observations };
    setCache(cacheKey, data);
    return data;
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
      const tickList = await fetchTickListData(sub.userId, sub.listType);
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
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired or invalid — remove it
        console.log(`🗑️ Removing expired subscription for user ${sub.userId}`);
        subscribers.delete(subKey);
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
  res.type("html").send(INDEX_HTML);
});

app.listen(PORT, () => {
  console.log(`🐦 Bird Ticker proxy running on http://localhost:${PORT}`);
  // Pre-warm today's observations cache so the first user doesn't pay the
  // 9s cold-scrape latency.
  fetchObservationsForDate(null)
    .then((d) => console.log(`🔥 Prewarmed observations: ${d.count} obs`))
    .catch((e) => console.error("Prewarm failed:", e.message));
  // Start background push checker
  pushInterval = setInterval(checkAndNotify, PUSH_CHECK_INTERVAL);
  console.log(`📬 Push checker running every ${PUSH_CHECK_INTERVAL / 1000}s`);
});
