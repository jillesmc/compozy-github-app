import type { ExtensionToolHandler, JSONValue } from "@compozy/extension-sdk";

import { causeCode, ReviewError, reviewError, toolError, type ReviewErrorCode } from "./errors.ts";
import { appReviews, runtime, type Runtime, type ToolDeps } from "./tools/common.ts";

const PERMISSIONS = ["pull_requests", "contents", "checks", "statuses"];
const SECRETS_SET = "run compozy extension secrets set github-app-review --env GITHUB_APP_PRIVATE_KEY --value-stdin";

export interface DoctorReport {
  app: { slug: string; id: string } | null;
  installation: { id: string; account: string; selection: string } | null;
  token_mint: { ok: true; expires_in_minutes: number } | { ok: false; code: ReviewErrorCode | "extension_failed"; error: string };
  repos: { repo: string; status: string; permissions?: Record<string, string> }[];
  /** `GITHUB_APP_BASE`, the delivery branch the app reviews and gates. */
  base: string | null;
  promotion: { head: string; base: string; approvers: string[] } | null;
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

/** Probes app identity, installation, one token per allowlisted repo and the rate limit. Never throws. */
export async function runDoctor(deps: ToolDeps): Promise<DoctorReport> {
  const report: DoctorReport = { app: null, installation: null, token_mint: { ok: false, code: "github_unavailable", error: "not attempted" }, repos: [], base: null, promotion: null, rate_limit: null, duplicates: null };
  let rt;
  try {
    rt = runtime(deps);
    const { config } = rt;
    report.base = config.base;
    if (config.promotion) report.promotion = { head: config.promotion.head, base: config.promotion.base, approvers: config.approvers };
    const app = await rt.auth.appGet("/app");
    report.app = { slug: String(app?.slug ?? "unknown"), id: String(app?.id ?? config.appId) };
    const installation = await rt.auth.appGet(`/app/installations/${encodeURIComponent(config.installationId)}`);
    report.installation = { id: config.installationId, account: String(installation?.account?.login ?? "unknown"), selection: String(installation?.repository_selection ?? "unknown") };
  } catch (error) {
    report.token_mint = { ok: false, code: causeCode(error), error: failureText(error) };
    return report;
  }
  for (const repo of rt.config.repos) {
    try {
      const minted = await rt.auth.mint(repo);
      if (report.token_mint.ok === false) report.token_mint = { ok: true, expires_in_minutes: Math.max(0, Math.floor((minted.expiresAt - rt.now()) / 60_000)) };
      report.repos.push({ repo, status: "ok", permissions: Object.fromEntries(PERMISSIONS.filter(p => minted.permissions[p]).map(p => [p, minted.permissions[p]!])) });
    } catch (error) {
      const code = causeCode(error);
      report.repos.push({ repo, status: code === "repo_not_installed" ? "not installed" : `failed (${failureText(error)})` });
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
  lines.push(mint.ok ? `token mint: ok (expires in ${mint.expires_in_minutes}m)` : `token mint: failed (${mint.error})`);
  if (report.repos.length > 0) {
    lines.push("repos:");
    for (const repo of report.repos) {
      const perms = Object.entries(repo.permissions ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ");
      lines.push(`  ${repo.repo}: ${repo.status}${perms ? ` (${perms})` : ""}`);
    }
  }
  const d = report.duplicates;
  if (d && !d.ok) lines.push(`duplicate reviews: ${d.error.startsWith("more than") ? "incomplete" : "unknown"} (${d.error})`);
  else if (d) lines.push(d.lines.length === 0 ? "duplicate reviews: none" : ["duplicate reviews:", ...d.lines.map(line => `  ${line}`)].join("\n"));
  if (report.app) {
    lines.push(`delivery base: ${report.base}`);
    const p = report.promotion;
    lines.push(p ? `promotion: ${p.head} -> ${p.base}, approvers: ${p.approvers.join(", ") || "none"}` : "promotion: not configured");
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
