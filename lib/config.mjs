// config.mjs — Capture Gate settings. Sandbox only: the one PayPal host is fixed here and checked at start-up.
// Credentials are read once at start and live only in memory: from PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET when set (judges
// use their own sandbox app), otherwise from a 1Password item named by PAYPAL_OP_ITEM (op CLI). Never written to disk or logged.
import { execFileSync } from "node:child_process";

export const SANDBOX = "https://api-m.sandbox.paypal.com";
export const OP_ITEM = process.env.PAYPAL_OP_ITEM;                 // e.g. op://<vault>/<item>, with fields username + credential
export const MERCHANT_ID = process.env.PAYPAL_MERCHANT_ID || "L5U7ZS83QUXJG"; // sandbox business account the app sells as
export const LLM_URL = "http://127.0.0.1:11434/v1";               // local Ollama (OpenAI-compatible); no cloud model
export const MODEL = process.env.GATE_MODEL || "qwen2.5:7b";

/** Read the sandbox client id and secret from 1Password (op CLI). Never logged, never written to disk. */
export function loadCredentials() {
  const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
  if (clientId && clientSecret) return { clientId, clientSecret };
  if (!OP_ITEM) throw new Error("Set PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET (sandbox app), or PAYPAL_OP_ITEM for a 1Password item");
  const read = (field) => execFileSync("op", ["read", `${OP_ITEM}/${field}`], { encoding: "utf8" }).trim();
  return { clientId: read("username"), clientSecret: read("credential") };
}
