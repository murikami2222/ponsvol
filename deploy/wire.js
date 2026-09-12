"use strict";
// C. Owner wiring — mirror mainnet factory state on testnet. Resumable:
// every setter is skipped when the on-chain value already matches.
const ethers = require("ethers");
const { provider, signer, artifact, loadDeployed, saveDeployed, sendAndWait } = require("./lib");

const MIRROR_CONFIG = {
  supply: 1000000000n * 10n ** 18n, // 1e9 tokens
  curveFeeBps: 100n,
  phantomQuote: ethers.parseEther("1.68"),
  graduationThreshold: ethers.parseEther("4.2"),
  poolFee: 0,
  tickSpacing: 200,
  enabled: true,
};

async function main() {
  const prov = provider();
  const wallet = signer(prov);
  const state = loadDeployed();
  const S = state.steps;
  const factoryAddr = S.factory?.address;
  if (!factoryAddr) throw new Error("factory not deployed yet");
  const gasPrice = (await prov.getFeeData()).gasPrice;

  const fArt = artifact("PonsV2LaunchFactory.sol/PonsV2LaunchFactory");
  const factory = new ethers.Contract(factoryAddr, fArt.abi, wallet);
  const hookArt = artifact("hooks/PonsV2MemeHook.sol/PonsV2MemeHook");
  const hook = new ethers.Contract(S.memeHook.address, hookArt.abi, wallet);
  const lockArt = artifact("PonsV2LaunchLocker.sol/PonsV2LaunchLocker");
  const locker = new ethers.Contract(S.locker.address, lockArt.abi, wallet);
  const vaultArt = artifact("PonsV2BuybackVault.sol/PonsV2BuybackVault");
  const vault = new ethers.Contract(S.buybackVault.address, vaultArt.abi, wallet);

  async function setOnce(key, label, currentFn, target, callFn) {
    const cur = await currentFn();
    if (String(cur).toLowerCase() === String(target).toLowerCase()) {
      console.log(`${label}: already ${target} — skip`);
      return;
    }
    const rc = await sendAndWait(callFn(), label, );
    const after = await currentFn();
    if (String(after).toLowerCase() !== String(target).toLowerCase()) throw new Error(`${label} readback mismatch: ${after} != ${target}`);
    console.log(`  ${label}: verified on-chain = ${after}`);
    state.wiring[key] = { tx: rc.hash, block: rc.blockNumber };
    saveDeployed(state);
  }

  // cross-wiring (one-time setters)
  await setOnce("hook.setFactory", "hook.setFactory", () => hook.factory(), factoryAddr, () => hook.setFactory(factoryAddr, { gasPrice }));
  await setOnce("hook.setBuybackVault", "hook.setBuybackVault", () => hook.buybackVault(), S.buybackVault.address, () => hook.setBuybackVault(S.buybackVault.address, { gasPrice }));
  await setOnce("locker.setFactory", "locker.setFactory", () => locker.factory(), factoryAddr, () => locker.setFactory(factoryAddr, { gasPrice }));
  await setOnce("vault.setFactory", "vault.setFactory", () => vault.factory(), factoryAddr, () => vault.setFactory(factoryAddr, { gasPrice }));
  await setOnce("factory.setLaunchDeployer", "factory.setLaunchDeployer", () => factory.launchDeployer(), S.launchDeployer.address, () => factory.setLaunchDeployer(S.launchDeployer.address, { gasPrice }));
  await setOnce("factory.setGraduationExecutor", "factory.setGraduationExecutor", () => factory.graduationExecutor(), S.graduationExecutor.address, () => factory.setGraduationExecutor(S.graduationExecutor.address, { gasPrice }));

  // launch gating — mirror mainnet: forwarder = deployer, launches open to all
  await setOnce("factory.setLaunchForwarder", "factory.setLaunchForwarder", () => factory.launchForwarder(), wallet.address, () => factory.setLaunchForwarder(wallet.address, { gasPrice }));
  await setOnce("factory.setLaunchEnabled", "factory.setLaunchEnabled", () => factory.launchEnabled(), true, () => factory.setLaunchEnabled(true, { gasPrice }));

  // launch config 0 — mirror mainnet values
  const count = Number(await factory.launchConfigCount());
  if (count === 0) {
    const rc = await sendAndWait(factory.addLaunchConfig(MIRROR_CONFIG, { gasPrice }), "factory.addLaunchConfig");
    state.wiring["factory.addLaunchConfig"] = { tx: rc.hash, block: rc.blockNumber };
    saveDeployed(state);
  } else {
    console.log("factory.addLaunchConfig: config 0 already exists — skip");
  }
  const c0 = await factory.getLaunchConfig(0);
  const match = c0.supply === MIRROR_CONFIG.supply && c0.curveFeeBps === MIRROR_CONFIG.curveFeeBps && c0.phantomQuote === MIRROR_CONFIG.phantomQuote && c0.graduationThreshold === MIRROR_CONFIG.graduationThreshold && Number(c0.poolFee) === 0 && Number(c0.tickSpacing) === 200 && c0.enabled === true;
  console.log(`config 0 readback: supply ${c0.supply} feeBps ${c0.curveFeeBps} phantom ${ethers.formatEther(c0.phantomQuote)} threshold ${ethers.formatEther(c0.graduationThreshold)} poolFee ${c0.poolFee} tickSpacing ${c0.tickSpacing} enabled ${c0.enabled}`);
  if (!match) throw new Error("config 0 does not mirror mainnet");

  // launchFee check
  const fee = await factory.launchFee();
  console.log(`launchFee = ${ethers.formatEther(fee)} ETH`);
  if (fee !== ethers.parseEther("0.0005")) throw new Error("launchFee mismatch");

  // native pairToken(0x0): no approval/economics wiring exists by design
  console.log(`approvedPairTokens(0x0) = ${await factory.approvedPairTokens(ethers.ZeroAddress)} (expected false — native launches skip this mapping)`);

  // final gate predicate
  const can = await factory.canLaunch(wallet.address);
  console.log(`canLaunch(deployer) = ${can}`);
  if (!can) throw new Error("deployer cannot launch");
  console.log("\nWiring complete. Next: node launch_trade.js");
}

main().catch((e) => { console.error("WIRE FAILED:", e.message); process.exit(1); });
