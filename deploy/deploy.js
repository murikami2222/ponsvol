"use strict";
// B. Deploy the Pons V2 launchpad stack to Robinhood Chain TESTNET (46630).
// Order: locker -> feeEscrow -> memeHook (CREATE2-mined v4 hook address) ->
// buybackVault -> factory -> launchDeployer -> graduationExecutor.
// Resumable: every step is recorded in ponsvol/deployed.json and skipped if
// the recorded address still has code on chain.
const ethers = require("ethers");
const {
  POOL_MANAGER, POSITION_MANAGER, PERMIT2, CREATE2_DEPLOYER,
  provider, signer, artifact, loadDeployed, saveDeployed, hasCode, sendAndWait,
} = require("./lib");

// v4-core Hooks.sol (vendored): permission flags live in the LOW 14 bits.
const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n); // beforeInitialize | afterSwap | afterSwapReturnDelta = 0x2044
const HOOK_MASK = (1n << 14n) - 1n;

async function deployPlain(state, prov, wallet, gasPrice, key, artifactRel, label, args) {
  if (await hasCode(prov, state.steps[key]?.address)) {
    console.log(`${key}: already deployed at ${state.steps[key].address} — skip`);
    return state.steps[key].address;
  }
  const art = artifact(artifactRel);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  console.log(`${key}: deploying ${label}...`);
  const deployed = await factory.deploy(...args, { gasPrice });
  const addr = await deployed.getAddress();
  const deployTx = deployed.deploymentTransaction();
  console.log(`  deploy tx ${deployTx.hash} -> ${addr}`);
  const rc = await deployTx.wait();
  if (rc.status !== 1) throw new Error(`${key} deploy reverted`);
  if (!(await hasCode(prov, addr))) throw new Error(`${key} has no code after deploy`);
  state.steps[key] = { address: addr, tx: deployTx.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(), args: args.map(String) };
  saveDeployed(state);
  console.log(`  mined block ${rc.blockNumber}, gasUsed ${rc.gasUsed}`);
  return addr;
}

async function mineHookSalt(initCodeHash) {
  const t0 = Date.now();
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(CREATE2_DEPLOYER, salt, initCodeHash);
    if ((BigInt(addr) & HOOK_MASK) === HOOK_FLAGS) {
      console.log(`  mined salt after ${i + 1n} iterations (${Date.now() - t0}ms): ${salt} -> ${addr}`);
      return { salt, address: addr, iterations: (i + 1n).toString() };
    }
  }
}

async function main() {
  const prov = provider();
  const wallet = signer(prov);
  const state = loadDeployed();
  console.log(`deployer ${wallet.address} on chain ${(await prov.getNetwork()).chainId}`);
  const bal = await prov.getBalance(wallet.address);
  const gasPrice = await (await prov.getFeeData()).gasPrice;
  console.log(`balance ${ethers.formatEther(bal)} ETH, gasPrice ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  // gas model probe: legacy-priced self-transfer, gas estimated by the node
  // (Orbit intrinsic gas includes the poster component — a bare 21000 reverts)
  if (!state.steps.gasProbe) {
    const rc = await sendAndWait(
      wallet.sendTransaction({ to: wallet.address, value: 0n, gasPrice }),
      "gasProbe self-transfer"
    );
    state.steps.gasProbe = { tx: rc.hash, gasUsed: rc.gasUsed.toString(), gasPrice: gasPrice.toString() };
    saveDeployed(state);
  }

  // 1. locker
  const locker = await deployPlain(state, prov, wallet, gasPrice, "locker", "PonsV2LaunchLocker.sol/PonsV2LaunchLocker", "PonsV2LaunchLocker", [wallet.address, POSITION_MANAGER]);
  // 2. feeEscrow
  const escrow = await deployPlain(state, prov, wallet, gasPrice, "feeEscrow", "PonsV2FeeEscrow.sol/PonsV2FeeEscrow", "PonsV2FeeEscrow", []);

  // 3. memeHook via CREATE2 (address must carry the v4 permission bits)
  const hookArt = artifact("hooks/PonsV2MemeHook.sol/PonsV2MemeHook");
  const hookArgs = [POOL_MANAGER, escrow, wallet.address, wallet.address]; // poolManager, feeEscrow, protocolFeeRecipient, initialOwner
  const initcode = hookArt.bytecode + ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address"], hookArgs).slice(2);
  const initCodeHash = ethers.keccak256(initcode);
  let hook;
  if (await hasCode(prov, state.steps.memeHook?.address)) {
    console.log(`memeHook: already deployed at ${state.steps.memeHook.address} — skip`);
    hook = state.steps.memeHook.address;
  } else {
    const mined = await mineHookSalt(initCodeHash);
    console.log(`memeHook: deploying via CREATE2 at predicted ${mined.address}...`);
    const data = mined.salt + initcode.slice(2);
    const rc = await sendAndWait(
      wallet.sendTransaction({ to: CREATE2_DEPLOYER, data, gasPrice }),
      "memeHook CREATE2"
    );
    if (!(await hasCode(prov, mined.address))) throw new Error("memeHook missing at predicted address after CREATE2");
    hook = mined.address;
    state.steps.memeHook = { address: hook, tx: rc.hash, salt: mined.salt, iterations: mined.iterations, gasUsed: rc.gasUsed.toString(), args: hookArgs.map(String) };
    saveDeployed(state);
  }

  // 4. buybackVault (feePolicy = hook, mirrors mainnet)
  const vault = await deployPlain(state, prov, wallet, gasPrice, "buybackVault", "PonsV2BuybackVault.sol/PonsV2BuybackVault", "PonsV2BuybackVault", [wallet.address, hook, escrow]);
  // 5. factory
  const LAUNCH_FEE = ethers.parseEther("0.0005"); // mirrors mainnet launchFee
  const factoryAddr = await deployPlain(state, prov, wallet, gasPrice, "factory", "PonsV2LaunchFactory.sol/PonsV2LaunchFactory", "PonsV2LaunchFactory", [wallet.address, POOL_MANAGER, POSITION_MANAGER, PERMIT2, locker, hook, escrow, vault, LAUNCH_FEE]);
  // 6. launchDeployer + graduationExecutor (post-factory one-time-wired helpers)
  const launchDeployer = await deployPlain(state, prov, wallet, gasPrice, "launchDeployer", "PonsV2LaunchDeployer.sol/PonsV2LaunchDeployer", "PonsV2LaunchDeployer", [factoryAddr]);
  const gradExec = await deployPlain(state, prov, wallet, gasPrice, "graduationExecutor", "PonsV2GraduationExecutor.sol/PonsV2GraduationExecutor", "PonsV2GraduationExecutor", [POSITION_MANAGER, PERMIT2, locker, factoryAddr]);

  console.log("\n=== deployed ===");
  for (const [k, v] of Object.entries(state.steps)) if (v.address) console.log(`  ${k}: ${v.address}`);
  console.log("deployed.json updated. Next: node wire.js");
}

main().catch((e) => { console.error("DEPLOY FAILED:", e.message); process.exit(1); });
