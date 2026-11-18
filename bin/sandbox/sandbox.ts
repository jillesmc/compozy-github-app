// Shared, provider-neutral setup for reviewer-sandbox (normal mode and --self-check): validation
// and launching one sandbox = one reviewer-gateway + one bubblewrap with a throwaway login copy. Provider
// specifics come from the selected adapter (bin/sandbox/adapters/, ADR-004).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AcpGuard, lineSplitter } from "./acp.ts";
import { resolveAdapter } from "./adapters/index.ts";
import type { ProviderAdapter } from "./adapters/types.ts";
import { MARKER, prepareLogin } from "./login.ts";
import { HOME, defaultAcpPrefix, fatal, log, type Opts } from "./options.ts";
import { IN, bwrapArgs, checkCwd, loginMountOf, sandboxEnv } from "./profile.ts";

export { HOME, defaultAcpPrefix, fatal, log, parseArgs, type Opts } from "./options.ts";

export const SANDBOX_DIR = path.dirname(fileURLToPath(import.meta.url));
// Appends to the gateway log (and stderr) in the gateway's format, so the operator sees every login sync.
function auditLog(o: Opts, line: string) {
  const l = `${new Date().toISOString()} reviewer-sandbox[${process.pid}] ${line}`;
  log(line);
  try {
    fs.appendFileSync(o.gatewayLog, l + "\n");
  } catch {}
}

// Cleanups of live sandboxes. They also run on process exit and on uncaught errors (R-20), so a crashed
// wrapper never leaves the login copy behind. Each is idempotent and synchronous. Nothing is ever copied back
// from a session (S10a), on any path.
const finishers = new Set<() => void>();
process.once("exit", () => {
  for (const f of [...finishers]) f();
});
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (e) => {
    log(`internal error: ${e instanceof Error ? e.message : String(e)}; stopping (fail closed)`);
    process.exit(1);
  });
}

// A pre-session refresh failed: the session must not start (S10a). Thrown by launch before bwrap starts.
export class LoginRefused extends Error {}

function realDir(p: string, what: string): string {
  try {
    const r = fs.realpathSync(p);
    if (!fs.statSync(r).isDirectory()) fatal(`${what} ${p} is not a directory`);
    return r;
  } catch {
    return fatal(`${what} ${p} does not exist`);
  }
}

// The operators' everyday login dirs are never acceptable as a dedicated reviewer login dir.
const EVERYDAY_LOGIN_DIRS = [".claude", ".codex", ".cursor", path.join(".config", "cursor")];

export type Validated = ReturnType<typeof validate>;

export function validate(o: Opts) {
  let adapter: ProviderAdapter;
  try {
    adapter = resolveAdapter(o.provider);
  } catch (e) {
    return fatal((e as Error).message);
  }
  const cwd = realDir(o.cwd, "cwd");
  // R-19: outside the self-check the cwd allowlist is mandatory.
  if (!o.selfCheck && o.worktreeRoots.length === 0) {
    fatal("--worktree-root is required (e.g. --worktree-root ~/.compozy/worktrees); see docs/reviewer-sandbox.md");
  }
  const roots = o.worktreeRoots.map((r) => realDir(r, "--worktree-root"));
  const cwdErr = checkCwd(cwd, HOME, { hasGit: fs.existsSync(path.join(cwd, ".git")), roots });
  if (cwdErr) fatal(cwdErr);
  const loginDir = realDir(o.loginDir, "--login-dir");
  const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : p);
  if (loginDir === real(HOME) || EVERYDAY_LOGIN_DIRS.some((d) => loginDir === real(path.join(HOME, d)))) {
    fatal(`--login-dir must be a dedicated reviewer login dir, not ${loginDir}`);
  }
  if (!fs.existsSync(path.join(loginDir, MARKER))) {
    fatal(`--login-dir ${loginDir} lacks the ${MARKER} marker (see docs/reviewer-sandbox.md)`);
  }
  const acpPrefix = realDir(o.acpPrefix ?? defaultAcpPrefix(adapter.id), "--acp-prefix");
  // Every path of the adapter's ACP command under the prefix must exist in the host install.
  for (const arg of adapter.acpCommand(IN.acpPrefix)) {
    if (!arg.startsWith(IN.acpPrefix + "/")) continue;
    const host = path.join(acpPrefix, arg.slice(IN.acpPrefix.length + 1));
    if (!fs.existsSync(host)) fatal(`provider ${adapter.id}: ACP not installed (${host} missing); see docs/reviewer-sandbox.md`);
  }
  return { adapter, cwd, loginDir, acpPrefix, nodeBin: fs.realpathSync(process.execPath) };
}

export type Sandbox = {
  bwrap: ChildProcess;
  allow(port: number): Promise<void>;
  stop(): void;
  closed: Promise<number>; // after bwrap's stdio closed and the temp dir (session copy included) removed
  rt: string; // per-session temp dir (login copy, gateway socket)
  egress: string; // the gateway's effective CONNECT allowlist, sorted, comma-separated
  audit(line: string): void; // stderr + gateway log
  loginLine: string; // the pre-session login-refresh audit line
};

// Self-check hooks: another adapter instance (e.g. identity or refresh pointed at a local endpoint), another
// login dir, and files seeded into the session copy before bwrap starts.
export type LaunchExtras = { adapter?: ProviderAdapter; loginDir?: string; seed?: Record<string, string> };

// One gateway + one bwrap per sandbox (IT-017): concurrent sessions never share an allowlist.
// The wrapper owns all three stdio streams (R-9): node gives the child socketpairs, which other sandbox
// processes cannot reopen through /proc/<pid>/fd, and the wrapper decides what reaches CompozyOS.
export async function launch(o: Opts, v: Validated, inner: string[], extras: LaunchExtras = {}): Promise<Sandbox> {
  const adapter = extras.adapter ?? v.adapter;
  const loginDir = extras.loginDir ?? v.loginDir;
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-sandbox-"));
  const gwDir = path.join(rt, "gw");
  const etcDir = path.join(rt, "etc");
  const loginCopy = path.join(rt, "login");
  fs.mkdirSync(gwDir, { mode: 0o700 });
  fs.mkdirSync(etcDir, { mode: 0o700 });
  // S10a: refresh the host login if needed, outside the sandbox, then build the throwaway session copy (R-10).
  const untilMs = Date.now() + (o.sessionBudgetMin + o.refreshMarginMin) * 60_000;
  const prepared = await prepareLogin(adapter, loginDir, loginCopy, { untilMs });
  auditLog(o, prepared.line);
  if (!prepared.ok) {
    fs.rmSync(rt, { recursive: true, force: true });
    throw new LoginRefused(prepared.line);
  }
  for (const [name, text] of Object.entries(extras.seed ?? {})) fs.writeFileSync(path.join(loginCopy, name), text, { mode: 0o600 });
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  fs.writeFileSync(path.join(etcDir, "passwd"), `reviewer:x:${uid}:${gid}:reviewer:${IN.home}:/bin/bash\n`);
  fs.writeFileSync(path.join(etcDir, "group"), `reviewer:x:${gid}:\n`);
  fs.writeFileSync(path.join(etcDir, "hosts"), "127.0.0.1 localhost reviewer-sandbox\n");
  fs.mkdirSync(path.dirname(o.gatewayLog), { recursive: true });

  const gateway = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      path.join(SANDBOX_DIR, "gateway.ts"),
      "--socket", path.join(gwDir, "gw.sock"),
      "--log", o.gatewayLog,
      "--daemon-port", String(o.daemonPort),
      ...adapter.egressHosts.flatMap((h) => ["--egress-host", h]),
    ],
    { stdio: ["pipe", "pipe", "inherit"], env: { PATH: "/usr/bin:/bin" } },
  );
  const replies = readline.createInterface({ input: gateway.stdout! });
  const waiters: ((line: string) => void)[] = [];
  replies.on("line", (line) => {
    for (const w of waiters.splice(0)) w(line);
  });
  const nextReply = (match: (l: string) => boolean, timeoutMs: number) =>
    new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("gateway did not answer")), timeoutMs);
      const w = (line: string) => {
        if (match(line)) return clearTimeout(t), resolve(line);
        waiters.push(w);
      };
      waiters.push(w);
      gateway.once("exit", () => reject(new Error("gateway exited")));
    });
  const ready = await nextReply((l) => l.startsWith("ready"), 5000);
  const egress = /^ready egress=(\S*)$/.exec(ready)?.[1] ?? "";

  const profile = {
    cwd: v.cwd,
    loginCopy,
    loginMount: loginMountOf(adapter),
    nodeBin: v.nodeBin,
    acpPrefix: v.acpPrefix,
    sandboxDir: SANDBOX_DIR,
    gatewayDir: gwDir,
    etcDir,
    env: sandboxEnv(process.env, adapter.configEnv(loginMountOf(adapter))),
  };
  const bwrap = spawn("bwrap", bwrapArgs(profile, inner), {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  bwrap.stderr!.pipe(process.stderr);

  const stop = () => {
    if (bwrap.exitCode !== null || bwrap.signalCode !== null) return;
    bwrap.kill("SIGTERM");
    setTimeout(() => bwrap.kill("SIGKILL"), 3000).unref();
  };
  gateway.on("exit", stop); // fail closed: no gateway, no sandbox
  let cleaned = false;
  // Synchronous and idempotent: stop everything and discard the session copy (whatever the session wrote).
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    finishers.delete(cleanup);
    if (bwrap.exitCode === null && bwrap.signalCode === null) bwrap.kill("SIGKILL");
    gateway.stdin!.end();
    gateway.kill("SIGTERM");
    fs.rmSync(rt, { recursive: true, force: true });
  };
  finishers.add(cleanup);
  const closed = new Promise<number>((resolve) => {
    bwrap.on("close", (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 128 : 1));
    });
  });

  return {
    bwrap,
    stop,
    closed,
    rt,
    egress,
    audit: (line: string) => auditLog(o, line),
    loginLine: prepared.line,
    async allow(port: number) {
      const reply = nextReply((l) => l.endsWith(` ${port}`) || l.includes(` ${port} `), 15_000);
      gateway.stdin!.write(`allow ${port}\n`);
      const line = await reply;
      if (!line.startsWith("ok ")) throw new Error(line);
    },
  };
}

// Agent -> client pump shared by normal mode and the self-check (R-9). Forwards what the guard allows,
// drops non-JSON lines, and on anything fatal stops the sandbox and calls onFatal once.
export function pumpAgent(sb: Sandbox, guard: AcpGuard, forward: (line: string) => void, onFatal: (reason: string) => void) {
  let failed = false;
  const fail = (reason: string) => {
    if (failed) return;
    failed = true;
    sb.audit(`refused agent message: ${reason}; stopping (fail closed)`);
    sb.stop();
    onFatal(reason);
  };
  sb.bwrap.stdout!.on(
    "data",
    lineSplitter(
      (line) => {
        if (failed) return;
        let v: ReturnType<AcpGuard["agentLine"]>;
        try {
          v = guard.agentLine(line);
        } catch (e) {
          return fail(`guard error: ${(e as Error).message}`);
        }
        if (v.kind === "forward") forward(v.line);
        else if (v.kind === "drop") log(`dropped agent output line (${v.reason}): ${JSON.stringify(line.slice(0, 120))}`);
        else fail(v.reason);
      },
      () => fail("agent output line too long"),
    ),
  );
}
