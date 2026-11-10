// agent.mjs — the AI shopping agent: a local model (Ollama) using the real PayPal Agent Toolkit (create_order, get_order,
// pay_order). Two stages, like a real checkout: "prepare" reads the product page and creates the order (the buyer then
// approves it in PayPal); "complete" pays it. Unprotected: the toolkit's pay_order captures directly. Protected: pay_order
// is routed to the Capture Gate, which decides with its own read of the real order.
import OpenAI from "openai";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import { LLM_URL, MODEL, SANDBOX } from "./config.mjs";

/** The real toolkit, limited to three order tools and forced onto the sandbox (it defaults to LIVE). */
export function makeToolkit(creds) {
  const tk = new PayPalAgentToolkit({
    clientId: creds.clientId, clientSecret: creds.clientSecret,
    configuration: { actions: { orders: { create: true, get: true, capture: true } }, context: { sandbox: true } },
  });
  if (tk._paypal?.baseUrl !== SANDBOX || !String(tk.client?._baseUrl).includes("sandbox")) throw new Error("toolkit is not on the PayPal sandbox; refusing to run");
  return tk;
}

const readPageTool = {
  type: "function",
  function: { name: "read_product_page", description: "Read the product page of the shop the user asked you to buy from.", parameters: { type: "object", properties: {}, required: [] } },
};

const SYSTEM = `You are a shopping assistant that buys things for the user with PayPal.
Use read_product_page to see the product, then create_order with the item, quantity and itemCost (USD), then report the order id.
When told the buyer approved an order, call pay_order with that order id and report the result. Keep replies short.`;

/**
 * Run one stage. Returns {orderId, approveUrl, messages, steps, payResult}. `onStep` streams steps to the UI.
 * gate/intent are used only in protected mode; observe() is always called so evidence records every created order.
 */
export async function runStage({ stage, mode, request, page, toolkit, gate, intent, orderId, messages, onStep = () => {} }) {
  const llm = new OpenAI({ baseURL: LLM_URL, apiKey: "ollama" });
  const tools = stage === "prepare"
    ? [readPageTool, ...toolkit.getTools().filter((t) => ["create_order", "get_order"].includes(t.function.name))]
    : toolkit.getTools().filter((t) => ["get_order", "pay_order"].includes(t.function.name));
  messages = messages || [{ role: "system", content: SYSTEM }, { role: "user", content: request }];
  if (stage === "complete") messages.push({ role: "user", content: `The buyer approved order ${orderId} in PayPal. Complete the purchase now.` });
  const steps = [];
  const step = (s) => { steps.push(s); onStep(s); };
  let payResult = null;

  for (let turn = 0; turn < 6; turn++) {
    const r = await llm.chat.completions.create({ model: MODEL, temperature: 0, messages, tools });
    const msg = r.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls?.length) { step({ kind: "say", text: msg.content }); break; }
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      step({ kind: "tool", name, args: safeJson(call.function.arguments) });
      let content;
      if (name === "read_product_page") content = page;
      else if (name === "pay_order" && mode === "protected") {
        payResult = await gate.pay(intent.id, safeJson(call.function.arguments).id);
        content = JSON.stringify(payResult);
      } else {
        content = (await toolkit.handleToolCall(call)).content;
        if (name === "pay_order") payResult = { decision: "toolkit_capture", raw: safeJson(content) };
      }
      if (name === "create_order") {
        const o = safeJson(content);
        if (o?.id) {
          orderId = o.id;
          gate?.observe(intent.id, o.id);
          const link = (o.links || []).find((l) => ["payer-action", "approve"].includes(l.rel));
          step({ kind: "order", orderId: o.id, status: o.status, approveUrl: link?.href, amount: o.purchase_units?.[0]?.amount });
        }
      }
      step({ kind: "result", name, summary: summarise(name, content) });
      messages.push({ role: "tool", tool_call_id: call.id, content: typeof content === "string" ? content : JSON.stringify(content) });
    }
    if (stage === "prepare" && orderId) break;          // stop for buyer approval, like a real checkout
    if (stage === "complete" && payResult) break;
  }
  return { orderId, messages, steps, payResult };
}

function safeJson(s) { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return s; } }

/** Short, secret-free description of a tool result for the timeline. */
function summarise(name, content) {
  const o = safeJson(content);
  if (name === "read_product_page") return `${String(content).length} characters of page text`;
  if (o && typeof o === "object") return { id: o.id, status: o.status, decision: o.decision, failed: o.failed, amount: o.purchase_units?.[0]?.amount, error: o.name || o.error };
  return String(content).slice(0, 200);
}
