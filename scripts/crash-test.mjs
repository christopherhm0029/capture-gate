// crash-test.mjs — live interruption tests against the PayPal sandbox (no fakes). Phase "create" makes 4 orders through
// the real toolkit (2 for a gated intent, 2 for an ungated one) and prints the buyer approval links; phase "run" executes:
//   gated:   double pay_order at once -> crash that loses the gate's ledger -> retry -> second order for the same intent
//   ungated: the toolkit's own pay_order on both orders (what an agent that restarted would do without the gate)
// and reads back every order from PayPal. Writes evidence/crash-test.json.
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials, MERCHANT_ID } from "../lib/config.mjs";
import { PayPal } from "../lib/paypal.mjs";
import { Gate } from "../lib/gate.mjs";
import { makeToolkit } from "../lib/agent.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "evidence", "crash-test.json");
/** Run "create" or "run" with caller-supplied credentials (server memory or a fresh 1Password read). */
export async function crashPhase(phase, creds, log = console.log) {
const paypal = new PayPal(creds);
const toolkit = makeToolkit(creds);
const st = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const save = () => writeFileSync(OUT, JSON.stringify(st, null, 1));
const order = { currencyCode: "USD", items: [{ name: "Ceramic mug", quantity: 1, itemCost: 12.5, itemTotal: 12.5, taxPercent: 0 }] };
const tool = async (name, args) => {
  const raw = (await toolkit.handleToolCall({ id: name, function: { name, arguments: JSON.stringify(args) } })).content;
  let o = raw;
  for (let i = 0; i < 2 && typeof o === "string"; i++) { try { o = JSON.parse(o); } catch { break; } }
  if (!o?.id && !o?.status) log(`${name} returned: ${String(typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 300)}`);
  return o || {};
};
const captured = async (id) => { const { json: o } = await paypal.getOrder(id); return { status: o.status, captures: (o.purchase_units?.[0]?.payments?.captures || []).map((c) => [c.id, c.status, c.amount?.value]) }; };

if (phase === "create") {
  st.ledger = join(mkdtempSync(join(tmpdir(), "crash-")), "ledger.json");
  const gate = new Gate(paypal, st.ledger);
  st.intent = gate.freeze({ item: "Ceramic mug", quantity: 1, maxTotal: 12.5, currency: "USD", merchantId: MERCHANT_ID });
  st.orders = {};
  for (const k of ["gatedA", "gatedB", "ungatedA", "ungatedB"]) {
    const o = await tool("create_order", order);
    st.orders[k] = { id: o.id, approve: o.links?.find((l) => l.rel === "payer-action")?.href };
    if (k.startsWith("gated")) gate.observe(st.intent.id, o.id);
  }
  save();
  log(Object.values(st.orders).map((o) => o.approve).join("\n"));
} else if (phase === "run") {
  const gate = new Gate(paypal, st.ledger);
  const A = st.orders.gatedA.id, B = st.orders.gatedB.id;
  const t = {};
  const [p1, p2] = await Promise.all([gate.pay(st.intent.id, A), gate.pay(st.intent.id, A)]);
  t.double_pay_at_once = { decisions: [p1.decision, p2.decision], paypal: await captured(A) };
  // crash: the capture happened but the gate's record of it is lost; a fresh gate process retries the same payment
  const ledger = JSON.parse(readFileSync(st.ledger, "utf8"));
  ledger.intents[st.intent.id].capture = null;
  writeFileSync(st.ledger, JSON.stringify(ledger));
  const fresh = new Gate(paypal, st.ledger);
  const p3 = await fresh.pay(st.intent.id, A);
  t.crash_then_retry = { decision: p3.decision, paypal: await captured(A) };
  const p4 = await fresh.pay(st.intent.id, B);
  t.second_order_same_intent = { decision: p4.decision, failed: p4.failed, paypal: await captured(B) };
  // without the gate: an agent that restarted and paid both orders with the toolkit
  const u1 = await tool("pay_order", { id: st.orders.ungatedA.id });
  const u2 = await tool("pay_order", { id: st.orders.ungatedB.id });
  t.ungated_restart = { paypalA: await captured(st.orders.ungatedA.id), paypalB: await captured(st.orders.ungatedB.id), statuses: [u1.status, u2.status] };
  const charges = (x) => x.captures.filter((c) => c[1] === "COMPLETED" || c[1] === "PENDING").length;
  t.summary = {
    gated_charges_for_one_intent: charges(t.crash_then_retry.paypal) + charges(t.second_order_same_intent.paypal),
    ungated_charges_for_one_intent: charges(t.ungated_restart.paypalA) + charges(t.ungated_restart.paypalB),
  };
  st.results = t; st.ranAt = new Date().toISOString(); save();
  log(JSON.stringify(t, null, 1));
} else log("usage: node scripts/crash-test.mjs create | run");
return st;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await crashPhase(process.argv[2], loadCredentials());
