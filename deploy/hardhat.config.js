// Hardhat workspace for deploying the verified Pons V2 launchpad stack
// onto Robinhood Chain TESTNET (chainId 46630). Sources are the verbatim
// verified bundle in ./contracts (solc v0.8.35+commit.47b9dedd settings).
/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.35",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      viaIR: true,
      metadata: { appendCBOR: true, bytecodeHash: "ipfs" },
    },
  },
  // Only the v2 contracts are compilation roots; contracts/lib/** is reached
  // exclusively through node_modules symlinks (npm-style), matching how the
  // verified build resolved remappings to the same physical files.
  paths: {
    sources: "./contracts/src",
    artifacts: "./artifacts",
    cache: "./cache",
  },
};
