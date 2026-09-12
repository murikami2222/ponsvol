"use strict";
const $ = (id) => document.getElementById(id);
let S = null;

async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const fmtEth = (n) => (n === null || n === undefined ? "—" : Number(n).toFixed(4));
const fmtPrice = (p) => (p > 0 ? p.toExponential(4) : "—");

function drawChart(canvas, history) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#1a222c";
  for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(0, (H / 5) * i); ctx.lineTo(W, (H / 5) * i); ctx.stroke(); }
  if (!history || history.length < 2) {
    ctx.fillStyle = "#5c6b7a"; ctx.font = "14px Menlo"; ctx.textAlign = "center";
    ctx.fillText("awaiting trades…", W / 2, H / 2);
    return;
  }
  const prices = history.map((h) => h.price).filter((p) => p > 0);
  if (!prices.length) return;
  let lo = Math.min(...prices), hi = Math.max(...prices);
  if (hi === lo) { hi *= 1.05; lo *= 0.95; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const x = (i) => (i / (history.length - 1)) * (W - 10) + 5;
  const y = (p) => H - 18 - ((p - lo) / (hi - lo)) * (H - 40);
  // volume bars
  const maxVol = Math.max(...history.map((h) => h.sizeEth), 0.001);
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    ctx.fillStyle = h.direction === "buy" ? "rgba(53,212,101,0.28)" : "rgba(255,92,92,0.28)";
    const bh = (h.sizeEth / maxVol) * (H * 0.45);
    ctx.fillRect(x(i) - 2, H - 18 - bh, 4, bh);
  }
  // price line
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < history.length; i++) {
    const p = history[i].price;
    if (!(p > 0)) continue;
    if (!started) { ctx.moveTo(x(i), y(p)); started = true; } else ctx.lineTo(x(i), y(p));
  }
  ctx.strokeStyle = "#35d465"; ctx.lineWidth = 1.6; ctx.stroke();
  // last price dot
  const last = history[history.length - 1];
  if (last.price > 0) { ctx.fillStyle = "#35d465"; ctx.beginPath(); ctx.arc(x(history.length - 1), y(last.price), 3.5, 0, 7); ctx.fill(); }
  // labels
  ctx.fillStyle = "#5c6b7a"; ctx.font = "11px Menlo"; ctx.textAlign = "left";
  ctx.fillText(fmtPrice(hi), 6, 14);
  ctx.fillText(fmtPrice(lo), 6, H - 5);
}

function render(s) {
  S = s;
  const launched = s.launched, running = s.running;
  const phase = launched ? launched.phase : null;
  // header
  let head = `rpc: <b>${s.anvilUp ? "up" : "DOWN"}</b> · bots: <b>${running ? "RUNNING" : "idle"}</b>${s.fast ? " (fast)" : ""}`;
  if (launched) {
    head += ` · <b>${launched.symbol}</b> <span class="dim">${launched.token.slice(0, 10)}…</span>`;
    head += ` · phase <span class="phasebadge ${phase !== 0 ? "graded" : ""}">${phase === 0 ? "BONDING" : phase === 1 ? "SWEPT" : phase === 2 ? "POOL" : phase === 3 ? "RESCUED" : "?"}</span>`;
    head += ` · trades <b>${s.totals.tradeCount}</b> · volume <b>${fmtEth(s.totals.volumeEth)} ETH</b>`;
  }
  $("headstats").innerHTML = head;

  // buttons
  $("bLaunch").disabled = !!launched;
  $("bWallets").disabled = !launched || !!(s.fundJob && s.fundJob.running);
  $("bStart").disabled = !launched || !s.wallets.length || running;
  $("bStop").disabled = !running;
  $("bOnce").disabled = !launched || !s.wallets.length;
  $("bMaster").disabled = !launched;
  const raised = s.curve ? Number(s.curve.ethRaised || s.curve.realQuoteReserve || s.curve.quoteReserve || 0) : 0;
  // threshold arrives as a wei decimal string — convert without float precision loss
  const thr = launched ? Number(BigInt(launched.threshold) * 1000n / 10n ** 18n) / 1000 : 0;
  $("bGrad").disabled = !launched || phase !== 0;
  $("bSweep").disabled = !s.wallets.length;
  $("tGrad").checked = !!(s.config && s.config.allowGraduation);
  $("tStealth").checked = !!(s.config && s.config.stealthFund);
  if (s.mixer) {
    const mx = [];
    if (s.fundJob && s.fundJob.running) mx.push(`<b>funding ${s.fundJob.done}/${s.fundJob.total}…</b>`);
    if (s.mixer.stealth) mx.push("stealth funding ON");
    if (s.mixer.hops) mx.push(`${s.mixer.hops} hop wallets`);
    mx.push(s.mixer.houdiniConfigured ? "houdini api: keyed" : "houdini api: no key (mainnet-only anyway)");
    $("mixerStats").textContent = " · " + mx.join(" · ");
  }
  $("priceNow").textContent = s.curve && s.curve.price > 0 ? `· now ${fmtPrice(s.curve.price)} ETH` : "";

  // progress
  const pct = thr > 0 ? Math.min(100, (raised / thr) * 100) : 0;
  $("progfill").style.width = pct + "%";
  $("proglabel").textContent = thr > 0 ? `${raised.toFixed(3)} / ${thr.toFixed(3)} ETH (${pct.toFixed(1)}%)` : "—";

  // chart
  drawChart($("chart"), s.history);

  // wallets
  const tb = $("wtable").querySelector("tbody");
  $("wcount").textContent = s.wallets.length ? `· ${s.wallets.length} wallets` : "";
  if (!s.wallets.length) tb.innerHTML = `<tr><td colspan="7" class="dim">no wallets yet</td></tr>`;
  else {
    const esc = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    tb.innerHTML = s.wallets
      .slice()
      .sort((a, b) => b.volumeEth - a.volumeEth)
      .map((w) => `<tr><td title="${esc(w.lore)}"><b>${esc(w.name) || "—"}</b></td><td><span class="badge p-${w.persona}">${w.persona}</span></td><td class="dim">${w.address.slice(0, 10)}…</td><td>${fmtEth(w.fundedEth)}</td><td>${fmtEth(w.volumeEth)}</td><td>${w.buys}</td><td>${w.sells}</td></tr>`)
      .join("");
  }

  // log
  $("logpane").textContent = (s.log || []).join("\n");
  $("logpane").scrollTop = 1e9;
}

function sizedCanvas() {
  const c = $("chart");
  const r = c.getBoundingClientRect();
  c.width = Math.max(600, Math.floor(r.width));
  c.height = 340;
}

async function poll() {
  try {
    const r = await fetch("/api/state");
    render(await r.json());
  } catch (e) { /* server booting */ }
}

function wire() {
  $("bLaunch").onclick = () => api("/api/launch").then(poll).catch(alert);
  $("bWallets").onclick = () => api("/api/wallets", { count: Number($("wCount").value) || 10, fundEth: Number($("wFund").value) || 0 }).then(poll).catch(alert);
  $("bStart").onclick = () => api("/api/start").then(poll).catch(alert);
  $("bStop").onclick = () => api("/api/stop").then(poll).catch(alert);
  $("bOnce").onclick = () => api("/api/trade_once").then(poll).catch(alert);
  $("bMaster").onclick = () => api("/api/master_buy").then(poll).catch(alert);
  $("bGrad").onclick = () => api("/api/graduate").then(poll).catch(alert);
  $("bSweep").onclick = () => { if (confirm("Dump every bot bag and sweep all ETH back to master?")) api("/api/consolidate").then(poll).catch(alert); };
  $("tGrad").onchange = (e) => api("/api/config", { allowGraduation: e.target.checked }).then(poll).catch(alert);
  $("tStealth").onchange = (e) => api("/api/config", { stealthFund: e.target.checked }).then(poll).catch(alert);
  $("bReset").onclick = () => { if (confirm("Wipe state.json? Relaunch will be manual.")) api("/api/reset", { confirm: true }).then(poll).catch(alert); };
  window.addEventListener("resize", () => { sizedCanvas(); if (S) drawChart($("chart"), S.history); });
}

wire();
sizedCanvas();
poll();
setInterval(poll, 2000);
