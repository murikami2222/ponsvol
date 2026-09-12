# Pons V2 testnet deployment — progress log

Goal: deploy the full Pons V2 launchpad stack to Robinhood Chain TESTNET (46630) from verified sources, then rewire ponsvol lab to testnet. No git commits.

## A. Compile — DONE (2026-09-12)

- Sources extracted verbatim from `/tmp/factory_ver.json` (87 files) into `ponsvol/deploy/contracts/` preserving paths.
- `PonsV2FeeEscrow` was NOT in the factory bundle (factory only needs the interface). Concrete implementation recovered from eth-bytecode-db (FULL match, mainnet escrow `0xd3AFEB2a...Ac9e`) → `contracts/src/v2/PonsV2FeeEscrow.sol`. No constructor args.
- `ponsvol/deploy/hardhat.config.js`: solc 0.8.35, optimizer 200, evm cancun, viaIR TRUE (the verified build used viaIR — found in compiler_settings), metadata ipfs.
- Import prefixes resolved via `deploy/node_modules` symlinks → `contracts/lib/*` + minimal `package.json` manifests added to lib roots (extra files only, sources untouched). `paths.sources = ./contracts/src` so lib files are never compilation roots (avoids HH415 dual-source-name clash on permit2).
- `hardhat compile` GREEN: 88 files, evm cancun.
- Bytecode parity check vs mainnet factory verified build: initcode byte-identical except the 34-byte ipfs metadata hash (source-name scheme differs: npm-style vs foundry paths). Runtime length identical (24,177 B); divergence only at baked immutable slots (expected — mainnet has its own dependency addresses). Code logic = exact match.
- Old fork config `ponsvol/hardhat.config.cjs` DELETED.

## Mainnet mirror reads (Alchemy mainnet, factory 0x7ed598...ec7e)

- owner = launchForwarder(target n/a) — owner `0x263ed295...`, launchForwarder `0xe33E9E47...`, launchEnabled true
- launchFee = 500000000000000 (0.0005 ETH)
- getLaunchConfig(0) = supply 1e27, curveFeeBps 100, phantomQuote 1.68e18, graduationThreshold 4.2e18, poolFee 0, tickSpacing 200, enabled true
- pairTokenEconomics(0x0): REVERTS/empty BY DESIGN — `_launchToken` takes native-quote economics from the LaunchConfig itself; `setPairTokenEconomics` reverts on address(0); `approvedPairTokens[0x0]` is not consulted for native launches. => no pair-token wiring needed for native ETH launches.
- hook defaults: protocolFeeShareBps 3000, buybackBurnBps 5000, hookFeeBps 100, maxInternalPriceImpactBps 300; protocolFeeRecipient = owner.
- vault.feePolicy = memeHook; hook/locker/vault all have one-time `setFactory`; hook also one-time `setBuybackVault`.

## Deploy plan (B)

Order: locker(owner, positionManager) → feeEscrow() → memeHook via CREATE2 (mined salt, flags low-14 = 0x2044 = beforeInitialize|afterSwap|afterSwapReturnDelta; ctor(poolManager, escrow, protocolFeeRecipient=deployer, owner=deployer)) → buybackVault(owner, feePolicy=hook, escrow) → factory(owner, poolManager, positionManager, permit2, locker, hook, escrow, vault, 0.0005e18) → launchDeployer(factory) → graduationExecutor(positionManager, permit2, locker, factory).

Wiring (C): hook.setFactory + setBuybackVault; locker.setFactory; vault.setFactory; factory.setLaunchDeployer; factory.setGraduationExecutor; factory.setLaunchForwarder(deployer); factory.setLaunchEnabled(true); factory.addLaunchConfig(mirror config-0). Re-read after each.

Testnet singletons (bytecode-verified earlier): PoolManager 0x8366a39cc670b4001a1121b8f6a443a643e40951, PositionManager 0x58daec3116aae6D93017bAAea7749052E8a04fA7, Permit2 0x000000000022D473030F116dDEE9F6B43aC78BA3, CREATE2 deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C (present on testnet).

Deployer: 0x7C5A10028a80d8b337E8637D01ecFA8014095e4d (~0.2526 ETH, nonce 1045). Gas 0.01 gwei.

## Status

- [x] A compile green
- [x] B deploys
- [x] C wiring
- [x] D launch + buy/sell proof
- [x] E engine/server/run.sh rewire
- [x] F end-to-end bot run
- [x] G screenshots
- [x] H restart-resume
- [x] I cleanup

## B. Deploys — DONE (2026-09-12, testnet 46630)

All from 0x7C5A10028a80d8b337E8637D01ecFA8014095e4d, legacy-priced (gasPrice 0.01 gwei), node-estimated gas (Orbit intrinsic > 21000 — never hardcode gasLimit). Gas probe tx 0x90c9e936…413c (25,069 gas). Total deploy gas 18.87M ≈ 0.00019 ETH (cap was 0.15).

| contract | address | creation tx |
|---|---|---|
| PonsV2LaunchLocker | 0x1322BEad2Fc68405c47cF0daf5a34704b5241A26 | 0x0d9beeda…989c62 |
| PonsV2FeeEscrow | 0xdB186a1Db464144F825DC76B228Aff0C3CB39BEa | 0x64ac796d…b8bf48 |
| PonsV2MemeHook | 0xf71276B7A3356bFDA33Ab158F01b614A9843a044 | 0xfe9710b0…342322 (CREATE2 via 0x4e59…, salt 0x…1ec2, 7,875 iterations; low-14 bits 0x2044 ✓) |
| PonsV2BuybackVault | 0xDCBd0B6E49C6A28403328661b26D85A8255B8155 | 0xfd25cd4e…59594 |
| PonsV2LaunchFactory | 0xcdaf36FD8EBB4D5A4fD7b5BD003B229f1267B39C | 0xd49fe991…75e1bf |
| PonsV2LaunchDeployer | 0xD53DDd8b90F0C5977e650a2Fb53C0D749aCE7Ced | 0x360f7c01…0400c32c |
| PonsV2GraduationExecutor | 0x368C09A4474270e30113587789ee302B8399c513 | 0x4c22f96c…7eaa1c0 |

deploy.js is resumable (skips steps whose recorded address still has code).

## C. Wiring — DONE (2026-09-12)

All setters verified by on-chain re-read (txs in deployed.json "wiring"):
hook.setFactory 0xb3680858…efcc6; hook.setBuybackVault 0x8f9d29b4…0df670; locker.setFactory 0x1a911da6…3bbe00; vault.setFactory 0xf4a40394…66af18; factory.setLaunchDeployer 0xa5084a2d…084a8a; factory.setGraduationExecutor 0x797f1fa0…bccc9bd; factory.setLaunchForwarder(deployer) 0xa3d20e2d…2dbdab; factory.setLaunchEnabled(true) 0xf9a6513a…4dc153; factory.addLaunchConfig(mirror) 0x30c26a7c…ee9e60c.
Readback: config0 = supply 1e27 / fee 100bps / phantom 1.68 / threshold 4.2 / poolFee 0 / tick 200 / enabled ✓; launchFee 0.0005 ETH ✓; canLaunch(deployer) ✓. No pairToken calls — native-quote economics come from LaunchConfig by design (verified in source + mainnet approvedPairTokens(0x0)=false).

## D. Launch + trade proof — DONE (2026-09-12)

- launchTokenFor(from deployer=forwarder, configId 0, pairToken 0x0, creatorTaxBps 200, buyback off, fee 0.0005 ETH): tx 0x0bb77d63ebbe5f0aab55483510b71eef43d4617b6fd9841f1d060f373ac72475 (block 117928941, gas 3,499,398)
- token 0x6bF1b8c887693DA370A76989DE4182537d8571aF, curve 0x96e5134B0cd62611965f270416E08BE867291535, threshold 4.2 ETH
- BUY: curve.buy(0.01 ETH) tx 0x103b3c245942d4d6de74c838aa60f7c40e8bdd6fa5ccec92e39213b71052958c → −0.0100015 ETH (incl gas), +5,740,664.0232 TESTVOL
- approve tx 0xf4025f10a20915db2e3a1f659d2ffb566ed80b096ac54188bd3bde3271d2b97f
- SELL: curve.sell(5740664.02…) tx 0x2aba709b637106c1b2464cc53998cab0f7f8e9f5844212d39e62332fc0314237 → −all tokens, +0.0094081 ETH (round-trip cost ≈3%: 1% curve fee + 2% creator tax, as designed)
- state.json seeded (launched + curveAbi) so the engine resumes this token.

## E. Engine/server/run.sh rewire — DONE (2026-09-12)

- `engine.js` rewritten: no spawn/anvil/impersonate/setBalance/evm_mine anywhere. `connect()` dials RPC_URL (default `https://rpc.testnet.chain.robinhood.com`), chain-id-asserts 46630. Factory address+ABI loaded from `deployed.json` + `deploy/artifacts`. Master wallet read from `projectX/testnet.wallet.json` at runtime (key never written anywhere).
- Real signed `launchTokenFor` (no impersonation); `createWallets` funds 0.005 ETH/wallet via real txs; MIN_TRADE_ETH=0.0005 (env-overridable). `reset()` wipes state AND auto-launches a fresh token. Lab launches appended to `deployed.json.labLaunches`. Snapshot keeps `anvilUp` key for the unchanged UI — now means "testnet reachable".
- `server.js`: no Alchemy requirement; `engine.connect()`; `/api/trade_once` accepts `{"direction":"sell"}` (organic engine sells don't fire at 0.005-ETH wallet scale due to portfolio hysteresis — this is the sanctioned sell path alongside `force_sell.js`).
- `run.sh`: cd + .env + port guard + `exec node server.js`, VOL_FAST=1 default. `force_sell.js` recreated as standalone multi-wallet seller. `state.json` sanitized (fork wallets/history dropped, TESTVOL launch kept).

## F. End-to-end bot run — DONE (2026-09-12)

- `bash run.sh` boot resumed the SAME token (no relaunch); 10 wallets funded 0.005 ETH each (0.05 ETH total, real testnet txs).
- ~10 min run: 26 engine trades, ≈0.0263 ETH volume. BUYs organic; SELLs via 3× `/api/trade_once {"direction":"sell"}` (engine-logged, e.g. 0x99994bdb9a…979f6, 0x3035b96ca2…, 0x1175d5ad3e…) + one `force_sell.js` round (7 wallet sells). Price tracked 1.680e-9 → 1.706e-9.
- `/api/launch` idempotent-skip verified.

## G. Screenshots — DONE (2026-09-12)

- `output/ponsvol_ui/ui_idle.png` (bots stopped) and `output/ponsvol_ui/ui_midrun.png` (bots running) via `ponsvol/shot.py` (`wait_until="load"` — networkidle never settles, UI polls every 2s). Chart, green/red volume bars, wallet table, log, progress bar all live.
- NOTE: UI header text still literally says "robinhood-chain fork" / "FORKVOL price" / "anvil: up" — hardcoded strings in `public/index.html`, intentionally untouched per brief (UI unchanged).

## H. Restart-resume — DONE (2026-09-12)

- `pkill -f "node server.js"` → `bash run.sh`: reconnects, log line "launched token 0x6bF1b8c8… verified on testnet — resuming without relaunch", ZERO LAUNCHED lines, wallets=10 and totals (0.0263 ETH volume) preserved. Post-restart bot trade confirmed (BUY 0xaa7f8f740c… 07:41:55).

## I. Cleanup — DONE (2026-09-12)

- Deleted `ponsvol/cache/hardhat-network-fork/` (fork leftover) + emptied `cache/`. No `fork-dump.json` exists; `debug_launch.js`/`fork_proxy.js` absent.
- Grep for 8545/anvil/alchemy/fork across engine.js/server.js/run.sh/force_sell.js/shot.py/package.json: ONE hit — `engine.js:631` comment explaining the UI-compat `anvilUp` key (intentional).
- `.env` still contains a stale `ALCHEMY_API_KEY=` line — nothing reads it anymore (gitignored, left in place; safe to delete manually).
- `public/` untouched per brief.

## Leftovers / honest caveats

- Organic engine SELLs don't fire at this wallet scale (hysteresis): sells come from `/api/trade_once {"direction":"sell"}` or `node force_sell.js`.
- graduate()/createGraduatedPool UNTESTED (needs 4.2 ETH raised) — deliberately out of scope.
- UX: `cd ponsvol && bash run.sh` → http://127.0.0.1:8577 ; stop `pkill -f "node server.js"` ; `VOL_FAST=0 bash run.sh` for normal cadence.
- Master spend this session ≈0.0023 ETH (deploys+wiring+launch+proof) + 0.05 ETH bot funding; ≈0.20 ETH remains.
