// reviewer-sandbox command-line options and the wrapper's stderr log.
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();

export function log(msg: string) {
  process.stderr.write(`reviewer-sandbox: ${msg}\n`);
}

export function fatal(msg: string): never {
  log(msg);
  process.exit(1);
}

export type Opts = {
  provider: string;
  loginDir: string;
  acpPrefix?: string; // default ${XDG_DATA_HOME:-~/.local/share}/reviewer-sandbox/<provider>
  cwd: string;
  worktreeRoots: string[];
  gatewayLog: string;
  daemonPort: number;
  sessionBudgetMin: number; // a pre-session refresh keeps the login valid this long ...
  refreshMarginMin: number; // ... plus this margin
  selfCheck: boolean;
};

function minutes(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 24 * 60) fatal(`${flag} must be a whole number of minutes (0..1440)`);
  return n;
}

export function parseArgs(argv: string[]): Opts {
  const o: Partial<Opts> = {};
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? fatal(`${a} needs a value`);
    if (a === "--provider") o.provider = val();
    else if (a === "--login-dir") o.loginDir = val();
    else if (a === "--acp-prefix") o.acpPrefix = val();
    else if (a === "--cwd") o.cwd = val();
    else if (a === "--worktree-root") roots.push(val());
    else if (a === "--gateway-log") o.gatewayLog = val();
    else if (a === "--daemon-port") o.daemonPort = Number(val());
    else if (a === "--session-budget-min") o.sessionBudgetMin = minutes(a, val());
    else if (a === "--refresh-margin-min") o.refreshMarginMin = minutes(a, val());
    else if (a === "--self-check") o.selfCheck = true;
    else fatal(`unknown argument ${a}`);
  }
  const state = process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state");
  return {
    provider: o.provider ?? fatal("--provider is required (claude|codex|cursor)"),
    loginDir: o.loginDir ?? fatal("--login-dir is required"),
    acpPrefix: o.acpPrefix ?? process.env.REVIEWER_ACP_PREFIX,
    cwd: o.cwd ?? process.cwd(),
    worktreeRoots: roots,
    gatewayLog: o.gatewayLog ?? path.join(state, "reviewer-sandbox", "gateway.log"),
    daemonPort: o.daemonPort ?? 2123,
    sessionBudgetMin: o.sessionBudgetMin ?? 30,
    refreshMarginMin: o.refreshMarginMin ?? 10,
    selfCheck: o.selfCheck ?? false,
  };
}

export function defaultAcpPrefix(provider: string): string {
  const data = process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share");
  return path.join(data, "reviewer-sandbox", provider);
}
