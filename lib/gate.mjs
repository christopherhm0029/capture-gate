// gate.mjs — Capture Gate: the independent check between an AI shopping agent and the money moving.
// The user approves an intent BEFORE the agent reads anything untrusted. The gate then sees every order the agent creates,
// re-reads the real order from PayPal when the agent asks to pay, and captures only if it matches the intent — one capture
// per intent. A capture whose outcome is unknown (lost response, crash) blocks every other order of that intent until
// PayPal has been asked what happened; the intent-derived PayPal-Request-Id makes a retry of the same order a replay.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Stable UUID-shaped id from text: the same intent + order always yields the same PayPal-Request-Id. */
export function requestIdFor(...parts) {
  const h = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const money = (v) => Math.round(parseFloat(v) * 100);   // cents, so 12.5 and "12.50" compare equal
const words = (s) => (s || "").toLowerCase().match(/[a-z0-9]+/g) || [];
/** PayPal's two definite "no money moved" capture statuses. Anything else (COMPLETED, PENDING, REFUNDED, unknown) spends the approval. */
const noMoney = (c) => c.status === "DECLINED" || c.status === "FAILED";
/** A capture on the order that means money moved or may still move, across every purchase unit. */
const liveCapture = (order) => (order.purchase_units || []).flatMap((pu) => pu.payments?.captures || []).find((c) => !noMoney(c));
/** Decision name for a capture: only COMPLETED may be called captured/reconciled; others are named after PayPal's status. */
const named = (c, ok) => (c.status === "COMPLETED" ? ok : `capture_${String(c.status).toLowerCase()}`);
/** Does the money PayPal actually captured fit the approval? Returns the names of the failed checks (empty = fits). */
const captureMismatch = (c, intent) => [
  ...(c.amount?.currency_code === intent.currency ? [] : ["captured_currency_matches"]),
  ...(money(c.amount?.value ?? "Infinity") <= money(intent.maxTotal) ? [] : ["captured_amount_within_limit"]),
];

export class Gate {
  /** paypal: the gate's own PayPal client; ledgerPath: JSON file holding intents and decisions (no secrets). */
  constructor(paypal, ledgerPath) {
    this.paypal = paypal;
    this.path = ledgerPath;
    this.ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { intents: {} };
    this.locks = new Map();   // intentId -> promise: one pay() at a time per intent, even if the agent fires twice
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.ledger, null, 1));
  }

  /** The user approves what may be bought. Frozen: the agent never sees or edits this record. */
  freeze({ item, quantity = 1, maxTotal, currency = "USD", merchantId }) {
    const intent = { item, quantity, maxTotal: Number(maxTotal).toFixed(2), currency, merchantId, approvedAt: new Date().toISOString() };
    intent.id = createHash("sha256").update(JSON.stringify(intent)).digest("hex").slice(0, 12);
    this.ledger.intents[intent.id] = { intent, orders: [], capture: null, decisions: [] };
    this.save();
    return intent;
  }

  /** The gate watches the agent's create_order results: only orders created inside this intent's session can be paid. */
  observe(intentId, orderId) {
    const rec = this.ledger.intents[intentId];
    if (rec && orderId && !rec.orders.includes(orderId)) { rec.orders.push(orderId); this.save(); }
  }

  /** Compare the REAL order (read from PayPal by the gate itself) with the frozen intent. Pure: no side effects. */
  evaluate(rec, orderId, order) {
    const it = rec.intent;
    const units = order.purchase_units || [];
    const pu = units[0] || {};
    const items = pu.items || [];
    const want = words(it.item);
    // exactly one purchase unit: a capture charges every unit, so an order the gate cannot fully check is refused
    const itemsMatch = units.length === 1 && items.length === 1 && want.every((w) => words(items[0].name).includes(w))
      && Number(items[0].quantity) <= it.quantity;
    return {
      created_in_this_session: rec.orders.includes(orderId),
      not_already_fulfilled: !rec.capture || rec.capture.orderId === orderId,
      not_rejected_by_user: !(rec.rejected || []).includes(orderId),
      payee_is_intended_merchant: !it.merchantId || (pu.payee || {}).merchant_id === it.merchantId,
      currency_matches: (pu.amount || {}).currency_code === it.currency,
      total_within_approved_limit: money((pu.amount || {}).value ?? "Infinity") <= money(it.maxTotal),
      items_match_intent: itemsMatch,
      buyer_approved: ["APPROVED", "COMPLETED"].includes(order.status),
    };
  }

  /** One job at a time per intent (pay and reject share the queue), so a rejection can never interleave with a capture. */
  _queue(intentId, job) {
    const prev = this.locks.get(intentId) || Promise.resolve();
    const run = prev.then(job, job);
    this.locks.set(intentId, run.catch(() => {}));
    return run;
  }

  /** Read an order with the gate's own client. A network error is "unknown" (status 0), never "not captured". */
  async _read(orderId) {
    try { return await this.paypal.getOrder(orderId); } catch (e) { return { status: 0, json: {}, error: e.message }; }
  }

  /** The user rejected a quarantined order: it can never be captured for this intent, whatever the agent retries later. */
  reject(intentId, orderId) {
    return this._queue(intentId, async () => {
      const rec = this.ledger.intents[intentId];
      if (!rec) return null;
      // the capture decision came first: a late rejection cannot undo money that already moved, so say so instead
      if (rec.capture?.orderId === orderId) return this._decide(rec, orderId, "already_captured", { capture: rec.capture });
      // a capture for this order may be in flight or already done: it cannot be rejected until PayPal has been read back (pay it again)
      if (rec.pending?.orderId === orderId) return this._decide(rec, orderId, "reject_refused", { reason: "capture outcome unknown for this order; retry it to reconcile first" });
      rec.rejected = [...new Set([...(rec.rejected || []), orderId])];
      return this._decide(rec, orderId, "rejected_by_user", {});
    });
  }

  /** The agent's pay_order lands here. Returns {decision: captured|reconciled|blocked|capture_<status>|incident, checks, ...}. */
  pay(intentId, orderId) {
    return this._queue(intentId, () => this._pay(intentId, orderId));
  }

  async _pay(intentId, orderId) {
    const rec = this.ledger.intents[intentId];
    if (!rec) return this._decide(null, orderId, "blocked", { reason: "no approved intent" });

    // An earlier capture attempt for ANOTHER order of this approval has an unknown outcome (lost response, crash).
    // A timeout is not a failure: ask PayPal what happened to that order before any other order may be paid.
    if (rec.pending && rec.pending.orderId !== orderId) {
      const prior = rec.pending.orderId, was = await this._read(prior);
      const took = was.status === 200 && liveCapture(was.json);
      if (took) {
        rec.capture = { orderId: prior, id: took.id, status: took.status, amount: took.amount };
        delete rec.pending;                                    // outcome now known: this approval is already paid
        const bad = captureMismatch(took, rec.intent);
        if (bad.length) rec.incident = rec.incident || { orderId: prior, captureId: took.id, failed: bad, at: new Date().toISOString() };
      } else {
        return this._decide(rec, orderId, "blocked", { reason: `capture outcome unknown for order ${prior}; retry that order first`, pendingOrder: prior });
      }
    }

    const got = await this._read(orderId);
    if (got.status !== 200) return this._decide(rec, orderId, "blocked", { reason: `order not readable (${got.status})` });
    const order = got.json;
    const checks = this.evaluate(rec, orderId, order);
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    const amount = order.purchase_units?.[0]?.amount;

    const done = liveCapture(order);
    if (done) {
      // PayPal already holds a capture for this order (earlier attempt, retry, or something outside the gate): never capture again
      if (!checks.created_in_this_session) return this._decide(rec, orderId, "blocked", { checks, failed, amount });
      if (rec.pending?.orderId === orderId) delete rec.pending;
      const bad = [...failed, ...captureMismatch(done, rec.intent)];
      if (!rec.capture) rec.capture = { orderId, id: done.id, status: done.status, amount: done.amount };   // money moved: the approval is spent
      if (bad.length || rec.incident?.orderId === orderId) {
        // money moved for an order that does not match the approval: a security incident, never an ordinary "paid"
        rec.incident = rec.incident || { orderId, captureId: done.id, failed: bad, at: new Date().toISOString() };
        return this._decide(rec, orderId, "incident", { checks, failed: rec.incident.failed, capture: { orderId, id: done.id, status: done.status, amount: done.amount } });
      }
      if (rec.capture.orderId === orderId) rec.capture.status = done.status;                                // PENDING may have completed since
      return this._decide(rec, orderId, named(done, "reconciled"), { checks, capture: rec.capture });
    }

    if (failed.length) return this._decide(rec, orderId, "blocked", { checks, failed, amount });
    // first attempt for this order? Only then can a definite "no" from PayPal clear pending: on a retry, the earlier
    // attempt may still be in flight, so its unknown outcome stands until a read-back shows a capture.
    const first = rec.pending?.orderId !== orderId;
    if (first) rec.pending = { orderId, at: new Date().toISOString() };   // written before the money moves; read back above after a crash
    this.save();
    let cap;
    try { cap = await this.paypal.captureOrder(orderId, requestIdFor("goalgate", intentId, orderId)); }
    catch (e) {
      // no response: PayPal may or may not have captured. pending stays, so nothing else is paid until this is resolved
      return this._decide(rec, orderId, "blocked", { checks, reason: "capture outcome unknown (no response from PayPal); retry this order to reconcile" });
    }
    const c = cap.json?.purchase_units?.[0]?.payments?.captures?.[0];
    if (![200, 201].includes(cap.status) || !c) {
      // a 4xx answer is a definite "not captured" (unless PayPal says it already was); 5xx or an empty body stays unknown
      const issue = cap.json?.details?.[0]?.issue;
      const already = (cap.json?.details || []).some((d) => d.issue === "ORDER_ALREADY_CAPTURED");
      if (first && cap.status >= 400 && cap.status < 500 && cap.status !== 408 && !already) delete rec.pending;   // 408 = timeout: unknown
      return this._decide(rec, orderId, "blocked", { checks, reason: `capture failed (${cap.status})`, error: cap.json?.name, issue });
    }
    // HTTP 201 alone is not proof of payment: PayPal's capture status decides
    if (noMoney(c)) {
      if (first) delete rec.pending;
      return this._decide(rec, orderId, "blocked", { checks, reason: `capture not completed (PayPal status ${c.status})`, captureStatus: c.status });
    }
    rec.capture = { orderId, id: c.id, status: c.status, amount: c.amount };
    delete rec.pending;
    // what PayPal actually took must equal what the gate checked a moment ago (the order could have changed in between)
    const bad = [...captureMismatch(c, rec.intent), ...(money(c.amount?.value) !== money(amount?.value) ? ["captured_amount_equals_checked_order"] : [])];
    if (bad.length) {
      rec.incident = { orderId, captureId: c.id, failed: bad, at: new Date().toISOString() };
      return this._decide(rec, orderId, "incident", { checks, failed: bad, capture: rec.capture, http: cap.status });
    }
    return this._decide(rec, orderId, named(c, "captured"), { checks, capture: rec.capture, http: cap.status });
  }

  _decide(rec, orderId, decision, extra) {
    const d = { at: new Date().toISOString(), orderId, decision, ...extra };
    if (rec) { rec.decisions.push(d); this.save(); }
    return d;
  }
}
