// Pure, provider-neutral pieces of reviewer-sandbox: the ACP stdio tap, the cwd guard, the env allowlist
// and the bubblewrap profile. No I/O here so they can be unit-tested (test/sandbox). Everything specific
// to a provider CLI lives in its adapter (bin/sandbox/adapters/).
import path from "node:path";

export const IN = {
  home: "/home/reviewer",
  login: "/home/reviewer/.reviewer-login", // per-session login copy; the adapter's configEnv points the CLI here
  node: "/opt/node/bin/node",
  acpPrefix: "/opt/acp", // the provider's pre-installed ACP prefix, read-only
  sandboxDir: "/opt/reviewer-sandbox",
  gatewayDir: "/run/reviewer",
  gatewaySock: "/run/reviewer/gw.sock",
  proxy: "http://127.0.0.1:3128",
  caBundle: "/etc/ssl/certs/ca-certificates.crt",
} as const;

// ---- ACP stdio tap ---------------------------------------------------------------------------------

export type TapVerdict =
  | { kind: "pass" }
  | { kind: "allow"; ports: number[] }
  | { kind: "reject"; reason: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function inspectMessage(msg: unknown, boundCwd: string): TapVerdict {
  if (!msg || typeof msg !== "object") return { kind: "pass" };
  const params = (msg as { params?: unknown }).params;
  if (!params || typeof params !== "object") return { kind: "pass" };
  const p = params as { cwd?: unknown; mcpServers?: unknown };
  if (p.cwd !== undefined && (typeof p.cwd !== "string" || !within(path.resolve(p.cwd), boundCwd))) {
    return { kind: "reject", reason: `cwd ${String(p.cwd)} is not the bound session cwd ${boundCwd}` };
  }
  if (p.mcpServers === undefined) return { kind: "pass" };
  if (!Array.isArray(p.mcpServers)) return { kind: "reject", reason: "mcpServers is not an array" };
  const ports: number[] = [];
  for (const [i, s] of p.mcpServers.entries()) {
    const url = (s as { url?: unknown } | null)?.url;
    if (typeof url !== "string") {
      return { kind: "reject", reason: `mcpServers[${i}] has no url (only http bridge servers are allowed)` };
    }
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { kind: "reject", reason: `mcpServers[${i}].url is not a URL` };
    }
    if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname) || u.port === "") {
      return { kind: "reject", reason: `mcpServers[${i}].url ${u.origin} is not http://127.0.0.1:<port>` };
    }
    ports.push(Number(u.port));
  }
  return ports.length ? { kind: "allow", ports: [...new Set(ports)] } : { kind: "pass" };
}

// One newline-delimited JSON-RPC message from CompozyOS to the agent. Lines that are not JSON pass:
// the tap only ever grants ports, and the gateway refuses anything not granted.
export function inspectClientLine(line: string, boundCwd: string): TapVerdict {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return { kind: "pass" };
  }
  const verdicts = (Array.isArray(msg) ? msg : [msg]).map((m) => inspectMessage(m, boundCwd));
  const rejected = verdicts.find((v) => v.kind === "reject");
  if (rejected) return rejected;
  const ports = verdicts.flatMap((v) => (v.kind === "allow" ? v.ports : []));
  return ports.length ? { kind: "allow", ports: [...new Set(ports)] } : { kind: "pass" };
}

// ---- cwd guard -------------------------------------------------------------------------------------

// The session cwd is bound read-only (R-11: allowlist, not denylist). It must be an absolute git checkout,
// inside one of `roots` when roots are given, never a host socket/device tree (/run, /var/run, /dev, /proc,
// /sys, /tmp itself) or anything containing one, and never the operator HOME, an ancestor of it, or one of
// its dot-directories other than a managed worktree ~/.compozy/worktrees/<workspace>/<name>.
const HOST_TREES = ["/run", "/var/run", "/dev", "/proc", "/sys"];

export type CwdFacts = { hasGit: boolean; roots?: readonly string[] };

export function checkCwd(cwd: string, home: string, facts: CwdFacts): string | null {
  if (!path.isAbsolute(cwd)) return `cwd ${cwd} is not absolute`;
  for (const t of HOST_TREES) {
    if (within(cwd, t) || within(t, cwd)) return `cwd ${cwd} overlaps the host tree ${t}`;
  }
  if (within("/tmp", cwd)) return `cwd ${cwd} is /tmp or contains it`;
  if (within(home, cwd)) return `cwd ${cwd} contains the operator HOME`;
  if (within(cwd, home)) {
    const first = path.relative(home, cwd).split(path.sep)[0] ?? "";
    const worktrees = path.join(home, ".compozy", "worktrees");
    // A managed worktree is ~/.compozy/worktrees/<workspace>/<name>; anything shallower holds many.
    const managed = within(cwd, worktrees) && path.relative(worktrees, cwd).split(path.sep).length >= 2;
    if (first.startsWith(".") && !managed) return `cwd ${cwd} is inside ${path.join(home, first)}`;
  }
  if (facts.roots?.length && !facts.roots.some((r) => within(cwd, r) && path.relative(r, cwd) !== "")) {
    return `cwd ${cwd} is not inside any --worktree-root (${facts.roots.join(", ")})`;
  }
  if (!facts.hasGit) return `cwd ${cwd} is not a git checkout (no .git)`;
  return null;
}

// ---- environment allowlist -------------------------------------------------------------------------

const PASS_THROUGH = ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"] as const;

// Core variables an adapter's configEnv may not override (egress and trust store stay core-owned).
export const PROTECTED_ENV = [
  "PATH", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
] as const;

export function sandboxEnv(hostEnv: Record<string, string | undefined>, adapterEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    HOME: IN.home,
    USER: "reviewer",
    LOGNAME: "reviewer",
    PATH: "/opt/node/bin:/usr/bin:/bin",
    TMPDIR: "/tmp",
    HTTPS_PROXY: IN.proxy,
    https_proxy: IN.proxy,
    HTTP_PROXY: IN.proxy,
    http_proxy: IN.proxy,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    NODE_EXTRA_CA_CERTS: IN.caBundle,
    SSL_CERT_FILE: IN.caBundle,
  };
  for (const k of PASS_THROUGH) {
    const v = hostEnv[k];
    if (v !== undefined && /^[\w.:@/+-]*$/.test(v)) env[k] = v;
  }
  for (const [k, v] of Object.entries(adapterEnv)) {
    if ((PROTECTED_ENV as readonly string[]).includes(k)) throw new Error(`adapter may not set ${k}`);
    env[k] = v;
  }
  return env;
}

// Where the per-session login copy is bound inside: the adapter's optional `loginMount`, else IN.login. It
// must be a normalized absolute path strictly below the sandbox HOME (a tmpfs), so it can never shadow a core
// mount (/opt, /run, /etc, the worktree).
export function loginMountOf(adapter: { loginMount?: string }): string {
  const m = adapter.loginMount ?? IN.login;
  if (!path.posix.isAbsolute(m) || path.posix.normalize(m) !== m || !m.startsWith(IN.home + "/") || m.endsWith("/")) {
    throw new Error(`adapter loginMount ${m} must be a normalized absolute path under ${IN.home}`);
  }
  return m;
}

// ---- bubblewrap profile ----------------------------------------------------------------------------

export type Profile = {
  cwd: string; // host path, bound read-only at the same path
  loginCopy: string; // per-session login copy, bound read-write at loginMount
  loginMount: string; // where it is bound inside: IN.login, or the adapter's loginMount (see loginMountOf)
  nodeBin: string; // host node binary, bound at IN.node
  acpPrefix: string; // host ACP install prefix of the provider, bound read-only at IN.acpPrefix
  sandboxDir: string; // host bin/sandbox, bound at IN.sandboxDir
  gatewayDir: string; // host dir holding only gw.sock
  etcDir: string; // host dir holding generated passwd, group, hosts
  env: Record<string, string>;
};

export function bwrapArgs(p: Profile, inner: string[]): string[] {
  const a = [
    "--unshare-all", // includes --unshare-net: the only interface is the sandbox's own loopback
    "--die-with-parent",
    "--new-session",
    "--hostname", "reviewer-sandbox",
    "--clearenv",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--ro-bind", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
    "--ro-bind-try", "/etc/localtime", "/etc/localtime",
    "--ro-bind", path.join(p.etcDir, "passwd"), "/etc/passwd",
    "--ro-bind", path.join(p.etcDir, "group"), "/etc/group",
    "--ro-bind", path.join(p.etcDir, "hosts"), "/etc/hosts",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", IN.home,
    "--bind", p.loginCopy, p.loginMount,
    "--ro-bind", p.nodeBin, IN.node,
    "--ro-bind", p.acpPrefix, IN.acpPrefix,
    "--ro-bind", p.sandboxDir, IN.sandboxDir,
    "--ro-bind", p.gatewayDir, IN.gatewayDir,
    "--ro-bind", p.cwd, p.cwd,
    "--chdir", p.cwd,
  ];
  for (const [k, v] of Object.entries(p.env)) a.push("--setenv", k, v);
  a.push(
    "--",
    IN.node,
    "--disable-warning=ExperimentalWarning",
    path.posix.join(IN.sandboxDir, "forwarder.ts"),
    IN.gatewaySock,
    "--",
    ...inner,
  );
  return a;
}
