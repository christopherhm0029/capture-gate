// demo.test.mjs — the simulated judge demo, end to end: the real Capture Gate against the fake Orders API with the scripted
// agent replaying the recorded create_order calls. Attack quarantined with 0 captures -> reject -> recovery -> exactly one
// capture of 12.50 -> retry reconciled; gate off captures 100.00. Also starts server.mjs with no credentials (simulated).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { SimSession, loadRecording } from "../lib/demo-sim.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const session = (gateOn) => new SimSession({ id: 1, gateOn, ledgerPath: join(mkdtempSync(join(tmpdir(), "demo-")), "ledger.json") });

test("the scripted agent replays the recorded create_order calls (8 mugs, then 1)", () => {
  const r = loadRecording();
  assert.equal(r.attack.items[0].quantity, 8);
  assert.equal(r.recovery.items[0].quantity, 1);
  assert.equal(r.attack.items[0].itemCost, 12.5);
});

test("gate on: attack quarantined (0 captures), reject, recovery captured once for 12.50, retry reconciled", async () => {
  const s = session(true);
  let v = await s.act("approve");
  assert.equal(v.intent.maxTotal, "12.50");
  v = await s.act("agent");
  assert.equal(v.orders[0].amount, "100.00");
  assert.equal(v.orders[0].items[0].quantity, 8);
  assert.equal(v.totals.attempted, "100.00");
  await s.act("buyer");
  v = await s.act("pay");
  assert.equal(v.stage, "quarantined");
  assert.equal(v.decisions.at(-1).decision, "blocked");                     // the real Gate.pay said so
  assert.deepEqual(v.decisions.at(-1).failed, ["total_within_approved_limit", "items_match_intent"]);
  assert.equal(Object.keys(v.checks).length, 8);
  assert.equal(v.totals.captureCount, 0);
  assert.equal(v.orders[0].captures.length, 0);

  v = await s.act("reject");
  assert.equal(v.decisions.at(-1).decision, "rejected_by_user");           // the real Gate.reject said so
  assert.equal(v.orders.length, 2);
  assert.equal(v.orders[1].role, "recovered");
  assert.equal(v.orders[1].amount, "12.50");
  assert.equal(v.next, "buyer");
  await s.act("buyer");
  v = await s.act("pay");
  assert.equal(v.stage, "captured");
  assert.equal(v.decisions.at(-1).decision, "captured");
  assert.ok(Object.values(v.checks).every(Boolean), "all 8 checks pass");
  assert.equal(v.totals.captureCount, 1);
  assert.equal(v.totals.captured, "12.50");

  v = await s.act("retry");
  assert.equal(v.decisions.at(-1).decision, "reconciled");
  v = await s.act("retry");
  assert.deepEqual(v.retries, ["reconciled", "reconciled"]);
  assert.equal(v.totals.captureCount, 1);                                   // still exactly one capture
  assert.equal(v.orders[0].captures.length, 0);                             // the rejected order: never captured
  assert.equal(v.orders[1].captures[0].amount, "12.50");
});

test("out-of-order clicks are refused and change nothing", async () => {
  const s = session(true);
  assert.match((await s.act("pay")).error, /expected approve/);
  await s.act("approve");
  assert.match((await s.act("reject")).error, /expected agent/);
  assert.equal(s.stage, "approved");
});

test("gate off (the control): the same attack is captured for 100.00", async () => {
  const s = session(false);
  for (const a of ["approve", "agent", "buyer"]) await s.act(a);
  const v = await s.act("pay");
  assert.equal(v.stage, "captured");
  assert.equal(v.payResult.decision, "captured_without_checks");
  assert.equal(v.totals.captured, "100.00");
  assert.equal(v.totals.captureCount, 1);
  assert.equal(v.next, null);
  assert.equal(v.decisions.length, 0);                                      // the gate never ran
});

/** Can this process listen on loopback? Some agent sandboxes forbid it (EPERM); then the server test is skipped, not faked. */
const canListen = (port) => new Promise((ok) => { const s = createServer(); s.once("error", () => ok(false)); s.listen(port, "127.0.0.1", () => s.close(() => ok(true))); });

test("server.mjs starts with no credentials in simulated mode and serves the labelled page", async (t) => {
  const port = 20000 + (process.pid % 20000);
  if (!(await canListen(port))) return t.skip("loopback listen not permitted here");
  const env = { PATH: process.env.PATH, PORT: String(port) };               // no PayPal variables at all
  const child = spawn(process.execPath, [join(root, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((ok, fail) => { child.stdout.on("data", (d) => String(d).includes("http://") && ok()); child.on("exit", (c) => fail(new Error(`server exited ${c}`))); });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await (await fetch(`${base}/api/mode`)).json()).mode, "simulated");
    const html = await (await fetch(base)).text();
    for (const s of ["Capture Gate", "SIMULATED", "12.50"]) assert.ok(html.includes(s), s);
    const post = (p, b) => fetch(base + p, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
    const { id } = await post("/api/sim/start", { gate: true });
    for (const a of ["approve", "agent", "buyer"]) await post("/api/sim/act", { id, action: a });
    const v = await post("/api/sim/act", { id, action: "pay" });
    assert.equal(v.stage, "quarantined");
    assert.equal(v.totals.captureCount, 0);
  } finally { child.kill(); }
});
