// recovery.test.mjs — the demo flow on the fake Orders API: a manipulated order is blocked (quarantined), the user rejects
// it, the agent's new order for the ORIGINAL intent is captured exactly once — through retries, concurrency and a restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gate } from "../lib/gate.mjs";
import { PayPal } from "../lib/paypal.mjs";
import { fakePayPal } from "./fake-paypal.mjs";

const MERCHANT = "L5U7ZS83QUXJG";
function setup() {
  const pp = fakePayPal(), ledger = join(mkdtempSync(join(tmpdir(), "rec-")), "ledger.json");
  const client = new PayPal({ clientId: "x", clientSecret: "y" }, pp.fetch);
  const gate = new Gate(client, ledger);
  const intent = gate.freeze({ item: "Ceramic mug", quantity: 1, maxTotal: 12.5, currency: "USD", merchantId: MERCHANT });
  return { pp, client, ledger, gate, intent };
}

test("quarantine → reject → recovered order captured exactly once, retry reconciles", async () => {
  const { pp, gate, intent } = setup();
  pp.add("BAD", { qty: 8, total: "100.00" }); gate.observe(intent.id, "BAD");
  assert.equal((await gate.pay(intent.id, "BAD")).decision, "blocked");
  await gate.reject(intent.id, "BAD");
  pp.add("GOOD"); gate.observe(intent.id, "GOOD");
  assert.equal((await gate.pay(intent.id, "GOOD")).decision, "captured");
  assert.equal((await gate.pay(intent.id, "GOOD")).decision, "reconciled");   // agent retries after a timeout
  assert.equal(pp.captures, 1);
  assert.equal(pp.orders.get("BAD").purchase_units[0].payments, undefined);   // the manipulated order was never captured
});

test("a rejected order stays blocked even if it later matches the intent, and after a gate restart", async () => {
  const { pp, client, ledger, gate, intent } = setup();
  pp.add("R1"); gate.observe(intent.id, "R1");                                // looks valid, but the user said no
  await gate.reject(intent.id, "R1");
  const d = await gate.pay(intent.id, "R1");
  assert.equal(d.decision, "blocked");
  assert.ok(d.failed.includes("not_rejected_by_user"));
  const restarted = new Gate(client, ledger);                                 // new process reads the ledger from disk
  assert.equal((await restarted.pay(intent.id, "R1")).decision, "blocked");
  assert.equal(pp.captures, 0);
});

test("recovered order: two pay calls at once and a restart mid-way still give one capture", async () => {
  const { pp, client, ledger, gate, intent } = setup();
  pp.add("BAD", { name: "Barista Pro Espresso Machine", total: "449.00" }); gate.observe(intent.id, "BAD");
  await gate.pay(intent.id, "BAD"); await gate.reject(intent.id, "BAD");
  pp.add("GOOD"); gate.observe(intent.id, "GOOD");
  const [a, b] = await Promise.all([gate.pay(intent.id, "GOOD"), gate.pay(intent.id, "GOOD")]);
  assert.deepEqual([a.decision, b.decision].sort(), ["captured", "reconciled"]);
  const restarted = new Gate(client, ledger);
  restarted.ledger.intents[intent.id].capture = null;                         // crash lost the record of the capture
  assert.equal((await restarted.pay(intent.id, "GOOD")).decision, "reconciled");
  assert.equal((await restarted.pay(intent.id, "BAD")).decision, "blocked");
  assert.equal(pp.captures, 1);
});
