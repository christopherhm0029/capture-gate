// vault-check.mjs — bounded feasibility check: can this sandbox app save a buyer's PayPal wallet (Vault) so later agent
// purchases need no buyer approval? Step 1 creates an order that asks to vault on success and prints PayPal's answer.
// Step 2 (after the buyer approves) captures it and reports whether a reusable payment token came back.
import { fileURLToPath } from "node:url";
import { loadCredentials } from "../lib/config.mjs";
import { PayPal } from "../lib/paypal.mjs";
import { requestIdFor } from "../lib/gate.mjs";

/** phase: "create" or "capture <orderId>"; creds from the caller (server memory or a fresh 1Password read). */
export async function vaultPhase(phase, creds, log = console.log) {
const pp = new PayPal(creds);
const [cmd, orderId] = phase.split(" ");

if (cmd === "create") {
  const r = await pp.call("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value: "1.00" }, description: "Vault feasibility check" }],
    payment_source: { paypal: {
      attributes: { vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" } },
      experience_context: { return_url: "https://example.com/return", cancel_url: "https://example.com/cancel", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" },
    } },
  }, requestIdFor("vault-check", "create", "v1"));
  const link = (r.json.links || []).find((l) => l.rel === "payer-action")?.href;
  log(JSON.stringify({ http: r.status, order: r.json.id, status: r.json.status, approve: link, error: r.json.name, issue: r.json.details?.map((d) => d.issue) }));
} else if (cmd === "capture") {
  const r = await pp.captureOrder(orderId, requestIdFor("vault-check", "capture", orderId));
  const vault = r.json.payment_source?.paypal?.attributes?.vault;
  log(JSON.stringify({ http: r.status, status: r.json.status, vault_status: vault?.status, has_token_id: Boolean(vault?.id), customer: Boolean(vault?.customer?.id), error: r.json.name, issue: r.json.details?.map((d) => d.issue) }));
}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await vaultPhase(process.argv.slice(2).join(" "), loadCredentials());
