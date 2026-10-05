# Necro

Every hour, $NECRO holders vote on ten dead Robinhood Chain coins. At the top of the hour, the pump bot spends that hour's fees buying the winner back from the grave.

```
server/public/index.html   The website. The server hosts it, so the site and the API share one address
server/src/                The server: graveyard scanner, hourly rounds, voting, pump bot, API
server/test/               Tests for every rule (run: npm test)
```

## How it works (rules the code enforces)

| Piece | What it does |
|---|---|
| **Scanner** | Reads every coin launched on pons (both factories) and every swap in its locked Uniswap v3 pool. Builds hourly price candles, so it knows each coin's peak, current price and trading activity |
| **Graveyard** | A coin is buried when it peaked above $10K, fell 90%+ from that peak, and traded less than 0.05 ETH in the last 24 hours |
| **Revivable** | A buried coin makes the ballot only if: at least 0.05 ETH is left in its pool, the dev holds under 2%, a test sale quotes back to ETH, it has been dead 7+ days, and it wasn't pumped in the last 24 hours |
| **Revival score** | Out of 100: liquidity 30, holders 25, dev wallet 20, time buried 15, recent activity 10. The top 10 make the ballot |
| **Rounds** | A new round opens every hour at :00. Voting closes at :50 and the winner locks |
| **Votes** | Free. Voters sign a message with their wallet, no gas. Weight = $NECRO held at the :00 snapshot. Before $NECRO launches it runs in practice mode: one wallet, one vote. Ties go to the higher revival score. No votes: the top score wins |
| **Pump** | At the next :00 the bot splits the hour's fund into 5 buys, one a minute, through the Uniswap router |
| **After the buy** | `AFTER_BUY=burn` sends the coins to the dead address. `AFTER_BUY=hold` keeps them in the pump wallet |

All rule numbers are settings (see `server/.env.example`). The rule math lives in `server/src/rules.ts`.

## Safety built in

- **Small hot wallet.** Only the pump wallet's key lives on the server. The Necro dev wallet's key never does. You send fees from the Necro dev wallet to the pump wallet; the bot can only spend what's in it.
- **Off switch.** No buy is ever sent unless `PUMPS_ENABLED=1`.
- **Caps.** At most `MAX_PUMP_ETH` per hour and `DAILY_PUMP_CAP_ETH` per UTC day. A gas reserve always stays behind.
- **Slippage guard.** Each buy takes a fresh quote and refuses to fill more than 3% worse (`MAX_SLIPPAGE_BPS`).
- **No double buys.** Every buy's tx hash is saved before waiting. After a restart the bot checks the chain instead of resending. A buy that fails 3 times is flagged and you get an alert.
- **Missed hours roll over.** If the server was down at pump time, that round is skipped and the ETH stays for the next one.
- **Vote snapshot.** Weight comes from balances at :00, so buying mid-round can't swing the vote.
- **/api/status** shows every setting as set or MISSING.

## Hosting (Railway)

1. New project from the GitHub repo, **Root Directory** `/server`.
2. Attach a **volume** at `/data` and set `DB_PATH=/data/necro.db`.
3. **Generate Domain**, then open `/api/status`.

The first full scan of every pons coin takes a while (minutes to an hour, depending on the RPC). The ballot fills in once the graveyard has revivable coins.

## Going live

1. Make a brand-new **pump wallet**. Put its secret key in Railway as `PUMP_PRIVATE_KEY`.
2. Launch $NECRO on pons. Set `NECRO_TOKEN` and `NECRO_START_BLOCK`.
3. Decide `AFTER_BUY` (`burn` or `hold`).
4. Send a small amount of ETH to the pump wallet and set `PUMPS_ENABLED=1`. Watch one round's buys on the explorer.
5. Point your creator-fee claims at the pump wallet.

Stuck buy? Check it on the explorer first, then: `npm run retry -- <roundId>`.
