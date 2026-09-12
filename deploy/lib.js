"use strict";
// Shared helpers for the testnet deploy/wire/launch scripts.
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");

const CHAIN_ID = 46630;
const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const WALLET_JSON = process.env.PONSVOL_WALLET_JSON || "/Users/addminus/minimaxh3/projectX/testnet.wallet.json";
const DEPLOYED_PATH = path.join(__dirname, "..", "deployed.json");
const ARTIFACTS = path.join(__dirname, "artifacts", "contracts", "src", "v2");

// Testnet singletons (bytecode-verified identical/compatible to mainnet).
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const POSITION_MANAGER = "0x58daec3116aae6D93017bAAea7749052E8a04fA7";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C"; // deterministic-deployment-proxy

function loadWallet() {
  const j = JSON.parse(fs.readFileSync(WALLET_JSON, "utf8"));
  if (!j.privateKey) throw new Error("privateKey missing in wallet json");
  return j;
}
function provider() {
  const p = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  p.pollingInterval = 400;
  return p;
}
function signer(prov) {
  return new ethers.Wallet(loadWallet().privateKey, prov);
}
function artifact(rel) {
  // rel like "PonsV2LaunchLocker.sol/PonsV2LaunchLocker" or "hooks/PonsV2MemeHook.sol/PonsV2MemeHook"
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS, rel + ".json"), "utf8"));
}
function loadDeployed() {
  if (fs.existsSync(DEPLOYED_PATH)) return JSON.parse(fs.readFileSync(DEPLOYED_PATH, "utf8"));
  return { chainId: CHAIN_ID, rpc: RPC_URL, deployer: loadWallet().address, constants: { poolManager: POOL_MANAGER, positionManager: POSITION_MANAGER, permit2: PERMIT2, create2Deployer: CREATE2_DEPLOYER }, steps: {}, wiring: {} };
}
function saveDeployed(d) {
  const tmp = DEPLOYED_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DEPLOYED_PATH);
}
async function hasCode(prov, addr) {
  if (!addr) return false;
  const code = await prov.getCode(addr);
  return code && code !== "0x";
}
// legacy gasPrice send — Robinhood Orbit accepts type-0; gasPrice from eth_gasPrice.
async function sendAndWait(txPromise, label) {
  const tx = await txPromise;
  console.log(`  ${label}: tx ${tx.hash}`);
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error(`${label} reverted (${tx.hash})`);
  console.log(`  ${label}: mined block ${rc.blockNumber}, gasUsed ${rc.gasUsed}`);
  return rc;
}
async function estimateCost(prov, gasUnits, gasPrice) {
  return ethers.formatEther(BigInt(gasUnits) * BigInt(gasPrice));
}

module.exports = { CHAIN_ID, RPC_URL, DEPLOYED_PATH, POOL_MANAGER, POSITION_MANAGER, PERMIT2, CREATE2_DEPLOYER, loadWallet, provider, signer, artifact, loadDeployed, saveDeployed, hasCode, sendAndWait, estimateCost };
