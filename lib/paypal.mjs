// paypal.mjs — the gate's own minimal PayPal REST client (sandbox only). It is separate from the agent's toolkit on purpose:
// the gate reads the real order and captures with its own calls, so nothing the agent says or does can shape what it sees.
import { SANDBOX } from "./config.mjs";

export class PayPal {
  /** creds: {clientId, clientSecret}; fetchImpl lets tests swap in a fake PayPal. */
  constructor(creds, fetchImpl = globalThis.fetch, base = SANDBOX) {
    if (base !== SANDBOX) throw new Error("Capture Gate refuses any PayPal host other than the sandbox");
    this.creds = creds;
    this.fetch = fetchImpl;
    this.base = base;
    this._token = null;
  }

  /** OAuth client-credentials token, cached until shortly before it expires. */
  async token() {
    if (this._token && this._token.until > Date.now()) return this._token.value;
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64");
    const r = await this.fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST", body: "grant_type=client_credentials",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!r.ok) throw new Error(`PayPal sandbox auth failed (${r.status})`);
    const j = await r.json();
    this._token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    return this._token.value;
  }

  /** One API call; returns {status, json}. requestId becomes PayPal-Request-Id (PayPal replays the original result). */
  async call(method, path, body, requestId) {
    const headers = { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json", Prefer: "return=representation" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const r = await this.fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : {} };
  }

  getOrder(id) { return this.call("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`); }
  captureOrder(id, requestId) { return this.call("POST", `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, requestId); }
}
