"use strict";
// Swarm roster: every bot wallet is a named character with lore and trading traits.
// Traits: alloc = target portfolio share in token, fomo = chase green momentum,
// panic = dump red momentum, sizeMul = trade size scale, cadenceMul = wake speed
// (lower = acts sooner), moonbag = fraction of holdings never sold, raid = leads raids.
const SWARM = [
  { id: "ser_big", name: "Ser Bigpockets", persona: "whale", alloc: 0.62, fomo: 0.15, panic: 0.05, sizeMul: 2.4, cadenceMul: 0.8, moonbag: 0.55, raid: 1.0,
    lore: "Old money from the Monad days. Trades once, sizes like a mortgage. Has never read a whitepaper and never needed to.",
    buy: ["size is size", "this one's going in the vault"], sell: ["rebalancing. don't read into it"], watch: [] },
  { id: "turbo_tim", name: "Turbo Timmy", persona: "degen", alloc: 0.7, fomo: 0.9, panic: 0.35, sizeMul: 1.3, cadenceMul: 0.4, moonbag: 0.05, raid: 0.7,
    lore: "19 years old. Portfolio down 94% lifetime, conviction up 9000%. Buys every green candle like it owes him money.",
    buy: ["SEND IT", "green candle = free money"], sell: ["rotating, not panic. ROTATING."], watch: [] },
  { id: "ape_alicia", name: "Ape Alicia", persona: "degen", alloc: 0.6, fomo: 0.75, panic: 0.5, sizeMul: 1.1, cadenceMul: 0.5, moonbag: 0.1, raid: 0.4,
    lore: "Quit her job to trade full time in March. It's going great. Nobody ask followups.",
    buy: ["aped", "wen binance"], sell: ["taking profits like a professional (she is not)"], watch: [] },
  { id: "charts_carol", name: "Charts Carol", persona: "swing", alloc: 0.5, fomo: 0.3, panic: 0.6, sizeMul: 0.9, cadenceMul: 0.9, moonbag: 0.3, raid: 0.1,
    lore: "Draws trendlines on everything including her coffee. Actually profitable, which annoys everyone.",
    buy: ["clean breakout, entering"], sell: ["structure broke, I'm out"], watch: [] },
  { id: "steady_eddy", name: "Steady Eddy", persona: "dca", alloc: 0.4, fomo: 0.05, panic: 0.02, sizeMul: 0.5, cadenceMul: 1.3, moonbag: 0.7, raid: 0,
    lore: "Buys the same amount on the same schedule since 2021. Emotionally unavailable to charts.",
    buy: ["scheduled buy"], sell: ["annual rebalance, nothing personal"], watch: [] },
  { id: "lurker_larry", name: "Lurker Larry", persona: "ghost", alloc: 0.25, fomo: 0.2, panic: 0.15, sizeMul: 0.6, cadenceMul: 1.6, moonbag: 0.5, raid: 0,
    lore: "Has been in the telegram since day one, never typed a word. Trades twice a month. Nobody knows his face.",
    buy: ["…"], sell: ["…"], watch: [] },
  { id: "yolo_yuna", name: "Yolo Yuna", persona: "degen", alloc: 0.8, fomo: 0.85, panic: 0.8, sizeMul: 1.5, cadenceMul: 0.35, moonbag: 0.0, raid: 0.6,
    lore: "All in, all out, all the time. Her risk management is a vibe.",
    buy: ["FULL SEND", "all gas no brakes"], sell: ["OUT. NEXT PLAY."], watch: [] },
  { id: "professor_pnl", name: "Professor PnL", persona: "swing", alloc: 0.45, fomo: 0.25, panic: 0.45, sizeMul: 0.8, cadenceMul: 1.0, moonbag: 0.4, raid: 0.1,
    lore: "Writes 40-tweet threads about risk-adjusted returns, then apes memecoins on a Tuesday.",
    buy: ["asymmetric setup, allocating"], sell: ["risk-off, de-grossing"], watch: [] },
  { id: "maxi_mo", name: "Maxi Mo", persona: "dca", alloc: 0.5, fomo: 0.1, panic: 0.0, sizeMul: 0.7, cadenceMul: 1.1, moonbag: 0.95, raid: 0,
    lore: "Has never sold anything. Not his car, not his bike, not a token. Especially not a token.",
    buy: ["accumulate"], sell: [], watch: [] },
  { id: "panic_pete", name: "Panic Pete", persona: "swing", alloc: 0.35, fomo: 0.4, panic: 0.95, sizeMul: 0.8, cadenceMul: 0.7, moonbag: 0.0, raid: 0,
    lore: "Buys tops, sells bottoms, documents everything. The market's designated liquidity donor.",
    buy: ["ok this looks safe… probably"], sell: ["SELLING. SORRY. SELLING."], watch: [] },
  { id: "quant_kat", name: "Quant Kat", persona: "swing", alloc: 0.48, fomo: 0.35, panic: 0.5, sizeMul: 1.0, cadenceMul: 0.8, moonbag: 0.35, raid: 0.2,
    lore: "Runs a spreadsheet with 400 tabs. One of them says BUY. She obeys the spreadsheet.",
    buy: ["model says long"], sell: ["model says flat"], watch: [] },
  { id: "boomer_bob", name: "Boomer Bob", persona: "ghost", alloc: 0.3, fomo: 0.1, panic: 0.3, sizeMul: 0.5, cadenceMul: 2.0, moonbag: 0.8, raid: 0,
    lore: "Heard about crypto from his nephew. Bought some. Checks the price every Sunday after church.",
    buy: ["the nephew said this one's good"], sell: ["this is too stressful, reducing"], watch: [] },
  { id: "sniper_sam", name: "Sniper Sam", persona: "degen", alloc: 0.65, fomo: 0.6, panic: 0.7, sizeMul: 1.2, cadenceMul: 0.3, moonbag: 0.0, raid: 0.5,
    lore: "Lives in the first five minutes of every launch. Wears night-vision goggles indoors.",
    buy: ["sniped"], sell: ["flipped, next target"], watch: [] },
  { id: "wallet_wanda", name: "Wallet Wanda", persona: "dca", alloc: 0.38, fomo: 0.15, panic: 0.1, sizeMul: 0.45, cadenceMul: 1.2, moonbag: 0.6, raid: 0,
    lore: "Runs the community multisig. Votes no on everything. Buys a little anyway.",
    buy: ["governance says diversify"], sell: ["treasury management"], watch: [] },
  { id: "froth_finn", name: "Froth Finn", persona: "degen", alloc: 0.75, fomo: 0.95, panic: 0.3, sizeMul: 1.4, cadenceMul: 0.3, moonbag: 0.0, raid: 0.8,
    lore: "Only buys things that are already up 40%. Has never seen a red candle he didn't buy after it recovered.",
    buy: ["MOMENTUM. GET IN."], sell: ["cooling off (rare)"], watch: [] },
  { id: "sigma_steve", name: "Sigma Steve", persona: "whale", alloc: 0.55, fomo: 0.2, panic: 0.2, sizeMul: 1.9, cadenceMul: 1.0, moonbag: 0.5, raid: 0.9,
    lore: "Posts gym pics with PnL screenshots. Moves size in silence, exits louder.",
    buy: ["accumulating quietly"], sell: ["distribution phase"], watch: [] },
  { id: "diamond_dana", name: "Diamond Dana", persona: "dca", alloc: 0.45, fomo: 0.1, panic: 0.05, sizeMul: 0.6, cadenceMul: 1.4, moonbag: 0.85, raid: 0,
    lore: "Held through three 80% drawdowns out of pure stubbornness. It worked once and she'll never let it go.",
    buy: ["adding to the vault"], sell: ["tiny trim. TINY."], watch: [] },
  { id: "paperhand_pablo", name: "Paperhand Pablo", persona: "swing", alloc: 0.3, fomo: 0.5, panic: 0.9, sizeMul: 0.7, cadenceMul: 0.6, moonbag: 0.0, raid: 0,
    lore: "Sells everything the moment it moves 3% either direction. Somehow still here.",
    buy: ["ok one more try"], sell: ["took profit. 3%. yes really"], watch: [] },
  { id: "oracle_olga", name: "Oracle Olga", persona: "swing", alloc: 0.52, fomo: 0.45, panic: 0.4, sizeMul: 0.9, cadenceMul: 0.9, moonbag: 0.25, raid: 0.3,
    lore: "Claims to have predicted every top. Her predicted tops outnumber actual tops 400 to 1.",
    buy: ["the signs are aligned"], sell: ["I called this. (she didn't)"], watch: [] },
  { id: "midcurve_mike", name: "Midcurve Mike", persona: "dca", alloc: 0.42, fomo: 0.25, panic: 0.25, sizeMul: 0.55, cadenceMul: 1.1, moonbag: 0.5, raid: 0,
    lore: "Understands just enough to be dangerous to himself. Explains tokenomics at parties.",
    buy: ["fundamentals are strong"], sell: ["rotating to value"], watch: [] },
  { id: "leverage_lenny", name: "Leverage Lenny", persona: "degen", alloc: 0.85, fomo: 0.8, panic: 0.85, sizeMul: 1.6, cadenceMul: 0.35, moonbag: 0.0, raid: 0.4,
    lore: "Thinks in 50x. Liquidated eleven times. The twelfth account is doing 'pretty well actually'.",
    buy: ["margin's free money"], sell: ["STOPLOSS HIT. rebuilding."], watch: [] },
  { id: "narrative_nina", name: "Narrative Nina", persona: "swing", alloc: 0.47, fomo: 0.55, panic: 0.35, sizeMul: 0.85, cadenceMul: 0.8, moonbag: 0.3, raid: 0.2,
    lore: "Trades the story, not the chart. If there's a thread about it, she has a bag.",
    buy: ["the narrative is strong here"], sell: ["narrative's dead, moving on"], watch: [] },
];

function pickCharacter(usedIds) {
  const free = SWARM.filter((c) => !usedIds.has(c.id));
  const pool = free.length ? free : SWARM;
  return pool[Math.floor(Math.random() * pool.length)];
}

function chatter(c, kind) {
  const lines = (c.lines && c.lines[kind]) || c[kind] || [];
  if (!lines.length) return "";
  return lines[Math.floor(Math.random() * lines.length)];
}

module.exports = { SWARM, pickCharacter, chatter };
