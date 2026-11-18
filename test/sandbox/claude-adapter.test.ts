import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { claudeAdapter } from "../../bin/sandbox/adapters/claude.ts";
import { PROFILE_PATH } from "../../bin/sandbox/adapters/claude-identity.ts";
import { CLAUDE_CLIENT_ID, claudeRefreshNeeded } from "../../bin/sandbox/adapters/claude-refresh.ts";
import { copyLoginIn, prepareLogin, type Prepared } from "../../bin/sandbox/login.ts";

// Synthetic identities and tokens only; local fakes of the token and profile endpoints answer per token.
const ACCT_A = "11111111-1111-4111-8111-111111111111";
const ACCT_B = "22222222-2222-4222-8222-222222222222";
const ORG_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EMAIL = "octocat@example.com";
const LOGIN = ".credentials.json";
const STATE = ".claude.json";
const TOKEN_PATH = "/v1/oauth/token";

type Answer = { status: number; body: string; delayMs?: number; headers?: Record<string, string> };
const profile = (account: string, org: string) =>
  JSON.stringify({ account: { uuid: account, email: EMAIL, display_name: "Octocat" }, organization: { uuid: org, name: "Acme" } });
const PROFILES: Record<string, Answer> = {
  "tok-same": { status: 200, body: profile(ACCT_A, ORG_1) },
  "tok-other-account": { status: 200, body: profile(ACCT_B, ORG_1) },
  "tok-other-org": { status: 200, body: profile(ACCT_A, ORG_2) },
  "tok-junk": { status: 401, body: '{"error":{"type":"authentication_error"}}' },
  "tok-shape": { status: 200, body: JSON.stringify({ account: { id: ACCT_A }, organization: { uuid: ORG_1 } }) },
};
// Token endpoint answers, keyed by the refresh token sent.
const granted = (access: string, extra: Record<string, unknown> = {}): Answer => ({
  status: 200,
  body: JSON.stringify({ token_type: "Bearer", access_token: access, expires_in: 28800, scope: "user:inference user:profile", ...extra }),
});
const TOKENS: Record<string, Answer> = {
  "rt-same": granted("tok-same", { refresh_token: "rt-same-next" }),
  "rt-same-keep": granted("tok-same", { scope: undefined }),
  "rt-other-account": granted("tok-other-account"),
  "rt-other-org": granted("tok-other-org"),
  "rt-identity-401": granted("tok-junk"),
  "rt-identity-shape": granted("tok-shape"),
  "rt-401": { status: 400, body: '{"error":"invalid_grant"}' },
  "rt-5xx": { status: 503, body: "upstream unavailable" },
  "rt-slow": { ...granted("tok-same"), delayMs: 1500 },
  "rt-no-expiry": { status: 200, body: JSON.stringify({ access_token: "tok-same" }) },
  "rt-bad-expiry": { status: 200, body: JSON.stringify({ access_token: "tok-same", expires_in: "8h" }) },
  "rt-no-access": { status: 200, body: JSON.stringify({ expires_in: 3600 }) },
  "rt-not-json": { status: 200, body: "<html>maintenance</html>" },
  "rt-redirect": { status: 302, body: "", headers: { location: "http://127.0.0.1:1/elsewhere" } },
};

const seen: { method?: string; url?: string; auth?: string; type?: string; body: string }[] = [];
let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      seen.push({ method: req.method, url: req.url, auth, type: req.headers["content-type"], body });
      let a: Answer | undefined;
      if (req.method === "GET" && req.url === PROFILE_PATH) a = PROFILES[auth.replace(/^Bearer /, "")];
      if (req.method === "POST" && req.url === TOKEN_PATH) {
        try {
          a = TOKENS[JSON.parse(body).refresh_token];
        } catch {}
      }
      const send = () => {
        if (!a) return void res.writeHead(404).end();
        res.writeHead(a.status, { "content-type": "application/json", ...a.headers }).end(a.body);
      };
      if (a?.delayMs) setTimeout(send, a.delayMs).unref();
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.closeAllConnections?.() ?? server.close());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-claude-adapter-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const loginFor = (refreshToken: string, expiresAt = 1000, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: "tok-host-expired", refreshToken, expiresAt, subscriptionType: "team", scopes: ["user:inference"], ...extra } });

let n = 0;
function hostDir(opts: { login?: string; oauthAccount?: unknown; timeoutMs?: number } = {}) {
  const adapter = claudeAdapter({ identityBaseUrl: base, refreshBaseUrl: base, timeoutMs: opts.timeoutMs ?? 1000 });
  const host = path.join(tmp, `host-${++n}`);
  fs.mkdirSync(host);
  fs.writeFileSync(path.join(host, ".reviewer-sandbox"), "");
  fs.writeFileSync(path.join(host, LOGIN), opts.login ?? loginFor("rt-same"), { mode: 0o600 });
  const oauthAccount = "oauthAccount" in opts ? opts.oauthAccount : { accountUuid: ACCT_A, organizationUuid: ORG_1, emailAddress: EMAIL };
  fs.writeFileSync(path.join(host, STATE), JSON.stringify(oauthAccount === undefined ? { numStartups: 1 } : { oauthAccount }));
  const copy = path.join(tmp, `copy-${n}`);
  const hostLogin = () => fs.readFileSync(path.join(host, LOGIN), "utf8");
  const original = hostLogin();
  const prepare = async () => record(await prepareLogin(adapter, host, copy, { untilMs: Date.now() + 40 * 60_000 }));
  return { adapter, host, copy, hostLogin, original, prepare };
}

const lines: string[] = [];
const record = (r: Prepared) => (lines.push(r.line), r);
const oauthOf = (text: string) => JSON.parse(text).claudeAiOauth;

describe("UT-080 claude adapter: configEnv, copyIn allowlist, egress, ACP command", () => {
  test("configEnv points the CLI at the session copy and disables non-essential traffic", () => {
    assert.deepEqual(claudeAdapter().configEnv("/home/reviewer/.reviewer-login"), {
      CLAUDE_CONFIG_DIR: "/home/reviewer/.reviewer-login",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });

  test("login file, egress hosts and ACP entry", () => {
    const a = claudeAdapter();
    assert.equal(a.loginFile, LOGIN);
    assert.deepEqual(a.egressHosts, ["api.anthropic.com"]);
    assert.deepEqual(a.acpCommand("/opt/acp"), ["/opt/node/bin/node", "/opt/acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"]);
  });

  test("copy-in takes only the allowlisted regular files and the marker", () => {
    const host = path.join(tmp, "copyin-host");
    fs.mkdirSync(path.join(host, "agents"), { recursive: true });
    fs.mkdirSync(path.join(host, "projects"));
    for (const f of [".reviewer-sandbox", LOGIN, "CLAUDE.md", "settings.json", "agents/a.md", "projects/p.jsonl"]) fs.writeFileSync(path.join(host, f), "x");
    fs.symlinkSync(path.join(host, "settings.json"), path.join(host, STATE)); // a symlinked allowlisted name is skipped
    const copy = path.join(tmp, "copyin-copy");
    copyLoginIn(claudeAdapter(), host, copy);
    assert.deepEqual(fs.readdirSync(copy).sort(), [LOGIN, ".reviewer-sandbox"].sort());
    assert.equal(fs.statSync(copy).mode & 0o777, 0o700);
  });
});

describe("UT-081 claude pre-session refresh: the CLI's own flow, same account and organization only", () => {
  test("refreshNeeded: valid only when expiresAt is past the session budget; not refreshable without OAuth", () => {
    const until = 1_000_000;
    assert.equal(claudeRefreshNeeded(loginFor("rt", until + 1), until), "valid");
    assert.equal(claudeRefreshNeeded(loginFor("rt", until), until), "refresh");
    assert.equal(claudeRefreshNeeded(loginFor("rt", until + 1, { accessToken: "" }), until), "refresh");
    assert.equal(claudeRefreshNeeded(loginFor("rt", until + 1, { expiresAt: "soon" }), until), "refresh");
    assert.equal(claudeRefreshNeeded(JSON.stringify({ primaryApiKey: "x" }), until), "not-refreshable");
    assert.equal(claudeRefreshNeeded("not json", until), "not-refreshable");
  });

  test("a valid login is copied without any network call", async () => {
    const s = hostDir({ login: loginFor("rt-same", Date.now() + 3 * 3600_000) });
    seen.length = 0;
    assert.deepEqual(await s.prepare(), { ok: true, line: "login-refresh skipped (token valid)" });
    assert.equal(seen.length, 0);
    assert.equal(fs.readFileSync(path.join(s.copy, LOGIN), "utf8"), s.original);
  });

  test("same-account refresh: the request is the CLI's, and only the obtained set is merged and saved at 0600", async () => {
    const s = hostDir({ login: JSON.stringify({ claudeAiOauth: oauthOf(loginFor("rt-same")), mcpOAuth: { keep: 1 } }) });
    seen.length = 0;
    const t0 = Date.now();
    const r = await s.prepare();
    assert.equal(r.ok, true);
    assert.match(r.line, /^login-refresh refreshed \(same account\) id=[0-9a-f]{12}$/);
    const tokenCall = seen.find((x) => x.url === TOKEN_PATH);
    assert.equal(tokenCall?.method, "POST");
    assert.equal(tokenCall?.type, "application/json");
    assert.deepEqual(JSON.parse(tokenCall!.body), { grant_type: "refresh_token", refresh_token: "rt-same", client_id: CLAUDE_CLIENT_ID, scope: "user:inference" });
    assert.deepEqual(seen.filter((x) => x.url === PROFILE_PATH).map((x) => x.auth), ["Bearer tok-same"], "identity of the refreshed token");
    const saved = JSON.parse(s.hostLogin());
    assert.deepEqual(saved.mcpOAuth, { keep: 1 }, "other top-level keys kept");
    assert.equal(saved.claudeAiOauth.accessToken, "tok-same");
    assert.equal(saved.claudeAiOauth.refreshToken, "rt-same-next");
    assert.deepEqual(saved.claudeAiOauth.scopes, ["user:inference", "user:profile"]);
    assert.equal(saved.claudeAiOauth.subscriptionType, "team", "other OAuth fields kept");
    assert.ok(saved.claudeAiOauth.expiresAt >= t0 + 28800_000 && saved.claudeAiOauth.expiresAt <= Date.now() + 28800_000);
    assert.equal(fs.statSync(path.join(s.host, LOGIN)).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(s.copy, LOGIN), "utf8"), s.hostLogin(), "the copy holds the refreshed login");
    assert.deepEqual(fs.readdirSync(s.host).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock")), []);
  });

  test("no refresh token or scope returned: the old refresh token and scopes are kept", async () => {
    const s = hostDir({ login: loginFor("rt-same-keep") });
    assert.equal((await s.prepare()).ok, true);
    const o = oauthOf(s.hostLogin());
    assert.equal(o.refreshToken, "rt-same-keep");
    assert.deepEqual(o.scopes, ["user:inference"]);
  });

  for (const [name, rt] of [["another account", "rt-other-account"], ["the same account in another organization", "rt-other-org"]] as const) {
    test(`a refresh that yields ${name} is refused, host untouched, no copy`, async () => {
      const s = hostDir({ login: loginFor(rt) });
      const r = await s.prepare();
      assert.equal(r.ok, false);
      assert.match(r.line, /^login-refresh refused \(identity mismatch\) before=[0-9a-f]{12} refreshed=[0-9a-f]{12}$/);
      assert.equal(s.hostLogin(), s.original);
      assert.ok(!fs.existsSync(s.copy));
    });
  }
});

describe("UT-082 claude pre-session refresh: every failure refuses (fail closed)", () => {
  const cases: [string, string, string][] = [
    ["invalid grant (4xx)", "rt-401", "refresh rejected"],
    ["5xx", "rt-5xx", "refresh unavailable"],
    ["timeout", "rt-slow", "refresh unavailable"],
    ["redirect (never followed)", "rt-redirect", "refresh unavailable"],
    ["no expires_in", "rt-no-expiry", "refresh shape changed"],
    ["non-numeric expires_in", "rt-bad-expiry", "refresh shape changed"],
    ["no access token", "rt-no-access", "refresh shape changed"],
    ["non-JSON 200", "rt-not-json", "refresh shape changed"],
    ["unknown refresh token (404 from the fake)", "rt-unknown", "refresh rejected"],
    ["refreshed token rejected by the profile endpoint", "rt-identity-401", "identity unavailable: refreshed login"],
    ["profile shape change", "rt-identity-shape", "identity shape changed: refreshed login"],
  ];
  for (const [name, rt, reason] of cases) {
    test(`${name} is refused`, async () => {
      const s = hostDir({ login: loginFor(rt), timeoutMs: 300 });
      assert.deepEqual(await s.prepare(), { ok: false, line: `login-refresh refused (${reason})` });
      assert.equal(s.hostLogin(), s.original);
      assert.ok(!fs.existsSync(s.copy));
    });
  }

  test("a host login without a refresh token or scopes is refused as a refresh shape change, without a call", async () => {
    for (const login of [loginFor(""), loginFor("rt-same", 1000, { scopes: [] })]) {
      const s = hostDir({ login });
      seen.length = 0;
      assert.deepEqual(await s.prepare(), { ok: false, line: "login-refresh refused (refresh shape changed)" });
      assert.equal(seen.filter((x) => x.url === TOKEN_PATH).length, 0);
    }
  });

  test("no oauthAccount on the host: refused, identity unavailable (host login), no refresh call", async () => {
    const s = hostDir({ oauthAccount: undefined });
    seen.length = 0;
    assert.deepEqual(await s.prepare(), { ok: false, line: "login-refresh refused (identity unavailable: host login)" });
    assert.equal(seen.length, 0);
  });

  test("a malformed oauthAccount: refused, identity shape changed (host login)", async () => {
    const s = hostDir({ oauthAccount: { accountUuid: "not-a-uuid", organizationUuid: ORG_1 } });
    assert.deepEqual(await s.prepare(), { ok: false, line: "login-refresh refused (identity shape changed: host login)" });
  });

  test("no audit line carries a token, an email, a raw UUID or a provider answer", () => {
    assert.ok(lines.length >= 15, `expected the earlier cases to record lines, got ${lines.length}`);
    for (const line of lines) {
      assert.doesNotMatch(line, /tok-|rt-/, `token value in: ${line}`);
      for (const secret of [EMAIL, ACCT_A, ACCT_B, ORG_1, ORG_2, "authentication_error", "invalid_grant", "maintenance"]) {
        assert.ok(!line.includes(secret), `identity data in: ${line}`);
      }
    }
  });
});
