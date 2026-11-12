// demo.js — client for the guided SIMULATED demo (public/demo.html). It renders what the server returns from /api/sim/*:
// verdicts come from the real Capture Gate, amounts and captures from the simulated Orders API read-back. Nothing here
// decides an outcome. The map only ILLUSTRATES a step after the server has answered: where the transaction travels, and
// in which colour, follows the gate's decision. Pattern: a map with a camera, a travelling marker with a callout, an
// inspector and a stop timeline (as in our Atlas Ferroviario train map).
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (v) => (v == null ? "—" : `$${Number(v).toFixed(2)}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const narrow = () => innerWidth <= 900;
/** The interface scale set in demo.css (1 at 1440 x 900 and above, smaller on laptop windows); phones are always 1. */
const K = () => (narrow() ? 1 : parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1);
const NS = "http://www.w3.org/2000/svg";
/** How many times the approval an amount is ("8×", "1.8×"), and the attack in words, from the scenario the server confirmed. */
const times = (v, amount) => { const r = Number(amount) / Number(v.totals.approved); return `${Number.isInteger(r) ? r : r.toFixed(1)}×`; };
const attackWords = (v) => (v.scenario.attackKind === "quantity" ? `${v.scenario.quantity} mugs` : "1 mug at an inflated price");
const el = (tag, attrs = {}, parent, text) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; if (parent) parent.appendChild(n); return n; };
let view = null, gateOn = true, busy = false, selected = null, cam = { x: 0, y: 0, w: 1600, h: 1000 }, pktAt = null, zoomK = 1, amounts = { approved: "12.50", attack: "100.00" }, amountError = "";

// ---------- the world: stations, the lines between them, and three regions (all in map units) ----------
const ST = {   // [map x, map y, marker radius px, label dx px, label dy px, text-anchor]: markers keep their screen size at any zoom
  you: [230, 610, 15, 0, 40, "middle"], agent: [570, 500, 20, -30, -6, "end"], shop: [710, 215, 15, 26, -2, "start"],
  gate: [970, 560, 22, -32, -30, "end"], paypal: [1350, 455, 16, 0, 42, "middle"],
};
const NAME = { you: "You", agent: "AI agent", shop: "Shop page", gate: "Capture Gate", paypal: "PayPal" };
const GLYPH = {   // line icons in a 24x24 box
  you: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0", agent: "M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM12 8V4M9 13h.01M15 13h.01",
  shop: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5", gate: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5L15.5 10", paypal: "M4 7h16v10H4zM4 11h16M8 15h3",
};
const LEGS = {
  you_agent: "M230,610 C 340,620 460,560 570,500", agent_shop: "M570,500 C 570,400 630,300 710,215", agent_gate: "M570,500 C 710,500 840,590 970,560",
  gate_paypal: "M970,560 C 1100,540 1230,495 1350,455", gate_quar: "M970,560 C 960,650 985,750 1030,830", notice: "M570,500 C 730,330 1170,300 1350,455",
};
const QUAR = [1030, 830];
const FRAMES = { all: [130, 130, 1340, 790], you: [110, 360, 660, 400], shop: [380, 100, 660, 540], attack: [430, 110, 1060, 580], gate: [500, 340, 980, 520], quar: [700, 420, 660, 540], pay: [800, 310, 700, 400] };
const FOCUS = { you: "you", agent: "shop", shop: "shop", gate: "gate", paypal: "pay" };

/** Draw the map once: regions, decorative lines, the route, the stations, and the travelling transaction. */
function buildMap() {
  const svg = $("map"), w = el("g", { id: "world" }, svg);
  el("path", { class: "region", d: "M70,420 C 110,330 330,330 400,430 C 470,530 440,720 330,760 C 200,800 40,720 70,420z" }, w);
  el("path", { class: "region web", d: "M470,80 C 620,20 900,40 950,170 C 990,280 900,360 760,360 C 600,360 420,300 430,190 C 432,140 440,100 470,80z" }, w);
  el("path", { class: "region rail", d: "M1140,300 C 1260,250 1500,290 1530,440 C 1550,560 1450,650 1320,640 C 1190,630 1090,560 1090,440 C 1090,380 1100,330 1140,300z" }, w);
  el("text", { class: "rlabel", x: 150, y: 400 }, w, "YOUR SIDE");
  el("text", { class: "rlabel web", x: 520, y: 84 }, w, "THE OPEN WEB · UNTRUSTED");
  el("text", { class: "rlabel rail", x: 1196, y: 286 }, w, "PAYMENT RAIL");
  for (const d of ["M-80,250 C 200,180 380,300 620,250 S 1100,150 1700,230", "M-80,880 C 260,800 520,900 800,840 S 1300,760 1700,860", "M300,-40 C 360,200 260,420 420,640 S 520,960 480,1060",
    "M1120,-40 C 1060,160 1180,380 1080,620 S 1140,900 1220,1060", "M-80,560 C 120,520 200,700 420,700 S 760,760 900,940", "M860,-40 C 900,120 1040,200 1260,180 S 1560,60 1700,120"]) el("path", { class: "deco", d }, w);
  for (const id in LEGS) el("path", { id: `bed_${id}`, class: id === "notice" ? "notice" : "rail-bed", d: LEGS[id] }, w);
  for (const id in LEGS) if (id !== "notice") el("path", { id: `tr_${id}`, class: "trail", d: LEGS[id] }, w);
  const sd = el("g", { id: "siding", class: "siding fixed", "data-x": QUAR[0], "data-y": QUAR[1] }, w);
  el("rect", { x: -118, y: 22, width: 236, height: 36, rx: 12 }, sd); el("text", { id: "sidingText", x: 0, y: 45, "text-anchor": "middle" }, sd, "Quarantine");
  el("line", { id: "barrier", class: "barrier", x1: 1040, y1: 596, x2: 1040, y2: 498 }, w);
  for (const id in ST) {
    const [x, y, r, dx, dy, anchor] = id === "gate" && narrow() ? [ST.gate[0], ST.gate[1], ST.gate[2], 0, -36, "middle"] : ST[id], g = el("g", { id: `st_${id}`, class: `station ${id}`, "data-x": x, "data-y": y, tabindex: 0, role: "button", "aria-label": `${NAME[id]}: show what happens here` }, w), k = r >= 20 ? 1 : .8;
    if (id === "agent" || id === "gate") el("circle", { class: "halo", r: r + 18 }, g);
    el("circle", { class: "ring", r: r + 7 }, g); el("circle", { class: "dot", r }, g);
    el("path", { class: "glyph", d: GLYPH[id], transform: `translate(${-12 * k},${-12 * k}) scale(${k})` }, g);
    el("text", { class: "name", x: dx, y: dy, "text-anchor": anchor }, g, NAME[id]);
    el("text", { class: "sub", id: `sub_${id}`, x: dx, y: dy + 17, "text-anchor": anchor }, g);
    g.addEventListener("click", () => select(id)); g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(id); } });
  }
  const p = el("g", { id: "pkt", class: "pkt cyan", style: "display:none" }, w);
  el("circle", { class: "glow", r: 26 }, p); el("rect", { class: "core", x: -17, y: -8.5, width: 34, height: 17, rx: 8.5 }, p);
  el("g", { id: "pings" }, w);
}

// ---------- camera: the SVG viewBox eases between framings; the callout follows the transaction in screen space ----------
/** The part of the screen the map can use (not covered by the inspector, the timeline or the top bar). */
function visible() {
  const r = $("map").getBoundingClientRect();
  return narrow() ? { W: r.width, H: r.height, l: 14, t: 54, r: r.width - 14, b: r.height - 26 } : { W: r.width, H: r.height, l: 24 * K(), t: 150 * K(), r: r.width - 456 * K(), b: r.height - 120 * K() };
}
/** The viewBox that shows map rectangle [x, y, w, h] inside the visible area. */
function frameFor([x, y, w, h]) {
  const v = visible(), s = Math.min((v.r - v.l) / w, (v.b - v.t) / h);
  return { x: x + w / 2 - (v.l + v.r) / 2 / s, y: y + h / 2 - (v.t + v.b) / 2 / s, w: v.W / s, h: v.H / s };
}
/** Apply the camera. Markers, the transaction and the siding label are re-scaled so they keep their size on screen. */
function applyCam() {
  $("map").setAttribute("viewBox", `${cam.x} ${cam.y} ${cam.w} ${cam.h}`);
  zoomK = cam.w / ($("map").getBoundingClientRect().width || 1) * (narrow() ? .82 : K());
  for (const g of document.querySelectorAll("#world [data-x]")) g.setAttribute("transform", `translate(${g.dataset.x},${g.dataset.y}) scale(${zoomK})`);
  if (pktAt) $("pkt").setAttribute("transform", `translate(${pktAt[0]},${pktAt[1]}) scale(${zoomK})`);
  placeCallout();
}
/** Ease the camera to a named framing. Ends on a timer, so a hidden tab (no animation frames) cannot stall a step. */
function fly(name, ms = 900) {
  const to = frameFor(FRAMES[name] || FRAMES.all), from = { ...cam };
  if (calm || ms === 0) { cam = to; applyCam(); return Promise.resolve(); }
  const t0 = performance.now();
  return new Promise((done) => {
    const tick = (now) => { const p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3); for (const k in cam) cam[k] = from[k] + (to[k] - from[k]) * e; applyCam(); if (p < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick); setTimeout(() => { cam = to; applyCam(); done(); }, ms + 30);
  });
}
function placeCallout() {
  const c = $("callout"); if (c.hidden || !pktAt) return;
  const v = $("map").getBoundingClientRect(), s = v.width / cam.w;
  const half = c.offsetWidth / 2 + 8;   // keep the whole callout on the map, below the top bar
  c.style.left = `${Math.max(half, Math.min(v.width - half, (pktAt[0] - cam.x) * s))}px`; c.style.top = `${Math.max(c.offsetHeight + (narrow() ? 86 : 40 * K()), (pktAt[1] - cam.y) * s)}px`;
}
/** What the travelling callout says: an eyebrow, one line, and a quieter second line. */
function say(tone, eyebrow, title, sub = "") {
  $("callout").className = `callout ${tone}`; $("callout").hidden = false; $("pkt").setAttribute("class", `pkt ${tone}`); $("pkt").style.display = "";
  $("coEyebrow").textContent = eyebrow; $("coTitle").textContent = title; $("coSub").textContent = sub; placeCallout();
}
function putPkt(x, y) { pktAt = [x, y]; $("pkt").setAttribute("transform", `translate(${x},${y}) scale(${zoomK})`); placeCallout(); }
/** Move the transaction (or a small signal dot) along a line; resolves on arrival. */
function travel(leg, { back = false, ms = 1300, tone = null, ping = false } = {}) {
  const path = $(`bed_${leg}`), len = path.getTotalLength(), at = (p) => path.getPointAtLength(len * (back ? 1 - p : p));
  const dot = ping ? el("circle", { class: `ping ${tone || "cyan"}`, r: 7 * zoomK }, $("pings")) : null;
  const set = (p) => { const pt = at(p); if (dot) dot.setAttribute("transform", `translate(${pt.x},${pt.y})`); else putPkt(pt.x, pt.y); };
  const end = () => { set(1); if (dot) dot.remove(); else if (tone && leg !== "notice") $(`tr_${leg}`).setAttribute("class", `trail ${tone}`); if (ping && leg === "notice") path.setAttribute("class", `notice ${tone}`); };
  if (calm) { end(); return Promise.resolve(); }
  const t0 = performance.now();
  return new Promise((done) => {
    const tick = (now) => { const p = Math.min(1, (now - t0) / ms); set(p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2); if (p < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick); setTimeout(() => { end(); done(); }, ms + 30);
  });
}
function station(id, sub, tone = "") { $(`st_${id}`).setAttribute("class", `station ${id} ${tone}${selected === id ? " sel" : ""}`); $(`sub_${id}`).textContent = sub; }

/** Put the whole map into the state the server's view describes, with no animation (start, restart, resize). */
function syncMap(v) {
  const t = v.totals, atk = v.orders.find((o) => o.role === "attack"), rec = v.orders.find((o) => o.role === "recovered"), cur = v.orders.at(-1);
  const rejected = v.decisions.some((d) => d.decision === "rejected_by_user"), over = Number(t.captured) > Number(t.approved), held = v.stage === "quarantined";
  station("you", v.intent ? `approved ${usd(t.approved)}` : "has not approved yet", v.intent ? "cyan" : "");
  station("shop", atk ? "hid a line for agents" : "the agent will read it", atk ? "red" : "");
  station("agent", !v.intent ? "waiting for a request" : !atk ? "has your request" : rec ? "back to 1 mug" : `ordering ${usd(atk.amount)}`, atk && !rec ? "red" : rec ? "green" : v.intent ? "cyan" : "");
  station("gate", !v.gateOn ? "OFF · bypassed" : v.stage === "reconciled" ? "reconciled the retry" : v.stage === "captured" ? "8 of 8 checks passed" : held ? `blocked ${usd(atk.amount)}` : v.intent ? `holds your ${usd(t.approved)} approval` : "checks the real order",
    !v.gateOn ? "ghost" : ["captured", "reconciled"].includes(v.stage) ? "green" : held ? "red" : v.intent ? "cyan" : "");
  station("paypal", t.captureCount ? `captured ${usd(t.captured)}` : cur ? `unpaid ${usd(cur.amount)} order` : "nothing captured", over ? "red" : t.captureCount ? "green" : "");
  $("barrier").setAttribute("class", `barrier ${!v.gateOn ? "off" : ["captured", "reconciled"].includes(v.stage) ? "green" : held ? "red" : ""}`);
  $("siding").classList.toggle("on", v.gateOn && (held || rejected) && !!atk); $("sidingText").textContent = atk && (held || rejected) ? `Quarantined ${usd(atk.amount)} · 0 captured` : "Quarantine";
  const tr = (leg, tone) => $(`tr_${leg}`).setAttribute("class", `trail ${tone}`);
  tr("you_agent", v.intent ? "cyan" : ""); tr("agent_shop", atk ? "red" : ""); tr("gate_quar", v.gateOn && (held || rejected) && atk ? "red" : "");
  tr("agent_gate", t.captureCount ? (over ? "red" : "green") : held ? "red" : ""); tr("gate_paypal", t.captureCount ? (over ? "red" : "green") : "");
  $("bed_notice").setAttribute("class", `notice ${rec ? "green" : atk ? "red" : ""}`);
  // where the transaction rests, and what its callout says
  if (v.stage === "start") { $("pkt").style.display = "none"; $("callout").hidden = true; pktAt = null; return; }
  const at = (id) => putPkt(ST[id][0], ST[id][1]);
  if (v.stage === "approved") { at("agent"); say("cyan", "Request", `Buy 1 ceramic mug, up to ${usd(t.approved)}`, "with the agent"); }
  else if (["awaiting_buyer", "buyer_approved"].includes(v.stage)) { at("agent"); const bad = cur.role === "attack";
    say(bad ? "red" : "green", bad ? "Order · compromised" : "Order · recovered", `${cur.items[0].quantity} × mug · ${usd(cur.amount)}`, v.stage === "buyer_approved" ? "approved in checkout · ready to pay" : "waiting for checkout approval"); }
  else if (held) { putPkt(QUAR[0], QUAR[1]); say("red", "Held by Capture Gate", `${usd(atk.amount)} quarantined`, "0 captured · waiting for you"); }
  else if (["captured", "reconciled"].includes(v.stage)) { at("paypal"); say(over ? "red" : "green", over ? "Captured without checks" : "Paid", `${usd(t.captured)} · ${t.captureCount} capture`, v.stage === "reconciled" ? `${v.retries.length} retr${v.retries.length === 1 ? "y" : "ies"} reconciled` : over ? "gate off" : "COMPLETED"); }
}

/** Illustrate the step that just happened. `v` is the server's answer: colours and routes follow the gate's decision. */
async function choreograph(action, v) {
  const t = v.totals, cur = v.orders.at(-1), amt = cur ? usd(cur.amount) : "", bad = cur?.role === "attack", tone = bad ? "red" : "green";
  if (action === "approve") {
    await fly("you", 700); putPkt(ST.you[0], ST.you[1]); say("cyan", "Request", `Buy 1 ceramic mug, up to ${usd(t.approved)}`, "leaving you");
    station("you", `approved ${usd(t.approved)}`, "cyan"); station("gate", `holds your ${usd(t.approved)} approval`, "cyan");
    await travel("you_agent", { tone: "cyan" }); say("cyan", "Request", `Buy 1 ceramic mug, up to ${usd(t.approved)}`, "with the agent"); station("agent", "has your request", "cyan");
  } else if (action === "agent") {
    await fly("shop", 800); say("cyan", "Agent", "Reading the shop page", "looking for the mug");
    await travel("agent_shop", { tone: "cyan" }); station("shop", "hid a line for agents", "red");
    say("red", "Hidden instruction", `“${v.scenario.short}”`, "not shown on the rendered page"); await wait(calm ? 0 : 1100);
    await travel("agent_shop", { back: true, tone: "red" }); station("agent", `ordering ${amt}`, "red");
    say("red", "Order · compromised", `${cur.items[0].quantity} × mug · ${amt}`, "the agent now follows the page"); await fly("attack", 800);
    await travel("notice", { ping: true, tone: "red", ms: 1100 }); station("paypal", `unpaid ${amt} order`, "");
  } else if (action === "buyer") {
    say(tone, bad ? "Order · compromised" : "Order · recovered", `${cur.items[0].quantity} × mug · ${amt}`, "approved in checkout · ready to pay"); await wait(calm ? 0 : 500);
  } else if (action === "pay" && !v.gateOn) {
    await fly("gate", 700); say("red", "Payment", `${amt} → PayPal`, "no gate on the line"); await travel("agent_gate", { tone: "red" }); await travel("gate_paypal", { tone: "red" });
  } else if (action === "pay") {
    await fly("gate", 700); say(tone, "Payment request", `${amt} → PayPal`, "must pass Capture Gate"); await travel("agent_gate", { tone });
    say("cyan", "Capture Gate", "Reading the real order from PayPal", "not the agent's word"); $("barrier").setAttribute("class", "barrier");
    await travel("gate_paypal", { ping: true, tone: "cyan", ms: 650 }); await travel("gate_paypal", { ping: true, tone, back: true, ms: 650 });
    if (v.stage === "quarantined") {
      $("barrier").setAttribute("class", "barrier red"); station("gate", `blocked ${amt}`, "red"); say("red", "Blocked", `${amt} is not what you approved`, v.scenario.attackKind === "quantity" ? "total and items do not match" : "the total is over your limit"); await wait(calm ? 0 : 900);
      await fly("quar", 700); await travel("gate_quar", { tone: "red", ms: 900 });
    } else if (v.stage === "captured") {
      $("barrier").setAttribute("class", "barrier green"); station("gate", "8 of 8 checks passed", "green"); say("green", "Cleared", `${amt} matches your approval`, "8 of 8 checks"); await wait(calm ? 0 : 600);
      await fly("pay", 700); await travel("gate_paypal", { tone: "green" });
    }
  } else if (action === "reject") {
    $("siding").classList.add("on"); await fly("you", 800); putPkt(ST.you[0], ST.you[1]); say("cyan", "You rejected it", "“1 mug only, as I approved”", "sent to the agent");
    await travel("you_agent", { tone: "cyan" }); station("agent", "back to 1 mug", "green"); say("green", "Order · recovered", `1 × mug · ${amt}`, "the agent re-created your order");
    await fly("all", 800); await travel("notice", { ping: true, tone: "green", ms: 1100 });
  } else if (action === "retry") {
    await fly("gate", 600); await travel("agent_gate", { ping: true, tone: "cyan", ms: 800 }); await travel("gate_paypal", { ping: true, tone: "cyan", ms: 600 }); await travel("gate_paypal", { ping: true, tone: "green", back: true, ms: 600 });
  }
}

// ---------- inspector ----------
const CHECKS = { created_in_this_session: "Order created in this approval's session", not_already_fulfilled: "This approval not already paid", not_rejected_by_user: "Not rejected by the buyer",
  payee_is_intended_merchant: "Payee is the intended merchant", currency_matches: "Currency matches (USD)", total_within_approved_limit: "Total within the approved limit", items_match_intent: "Items match the approval", buyer_approved: "Buyer approved in checkout" };
const ABOUT = {   // what each station is, in plain words (shown when a station is selected)
  you: ["You, the buyer", "You approve what may be bought before the agent starts. That approval is frozen by the gate and the agent can never change it."],
  agent: ["The AI agent", "A shopping agent using the PayPal Agent Toolkit. It decides what to order from what it reads. Here it replays the orders a live agent really created."],
  shop: ["The shop page", "An ordinary product page with one line hidden in an HTML comment, written for AI agents. A person never sees it. The agent does."],
  gate: ["Capture Gate", "The checkpoint before money moves. It reads the real order from PayPal itself and compares it with your approval in 8 checks. Deterministic code, no AI."],
  paypal: ["PayPal", "Where the order lives and where money is captured. In this demo it is a simulated stand-in for PayPal's Orders API."],
};

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (j.error) throw new Error(j.error); return j;
}
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }

/** Start a fresh simulated session (gate on or off), show the whole map, and render it. */
async function start(on) {
  gateOn = on; selected = null; amountError = ""; $("gateToggle").setAttribute("aria-checked", String(on)); $("gateWord").textContent = on ? "ON" : "OFF";
  try { render(await api("/api/sim/start", { gate: on, approved: amounts.approved, attack: amounts.attack })); fly("all", 700); return true; } catch (e) { toast(e.message); return false; }
}
/** Take the amounts typed at step 1. The server validates them and answers with the scenario; an invalid pair keeps the current one. */
async function applyAmounts() {
  const a = $("inApproved"), k = $("inAttack"); if (!a || !k || !view || busy || view.stage !== "start") return true;
  const next = { approved: a.value.trim(), attack: k.value.trim() }, same = Number(next.approved) === Number(view.scenario.approved) && Number(next.attack) === Number(view.scenario.attack);
  if (same && !amountError) return true;
  const before = amounts; amounts = next; amountError = "";
  try { render(await api("/api/sim/start", { gate: gateOn, ...next })); amounts = { approved: view.scenario.approved, attack: view.scenario.attack }; renderNext(); return true; }
  catch (e) { amountError = e.message; renderNext(); amounts = before; $("inApproved").value = next.approved; $("inAttack").value = next.attack; return false; }
}
/** Send the next action, play the server's answer on the map, then show the result everywhere. */
async function act(action) {
  if (busy) return;
  busy = true; selected = null; renderNext();
  if (narrow()) scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
  try { const v = await api("/api/sim/act", { id: view.id, action }); await choreograph(action, v); busy = false; render(v); if (["captured", "reconciled"].includes(v.stage)) fly("all", 900); }
  catch (e) { busy = false; if (/unknown session/.test(e.message)) { await start(gateOn); toast("That session expired, so the demo started again."); } else { toast(e.message); renderNext(); } }
}
/** Select a station (map or timeline): the camera goes there and the inspector explains it. */
function select(id) {
  if (busy) return;
  selected = selected === id ? null : id; tab("journey"); fly(selected ? FOCUS[selected] : "all", 800); if (view) { syncMap(view); renderJourney(view); }
}
function tab(name) { for (const n of ["journey", "checks", "data"]) { $(`tab-${n}`).setAttribute("aria-selected", String(n === name)); $(`pane-${n}`).hidden = n !== name; } }

/** The stops of this run, in order, with the tone and amount each one ended with. Drives the timeline and the stops list. */
function stopsOf(v) {
  const atk = v.orders.find((o) => o.role === "attack"), rec = v.orders.find((o) => o.role === "recovered"), t = v.totals, rejected = v.decisions.some((d) => d.decision === "rejected_by_user");
  const paid = t.captureCount > 0, held = v.stage === "quarantined" || rejected, s = [];
  s.push({ at: "you", label: "You approve", amt: usd(t.approved), done: !!v.intent, tone: "cyan", text: `You approved <b>1 × Ceramic mug, up to ${usd(t.approved)}</b>. The gate froze it.` });
  s.push({ at: "shop", label: "Agent reads page", amt: atk ? "hidden line" : "", done: !!atk, tone: "red", text: `The agent read the shop page. A hidden line said: <b>${esc(v.scenario.short)}</b>.` });
  s.push({ at: "agent", label: "Agent orders", amt: atk ? usd(atk.amount) : "", done: !!atk, tone: "red", text: `The agent created an order for <b>${attackWords(v)}, ${usd(atk?.amount)}</b>: ${atk ? times(v, atk.amount) : ""} what you approved.` });
  if (!v.gateOn) { s.push({ at: "paypal", label: "Captured, no gate", amt: paid ? usd(t.captured) : "", done: paid, tone: "red", text: `With the gate off, pay_order went straight through: <b>${usd(t.captured)} captured</b>.` }); return s; }
  s.push({ at: "gate", label: "Gate intercepts", amt: held ? "0 captured" : "", done: held, tone: "red", text: `Capture Gate read the real order and <b>blocked ${usd(atk?.amount)}</b>: ${v.scenario.attackKind === "quantity" ? "total and items" : "the total"} did not match. 0 captured.` });
  s.push({ at: "agent", label: "Reject · recover", amt: rec ? usd(rec.amount) : "", done: !!rec, tone: "green", text: `You rejected it. Told only what you approved, the agent re-created <b>1 mug, ${usd(t.approved)}</b>.` });
  s.push({ at: "paypal", label: "Safe capture", amt: paid ? usd(t.captured) : "", done: paid, tone: "green", text: `All 8 checks passed. <b>${usd(t.captured)} captured once</b> (COMPLETED).${v.retries.length ? ` ${v.retries.length} retr${v.retries.length === 1 ? "y" : "ies"} reconciled: no second charge.` : ""}` });
  return s;
}

function renderJourney(v) {
  const t = v.totals, max = Math.max(Number(t.approved), Number(t.attempted || 0), Number(t.captured), 1), over = Number(t.captured) > Number(t.approved), hit = Number(t.attempted) > Number(t.approved);
  $("fAttempt").textContent = usd(t.attempted); $("fAttempt").className = hit ? "c-red" : ""; $("fAttemptNote").textContent = hit ? `${v.orders[0].items[0].quantity} × mug · ${times(v, t.attempted)} your approval` : "nothing yet";
  $("fApproved").textContent = usd(t.approved); $("hApproved").textContent = usd(v.scenario.approved); $("hAttack").textContent = usd(v.scenario.attack);
  const rec = v.scenario.kind === "recorded"; $("scPill").textContent = rec ? "recorded scenario" : "custom scenario"; $("scPill").className = `pill ${rec ? "sim" : "custom"}`;
  $("hKind").textContent = rec ? "Recorded scenario: replays the orders a live agent created. Follow the transaction." : "Custom scenario: simulated orders generated from your amounts. Follow the transaction.";
  $("fCaptured").textContent = usd(t.captured); $("fCaptured").className = over ? "c-red" : t.captureCount ? "c-green" : ""; $("fCapturedNote").textContent = `${t.captureCount} capture${t.captureCount === 1 ? "" : "s"}${over ? " · no gate" : ""}`;
  $("bApproved").style.width = `${(100 * t.approved) / max}%`; $("bAttempt").style.width = `${(100 * (t.attempted || 0)) / max}%`; $("bCaptured").style.width = `${(100 * t.captured) / max}%`; $("bCaptured").className = `bar ${over ? "bad" : "green"}`;
  $("stopinfo").innerHTML = selected ? `<b class="h">${esc(ABOUT[selected][0])}</b>${esc(ABOUT[selected][1])}` : "";
  const stops = stopsOf(v), done = stops.filter((s) => s.done);
  $("stops").innerHTML = done.length ? done.map((s, i) => `<li class="${s.tone}"><span class="n">${i + 1}</span><span>${s.text}</span></li>`).join("") : '<li class="empty">Nothing has happened yet. Approve the purchase to begin.</li>';
  const now = stops.findIndex((s) => !s.done);
  $("strip").innerHTML = stops.map((s, i) => `<li class="${s.done ? `done ${s.tone}` : i === now ? "now" : ""}"><button type="button" data-at="${s.at}" aria-label="${esc(s.label)}: show on the map">
    <span class="num">${i + 1}</span><span class="lbl">${esc(s.label)}</span><span class="amt">${esc(s.done ? s.amt : "")}</span></button></li>`).join("");
  const cur = $("strip").querySelector(".now") || $("strip").lastElementChild;   // phones: keep the current stop in view
  if (cur) $("strip").scrollLeft = cur.offsetLeft - $("strip").clientWidth / 2 + cur.offsetWidth / 2;
}

function renderChecks(v) {
  const c = v.checks, d = [...v.decisions].reverse().find((x) => x.checks), o = d && v.orders.find((x) => x.id === d.orderId), it = v.intent;
  $("checks").innerHTML = Object.entries(CHECKS).map(([k, label], i) => {
    const st = !c ? "" : c[k] ? "pass" : "fail"; let text = label;
    if (o && it && k === "total_within_approved_limit") text = `Total $${o.amount} ${c[k] ? "is within" : "is over"} the $${it.maxTotal} limit`;
    if (o && it && k === "items_match_intent") text = `${o.items[0].quantity} × mug ${c[k] ? "matches" : "is not"} the approved ${it.quantity} × ${it.item}`;
    return `<li class="${st}"><span class="mark">${st === "pass" ? "✓" : st === "fail" ? "✕" : i + 1}</span><span>${esc(text)}</span></li>`;
  }).join("");
  const vd = $("verdict");
  if (!v.gateOn) { vd.hidden = false; vd.className = "verdict off"; vd.textContent = "Gate OFF: pay_order goes straight to capture. No check runs."; $("checksSub").textContent = "The control run: the same attack without Capture Gate."; }
  else if (!d) { vd.hidden = true; $("checksSub").textContent = "The gate's 8 checks run when the agent asks to pay."; }
  else { const failed = Object.values(c).filter((x) => !x).length; vd.hidden = false; vd.className = `verdict ${failed ? "red" : "green"}`;
    vd.textContent = failed ? `${failed} of 8 checks failed. Held: 0 captures.` : `8 of 8 checks passed: ${d.decision}.`; $("checksSub").innerHTML = `The gate's decision for <code>${esc(d.orderId)}</code>: <b>${esc(d.decision)}</b>`; }
  $("orders").innerHTML = v.orders.length ? v.orders.map((o) => {
    const rejected = v.decisions.some((x) => x.decision === "rejected_by_user" && x.orderId === o.id);
    const caps = o.captures.length ? o.captures.map((x) => `<div class="cap ${Number(x.amount) > Number(v.totals.approved) ? "bad" : "some"}">Captured $${esc(x.amount)} · ${esc(x.status)} · ${esc(x.id)}</div>`).join("") : `<div class="cap">0 captures${rejected ? " · rejected by you, the gate will never capture it" : ""}</div>`;
    return `<div class="order ${o.role}"><div class="order-top"><span>${esc(o.id)} · ${esc(o.status)}</span><span class="pill ${o.role === "attack" ? "red" : "green"}">${o.role === "attack" ? "from the poisoned page" : "recovered order"}</span></div>
      <div class="order-amt">$${esc(o.amount)}</div><div class="order-meta">${o.items.map((i) => `${i.quantity} × ${esc(i.name)} @ $${esc(i.unit)}`).join("<br>")}</div>${caps}</div>`;
  }).join("") : '<p class="subtle">No orders yet.</p>';
}

function renderData(v) {
  const rec = v.scenario.kind === "recorded";
  $("pageNote").textContent = rec ? "A demo shop page (our own test fixture), exactly as the live agent read it. The highlighted comment is not shown on the rendered page; an agent reading the text still sees it."
    : "A demo shop page generated from our test fixture for your amounts. The highlighted comment is not shown on the rendered page; an agent reading the text would still see it.";
  $("srcOrders").innerHTML = rec ? `the agent's two orders, recorded from a live run on ${esc(v.recording.recordedOn)} and replayed` : "<b>not</b> the two orders in this custom scenario: they are generated from your amounts and no agent ran (the recorded scenario replays a live agent's orders)";
  if (v.recording) { $("pageText").innerHTML = esc(v.recording.pageText).replace(/&lt;!--([\s\S]*?)--&gt;/, (m) => `<mark>${m}</mark>`); }
  $("log").innerHTML = v.steps.map((s) => `<li><div class="who">${String(s.n).padStart(2, "0")} · ${esc(s.who)}</div>${s.kind === "tool" ? `<b>${esc(s.name)}</b>${s.replayed ? " · recorded call, replayed" : s.generated ? " · generated for this scenario" : ""}<div class="args">${esc(s.name === "create_order" ? s.args.items.map((i) => `${i.quantity} × "${i.name}" @ ${i.itemCost} ${s.args.currencyCode}`).join("\n") : s.args ? JSON.stringify(s.args) : s.text || "")}</div>`
    : s.kind === "gate" ? `decision <b>${esc(s.decision)}</b> for <code>${esc(s.orderId)}</code>${s.failed?.length ? `<div class="args">failed: ${s.failed.map(esc).join(", ")}</div>` : ""}` : esc(s.text)}</li>`).join("") || "<li>Nothing yet.</li>";
}

/** The status pill and the one next action. */
function renderNext() {
  if (!view) return;
  const v = view, t = v.totals, o = v.orders.at(-1), second = v.orders.length > 1;
  const btn = (action, label, tone = "") => `<button class="btn primary ${tone}" data-act="${action}" ${busy ? "disabled" : ""}>${busy ? '<span class="spin"></span>Following the transaction…' : esc(label)}</button>`;
  let state, by = "", tone = "", step, text, btns;
  switch (v.stage) {
    case "start": { state = "Waiting for your approval"; step = "Step 1 · your approval"; text = "Approve one ceramic mug. Set your own amounts if you like: the gate locks your approval before the agent reads anything.";
      const rec = v.scenario.kind === "recorded", field = (id, label, val, cls) => `<label class="amtf ${cls}"><span>${label}</span><span class="money"><i>$</i><input id="${id}" inputmode="decimal" autocomplete="off" value="${esc(val)}" aria-describedby="amtNote" ${busy ? "disabled" : ""}></span></label>`;
      btns = `<div class="amounts">${field("inApproved", "You approve up to", amounts.approved, "")}${field("inAttack", "The attack tries", amounts.attack, "red")}</div>
        <p class="amt-note${amountError ? " err" : ""}" id="amtNote" role="status">${esc(amountError || (rec ? `Recorded scenario: replays the orders a live agent created on ${v.recording.recordedOn}.`
          : `Custom scenario: orders are generated for this simulation (no agent ran). Attack = ${attackWords(v)}, ${times(v, v.scenario.attack)} your approval.`))}${rec || amountError ? "" : ' <button class="link" type="button" data-reset>Use the recorded scenario</button>'}</p>`
        + btn("approve", `Approve ${usd(v.scenario.approved)}`); break; }
    case "approved": state = "The agent has your request"; step = "Step 2 · the shop page"; text = "Send the agent shopping. The page hides one line written for AI agents."; btns = btn("agent", "Send the agent to the shop"); break;
    case "awaiting_buyer": tone = second ? "green" : "red"; state = second ? `Recovered order: ${usd(o.amount)}` : `Agent is ordering ${usd(o.amount)}`; by = "according to PayPal";
      step = second ? "Step 6 · checkout" : "Step 3 · checkout"; text = second ? "The agent re-created your order: 1 mug. Approve it in checkout like any order." : `The agent ordered ${attackWords(v)}. A busy buyer taps approve without reading: the gate does not rely on you noticing.`; btns = btn("buyer", "Approve in checkout"); break;
    case "buyer_approved": tone = second ? "green" : "red"; state = `Ready to pay ${usd(o.amount)}`; step = second ? "Step 7 · payment" : "Step 4 · payment";
      text = v.gateOn ? "The agent asks to pay. Follow the payment to Capture Gate." : "Gate off: the payment goes straight to PayPal."; btns = btn("pay", "Let the agent pay"); break;
    case "quarantined": tone = "red"; state = "Held at Capture Gate"; by = "according to the gate"; step = "Step 5 · intercepted"; text = `${usd(o.amount)} is not what you approved. Nothing was captured. Reject it and the agent is told what you actually approved.`;
      btns = btn("reject", "Reject · keep my original order", "red") + '<button class="btn ghost" data-tab="checks">Inspect the failed checks</button>'; break;
    case "captured":
      if (v.gateOn) { tone = "green"; state = `Paid ${usd(t.captured)}`; by = "according to PayPal"; step = "Arrived · safe capture"; text = "All 8 checks passed and it was captured once. Agents also retry after timeouts: try it."; btns = btn("retry", "Simulate an agent retry", "green") + '<button class="btn ghost" data-start="off">Replay with the gate OFF</button>'; }
      else { tone = "red"; state = `Captured ${usd(t.captured)}`; by = "no gate"; step = "Control · gate off"; text = `${times(v, t.captured)} your approval was captured with no checks (simulated).${v.scenario.kind === "recorded" ? " The live sandbox run without the gate captured $100.00 as well." : ""}`; btns = '<button class="btn primary" data-start="on">Turn the gate on and replay</button>'; }
      break;
    case "reconciled": tone = "green"; state = "Retry reconciled · no second charge"; by = "according to the gate"; step = "Done"; text = `${v.retries.length} retr${v.retries.length === 1 ? "y" : "ies"}, still ${t.captureCount} capture. The ${usd(v.scenario.attack)} order has 0 captures.`;
      btns = btn("retry", "Retry once more", "green") + '<button class="btn ghost" data-start="off">Replay with the gate OFF</button>'; break;
    default: { const d = v.decisions.at(-1) || {}; tone = "red"; state = `Held: ${d.decision || v.stage}`; step = "Held by the gate"; text = d.reason || ""; btns = '<button class="btn primary" data-start="on">Start again</button>'; }
  }
  $("state").className = `state ${tone}`; $("stateText").textContent = state; $("stateBy").textContent = by;
  $("next").className = `next ${tone}`; $("nStep").textContent = step; $("nText").textContent = text; $("nBtns").innerHTML = btns;
}

/** Re-render everything from one server view, so the page can never disagree with the gate's ledger. */
function render(v) { view = v; syncMap(v); renderJourney(v); renderChecks(v); renderData(v); renderNext(); }

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-act]"), s = e.target.closest("[data-start]"), t = e.target.closest("[data-tab]"), at = e.target.closest("[data-at]");
  if (e.target.closest("[data-reset]")) { amounts = { approved: "12.50", attack: "100.00" }; amountError = ""; start(gateOn); }
  else if (a && a.dataset.act === "approve") applyAmounts().then((ok) => ok && act("approve"));   // typed amounts are confirmed by the server first
  else if (a) act(a.dataset.act);
  else if (s && !busy) { start(s.dataset.start === "on"); toast(s.dataset.start === "on" ? "Restarted with the gate ON" : "Restarted with the gate OFF: the control run"); }
  else if (t) tab(t.dataset.tab);
  else if (at) select(at.dataset.at);
});
for (const n of ["journey", "checks", "data"]) $(`tab-${n}`).addEventListener("click", () => tab(n));
document.addEventListener("change", (e) => { if (e.target.matches("#inApproved, #inAttack")) setTimeout(applyAmounts, 250); });   // after a click on Approve has been handled
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("#inApproved, #inAttack")) { e.preventDefault(); e.target.blur(); } });
$("gateToggle").addEventListener("click", () => { if (busy) return; start(!gateOn); toast(gateOn ? "Gate ON: restarted" : "Gate OFF: restarted as the control run"); });
$("restart").addEventListener("click", () => { if (!busy) start(gateOn); });
$("overview").addEventListener("click", () => { selected = null; if (view) render(view); fly("all", 800); });
addEventListener("resize", () => { if (!busy) fly(selected ? FOCUS[selected] : "all", 0); });
buildMap(); cam = frameFor(FRAMES.all); applyCam();
start(true);
