"use strict";
// D. Launch a token on the testnet factory via launchTokenFor (deployer IS the
// launchForwarder), then PROVE both trade directions on the bonding curve:
// buy 0.01 ETH, sell the received tokens back. Prints deltas + tx hashes and
// records everything into ponsvol/deployed.json (+ seeds ponsvol/state.json
// so the lab engine resumes this token instead of relaunching).
const path = require("path");
const fs = require("fs");
const ethers = require("ethers");
const { provider, signer, artifact, loadDeployed, saveDeployed, sendAndWait } = require("./lib");

const STATE_FILE = path.join(__dirname, "..", "state.json");
const NAME = "Testnet Volume";
const SYMBOL = "TESTVOL";
const BUY_ETH = ethers.parseEther("0.01");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
];
const CURVE_ABI = [
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)",
  "function getReserves() view returns (uint256, uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function graduated() view returns (bool)",
];

async function main() {
  const prov = provider();
  const wallet = signer(prov);
  const state = loadDeployed();
  const factoryAddr = state.steps.factory?.address;
  if (!factoryAddr) throw new Error("factory not deployed");
  const gasPrice = (await prov.getFeeData()).gasPrice;
  const factory = new ethers.Contract(factoryAddr, artifact("PonsV2LaunchFactory.sol/PonsV2LaunchFactory").abi, wallet);

  // ---- launch (skip if already recorded + still exists on chain) ----
  let launch = state.launch;
  if (launch?.token && (await prov.getCode(launch.token)) !== "0x") {
    console.log(`launch: already have token ${launch.token} — skip launch tx`);
  } else {
    const forwarder = await factory.launchForwarder();
    if (forwarder.toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`deployer is not launchForwarder (${forwarder})`);
    const launchFee = await factory.launchFee();
    const configId = 0;
    const economics = await factory.previewLaunchEconomics(configId, ethers.ZeroAddress);
    const params = {
      name: NAME, symbol: SYMBOL, logo: "", description: "ponsvol volume lab on testnet",
      socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
      creatorFeeRecipient: wallet.address,
      creatorTaxBps: 200, buybackEnabled: false,
      expectedEconomics: economics,
      salt: ethers.hexlify(ethers.randomBytes(32)),
    };
    console.log(`launching ${NAME} (${SYMBOL}) via launchTokenFor, fee ${ethers.formatEther(launchFee)} ETH...`);
    const rc = await sendAndWait(
      factory.launchTokenFor(params, configId, ethers.ZeroAddress, wallet.address, [], { value: launchFee, gasPrice }),
      "launchTokenFor"
    );
    let token = null, curve = null;
    for (const log of rc.logs) {
      if (log.address.toLowerCase() !== factoryAddr.toLowerCase()) continue;
      try {
        const parsed = factory.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.name === "TokenLaunched") { token = parsed.args[0]; curve = parsed.args[1]; break; }
      } catch { /* not ours */ }
    }
    if (!token) throw new Error("TokenLaunched not found in receipt");
    const lt = await factory.getLaunchedToken(token);
    if (!lt.exists) throw new Error("getLaunchedToken: not exists");
    launch = {
      token, curve, threshold: lt.graduationThreshold.toString(), configId,
      txHash: rc.hash, block: rc.blockNumber, name: NAME, symbol: SYMBOL,
      gasUsed: rc.gasUsed.toString(),
    };
    state.launch = launch;
    saveDeployed(state);
    console.log(`LAUNCHED token=${token} curve=${curve} threshold=${ethers.formatEther(lt.graduationThreshold)} ETH`);
  }

  const curve = new ethers.Contract(launch.curve, CURVE_ABI, wallet);
  const token = new ethers.Contract(launch.token, ERC20_ABI, wallet);
  console.log(`curve graduated()=${await curve.graduated()} reserves=${await curve.getReserves()} realQuote=${await curve.realQuoteReserve()}`);

  // ---- BUY proof ----
  if (!state.trades?.buy) {
    const [resQ, resT] = await curve.getReserves();
    const impliedTokens = (Number(ethers.formatEther(BUY_ETH)) / Number(ethers.formatEther(resQ))) * Number(ethers.formatEther(resT));
    const minOut = ethers.parseEther((impliedTokens * 0.9).toFixed(18));
    const ethBefore = await prov.getBalance(wallet.address);
    const tokBefore = await token.balanceOf(wallet.address);
    const rc = await sendAndWait(curve.buy(BUY_ETH, minOut, wallet.address, { value: BUY_ETH, gasPrice }), "curve.buy(0.01 ETH)");
    const ethAfter = await prov.getBalance(wallet.address);
    const tokAfter = await token.balanceOf(wallet.address);
    const ethDelta = ethAfter - ethBefore; // includes gas
    const tokDelta = tokAfter - tokBefore;
    console.log(`BUY OK: eth delta ${ethers.formatEther(ethDelta)} (incl. gas), token delta ${ethers.formatEther(tokDelta)}`);
    state.trades = state.trades || {};
    state.trades.buy = {
      txHash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
      ethIn: ethers.formatEther(BUY_ETH),
      ethDeltaInclGas: ethDelta.toString(), tokenDelta: tokDelta.toString(),
      tokenDeltaEth: ethers.formatEther(tokDelta),
    };
    saveDeployed(state);
  } else console.log("buy proof already recorded — skip");

  // ---- approve + SELL proof (sell back exactly what the buy delivered) ----
  if (!state.trades?.sell) {
    const bought = BigInt(state.trades.buy.tokenDelta);
    const allowRc = await sendAndWait(token.approve(launch.curve, ethers.MaxUint256, { gasPrice }), "token.approve(curve)");
    const ethBefore = await prov.getBalance(wallet.address);
    const tokBefore = await token.balanceOf(wallet.address);
    const rc = await sendAndWait(curve.sell(bought, 0n, wallet.address, { gasPrice }), "curve.sell(all bought tokens)");
    const ethAfter = await prov.getBalance(wallet.address);
    const tokAfter = await token.balanceOf(wallet.address);
    const ethDelta = ethAfter - ethBefore;
    const tokDelta = tokAfter - tokBefore;
    console.log(`SELL OK: eth delta ${ethers.formatEther(ethDelta)} (incl. approve gas earlier), token delta ${ethers.formatEther(tokDelta)}`);
    state.trades.sell = {
      txHash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
      approveTx: allowRc.hash,
      tokensIn: bought.toString(), tokensInEth: ethers.formatEther(bought),
      ethDelta: ethDelta.toString(), ethDeltaEth: ethers.formatEther(ethDelta),
      tokenDelta: tokDelta.toString(),
    };
    saveDeployed(state);
  } else console.log("sell proof already recorded — skip");

  // ---- seed the lab state.json so the engine resumes THIS token ----
  const labState = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  labState.launched = { token: launch.token, curve: launch.curve, threshold: launch.threshold, configId: launch.configId, txHash: launch.txHash, name: NAME, symbol: SYMBOL };
  labState.curveAbi = {
    buySig: "buy(uint256,uint256,address)", sellSig: "sell(uint256,uint256,address)",
    buyEthPos: 0, buyMinPos: 1,
    views: { "getReserves()": "0", "realQuoteReserve()": "0", "graduated()": "0" },
  };
  const [resQ, resT] = await curve.getReserves();
  const price = Number(ethers.formatEther(resQ)) / Number(ethers.formatEther(resT));
  labState.history = (labState.history || []).concat([
    { ts: Date.now() - 2000, price, sizeEth: 0.01, direction: "buy", wallet: wallet.address, txHash: state.trades.buy.txHash },
    { ts: Date.now() - 1000, price, sizeEth: Number(state.trades.sell.ethDeltaEth), direction: "sell", wallet: wallet.address, txHash: state.trades.sell.txHash },
  ]).slice(-1000);
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(labState, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  console.log("state.json seeded with launch + curveAbi + proof trades");

  console.log("\n=== D COMPLETE ===");
  console.log(`token  ${launch.token}`);
  console.log(`curve  ${launch.curve}`);
  console.log(`buy    ${state.trades.buy.txHash}`);
  console.log(`sell   ${state.trades.sell.txHash}`);
}

main().catch((e) => { console.error("LAUNCH/TRADE FAILED:", e.message); process.exit(1); });
