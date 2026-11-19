import type { JSONValue } from "@compozy/extension-sdk";

import { allowedRepo } from "../config.ts";
import { ReviewError, reviewError } from "../errors.ts";
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

/** Today's default (`key_pattern` absent): Jira-shaped keys. */
export const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
/** `key` matches all of `text`, not a part of it. */
const whole = (key: RegExp, text: string) => key.exec(text)?.[0] === text;

/** Only short, plain candidates can be keys (ACME-123, ABCDEFGHIJ-1234567, #205); others never run `key`. */
const CANDIDATE = /^[A-Za-z0-9#_.-]{1,20}$/;
/** G-1: per-call budget for an agent-supplied pattern; past it the title is the plain one. */
export const MAX_KEY_CANDIDATES = 500;
export const KEY_BUDGET_MS = 250;
const MAX_SUBJECT = 1000;

export interface KeyMatcher {
  test(text: string): boolean;
  /** The budget ran out: the caller produces no keys (plain title). */
  exhausted: boolean;
}

/**
 * G-1: matches whole keys without letting an agent pattern stall the extension. A candidate runs `key`
 * at most once (results cached), only if it passes CANDIDATE, and at most MAX_KEY_CANDIDATES times or
 * KEY_BUDGET_MS of regex time per call. One run backtracks over ≤ 20 characters (tens of ms even for `^(a+)+$`), so a
 * call stays near the budget. The built-in Jira default is linear and has no budget.
 */
export function keyMatcher(key: RegExp, now: () => number = () => performance.now()): KeyMatcher {
  const seen = new Map<string, boolean>();
  const unbounded = key === JIRA_KEY;
  let spent = 0;
  let runs = 0;
  const matcher: KeyMatcher = {
    exhausted: false,
    test(text) {
      if (matcher.exhausted || !CANDIDATE.test(text)) return false;
      const known = seen.get(text);
      if (known !== undefined) return known;
      if (!unbounded && (runs >= MAX_KEY_CANDIDATES || spent > KEY_BUDGET_MS)) {
        matcher.exhausted = true;
        return false;
      }
      runs++;
      // G-8: only time inside the regex counts (never the awaited PR reads between candidates).
      const started = now();
      const result = whole(key, text);
      spent += now() - started;
      seen.set(text, result);
      return result;
    },
  };
  return matcher;
}
export const MAX_KEY_PATTERN = 200;

/**
 * Keys of the included PRs, unique, in commit order: the squash subject prefix (`KEY: …`, title prefix
 * `{key}: `) or the branch of a merge commit (`Merge pull request #1 from org/KEY-slug`, branch prefix
 * `{key}-`), whichever prefix `key` matches whole. The PR number is never a key.
 */
export function includedKeys(commits: any[], key: RegExp = JIRA_KEY, match: KeyMatcher = keyMatcher(key)): string[] {
  const keys = new Set<string>();
  for (const commit of commits) {
    const subject = String(commit?.commit?.message ?? "").split("\n")[0]!.slice(0, MAX_SUBJECT);
    const branch = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject)?.[1];
    const candidates = branch
      ? branch.split("-").map((_, i, parts) => parts.slice(0, i + 1).join("-"))
      : subject.includes(":") ? [subject.slice(0, subject.indexOf(":"))] : [];
    const found = candidates.find(candidate => match.test(candidate));
    if (found) keys.add(found);
    if (match.exhausted) return [];
  }
  return [...keys];
}

/** `Closes|Fixes|Resolves #N` (and the other GitHub closing keywords) in a PR body; same-repo issues only. */
const CLOSES = /(?<![\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi;

export const closedIssues = (body: unknown): string[] => [...String(body ?? "").matchAll(CLOSES)].map(match => `#${match[1]}`);

/** `key_pattern` as a regular expression, or `invalid_input`. */
export function keyPattern(value: unknown): RegExp | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEY_PATTERN) {
    throw reviewError("invalid_input", `key_pattern must be a regular expression of 1-${MAX_KEY_PATTERN} characters`);
  }
  try {
    return new RegExp(value);
  } catch {
    throw reviewError("invalid_input", "key_pattern is not a valid regular expression");
  }
}

/** A pattern for GitHub issue keys (`#<n>`): the keys are the issues the included PRs close. */
export const isIssueKey = (key: RegExp) => whole(key, "#1") && whole(key, "#205");

/** Issues closed by the included PRs (one `GET pulls/{n}` each), unique, in PR order; a missing PR adds none. */
async function closedByIncluded(gh: GitHub, path: string, prs: number[], key: RegExp): Promise<string[]> {
  const keys = new Set<string>();
  const match = keyMatcher(key);
  // ponytail: sequential reads, one per included PR; batch them if promotions grow past a few dozen PRs.
  for (const number of prs) {
    let pr: any;
    try {
      pr = await gh.rest("GET", `${path}/pulls/${number}`);
    } catch (error) {
      if (error instanceof ReviewError && error.httpStatus === 404) continue;
      throw error;
    }
    for (const issue of closedIssues(pr?.body)) if (match.test(issue)) keys.add(issue);
    if (match.exhausted) return [];
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
    "Open or update the app's promotion pull request (the repository's promotion head → base in the approved " +
    "policy, e.g. staging → main) listing the included PRs, titled with their work-item keys: Jira-shaped keys from " +
    "the commit subjects by default, or keys matching key_pattern (the work adapter's key format); a #<n> pattern " +
    "lists the issues the included PRs close. Nothing to promote → created:false, number:null. Refuses when an " +
    "open promotion PR by another author exists. The app never approves or merges it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["repo"],
    properties: {
      repo: REPO_SCHEMA,
      key_pattern: { type: "string", minLength: 1, maxLength: MAX_KEY_PATTERN, description: "regular expression of one work-item key, e.g. ^#\\d+$ for GitHub issues" },
    },
  },
  readOnly: false,
  async handle(input, rt, log) {
    onlyKeys(input, ["repo", "key_pattern"]);
    const repo = allowedRepo(input.repo, rt.config);
    const { head, base } = promotionTarget(repo.policy);
    const key = keyPattern(input.key_pattern) ?? JIRA_KEY;
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
    const keys = isIssueKey(key) ? await closedByIncluded(gh, path, included, key) : includedKeys(commits, key);
    const title = promotionTitle(head, base, keys);
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
