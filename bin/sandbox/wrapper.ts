// reviewer-sandbox (ADR-002, ADR-004): runs the selected provider's ACP agent under bubblewrap with no
// network, behind a per-sandbox reviewer-gateway, and guards both directions of the ACP stdio.
//
//   reviewer-sandbox --provider claude|codex|cursor --login-dir DIR --worktree-root DIR [--worktree-root DIR]...
//                    [--acp-prefix DIR] [--cwd DIR] [--gateway-log FILE] [--daemon-port N]
//   reviewer-sandbox --provider P --login-dir DIR --self-check
//
// Fails closed: any setup error, a rejected session/new, a gateway that cannot confirm the bridge port, or
// a refused agent message stops the sandbox and exits non-zero, so the CompozyOS session reports failed.
import readline from "node:readline";
import { AcpGuard } from "./acp.ts";
import { IN, inspectClientLine } from "./profile.ts";
import { LoginRefused, launch, log, parseArgs, pumpAgent, validate, type Opts } from "./sandbox.ts";
import { selfCheck } from "./selfcheck.ts";

// Normal mode: CompozyOS <-> wrapper (guard + tap) <-> bwrap(forwarder -> provider ACP agent).
async function run(o: Opts) {
  const v = validate(o);
  let sb: Awaited<ReturnType<typeof launch>>;
  try {
    sb = await launch(o, v, v.adapter.acpCommand(IN.acpPrefix));
  } catch (e) {
    // S10a: the pre-session refresh refused (already in the audit log); the session never starts.
    if (e instanceof LoginRefused) process.exit(1);
    throw e;
  }
  const guard = new AcpGuard(v.adapter.extraAgentMethods);
  let exiting = false;
  const exitAfterClose = (code: number) => {
    if (exiting) return;
    exiting = true;
    sb.stop();
    void sb.closed.then(() => process.exit(code));
  };

  pumpAgent(sb, guard, (line) => process.stdout.write(line + "\n"), () => exitAfterClose(1));

  const agentIn = sb.bwrap.stdin!;
  agentIn.on("error", () => {});
  let chain = Promise.resolve();
  readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
    .on("line", (line) => {
      chain = chain.then(async () => {
        if (exiting) return;
        const verdict = inspectClientLine(line, v.cwd);
        if (verdict.kind === "reject") throw new Error(`refused ACP message: ${verdict.reason}`);
        if (verdict.kind === "allow") for (const port of verdict.ports) await sb.allow(port);
        agentIn.write(guard.clientLine(line) + "\n");
      }).catch((e) => {
        log(`${(e as Error).message}; stopping (fail closed)`);
        exitAfterClose(1);
      });
    })
    .on("close", () => chain.then(() => agentIn.end()));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => exitAfterClose(143));
  void sb.closed.then((code) => {
    if (!exiting) process.exit(code);
  });
}

const opts = parseArgs(process.argv.slice(2));
await (opts.selfCheck ? selfCheck(opts) : run(opts));
