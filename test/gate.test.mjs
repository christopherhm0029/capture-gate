// gate.test.mjs — Capture Gate behaviour against a fake PayPal that mimics the sandbox: orders, buyer approval,
// captures replayed per PayPal-Request-Id, and ORDER_ALREADY_CAPTURED for a second capture with a new id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gate, requestIdFor } from "../lib/gate.mjs";
import { PayPal } from "../lib/paypal.mjs";
import { fakePayPal } from "./fake-paypal.mjs";

const MERCHANT = "L5U7ZS83QUXJG";

function setup() {
  const pp = fakePayPal();
  const gate = new Gate(new PayPal({ clientId: "x", clientSecret: "y" }, pp.fetch), join(mkdtempSync(join(tmpdir(), "gate-")), "ledger.json"));
  const intent = gate.freeze({ item: "Ceramic mug", quantity: 1, maxTotal: 12.5, currency: "USD", merchantId: MERCHANT });
  return { pp, gate, intent };
}

test("an order that matches the intent is captured exactly once", async () => {
  const { pp, gate, intent } = setup();
  pp.add("O1"); gate.observe(intent.id, "O1");
  const d = await gate.pay(intent.id, "O1");
  assert.equal(d.decision, "captured");
  assert.equal(pp.captures, 1);
});

for (const [name, opts, failed] of [
  ["injected extra amount", { total: "99.00" }, "total_within_approved_limit"],
  ["swapped item", { name: "Barista Pro espresso machine", total: "12.50" }, "items_match_intent"],
  ["inflated quantity", { qty: 8, total: "12.50" }, "items_match_intent"],
  ["different payee", { payee: "ATTACKER123" }, "payee_is_intended_merchant"],
  ["different currency", { currency: "EUR" }, "currency_matches"],
  ["buyer has not approved", { status: "PAYER_ACTION_REQUIRED" }, "buyer_approved"],
]) {
  test(`blocked: ${name} (no money moves)`, async () => {
    const { pp, gate, intent } = setup();
    pp.add("O1", opts); gate.observe(intent.id, "O1");
    const d = await gate.pay(intent.id, "O1");
    assert.equal(d.decision, "blocked");
    assert.ok(d.failed.includes(failed), `expected ${failed} in ${d.failed}`);
    assert.equal(pp.captures, 0);
  });
}

test("blocked: an order the agent did not create in this intent's session", async () => {
  const { pp, gate, intent } = setup();
  pp.add("FOREIGN");
  const d = await gate.pay(intent.id, "FOREIGN");
  assert.equal(d.decision, "blocked");
  assert.ok(d.failed.includes("created_in_this_session"));
  assert.equal(pp.captures, 0);
});

test("agent fires pay_order twice at once: one capture", async () => {
  const { pp, gate, intent } = setup();
  pp.add("O1"); gate.observe(intent.id, "O1");
  const [a, b] = await Promise.all([gate.pay(intent.id, "O1"), gate.pay(intent.id, "O1")]);
  assert.deepEqual([a.decision, b.decision].sort(), ["captured", "reconciled"]);
  assert.equal(pp.captures, 1);
});

test("crash after capture, before the ledger was saved: retry reconciles, no second capture", async () => {
  const { pp, gate, intent } = setup();
  pp.add("O1"); gate.observe(intent.id, "O1");
  await gate.pay(intent.id, "O1");
  // simulate the lost ledger write: a fresh gate process that only knows the order belongs to the intent
  const rec = gate.ledger.intents[intent.id];
  rec.capture = null; rec.decisions = [];
  const d = await gate.pay(intent.id, "O1");
  assert.equal(d.decision, "reconciled");
  assert.equal(pp.captures, 1);
});

test("agent restarts and creates a NEW order for an intent already paid: blocked as a duplicate", async () => {
  const { pp, gate, intent } = setup();
  pp.add("O1"); pp.add("O2"); gate.observe(intent.id, "O1"); gate.observe(intent.id, "O2");
  assert.equal((await gate.pay(intent.id, "O1")).decision, "captured");
  const d = await gate.pay(intent.id, "O2");
  assert.equal(d.decision, "blocked");
  assert.ok(d.failed.includes("not_already_fulfilled"));
  assert.equal(pp.captures, 1);
});

test("request ids are deterministic per intent + order", () => {
  assert.equal(requestIdFor("goalgate", "i1", "O1"), requestIdFor("goalgate", "i1", "O1"));
  assert.notEqual(requestIdFor("goalgate", "i1", "O1"), requestIdFor("goalgate", "i1", "O2"));
});

test("the client refuses any host other than the PayPal sandbox", () => {
  assert.throws(() => new PayPal({ clientId: "x", clientSecret: "y" }, fetch, "https://api-m.paypal.com"), /sandbox/);
});
