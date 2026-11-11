// server.mjs — web app for the Capture Gate demo. Always listens on loopback only (http://127.0.0.1:$PORT, default 8740).
// Two explicit modes:
//   simulated (DEFAULT): no credentials, no network, no node_modules. The REAL gate (lib/gate.mjs) runs against a
//     deterministic fake Orders API with a scripted agent replaying recorded create_order calls (lib/demo-sim.mjs).
//   sandbox: only with DEMO_MODE=sandbox AND PayPal sandbox credentials. A real local agent (Ollama + PayPal Agent Toolkit)
//     against the real PayPal sandbox (lib/sandbox-routes.mjs, loaded lazily so simulated mode never imports it).
// Public hosting: set PUBLIC_HOST=<domain> and put an HTTPS reverse proxy on the same machine in front of this port
// (deploy/). That turns on the public host name, per-visitor rate limits and refuses sandbox mode outright.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MODE = process.env.DEMO_MODE === "sandbox" ? "sandbox" : "simulated";
const PORT = Number(process.env.PORT) || 8740;
const PUBLIC_HOST = process.env.PUBLIC_HOST || "";        // e.g. capture-gate.example.com; empty = local only
const COMMIT = process.env.GIT_SHA || "dev";              // reported by /healthz so a deploy can be verified
const MAX_BODY = 2048;                                    // bytes; the largest real request is under 100

if (PUBLIC_HOST && MODE === "sandbox") { console.error("PUBLIC_HOST and DEMO_MODE=sandbox cannot be combined: the public demo is simulation-only."); process.exit(1); }

let routes;
if (MODE === "sandbox") {
  try { routes = await (await import("./lib/sandbox-routes.mjs")).sandboxRoutes(here); }
  catch (e) {
    console.error(`DEMO_MODE=sandbox needs PayPal sandbox credentials and npm ci: ${e.message}\nUnset DEMO_MODE for the simulated demo (no credentials).`);
    process.exit(1);
  }
} else routes = (await import("./lib/demo-sim.mjs")).simulatedRoutes(here);
routes["GET /api/mode"] = async () => ({ mode: MODE, gate: "lib/gate.mjs (real)",
  paypal: MODE === "sandbox" ? "PayPal sandbox (real, test money)" : "test/fake-paypal.mjs (deterministic fake, SIMULATED)" });

// Static files per mode: the guided simulated demo, or the original sandbox page. Read once at start.
const STATIC = MODE === "sandbox"
  ? { "/": ["index.html", "text/html; charset=utf-8"] }
  : { "/": ["demo.html", "text/html; charset=utf-8"], "/demo.css": ["demo.css", "text/css; charset=utf-8"], "/demo.js": ["demo.js", "text/javascript; charset=utf-8"] };
STATIC["/index.html"] = STATIC["/"];
for (const v of new Set(Object.values(STATIC))) v[2] = readFileSync(join(here, "public", v[0]));

// Browser requests must come from this page itself: stops another site open in the same browser (or a DNS-rebinding
// host name) from driving the demo. Tools without an Origin header (curl, the repeatability script) still work.
const HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...(PUBLIC_HOST ? [PUBLIC_HOST] : [])];
const ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, ...(PUBLIC_HOST ? [`https://${PUBLIC_HOST}`] : [])];
const allowed = (req) => HOSTS.includes(req.headers.host) && (!req.headers.origin || ORIGINS.includes(req.headers.origin))
  && req.headers["sec-fetch-site"] !== "cross-site";

// Rate limit (public hosting only): per visitor and minute, 240 API calls, of which 30 may start a new session. A full
// run of the demo is about 10 calls. The visitor's address is the last X-Forwarded-For entry, which the local proxy sets.
const LIMITS = { api: 240, start: 30 }, hits = new Map();
if (PUBLIC_HOST) setInterval(() => hits.clear(), 60_000).unref();
const limited = (req, kind) => {
  if (!PUBLIC_HOST) return false;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",").pop().trim();
  if (hits.size > 50_000) hits.clear();                   // a flood of addresses cannot grow memory
  const k = `${kind} ${ip}`, n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  return n > LIMITS[kind];
};

const SECURITY = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
const send = (res, code, body, type = "application/json", extra = {}) =>
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY, ...extra }).end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));

/** Read a request body, refusing anything larger than MAX_BODY. */
async function readBody(req) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > MAX_BODY) throw Object.assign(new Error("request too large"), { code: 413 }); }
  return body;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  try {
    if (key === "GET /healthz") send(res, 200, { ok: true, mode: MODE, commit: COMMIT, sessions: routes._count?.() ?? null, uptime: Math.round(process.uptime()) });
    else if (url.pathname.startsWith("/api/") && !allowed(req)) send(res, 403, { error: "request not from the demo page" });
    else if (url.pathname.startsWith("/api/") && routes[key]) {
      if (limited(req, "api") || (url.pathname === "/api/sim/start" && limited(req, "start")))
        return send(res, 429, { error: "Too many requests. Please wait a minute and try again." }, undefined, { "Retry-After": "60" });
      const body = await readBody(req);
      let json = {};
      try { if (body) json = JSON.parse(body); } catch { return send(res, 400, { error: "invalid JSON" }); }
      if (!json || typeof json !== "object" || Array.isArray(json)) return send(res, 400, { error: "invalid request" });
      send(res, 200, await routes[key](json, url.searchParams));
    } else if (req.method === "GET" && STATIC[url.pathname]) send(res, 200, STATIC[url.pathname][2], STATIC[url.pathname][1]);
    else send(res, 404, "not found", "text/plain");
  } catch (e) {
    if (e.code === 413) { send(res, 413, { error: e.message }, undefined, { Connection: "close" }); return; }
    console.error(key, e);                                // details stay in the server log, not in the response
    send(res, 500, { error: PUBLIC_HOST ? "internal error" : e.message });
  }
});
server.requestTimeout = 15_000; server.headersTimeout = 10_000;
server.listen(PORT, "127.0.0.1", () => console.log(MODE === "sandbox"
  ? `Capture Gate demo on http://127.0.0.1:${PORT} (PayPal sandbox only)`
  : `Capture Gate demo on http://127.0.0.1:${PORT} (SIMULATED: real gate, fake PayPal, no credentials${PUBLIC_HOST ? `; public host ${PUBLIC_HOST}, commit ${COMMIT}` : ""})`));
