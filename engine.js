"use strict";
// Volume-lab engine: Robinhood Chain TESTNET (46630) edition.
// No chain-node lifecycle — the lab runs against the public testnet RPC and the
// Pons V2 stack deployed by deploy/ (addresses come from deployed.json).
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const { pickCharacter, chatter } = require("./characters.js");
const { HoudiniClient, StealthMixer } = require("./mixer.js");

const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID = 46630;
const STATE_FILE = path.join(__dirname, "state.json");
const DEPLOYED_FILE = path.join(__dirname, "deployed.json");
const FACTORY_ARTIFACT = path.join(__dirname, "deploy", "artifacts", "contracts", "src", "v2", "PonsV2LaunchFactory.sol", "PonsV2LaunchFactory.json");
const WALLET_JSON = process.env.PONSVOL_WALLET_JSON || "/Users/addminus/minimaxh3/projectX/testnet.wallet.json";
const HISTORY_CAP = 1000;
const MIN_TRADE_ETH = Number(process.env.VOL_MIN_TRADE || 0.0005); // testnet-scale trade floor
const WALLET_FUND_ETH = Number(process.env.VOL_WALLET_FUND || 0.005); // per-bot funding from master
const STEALTH_FUND = process.env.VOL_STEALTH === "1"; // default funding privacy mode
const LAUNCH_NAME = "Testnet Volume";
const LAUNCH_SYMBOL = "TESTVOL";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
// Discovered PonsV2BondingCurve interface (verified against contracts/src/v2/PonsV2BondingCurve.sol):
// buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable — quoteIn must equal msg.value
// sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
const BUY_CANDIDATES = ["buy(uint256,uint256,address)", "buy(uint256)", "buy(uint256,uint256)", "buy()", "buy(uint256,address)", "swapETHForTokens(uint256)"];
const SELL_CANDIDATES = ["sell(uint256,uint256,address)", "sell(uint256,uint256)", "sell(uint256)", "sell(uint256,uint256,uint256)"];
const VIEW_CANDIDATES = ["getReserves()", "realQuoteReserve()", "pricePerToken()", "ethRaised()", "graduated()"];

const PERSONAS = {
  degen:  { weight: 0.25, alloc: 0.55, tradeFrac: 0.55, sessionTrades: [3, 8], thinkTime: [4, 20],   cadenceMin: [2, 12],  sigma: 0.9 },
  dca:    { weight: 0.30, alloc: 0.35, tradeFrac: 0.20, sessionTrades: [1, 3], thinkTime: [10, 60],  cadenceMin: [20, 72], sigma: 0.3 },
  swing:  { weight: 0.25, alloc: 0.50, tradeFrac: 0.45, sessionTrades: [2, 5], thinkTime: [8, 40],   cadenceMin: [8, 36],  sigma: 0.6 },
  ghost:  { weight: 0.15, alloc: 0.20, tradeFrac: 0.15, sessionTrades: [1, 2], thinkTime: [15, 60],  cadenceMin: [30, 72], sigma: 0.4 },
  whale:  { weight: 0.05, alloc: 0.60, tradeFrac: 0.80, sessionTrades: [1, 4], thinkTime: [6, 30],   cadenceMin: [10, 48], sigma: 0.7 },
};
const FAST = process.env.VOL_FAST === "1";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randn() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function lognormal(sigma) { return Math.exp(sigma * randn() - (sigma * sigma) / 2); }
function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function randRange(lo, hi) { return lo + Math.random() * (hi - lo); }
function atomicWrite(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

class Engine {
  constructor() {
    this.provider = null;
    this.factory = null;
    this.running = false;
    this.stopRequested = false;
    this.loopTimer = null;
    this.logBuf = [];
    this.state = { launched: null, curveAbi: null, wallets: [], history: [], config: { allowGraduation: false, stealthFund: STEALTH_FUND }, totals: { volumeEth: 0, tradeCount: 0 } };
    this.graduatedFlag = false;
    this.busyTrade = false;
    this.houdini = new HoudiniClient((m) => this.log(m));
    if (fs.existsSync(STATE_FILE)) {
      try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; }
      catch (e) { this.log(`state.json unreadable, starting fresh: ${e.message}`); }
    }
    // sessions killed mid-flight persist busy:true; clear so the loop picks wallets up again
    for (const w of this.state.wallets) { w.busy = false; w.nextWake = 0; }
    this.state.config = { allowGraduation: false, stealthFund: STEALTH_FUND, ...(this.state.config || {}) };
  }

  stealth() { return new StealthMixer(this, this.state); }

  log(msg) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    console.log(line);
    this.logBuf.push(line);
    if (this.logBuf.length > 200) this.logBuf.splice(0, this.logBuf.length - 200);
  }
  save() { atomicWrite(STATE_FILE, this.state); }

  // ---------- chain connection ----------
  async connect() {
    if (!fs.existsSync(DEPLOYED_FILE)) throw new Error("deployed.json missing — run deploy/deploy.js first");
    this.deployed = JSON.parse(fs.readFileSync(DEPLOYED_FILE, "utf8"));
    const factoryAddr = this.deployed.steps?.factory?.address;
    if (!factoryAddr) throw new Error("deployed.json has no factory address");
    this.provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
    this.provider.pollingInterval = 400;
    const net = await this.provider.getNetwork();
    if (Number(net.chainId) !== CHAIN_ID) throw new Error(`wrong chain: ${net.chainId}`);
    const masterKey = JSON.parse(fs.readFileSync(WALLET_JSON, "utf8")).privateKey;
    if (!masterKey) throw new Error(`privateKey missing in ${WALLET_JSON}`);
    this.master = new ethers.Wallet(masterKey, this.provider);
    const factoryAbi = JSON.parse(fs.readFileSync(FACTORY_ARTIFACT, "utf8")).abi;
    this.factory = new ethers.Contract(factoryAddr, factoryAbi, this.provider);
    this.factoryAddr = factoryAddr;
    const bal = await this.provider.getBalance(this.master.address);
    this.nodeUp = true;
    this.log(`connected to ${RPC_URL} (chain ${net.chainId}); factory ${factoryAddr}`);
    this.log(`master ${this.master.address} balance ${ethers.formatEther(bal)} ETH`);
    await this.verifyOnChain();
  }

  // If our recorded token doesn't exist on this chain, chain-dependent state is
  // worthless — wipe it (relaunch stays manual). On testnet the token persists,
  // so a server restart resumes the SAME token.
  async verifyOnChain() {
    if (!this.state.launched) return;
    try {
      const code = await this.provider.getCode(this.state.launched.token);
      if (code === "0x") throw new Error("token has no code on this chain");
      this.log(`launched token ${this.state.launched.token} verified on testnet — resuming without relaunch`);
    } catch (e) {
      this.log(`launched token missing on chain (${e.message}) — wiping chain state, relaunch manually`);
      this.state.launched = null;
      this.state.curveAbi = null;
      this.state.wallets = [];
      this.state.history = [];
      this.state.totals = { volumeEth: 0, tradeCount: 0 };
      this.save();
    }
  }

  // ---------- launch ----------
  async launch() {
    if (this.state.launched) {
      this.log("token already launched (state.json) — idempotent skip");
      if (!this.state.curveAbi) await this.probeCurve(); // resume a launch whose probe previously failed
      return this.state.launched;
    }
    const owner = await this.factory.owner();
    const forwarder = await this.factory.launchForwarder();
    this.log(`factory owner: ${owner}, launchForwarder: ${forwarder}`);
    if (forwarder.toLowerCase() !== this.master.address.toLowerCase()) {
      throw new Error(`master ${this.master.address} is not the factory launchForwarder (${forwarder})`);
    }

    const count = Number(await this.factory.launchConfigCount());
    this.log(`launch configs: ${count}`);
    let configId = -1, threshold = 0n;
    for (let i = 0; i < count; i++) {
      const c = await this.factory.getLaunchConfig(i);
      this.log(`config ${i}: supply ${c.supply} threshold ${ethers.formatEther(c.graduationThreshold)} ETH fee ${c.poolFee} enabled ${c.enabled}`);
      if (c.enabled && configId < 0) { configId = i; threshold = c.graduationThreshold; }
    }
    if (configId < 0) throw new Error("no enabled launch config");

    const pairToken = ethers.ZeroAddress;
    const expectedEconomics = await this.factory.previewLaunchEconomics(configId, pairToken);
    this.log(`config ${configId} picked, expectedEconomics ${expectedEconomics}`);
    const launchFee = await this.factory.launchFee();
    this.log(`launchFee: ${ethers.formatEther(launchFee)} ETH`);

    const salt = ethers.hexlify(ethers.randomBytes(32));
    const params = {
      name: LAUNCH_NAME, symbol: LAUNCH_SYMBOL, logo: "", description: "ponsvol volume lab (testnet)",
      socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
      creatorFeeRecipient: this.master.address,
      creatorTaxBps: 200, buybackEnabled: false,
      expectedEconomics, salt,
    };
    // master IS the launchForwarder, so it may supply originalDeployer directly
    const tx = await this.factory.connect(this.master).launchTokenFor(params, configId, pairToken, this.master.address, [], { value: launchFee });
    this.log(`launch tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("launch tx reverted");

    let token = null, curve = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.factoryAddr.toLowerCase()) continue;
      try {
        const parsed = this.factory.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.name === "TokenLaunched") { token = String(parsed.args[0]); curve = String(parsed.args[1]); break; }
      } catch (e) { /* not ours */ }
    }
    if (!token) throw new Error("could not parse TokenLaunched event");
    const lt = await this.factory.getLaunchedToken(token);
    if (!lt.exists) throw new Error("getLaunchedToken says token does not exist");
    threshold = lt.graduationThreshold;
    this.state.launched = { token, curve, threshold: threshold.toString(), configId, txHash: receipt.hash, name: LAUNCH_NAME, symbol: LAUNCH_SYMBOL };
    this.save();
    this.log(`LAUNCHED token=${token} curve=${curve} threshold=${ethers.formatEther(threshold)} ETH (tx ${receipt.hash})`);
    // record lab launches alongside the deploy record
    try {
      this.deployed.labLaunches = this.deployed.labLaunches || [];
      this.deployed.labLaunches.push({ token, curve, txHash: receipt.hash, block: receipt.blockNumber, ts: Date.now() });
      atomicWrite(DEPLOYED_FILE, this.deployed);
    } catch (e) { this.log(`deployed.json labLaunches append failed (non-fatal): ${e.message}`); }
    await this.probeCurve();
    return this.state.launched;
  }

  async waitReceipt(txHash, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const rc = await this.provider.getTransactionReceipt(txHash);
      if (rc) return rc;
      await sleep(1000);
    }
    return null;
  }

  // ---------- curve probe ----------
  async probeCurve() {
    const { curve } = this.state.launched;
    const views = {};
    for (const sig of VIEW_CANDIDATES) {
      const data = ethers.id(sig).slice(0, 10);
      try {
        const out = await this.provider.call({ to: curve, data });
        const value = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], out);
        views[sig] = value[0].toString();
        this.log(`curve probe OK: ${sig} -> ${ethers.formatEther(value[0])}`);
      } catch (e) { this.log(`curve probe FAIL: ${sig}`); }
    }
    // buy(uint256 quoteIn, uint256 minTokensOut, address recipient) — quoteIn must EXACTLY equal msg.value.
    // Probe combos to find which uint slot takes the value (eth_call from master, who holds funds).
    const probeVal = ethers.parseEther("0.001");
    const uintCombos = (nUints) => {
      const combos = [Array(nUints).fill(0n)];
      for (let i = 0; i < nUints; i++) { const c = Array(nUints).fill(0n); c[i] = probeVal; combos.push(c); }
      return combos;
    };
    let buySig = null, buyEthPos = 0, buyMinPos = 1;
    outer: for (const sig of BUY_CANDIDATES) {
      const types = this.sigTypes(sig);
      const nUints = types.filter((t) => t === "uint256").length;
      for (const combo of uintCombos(nUints)) {
        try {
          const values = types.map((t) => t === "address" ? this.master.address : combo.shift());
          const data = this.encodeSig(sig, values);
          await this.provider.call({ to: curve, data, value: probeVal, from: this.master.address });
          buySig = sig;
          buyEthPos = values.findIndex((v) => v === probeVal);
          if (buyEthPos < 0) buyEthPos = 0;
          const uintIdx = [];
          types.forEach((t, i) => { if (t === "uint256") uintIdx.push(i); });
          buyMinPos = uintIdx.find((i) => i !== buyEthPos) ?? buyEthPos;
          this.log(`curve probe OK (buy): ${sig} ethPos=${buyEthPos} minPos=${buyMinPos}`);
          break outer;
        } catch (e) { /* next combo */ }
      }
      this.log(`curve probe FAIL (buy): ${sig}`);
    }
    if (!buySig) throw new Error("no buy interface found on curve");

    // real master buy to confirm end-to-end + enable sell probing
    const price = await this.spotPrice();
    const size = ethers.parseEther("0.01");
    const implied = price > 0 ? (Number(ethers.formatEther(size)) / price) : 0;
    const minTokens = implied > 0 ? ethers.parseEther((implied * 0.9).toFixed(18)) : 0n;
    const buyData = this.encodeBuy(buySig, buyEthPos, buyMinPos, size, minTokens, this.master.address);
    const tx = await this.sendTx(this.master, { to: curve, data: buyData, value: size, gasLimit: 500000 });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error("master confirmation buy reverted");
    this.log(`master confirmation buy OK: ${rc.hash} (0.01 ETH)`);

    const token = new ethers.Contract(this.state.launched.token, ERC20_ABI, this.master);
    const apData = token.interface.encodeFunctionData("approve", [curve, ethers.MaxUint256]);
    const ap = await this.sendTx(this.master, { to: this.state.launched.token, data: apData, gasLimit: 500000 });
    await ap.wait();
    this.log("master approved curve for token sells");

    let sellSig = null;
    for (const sig of SELL_CANDIDATES) {
      try {
        let usedTokens = false;
        const values = this.sigTypes(sig).map((t) => {
          if (t === "address") return this.master.address;
          if (!usedTokens) { usedTokens = true; return ethers.parseEther("1"); } // 1 token: above the curve's dust floor
          return 0n; // minQuoteOut = 0
        });
        const data = this.encodeSig(sig, values);
        await this.provider.call({ to: curve, data, from: this.master.address });
        sellSig = sig;
        this.log(`curve probe OK (sell): ${sig}`);
        break;
      } catch (e) { this.log(`curve probe FAIL (sell): ${sig}`); }
    }
    this.state.curveAbi = { buySig, sellSig, buyEthPos, buyMinPos, views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.toString()])) };
    this.save();
    const p = await this.spotPrice();
    this.pushHistory({ ts: Date.now(), price: p, sizeEth: 0.01, direction: "buy", wallet: this.master.address, txHash: rc.hash });
    return this.state.curveAbi;
  }

  sigTypes(sig) {
    const inner = sig.slice(sig.indexOf("(") + 1, sig.lastIndexOf(")"));
    return inner === "" ? [] : inner.split(",");
  }
  encodeSig(sig, values) {
    return ethers.id(sig).slice(0, 10) + ethers.AbiCoder.defaultAbiCoder().encode(this.sigTypes(sig), values).slice(2);
  }
  encodeBuy(sig, ethPos, minPos, sizeWei, minTokens, recipient) {
    return this.encodeSig(sig, this.sigTypes(sig).map((t, i) => {
      if (t === "address") return recipient;
      if (i === ethPos) return sizeWei;
      if (i === minPos) return minTokens;
      return 0n;
    }));
  }
  encodeSell(sig, tokensIn, minEth, recipient) {
    let usedTokens = false;
    return this.encodeSig(sig, this.sigTypes(sig).map((t) => {
      if (t === "address") return recipient;
      if (!usedTokens) { usedTokens = true; return tokensIn; }
      return minEth;
    }));
  }

  // ---------- market reads ----------
  async curveViews() {
    const { curve } = this.state.launched;
    const call = async (sig) => {
      try {
        const out = await this.provider.call({ to: curve, data: ethers.id(sig).slice(0, 10) });
        return ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], out)[0];
      } catch (e) { return null; }
    };
    const reservesOut = await (async () => {
      try {
        const out = await this.provider.call({ to: curve, data: ethers.id("getReserves()").slice(0, 10) });
        return ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], out);
      } catch (e) { return null; }
    })();
    let quoteReserve = null, tokenReserve = null;
    if (reservesOut) { quoteReserve = reservesOut[0]; tokenReserve = reservesOut[1]; }
    return {
      quoteReserve, tokenReserve,
      realQuoteReserve: await call("realQuoteReserve()"),
      ethRaised: await call("ethRaised()"),
      pricePerToken: await call("pricePerToken()"),
    };
  }
  async spotPrice() {
    const v = await this.curveViews();
    if (v.quoteReserve && v.tokenReserve && v.tokenReserve > 0n) return Number(ethers.formatEther(v.quoteReserve)) / Number(ethers.formatEther(v.tokenReserve));
    if (v.pricePerToken) return Number(ethers.formatEther(v.pricePerToken));
    return 0;
  }
  async phase() {
    try { return Number((await this.factory.getLaunchedToken(this.state.launched.token)).phase); }
    catch (e) { return -1; }
  }

  // ---------- wallets ----------
  // Real testnet funding: each bot wallet gets a randomized stake around the requested
  // base (lognormal spread, clamped 0.4x–2.6x) — flat equal amounts are an on-chain fingerprint.
  rollFundAmount(base = WALLET_FUND_ETH) {
    const a = base * lognormal(0.6);
    return Math.min(base * 2.6, Math.max(base * 0.4, a));
  }

  _mkWalletRec(w, fundAmt, fundInfo, usedIds) {
    const c = pickCharacter(usedIds);
    usedIds.add(c.id);
    return {
      address: w.address, privateKey: w.privateKey, persona: c.persona,
      charId: c.id, name: c.name, lore: c.lore,
      allocTarget: Math.min(0.92, Math.max(0.05, c.alloc + randRange(-0.06, 0.06))),
      fomo: c.fomo, panic: c.panic, sizeMul: c.sizeMul, cadenceMul: c.cadenceMul, moonbag: c.moonbag, raid: c.raid || 0,
      lines: { buy: c.buy, sell: c.sell, watch: c.watch },
      allocJitter: randRange(-0.05, 0.05), peakTok: 0,
      volumeEth: 0, buys: 0, sells: 0, nextWake: Date.now() + randInt(0, 5000), busy: false,
      fundedEth: fundAmt, funding: fundInfo,
    };
  }

  // Small creates run synchronously; bigger batches become a background fund job
  // (progress visible in snapshot().fundJob, wallets land in state as they're funded).
  async createWallets(n = 5, fundBase = WALLET_FUND_ETH) {
    if (this.fundJob && this.fundJob.running) throw new Error("a funding job is already running");
    if (n > 5) {
      this.fundJob = { running: true, total: n, done: 0, failed: 0, fundBase, startedTs: Date.now() };
      this._fundBatch(n, fundBase).catch((e) => {
        this.log(`fund job died: ${(e.shortMessage || e.message).slice(0, 120)}`);
        if (this.fundJob) this.fundJob.running = false;
        this.save();
      });
      return { job: this.fundJob };
    }
    const created = await this._fundWalletsSync(n, fundBase);
    return { created };
  }

  async _checkFundable(amounts, headroom) {
    const masterBal = await this.provider.getBalance(this.master.address);
    const need = ethers.parseEther((amounts.reduce((a, b) => a + b, 0) * headroom).toFixed(18));
    if (masterBal < need) throw new Error(`master balance ${ethers.formatEther(masterBal)} ETH too low to fund ${amounts.length} wallets (${ethers.formatEther(need)} ETH needed)`);
  }

  async _fundWalletsSync(n, fundBase) {
    const created = [];
    const stealthOn = !!this.state.config.stealthFund;
    const amounts = Array.from({ length: n }, () => this.rollFundAmount(fundBase));
    await this._checkFundable(amounts, stealthOn ? 1.25 : 1);
    const usedIds = new Set(this.state.wallets.map((r) => r.charId));
    for (let i = 0; i < n; i++) {
      const w = ethers.Wallet.createRandom();
      const fundAmt = amounts[i];
      let fundInfo = null;
      if (stealthOn) {
        const r = await this.stealth().routeFund(this.master, w.address, fundAmt, { hops: 1, jitterPct: 0.2, maxDelaySec: 60, save: () => this.save() });
        fundInfo = { stealth: true, hop: r.hops[0] };
      } else {
        const fundTx = await this.sendTx(this.master, { to: w.address, value: ethers.parseEther(fundAmt.toFixed(18)) });
        await fundTx.wait();
        fundInfo = { stealth: false, txHash: fundTx.hash };
      }
      const rec = this._mkWalletRec(w, fundAmt, fundInfo, usedIds);
      this.state.wallets.push(rec);
      created.push(rec);
      this.log(`funded ${rec.name} (${w.address.slice(0, 10)}…) with ${fundAmt.toFixed(5)} ETH${stealthOn ? ` via stealth hop ${fundInfo.hop.slice(0, 10)}…` : ` (tx ${fundInfo.txHash.slice(0, 14)}…)`}`);
    }
    this.save();
    this.log(`created ${n} wallets (total ${this.state.wallets.length})`);
    return created;
  }

  // Batch: groups of 8. Stealth = one group-hop per 8 wallets (master→hop fan-out,
  // master never sees a bot address); direct = master sends with short spacing.
  async _fundBatch(n, fundBase) {
    const job = this.fundJob;
    const stealthOn = !!this.state.config.stealthFund;
    const GROUP = 8;
    const usedIds = new Set(this.state.wallets.map((r) => r.charId));
    const amounts = Array.from({ length: n }, () => this.rollFundAmount(fundBase));
    await this._checkFundable(amounts, stealthOn ? 1.25 : 1);
    this.log(`fund job started: ${n} wallets @ ~${fundBase} ETH base${stealthOn ? " (stealth group hops)" : ""}`);
    for (let g = 0; g < n; g += GROUP) {
      if (!job.running) { this.log("fund job aborted"); break; }
      const sliceAmt = amounts.slice(g, g + GROUP);
      const news = sliceAmt.map(() => ethers.Wallet.createRandom());
      if (stealthOn) {
        const targets = news.map((w, i) => ({ address: w.address, amountEth: sliceAmt[i] }));
        const r = await this.stealth().routeFundGroup(this.master, targets, { save: () => this.save() });
        news.forEach((w, i) => {
          const rec = this._mkWalletRec(w, sliceAmt[i], { stealth: true, hop: r.hop, group: true }, usedIds);
          this.state.wallets.push(rec);
        });
      } else {
        for (let i = 0; i < news.length; i++) {
          const tx = await this.sendTx(this.master, { to: news[i].address, value: ethers.parseEther(sliceAmt[i].toFixed(18)) });
          await tx.wait();
          this.state.wallets.push(this._mkWalletRec(news[i], sliceAmt[i], { stealth: false, txHash: tx.hash }, usedIds));
          await sleep(randInt(300, 1000));
        }
      }
      job.done = Math.min(n, g + GROUP);
      this.save();
      this.log(`fund job ${job.done}/${n}`);
    }
    job.running = false;
    job.finishedTs = Date.now();
    this.save();
    this.log(`fund job complete: ${job.done} wallets (total ${this.state.wallets.length})`);
  }

  // per-wallet trade floor: micro wallets trade micro lots, the global floor stays for big ones
  tradeFloor(rec) {
    if (!rec || rec.persona === "master") return MIN_TRADE_ETH;
    return Math.max(0.00002, Math.min(MIN_TRADE_ETH, (rec.fundedEth || 0.002) * 0.2));
  }
  walletObj(rec) { return new ethers.Wallet(rec.privateKey, this.provider); }

  // Retry nonce collisions with a fresh query; reverts propagate to the caller.
  async sendTx(wallet, tx, tries = 3) {
    for (let i = 0; i < tries; i++) {
      try { return await wallet.sendTransaction(tx); }
      catch (e) {
        if (/nonce/i.test(e.message) && i < tries - 1) { await sleep(500); continue; }
        throw e;
      }
    }
  }

  // ---------- bot loop ----------
  startBots() {
    if (this.running) return;
    if (!this.state.launched) throw new Error("launch a token first");
    if (!this.state.wallets.length) throw new Error("create wallets first");
    this.running = true;
    this.stopRequested = false;
    this.graduatedFlag = false;
    this.nextRaidAt = Date.now() + (FAST ? 45 : 300) * 1000;
    this.log(`bots started (${this.state.wallets.length} wallets, ${FAST ? "FAST test" : "normal"} cadence)`);
    this.loopTimer = setInterval(() => this.epoch().catch((e) => this.log(`epoch error: ${e.message}`)), 1000);
  }
  async stopBots() {
    this.stopRequested = true;
    this.running = false;
    if (this.loopTimer) { clearInterval(this.loopTimer); this.loopTimer = null; }
    this.log("bots stopping (in-flight sessions finish current trade)");
  }
  // Raid: a leader wallet "calls it" and the high-fomo swarm wakes up to chase.
  maybeRaid(now) {
    if (now < (this.nextRaidAt || 0)) return;
    const leaders = this.state.wallets.filter((w) => (w.raid || 0) > 0.3 && !w.busy);
    if (!leaders.length) { this.nextRaidAt = now + 60_000; return; }
    const leader = leaders[Math.floor(Math.random() * leaders.length)];
    const followers = this.state.wallets.filter((w) => w !== leader && (w.fomo || 0) > 0.4 && !w.busy);
    leader.nextWake = now;
    let joined = 0;
    for (const f of followers) {
      if (Math.random() < 0.8) { f.nextWake = now + randInt(2000, 12000); joined++; }
    }
    this.log(`SIGNAL: ${leader.name} is calling it — ${joined} swarm wallets following`);
    this.nextRaidAt = now + (FAST ? randInt(90, 200) : randInt(600, 1800)) * 1000;
  }

  async epoch() {
    if (!this.running) return;
    const now = Date.now();
    this.maybeRaid(now);
    const order = [...this.state.wallets].sort(() => Math.random() - 0.5); // reshuffle each pass
    for (const rec of order) {
      if (!this.running) break;
      if (rec.busy || now < rec.nextWake) continue;
      rec.busy = true;
      rec.nextWake = now + 365 * 24 * 3600 * 1000; // parked until session ends
      this.runSession(rec).catch((e) => this.log(`session error ${rec.address.slice(0, 8)}: ${e.message}`));
    }
  }
  personaTiming(rec) {
    const mul = rec.cadenceMul || 1;
    if (FAST) return { think: randRange(1, 4) * 1000 * mul, cadence: randRange(10, 30) * 1000 * mul, trades: randInt(2, 6) };
    const p = PERSONAS[rec.persona] || PERSONAS.dca;
    return { think: randRange(p.thinkTime[0], p.thinkTime[1]) * 1000 * mul, cadence: randRange(p.cadenceMin[0], p.cadenceMin[1]) * 60 * 1000 * mul, trades: randInt(p.sessionTrades[0], p.sessionTrades[1]) };
  }
  async runSession(rec) {
    const t = this.personaTiming(rec);
    try {
      for (let i = 0; i < t.trades; i++) {
        if (this.stopRequested) break;
        await sleep(t.think);
        if (this.stopRequested || !this.running) break;
        await this.trade(rec);
      }
    } finally {
      rec.busy = false;
      rec.nextWake = Date.now() + t.cadence * (0.5 + Math.random());
      this.save();
    }
  }

  // price momentum over the recent history window; drives fomo/panic overrides
  momentum() {
    const h = this.state.history;
    if (!h || h.length < 4) return 0;
    const w = h.slice(-8);
    const a = w[0].price;
    return a > 0 ? (w[w.length - 1].price - a) / a : 0;
  }

  async decideTrade(rec, ethBal, tokBal, price) {
    const portfolio = ethBal + tokBal * price;
    if (portfolio <= 0 || price <= 0) return null;
    const floor = this.tradeFloor(rec);
    const p = PERSONAS[rec.persona] || PERSONAS.dca;
    const charAlloc = rec.allocTarget != null ? rec.allocTarget : p.alloc;
    const sizeMul = rec.sizeMul || 1;
    const fomo = rec.fomo || 0;
    const panic = rec.panic || 0;
    const moonbag = rec.moonbag || 0;
    const mom = this.momentum();

    // fomo: green momentum pulls buys from chasers
    if (mom > 0.004 && ethBal > floor * 2 && Math.random() < fomo * Math.min(1, mom / 0.03)) {
      const size = Math.min(ethBal * 0.9, portfolio * 0.06 * sizeMul * (1 + mom * 30));
      if (size >= floor) return { direction: "buy", sizeEth: size, why: "fomo" };
    }
    // panic: red momentum shakes weak hands — the moonbag floor is never sold
    const sellableTok = Math.max(0, tokBal - (rec.peakTok || 0) * moonbag);
    if (mom < -0.004 && sellableTok > 0 && Math.random() < panic * Math.min(1, -mom / 0.03)) {
      const size = Math.min(sellableTok * price * 0.9, portfolio * 0.08 * sizeMul * (1 + -mom * 30));
      if (size >= floor) return { direction: "sell", sizeEth: size, why: "panic" };
    }
    // base: drift back toward the character's target allocation
    const target = Math.min(0.95, Math.max(0.02, charAlloc + (rec.allocJitter || 0)));
    const current = (tokBal * price) / portfolio;
    const drift = target - current;
    if (Math.abs(drift) < 0.08) return null; // hysteresis
    let sizeEth = Math.abs(drift) * portfolio * p.tradeFrac * lognormal(p.sigma) * sizeMul;
    if (drift > 0) sizeEth = Math.min(sizeEth, ethBal * 0.9);
    else sizeEth = Math.min(sizeEth, sellableTok * price * 0.9);
    if (sizeEth < floor) return null;
    return { direction: drift > 0 ? "buy" : "sell", sizeEth, why: "rebalance" };
  }

  async trade(rec, opts = {}) {
    if (this.busyTrade && !opts.force) return null;
    const { curve, token, threshold } = this.state.launched;
    const abi = this.state.curveAbi;
    this.busyTrade = true;
    try {
      const ph = await this.phase();
      if (ph !== 0) { this.graduatedFlag = true; this.log(`phase is ${ph}, curve trading halted`); return null; }
      const w = this.walletObj(rec);
      const tokenC = new ethers.Contract(token, ERC20_ABI, w);
      const [ethBal, tokBal, v] = await Promise.all([
        this.provider.getBalance(w.address),
        tokenC.balanceOf(w.address),
        this.curveViews(),
      ]);
      const price = v.quoteReserve && v.tokenReserve && v.tokenReserve > 0n
        ? Number(ethers.formatEther(v.quoteReserve)) / Number(ethers.formatEther(v.tokenReserve))
        : v.pricePerToken ? Number(ethers.formatEther(v.pricePerToken)) : 0;
      const realQuote = v.realQuoteReserve || v.quoteReserve || 0n;
      const ethRaised = v.ethRaised || realQuote;
      const thresholdEth = Number(ethers.formatEther(threshold));
      const raisedEth = Number(ethers.formatEther(ethRaised));
      if (raisedEth >= thresholdEth) { this.graduatedFlag = true; this.log("ethRaised >= threshold, awaiting graduation"); return null; }

      let d = opts.direction ? { direction: opts.direction, sizeEth: opts.sizeEth || 0.01 } : await this.decideTrade(rec, Number(ethers.formatEther(ethBal)), Number(ethers.formatEther(tokBal)), price);
      if (!d) return null;
      // impact guard: size vs 2% of real reserves — but a fresh curve's realQuoteReserve is ~0
      // (phantom quote does the pricing), so guard against max(realReserve, 0.5 ETH) instead
      const floor = this.tradeFloor(rec);
      const guardBaseEth = Math.max(Number(ethers.formatEther(realQuote)), 0.5);
      if (d.sizeEth / guardBaseEth > 0.02) {
        d.sizeEth = 0.02 * guardBaseEth;
        if (d.sizeEth < floor) { this.log("trade skipped: impact-clamped below floor"); return null; }
      }
      // graduation guard
      if (!this.state.config.allowGraduation && raisedEth + d.sizeEth > 0.9 * thresholdEth) {
        d.sizeEth = Math.max(0, 0.9 * thresholdEth - raisedEth);
        if (d.sizeEth < floor) { this.log("trade skipped: would approach graduation (allowGraduation off)"); return null; }
      }

      const tag = d.why ? ` [${d.why}]` : "";
      const who = rec.name || rec.persona;
      if (d.direction === "buy") {
        const sizeWei = ethers.parseEther(d.sizeEth.toFixed(18));
        const implied = d.sizeEth / price;
        const minTokens = ethers.parseEther((implied * 0.9).toFixed(18));
        const tx = await this.sendTx(w, { to: curve, data: this.encodeBuy(abi.buySig, abi.buyEthPos, abi.buyMinPos, sizeWei, minTokens, w.address), value: sizeWei, gasLimit: 500000 });
        const rc = await tx.wait();
        if (rc.status !== 1) throw new Error("buy reverted");
        rec.buys++; rec.volumeEth += d.sizeEth;
        rec.peakTok = Math.max(rec.peakTok || 0, Number(ethers.formatEther(tokBal)) + implied);
        this.state.totals.volumeEth += d.sizeEth; this.state.totals.tradeCount++;
        const nv = await this.curveViews();
        const np = nv.quoteReserve && nv.tokenReserve && nv.tokenReserve > 0n ? Number(ethers.formatEther(nv.quoteReserve)) / Number(ethers.formatEther(nv.tokenReserve)) : price;
        this.pushHistory({ ts: Date.now(), price: np, sizeEth: d.sizeEth, direction: "buy", wallet: rec.address, txHash: rc.hash });
        const chat = chatter(rec, "buy");
        this.log(`BUY  ${who}${tag} ${d.sizeEth.toFixed(4)} ETH @ ${np.toExponential(3)} (${rc.hash.slice(0, 12)}…)${chat ? " — " + chat : ""}`);
        return { rc, sizeEth: d.sizeEth };
      } else {
        if (!rec.approved) {
          const tokenC2 = new ethers.Contract(token, ERC20_ABI, w);
          const apData = tokenC2.interface.encodeFunctionData("approve", [curve, ethers.MaxUint256]);
          const ap = await this.sendTx(w, { to: token, data: apData, gasLimit: 500000 });
          await ap.wait();
          rec.approved = true;
        }
        let tokensIn = ethers.parseEther(((d.sizeEth / price) * 1.05).toFixed(18)); // sell slightly more tokens than sizeEth implies
        if (tokensIn > tokBal) tokensIn = tokBal;
        const minEth = ethers.parseEther((d.sizeEth * 0.9).toFixed(18));
        const tx = await this.sendTx(w, { to: curve, data: this.encodeSell(abi.sellSig, tokensIn, minEth, w.address), gasLimit: 500000 });
        const rc = await tx.wait();
        if (rc.status !== 1) throw new Error("sell reverted");
        rec.sells++; rec.volumeEth += d.sizeEth;
        this.state.totals.volumeEth += d.sizeEth; this.state.totals.tradeCount++;
        const nv = await this.curveViews();
        const np = nv.quoteReserve && nv.tokenReserve && nv.tokenReserve > 0n ? Number(ethers.formatEther(nv.quoteReserve)) / Number(ethers.formatEther(nv.tokenReserve)) : price;
        this.pushHistory({ ts: Date.now(), price: np, sizeEth: d.sizeEth, direction: "sell", wallet: rec.address, txHash: rc.hash });
        const chat = chatter(rec, "sell");
        this.log(`SELL ${who}${tag} ${d.sizeEth.toFixed(4)} ETH @ ${np.toExponential(3)} (${rc.hash.slice(0, 12)}…)${chat ? " — " + chat : ""}`);
        return { rc, sizeEth: d.sizeEth };
      }
    } finally {
      this.busyTrade = false;
      this.save();
    }
  }

  pushHistory(e) {
    this.state.history.push(e);
    if (this.state.history.length > HISTORY_CAP) this.state.history.splice(0, this.state.history.length - HISTORY_CAP);
  }

  async tradeOnce(opts = {}) {
    if (!this.state.wallets.length) throw new Error("no wallets");
    const eligible = this.state.wallets.filter((w) => !w.busy);
    if (opts.direction === "sell") {
      // pick a wallet that actually holds tokens; size the sell to its balance
      const { token } = this.state.launched;
      const price = await this.spotPrice();
      const tokenC = new ethers.Contract(token, ERC20_ABI, this.provider);
      const holders = [];
      for (const rec of eligible) {
        const bal = await tokenC.balanceOf(rec.address);
        if (bal > 0n) holders.push({ rec, bal });
      }
      if (!holders.length) { this.log("trade_once sell: no wallet holds tokens"); return null; }
      const pick = holders[randInt(0, holders.length - 1)];
      const tokValEth = Number(ethers.formatEther(pick.bal)) * price;
      // 60% of the position, or ~everything for dust-sized holdings (minEth stays below quoteOut)
      const sizeEth = tokValEth * 0.6 >= MIN_TRADE_ETH ? tokValEth * 0.6 : tokValEth * 0.98;
      this.log(`trade_once: forcing SELL for ${pick.rec.address.slice(0, 10)}… (~${sizeEth.toFixed(4)} ETH)`);
      return this.trade(pick.rec, { force: true, direction: "sell", sizeEth });
    }
    const rec = eligible[randInt(0, eligible.length - 1)] || this.state.wallets[0];
    this.log(`trade_once: forcing trade for ${rec.address.slice(0, 10)}…`);
    return this.trade(rec, { force: true });
  }

  async masterBuy(sizeEth = 0.01) {
    if (!this.state.launched) throw new Error("launch first");
    const masterKey = JSON.parse(fs.readFileSync(WALLET_JSON, "utf8")).privateKey;
    const rec = { address: this.master.address, privateKey: masterKey, persona: "master", allocJitter: 0 };
    const r = await this.trade(rec, { force: true, direction: "buy", sizeEth });
    this.log(`master buy executed: ${sizeEth} ETH`);
    return r;
  }

  async graduate() {
    if (!this.state.launched) throw new Error("launch first");
    const token = this.state.launched.token;
    const before = await this.phase();
    if (before !== 0) return { phase: before, note: "already graduated" };
    const results = {};
    try {
      const tx = await this.factory.connect(this.master).graduate(token, { gasLimit: 5000000 });
      const rc = await tx.wait();
      results.graduate = rc.status === 1 ? "ok" : "reverted";
    } catch (e) { results.graduate = `reverted: ${e.shortMessage || e.message}`; }
    const mid = await this.phase();
    if (mid === 1 || mid === 3) {
      try {
        const tx2 = await this.factory.connect(this.master).createGraduatedPool(token, { gasLimit: 12000000 });
        const rc2 = await tx2.wait();
        results.createGraduatedPool = rc2.status === 1 ? "ok" : "reverted";
      } catch (e) { results.createGraduatedPool = `reverted: ${e.shortMessage || e.message}`; }
    }
    const after = await this.phase();
    if (after !== 0) this.graduatedFlag = true;
    this.log(`graduate() called: phase ${before} -> ${after} (${JSON.stringify(results)})`);
    this.save();
    return { phase: after, ...results };
  }

  async snapshot() {
    let curve = null, phase = null;
    if (this.state.launched && this.provider) {
      phase = await this.phase();
      const price = await this.spotPrice().catch(() => 0);
      const v = await this.curveViews().catch(() => null);
      curve = {
        price,
        ethRaised: v && v.ethRaised ? ethers.formatEther(v.ethRaised) : null,
        quoteReserve: v && v.quoteReserve ? ethers.formatEther(v.quoteReserve) : null,
        tokenReserve: v && v.tokenReserve ? ethers.formatEther(v.tokenReserve) : null,
        realQuoteReserve: v && v.realQuoteReserve ? ethers.formatEther(v.realQuoteReserve) : null,
      };
    }
    return {
      launched: this.state.launched ? { ...this.state.launched, phase } : null,
      running: this.running,
      graduated: this.graduatedFlag,
      curve,
      history: this.state.history,
      wallets: this.state.wallets.map(({ privateKey, busy, nextWake, ...pub }) => ({ ...pub, busy: !!busy })),
      totals: this.state.totals,
      config: this.state.config,
      mixer: {
        stealth: !!this.state.config.stealthFund,
        hops: (this.state.stealthHops || []).length,
        houdiniConfigured: this.houdini.configured, // key presence only — never the key
        houdiniNote: "houdini swap covers mainnet chains only; on testnet 46630 the local stealth-hop mixer is what actually runs",
      },
      curveAbi: this.state.curveAbi ? { buySig: this.state.curveAbi.buySig, sellSig: this.state.curveAbi.sellSig, views: Object.keys(this.state.curveAbi.views || {}) } : null,
      fundJob: this.fundJob ? { running: !!this.fundJob.running, total: this.fundJob.total, done: this.fundJob.done, failed: this.fundJob.failed || 0, fundBase: this.fundJob.fundBase } : null,
      log: this.logBuf.slice(-30),
      anvilUp: !!this.nodeUp, // key kept for the unchanged UI; now means "testnet reachable"
      fast: FAST,
    };
  }

  // Wipe lab state AND launch a fresh token on testnet (deliverable E semantics).
  // Consolidate: stop bots, dump every bot's full token bag, sweep all ETH home.
  async consolidate() {
    if (this.running) await this.stopBots();
    const launched = this.state.launched;
    const abi = this.state.curveAbi;
    const price = await this.spotPrice().catch(() => 0);
    let sweptEth = 0, soldEth = 0, walletsTouched = 0;
    for (const rec of this.state.wallets) {
      const w = this.walletObj(rec);
      const who = rec.name || rec.address.slice(0, 8);
      try {
        if (launched && abi) {
          const tokenC = new ethers.Contract(launched.token, ERC20_ABI, w);
          const tokBal = await tokenC.balanceOf(w.address);
          if (tokBal > 0n) {
            if (!rec.approved) {
              const ap = await this.sendTx(w, { to: launched.token, data: tokenC.interface.encodeFunctionData("approve", [launched.curve, ethers.MaxUint256]), gasLimit: 500000 });
              await ap.wait();
              rec.approved = true;
            }
            const impliedEth = price > 0 ? Number(ethers.formatEther(tokBal)) * price : 0;
            // sequential full-bag dumps slide the price — 50% min-out floor
            const minEth = ethers.parseEther((impliedEth * 0.5).toFixed(18));
            const tx = await this.sendTx(w, { to: launched.curve, data: this.encodeSell(abi.sellSig, tokBal, minEth, w.address), gasLimit: 500000 });
            const rc = await tx.wait();
            if (rc.status !== 1) throw new Error("sell reverted");
            rec.sells++; rec.volumeEth += impliedEth;
            this.state.totals.volumeEth += impliedEth; this.state.totals.tradeCount++;
            soldEth += impliedEth;
            const nv = await this.curveViews().catch(() => null);
            if (nv && nv.quoteReserve && nv.tokenReserve > 0n) this.pushHistory({ ts: Date.now(), price: Number(ethers.formatEther(nv.quoteReserve)) / Number(ethers.formatEther(nv.tokenReserve)), sizeEth: impliedEth, direction: "sell", wallet: rec.address, txHash: rc.hash });
            this.log(`CONSOLIDATE ${who}: full bag dumped (${rc.hash.slice(0, 12)}…)`);
          }
        }
      } catch (e) {
        this.log(`consolidate: ${who} failed: ${(e.shortMessage || e.message).slice(0, 80)}`);
      }
    }
    // sweep phase: ETH home. Stealth + many wallets = group-hop collection
    // (bots fan into fresh hops, hops forward to master) instead of per-wallet routes.
    const stealthOn = !!this.state.config.stealthFund;
    const sweepable = [];
    for (const rec of this.state.wallets) {
      try {
        const bal = await this.provider.getBalance(rec.address);
        const reserve = ethers.parseEther("0.0002"); // gas cushion left in the wallet
        if (bal > reserve) sweepable.push({ rec, amt: bal - reserve });
      } catch (e) {
        this.log(`consolidate: balance check ${rec.address.slice(0, 10)}… failed: ${(e.shortMessage || e.message).slice(0, 60)}`);
      }
    }
    if (stealthOn && sweepable.length > 8) {
      const GROUP = 10;
      for (let g = 0; g < sweepable.length; g += GROUP) {
        const chunk = sweepable.slice(g, g + GROUP);
        const payments = chunk.map(({ rec, amt }) => ({ wallet: this.walletObj(rec), amountWei: amt }));
        const r = await this.stealth().routeReturnGroup(payments, { save: () => this.save() });
        const legEth = Number(ethers.formatEther(r.deliveredWei));
        sweptEth += chunk.reduce((a, c) => a + Number(ethers.formatEther(c.amt)), 0);
        walletsTouched += chunk.length;
        this.log(`consolidate: group leg ${Math.floor(g / GROUP) + 1} done — ${chunk.length} wallets, hop forwarded ${legEth.toFixed(5)} ETH`);
      }
    } else {
      for (const { rec, amt } of sweepable) {
        const w = this.walletObj(rec);
        const who = rec.name || rec.address.slice(0, 8);
        try {
          if (stealthOn) {
            await this.stealth().routeReturn(w, amt, { save: () => this.save() });
          } else {
            const tx = await this.sendTx(w, { to: this.master.address, value: amt });
            await tx.wait();
          }
          sweptEth += Number(ethers.formatEther(amt));
          walletsTouched++;
        } catch (e) {
          this.log(`consolidate: ${who} sweep failed: ${(e.shortMessage || e.message).slice(0, 80)}`);
        }
      }
    }
    this.log(`consolidated: swept ${sweptEth.toFixed(5)} ETH home from ${walletsTouched} wallets (bag dumps ≈ ${soldEth.toFixed(5)} ETH of volume)${stealthOn ? " [stealth hops]" : ""}`);
    const dust = await this.stealth().sweepHops();
    if (dust > 0) this.log(`consolidated: +${dust.toFixed(5)} ETH hop dust recovered`);
    this.save();
    return { sweptEth, soldEth, walletsTouched, hopDust: dust };
  }

  async reset() {
    await this.stopBots().catch(() => {});
    this.state = { launched: null, curveAbi: null, wallets: [], history: [], config: { allowGraduation: false, stealthFund: STEALTH_FUND }, totals: { volumeEth: 0, tradeCount: 0 } };
    this.graduatedFlag = false;
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    this.log("state wiped — launching a FRESH token on testnet");
    await this.launch();
    return this.state.launched;
  }

  async shutdown() {
    // stop bots + persist; there is no local chain node to manage
    await this.stopBots().catch(() => {});
    this.save();
  }
}

module.exports = { Engine };
