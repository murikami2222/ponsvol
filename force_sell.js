"use strict";
// force_sell.js — standalone "force direction:sell" helper for the testnet lab.
// Sells a fraction of every funded bot wallet's token balance on the launched
// curve. Safe to run alongside the server (all coordination is on-chain).
//   node force_sell.js [fraction]     (default 0.5 = sell half of each balance)
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID = 46630;
const FRAC = Math.min(1, Math.max(0.01, Number(process.argv[2]) || 0.5));

const CURVE_ABI = [
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)",
  "function getReserves() view returns (uint256, uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
];

(async () => {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  if (!state.launched) throw new Error("no launched token in state.json");
  const { token, curve } = state.launched;
  const prov = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  prov.pollingInterval = 400;
  const tokenC = new ethers.Contract(token, ERC20_ABI, prov);

  let sold = 0;
  for (const rec of state.wallets) {
    const w = new ethers.Wallet(rec.privateKey, prov);
    const bal = await tokenC.balanceOf(w.address);
    if (bal === 0n) { console.log(`${w.address.slice(0, 10)}… no token balance — skip`); continue; }
    const amount = (bal * BigInt(Math.round(FRAC * 100))) / 100n;
    if (amount === 0n) continue;
    const allowance = await tokenC.allowance(w.address, curve);
    if (allowance < amount) {
      const ap = await new ethers.Contract(token, ERC20_ABI, w).approve(curve, ethers.MaxUint256, { gasLimit: 500000 });
      await ap.wait();
      console.log(`${w.address.slice(0, 10)}… approved curve (tx ${ap.hash.slice(0, 14)}…)`);
    }
    const tx = await new ethers.Contract(curve, CURVE_ABI, w).sell(amount, 0n, w.address, { gasLimit: 500000 });
    const rc = await tx.wait();
    if (rc.status !== 1) { console.log(`${w.address.slice(0, 10)}… sell REVERTED (${tx.hash})`); continue; }
    sold++;
    console.log(`SELL ${w.address.slice(0, 10)}… ${ethers.formatEther(amount)} tokens (tx ${tx.hash})`);
  }
  const [q, t] = await new ethers.Contract(curve, CURVE_ABI, prov).getReserves();
  console.log(`done — ${sold} sells. reserves now ${ethers.formatEther(q)} quote / ${ethers.formatEther(t)} token`);
})().catch((e) => { console.error("force_sell failed:", e.message); process.exit(1); });
