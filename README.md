# ponsvol

Pons V2 volume lab on Robinhood Chain **testnet 46630** — deploys the full Pons V2
launchpad stack and runs a swarm of persona trading bots against a launched token's
bonding curve, with a local web UI (buttons + live price/volume chart).

Built to test reward-payout protocol behavior against realistic on-chain volume.

## Run

```bash
cd ponsvol && bash run.sh
# UI → http://127.0.0.1:8577
```

Requires a testnet wallet JSON with a `privateKey` field (set `PONSVOL_WALLET_JSON`,
default path is hardcoded for the author's machine). Stop with `pkill -f "node server.js"`.

## What's inside

- `engine.js` — swarm engine: 22 named characters with lore/traits (`characters.js`),
  momentum-driven fomo/panic on top of allocation drift, moonbag floors, raid events,
  per-wallet trade floors so micro-funded wallets trade micro lots.
- `mixer.js` — funding privacy. `StealthMixer`: master → one-time hop → bot (jittered
  amounts + randomized delays), mirrored on consolidate; group-hop batch mode funds
  100 wallets in ~7 minutes. Hop keys persist in `state.json` so funds never strand
  (`/api/sweep_hops` recovers dust). `HoudiniClient`: wired-but-dormant real Houdini
  Swap partner API client (mainnet chains only — it cannot see testnet 46630).
- `deploy/` — the Pons V2 launchpad contracts (source from the verified Blockscout
  bundle, solc 0.8.35 cancun) + deploy script. Deployed stack addresses in
  `deployed.json`.

## Notes

- Curve ABI (probed live, documented nowhere else): `buy(uint256,uint256,address)`
  payable, `sell(uint256,uint256,address)`, views `getReserves()` /
  `realQuoteReserve()` (0 on a fresh curve — phantom-quote pricing).
- Round-trip cost is ~3%: 1% curve fee + 2% creator tax.
- `.env`, `state.json` (bot keys), `node_modules/`, build artifacts are gitignored.
  Never commit keys.
