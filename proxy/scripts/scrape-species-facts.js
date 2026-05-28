// One-off scraper for dofbasen.dk/danmarksfugle/art/<artId> species pages.
// The pages are Vue-rendered, so we use puppeteer to get the live DOM.
//
// For each species in the local observations DB:
//   1. Render the page in a headless browser.
//   2. Extract description, facts cards, habitat, diet, status, gallery URLs.
//   3. Download the hero image to public/img/species/<artId>.jpg (resized).
//   4. Write everything to proxy/data/species-facts.json.
//
// Usage:
//   DATABASE_URL=postgresql://... node proxy/scripts/scrape-species-facts.js [opts]
//
// Flags:
//   --only=02390      Single artId.
//   --limit=N         First N species only.
//   --force-images    Re-download images even if file exists.
//   --concurrency=N   Parallel pages (default 3).
//   --skip-images     Skip image download.

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const sharp = require("sharp");
const db = require("../db");

const ROOT = path.join(__dirname, "..", "..");
const OUT_JSON = path.join(__dirname, "..", "data", "species-facts.json");
const IMG_DIR = path.join(ROOT, "public", "img", "species");
const PAGE_BASE = "https://dofbasen.dk/danmarksfugle/art";
const IMAGE_MAX_WIDTH = 800;
const NAV_TIMEOUT = 45000;

function parseArgs() {
  const args = { concurrency: 3, force: false, skipImages: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--only=")) args.only = a.slice(7);
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
    else if (a.startsWith("--concurrency=")) args.concurrency = parseInt(a.slice(14), 10);
    else if (a === "--force-images") args.force = true;
    else if (a === "--skip-images") args.skipImages = true;
  }
  return args;
}

async function loadSpeciesList(browser) {
  // Primary source: the dofbasen species index — the full set of art pages.
  const indexPage = await browser.newPage();
  await indexPage.goto("https://dofbasen.dk/danmarksfugle/", {
    waitUntil: "networkidle2",
    timeout: NAV_TIMEOUT,
  });
  const links = await indexPage.$$eval(
    'a[href*="/danmarksfugle/art/"]',
    (as) =>
      as.map((a) => ({
        href: a.href,
        text: (a.innerText || "").trim(),
      }))
  );
  await indexPage.close();

  const indexed = [];
  const seen = new Set();
  for (const l of links) {
    const m = l.href.match(/\/art\/(\d+)/);
    if (!m) continue;
    const artId = m[1];
    if (seen.has(artId)) continue;
    seen.add(artId);
    indexed.push({ artId, name: l.text });
  }

  // Enrich with latin names from local observations DB (when available).
  const { rows } = await db.query(
    `SELECT raw->>'artId' AS art_id,
            max(species) AS name,
            max(latin)   AS latin
       FROM observations
      WHERE raw->>'artId' IS NOT NULL
        AND raw->>'artId' <> ''
      GROUP BY raw->>'artId'`
  );
  const dbByArt = new Map(rows.map((r) => [r.art_id, r]));
  for (const s of indexed) {
    const hit = dbByArt.get(s.artId);
    if (hit) {
      s.latin = hit.latin;
      if (!s.name && hit.name) s.name = hit.name;
    }
  }
  return indexed;
}

function readExistingFacts() {
  if (!fs.existsSync(OUT_JSON)) return {};
  try {
    const arr = JSON.parse(fs.readFileSync(OUT_JSON, "utf8"));
    const out = {};
    for (const r of arr) out[r.artId] = r;
    return out;
  } catch {
    return {};
  }
}

function writeFacts(byArtId) {
  const arr = Object.values(byArtId).sort((a, b) => a.artId.localeCompare(b.artId));
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(arr, null, 2));
}

async function extractFromPage(page) {
  return page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText.trim().replace(/\s+/g, " ") : "";
    };
    const allText = (sel) => {
      const els = document.querySelectorAll(sel);
      return [...els].map((e) => e.innerText.trim().replace(/\s+/g, " ")).filter(Boolean);
    };
    const sectionText = (id) => {
      const sec = document.getElementById(id);
      if (!sec) return "";
      // Drop the heading from text; keep paragraph + lists.
      const clone = sec.cloneNode(true);
      clone.querySelectorAll("h1, h2, h3, .margin-top-medium .button-container, button").forEach((n) => n.remove());
      return clone.innerText.trim().replace(/\n{2,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
    };

    const heroImg = document.querySelector(".header-image img.image, .image-container img.image");
    const heroSrc = heroImg ? heroImg.currentSrc || heroImg.src : null;

    const facts = {};
    document.querySelectorAll("#fakta .fact-card").forEach((card) => {
      const label = card.querySelector("img")?.alt?.trim() || card.querySelector("h3, h4")?.innerText?.trim() || "";
      const value = card.innerText.trim().replace(/\s+/g, " ");
      if (label) facts[label] = value;
    });

    const galleryImgs = [...document.querySelectorAll("#galleri img")]
      .map((i) => i.currentSrc || i.src)
      .filter((s) => s && !s.startsWith("data:"))
      .slice(0, 6);

    const headerName = text(".header-text h1, .header-text .heading, .header-text") ||
      document.title.replace(/\s*[-|]\s*Danmarks Fugle.*$/i, "").trim();

    return {
      headerName,
      description: sectionText("beskrivelse"),
      habitat: sectionText("levested"),
      diet: sectionText("føde"),
      population: sectionText("bestandsudvikling"),
      protection: sectionText("beskyttelse"),
      breeding: sectionText("ynglebestand"),
      more: sectionText("mere"),
      facts,
      heroImage: heroSrc,
      galleryImages: galleryImgs,
    };
  });
}

async function downloadAndStoreImage(url, artId, force) {
  if (!url || url.startsWith("data:")) return null;
  const outPath = path.join(IMG_DIR, `${artId}.jpg`);
  if (fs.existsSync(outPath) && !force) return `/img/species/${artId}.jpg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(IMG_DIR, { recursive: true });
  await sharp(buf)
    .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 80, progressive: true })
    .toFile(outPath);
  return `/img/species/${artId}.jpg`;
}

async function scrapeOne(page, species, opts) {
  const url = `${PAGE_BASE}/${species.artId}`;
  await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });
  await page.waitForSelector("#beskrivelse, #fakta", { timeout: NAV_TIMEOUT }).catch(() => {});

  const data = await extractFromPage(page);

  let localImage = null;
  if (!opts.skipImages && data.heroImage) {
    try {
      localImage = await downloadAndStoreImage(data.heroImage, species.artId, opts.force);
    } catch (err) {
      console.warn(`  image fail ${species.artId}: ${err.message}`);
    }
  }

  return {
    artId: species.artId,
    name: species.name || data.headerName,
    latin: species.latin,
    description: data.description,
    habitat: data.habitat,
    diet: data.diet,
    population: data.population,
    protection: data.protection,
    breeding: data.breeding,
    more: data.more,
    facts: data.facts,
    image: localImage,
    sourceUrl: url,
    sourceHeroImage: data.heroImage,
    galleryImages: data.galleryImages,
    scrapedAt: new Date().toISOString(),
  };
}

async function main() {
  const opts = parseArgs();
  const browser = await puppeteer.launch({ headless: "new" });
  const all = await loadSpeciesList(browser);
  let species = all;
  if (opts.only) species = species.filter((s) => s.artId === opts.only);
  if (opts.limit) species = species.slice(0, opts.limit);
  console.log(`Scraping ${species.length} of ${all.length} species`);

  const existing = readExistingFacts();

  let done = 0;
  const concurrency = Math.max(1, Math.min(opts.concurrency, 5));
  const queue = [...species];

  async function worker() {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    page.setDefaultTimeout(NAV_TIMEOUT);
    // Reduce noise: block fonts/analytics
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const rType = req.resourceType();
      if (rType === "font" || rType === "media") return req.abort();
      const u = req.url();
      if (u.includes("googletagmanager") || u.includes("google-analytics")) return req.abort();
      req.continue();
    });

    while (queue.length) {
      const s = queue.shift();
      if (!s) break;
      try {
        const record = await scrapeOne(page, s, opts);
        existing[s.artId] = record;
        done += 1;
        console.log(`[${done}/${species.length}] ${s.artId} ${record.name} — ${record.description ? "✓" : "no desc"}`);
        if (done % 10 === 0) writeFacts(existing);
      } catch (err) {
        console.warn(`! ${s.artId} ${s.name}: ${err.message}`);
      }
    }
    await page.close();
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  writeFacts(existing);
  await browser.close();
  await db.close();
  console.log(`Done. ${Object.keys(existing).length} records in ${OUT_JSON}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
