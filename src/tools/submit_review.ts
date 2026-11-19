import { reviewError } from "../errors.ts";
import { deriveEvent, marker, partitionAnchors, passFor, SEVERITIES, type Finding, type MoveReason } from "../rules.ts";
import { appReviews, jsonResult, NUMBER_SCHEMA, onlyKeys, prState, REPO_SCHEMA, target, type ToolDefinition } from "./common.ts";
import { appThreads, prFiles } from "./pr_context.ts";

/** BR-10 limits. */
export const MAX_FINDINGS = 50;
export const MAX_BODY = 4000;
export const MAX_SUMMARY = 8000;
const MAX_TITLE = 200;
/** Assembled review body limit: GitHub caps it at 65 536 characters; this keeps a margin (BR-10). */
export const MAX_REVIEW_BODY = 60_000;

const REFUSED = {
  already_reviewed_head: (head: string) => `this app already reviewed head ${head}`,
  rereview_not_eligible: (head: string) => `head ${head} needs pass 1, no pass 2, and a non-bot reply on a bot thread opened on it`,
};

const SHA = /^[0-9a-f]{40}$/;
const FINDING_KEYS = ["path", "line", "side", "start_line", "severity", "title", "body"];

function text(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== "string" || (required && !value.trim())) throw reviewError("invalid_input", `${field} must be a non-empty string`);
  if (value.length > max) throw reviewError("field_too_long", `${field} has ${value.length} characters (max ${max})`);
  return value;
}

const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** Validates every field before any HTTP call (UT-005, UT-026). */
export function parseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) throw reviewError("invalid_input", "findings must be an array");
  if (value.length > MAX_FINDINGS) throw reviewError("too_many_findings", `${value.length} findings (max ${MAX_FINDINGS})`);
  return value.map((raw, index) => {
    const at = `findings[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw reviewError("invalid_input", `${at} must be an object`);
    const entry = raw as Record<string, unknown>;
    const extra = Object.keys(entry).find(key => !FINDING_KEYS.includes(key));
    if (extra) throw reviewError("invalid_input", `${at}.${extra}: unknown field`);
    if (!SEVERITIES.includes(entry.severity as never)) throw reviewError("invalid_input", `${at}.severity must be one of ${SEVERITIES.join(", ")}`);
    if (!positive(entry.line)) throw reviewError("invalid_input", `${at}.line must be a positive integer`);
    if (entry.side !== undefined && entry.side !== "RIGHT" && entry.side !== "LEFT") throw reviewError("invalid_input", `${at}.side must be RIGHT or LEFT`);
    if (entry.start_line !== undefined && !(positive(entry.start_line) && (entry.start_line as number) < (entry.line as number))) {
      throw reviewError("invalid_input", `${at}.start_line must be a positive integer below line`);
    }
    return {
      path: text(entry.path, `${at}.path`, 1000),
      line: entry.line as number,
      ...(entry.side ? { side: entry.side as Finding["side"] } : {}),
      ...(entry.start_line !== undefined ? { start_line: entry.start_line as number } : {}),
      severity: entry.severity as Finding["severity"],
      title: text(entry.title, `${at}.title`, MAX_TITLE),
      body: text(entry.body, `${at}.body`, MAX_BODY),
    };
  });
}

/**
 * Marker line, summary, then every finding that could not be anchored, with its full text (BR-6).
 * Over GitHub's aggregate limit the review is refused, never shortened (BR-10).
 */
export function reviewBody(headSha: string, pass: 1 | 2, summary: string, moved: { finding: Finding; reason: MoveReason }[]): string {
  const head = `${marker(headSha, pass)}\n\n${summary}`;
  const entry = ({ finding: f }: { finding: Finding }) =>
    `- **${f.severity}** \`${f.path}:${f.line}\` — ${f.title}\n\n  ${f.body.replaceAll("\n", "\n  ")}`;
  const body = moved.length === 0 ? head : `${head}\n\n### Outside the diff\n\n${moved.map(entry).join("\n\n")}`;
  if (body.length > MAX_REVIEW_BODY) {
    throw reviewError("field_too_long", `review body (summary plus findings outside the diff) has ${body.length} characters (max ${MAX_REVIEW_BODY})`, undefined, "split or shorten findings");
  }
  return body;
}

/** Open, non-draft, into the repository's `delivery_base`, and still on `headSha`; otherwise the matching refusal. */
function assertReviewable(pr: any, number: number, headSha: string, base: string): void {
  const state = prState(pr);
  if (state !== "open" || pr.draft) throw reviewError("pr_not_reviewable", `pull request #${number} is ${pr.draft && state === "open" ? "a draft" : state}`);
  if (pr.base?.ref !== base) {
    throw reviewError("base_not_reviewable", `pull request #${number} targets ${pr.base?.ref}, not delivery_base (${base})`);
  }
  if (pr.head?.sha !== headSha) throw reviewError("head_moved", `head_sha ${headSha} is not the current head; current head is ${pr.head?.sha}`);
}

export const submitReviewTool: ToolDefinition = {
  name: "submit_review",
  description:
    "Post this app's review of a pull request head. The event is derived from the findings' severities " +
    "(blocker/major → REQUEST_CHANGES, else APPROVE); findings outside the diff move to the summary. " +
    "Reviews only pull requests into the repository's delivery_base (approved policy). Refuses a head that is not current, a second review " +
    "of the same head, drafts, and closed PRs. " +
    "`rereview: true` posts one pass 2 on a head whose bot thread got a non-bot reply after pass 1.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "number", "head_sha", "summary", "findings"],
    properties: {
      repo: REPO_SCHEMA,
      number: NUMBER_SCHEMA,
      head_sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
      summary: { type: "string", maxLength: MAX_SUMMARY },
      findings: {
        type: "array",
        maxItems: MAX_FINDINGS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "line", "severity", "title", "body"],
          properties: {
            path: { type: "string" },
            line: { type: "integer", minimum: 1 },
            side: { enum: ["RIGHT", "LEFT"] },
            start_line: { type: "integer", minimum: 1 },
            severity: { enum: [...SEVERITIES] },
            title: { type: "string", maxLength: MAX_TITLE },
            body: { type: "string", maxLength: MAX_BODY },
          },
        },
      },
      rereview: { type: "boolean", description: "contested re-review of the same head (pass 2), once per head" },
    },
  },
  readOnly: false,
  async handle(input, rt, log) {
    onlyKeys(input, ["repo", "number", "head_sha", "summary", "findings", "rereview"]);
    const { repo, number, gh, base } = target(input, rt, log);
    const headSha = input.head_sha;
    if (typeof headSha !== "string" || !SHA.test(headSha)) throw reviewError("invalid_input", "head_sha must be a 40-character lowercase hex SHA");
    log.head_sha = headSha.slice(0, 12);
    const summary = text(input.summary, "summary", MAX_SUMMARY, false);
    const findings = parseFindings(input.findings);
    if (input.rereview !== undefined && typeof input.rereview !== "boolean") throw reviewError("invalid_input", "rereview must be a boolean");
    const rereview = input.rereview === true;

    const pr = await gh.rest("GET", `${base}/pulls/${number}`);
    assertReviewable(pr, number, headSha, repo.policy.delivery_base);

    const { commentable } = await prFiles(gh, base, number, pr.changed_files);
    const { inline, moved } = partitionAnchors(findings, commentable);
    const event = deriveEvent(findings);
    // Re-read reviews (and threads for pass 2) just before posting (US-010.EC-1): a concurrent pass refuses this one.
    const [slug, reviews, threads] = await Promise.all([
      rt.slug(),
      gh.all(`${base}/pulls/${number}/reviews`),
      rereview ? gh.threads(number) : undefined,
    ]);
    if (!reviews.complete) throw reviewError("github_unavailable", `review history of #${number} is too large to read completely; refusing to decide the pass`);
    if (threads && !threads.complete) throw reviewError("github_unavailable", `review threads of #${number} are too large to read completely; refusing to decide the pass`);
    const decision = passFor({ headSha, appReviews: appReviews(reviews.items, slug), threads: threads ? appThreads(threads.threads, slug) : [], rereview });
    if ("refused" in decision) throw reviewError(decision.refused, REFUSED[decision.refused](headSha));
    Object.assign(log, { pass: decision.pass, event, inline: inline.length, moved: moved.length });
    const body = reviewBody(headSha, decision.pass, summary, moved);
    // Re-validate the PR right before writing: head, base, draft or state may have changed during the reads.
    // ponytail: GitHub has no compare-and-swap for reviews; a change between this GET and the POST stays possible.
    assertReviewable(await gh.rest("GET", `${base}/pulls/${number}`), number, headSha, repo.policy.delivery_base);

    const review = await gh.rest("POST", `${base}/pulls/${number}/reviews`, {
      commit_id: headSha,
      event,
      body,
      comments: inline.map(f => ({
        path: f.path,
        line: f.line,
        side: f.side ?? "RIGHT",
        ...(f.start_line !== undefined ? { start_line: f.start_line, start_side: f.side ?? "RIGHT" } : {}),
        body: `${f.severity}: ${f.title}\n\n${f.body}`,
      })),
    });
    return jsonResult({
      review_id: review.id,
      event,
      pass: decision.pass,
      inline: inline.length,
      moved_to_summary: moved.map(item => ({ path: item.finding.path, line: item.finding.line, reason: item.reason })),
      url: review.html_url ?? `https://github.com/${input.repo}/pull/${number}#pullrequestreview-${review.id}`,
    });
  },
};
