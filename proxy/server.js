const express = require("express");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Cache stores
const cache = new Map();
const TICK_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const OBS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key, ttl) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttl) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

// Serve static frontend files
app.use(express.static(path.join(__dirname, "..", "public")));

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
    if (!response.ok) throw new Error(`Netfugl returned ${response.status}`);

    const html = await response.text();
    const $ = cheerio.load(html);
    const birds = [];

    $("table.datatable tbody tr").each((i, row) => {
      const cells = $(row).find("td");
      if (cells.length < 4) return;

      const number = parseInt($(cells[0]).text().trim(), 10);
      const ticked = $(cells[1]).text().trim() === "X";
      const removed = $(cells[2]).text().trim() === "*";
      const nameCell = $(cells[3]).text().trim();

      // Parse "Agerhøne (Perdix perdix)"
      const latinMatch = nameCell.match(/\(([^)]+)\)/);
      const latin = latinMatch ? latinMatch[1].trim() : "";
      const name = nameCell.replace(/\([^)]+\)/, "").trim();

      if (name) {
        birds.push({ number, name, latin, ticked, removed });
      }
    });

    // Extract list name from page
    const listName = $("p.page-headline").text().trim() || "Krydsliste";

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
app.get("/api/observations", async (req, res) => {
  const { region = "all" } = req.query;

  const cacheKey = `obs-${region}`;
  const cached = getCached(cacheKey, OBS_CACHE_TTL);
  if (cached) return res.json(cached);

  try {
    const url = "https://dofbasen.dk/observationer/";
    const response = await fetch(url);
    if (!response.ok) throw new Error(`DOFbasen returned ${response.status}`);

    // DOFbasen uses ISO-8859-1
    const buffer = await response.arrayBuffer();
    const html = iconv.decode(Buffer.from(buffer), "iso-8859-1");
    const $ = cheerio.load(html);

    const observations = [];
    const seen = new Set();

    // DOFbasen structure: species name in <a><span class="defaultart|subart|seasonart">
    // followed by (<i>Latin name</i>): then table rows with observation details
    const content = $("#content_observation").html() || $("body").html();
    const $content = cheerio.load(content);

    // Find all species headers and their observation tables
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

      // Parse observation tables within this block
      const $block = cheerio.load(block);
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
      date: new Date().toISOString().slice(0, 10),
      count: observations.length,
      observations,
    };

    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error("Observations error:", err.message);
    res.status(500).json({ error: "Failed to fetch observations", detail: err.message });
  }
});

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

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🐦 Bird Ticker proxy running on http://localhost:${PORT}`);
});
