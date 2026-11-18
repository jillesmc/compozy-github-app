import type { JSONValue } from "@compozy/extension-sdk";

import { allowedRepo } from "../config.ts";
import { reviewError } from "../errors.ts";
import type { GitHub } from "../github.ts";
import { jsonResult, onlyKeys, promotionTarget, REPO_SCHEMA, type ToolDefinition } from "./common.ts";

/** `Merge pull request #231 from …` (merge commit) or `title (#231)` (squash), on the first line. */
const PR_REF = /^Merge pull request #(\d+)\b|\(#(\d+)\)\s*$/;

/** PR numbers merged into the head branch, ascending and unique, from the compared commits' subjects. */
export function includedPrs(commits: any[]): number[] {
  const numbers = new Set<number>();
  for (const commit of commits) {
    const match = PR_REF.exec(String(commit?.commit?.message ?? "").split("\n")[0]!);
    if (match) numbers.add(Number(match[1] ?? match[2]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Jira key of an included PR: its branch (`Merge pull request #1 from org/KEY-1-slug`) or squash subject (`KEY-1: …`). */
const JIRA_KEY = /^Merge pull request #\d+ from [^/\s]+\/([A-Z][A-Z0-9]+-\d+)(?![\d])|^([A-Z][A-Z0-9]+-\d+):/;

/** Jira keys of the included PRs, unique, in commit order. */
export function includedJiraKeys(commits: any[]): string[] {
  const keys = new Set<string>();
  for (const commit of commits) {
    const match = JIRA_KEY.exec(String(commit?.commit?.message ?? "").split("\n")[0]!);
    if (match) keys.add(match[1] ?? match[2]!);
  }
  return [...keys];
}

/** GitHub caps titles at 256 characters; keys that do not fit become `+N`. */
const MAX_TITLE = 256;

/** `KEY-1, KEY-2: Promote head to base`, or the plain title when no key was found. */
export function promotionTitle(head: string, base: string, keys: string[]): string {
  const plain = `Promote ${head} to ${base}`;
  for (let shown = keys.length; shown > 0; shown--) {
    const rest = keys.length - shown;
    const title = `${keys.slice(0, shown).join(", ")}${rest > 0 ? ` +${rest}` : ""}: ${plain}`;
    if (title.length <= MAX_TITLE) return title;
  }
  return plain;
}

/** Safety cap for the comparison: 50 pages of 100 commits. */
export const MAX_COMPARE_PAGES = 50;

/** Every commit of `base...head`, paged until `total_commits` are read; refuses rather than truncate (cap or short answer). */
async function comparedCommits(gh: GitHub, path: string): Promise<any[]> {
  const commits: any[] = [];
  for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
    const answer = await gh.rest("GET", `${path}?per_page=100&page=${page}`);
    const total = Number(answer?.total_commits) || 0;
    const batch: any[] = answer?.commits ?? [];
    commits.push(...batch);
    if (commits.length >= total) return commits;
    if (batch.length === 0) break;
  }
  throw reviewError("github_unavailable", "comparison too large to list every included PR; nothing written");
}

const promotionBody = (head: string, base: string, prs: number[]) =>
  `Promotes \`${head}\` to \`${base}\`. Opened by the app; the operator approves it on GitHub.\n\n` +
  `Included PRs:\n\n${prs.length > 0 ? prs.map(n => `- #${n}`).join("\n") : "- (none found in the commit subjects)"}\n`;

export const upsertPromotionTool: ToolDefinition = {
  name: "upsert_promotion",
  description:
    "Open or update the app's promotion pull request (GITHUB_APP_PROMOTION head → base, e.g. staging → " +
    "main) listing the included PRs, titled with their Jira keys. Nothing to promote → created:false, number:null. Refuses when an " +
    "open promotion PR by another author exists. The app never approves or merges it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["repo"],
    properties: { repo: REPO_SCHEMA },
  },
  readOnly: false,
  async handle(input, rt, log) {
    onlyKeys(input, ["repo"]);
    const repo = allowedRepo(input.repo, rt.config);
    const { head, base } = promotionTarget(rt, repo.full);
    log.repo = repo.full;
    const gh = rt.github(repo.full);
    const path = `/repos/${repo.owner}/${repo.name}`;
    const commits = await comparedCommits(gh, `${path}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    if (commits.length === 0) {
      return jsonResult({ created: false, number: null, url: null, head_sha: null, included_prs: [] });
    }
    const included = includedPrs(commits);
    const query = `state=open&head=${encodeURIComponent(`${repo.owner}:${head}`)}&base=${encodeURIComponent(base)}`;
    const [slug, open] = await Promise.all([rt.slug(), gh.paginate(`${path}/pulls?${query}`, 100)]);
    const other = open.find(pr => pr?.user?.login !== `${slug}[bot]`);
    if (other) {
      throw reviewError("promotion_conflict", `open promotion PR #${other.number} by ${other.user?.login ?? "ghost"} (${head} → ${base}) already exists`);
    }
    const body = promotionBody(head, base, included);
    const title = promotionTitle(head, base, includedJiraKeys(commits));
    const existing = open[0];
    const pr = existing
      ? await gh.rest("PATCH", `${path}/pulls/${existing.number}`, { title, body })
      : await gh.rest("POST", `${path}/pulls`, { title, head, base, body });
    log.pr = pr.number;
    log.head_sha = String(pr.head?.sha ?? "").slice(0, 12);
    const result = { created: !existing, number: pr.number, url: pr.html_url, head_sha: pr.head?.sha ?? null, included_prs: included };
    return jsonResult(result as unknown as JSONValue);
  },
};
