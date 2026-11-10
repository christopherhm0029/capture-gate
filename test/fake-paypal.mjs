// fake-paypal.mjs — deterministic stand-in for the PayPal sandbox Orders API (no network). Used by the unit tests and by
// the simulated scenario run, which replays real sandbox order snapshots. Captures replay per PayPal-Request-Id and a
// second capture with a new id fails with ORDER_ALREADY_CAPTURED, as the real sandbox does.
// Faults (one-shot, for the next capture call) let tests reproduce what a real network does: `fault = "lost"` captures and
// then drops the response, "unsent" drops the request, "http500", "http429", "captured500" (captures, then answers 500),
// "declined" / "pending" (HTTP 201 with that capture status), "tamper" / "tamper-low" (captures a different amount than
// the order showed). `down = true` makes every call fail.
import { SANDBOX } from "../lib/config.mjs";

const MERCHANT = "L5U7ZS83QUXJG";

/** A fake sandbox: orders keyed by id; counts real captures so tests can prove "exactly once". */
export function fakePayPal() {
  const orders = new Map(), replays = new Map();
  let captures = 0, fault = null, down = false;
  const fetch = async (url, init) => {
    if (down) throw new Error("fake network: PayPal unreachable");
    const path = url.replace(SANDBOX, "");
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (path === "/v1/oauth2/token") return reply(200, { access_token: "t", expires_in: 3600 });
    const m = path.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    const o = m && orders.get(decodeURIComponent(m[1]));
    if (!o) return reply(404, { name: "RESOURCE_NOT_FOUND" });
    if (!m[2]) return reply(200, o);
    const rid = init.headers["PayPal-Request-Id"];
    if (rid && replays.has(rid)) return reply(200, replays.get(rid));
    if (o.status === "COMPLETED") return reply(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
    if (o.status !== "APPROVED") return reply(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
    const f = fault; fault = null;
    const amount = o.purchase_units[0].amount;
    if (f === "unsent") throw new Error("fake network: request never reached PayPal");
    if (f === "http500") return reply(500, { name: "INTERNAL_SERVER_ERROR" });
    if (f === "http429") return reply(429, { name: "RATE_LIMIT_REACHED" });
    if (f === "declined") return reply(201, { ...o, purchase_units: [{ ...o.purchase_units[0], payments: { captures: [{ id: "DECLINED1", status: "DECLINED", amount }] } }] });
    captures++;
    o.status = "COMPLETED";
    o.purchase_units[0].payments = { captures: [{ id: `CAP${captures}`, status: f === "pending" ? "PENDING" : "COMPLETED", amount: f === "tamper" ? { ...amount, value: "100.00" } : f === "tamper-low" ? { ...amount, value: "5.00" } : amount }] };
    if (rid) replays.set(rid, o);
    if (f === "captured500") return reply(500, { name: "INTERNAL_SERVER_ERROR" });
    if (f === "lost") throw new Error("fake network: response lost after PayPal captured");
    return reply(201, o);
  };
  const add = (id, { total = "12.50", name = "Ceramic mug", qty = 1, payee = MERCHANT, status = "APPROVED", currency = "USD" } = {}) =>
    orders.set(id, { id, status, purchase_units: [{ payee: { merchant_id: payee }, amount: { currency_code: currency, value: total }, items: [{ name, quantity: String(qty) }] }] });
  /** put: load a full order snapshot (e.g. a recorded sandbox order), cloned so replays never mutate the fixture. */
  const put = (o) => orders.set(o.id, structuredClone(o));
  return { fetch, add, put, orders, get captures() { return captures; }, set fault(v) { fault = v; }, set down(v) { down = v; } };
}

