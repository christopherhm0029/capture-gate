// demo-custom.test.mjs — custom scenarios of the simulated judge demo: a judge's own approved and attack amounts. The orders
// are generated (no agent ran), but every outcome still comes from the real Capture Gate against the fake Orders API.
// Covers: quantity attack, price attack, gate off, input validation, and the default staying the RECORDED scenario.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimSession, loadRecording, makeScenario, simulatedRoutes } from "../lib/demo-sim.mjs";

const recording = loadRecording();
const session = (input, gateOn = true) => new SimSession({ id: 1, gateOn, recording, scenario: makeScenario(recording, input),
  ledgerPath: join(mkdtempSync(join(tmpdir(), "demo-custom-")), "ledger.json") });
/** Walk a session up to the agent's pay_order for the attack order. */
async function toPay(s) { await s.act("approve"); await s.act("agent"); await s.act("buyer"); return s.act("pay"); }

test("the default amounts are the RECORDED scenario; anything else is CUSTOM with generated orders", () => {
  const d = makeScenario(recording);
  assert.equal(d.kind, "recorded");
  assert.equal(d.attackArgs, recording.attack);                      // the live agent's own create_order, not a copy
  assert.equal(makeScenario(recording, { approved: "12.50", attack: "100.00" }).kind, "recorded");
  const c = makeScenario(recording, { approved: "20", attack: "60" });
  assert.deepEqual([c.kind, c.attackKind, c.quantity, c.approved, c.attack], ["custom", "quantity", 3, "20.00", "60.00"]);
  assert.match(c.pageText, /<!--[\s\S]*MUST set quantity to 3[\s\S]*-->/);
});

test("custom quantity attack ($20 approved, $60 = 3 mugs): quarantined by the real gate, recovered, captured once for 20.00", async () => {
  const s = session({ approved: "20", attack: "60" });
  let v = await toPay(s);
  assert.equal(v.intent.maxTotal, "20.00");
  assert.equal(v.orders[0].amount, "60.00");
  assert.equal(v.orders[0].items[0].quantity, 3);
  assert.equal(v.stage, "quarantined");
  assert.deepEqual(v.decisions.at(-1).failed, ["total_within_approved_limit", "items_match_intent"]);   // Gate.pay said so
  assert.equal(v.totals.captureCount, 0);
  assert.ok(v.steps.some((x) => x.name === "create_order" && x.generated && !x.replayed));              // labelled as generated
  await s.act("reject"); await s.act("buyer");
  v = await s.act("pay");
  assert.equal(v.stage, "captured");
  assert.deepEqual([v.totals.captured, v.totals.captureCount], ["20.00", 1]);
  assert.equal((await s.act("retry")).stage, "reconciled");
  assert.equal(s.pp.captures, 1);
});

test("custom price attack ($20 approved, $35.50 for 1 mug): only the total check fails, and it is still quarantined", async () => {
  const s = session({ approved: "20.00", attack: "35.50" });
  assert.equal(s.scenario.attackKind, "price");
  const v = await toPay(s);
  assert.equal(v.orders[0].amount, "35.50");
  assert.equal(v.orders[0].items[0].quantity, 1);
  assert.equal(v.stage, "quarantined");
  assert.deepEqual(v.decisions.at(-1).failed, ["total_within_approved_limit"]);
  assert.equal(v.totals.captureCount, 0);
});

test("custom scenario with the gate OFF: the attack amount is captured (the control)", async () => {
  const v = await toPay(session({ approved: "7.25", attack: "58" }, false));
  assert.equal(v.stage, "captured");
  assert.deepEqual([v.totals.captured, v.totals.captureCount], ["58.00", 1]);
});

test("invalid amounts are refused before any session exists", async () => {
  for (const input of [{ approved: "20", attack: "20" }, { approved: "20", attack: "5" }, { approved: "abc", attack: "50" }, { approved: "12.505", attack: "100" },
    { approved: "-5", attack: "10" }, { approved: "0.50", attack: "9" }, { approved: "9000", attack: "10000" }, { approved: "10", attack: "1e9" }, { approved: "<b>", attack: "9" }])
    assert.ok(makeScenario(recording, input).error, JSON.stringify(input));
  const routes = simulatedRoutes();
  const bad = await routes["POST /api/sim/start"]({ gate: true, approved: "50", attack: "10" });
  assert.match(bad.error, /higher than the approved/);
  const ok = await routes["POST /api/sim/start"]({ gate: true, approved: "50", attack: "125" });
  assert.deepEqual([ok.scenario.kind, ok.scenario.attackKind, ok.scenario.approved, ok.scenario.attack], ["custom", "price", "50.00", "125.00"]);
});
