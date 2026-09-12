"use strict";
// Volume-lab server: Robinhood Chain TESTNET (46630) backend, JSON API + static UI on :8577.
const http = require("http");
const fs = require("fs");
const path = require("path");

// load .env (no dep)
if (fs.existsSync(path.join(__dirname, ".env"))) {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { Engine } = require("./engine");
const engine = new Engine();
const PORT = 8577;
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    try {
      if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, await engine.snapshot());
      if (req.method === "POST" && url.pathname === "/api/launch") return send(res, 200, { ok: true, launched: await engine.launch() });
      if (req.method === "POST" && url.pathname === "/api/wallets") {
        const b = await readBody(req);
        const count = Math.min(250, Math.max(1, b.count || 5));
        const fundEth = Math.min(0.05, Math.max(0.0001, Number(b.fundEth) || 0)); // 0 = use env default
        const out = await engine.createWallets(count, fundEth || undefined);
        return send(res, 200, {
          ok: true,
          job: out.job ? { total: out.job.total } : null,
          created: (out.created || []).map((w) => ({ address: w.address, persona: w.persona })),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/start") { engine.startBots(); return send(res, 200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/api/stop") { await engine.stopBots(); return send(res, 200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/api/trade_once") {
        const b = await readBody(req).catch(() => ({}));
        const direction = b.direction === "sell" ? "sell" : undefined; // forced sells for hysteresis-proof demos
        return send(res, 200, { ok: true, result: await engine.tradeOnce({ direction }) });
      }
      if (req.method === "POST" && url.pathname === "/api/graduate") return send(res, 200, { ok: true, ...(await engine.graduate()) });
      if (req.method === "POST" && url.pathname === "/api/master_buy") {
        const b = await readBody(req).catch(() => ({}));
        return send(res, 200, { ok: true, result: await engine.masterBuy(Math.min(5, Number(b.sizeEth) || 0.05)) });
      }
      if (req.method === "POST" && url.pathname === "/api/config") {
        const b = await readBody(req);
        if (typeof b.allowGraduation === "boolean") engine.state.config.allowGraduation = b.allowGraduation;
        if (typeof b.stealthFund === "boolean") engine.state.config.stealthFund = b.stealthFund;
        engine.save();
        return send(res, 200, { ok: true, config: engine.state.config });
      }
      if (req.method === "POST" && url.pathname === "/api/consolidate") return send(res, 200, { ok: true, ...(await engine.consolidate()) });
      if (req.method === "POST" && url.pathname === "/api/sweep_hops") {
        const dust = await engine.stealth().sweepHops();
        engine.save();
        return send(res, 200, { ok: true, recoveredEth: dust });
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        const b = await readBody(req);
        if (b.confirm !== true) return send(res, 400, { error: "pass {confirm:true}" });
        // reset wipes state AND launches a fresh token on testnet
        return send(res, 200, { ok: true, launched: await engine.reset() });
      }
      return send(res, 404, { error: "unknown api route" });
    } catch (e) {
      return send(res, 500, { error: e.shortMessage || e.message });
    }
  }
  // static
  let fp = path.join(PUBLIC, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(data);
  });
});

(async () => {
  await engine.connect();
  server.listen(PORT, "127.0.0.1", () => {
    engine.log(`UI on http://127.0.0.1:${PORT}`);
    console.log(`\n  volume lab (testnet 46630) -> http://127.0.0.1:${PORT}\n`);
  });
})().catch((e) => { console.error("boot failed:", e.message); process.exit(1); });

process.on("SIGINT", async () => { await engine.shutdown(); process.exit(0); });
process.on("SIGTERM", async () => { await engine.shutdown(); process.exit(0); });
