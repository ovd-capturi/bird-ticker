const db = require("./db");

let aborted = false;
let running = false;

function abort() {
  aborted = true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function enumerateDates(start, end) {
  const out = [];
  const d = new Date(Date.UTC(
    start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()
  ));
  const stop = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (d.getTime() <= stop) {
    out.push(isoDate(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function runBackfill({
  years = 3,
  fetchOne,
  baseDelayMs = 2000,
  jitterMs = 750,
  log = console.log,
} = {}) {
  if (running) {
    log("backfill: already running, skipping");
    return;
  }
  if (!db.isEnabled()) {
    log("backfill: DB not configured, skipping");
    return;
  }
  if (typeof fetchOne !== "function") {
    throw new Error("backfill: fetchOne(date) required");
  }
  running = true;
  aborted = false;

  try {
    const today = new Date();
    const yesterday = new Date(today); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const start = new Date(today); start.setUTCFullYear(start.getUTCFullYear() - years);

    const startStr = isoDate(start);
    const endStr = isoDate(yesterday);
    const scraped = await db.getDatesWithScrape(startStr, endStr);
    const all = enumerateDates(start, yesterday);
    const missing = all.filter((d) => !scraped.has(d));

    log(`backfill: ${missing.length}/${all.length} dates to fetch (${startStr} → ${endStr})`);
    if (!missing.length) return;

    let consecutiveFailures = 0;
    let processed = 0;
    const startedAt = Date.now();

    for (const date of missing) {
      if (aborted) {
        log(`backfill: aborted after ${processed} dates`);
        return;
      }
      try {
        await fetchOne(date);
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        log(`backfill ${date} failed: ${err.message}`);
        if (consecutiveFailures >= 20) {
          log(`backfill: aborting after ${consecutiveFailures} consecutive failures (DOFbasen blocking?)`);
          return;
        }
        if (consecutiveFailures >= 5) {
          const backoffMs = Math.min(60000, 5000 * 2 ** (consecutiveFailures - 5));
          log(`backfill: backing off ${Math.round(backoffMs / 1000)}s after ${consecutiveFailures} consecutive failures`);
          await sleep(backoffMs);
        }
      }
      processed += 1;
      if (processed % 50 === 0) {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        log(`backfill: ${processed}/${missing.length} done (${elapsedSec}s elapsed)`);
      }
      await sleep(baseDelayMs + Math.random() * jitterMs);
    }

    log(`backfill: complete — processed ${processed} dates in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } finally {
    running = false;
  }
}

module.exports = { runBackfill, abort };
