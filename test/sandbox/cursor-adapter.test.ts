import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { resolveAdapter } from "../../bin/sandbox/adapters/index.ts";
import { CURSOR_AGENT_VERSION, CURSOR_LOGIN_MOUNT, cursorAdapter, cursorRefreshNeeded } from "../../bin/sandbox/adapters/cursor.ts";
import { GET_ME_PATH, accessTokenOf, authInfoIdentity, decodeGetMe } from "../../bin/sandbox/adapters/cursor-identity.ts";
import { IdentityError, RefreshError, type Identity } from "../../bin/sandbox/adapters/types.ts";
import { copyLoginIn, prepareLogin, type Prepared } from "../../bin/sandbox/login.ts";
import { IN, loginMountOf, sandboxEnv } from "../../bin/sandbox/profile.ts";

// Synthetic identities and tokens only; a local fake of DashboardService/GetMe answers per bearer token.
const AUTH_A = "auth0|user_octocat_0001";
const AUTH_B = "auth0|user_octocat_0002";
const USER_A = 424242421;
const TEAM_1 = 100100101;
const TEAM_2 = 100200102;
const EMAIL = "octocat@example.com";
const LOGIN = "auth.json";
const CONFIG = "cli-config.json";

// ---- minimal protobuf writer for GetMeResponse answers ----
const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const vField = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const sField = (field: number, value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
};
const getMe = (authId: string, userId: number, teamId?: number) =>
  Buffer.from([...sField(1, authId), ...vField(2, userId), ...sField(3, EMAIL), ...sField(4, "Octo"), ...(teamId === undefined ? [] : vField(7, teamId)), ...sField(10, "Acme")]);

type Answer = { status: number; body: Buffer | string; type?: string; delayMs?: number; headers?: Record<string, string> };
const PROTO = "application/proto";
const ANSWERS: Record<string, Answer> = {
  "tok-same": { status: 200, body: getMe(AUTH_A, USER_A, TEAM_1) },
  "tok-other-account": { status: 200, body: getMe(AUTH_B, USER_A, TEAM_1) },
  "tok-other-org": { status: 200, body: getMe(AUTH_A, USER_A, TEAM_2) },
  "tok-no-team": { status: 200, body: getMe(AUTH_A, USER_A) },
  "tok-junk": { status: 401, type: "application/json", body: '{"code":"unauthenticated","message":"invalid token"}' },
  "tok-5xx": { status: 503, type: "text/plain", body: "upstream unavailable" },
  "tok-slow": { status: 200, body: getMe(AUTH_A, USER_A, TEAM_1), delayMs: 1500 },
  "tok-shape": { status: 200, body: Buffer.from([...sField(1, AUTH_A), ...sField(3, EMAIL)]) }, // no user_id
  "tok-wire": { status: 200, body: Buffer.from([...vField(1, 7), ...vField(2, USER_A)]) }, // auth_id as a varint
  "tok-dup": { status: 200, body: Buffer.concat([getMe(AUTH_A, USER_A, TEAM_1), Buffer.from(sField(1, AUTH_B))]) },
  "tok-json": { status: 200, type: "application/json", body: JSON.stringify({ authId: AUTH_A, userId: USER_A, teamId: TEAM_1 }) },
  "tok-redirect": { status: 302, body: "", headers: { location: "http://127.0.0.1:1/elsewhere" } },
};

const seen: { method?: string; url?: string; auth?: string; type?: string; connect?: string; length: number }[] = [];
let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      seen.push({ method: req.method, url: req.url, auth, type: req.headers["content-type"], connect: req.headers["connect-protocol-version"] as string, length: Buffer.concat(chunks).length });
      const a = req.method === "POST" && req.url === GET_ME_PATH ? ANSWERS[auth.replace(/^Bearer /, "")] : undefined;
      const send = () => {
        if (!a) return void res.writeHead(404).end();
        res.writeHead(a.status, { "content-type": a.type ?? PROTO, ...a.headers }).end(a.body);
      };
      if (a?.delayMs) setTimeout(send, a.delayMs).unref();
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.closeAllConnections?.() ?? server.close());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-cursor-adapter-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const loginFor = (token: string) => JSON.stringify({ accessToken: token, refreshToken: `${token}-refresh` }, null, 2);
const configFor = (authInfo: unknown) =>
  JSON.stringify(authInfo === undefined ? { version: 1 } : { version: 1, permissions: { allow: ["Shell(ls)"], deny: [] }, authInfo });
const AUTH_INFO = { authId: AUTH_A, userId: USER_A, teamId: TEAM_1, email: EMAIL, displayName: "Octo Cat", teamName: "Acme" };

let n = 0;
function hostDir(opts: { authInfo?: unknown; timeoutMs?: number; login?: string } = {}) {
  const adapter = cursorAdapter({ identityBaseUrl: base, timeoutMs: opts.timeoutMs ?? 1000 });
  const host = path.join(tmp, `host-${++n}`);
  fs.mkdirSync(host);
  fs.writeFileSync(path.join(host, ".reviewer-sandbox"), "");
  fs.writeFileSync(path.join(host, LOGIN), opts.login ?? loginFor("tok-host"), { mode: 0o600 });
  fs.writeFileSync(path.join(host, CONFIG), configFor("authInfo" in opts ? opts.authInfo : AUTH_INFO));
  const copy = path.join(tmp, `copy-${n}`);
  const hostLogin = () => fs.readFileSync(path.join(host, LOGIN), "utf8");
  const original = hostLogin();
  // The identity the core compares: offline start identity (authInfo) vs GetMe for a login file's token.
  const start = () => outcome(adapter.startIdentity!(host, AbortSignal.timeout(1000)));
  const identityOf = (text: string) => {
    const file = path.join(tmp, `login-${n}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    return outcome(adapter.identity(file, AbortSignal.timeout(2000)));
  };
  const prepare = async (untilMs = Date.now() + 40 * 60_000) => record(await prepareLogin(adapter, host, copy, { untilMs }));
  return { adapter, host, copy, hostLogin, original, start, identityOf, prepare };
}
// "unavailable" / "shape" for IdentityError kinds, else the identity.
async function outcome(p: Promise<Identity>): Promise<Identity | "unavailable" | "shape"> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof IdentityError) return e.kind;
    throw e;
  }
}

const lines: string[] = [];
const record = (r: Prepared) => (lines.push(r.line), r);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwtExp = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: AUTH_A, exp })}.c2ln`;

describe("UT-087 cursor adapter: ACP command, configEnv, login mount, copyIn allowlist, egress", () => {
  test("registered and pinned", () => {
    assert.equal(resolveAdapter("cursor").id, "cursor");
    assert.match(CURSOR_AGENT_VERSION, /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/);
  });

  test("ACP command runs the pinned copy's cursor-agent with acp", () => {
    assert.deepEqual(cursorAdapter().acpCommand("/opt/acp"), ["/opt/acp/cursor-agent", "acp"]);
  });

  test("the session copy is bound at ~/.config/cursor and XDG_CONFIG_HOME points at its parent", () => {
    const a = cursorAdapter();
    assert.equal(loginMountOf(a), `${IN.home}/.config/cursor`);
    assert.equal(CURSOR_LOGIN_MOUNT, `${IN.home}/.config/cursor`);
    assert.deepEqual(a.configEnv(CURSOR_LOGIN_MOUNT), { XDG_CONFIG_HOME: `${IN.home}/.config`, NO_OPEN_BROWSER: "1" });
    assert.throws(() => a.configEnv(IN.login), /must be mounted at \.\.\.\/cursor/);
    const env = sandboxEnv({}, a.configEnv(CURSOR_LOGIN_MOUNT));
    assert.equal(env.XDG_CONFIG_HOME, `${IN.home}/.config`);
    assert.equal(env.HTTPS_PROXY, IN.proxy, "proxy stays core-owned");
  });

  test("login file, egress hosts (provisional) and extra ACP methods", () => {
    const a = cursorAdapter();
    assert.equal(a.loginFile, LOGIN);
    assert.deepEqual(a.copyIn, [LOGIN]);
    assert.deepEqual(a.egressHosts, ["api2.cursor.sh"]);
    for (const m of a.extraAgentMethods ?? []) assert.match(m, /^cursor\//);
  });

  test("copy-in takes only auth.json and the marker (never cli-config.json, mcp.json or policy)", () => {
    const host = path.join(tmp, "copyin-host");
    fs.mkdirSync(path.join(host, "projects"), { recursive: true });
    for (const f of [".reviewer-sandbox", CONFIG, "mcp.json", "mcp-approvals.json", "permissions.json", "projects/p.json"]) fs.writeFileSync(path.join(host, f), "x");
    fs.symlinkSync(path.join(host, CONFIG), path.join(host, LOGIN)); // a symlinked allowlisted name is skipped
    const copy = path.join(tmp, "copyin-copy");
    copyLoginIn(cursorAdapter(), host, copy);
    assert.deepEqual(fs.readdirSync(copy), [".reviewer-sandbox"]);
    fs.rmSync(path.join(host, LOGIN));
    fs.writeFileSync(path.join(host, LOGIN), loginFor("tok-host"));
    const copy2 = path.join(tmp, "copyin-copy2");
    copyLoginIn(cursorAdapter(), host, copy2);
    assert.deepEqual(fs.readdirSync(copy2).sort(), [LOGIN, ".reviewer-sandbox"].sort());
    assert.equal(fs.statSync(copy2).mode & 0o777, 0o700);
  });

  test("the self-check fixture has a known start identity and a well-shaped forged login", async () => {
    const f = cursorAdapter().selfCheckFixture();
    const dir = path.join(tmp, "fixture");
    fs.mkdirSync(dir);
    for (const [name, text] of Object.entries(f.files)) fs.writeFileSync(path.join(dir, name), text);
    const id = await cursorAdapter().startIdentity!(dir, AbortSignal.timeout(1000));
    assert.equal(typeof id.account, "string");
    assert.equal(typeof accessTokenOf(f.forgedLogin), "string");
    assert.doesNotMatch(JSON.stringify(f), /eyJ|@/); // no JWT-looking token, no email
  });
});

describe("UT-088 cursor identity: same account and team only", () => {
  test("a token of the host account and team resolves to the start identity", async () => {
    const s = hostDir();
    assert.deepEqual(await s.identityOf(loginFor("tok-same")), await s.start());
  });

  for (const [name, token] of [["another account", "tok-other-account"], ["the same account in another team", "tok-other-org"], ["the same account without its team", "tok-no-team"]] as const) {
    test(`a token of ${name} resolves to another identity`, async () => {
      const s = hostDir();
      const id = await s.identityOf(loginFor(token));
      assert.equal(typeof id, "object");
      assert.notDeepEqual(id, await s.start());
    });
  }

  test("a login without a team on both sides matches (team optional, compared when present)", async () => {
    const s = hostDir({ authInfo: { authId: AUTH_A, userId: USER_A } });
    assert.deepEqual(await s.identityOf(loginFor("tok-no-team")), await s.start());
  });

  test("the request is the CLI's Connect unary GetMe: POST, bearer token, application/proto, empty body", async () => {
    const s = hostDir();
    seen.length = 0;
    await s.identityOf(loginFor("tok-same"));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { method: "POST", url: GET_ME_PATH, auth: "Bearer tok-same", type: PROTO, connect: "1", length: 0 });
  });
});

describe("UT-088 cursor identity: every failure is unavailable or a shape change (fail closed)", () => {
  const cases: [string, string, "unavailable" | "shape"][] = [
    ["junk token (401)", "tok-junk", "unavailable"],
    ["5xx", "tok-5xx", "unavailable"],
    ["timeout", "tok-slow", "unavailable"],
    ["response shape change (no user_id)", "tok-shape", "shape"],
    ["wrong wire type for auth_id", "tok-wire", "shape"],
    ["duplicate auth_id", "tok-dup", "shape"],
    ["JSON instead of protobuf", "tok-json", "shape"],
    ["redirect (never followed)", "tok-redirect", "unavailable"],
    ["unknown token (404 from the fake)", "tok-unknown", "unavailable"],
  ];
  for (const [name, token, kind] of cases) {
    test(`${name}: ${kind}`, async () => {
      const s = hostDir({ timeoutMs: 300 });
      assert.equal(await s.identityOf(loginFor(token)), kind);
    });
  }

  test("a login without an access token (API-key or junk file) is a shape change", async () => {
    for (const text of [JSON.stringify({ apiKey: "x", refreshToken: "y" }), "not json", JSON.stringify({ accessToken: "a b" })]) {
      assert.equal(await hostDir().identityOf(text), "shape", text);
    }
  });

  test("R-29 a valid access token plus a foreign apiKey or any other credential field is a shape change, before any provider call", async () => {
    const extras: Record<string, unknown>[] = [
      { apiKey: "synthetic-api-key-B" },
      { bedrockCredentials: { accessKey: "AKIASYNTHETIC", secretKey: "synthetic" } },
      { sessionToken: "synthetic" },
      { apiKey: null },
      { apiKey: "" },
    ];
    for (const extra of extras) {
      const s = hostDir();
      seen.length = 0;
      assert.equal(await s.identityOf(JSON.stringify({ accessToken: "tok-same", refreshToken: "tok-same-refresh", ...extra })), "shape", JSON.stringify(extra));
      assert.equal(seen.length, 0);
    }
  });

  test("R-29 a browser login (access and refresh token, or no refresh token) resolves", async () => {
    for (const text of [JSON.stringify({ accessToken: "tok-same", refreshToken: "tok-same-rotated" }), JSON.stringify({ accessToken: "tok-same" })]) {
      const s = hostDir();
      assert.deepEqual(await s.identityOf(text), await s.start(), text);
    }
  });

  test("R-29 a host login that is not a browser login (apiKey present) has no start identity (shape)", async () => {
    const s = hostDir({ login: JSON.stringify({ accessToken: "tok-host", refreshToken: "r", apiKey: "synthetic-api-key-B" }) });
    assert.equal(await s.start(), "shape");
  });

  test("no authInfo: start identity unavailable; a malformed authInfo: shape", async () => {
    assert.equal(await hostDir({ authInfo: undefined }).start(), "unavailable");
    for (const authInfo of [{ authId: "", userId: USER_A }, { authId: AUTH_A, userId: "424242421" }, { authId: AUTH_A, userId: USER_A, teamId: -1 }, { authId: "a b", userId: 1 }, "x"]) {
      assert.equal(await hostDir({ authInfo }).start(), "shape", JSON.stringify(authInfo));
    }
  });
});

describe("UT-089 cursor GetMe decoder and authInfo reader (strict shape)", () => {
  test("reads auth_id, user_id and team_id, skipping unknown fields of every wire type", () => {
    const extra = Buffer.from([...vField(9, 1), 0x59, 1, 2, 3, 4, 5, 6, 7, 8, 0x65, 1, 2, 3, 4]); // 9 varint, 11 fixed64, 12 fixed32
    assert.deepEqual(decodeGetMe(Buffer.concat([getMe(AUTH_A, USER_A, TEAM_1), extra])), { account: AUTH_A, org: String(TEAM_1) });
    assert.deepEqual(decodeGetMe(getMe(AUTH_A, USER_A)), { account: AUTH_A });
  });

  const bad: [string, Buffer][] = [
    ["empty message", Buffer.alloc(0)],
    ["truncated string", Buffer.from([0x0a, 0x20, 0x61])],
    ["truncated varint", Buffer.from([...sField(1, AUTH_A), 0x10, 0x80])],
    ["group wire type", Buffer.from([...getMe(AUTH_A, USER_A), 0x1b])],
    ["field number 0", Buffer.from([0x02, 0x00])],
    ["user_id 0", Buffer.from([...sField(1, AUTH_A), ...vField(2, 0)])],
    ["user_id above int32", Buffer.from([...sField(1, AUTH_A), ...vField(2, 2 ** 31)])],
    ["team_id as a string", Buffer.from([...sField(1, AUTH_A), ...vField(2, USER_A), ...sField(7, "100100101")])],
    ["team_id as fixed32", Buffer.from([...sField(1, AUTH_A), ...vField(2, USER_A), 0x3d, 1, 0, 0, 0])],
    ["auth_id with a space", Buffer.from([...sField(1, "auth0|a b"), ...vField(2, USER_A)])],
    ["auth_id invalid UTF-8", Buffer.from([...sField(1, Uint8Array.from([0xc3, 0x28])), ...vField(2, USER_A)])],
    ["duplicate team_id", Buffer.from([...getMe(AUTH_A, USER_A, TEAM_1), ...vField(7, TEAM_2)])],
  ];
  for (const [name, buf] of bad) {
    test(`${name} is a shape change`, () => {
      assert.throws(() => decodeGetMe(buf), (e: unknown) => e instanceof IdentityError && e.kind === "shape");
    });
  }

  test("authInfo: absent is unavailable, malformed is shape, a valid one gives account and team", () => {
    assert.deepEqual(authInfoIdentity(configFor(AUTH_INFO)), { account: AUTH_A, org: String(TEAM_1) });
    assert.throws(() => authInfoIdentity(configFor(undefined)), (e: unknown) => e instanceof IdentityError && e.kind === "unavailable");
    assert.throws(() => authInfoIdentity("[1]"), (e: unknown) => e instanceof IdentityError && e.kind === "shape");
  });
});

describe("UT-089 cursor pre-session refresh (S10b: the pinned CLI has no browser-login refresh flow)", () => {
  test("refreshNeeded: the access token's JWT exp decides; no access token is not refreshable", () => {
    const until = 2_000_000_000_000;
    assert.equal(cursorRefreshNeeded(JSON.stringify({ accessToken: jwtExp(until / 1000 + 1) }), until), "valid");
    assert.equal(cursorRefreshNeeded(JSON.stringify({ accessToken: jwtExp(until / 1000) }), until), "refresh");
    assert.equal(cursorRefreshNeeded(loginFor("tok-host"), until), "refresh"); // not a JWT
    assert.equal(cursorRefreshNeeded("not json", until), "refresh");
    assert.equal(cursorRefreshNeeded(JSON.stringify({ apiKey: "x" }), until), "not-refreshable");
  });

  test("a fresh host token: the session starts with the host login copied, no provider call", async () => {
    const login = JSON.stringify({ accessToken: jwtExp(Math.floor(Date.now() / 1000) + 3 * 3600), refreshToken: "tok-host-refresh" });
    const s = hostDir({ login });
    seen.length = 0;
    assert.deepEqual(await s.prepare(), { ok: true, line: "login-refresh skipped (token valid)" });
    assert.equal(seen.length, 0);
    assert.equal(fs.readFileSync(path.join(s.copy, LOGIN), "utf8"), login);
  });

  test("refresh never calls the provider: no fetch, refused as unavailable", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const a = cursorAdapter({ refreshBaseUrl: base, identityBaseUrl: base, fetch: counting });
    await assert.rejects(a.refresh(loginFor("tok-host"), AbortSignal.timeout(1000)), (e: unknown) => e instanceof RefreshError && e.kind === "unavailable");
    assert.equal(calls, 0);
  });

  test("a token that needs a refresh: refused (refresh unavailable), host untouched, no copy", async () => {
    const s = hostDir();
    assert.deepEqual(await s.prepare(), { ok: false, line: "login-refresh refused (refresh unavailable)" });
    assert.equal(s.hostLogin(), s.original);
    assert.ok(!fs.existsSync(s.copy));
  });

  test("no audit line carries a token, an email, an account or team id, or a provider answer", () => {
    assert.ok(lines.length >= 2);
    for (const line of lines) {
      assert.doesNotMatch(line, /tok-|eyJ/, `token value in: ${line}`);
      for (const secret of [EMAIL, AUTH_A, AUTH_B, "octocat", String(USER_A), String(TEAM_1), String(TEAM_2)]) assert.ok(!line.includes(secret), `identity data in: ${line}`);
    }
  });
});
