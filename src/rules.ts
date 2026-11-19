// Pure rules (BR-1, BR-3, BR-6, BR-7, BR-8): no I/O and no imports from github.ts or auth.ts. Mutation target.

export type Severity = "blocker" | "major" | "minor" | "nit";
export type Side = "RIGHT" | "LEFT";
export const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor", "nit"];

export interface Finding {
  path: string;
  line: number;
  side?: Side;
  start_line?: number;
  severity: Severity;
  title: string;
  body: string;
}
export interface Commentable {
  path: string;
  side: Side;
  lines: number[];
}
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES";

/** A review by this app; `pass` comes from the body marker (null when absent). */
export interface AppReview {
  id: number;
  state: string;
  commit_id: string;
  pass: 1 | 2 | null;
  /** ISO time GitHub recorded the review. */
  submitted_at: string;
}
export interface ThreadComment {
  author: string;
  is_app: boolean;
  body: string;
  created_at: string;
}
export interface AppThread {
  id: string;
  is_resolved: boolean;
  path: string;
  line: number | null;
  /** Head the thread was opened on. */
  commit_id: string | null;
  comments: ThreadComment[];
}

/** Any review on the PR, in submission order; `is_app` marks this app's reviews. */
export interface SnapshotReview {
  author: string;
  is_app: boolean;
  state: string;
  commit_id: string;
}
export interface PrSnapshot {
  state: "open" | "closed" | "merged";
  base_ref: string;
  head_ref: string;
  head_sha: string;
  author: string;
  /** The PR was opened by this app (`<slug>[bot]`). */
  author_is_app: boolean;
  reviews: SnapshotReview[];
  checks: { status: string; conclusion: string | null }[];
  /** GraphQL `mergeable`: MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
  threads: { is_resolved: boolean }[];
  /** False when reviews or check runs hit the paging cap: the gate fails closed (`history_incomplete`). */
  history_complete: boolean;
}
export interface GateVerdict {
  ready: boolean;
  head_sha: string;
  reasons: string[];
}

/** A repository's promotion branches and approver logins (approved policy). */
export interface PromotionConfig {
  head: string;
  base: string;
  approvers: string[];
}

export const MARKER_PATTERN = /^<!-- github-app-review head=([0-9a-f]{40}) pass=([12]) -->/;

export const marker = (headSha: string, pass: 1 | 2) => `<!-- github-app-review head=${headSha} pass=${pass} -->`;

/** The pass recorded in a review body's first line, or null. */
export function parsePass(body: string | null | undefined): 1 | 2 | null {
  const match = MARKER_PATTERN.exec(body ?? "");
  return match ? (Number(match[2]) as 1 | 2) : null;
}

const BLOCKING = new Set<Severity>(["blocker", "major"]);

/** BR-1: any blocker/major → REQUEST_CHANGES; otherwise APPROVE. Text is never parsed. */
export function deriveEvent(findings: Finding[]): ReviewEvent {
  return findings.some(finding => BLOCKING.has(finding.severity)) ? "REQUEST_CHANGES" : "APPROVE";
}

export type MoveReason = "not_in_diff" | "side_mismatch";

/** BR-6: a finding is inline only when its line (and start_line) is commentable on its side. */
export function partitionAnchors(
  findings: Finding[],
  commentable: Commentable[]
): { inline: Finding[]; moved: { finding: Finding; reason: MoveReason }[] } {
  const inline: Finding[] = [];
  const moved: { finding: Finding; reason: MoveReason }[] = [];
  for (const finding of findings) {
    const side = finding.side ?? "RIGHT";
    const covers = (entry: Commentable) =>
      entry.path === finding.path &&
      entry.lines.includes(finding.line) &&
      (finding.start_line === undefined || entry.lines.includes(finding.start_line));
    if (commentable.some(entry => entry.side === side && covers(entry))) inline.push(finding);
    else if (commentable.some(entry => entry.side !== side && covers(entry))) moved.push({ finding, reason: "side_mismatch" });
    else moved.push({ finding, reason: "not_in_diff" });
  }
  return { inline, moved };
}

/**
 * BR-3: pass 1 when this app has no marked review on the head. Pass 2 (`rereview`) needs, on the head:
 * exactly one pass-1 review (duplicates from the accepted concurrent-post race fail closed), no pass 2,
 * and a non-bot reply on an app thread of the head created after the app's latest review of the head.
 */
export function passFor(input: {
  headSha: string;
  appReviews: AppReview[];
  threads: AppThread[];
  rereview: boolean;
}): { pass: 1 | 2 } | { refused: "already_reviewed_head" | "rereview_not_eligible" } {
  const onHead = input.appReviews.filter(review => review.commit_id === input.headSha && review.pass !== null);
  if (!input.rereview) return onHead.length > 0 ? { refused: "already_reviewed_head" } : { pass: 1 };
  const latest = Math.max(
    ...input.appReviews.filter(r => r.commit_id === input.headSha).map(r => Date.parse(r.submitted_at))
  );
  const contested = input.threads.some(
    thread =>
      thread.commit_id === input.headSha &&
      thread.comments.some(comment => !comment.author.endsWith("[bot]") && Date.parse(comment.created_at) > latest)
  );
  const firstPasses = onHead.filter(review => review.pass === 1).length;
  const eligible = firstPasses === 1 && !onHead.some(review => review.pass === 2) && contested;
  return eligible ? { pass: 2 } : { refused: "rereview_not_eligible" };
}

/** The latest effective (APPROVED/CHANGES_REQUESTED) review of each author. */
function latestByAuthor(reviews: SnapshotReview[]): SnapshotReview[] {
  const latest = new Map<string, SnapshotReview>();
  for (const review of reviews) {
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") latest.set(review.author, review);
  }
  return [...latest.values()];
}

/** GitHub treats `neutral` as passing for required checks (e.g. a bot with no rule to apply). */
const PASSING_CHECK = new Set(["success", "skipped", "neutral"]);

/** Shared tail of both gates (BR-7): open state first, then the gate's own reasons, then CI/merge/threads. */
function verdict(pr: PrSnapshot, own: string[]): GateVerdict {
  const head = pr.head_sha;
  const reasons = pr.state !== "open" ? ["pr_not_open", ...own] : own;
  if (!pr.history_complete) reasons.push("history_incomplete");
  if (latestByAuthor(pr.reviews).some(review => review.state === "CHANGES_REQUESTED" && review.commit_id === head)) {
    reasons.push("changes_requested");
  }
  if (pr.checks.some(check => check.status !== "completed")) reasons.push("checks_pending");
  if (pr.checks.some(check => check.status === "completed" && !PASSING_CHECK.has(check.conclusion ?? ""))) {
    reasons.push("checks_failed");
  }
  if (pr.mergeable !== "MERGEABLE") reasons.push("not_mergeable");
  if (pr.threads.some(thread => !thread.is_resolved)) reasons.push("unresolved_threads");
  return { ready: reasons.length === 0, head_sha: head, reasons };
}

/** BR-7 for the delivery branch (the repository's `delivery_base`): one reason per failed condition, in a stable order. */
export function deliveryGate(pr: PrSnapshot, base: string): GateVerdict {
  const own: string[] = [];
  const head = pr.head_sha;
  if (pr.base_ref !== base) own.push("base_mismatch");
  const app = latestByAuthor(pr.reviews.filter(review => review.is_app)).at(-1);
  if (!(app && app.state === "APPROVED" && app.commit_id === head)) {
    own.push(app?.state === "APPROVED" ? "approval_not_on_head" : "no_app_approval_on_head");
  }
  return verdict(pr, own);
}

/**
 * BR-8: authored by the app; base and head are the configured promotion branches; an approver's latest
 * effective review is APPROVED on the current head; then BR-7's tail.
 */
export function promotionGate(pr: PrSnapshot, cfg: PromotionConfig): GateVerdict {
  const own: string[] = [];
  if (!pr.author_is_app) own.push("not_app_authored");
  if (pr.base_ref !== cfg.base || pr.head_ref !== cfg.head) own.push("base_mismatch");
  const approvers = new Set(cfg.approvers.map(login => login.toLowerCase()));
  const approved = latestByAuthor(pr.reviews).some(
    r => approvers.has(r.author.toLowerCase()) && !r.is_app && r.state === "APPROVED" && r.commit_id === pr.head_sha
  );
  if (!approved) own.push("promotion_not_approved");
  return verdict(pr, own);
}
