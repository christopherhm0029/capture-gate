// unknown-outcome.test.mjs — regression tests for the audit findings: a capture whose outcome is unknown (lost response,
// crash, PayPal unreachable) must never lead to a second charge for the same approval, and nothing but a COMPLETED capture
// that fits the approval may be reported as paid. Runs on the fake Orders API with injected network faults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gate } from "../lib/gate.mjs";
import { PayPal } from "../lib/paypal.mjs";
import { fakePayPal } from "./fake-paypal.mjs";

const MERCHANT = "L5U7ZS83QUXJG";
/** Two matching, buyer-approved orders (A and B) for one approval: the worst case for a double charge. */
function setup() {
  const pp = fakePayPal(), ledger = join(mkdtempSync(join(tmpdir(), "unk-")), "ledger.json");
  const client = new PayPal({ clientId: "x", clientSecret: "y" }, pp.fetch);
  const gate = new Gate(client, ledger);
  const intent = gate.freeze({ item: "Ceramic mug", quantity: 1, maxTotal: 12.5, currency: "USD", merchantId: MERCHANT });
  for (const id of ["A", "B"]) { pp.add(id); gate.observe(intent.id, id); }
  return { pp, client, ledger, gate, intent };
}

test("lost capture response, then a DIFFERENT order: blocked, one charge (audit P1-1)", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "lost";
  const a = await gate.pay(intent.id, "A");
  assert.equal(a.decision, "blocked");                    // the gate does not know, so it does not say "captured"
  assert.match(a.reason, /outcome unknown/);
  const b = await gate.pay(intent.id, "B");
  assert.equal(b.decision, "blocked");
  assert.ok(b.failed.includes("not_already_fulfilled"));  // PayPal was asked: A did capture, so the approval is spent
  assert.equal(pp.captures, 1);
  assert.equal(pp.orders.get("B").purchase_units[0].payments, undefined);
});

test("lost capture response, then duplicate and concurrent retries of the same order: reconciled, one charge", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "lost";
  await gate.pay(intent.id, "A");
  const again = await Promise.all([gate.pay(intent.id, "A"), gate.pay(intent.id, "A"), gate.pay(intent.id, "B"), gate.pay(intent.id, "A")]);
  assert.deepEqual(again.map((d) => d.decision), ["reconciled", "reconciled", "blocked", "reconciled"]);
  assert.equal(pp.captures, 1);
});

test("request never reached PayPal: the other order stays blocked until the first is retried (fail closed)", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "unsent";
  assert.equal((await gate.pay(intent.id, "A")).decision, "blocked");
  const b = await gate.pay(intent.id, "B");
  assert.equal(b.decision, "blocked");
  assert.match(b.reason, /outcome unknown for order A/);
  assert.equal(pp.captures, 0);                            // nothing was taken, and nothing is taken on a guess
  assert.equal((await gate.pay(intent.id, "A")).decision, "captured");
  assert.equal((await gate.pay(intent.id, "B")).decision, "blocked");
  assert.equal(pp.captures, 1);
});

test("PayPal unreachable while the outcome is unknown: every pay call is blocked, then reconciled once it answers", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "lost";
  await gate.pay(intent.id, "A");
  pp.down = true;
  for (const id of ["A", "B", "A"]) assert.equal((await gate.pay(intent.id, id)).decision, "blocked");
  pp.down = false;
  assert.equal((await gate.pay(intent.id, "B")).decision, "blocked");
  assert.equal((await gate.pay(intent.id, "A")).decision, "reconciled");
  assert.equal(pp.captures, 1);
});

test("process restart with a pending capture on disk: the new gate reconciles before paying anything", async () => {
  const { pp, client, ledger, gate, intent } = setup();
  pp.fault = "lost";
  await gate.pay(intent.id, "A");
  const onDisk = JSON.parse(readFileSync(ledger, "utf8")).intents[intent.id];
  assert.equal(onDisk.pending.orderId, "A");               // what a killed process leaves behind
  assert.equal(onDisk.capture, null);
  const restarted = new Gate(client, ledger);
  const [b1, b2, a] = await Promise.all([restarted.pay(intent.id, "B"), restarted.pay(intent.id, "B"), restarted.pay(intent.id, "A")]);
  assert.deepEqual([b1.decision, b2.decision, a.decision], ["blocked", "blocked", "reconciled"]);
  assert.equal(pp.captures, 1);
});

test("HTTP 500 from capture is an unknown outcome: the other order stays blocked", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "http500";
  assert.equal((await gate.pay(intent.id, "A")).decision, "blocked");
  assert.match((await gate.pay(intent.id, "B")).reason, /outcome unknown/);
  assert.equal(pp.captures, 0);
});

test("HTTP 201 with a DECLINED capture is not a payment (audit P3-2); the approval is still unspent", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "declined";
  const a = await gate.pay(intent.id, "A");
  assert.equal(a.decision, "blocked");
  assert.match(a.reason, /DECLINED/);
  assert.equal(gate.ledger.intents[intent.id].capture, null);
  assert.equal((await gate.pay(intent.id, "B")).decision, "captured");   // a definite "no" does not lock the approval
  assert.equal(pp.captures, 1);
});

test("a PENDING capture is reported as pending, never as captured, and still spends the approval", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "pending";
  assert.equal((await gate.pay(intent.id, "A")).decision, "capture_pending");
  assert.equal((await gate.pay(intent.id, "A")).decision, "capture_pending");
  pp.orders.get("A").purchase_units[0].payments.captures[0].status = "REFUNDED";   // any status that is not a definite "no" keeps the approval spent
  assert.equal((await gate.pay(intent.id, "A")).decision, "capture_refunded");
  assert.equal((await gate.pay(intent.id, "B")).decision, "blocked");
  assert.equal(pp.captures, 1);
});

test("captured amount differs from the order the gate checked: security incident, not success (audit P2-2)", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "tamper";                                     // PayPal takes $100.00 although the order read $12.50
  const a = await gate.pay(intent.id, "A");
  assert.equal(a.decision, "incident");
  assert.ok(a.failed.includes("captured_amount_within_limit"));
  assert.equal((await gate.pay(intent.id, "A")).decision, "incident");   // a retry never turns it into "reconciled"
  assert.equal((await gate.pay(intent.id, "B")).decision, "blocked");
  assert.equal(pp.captures, 1);
});

test("an order with a second purchase unit is refused (audit P2-1)", async () => {
  const { pp, gate, intent } = setup();
  const unit = pp.orders.get("A").purchase_units[0];
  pp.put({ id: "M", status: "APPROVED", purchase_units: [unit, { ...unit, amount: { currency_code: "USD", value: "100.00" } }] });
  gate.observe(intent.id, "M");
  const d = await gate.pay(intent.id, "M");
  assert.equal(d.decision, "blocked");
  assert.ok(d.failed.includes("items_match_intent"));
  assert.equal(pp.captures, 0);
});

test("an order captured outside the gate that does not match the approval is an incident, not 'reconciled' (audit P3-1)", async () => {
  const { pp, gate, intent } = setup();
  const amount = { currency_code: "USD", value: "100.00" };
  pp.put({ id: "X", status: "COMPLETED", purchase_units: [{ payee: { merchant_id: MERCHANT }, amount, items: [{ name: "Ceramic mug", quantity: "8" }],
    payments: { captures: [{ id: "OUTSIDE1", status: "COMPLETED", amount }] } }] });
  assert.equal((await gate.pay(intent.id, "X")).decision, "blocked");    // not created in this session: nothing to do with this approval
  gate.observe(intent.id, "X");
  const d = await gate.pay(intent.id, "X");
  assert.equal(d.decision, "incident");
  assert.ok(d.failed.includes("total_within_approved_limit"));
  assert.equal((await gate.pay(intent.id, "A")).decision, "blocked");    // money already moved for this approval: no further capture
  assert.equal(pp.captures, 0);                                          // the gate itself captured nothing
});

test("rejection and capture cannot interleave (audit P3-3)", async () => {
  const { pp, gate, intent } = setup();
  const [paid, late] = await Promise.all([gate.pay(intent.id, "A"), gate.reject(intent.id, "A")]);
  assert.equal(paid.decision, "captured");
  assert.equal(late.decision, "already_captured");         // the capture was decided first; the rejection reports it instead of pretending
  const [first, blocked] = await Promise.all([gate.reject(intent.id, "B"), gate.pay(intent.id, "B")]);
  assert.equal(first.decision, "rejected_by_user");
  assert.equal(blocked.decision, "blocked");
  assert.equal(pp.captures, 1);
});

test("a definite 'no' on a RETRY does not clear an unknown outcome: the first attempt may still land (independent review)", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "unsent";                                     // attempt 1: no answer, outcome unknown
  await gate.pay(intent.id, "A");
  pp.fault = "http429";                                    // attempt 2: PayPal says no to THIS request only
  assert.equal((await gate.pay(intent.id, "A")).decision, "blocked");
  assert.equal(gate.ledger.intents[intent.id].pending.orderId, "A");
  assert.match((await gate.pay(intent.id, "B")).reason, /outcome unknown for order A/);
  assert.equal(pp.captures, 0);
});

test("a definite 'no' on the FIRST attempt (429) is known: the approval is not locked", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "http429";
  assert.equal((await gate.pay(intent.id, "A")).decision, "blocked");
  assert.equal(gate.ledger.intents[intent.id].pending, undefined);
  assert.equal((await gate.pay(intent.id, "B")).decision, "captured");
  assert.equal(pp.captures, 1);
});

test("PayPal captured but answered HTTP 500: unknown, then the other order is blocked after read-back", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "captured500";
  assert.equal((await gate.pay(intent.id, "A")).decision, "blocked");
  assert.ok((await gate.pay(intent.id, "B")).failed.includes("not_already_fulfilled"));
  assert.equal((await gate.pay(intent.id, "A")).decision, "reconciled");
  assert.equal(pp.captures, 1);
});

test("captured amount within the limit but different from the checked order is still an incident", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "tamper-low";                                 // $5.00 taken although the order read $12.50
  const a = await gate.pay(intent.id, "A");
  assert.equal(a.decision, "incident");
  assert.deepEqual(a.failed, ["captured_amount_equals_checked_order"]);
});

test("an order with an unknown capture outcome cannot be rejected until it is reconciled", async () => {
  const { pp, gate, intent } = setup();
  pp.fault = "lost";
  await gate.pay(intent.id, "A");
  assert.equal((await gate.reject(intent.id, "A")).decision, "reject_refused");
  assert.equal((await gate.pay(intent.id, "A")).decision, "reconciled");   // not deadlocked: the retry still resolves it
  assert.equal((await gate.reject(intent.id, "A")).decision, "already_captured");
  assert.equal(pp.captures, 1);
});
