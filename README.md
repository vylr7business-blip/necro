# Afterlife

Every hour, $AFTER holders vote on ten dead pump.fun coins. At the top of the hour, the pump bot spends that hour's creator fees buying the winner through Jupiter, then burns what it bought on-chain.

```
server/public/index.html   The website (served by the server, same address as the API)
server/src/                pump.fun sync, graveyard, hourly rounds, voting, pump bot, API
server/test/               Tests for every rule (npm test)
```

## Rules the code enforces

| Piece | What it does |
|---|---|
| **Coins** | Only pump.fun coins that **bonded** (`complete`), pulled from pump.fun's API across several sort orders |
| **Dead** | All-time high (from pump.fun) above $60K, now 90%+ below it, under $2K traded in 24h (DexScreener) |
| **Revivable** | At least 1 SOL left in its PumpSwap pool, creator holds under 2%, ATH at least 7 days ago, not pumped in 24h |
| **Score** | Liquidity 35, how big it got 25, dev wallet 20, time buried 10, recent activity 10. Top 10 make the ballot |
| **Rounds** | Open at :00, voting closes at :50, pump at the next :00 |
| **Votes** | Free (Phantom/Solflare sign a message). Weight = $AFTER held when voting, re-checked at :50; the smaller number counts |
| **Pump** | The hour's fund in 5 Jupiter buys a minute apart, then an on-chain burn of everything bought (`AFTER_BUY=burn`) |

## Safety

- Only the small pump wallet's key is on the server. The dev wallet's key never is.
- No buys unless `PUMPS_ENABLED=1`, and never in practice rounds.
- At most `MAX_PUMP_SOL` an hour and `DAILY_PUMP_CAP_SOL` a day; `SOL_RESERVE` always stays for fees.
- Every buy's signature is saved before it's sent. After a restart the bot checks the chain; a buy that never landed is only retried once its blockhash has expired, so nothing is bought twice.
- `/api/status` shows every setting as set or MISSING.

## Setup (Railway)

Same project as before. Variables: `SOLANA_RPC_URL` (Helius), `DB_PATH=/data/afterlife.db`, `PUMP_PRIVATE_KEY` (new Phantom wallet), `AFTER_BUY=burn`. After launching $AFTER on pump.fun: `DEV_WALLET`, `AFTER_MINT`. Then fund the pump wallet with a little SOL and set `PUMPS_ENABLED=1`.
