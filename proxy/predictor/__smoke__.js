// Smoke test for predictor. Requires DATABASE_URL pointed at a populated DB.
//   node proxy/predictor/__smoke__.js day
//   node proxy/predictor/__smoke__.js calendar 2026-06
//
// Prints top candidate clusters; does NOT call the LLM.

const db = require("../db");
const predictor = require(".");

async function main() {
  if (!db.isEnabled()) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const mode = process.argv[2] || "day";

  const { rows: latinRows } = await db.query(
    `SELECT DISTINCT latin FROM observations
      WHERE obs_date >= current_date - interval '365 days'
      LIMIT 30`
  );
  const missingBirds = latinRows.map((r) => ({ latin: r.latin, name: r.latin }));
  console.log(`smoke: ${missingBirds.length} synthetic missing species`);

  if (mode === "day") {
    const out = await predictor.rankForDay({
      lat: 55.6761,
      lng: 12.5683,
      missingBirds,
      today: new Date(),
    });
    console.log(`day items: ${out.items.length}`);
    for (const it of out.items.slice(0, 8)) {
      console.log(
        `  ${it.band}  ${it.scoreNorm.toFixed(2)}  ${it.species} @ ${it.cluster.name}` +
        ` (+${it.cluster.nearby.length} naerliggende, ${it.evidence.length} evidens)`
      );
    }
  } else if (mode === "calendar") {
    const month = process.argv[3] || new Date().toISOString().slice(0, 7);
    const out = await predictor.rankForCalendar({ month, missingBirds });
    console.log(`calendar items for ${month}: ${out.items.length}`);
    for (const it of out.items.slice(0, 6)) {
      console.log(
        `  score=${it.score.toFixed(2)}  ${it.cluster.name}` +
        ` — ${it.species.length} arter (+${it.cluster.nearby.length} naerliggende)`
      );
      for (const s of it.species.slice(0, 4)) {
        console.log(`      - ${s.band || "?"}  ${s.species}  (${s.evidence.length} evidens)`);
      }
    }
  } else {
    console.error("usage: __smoke__.js day | calendar YYYY-MM");
    process.exit(1);
  }

  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
