const fs = require("fs");
const path = require("path");
const db = require("./index");

async function runMigrations() {
  if (!db.isEnabled()) {
    console.log("⚠️  DATABASE_URL not set — skipping migrations (in-memory mode)");
    return false;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const { rows } = await db.query(`SELECT 1 FROM _migrations WHERE name = $1`, [file]);
    if (rows.length) continue;

    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const isOptional = file.includes("azure_ai");

    try {
      await db.query(sql);
      await db.query(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
      console.log(`✅ migration ${file}`);
    } catch (err) {
      if (isOptional) {
        console.log(`⏭️  migration ${file} skipped (${err.message.split("\n")[0]})`);
      } else {
        console.error(`❌ migration ${file} failed:`, err.message);
        throw err;
      }
    }
  }
  return true;
}

module.exports = { runMigrations };
