// Operator commands `policy` and `policy-stage` (BR-15, N2): exempt from approval, no credentials, no
// network call. They work while GITHUB_APP_POLICY_DIGEST is unset so the first approval is possible.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionToolHandler, JSONValue, ToolResult } from "@compozy/extension-sdk";

import type { Env } from "./config.ts";
import { causeCode, ReviewError, reviewError, toolError } from "./errors.ts";
import { decode, loadPolicy, parsePolicy, policyPaths, POLICY_DIGEST_ENV, sha256, type ReadFile, type RepoPolicy } from "./policy.ts";

export interface PolicyDeps {
  env: Env;
  readFile?: ReadFile;
  stderr?: { write(line: string): unknown };
}

type Repos = ReadonlyMap<string, Readonly<RepoPolicy>>;

export interface PolicyStatus {
  working: { path: string; digest: string | null; error: string | null };
  active: { digest: string | null; path: string | null; state: "unset" | "approved" | "unapproved" | "invalid"; error: string | null };
  /** `policies/<working digest>.toml` exists with the working copy's bytes. */
  working_staged: boolean;
  /** The working copy is the active approved version. */
  working_active: boolean;
  /** Working copy against the active version (every working repo is added while none is active). */
  repos: { added: string[]; removed: string[]; changed: string[] };
}

const activateLine = (digest: string) =>
  `printf ${digest} | compozy extension secrets set github-app-review --env ${POLICY_DIGEST_ENV} --value-stdin`;

/** Bytes at `path`, or null when it does not exist; other read failures are `config_invalid`. */
function readOrNull(read: ReadFile, path: string): Buffer | null {
  try {
    return read(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw reviewError("config_invalid", `${path} is unreadable (${code ?? "error"})`);
  }
}

const message = (error: unknown) => (error instanceof ReviewError ? `${error.code}: ${error.message}` : String(error));

/** Read-only status: working-copy digest, active digest, approval state and the repo diff. */
export function policyStatus(deps: PolicyDeps): PolicyStatus {
  const read = deps.readFile ?? readFileSync;
  let paths: ReturnType<typeof policyPaths>;
  try {
    paths = policyPaths(deps.env);
  } catch (error) {
    // G-7: a relative GITHUB_APP_POLICY_FILE is reported, never thrown (policy always exits 0).
    return {
      working: { path: deps.env.GITHUB_APP_POLICY_FILE ?? "", digest: null, error: message(error) },
      active: { digest: deps.env[POLICY_DIGEST_ENV]?.trim() || null, path: null, state: deps.env[POLICY_DIGEST_ENV]?.trim() ? "invalid" : "unset", error: deps.env[POLICY_DIGEST_ENV]?.trim() ? message(error) : null },
      working_staged: false,
      working_active: false,
      repos: { added: [], removed: [], changed: [] },
    };
  }
  const { working: path, versions } = paths;
  const status: PolicyStatus = {
    working: { path, digest: null, error: null },
    active: { digest: null, path: null, state: "unset", error: null },
    working_staged: false,
    working_active: false,
    repos: { added: [], removed: [], changed: [] },
  };
  let working: Repos = new Map();
  try {
    const bytes = readOrNull(read, path);
    if (!bytes) throw reviewError("config_invalid", `${path} does not exist`);
    status.working.digest = sha256(bytes);
    const staged = readOrNull(read, join(versions, `${status.working.digest}.toml`));
    status.working_staged = staged !== null && staged.equals(bytes);
    working = parsePolicy(decode(bytes, path), path);
  } catch (error) {
    status.working.error = message(error);
  }
  let active: Repos = new Map();
  const digest = deps.env[POLICY_DIGEST_ENV]?.trim();
  if (digest) {
    status.active.digest = digest;
    try {
      const policy = loadPolicy(deps.env, read);
      status.active = { digest, path: policy.path, state: "approved", error: null };
      active = policy.repos;
    } catch (error) {
      status.active.state = causeCode(error) === "policy_unapproved" ? "unapproved" : "invalid";
      status.active.error = message(error);
    }
  }
  status.working_active = status.active.state === "approved" && status.working.digest === digest && status.working.error === null;
  for (const [key, entry] of working) {
    const old = active.get(key);
    if (!old) status.repos.added.push(entry.repo);
    else if (JSON.stringify(old) !== JSON.stringify(entry)) status.repos.changed.push(entry.repo);
  }
  for (const [key, entry] of active) if (!working.has(key)) status.repos.removed.push(entry.repo);
  return status;
}

export function formatStatus(s: PolicyStatus): string {
  const w = s.working;
  const a = s.active;
  const lines = [`working   ${w.path}${w.digest ? `  digest ${w.digest}` : ""}${w.error ? `  (${w.error})` : ""}`];
  if (a.state === "unset") lines.push(`active    unset (${POLICY_DIGEST_ENV})`);
  else if (a.state === "approved") lines.push(`active    ${a.digest} (policies/${a.digest}.toml)`);
  else lines.push(`active    ${a.digest} ${a.state} (${a.error})`);
  if (s.working_active) lines.push("state     approved (the working copy is the active version)");
  else if (s.working_staged && w.error === null) lines.push(`state     staged, not active; activate: ${activateLine(w.digest!)}`);
  else if (w.error === null) lines.push("state     not staged; run compozy extension exec github-app-review --cmd policy-stage");
  for (const [mark, repos] of [["+", s.repos.added], ["-", s.repos.removed], ["~", s.repos.changed]] as const) {
    for (const repo of repos) lines.push(`repos     ${mark} ${repo}`);
  }
  return lines.join("\n");
}

export interface StageResult {
  status: "staged" | "unchanged";
  digest: string;
  path: string;
  /** The `secrets set` line, or null when this version is already active. */
  activate: string | null;
}

/** Copies the working copy, schema-checked, to `policies/<sha256>.toml` (read-only); idempotent. */
export function stagePolicy(deps: PolicyDeps): StageResult {
  const read = deps.readFile ?? readFileSync;
  const { working, versions } = policyPaths(deps.env);
  const bytes = readOrNull(read, working);
  if (!bytes) throw reviewError("config_invalid", `${working} does not exist`);
  parsePolicy(decode(bytes, working), working);
  const digest = sha256(bytes);
  const path = join(versions, `${digest}.toml`);
  const existing = readOrNull(read, path);
  if (existing && !existing.equals(bytes)) throw reviewError("config_invalid", `${path} exists with other bytes; the operator removes it`);
  if (!existing) {
    mkdirSync(versions, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, bytes, { flag: "wx", mode: 0o444 });
      renameSync(tmp, path);
    } catch (error) {
      // A stale temp file (EEXIST) or a failed write: remove the temp file, write nothing.
      rmSync(tmp, { force: true });
      throw reviewError("config_invalid", `${path} could not be written (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }
  const activate = deps.env[POLICY_DIGEST_ENV]?.trim() === digest ? null : activateLine(digest);
  return { status: existing ? "unchanged" : "staged", digest, path, activate };
}

export const formatStage = (r: StageResult) =>
  [`${r.status.padEnd(9)} ${r.path}`, r.activate ? `activate  ${r.activate}` : `active    ${r.digest} (already active)`].join("\n");

const textResult = (text: string, structured: unknown): ToolResult => ({
  content: [{ type: "text", text }],
  structured: structured as JSONValue,
  truncated: false,
  bytes: Buffer.byteLength(text),
  duration_ms: 0,
});

/** SDK handler for one operator command; one log line with the outcome code only. */
export function policyHandler(name: "policy" | "policy-stage", deps: PolicyDeps): ExtensionToolHandler {
  return async () => {
    let outcome = "ok";
    try {
      if (name === "policy") {
        const status = policyStatus(deps);
        return textResult(formatStatus(status), status);
      }
      const staged = stagePolicy(deps);
      return textResult(formatStage(staged), staged);
    } catch (error) {
      outcome = causeCode(error);
      throw toolError(error);
    } finally {
      (deps.stderr ?? process.stderr).write(`github-app-review: tool=${name} outcome=${outcome}\n`);
    }
  };
}
