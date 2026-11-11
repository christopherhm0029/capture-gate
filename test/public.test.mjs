// public.test.mjs — the protections that matter when the simulated demo is hosted publicly (PUBLIC_HOST set):
// host/origin guard, request-size cap, rate limit, security headers, /healthz, simulation-only, and session expiry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtempSync, cpSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulatedRoutes, SESSION_TTL_MS, MAX_SESSIONS } from "../lib/demo-sim.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "demo.example.test";
const canListen = (port) => new Promise((ok) => { const s = createServer(); s.once("error", () => ok(false)); s.listen(port, "127.0.0.1", () => s.close(() => ok(true))); });
/** A request as the HTTPS proxy would forward it: public Host header, visitor address in X-Forwarded-For. */
const call = (port, path, { method = "GET", body, headers = {}, ip = "203.0.113.9" } = {}) => new Promise((ok, fail) => {
  const r = request({ host: "127.0.0.1", port, path, method, headers: { host: HOST, "x-forwarded-for": ip, ...headers } }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let json = null; try { json = JSON.parse(d); } catch {} ok({ status: res.statusCode, headers: res.headers, json, text: d }); });
  });
  r.on("error", fail); r.end(body);
});
const boot = (env) => new Promise((ok, fail) => {
  const child = spawn(process.execPath, [join(root, "server.mjs")], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let err = ""; child.stderr.on("data", (d) => (err += d));
  child.stdout.on("data", (d) => String(d).includes("http://") && ok({ child }));
  child.on("exit", (code) => ok({ child, code, err }));
});

test("public host: guard, size cap, rate limit, headers and health", async (t) => {
  const port = 21000 + (process.pid % 20000);
  if (!(await canListen(port))) return t.skip("loopback listen not permitted here");
  const { child } = await boot({ PORT: String(port), PUBLIC_HOST: HOST, GIT_SHA: "abc1234" });
  try {
    const h = await call(port, "/healthz");
    assert.deepEqual([h.status, h.json.ok, h.json.mode, h.json.commit], [200, true, "simulated", "abc1234"]);
    const page = await call(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /default-src 'self'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.ok(!/GIT_SHA|PUBLIC_HOST|process\.env/.test(page.text));                         // nothing from the environment reaches the browser

    assert.equal((await call(port, "/api/mode", { headers: { host: "evil.example" } })).status, 403);        // wrong host
    assert.equal((await call(port, "/api/mode", { headers: { origin: "https://evil.example" } })).status, 403); // wrong origin
    assert.equal((await call(port, "/api/mode", { headers: { origin: `https://${HOST}` } })).status, 200);

    const big = await call(port, "/api/sim/start", { method: "POST", body: "x".repeat(5000) });
    assert.equal(big.status, 413);
    assert.equal((await call(port, "/api/sim/start", { method: "POST", body: "{not json" })).status, 400);
    assert.equal((await call(port, "/api/sim/start", { method: "POST", body: "[1]" })).status, 400);

    const s = await call(port, "/api/sim/start", { method: "POST", body: JSON.stringify({ gate: true }) });
    assert.match(s.json.id, /^[0-9a-f-]{36}$/);                                            // random, not guessable
    assert.match((await call(port, "/api/sim/act", { method: "POST", body: JSON.stringify({ id: 1, action: "approve" }) })).json.error, /unknown session/);
    assert.match((await call(port, "/api/sim/act", { method: "POST", body: JSON.stringify({ id: "../../etc/passwd", action: "approve" }) })).json.error, /unknown session/);

    // One visitor may start 30 sessions a minute; the 31st is refused, while another visitor is unaffected.
    const codes = [];
    for (let i = 0; i < 35; i++) codes.push((await call(port, "/api/sim/start", { method: "POST", body: "{}", ip: "198.51.100.7" })).status);
    assert.deepEqual([codes.filter((c) => c === 200).length, codes.filter((c) => c === 429).length], [30, 5]);
    assert.equal((await call(port, "/api/sim/start", { method: "POST", body: "{}", ip: "198.51.100.8" })).status, 200);
  } finally { child.kill(); }
});

test("the public demo refuses sandbox mode, even with credentials present", async () => {
  const { code, err } = await boot({ PORT: "1", PUBLIC_HOST: HOST, DEMO_MODE: "sandbox", PAYPAL_CLIENT_ID: "x", PAYPAL_CLIENT_SECRET: "y" });
  assert.equal(code, 1);
  assert.match(err, /simulation-only/);
});

test("sessions expire after 30 idle minutes and are capped, and their ledger files are removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-public-"));
  for (const d of ["evidence", "pages"]) cpSync(join(root, d), join(dir, d), { recursive: true });   // what the recording loader reads
  let clock = 0;
  const routes = simulatedRoutes(dir, () => clock), ledgers = () => (existsSync(join(dir, "state", "simulated")) ? readdirSync(join(dir, "state", "simulated")).length : 0);
  const a = await routes["POST /api/sim/start"]({});
  await routes["POST /api/sim/act"]({ id: a.id, action: "approve" });                        // writes the ledger file
  assert.deepEqual([routes._count(), ledgers()], [1, 1]);
  clock = SESSION_TTL_MS + 1;
  const b = await routes["POST /api/sim/start"]({});                                         // the sweep runs on start
  assert.equal(routes._count(), 1);
  assert.match((await routes["POST /api/sim/act"]({ id: a.id, action: "agent" })).error, /unknown session/);
  assert.equal(ledgers(), 0);
  assert.equal((await routes["GET /api/sim"]({}, new URLSearchParams({ id: b.id }))).id, b.id);
  for (let i = 0; i < MAX_SESSIONS + 20; i++) await routes["POST /api/sim/start"]({});
  assert.equal(routes._count(), MAX_SESSIONS);
});
