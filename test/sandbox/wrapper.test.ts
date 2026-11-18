import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const WRAPPER = fileURLToPath(new URL("../../bin/reviewer-sandbox", import.meta.url));
const SANDBOX_TS = fileURLToPath(new URL("../../bin/sandbox/sandbox.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const ACP_PREFIX = process.env.REVIEWER_ACP_PREFIX ?? path.join(os.homedir(), ".local", "share", "reviewer-sandbox", "claude");

test("R-19 normal mode refuses to start without --worktree-root", () => {
  const r = spawnSync(WRAPPER, ["--provider", "claude", "--login-dir", "/nonexistent"], { input: "", encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--worktree-root is required/);
});

test("ADR-004 an unknown provider fails at start", () => {
  const r = spawnSync(WRAPPER, ["--provider", "gemini", "--login-dir", "/nonexistent"], { input: "", encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown provider gemini/);
});

test("ADR-004 cursor is implemented (S9): it resolves and fails only on the wrapper's own validation", () => {
  const r = spawnSync(WRAPPER, ["--provider", "cursor", "--login-dir", "/nonexistent"], { input: "", encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /not yet implemented|unknown provider/);
  assert.match(r.stderr, /--worktree-root is required/);
});

test("ADR-004 the removed --claude-config flag is rejected", () => {
  const r = spawnSync(WRAPPER, ["--claude-config", "/nonexistent"], { input: "", encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument --claude-config/);
});

// Needs the host pieces the sandbox runs on: bwrap, Node >= 24 and the dedicated claude-agent-acp install.
const hostReady =
  spawnSync("bwrap", ["--version"]).status === 0 &&
  spawnSync("node", ["--version"]).status === 0 &&
  fs.existsSync(path.join(ACP_PREFIX, "node_modules"));

test("R-20/R-21/S10a an uncaught wrapper error removes the session temp dir; a session-written login never reaches the host", { skip: !hostReady && "bwrap, node or claude-agent-acp missing" }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-crash-test-"));
  try {
    const config = path.join(tmp, "claude");
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, ".reviewer-sandbox"), "");
    // Valid well past the session budget, so the pre-session step makes no network call.
    const cred = (o: Record<string, unknown>) =>
      JSON.stringify({ claudeAiOauth: { accessToken: "a1", refreshToken: "r1", expiresAt: 4102444800000, subscriptionType: "team", scopes: ["user:inference"], ...o } });
    const hostLogin = cred({});
    fs.writeFileSync(path.join(config, ".credentials.json"), hostLogin, { mode: 0o600 });
    // A login written by the session: nothing is ever copied back, on any path.
    const refreshed = cred({ accessToken: "a2", refreshToken: "r2", expiresAt: 4102444900000 });
    const log = path.join(tmp, "gateway.log");
    const script = path.join(tmp, "crash.mjs");
    fs.writeFileSync(
      script,
      `import fs from "node:fs";
import { launch, validate } from ${JSON.stringify(SANDBOX_TS)};
const o = { provider: "claude", loginDir: ${JSON.stringify(config)}, acpPrefix: ${JSON.stringify(ACP_PREFIX)}, cwd: ${JSON.stringify(REPO)},
  worktreeRoots: [], gatewayLog: ${JSON.stringify(log)}, daemonPort: 2123, sessionBudgetMin: 30, refreshMarginMin: 10, selfCheck: true };
const sb = await launch(o, validate(o), ["/bin/sleep", "30"]);
process.stdout.write(sb.rt + "\\n");
fs.writeFileSync(sb.rt + "/login/.credentials.json", ${JSON.stringify(refreshed)});
setTimeout(() => { throw new Error("simulated crash"); }, 300);
`,
    );
    const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", script], { encoding: "utf8", timeout: 20_000 });
    const rt = r.stdout.trim();
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /internal error: simulated crash; stopping \(fail closed\)/);
    assert.match(rt, /reviewer-sandbox-/);
    assert.equal(fs.existsSync(rt), false, `${rt} must be removed`);
    const audit = fs.readFileSync(log, "utf8");
    assert.match(audit, /login-refresh skipped \(token valid\)/);
    assert.doesNotMatch(audit, /login-sync/);
    assert.equal(fs.readFileSync(path.join(config, ".credentials.json"), "utf8"), hostLogin);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
