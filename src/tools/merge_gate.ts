import type { JSONValue } from "@compozy/extension-sdk";

import { reviewError } from "../errors.ts";
import { deliveryGate, promotionGate, type PrSnapshot } from "../rules.ts";
import { jsonResult, promotionTarget, NUMBER_SCHEMA, onlyKeys, prState, REPO_SCHEMA, target, type Runtime, type ToolDefinition } from "./common.ts";

/** Reads everything BR-7/BR-8 need into one snapshot (PR, reviews, check runs, mergeability, threads). */
export async function snapshot(rt: Runtime, t: ReturnType<typeof target>): Promise<PrSnapshot> {
  const { gh, base, number } = t;
  const pr = await gh.rest("GET", `${base}/pulls/${number}`);
  const head = String(pr.head?.sha ?? "");
  const [slug, reviews, checks, graph] = await Promise.all([
    rt.slug(),
    gh.all(`${base}/pulls/${number}/reviews`),
    gh.all(`${base}/commits/${head}/check-runs`, "check_runs"),
    gh.threads(number),
  ]);
  return {
    state: prState(pr),
    base_ref: pr.base?.ref,
    head_ref: pr.head?.ref,
    head_sha: head,
    author: pr.user?.login,
    author_is_app: pr.user?.login === `${slug}[bot]`,
    reviews: reviews.items.map(review => ({
      author: review.user?.login ?? "ghost",
      is_app: review.user?.login === `${slug}[bot]`,
      state: review.state,
      commit_id: review.commit_id,
    })),
    checks: checks.items.map(check => ({ status: check.status, conclusion: check.conclusion ?? null })),
    mergeable: graph.mergeable,
    threads: graph.threads.map(thread => ({ is_resolved: thread.is_resolved })),
    // Never decide on a prefix: a capped review, check or thread list makes the gate not ready.
    history_complete: reviews.complete && checks.complete && graph.complete,
  };
}

export const mergeGateTool: ToolDefinition = {
  name: "merge_gate",
  description:
    "Deterministic merge readiness of a pull request. kind=delivery: the PR targets GITHUB_APP_BASE, the app " +
    "approved the current head, no " +
    "changes requested on it, checks green, mergeable, no unresolved threads. kind=promotion: the app opened the " +
    "configured promotion PR and a configured approver approved its current head, plus the same check, " +
    "mergeability and thread rules. Returns {ready, head_sha, reasons}.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "number", "kind"],
    properties: { repo: REPO_SCHEMA, number: NUMBER_SCHEMA, kind: { enum: ["delivery", "promotion"] } },
  },
  readOnly: true,
  async handle(input, rt, log) {
    onlyKeys(input, ["repo", "number", "kind"]);
    const t = target(input, rt, log);
    if (input.kind !== "delivery" && input.kind !== "promotion") throw reviewError("invalid_input", "kind must be delivery or promotion");
    const promotion = input.kind === "promotion" ? promotionTarget(rt, t.repo.full) : null;
    const pr = await snapshot(rt, t);
    const verdict = promotion ? promotionGate(pr, { ...promotion, approvers: rt.config.approvers }) : deliveryGate(pr, rt.config.base);
    log.head_sha = verdict.head_sha.slice(0, 12);
    return jsonResult(verdict as unknown as JSONValue);
  },
};
