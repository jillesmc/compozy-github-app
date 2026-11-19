import type { ExtensionToolHandler, JSONValue } from "@compozy/extension-sdk";

import { causeCode, ReviewError, reviewError, toolError, type ReviewErrorCode } from "./errors.ts";
import { loadCredentials } from "./config.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { appReviews, runtimeFor, type Runtime, type ToolDeps } from "./tools/common.ts";

const PERMISSIONS = ["pull_requests", "contents", "checks", "statuses"];
const SECRETS_SET = "run compozy extension secrets set github-app-review --env GITHUB_APP_PRIVATE_KEY --value-stdin";

export interface DoctorReport {
  app: { slug: string; id: string } | null;
  installation: { id: string; account: string; selection: string } | null;
  token_mint: { ok: true; expires_in_minutes: number } | { ok: false; code: ReviewErrorCode | "extension_failed"; error: string };
  /** The approved policy version (BR-15), or why it is not honored. */
  policy: { state: "approved"; digest: string; path: string } | { state: "unapproved" | "invalid"; error: string } | null;
  /** One entry per policy repository: its token mint status and its branches. */
  repos: { repo: string; status: string; permissions?: Record<string, string>; delivery_base: string; promotion: { head: string; base: string; approvers: string[] } | null }[];
  rate_limit: { remaining: number; limit: number; reset: string } | null;
  /** One line per PR head with more than one app review of the same pass (US-010.EC-1); null when not checked. */
  duplicates: { ok: true; lines: string[] } | { ok: false; error: string } | null;
}

/** Open PRs scanned per repository (two pages of 100); more → the scan reports `incomplete`. */
export const MAX_OPEN_PRS = 200;
/** Scan time budget, well under the 25 s tool budget, so a slow scan never fails the doctor. */
export const DOCTOR_SCAN_MS = 10_000;

class ScanIncomplete extends Error {}

/** Duplicate app reviews (same head, same pass marker) on the open PRs of one repository. */
async function duplicateReviews(rt: Runtime, repo: string, slug: string): Promise<string[]> {
  const gh = rt.github(repo);
  const lines: string[] = [];
  const open = await gh.paginate(`/repos/${repo}/pulls?state=open`, MAX_OPEN_PRS + 1);
  if (open.length > MAX_OPEN_PRS) throw new ScanIncomplete();
  for (const pr of open) {
    const reviews = await gh.all(`/repos/${repo}/pulls/${pr.number}/reviews`);
    if (!reviews.complete) lines.push(`${repo}#${pr.number}: review history too large to check`);
    const counts = new Map<string, number>();
    for (const review of appReviews(reviews.items, slug).filter(r => r.pass !== null)) {
      const key = `head ${review.commit_id.slice(0, 12)} pass=${review.pass}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) if (count > 1) lines.push(`${repo}#${pr.number} ${key}: ${count} reviews`);
  }
  return lines;
}

/** `401` for a rejected key, the cause code and text otherwise (`_dx.md` › CLI). */
const failureText = (error: unknown) =>
  error instanceof ReviewError && error.code === "credential_absent"
    ? `credential_absent: ${SECRETS_SET}`
    : error instanceof ReviewError && error.httpStatus === 401
      ? "401"
      : `${causeCode(error)}${error instanceof ReviewError ? `: ${error.message}` : ""}`;

/** The approved policy, or the refusal every tool would give (reported, then the doctor fails). */
function policyOrError(deps: ToolDeps): Policy | ReviewError {
  try {
    return loadPolicy(deps.env, deps.readFile);
  } catch (error) {
    if (error instanceof ReviewError) return error;
    throw error;
  }
}

const NO_POLICY: Policy = { digest: "", path: "", repos: new Map() };

/** Probes app identity, installation, the approved policy, one token per policy repo and the rate limit. Never throws. */
export async function runDoctor(deps: ToolDeps): Promise<DoctorReport> {
  const report: DoctorReport = { app: null, installation: null, token_mint: { ok: false, code: "github_unavailable", error: "not attempted" }, policy: null, repos: [], rate_limit: null, duplicates: null };
  let rt: Runtime;
  try {
    const credentials = loadCredentials(deps.env);
    const policy = policyOrError(deps);
    report.policy =
      policy instanceof ReviewError
        ? { state: policy.code === "policy_unapproved" ? "unapproved" : "invalid", error: `${policy.code}: ${policy.message}` }
        : { state: "approved", digest: policy.digest, path: policy.path };
    rt = runtimeFor(deps, { ...credentials, policy: policy instanceof ReviewError ? NO_POLICY : policy });
    const app = await rt.auth.appGet("/app");
    report.app = { slug: String(app?.slug ?? "unknown"), id: String(app?.id ?? credentials.appId) };
    const installation = await rt.auth.appGet(`/app/installations/${encodeURIComponent(credentials.installationId)}`);
    report.installation = { id: credentials.installationId, account: String(installation?.account?.login ?? "unknown"), selection: String(installation?.repository_selection ?? "unknown") };
    if (policy instanceof ReviewError) {
      // G-6: no repository token is minted without an approved policy.
      report.token_mint = { ok: false, code: policy.code, error: `not attempted (policy ${report.policy.state})` };
      return report;
    }
  } catch (error) {
    report.token_mint = { ok: false, code: causeCode(error), error: failureText(error) };
    return report;
  }
  for (const entry of rt.config.policy.repos.values()) {
    const repo = entry.repo;
    const branches = { delivery_base: entry.delivery_base, promotion: entry.promotion && { ...entry.promotion, approvers: [...entry.approvers] } };
    try {
      const minted = await rt.auth.mint(repo);
      if (report.token_mint.ok === false) report.token_mint = { ok: true, expires_in_minutes: Math.max(0, Math.floor((minted.expiresAt - rt.now()) / 60_000)) };
      report.repos.push({ repo, status: "ok", permissions: Object.fromEntries(PERMISSIONS.filter(p => minted.permissions[p]).map(p => [p, minted.permissions[p]!])), ...branches });
    } catch (error) {
      const code = causeCode(error);
      report.repos.push({ repo, status: code === "repo_not_installed" ? "not installed" : `failed (${failureText(error)})`, ...branches });
      if (report.token_mint.ok === false) report.token_mint = { ok: false, code, error: failureText(error) };
    }
  }
  const installed = report.repos.filter(entry => entry.status === "ok").map(entry => entry.repo);
  if (installed.length > 0) {
    // Open PRs only (operator decision); bounded in count and time so it degrades instead of failing.
    const scan = (async () => {
      const lines: string[] = [];
      for (const repo of installed) lines.push(...(await duplicateReviews(rt, repo, report.app!.slug)));
      return lines;
    })();
    scan.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">(resolve => (timer = setTimeout(() => resolve("timeout"), deps.doctorScanMs ?? DOCTOR_SCAN_MS)));
    try {
      const lines = await Promise.race([scan, timeout]);
      report.duplicates = lines === "timeout" ? { ok: false, error: "scan timed out" } : { ok: true, lines };
    } catch (error) {
      report.duplicates = { ok: false, error: error instanceof ScanIncomplete ? `more than ${MAX_OPEN_PRS} open PRs` : failureText(error) };
    } finally {
      clearTimeout(timer);
    }
    try {
      // Through the GitHub client: no installation token is handled outside auth.ts/github.ts.
      const body = await rt.github(installed[0]!).rest("GET", "/rate_limit");
      const core = body?.resources?.core ?? body?.rate;
      if (core) report.rate_limit = { remaining: core.remaining, limit: core.limit, reset: new Date(core.reset * 1000).toISOString() };
    } catch {
      // rate limit stays unknown
    }
  }
  return report;
}

/** Operator report, the `_dx.md` Golden Path lines. */
export function formatReport(report: DoctorReport): string {
  const lines = [report.app ? `app: ${report.app.slug} (id ${report.app.id})` : "app: unknown"];
  if (report.installation) lines.push(`installation: ${report.installation.id} on ${report.installation.account} (${report.installation.selection.replaceAll("_", " ")} repositories)`);
  const mint = report.token_mint;
  lines.push(mint.ok ? `token mint: ok (expires in ${mint.expires_in_minutes}m)` : mint.error.startsWith("not attempted") ? `token mint: ${mint.error}` : `token mint: failed (${mint.error})`);
  const policy = report.policy;
  if (policy) lines.push(policy.state === "approved" ? `policy: approved ${policy.digest} (${policy.path})` : `policy: ${policy.state} (${policy.error})`);
  if (report.repos.length > 0) {
    lines.push("repos:");
    for (const repo of report.repos) {
      const perms = Object.entries(repo.permissions ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ");
      const p = repo.promotion;
      lines.push(`  ${repo.repo}: ${repo.status}${perms ? ` (${perms})` : ""}`);
      lines.push(`    delivery base: ${repo.delivery_base}; promotion: ${p ? `${p.head} -> ${p.base}, approvers: ${p.approvers.join(", ")}` : "not configured"}`);
    }
  }
  const d = report.duplicates;
  if (d && !d.ok) lines.push(`duplicate reviews: ${d.error.startsWith("more than") ? "incomplete" : "unknown"} (${d.error})`);
  else if (d) lines.push(d.lines.length === 0 ? "duplicate reviews: none" : ["duplicate reviews:", ...d.lines.map(line => `  ${line}`)].join("\n"));
  if (report.app) {
    const r = report.rate_limit;
    lines.push(r ? `rate limit: ${r.remaining}/${r.limit} (resets ${r.reset.slice(11, 16)}Z)` : "rate limit: unknown");
  }
  return lines.join("\n");
}

/** Doctor handler: the report as text and JSON; a failed token mint is a tool error (CLI exit 1). */
export function doctorHandler(deps: ToolDeps): ExtensionToolHandler {
  return async () => {
    const report = await runDoctor(deps);
    const text = formatReport(report);
    (deps.stderr ?? process.stderr).write(`github-app-review: tool=doctor outcome=${report.token_mint.ok ? "ok" : "failed"}\n`);
    if (!report.token_mint.ok) {
      const code = report.token_mint.code;
      throw toolError(reviewError(code === "extension_failed" ? "github_unavailable" : code, text.replaceAll("\n", "; ")));
    }
    return { content: [{ type: "text", text }], structured: report as unknown as JSONValue, truncated: false, bytes: Buffer.byteLength(text), duration_ms: 0 };
  };
}
