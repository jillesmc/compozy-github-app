// --self-check --provider <p>: runs the core probes (IT-010..IT-017, R-9, R-10, R-17, R-18, R-20) and the
// adapter probes inside the exact bubblewrap profile used for the provider's ACP agent. Prints one
// "ok|FAIL <probe>" line each; exit 0 only when all pass. Provider-neutral: a new adapter gets every probe
// by supplying acpCommand, configEnv, egressHosts, loginFile and selfCheckFixture (ADR-004).
//   A, B: two concurrent sandboxes, each with its own gateway and fake bridge; probes.sh runs inside.
//   C:    R-9 end to end: an agent that injects terminal/create on its stdout, through the normal-mode pump.
//   D:    R-20: an agent that prints a 20 000-deep message; refused, and the temp dir is removed.
//   E:    S10a refresh refusal path: a synthetic host login that needs a refresh, with the adapter's refresh
//         and identity endpoints unreachable: the session is refused before bwrap starts, the host unchanged.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AcpGuard } from "./acp.ts";
import { resolveAdapter } from "./adapters/index.ts";
import { MARKER } from "./login.ts";
import { readRegular } from "./files.ts";
import { IN, loginMountOf, sandboxEnv } from "./profile.ts";
import { HOME, LoginRefused, launch, pumpAgent, validate, type Opts, type Validated } from "./sandbox.ts";

export const INJECTED = '{"jsonrpc":"2.0","id":9,"method":"terminal/create","params":{"sessionId":"S","command":"id"}}';
const UPDATE = (n: number) => `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"S","n":${n}}}`;
const FORGED = ".reviewer-sandbox-forged"; // seeded into the session copy; the probe moves it over the login file

// Recursive name/size/mtime listing, to prove a host login dir is untouched (R-10, R-18).
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(dir, p)} ${st.size} ${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort().join("\n");
}

async function probeSandbox(o: Opts, v: Validated, label: string, mode: string, own: number, other: number) {
  const a = v.adapter;
  const mount = loginMountOf(a);
  const envNames = Object.keys(sandboxEnv(process.env, a.configEnv(mount))).join(" ");
  const acpPaths = a.acpCommand(IN.acpPrefix).filter((p) => p.startsWith("/")).join(" ");
  const inner = [
    "/bin/bash",
    path.posix.join(IN.sandboxDir, "probes.sh"),
    label, mode, String(own), String(other), HOME, v.cwd, String(o.daemonPort),
    envNames, mount, a.egressHosts.join(" "), acpPaths, a.loginFile, a.id,
  ];
  const hostLoginBefore = readRegular(path.join(v.loginDir, a.loginFile), 64 * 1024);
  const sb = await launch(o, v, inner, { seed: { [FORGED]: a.selfCheckFixture().forgedLogin } });
  let out = "";
  sb.bwrap.stdout!.on("data", (d) => (out += d));
  try {
    await sb.allow(own);
    sb.bwrap.stdin!.end("go\n");
  } catch (e) {
    out += `FAIL [${label}] gateway allow ${own}: ${(e as Error).message}\n`;
    sb.stop();
  }
  const code = await sb.closed;
  // Probe output is text; any JSON-RPC line on it is an injection attempt and must be refused (R-9).
  const guard = new AcpGuard(a.extraAgentMethods);
  const lines = out.split("\n").filter(Boolean).map((l) => {
    if (!l.startsWith("{")) return l;
    const verdict = guard.agentLine(l);
    return verdict.kind === "fatal"
      ? `ok [${label}] R-9 injected terminal/create on agent stdout refused by the wrapper filter (${verdict.reason})`
      : `FAIL [${label}] R-9 injected line would be forwarded: ${l.slice(0, 80)}`;
  });
  if (mode === "full") {
    if (!lines.some((l) => l.includes("R-9 injected terminal/create on agent stdout"))) {
      lines.push(`FAIL [${label}] R-9 probe did not emit the injected line`);
    }
    // S10a: the forged login written inside never reaches the host (nothing is ever copied back).
    const after = readRegular(path.join(v.loginDir, a.loginFile), 64 * 1024);
    lines.push(
      `${after === hostLoginBefore ? "ok" : "FAIL"} [${label}] R-18 session-written login never reaches the host ` +
        `(${a.loginFile} ${after === hostLoginBefore ? "unchanged" : "CHANGED"}; ${sb.loginLine})`,
    );
    const want = [...new Set(a.egressHosts.map((h) => h.toLowerCase()))].sort().join(",");
    lines.push(`${sb.egress === want ? "ok" : "FAIL"} [${label}] adapter ${a.id}: gateway allowlist = egressHosts (${sb.egress || "none"})`);
  }
  if (code !== 0) lines.push(`FAIL [${label}] probe sandbox exited ${code}`);
  return lines;
}

// R-9 end to end through the same pump as normal mode.
async function injectionSandbox(o: Opts, v: Validated): Promise<string[]> {
  const script = `printf '%s\\n' '${UPDATE(1)}' '${INJECTED}'; sleep 5; printf '%s\\n' '${UPDATE(2)}'`;
  const started = Date.now();
  const sb = await launch(o, v, ["/bin/bash", "-c", script]);
  const forwarded: string[] = [];
  let reason = "";
  pumpAgent(sb, new AcpGuard(v.adapter.extraAgentMethods), (l) => forwarded.push(l), (r) => (reason = r));
  sb.bwrap.stdin!.end();
  await sb.closed;
  const ms = Date.now() - started;
  const ok = reason.includes("terminal/create") && forwarded.length === 1 && forwarded[0] === UPDATE(1) && ms < 4500;
  return [
    `${ok ? "ok" : "FAIL"} [C] R-9 injected terminal/create refused (session stopped after ${ms} ms; ` +
      `${forwarded.length} line forwarded before it; reason: ${reason || "none"})`,
  ];
}

// R-20: pathological nesting through the same pump: fatal, and the per-session temp dir is removed.
async function deepNestingSandbox(o: Opts, v: Validated): Promise<string[]> {
  const gen =
    'const n=20000;process.stdout.write(\'{"jsonrpc":"2.0","method":"session/update","params":\'+\'{"a":\'.repeat(n)+"1"+"}".repeat(n)+"}\\n")';
  const sb = await launch(o, v, [IN.node, "-e", gen]);
  let reason = "";
  let forwarded = 0;
  pumpAgent(sb, new AcpGuard(v.adapter.extraAgentMethods), () => forwarded++, (r) => (reason = r));
  sb.bwrap.stdin!.end();
  await sb.closed;
  const ok = reason.includes("nesting deeper than") && forwarded === 0 && !fs.existsSync(sb.rt);
  return [
    `${ok ? "ok" : "FAIL"} [D] R-20 20000-deep agent message refused, temp dir removed ` +
      `(reason: ${reason || "none"}; forwarded ${forwarded}; temp dir ${fs.existsSync(sb.rt) ? "left" : "gone"})`,
  ];
}

// A local port nothing listens on (bound, then closed); never the daemon port.
async function closedLocalPort(daemonPort: number): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    if (port !== daemonPort) return port;
  }
}

// S10a refresh refusal path with synthetic data only (never real tokens): a fixture host login that needs a
// refresh, and the adapter's identity and refresh endpoints pointed at a closed local port. The session must
// be refused before bwrap starts, with the fixture host login unchanged.
async function refreshRefusalProbe(o: Opts, v: Validated): Promise<string[]> {
  const port = await closedLocalPort(o.daemonPort);
  const base = `http://127.0.0.1:${port}`;
  const adapter = resolveAdapter(v.adapter.id, { identityBaseUrl: base, refreshBaseUrl: base, timeoutMs: 2000 });
  const fixture = adapter.selfCheckFixture();
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-sandbox-fixture-"));
  try {
    fs.writeFileSync(path.join(hostDir, MARKER), "");
    for (const [name, text] of Object.entries(fixture.files)) fs.writeFileSync(path.join(hostDir, name), text, { mode: 0o600 });
    const before = snapshot(hostDir);
    let line = "";
    let started = false;
    try {
      const sb = await launch(o, v, ["/bin/true"], { adapter, loginDir: hostDir });
      started = true;
      sb.bwrap.stdout!.resume();
      sb.bwrap.stdin!.end();
      await sb.closed;
      line = sb.loginLine;
    } catch (e) {
      if (!(e instanceof LoginRefused)) throw e;
      line = e.message;
    }
    const unchanged = snapshot(hostDir) === before;
    const ok = !started && line.startsWith("login-refresh refused (") && unchanged;
    return [
      `${ok ? "ok" : "FAIL"} [E] adapter ${adapter.id}: near-expiry login with an unreachable refresh endpoint ` +
        `(127.0.0.1:${port}): session ${started ? "STARTED" : "refused before start"} (${line || "no decision"}); ` +
        `fixture host dir ${unchanged ? "unchanged" : "CHANGED"}`,
    ];
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
}

export async function selfCheck(o: Opts) {
  const v = validate(o);
  const before = snapshot(v.loginDir);
  const fakeBridge = (label: string) =>
    new Promise<{ port: number; server: http.Server }>((resolve) => {
      const server = http.createServer((_req, res) => res.end(`bridge-${label}`));
      server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, server }));
    });
  const [a, b] = await Promise.all([fakeBridge("A"), fakeBridge("B")]);
  const results = await Promise.all([
    probeSandbox(o, v, "A", "full", a.port, b.port),
    probeSandbox(o, v, "B", "bridge", b.port, a.port),
    injectionSandbox(o, v),
    deepNestingSandbox(o, v),
    refreshRefusalProbe(o, v),
  ]);
  a.server.close();
  b.server.close();
  const lines = results.flat();
  lines.push(
    `${snapshot(v.loginDir) === before ? "ok" : "FAIL"} [host] R-10/R-18 writes to the login copy inside ` +
      "(instructions, settings, agents/, forged login) did not reach the host login dir",
  );
  for (const l of lines) process.stdout.write(l + "\n");
  if (lines.some((l) => !l.startsWith("ok "))) {
    process.stdout.write(`self-check --provider ${v.adapter.id}: FAILED\n`);
    process.exit(1);
  }
  process.stdout.write(`self-check --provider ${v.adapter.id}: all ${lines.length} probes passed\n`);
  process.exit(0);
}
