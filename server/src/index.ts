import { CONFIG } from "./config.js";
import { openDb } from "./db.js";
import { createApi } from "./api.js";
import { startScanner } from "./scanner.js";
import { startGraves } from "./graves.js";
import { startRounds } from "./rounds.js";
import { startPump } from "./pump.js";
import { startGecko } from "./gecko.js";
import { ethUsd } from "./prices.js";

// Modes: "api" (website + API), "worker" (scanner, graveyard, rounds, pump bot), "all" (both, one process).
const mode = process.argv[2] ?? "all";
const db = openDb(CONFIG.dbPath);

if (mode === "api" || mode === "all") {
  createApi(db).listen(CONFIG.port, () => console.log(`[api] Necro on :${CONFIG.port}`));
}
if (mode === "worker" || mode === "all") {
  startScanner(db);
  startGecko(db, ethUsd);
  startGraves(db);
  startRounds(db);
  startPump(db);
  console.log(`[worker] scanner, graveyard, rounds and pump bot running (pumps ${CONFIG.pumpsEnabled ? "ON" : "off"}, after buy: ${CONFIG.afterBuy})`);
}
