"use strict";
// Funding-privacy layer for the volume lab.
//
// Two modes:
//  - StealthMixer (default on testnet): behavioral clone of a mixer's properties.
//    master -> one-time hop wallet -> bot (funding) and bot -> hop -> master
//    (consolidate), with randomized delays and ±20% amount jitter, so the master
//    never touches a bot address directly. Hop keys live in state.json so funds
//    are NEVER stranded; `sweepHops()` recovers dust.
//  - HoudiniClient: the REAL Houdini Swap partner API (api-partner.houdiniswap.com,
//    Authorization: "ApiKey:ApiSecret", quote -> exchange -> status flow). Houdini
//    routes mainnet assets across 100+ chains — it does NOT know Robinhood testnet
//    46630 exists, so on this chain StealthMixer is the only thing that can run.
//    The client is wired for when the lab points at a supported chain; keys come
//    from HOUDINI_API_KEY / HOUDINI_API_SECRET env and are never logged or served.
const ethers = require("ethers");

const HOUDINI_BASE = process.env.HOUDINI_API_URL || "https://api-partner.houdiniswap.com";

function randRange(lo, hi) { return lo + Math.random() * (hi - lo); }

// ---------------------------------------------------------------- Houdini API
class HoudiniClient {
  constructor(log = () => {}) {
    this.key = process.env.HOUDINI_API_KEY || "";
    this.secret = process.env.HOUDINI_API_SECRET || "";
    this.log = log;
  }
  get configured() { return !!(this.key && this.secret); }
  async call(method, path, body) {
    const headers = {
      "authorization": `${this.key}:${this.secret}`,
      "content-type": "application/json",
      // compliance fields Houdini requires on quote/exchange calls
      "x-user-ip": "127.0.0.1",
      "x-user-agent": "ponsvol-lab/1.0",
      "x-user-timezone": "0",
    };
    const res = await fetch(HOUDINI_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* text body */ }
    if (!res.ok) throw new Error(`houdini ${method} ${path} -> ${res.status}: ${text.slice(0, 160)}`);
    return json;
  }
  async currencies() { return this.call("GET", "/v1/currencies"); }
  async quote({ from, to, amount, anonymous = true }) {
    return this.call("POST", "/v1/quote", { from, to, amount: String(amount), anonymous });
  }
  // Returns { orderId, depositAddress, ... } — you send funds to depositAddress,
  // Houdini delivers the swapped asset to recipientAddress through its pool.
  async exchange(args) { return this.call("POST", "/v1/exchange", args); }
  async status(orderId) { return this.call("GET", `/v1/status?id=${encodeURIComponent(orderId)}`); }
}

// -------------------------------------------------------------- Stealth mixer
// engine: provides { provider, master, sendTx, log }.
// state:  the persisted state object — hop keys are stored under `stealthHops`.
class StealthMixer {
  constructor(engine, state) {
    this.engine = engine;
    this.state = state;
    this.state.stealthHops = this.state.stealthHops || [];
  }

  _recordHop(rec) { this.state.stealthHops.push(rec); }

  async _send(wallet, to, valueWei) {
    const tx = await this.engine.sendTx(wallet, { to, value: valueWei });
    return tx.wait();
  }

  // Fund `toAddress` from `fromWallet` (usually master) through `hops` one-time
  // intermediaries with delay + ±jitterPct amount jitter. Returns the hop record.
  async routeFund(fromWallet, toAddress, amountEth, { hops = 1, jitterPct = 0.2, maxDelaySec = 60, save = () => {} } = {}) {
    const chain = [];
    for (let i = 0; i < hops; i++) {
      const h = ethers.Wallet.createRandom().connect(this.engine.provider);
      chain.push(h);
      this._recordHop({ address: h.address, privateKey: h.privateKey, createdTs: Date.now(), kind: "fund" });
    }
    save();

    const provider = this.engine.provider;
    let cur = fromWallet;
    let amt = amountEth;
    for (let i = 0; i <= chain.length; i++) {
      const dest = i < chain.length ? chain[i].address : toAddress;
      const isLast = i === chain.length;
      // jitter applies only to intermediate legs; the final leg delivers the exact amount
      const legAmt = isLast ? amt : amt * (1 + randRange(-jitterPct, jitterPct));
      const bal = await provider.getBalance(cur.address);
      const gasReserve = ethers.parseEther("0.00015");
      let value = ethers.parseEther(legAmt.toFixed(18));
      if (!isLast && value > bal - gasReserve) value = bal - gasReserve;
      if (isLast) {
        // last leg: the hop sends everything it can (exact amount requested may exceed
        // what arrived after jitter — clamp to balance minus gas)
        const want = ethers.parseEther(amt.toFixed(18));
        value = want <= bal - gasReserve ? want : bal - gasReserve;
        amt = Number(ethers.formatEther(value)); // recipient sees what actually arrived
      }
      if (value <= 0n) throw new Error(`stealth hop ${i}: source ${cur.address.slice(0, 10)}… has nothing to send`);
      const delaySec = randRange(3, maxDelaySec);
      this.engine.log(`stealth: hop ${i + 1}/${chain.length + 1} ${cur.address.slice(0, 10)}…→${dest.slice(0, 10)}… ${ethers.formatEther(value)} ETH (delay ${delaySec.toFixed(0)}s)`);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
      await this._send(cur, dest, value);
      if (isLast) break;
      cur = chain[i];
      amt = Number(ethers.formatEther(value));
    }
    return { hops: chain.map((h) => h.address), deliveredEth: amt };
  }

  // Sweep a bot's ETH back to master through a fresh hop (mirror of routeFund).
  async routeReturn(botWallet, amountWei, { maxDelaySec = 45, save = () => {} } = {}) {
    const hop = ethers.Wallet.createRandom();
    this._recordHop({ address: hop.address, privateKey: hop.privateKey, createdTs: Date.now(), kind: "return" });
    save();
    const provider = this.engine.provider;
    const gasReserve = ethers.parseEther("0.00015");

    const d1 = randRange(2, maxDelaySec);
    this.engine.log(`stealth: return ${botWallet.address.slice(0, 10)}…→hop ${hop.address.slice(0, 10)}… (delay ${d1.toFixed(0)}s)`);
    await new Promise((r) => setTimeout(r, d1 * 1000));
    await this._send(botWallet, hop.address, amountWei);

    const d2 = randRange(2, maxDelaySec);
    await new Promise((r) => setTimeout(r, d2 * 1000));
    const hopBal = await provider.getBalance(hop.address);
    const fwd = hopBal - gasReserve;
    if (fwd > 0n) {
      this.engine.log(`stealth: hop ${hop.address.slice(0, 10)}…→master ${ethers.formatEther(fwd)} ETH`);
      await this._send(new ethers.Wallet(hop.privateKey, provider), this.engine.master.address, fwd);
      return { hop: hop.address, deliveredWei: fwd };
    }
    this.engine.log(`stealth: hop ${hop.address.slice(0, 10)}… under gas reserve, dust stays for sweepHops`);
    return { hop: hop.address, deliveredWei: 0n };
  }

  // --- batch variants: one hop fans out to many wallets (fast) or collects ---
  // from many bots (consolidate). Per-wallet hops stay the high-privacy path for
  // small creates; group hops trade a little unlinkability for ~10x speed.

  // Fund many targets from one fresh hop: master -> hop (sum + jitter + gas),
  // hop -> each target with ±jitterPct jitter and short randomized spacing.
  async routeFundGroup(fromWallet, targets, { jitterPct = 0.12, save = () => {} } = {}) {
    // targets: [{ address, amountEth }]
    const hop = ethers.Wallet.createRandom().connect(this.engine.provider);
    this._recordHop({ address: hop.address, privateKey: hop.privateKey, createdTs: Date.now(), kind: "fund-group" });
    save();
    const provider = this.engine.provider;
    const gasReserve = ethers.parseEther("0.00015");
    const sum = targets.reduce((a, t) => a + t.amountEth, 0);
    const topUp = sum * (1 + jitterPct) + 0.00003; // covers worst-case jitter + fanout gas
    const delayIn = randRange(2, 8);
    this.engine.log(`stealth group: master→hop ${hop.address.slice(0, 10)}… ${topUp.toFixed(5)} ETH for ${targets.length} wallets (delay ${delayIn.toFixed(0)}s)`);
    await new Promise((r) => setTimeout(r, delayIn * 1000));
    await this._send(fromWallet, hop.address, ethers.parseEther(topUp.toFixed(18)));

    let delivered = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const bal = await provider.getBalance(hop.address);
      let value = ethers.parseEther((t.amountEth * (1 + randRange(-jitterPct, jitterPct))).toFixed(18));
      if (i === targets.length - 1 || value > bal - gasReserve) value = bal - gasReserve; // last wallet gets what's left
      if (value <= 0n) { this.engine.log(`stealth group: hop drained at wallet ${i + 1}/${targets.length}`); break; }
      await new Promise((r) => setTimeout(r, randRange(400, 2500)));
      await this._send(hop, t.address, value);
      delivered += Number(ethers.formatEther(value));
    }
    this.engine.log(`stealth group: hop fanned out ${delivered.toFixed(5)} ETH to ${targets.length} wallets`);
    return { hop: hop.address, deliveredEth: delivered };
  }

  // Collect many bots into one fresh hop, then hop -> master in a single leg.
  async routeReturnGroup(payments, { save = () => {} } = {}) {
    // payments: [{ wallet, amountWei }] — wallet must be a connected ethers.Wallet
    const hop = ethers.Wallet.createRandom().connect(this.engine.provider);
    this._recordHop({ address: hop.address, privateKey: hop.privateKey, createdTs: Date.now(), kind: "return-group" });
    save();
    const provider = this.engine.provider;
    const gasReserve = ethers.parseEther("0.00015");
    let collected = 0n;
    for (const p of payments) {
      await new Promise((r) => setTimeout(r, randRange(400, 2500)));
      try {
        await this._send(p.wallet, hop.address, p.amountWei);
        collected += p.amountWei;
      } catch (e) {
        this.engine.log(`stealth group return: ${p.wallet.address.slice(0, 10)}… failed: ${(e.shortMessage || e.message).slice(0, 60)}`);
      }
    }
    const d = randRange(2, 8);
    await new Promise((r) => setTimeout(r, d * 1000));
    const hopBal = await provider.getBalance(hop.address);
    const fwd = hopBal - gasReserve;
    if (fwd > 0n) {
      this.engine.log(`stealth group: hop ${hop.address.slice(0, 10)}…→master ${ethers.formatEther(fwd)} ETH (collected from ${payments.length} bots)`);
      await this._send(hop, this.engine.master.address, fwd);
      return { hop: hop.address, deliveredWei: fwd };
    }
    return { hop: hop.address, deliveredWei: 0n };
  }

  // Recover dust left in recorded hop wallets (e.g. after a crash mid-route).
  async sweepHops() {
    const provider = this.engine.provider;
    const gasReserve = ethers.parseEther("0.00015");
    let recovered = 0;
    for (const rec of this.state.stealthHops) {
      try {
        const bal = await provider.getBalance(rec.address);
        if (bal <= gasReserve) continue;
        const amt = bal - gasReserve;
        const w = new ethers.Wallet(rec.privateKey, provider);
        await this._send(w, this.engine.master.address, amt);
        recovered += Number(ethers.formatEther(amt));
        this.engine.log(`stealth: recovered ${ethers.formatEther(amt)} ETH dust from hop ${rec.address.slice(0, 10)}…`);
      } catch (e) {
        this.engine.log(`stealth: hop sweep failed for ${rec.address.slice(0, 10)}…: ${(e.shortMessage || e.message).slice(0, 60)}`);
      }
    }
    return recovered;
  }
}

module.exports = { HoudiniClient, StealthMixer, HOUDINI_BASE };
