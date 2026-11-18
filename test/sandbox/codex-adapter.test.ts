import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { AUTH_CLAIM, CODEX_CLIENT_ID, ISSUER } from "../../bin/sandbox/adapters/codex-identity.ts";
import { codexRefreshNeeded } from "../../bin/sandbox/adapters/codex-refresh.ts";
import { codexAdapter } from "../../bin/sandbox/adapters/codex.ts";
import { copyLoginIn, prepareLogin, type Prepared } from "../../bin/sandbox/login.ts";

// Synthetic issuer: throwaway RSA keys, a local JWKS endpoint whose behaviour the tests switch, and tokens
// minted here. Never real tokens.
const KEY = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const ROGUE = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";
const jwk = { ...KEY.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

const USER_A = "user-octocat-a";
const USER_B = "user-octocat-b";
const ORG_1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const ORG_2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const EMAIL = "octocat@example.com";

type Mode = "ok" | "401" | "503" | "slow" | "shape" | "redirect";
let mode: Mode = "ok";
let jwksHits = 0;
// The token endpoint's next answer (set per test) and the requests it saw.
type TokenAnswer = { status: number; body: unknown; delayMs?: number; location?: string };
let tokenAnswer: TokenAnswer = { status: 404, body: {} };
const tokenCalls: { type?: string; body: string }[] = [];
let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(typeof body === "string" ? body : JSON.stringify(body));
    if (req.method === "POST" && req.url === "/oauth/token") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        tokenCalls.push({ type: req.headers["content-type"], body });
        const a = tokenAnswer;
        const send = () => (a.location ? void res.writeHead(a.status, { location: a.location }).end() : json(a.status, a.body));
        if (a.delayMs) setTimeout(send, a.delayMs).unref();
        else send();
      });
      return;
    }
    if (req.url !== "/.well-known/jwks.json") return void res.writeHead(404).end();
    jwksHits++;
    if (mode === "ok") return json(200, { keys: [jwk] });
    if (mode === "401") return json(401, { error: "unauthorized" });
    if (mode === "503") return json(503, { error: "unavailable" });
    if (mode === "shape") return json(200, { keys: [{ kty: "EC", kid: KID, crv: "P-256" }] });
    if (mode === "redirect") return void res.writeHead(302, { location: "http://127.0.0.1:1/jwks" }).end();
    setTimeout(() => json(200, { keys: [jwk] }), 1500).unref(); // slow
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.closeAllConnections?.() ?? server.close());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-codex-adapter-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(payload: Record<string, unknown>, opts: { key?: crypto.KeyObject; kid?: string; alg?: string } = {}) {
  const head = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" });
  const body = b64(payload);
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), opts.key ?? KEY.privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}
type Who = { user: string; org: string; tag: string; exp?: number };
const idToken = (w: Who, extra: Record<string, unknown> = {}) =>
  jwt({ iss: ISSUER, aud: [CODEX_CLIENT_ID], sub: w.user, exp: w.exp ?? 1, email: EMAIL, [AUTH_CLAIM]: { chatgpt_user_id: w.user, chatgpt_account_id: w.org, chatgpt_plan_type: "team" }, ...extra });
const accessToken = (w: Who) => jwt({ iss: ISSUER, aud: ["https://api.openai.com/v1"], exp: w.exp ?? 1, [AUTH_CLAIM]: { chatgpt_account_id: w.org, user_id: w.user } });
const authJson = (w: Who, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken(w), access_token: accessToken(w), refresh_token: `rt-${w.tag}`, account_id: w.org },
    last_refresh: "2026-01-01T00:00:00Z",
    ...overrides,
  });

const HOST: Who = { user: USER_A, org: ORG_1, tag: "host" }; // exp 1: long expired, as a host copy usually is

const FAR = 4102444800; // 2100-01-01
const granted = (w: Who, extra: Record<string, unknown> = {}): TokenAnswer => ({
  status: 200,
  body: { id_token: idToken({ ...w, exp: FAR }), access_token: accessToken({ ...w, exp: FAR }), refresh_token: `rt-${w.tag}-next`, ...extra },
});

let n = 0;
function hostDir(hostAuth = authJson(HOST), answer: TokenAnswer = granted({ user: USER_A, org: ORG_1, tag: "fresh" })) {
  mode = "ok";
  tokenAnswer = answer;
  const adapter = codexAdapter({ identityBaseUrl: base, refreshBaseUrl: base, timeoutMs: 300 });
  const host = path.join(tmp, `host-${++n}`);
  fs.mkdirSync(host);
  fs.writeFileSync(path.join(host, ".reviewer-sandbox"), "");
  fs.writeFileSync(path.join(host, "auth.json"), hostAuth, { mode: 0o600 });
  const copy = path.join(tmp, `copy-${n}`);
  const hostLogin = () => fs.readFileSync(path.join(host, "auth.json"), "utf8");
  const prepare = async () => record(await prepareLogin(adapter, host, copy, { untilMs: Date.now() + 40 * 60_000 }));
  return { host, copy, hostLogin, original: hostAuth, prepare };
}

const lines: string[] = [];
const record = (r: Prepared) => (lines.push(r.line), r);

describe("UT-084 codex adapter: configEnv, copyIn allowlist, egress, ACP command", () => {
  test("configEnv points CODEX_HOME at the session copy", () => {
    assert.deepEqual(codexAdapter().configEnv("/home/reviewer/.reviewer-login"), { CODEX_HOME: "/home/reviewer/.reviewer-login" });
  });

  test("login file, provisional egress hosts and ACP entry (bundled codex binary, never CODEX_PATH)", () => {
    const a = codexAdapter();
    assert.equal(a.loginFile, "auth.json");
    assert.deepEqual([...a.egressHosts].sort(), ["api.openai.com", "auth.openai.com", "chatgpt.com"]);
    assert.ok(!a.egressHosts.includes("ab.chatgpt.com"), "telemetry host stays out");
    assert.deepEqual(a.acpCommand("/opt/acp"), ["/opt/node/bin/node", "/opt/acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js"]);
    assert.equal(a.configEnv("/x").CODEX_PATH, undefined);
  });

  test("copy-in takes only auth.json, config.toml and the marker; a symlinked allowlisted name is skipped", () => {
    const host = path.join(tmp, "copyin-host");
    fs.mkdirSync(path.join(host, "sessions"), { recursive: true });
    for (const f of [".reviewer-sandbox", "auth.json", "AGENTS.md", "history.jsonl", "sessions/s.jsonl", "elsewhere.toml"]) fs.writeFileSync(path.join(host, f), "x");
    fs.symlinkSync(path.join(host, "elsewhere.toml"), path.join(host, "config.toml"));
    const copy = path.join(tmp, "copyin-copy");
    copyLoginIn(codexAdapter(), host, copy);
    assert.deepEqual(fs.readdirSync(copy).sort(), [".reviewer-sandbox", "auth.json"].sort());
  });
});

describe("UT-085 codex pre-session refresh: the CLI's own flow, signature-verified, same account and organization only", () => {
  test("refreshNeeded: by the access token's exp against the session budget; API-key logins are not refreshable", () => {
    const until = Date.now() + 40 * 60_000;
    assert.equal(codexRefreshNeeded(authJson({ ...HOST, exp: FAR }), until), "valid");
    assert.equal(codexRefreshNeeded(authJson(HOST), until), "refresh");
    assert.equal(codexRefreshNeeded(authJson({ ...HOST, exp: Math.floor(until / 1000) }), until), "refresh");
    assert.equal(codexRefreshNeeded(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "junk" } }), until), "refresh");
    assert.equal(codexRefreshNeeded("not json", until), "refresh");
    assert.equal(codexRefreshNeeded(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-not-a-key" }), until), "not-refreshable");
    assert.equal(codexRefreshNeeded(JSON.stringify({ OPENAI_API_KEY: "sk-test-not-a-key", tokens: null }), until), "not-refreshable");
  });

  test("a valid login is copied without any network call", async () => {
    const s = hostDir(authJson({ ...HOST, exp: FAR }));
    jwksHits = 0;
    tokenCalls.length = 0;
    assert.deepEqual(await s.prepare(), { ok: true, line: "login-refresh skipped (token valid)" });
    assert.equal(jwksHits + tokenCalls.length, 0);
    assert.equal(fs.readFileSync(path.join(s.copy, "auth.json"), "utf8"), s.original);
  });

  test("same-account refresh: the request is the CLI's, and only the obtained set is merged and saved at 0600", async () => {
    const s = hostDir(authJson(HOST, { extra_field: { keep: 1 } }));
    tokenCalls.length = 0;
    const t0 = Date.now();
    const r = await s.prepare();
    assert.equal(r.ok, true, r.line);
    assert.match(r.line, /^login-refresh refreshed \(same account\) id=[0-9a-f]{12}$/);
    assert.equal(tokenCalls.length, 1);
    assert.equal(tokenCalls[0]?.type, "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenCalls[0]!.body)), {
      grant_type: "refresh_token",
      refresh_token: "rt-host",
      client_id: CODEX_CLIENT_ID,
      refresh_reason: "scheduled",
    });
    const saved = JSON.parse(s.hostLogin());
    const sent = tokenAnswer.body as Record<string, string>;
    assert.deepEqual(saved.tokens, { id_token: sent.id_token, access_token: sent.access_token, refresh_token: "rt-fresh-next", account_id: ORG_1 });
    assert.equal(saved.auth_mode, "chatgpt");
    assert.equal(saved.OPENAI_API_KEY, null);
    assert.deepEqual(saved.extra_field, { keep: 1 }, "other fields kept");
    assert.ok(Date.parse(saved.last_refresh) >= t0 - 1000);
    assert.equal(fs.statSync(path.join(s.host, "auth.json")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(s.copy, "auth.json"), "utf8"), s.hostLogin(), "the copy holds the refreshed login");
    assert.deepEqual(fs.readdirSync(s.host).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock")), []);
  });

  test("only an access token returned: the old id_token and refresh token are kept", async () => {
    const fresh = granted({ user: USER_A, org: ORG_1, tag: "only" });
    const s = hostDir(authJson(HOST), { status: 200, body: { access_token: (fresh.body as Record<string, string>).access_token } });
    assert.equal((await s.prepare()).ok, true);
    const before = JSON.parse(s.original).tokens;
    const saved = JSON.parse(s.hostLogin()).tokens;
    assert.equal(saved.id_token, before.id_token);
    assert.equal(saved.refresh_token, "rt-host");
    assert.notEqual(saved.access_token, before.access_token);
  });

  for (const [name, who] of [
    ["another account", { user: USER_B, org: ORG_1, tag: "b" }],
    ["the same user in another organization", { user: USER_A, org: ORG_2, tag: "o2" }],
  ] as const) {
    test(`a refresh that yields tokens of ${name} is refused, host untouched, no copy`, async () => {
      const s = hostDir(authJson(HOST), granted(who));
      const r = await s.prepare();
      assert.match(r.line, /^login-refresh refused \(identity mismatch\) before=[0-9a-f]{12} refreshed=[0-9a-f]{12}$/);
      assert.equal(s.hostLogin(), s.original);
      assert.ok(!fs.existsSync(s.copy));
    });
  }

  test("an id_token of the host account paired with another account's access token is refused", async () => {
    const s = hostDir(authJson(HOST), { status: 200, body: { id_token: idToken({ ...HOST, exp: FAR }), access_token: accessToken({ user: USER_B, org: ORG_2, tag: "b" }) } });
    assert.equal((await s.prepare()).line, "login-refresh refused (identity shape changed: refreshed login)");
    assert.equal(s.hostLogin(), s.original);
  });
});

describe("UT-086 codex pre-session refresh: every failure refuses (fail closed)", () => {
  const claims = { [AUTH_CLAIM]: { chatgpt_user_id: USER_A, chatgpt_account_id: ORG_1 } };
  const ok = granted({ user: USER_A, org: ORG_1, tag: "ok" }).body as Record<string, string>;
  const answer = (tokens: Record<string, unknown>): TokenAnswer => ({ status: 200, body: { ...ok, ...tokens } });
  // Every refreshed-token case is internally consistent and claims the host account; only the flaw named
  // gives it away.
  const refreshedCases: [string, TokenAnswer, string][] = [
    [
      "a forged signature claiming the host account",
      answer({
        id_token: jwt({ iss: ISSUER, aud: [CODEX_CLIENT_ID], ...claims }, { key: ROGUE.privateKey }),
        access_token: jwt({ iss: ISSUER, aud: ["https://api.openai.com/v1"], ...claims }, { key: ROGUE.privateKey }),
      }),
      "identity shape changed: refreshed login",
    ],
    ["an unknown signing key id", answer({ id_token: jwt({ iss: ISSUER, aud: [CODEX_CLIENT_ID], ...claims }, { kid: "rotated" }) }), "identity unavailable: refreshed login"],
    ["alg none", answer({ id_token: `${b64({ alg: "none" })}.${b64({ iss: ISSUER, ...claims })}.x` }), "identity shape changed: refreshed login"],
    // R-30: the access token must meet the access-token contract, not just carry a valid signature.
    ["R-30 the ID token returned as the access token", answer({ access_token: ok.id_token }), "identity shape changed: refreshed login"],
    ["R-30 an access token for an unrelated audience", answer({ access_token: jwt({ iss: ISSUER, aud: ["https://unrelated.example"], [AUTH_CLAIM]: { chatgpt_account_id: ORG_1, user_id: USER_A } }) }), "identity shape changed: refreshed login"],
    ["R-30 an access token whose audience is the CLI client id", answer({ access_token: jwt({ iss: ISSUER, aud: ["https://api.openai.com/v1", CODEX_CLIENT_ID], [AUTH_CLAIM]: { chatgpt_account_id: ORG_1, user_id: USER_A } }) }), "identity shape changed: refreshed login"],
    ["a wrong issuer", answer({ id_token: jwt({ iss: "https://evil.example", aud: [CODEX_CLIENT_ID], ...claims }) }), "identity shape changed: refreshed login"],
    ["another client id in aud", answer({ id_token: jwt({ iss: ISSUER, aud: ["app_other"], ...claims }) }), "identity shape changed: refreshed login"],
    ["junk tokens", answer({ id_token: "junk", access_token: "junk" }), "identity shape changed: refreshed login"],
    // Token endpoint failures.
    ["invalid grant (4xx)", { status: 401, body: { error: "invalid_grant" } }, "refresh rejected"],
    ["5xx", { status: 503, body: "upstream unavailable" }, "refresh unavailable"],
    ["timeout", { ...answer({}), delayMs: 1500 }, "refresh unavailable"],
    ["redirect (never followed)", { status: 302, body: "", location: "http://127.0.0.1:1/token" }, "refresh unavailable"],
    ["no access token", { status: 200, body: { id_token: ok.id_token } }, "refresh shape changed"],
    ["a non-string refresh token", answer({ refresh_token: 42 }), "refresh shape changed"],
    ["non-JSON 200", { status: 200, body: "<html>maintenance</html>" }, "refresh shape changed"],
  ];
  for (const [name, a, reason] of refreshedCases) {
    test(`${name} is refused`, async () => {
      const s = hostDir(authJson(HOST), a);
      assert.deepEqual(await s.prepare(), { ok: false, line: `login-refresh refused (${reason})` });
      assert.equal(s.hostLogin(), s.original);
      assert.ok(!fs.existsSync(s.copy));
    });
  }

  // The host login's own identity is verified (JWKS) before any refresh call.
  const hostCases: [string, Mode, string, string?][] = [
    ["JWKS 401", "401", "identity unavailable: host login"],
    ["JWKS 5xx", "503", "identity unavailable: host login"],
    ["JWKS timeout", "slow", "identity unavailable: host login"],
    ["JWKS shape change", "shape", "identity shape changed: host login"],
    ["JWKS redirect (never followed)", "redirect", "identity unavailable: host login"],
    ["a ChatGPT host login that also carries an API key", "ok", "identity shape changed: host login", authJson(HOST, { OPENAI_API_KEY: "sk-test-not-a-key" })],
    ["a host login without a refresh token", "ok", "refresh shape changed", authJson(HOST, { tokens: { ...JSON.parse(authJson(HOST)).tokens, refresh_token: "" } })],
  ];
  for (const [name, jwksMode, reason, hostAuth] of hostCases) {
    test(`${name}: refused before any refresh call`, async () => {
      const s = hostDir(hostAuth ?? authJson(HOST));
      mode = jwksMode;
      tokenCalls.length = 0;
      const r = await s.prepare();
      mode = "ok";
      assert.deepEqual(r, { ok: false, line: `login-refresh refused (${reason})` });
      assert.equal(tokenCalls.length, 0);
      assert.equal(s.hostLogin(), s.original);
    });
  }

  test("an API-key host login starts without a refresh", async () => {
    const s = hostDir(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-not-a-key" }));
    tokenCalls.length = 0;
    assert.deepEqual(await s.prepare(), { ok: true, line: "login-refresh skipped (not refreshable)" });
    assert.equal(tokenCalls.length, 0);
  });

  test("no audit line carries a token, an email, a user or org id, or a provider answer", () => {
    assert.ok(lines.length >= 25, `expected the earlier cases to record lines, got ${lines.length}`);
    for (const line of lines) {
      assert.doesNotMatch(line, /eyJ|rt-|sk-test|junk/, `token material in: ${line}`);
      for (const secret of [EMAIL, USER_A, USER_B, ORG_1, ORG_2, "unauthorized", "invalid_grant", "maintenance", KID]) assert.ok(!line.includes(secret), `identity data in: ${line}`);
    }
  });
});
