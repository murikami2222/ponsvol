#!/bin/bash
# Volume lab launcher — Robinhood Chain TESTNET (46630) backend + web UI on :8577.
# No local chain node: the lab talks to the public testnet RPC and the Pons V2
# stack recorded in deployed.json. Rerunning while the server is up is a no-op.
# Stop with: pkill -f "node server.js"
cd "$(dirname "$0")"
set -a
[ -f .env ] && . ./.env
set +a

# Fast bot cadence by default so both trade directions show within minutes.
# Override with: VOL_FAST=0 bash run.sh
export VOL_FAST="${VOL_FAST:-1}"

if lsof -nP -iTCP:8577 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[run.sh] server already running on :8577 (resume)"
  exit 0
fi

echo "[run.sh] starting server on :8577 (testnet 46630, RPC ${RPC_URL:-https://rpc.testnet.chain.robinhood.com})"
exec node server.js
