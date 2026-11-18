import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { IdentityError, RefreshError, type Identity, type ProviderAdapter } from "../../bin/sandbox/adapters/types.ts";
import { readRegular } from "../../bin/sandbox/files.ts";
import { LOCK_FILE, prepareLogin, withLoginLock, type Prepared } from "../../bin/sandbox/login.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-login-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A provider-neutral double. The login file holds "<account>/<org>[/<tag>]": tag "fresh" is valid for the
// session, tag "apikey" is not refreshable, anything else needs a refresh. identity() reads the file back
// (or throws for "unavailable" / "shape"); refresh() returns `next(text)`, by default "<account>/<org>/fresh".
// No startIdentity, so the core resolves the start identity with identity() on the host login file.
type Double = ProviderAdapter & { calls: string[]; next: (text: string) => Promise<string> | string };
function doubleAdapter(): Double {
  const calls: string[] = [];
  const adapter: Double = {
    calls,
    next: (text: string): Promise<string> | string => `${text.split("/").slice(0, 2).join("/")}/fresh`,
    id: "codex",
    acpCommand: () => ["/bin/true"],
    configEnv: (dir: string) => ({ DOUBLE_HOME: dir }),
    copyIn: ["auth.json", "config.toml"],
    loginFile: "auth.json",
    egressHosts: ["api.example.com"],
    async identity(file: string): Promise<Identity> {
      calls.push(`identity:${file.endsWith(".tmp") ? "refreshed" : "host"}`);
      const text = readRegular(file, 1024);
      if (text === null || text === "unavailable") throw new IdentityError("unavailable");
      if (text === "shape") throw new IdentityError("shape");
      const [account = "", org] = text.split("/");
      return { account, org: org || undefined };
    },
    refreshNeeded(text: string) {
      calls.push("refreshNeeded");
      if (text.endsWith("/fresh")) return "valid" as const;
      if (text.endsWith("/apikey")) return "not-refreshable" as const;
      return "refresh" as const;
    },
    async refresh(text: string): Promise<string> {
      calls.push("refresh");
      return adapter.next(text);
    },
    selfCheckFixture: () => ({ files: {}, forgedLogin: "x" }),
  };
  return adapter;
}

let n = 0;
function setup(hostLogin: string | null) {
  const adapter = doubleAdapter();
  const host = path.join(tmp, `host-${++n}`);
  fs.mkdirSync(host);
  fs.writeFileSync(path.join(host, ".reviewer-sandbox"), "");
  if (hostLogin !== null) fs.writeFileSync(path.join(host, "auth.json"), hostLogin, { mode: 0o600 });
  fs.writeFileSync(path.join(host, "notes.md"), "not allowlisted");
  const copy = path.join(tmp, `copy-${n}`);
  const prepare = (lockWaitMs?: number, copyDir = copy) => prepareLogin(adapter, host, copyDir, { untilMs: Date.now() + 40 * 60_000, lockWaitMs }).then(record);
  return {
    adapter,
    host,
    copy,
    prepare,
    read: () => fs.readFileSync(path.join(host, "auth.json"), "utf8"),
    leftovers: () => fs.readdirSync(host).filter((f) => f.endsWith(".tmp") || f.startsWith(LOCK_FILE)),
  };
}
const lines: string[] = [];
const record = (r: Prepared) => (lines.push(r.line), r);

describe("S10a pre-session refresh (any adapter)", () => {
  test("refresh not needed: no refresh call, the copy follows the allowlist and holds the host login", async () => {
    const s = setup("acct-1/org-1/fresh");
    const r = await s.prepare();
    assert.deepEqual(r, { ok: true, line: "login-refresh skipped (token valid)" });
    assert.deepEqual(s.adapter.calls, ["refreshNeeded"]);
    assert.deepEqual(fs.readdirSync(s.copy).sort(), [".reviewer-sandbox", "auth.json"]);
    assert.equal(fs.readFileSync(path.join(s.copy, "auth.json"), "utf8"), "acct-1/org-1/fresh");
    assert.deepEqual(s.leftovers(), []);
  });

  test("no host login (marker-only dir) and a not-refreshable login (API-key mode) start without a refresh", async () => {
    const none = setup(null);
    assert.deepEqual(await none.prepare(), { ok: true, line: "login-refresh skipped (no login)" });
    assert.deepEqual(fs.readdirSync(none.copy), [".reviewer-sandbox"]);
    const key = setup("acct-1/org-1/apikey");
    assert.deepEqual(await key.prepare(), { ok: true, line: "login-refresh skipped (not refreshable)" });
    assert.deepEqual(key.adapter.calls, ["refreshNeeded"]);
  });

  test("refresh succeeds: exactly the new login is saved at 0600 and the copy holds it", async () => {
    const s = setup("acct-1/org-1/expired");
    const r = await s.prepare();
    assert.equal(r.ok, true);
    assert.match(r.line, /^login-refresh refreshed \(same account\) id=[0-9a-f]{12}$/);
    assert.deepEqual(s.adapter.calls, ["refreshNeeded", "identity:host", "refresh", "identity:refreshed", "refreshNeeded"]);
    assert.equal(s.read(), "acct-1/org-1/fresh");
    assert.equal(fs.statSync(path.join(s.host, "auth.json")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(s.copy, "auth.json"), "utf8"), "acct-1/org-1/fresh");
    assert.deepEqual(s.leftovers(), []);
  });

  test("R-33: a refreshed token shorter than the session budget is saved, but the session does not start", async () => {
    const s = setup("acct-1/org-1/expired");
    s.adapter.next = () => "acct-1/org-1/short";
    const r = await s.prepare();
    assert.equal(r.ok, false);
    assert.equal(r.line, "login-refresh refused (refreshed token shorter than the session budget; saved, session not started)");
    assert.deepEqual(s.adapter.calls, ["refreshNeeded", "identity:host", "refresh", "identity:refreshed", "refreshNeeded"]);
    assert.equal(s.read(), "acct-1/org-1/short");
    assert.ok(!fs.existsSync(s.copy), "session copy not made");
    assert.deepEqual(s.leftovers(), []);
  });

  test("another account or organization: refused, host untouched, no copy made", async () => {
    for (const next of ["acct-2/org-1/fresh", "acct-1/org-2/fresh", "acct-1"]) {
      const s = setup("acct-1/org-1/expired");
      s.adapter.next = () => next;
      const r = await s.prepare();
      assert.equal(r.ok, false, next);
      assert.match(r.line, /^login-refresh refused \(identity mismatch\) before=[0-9a-f]{12} refreshed=[0-9a-f]{12}$/);
      assert.equal(s.read(), "acct-1/org-1/expired");
      assert.ok(!fs.existsSync(s.copy), "session copy not made");
      assert.deepEqual(s.leftovers(), []);
    }
  });

  test("every refresh error kind and every identity failure refuses with a fixed reason, host untouched", async () => {
    const cases: [string, (s: ReturnType<typeof setup>) => void, string][] = [
      ["rejected", (s) => (s.adapter.next = () => Promise.reject(new RefreshError("rejected"))), "refresh rejected"],
      ["unavailable", (s) => (s.adapter.next = () => Promise.reject(new RefreshError("unavailable"))), "refresh unavailable"],
      ["shape", (s) => (s.adapter.next = () => Promise.reject(new RefreshError("shape"))), "refresh shape changed"],
      ["other error", (s) => (s.adapter.next = () => Promise.reject(new TypeError("boom"))), "refresh unavailable"],
      ["oversized", (s) => (s.adapter.next = () => "x".repeat(64 * 1024 + 1)), "refresh shape changed"],
      ["refreshed shape", (s) => (s.adapter.next = () => "shape"), "identity shape changed: refreshed login"],
      ["refreshed unavailable", (s) => (s.adapter.next = () => "unavailable"), "identity unavailable: refreshed login"],
      ["bad refreshNeeded", (s) => (s.adapter.refreshNeeded = () => { throw new SyntaxError("x"); }), "host login shape changed"],
    ];
    for (const [name, arrange, reason] of cases) {
      const s = setup("acct-1/org-1/expired");
      arrange(s);
      assert.deepEqual(await s.prepare(), { ok: false, line: `login-refresh refused (${reason})` }, name);
      assert.equal(s.read(), "acct-1/org-1/expired", name);
      assert.ok(!fs.existsSync(s.copy), name);
      assert.deepEqual(s.leftovers(), [], name);
    }
    for (const [hostLogin, reason] of [["unavailable", "identity unavailable: host login"], ["shape", "identity shape changed: host login"]]) {
      const s = setup(hostLogin!);
      assert.deepEqual(await s.prepare(), { ok: false, line: `login-refresh refused (${reason})` });
      assert.ok(!s.adapter.calls.includes("refresh"), "no refresh without a start identity");
    }
  });

  test("a host login that is a symlink or a directory is refused, never followed", async () => {
    const s = setup(null);
    const target = path.join(tmp, `target-${n}`);
    fs.writeFileSync(target, "acct-1/org-1/expired");
    fs.symlinkSync(target, path.join(s.host, "auth.json"));
    assert.deepEqual(await s.prepare(), { ok: false, line: "login-refresh refused (host login is not a regular file within bounds)" });
    assert.equal(fs.readFileSync(target, "utf8"), "acct-1/org-1/expired");
  });

  test("the host login changes while the refresh is pending: refused, the new host login is kept", async () => {
    const s = setup("acct-1/org-1/expired");
    s.adapter.next = (text) => {
      fs.writeFileSync(path.join(s.host, "auth.json"), "acct-1/org-1/operator-relogin"); // concurrent change
      return `${text}-refreshed`;
    };
    assert.deepEqual(await s.prepare(), { ok: false, line: "login-refresh refused (host login changed during refresh)" });
    assert.equal(s.read(), "acct-1/org-1/operator-relogin");
    assert.deepEqual(s.leftovers(), []);
  });

  test("a lock taken away during the refresh: refused (login lock lost), the foreign lock kept", async () => {
    const s = setup("acct-1/org-1/expired");
    const foreign = `${process.pid} ${crypto.randomUUID()} ${Date.now()}`;
    s.adapter.next = () => {
      fs.writeFileSync(path.join(s.host, LOCK_FILE), foreign);
      return "acct-1/org-1/fresh";
    };
    assert.deepEqual(await s.prepare(), { ok: false, line: "login-refresh refused (login lock lost)" });
    assert.equal(s.read(), "acct-1/org-1/expired");
    assert.equal(fs.readFileSync(path.join(s.host, LOCK_FILE), "utf8"), foreign, "unlock never removes a foreign lock");
  });

  test("two concurrent wrappers: serialized, one refreshes and the other then finds the token valid", async () => {
    const s = setup("acct-1/org-1/expired");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.adapter.next = async (text) => {
      await gate;
      return `${text.split("/").slice(0, 2).join("/")}/fresh`;
    };
    const a = s.prepare();
    for (let i = 0; i < 200 && !s.adapter.calls.includes("refresh"); i++) await new Promise((r) => setTimeout(r, 5));
    const b = s.prepare(undefined, `${s.copy}-second`);
    await new Promise((r) => setTimeout(r, 100)); // b is waiting for the lock
    assert.equal(s.adapter.calls.filter((c) => c === "refreshNeeded").length, 1, "the second wrapper has not entered");
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.match(ra.line, /^login-refresh refreshed \(same account\)/);
    assert.deepEqual(rb, { ok: true, line: "login-refresh skipped (token valid)" });
    assert.equal(s.adapter.calls.filter((c) => c === "refresh").length, 1);
    assert.equal(fs.readFileSync(path.join(`${s.copy}-second`, "auth.json"), "utf8"), "acct-1/org-1/fresh");
  });

  test("a wrapper waits for another wrapper's lock, then prepares", async () => {
    const s = setup("acct-1/org-1/expired");
    fs.writeFileSync(path.join(s.host, LOCK_FILE), `${process.pid} ${crypto.randomUUID()} ${Date.now()}`);
    setTimeout(() => fs.rmSync(path.join(s.host, LOCK_FILE), { force: true }), 50);
    assert.equal((await s.prepare()).ok, true);
    assert.equal(s.read(), "acct-1/org-1/fresh");
  });

  test("a login written in the session copy never reaches the host", async () => {
    const s = setup("acct-1/org-1/fresh");
    await s.prepare();
    fs.writeFileSync(path.join(s.copy, "auth.json"), "acct-9/org-9/forged");
    fs.rmSync(s.copy, { recursive: true }); // what the wrapper does when the session ends
    assert.equal(s.read(), "acct-1/org-1/fresh");
  });

  test("no audit line carries a login, an account or org, or a token", () => {
    assert.ok(lines.length > 10);
    for (const l of lines) {
      assert.match(l, /^login-refresh (skipped|refreshed|refused) /);
      assert.doesNotMatch(l, /acct-|org-|\/fresh|expired|forged|relogin/, l);
    }
  });
});

describe("R-21 race-free reader (O_NOFOLLOW + fstat on one descriptor)", () => {
  test("reads a regular file within the bound", () => {
    const f = path.join(tmp, "r21-regular");
    fs.writeFileSync(f, "héllo");
    assert.equal(readRegular(f, 64), "héllo");
    assert.equal(readRegular(f, 3), null); // over the size bound
  });

  test("refuses a symlinked login file without resolving it", () => {
    const target = path.join(tmp, "r21-host-login");
    fs.writeFileSync(target, "acct-9/org-9");
    const link = path.join(tmp, "r21-link.json");
    fs.symlinkSync(target, link);
    assert.equal(readRegular(link, 64 * 1024), null);
    const relLink = path.join(tmp, "r21-rel-link.json");
    fs.symlinkSync("r21-host-login", relLink);
    assert.equal(readRegular(relLink, 64 * 1024), null);
  });

  test("a FIFO in place of the file neither blocks nor reads", { skip: spawnSync("mkfifo", ["--version"]).status !== 0 && "mkfifo missing" }, () => {
    const fifo = path.join(tmp, "r21-fifo");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    assert.equal(readRegular(fifo, 64), null);
  });

  test("a directory or a missing path reads as null", () => {
    assert.equal(readRegular(tmp, 64), null);
    assert.equal(readRegular(path.join(tmp, "r21-missing"), 64), null);
  });
});

describe("R-31 the login lock across real OS processes: never stolen from a live or initializing owner", () => {
  const LOGIN_TS = new URL("../../bin/sandbox/login.ts", import.meta.url).pathname;
  const helper = path.join(tmp, "lock-helper.mjs");
  fs.writeFileSync(
    helper,
    `import fs from "node:fs";
import crypto from "node:crypto";
import { withLoginLock, LOCK_FILE } from ${JSON.stringify(LOGIN_TS)};
const [mode, dir, arg] = process.argv.slice(2);
const lock = dir + "/" + LOCK_FILE;
const say = (m) => fs.writeSync(1, m + "\\n");
if (mode === "hold-old") {
  // A live owner whose token is two minutes old (e.g. it was paused): it must never be evicted.
  fs.writeFileSync(lock, process.pid + " " + crypto.randomUUID() + " " + (Date.now() - 120000), { flag: "wx" });
  say("held");
  setTimeout(() => { fs.rmSync(lock, { force: true }); process.exit(0); }, Number(arg));
} else if (mode === "commit-sleep") {
  // A real owner that blocks inside its critical section, then reports whether it still owns the lock.
  await withLoginLock(dir, (owned) => {
    say("held");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(arg));
    say(owned() ? "still-owner" : "lost");
    return 0;
  });
  process.exit(0);
} else if (mode === "empty") {
  // A creator that made the lock path but never wrote a token (crashed mid-create): never stolen.
  fs.closeSync(fs.openSync(lock, "wx"));
  say("created");
} else if (mode === "dead") {
  fs.writeFileSync(lock, process.pid + " " + crypto.randomUUID() + " " + Date.now(), { flag: "wx" });
  say("written");
}
`,
  );

  // Starts the helper in its own process; resolves once it printed `ready`, with a handle to its output.
  function run(mode: string, dir: string, arg = "0", ready = "") {
    const child = spawn("node", ["--disable-warning=ExperimentalWarning", helper, mode, dir, arg], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    const exited = new Promise<number>((r) => child.on("exit", (c) => r(c ?? 1)));
    const started = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d) => {
        out += d;
        if (out.includes(ready)) resolve();
      });
      child.on("exit", () => (out.includes(ready) ? resolve() : reject(new Error(`helper ${mode} exited early: ${out}`))));
    });
    return { child, started, exited, out: () => out };
  }
  const lockDir = () => {
    const d = path.join(tmp, `r31-${++n}`);
    fs.mkdirSync(d);
    return d;
  };

  test("a live owner with a two-minute-old lock is never evicted: the refresh waits, then refuses (busy)", async () => {
    const s = setup("acct-1/org-1/expired");
    const owner = run("hold-old", s.host, "5000", "held");
    await owner.started;
    const held = fs.readFileSync(path.join(s.host, LOCK_FILE), "utf8");
    const r = await s.prepare(400);
    assert.deepEqual(r, { ok: false, line: "login-refresh refused (login dir busy)" });
    assert.equal(s.read(), "acct-1/org-1/expired", "host unchanged");
    assert.deepEqual(s.adapter.calls, [], "nothing read or refreshed without the lock");
    assert.equal(fs.readFileSync(path.join(s.host, LOCK_FILE), "utf8"), held, "the owner's lock is untouched");
    owner.child.kill("SIGKILL");
    await owner.exited;
  });

  test("an owner blocked inside its critical section keeps the lock; a second process does not enter", async () => {
    const dir = lockDir();
    const owner = run("commit-sleep", dir, "1200", "held");
    await owner.started;
    let entered = false;
    const r = await withLoginLock(dir, () => (entered = true), 400);
    assert.equal(r, null);
    assert.equal(entered, false);
    assert.equal(await owner.exited, 0);
    assert.match(owner.out(), /still-owner/, "the blocked owner still owned its lock when it resumed");
    assert.ok(!fs.existsSync(path.join(dir, LOCK_FILE)), "the owner released it");
  });

  test("an empty lock left by a crashed creator, or a malformed one, is never stolen", async () => {
    const dir = lockDir();
    const creator = run("empty", dir, "0", "created");
    await creator.started;
    await creator.exited; // the creator is gone, but an empty lock has no provable owner
    assert.equal(await withLoginLock(dir, () => "entered", 300), null);
    assert.equal(fs.readFileSync(path.join(dir, LOCK_FILE), "utf8"), "");
    fs.writeFileSync(path.join(dir, LOCK_FILE), "999999999 not-a-token");
    assert.equal(await withLoginLock(dir, () => "entered", 300), null);
    assert.equal(fs.readFileSync(path.join(dir, LOCK_FILE), "utf8"), "999999999 not-a-token");
  });

  test("a well-formed lock of a dead process is never taken over: refused (login dir busy), lock kept", async () => {
    const s = setup("acct-1/org-1/expired");
    const dead = run("dead", s.host, "0", "written");
    await dead.started;
    await dead.exited;
    const before = fs.readFileSync(path.join(s.host, LOCK_FILE), "utf8");
    const r = await s.prepare(300);
    assert.deepEqual(r, { ok: false, line: "login-refresh refused (login dir busy)" });
    assert.equal(s.read(), "acct-1/org-1/expired");
    assert.equal(fs.readFileSync(path.join(s.host, LOCK_FILE), "utf8"), before);
  });
});
