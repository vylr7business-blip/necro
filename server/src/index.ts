import { CONFIG } from "./config.js";
import { openDb } from "./db.js";
import { createApi } from "./api.js";
import { startPumpFun } from "./pumpfun.js";
import { startGraves } from "./graves.js";
import { startRounds } from "./rounds.js";
import { startPump } from "./pump.js";
import { tokenBalance } from "./solana.js";

// Modes: "api" (website + API), "worker" (pump.fun sync, graveyard, rounds, pump bot), "all" (both, one process).
const mode = process.argv[2] ?? "all";
const db = openDb(CONFIG.dbPath);

if (mode === "api" || mode === "all") {
  createApi(db).listen(CONFIG.port, () => console.log(`[api] Afterlife on :${CONFIG.port}`));
}
if (mode === "worker" || mode === "all") {
  startPumpFun(db);
  startGraves(db);
  startRounds(db, (a) => (CONFIG.afterMint ? tokenBalance(a, CONFIG.afterMint) : Promise.resolve(1n)));
  startPump(db);
  console.log(`[worker] pump.fun sync, graveyard, rounds and pump bot running (pumps ${CONFIG.pumpsEnabled ? "ON" : "off"}, after buy: ${CONFIG.afterBuy})`);
}
