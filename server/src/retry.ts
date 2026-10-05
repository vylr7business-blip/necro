// Put a stuck pump back in line after you've checked it on Solscan.
// Usage: npm run retry -- <roundId>
import { CONFIG } from "./config.js";
import { openDb, tx } from "./db.js";

const id = Number(process.argv[2]);
if (!Number.isInteger(id)) { console.error("Usage: npm run retry -- <roundId>"); process.exit(1); }
const db = openDb(CONFIG.dbPath);
const changed = tx(db, () => {
  const n = db.prepare("UPDATE pump_legs SET status = 'pending', attempts = 0, last_error = NULL, sig = NULL, due_at = ? WHERE round_id = ? AND status = 'failed'").run(Date.now(), id).changes;
  if (n) db.prepare("UPDATE rounds SET pump_status = 'pending' WHERE id = ?").run(id);
  return n;
});
console.log(`Round ${id}: ${changed} buy(s) back in line.`);
