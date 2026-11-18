import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { promotionGate, type PrSnapshot, type PromotionConfig } from "../src/rules.ts";
import { includedPrs, MAX_COMPARE_PAGES } from "../src/tools/upsert_promotion.ts";
import { BOT, HEAD, OLD_HEAD, PROMO_HEAD, pull, REPO, review } from "./fixtures.ts";
import { failure, harness } from "./helpers.ts";

const CFG: PromotionConfig = { head: "staging", base: "main", approvers: ["octocat"] };

const promotion = (): PrSnapshot => ({
  state: "open",
  base_ref: "main",
  head_ref: "staging",
  head_sha: HEAD,
  author: BOT,
  author_is_app: true,
  reviews: [{ author: "octocat", is_app: false, state: "APPROVED", commit_id: HEAD }],
  checks: [{ status: "completed", conclusion: "success" }],
  history_complete: true,
  mergeable: "MERGEABLE",
  threads: [{ is_resolved: true }],
});

describe("promotion gate (BR-8)", () => {
  test("UT-050 promotionGate: app-authored, approver octocat approved current head → ready", () => {
    assert.deepEqual(promotionGate(promotion(), CFG), { ready: true, head_sha: HEAD, reasons: [] });
    // Logins compare case-insensitively; a later COMMENTED review keeps the approval.
    const s = promotion();
    s.reviews.push({ author: "octocat", is_app: false, state: "COMMENTED", commit_id: HEAD });
    assert.deepEqual(promotionGate(s, { ...CFG, approvers: ["OctoCat"] }).reasons, []);
  });

  test("UT-051 promotionGate: approval from a non-configured login → promotion_not_approved", () => {
    const s = promotion();
    s.reviews = [{ author: "someone", is_app: false, state: "APPROVED", commit_id: HEAD }];
    assert.deepEqual(promotionGate(s, CFG).reasons, ["promotion_not_approved"]);
    // The app's own approval never counts, even if its login were configured.
    s.reviews = [{ author: BOT, is_app: true, state: "APPROVED", commit_id: HEAD }];
    assert.deepEqual(promotionGate(s, { ...CFG, approvers: [BOT] }).reasons, ["promotion_not_approved"]);
    // No approvers configured → never ready.
    assert.deepEqual(promotionGate(promotion(), { ...CFG, approvers: [] }).reasons, ["promotion_not_approved"]);
  });

  test("UT-052 promotionGate: PR authored by a human → not_app_authored", () => {
    const s = promotion();
    s.author = "octocat";
    s.author_is_app = false;
    assert.deepEqual(promotionGate(s, CFG).reasons, ["not_app_authored"]);
  });

  test("UT-053 promotionGate: approval on an older head → promotion_not_approved; later CHANGES_REQUESTED replaces it", () => {
    const s = promotion();
    s.reviews[0]!.commit_id = OLD_HEAD;
    assert.deepEqual(promotionGate(s, CFG).reasons, ["promotion_not_approved"]);
    s.reviews = [
      { author: "octocat", is_app: false, state: "APPROVED", commit_id: HEAD },
      { author: "octocat", is_app: false, state: "CHANGES_REQUESTED", commit_id: HEAD },
    ];
    assert.deepEqual(promotionGate(s, CFG).reasons, ["promotion_not_approved", "changes_requested"]);
  });

  test("UT-050 promotionGate: base/head must match GITHUB_APP_PROMOTION (no default-branch assumption)", () => {
    // Any configured base works, whether or not it is the repository's default branch.
    assert.deepEqual(promotionGate({ ...promotion(), base_ref: "release" }, { ...CFG, base: "release" }).reasons, []);
    for (const change of [{ base_ref: "staging" }, { head_ref: "feature" }]) {
      assert.deepEqual(promotionGate({ ...promotion(), ...change }, CFG).reasons, ["base_mismatch"], JSON.stringify(change));
    }
  });

  test("UT-050 promotionGate: BR-7 rules hold; every condition failing → one reason each, stable order", () => {
    const s: PrSnapshot = {
      ...promotion(),
      state: "closed",
      author_is_app: false,
      base_ref: "staging",
      reviews: [{ author: "human", is_app: false, state: "CHANGES_REQUESTED", commit_id: HEAD }],
      checks: [{ status: "queued", conclusion: null }, { status: "completed", conclusion: "failure" }],
      mergeable: "UNKNOWN",
      threads: [{ is_resolved: false }],
    };
    const expected = ["pr_not_open", "not_app_authored", "base_mismatch", "promotion_not_approved", "changes_requested", "checks_pending", "checks_failed", "not_mergeable", "unresolved_threads"];
    assert.deepEqual(promotionGate(s, CFG), { ready: false, head_sha: HEAD, reasons: expected });
  });
});

let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});
const writes = () => h.gh.requests.filter(r => r.method === "POST" && r.path.endsWith("/pulls") || r.method === "PATCH");

describe("upsert_promotion and merge_gate kind=promotion over the fake GitHub", () => {
  test("UT-054 upsert_promotion: open staging → main PR by another author → promotion_conflict naming it; no POST", async () => {
    h.gh.state.pulls = [pull(239, "octocat")];
    const err = await failure(h.call("upsert_promotion", { repo: REPO }));
    assert.deepEqual([err.code, err.toolCode, err.recovery], ["promotion_conflict", "tool_invalid_input", "operator closes or merges that PR"]);
    assert.match(err.message, /#239 by octocat/);
    assert.deepEqual(writes(), []);
  });

  test("UT-055 upsert_promotion: compare shows 0 commits → created:false, number:null; no POST", async () => {
    h.gh.state.compare = { total_commits: 0, commits: [] };
    h.gh.state.pulls = [pull(239, "octocat")];
    assert.deepEqual(await h.call("upsert_promotion", { repo: REPO }), { created: false, number: null, url: null, head_sha: null, included_prs: [] });
    assert.deepEqual(writes(), []);
    assert.ok(h.gh.requests.some(r => r.path === `/repos/${REPO}/compare/main...staging`));
  });

  test("UT-056 upsert_promotion: existing open app PR → PATCH body with the new PR list; created:false", async () => {
    h.gh.state.pulls = [pull(240, BOT)];
    const out = await h.call("upsert_promotion", { repo: REPO });
    assert.deepEqual(out, { created: false, number: 240, url: `https://github.com/${REPO}/pull/240`, head_sha: PROMO_HEAD, included_prs: [231, 233, 236] });
    const [patch, ...rest] = writes();
    assert.deepEqual(rest, []);
    assert.equal(patch!.path, `/repos/${REPO}/pulls/240`);
    assert.deepEqual(Object.keys(patch!.body), ["body"]);
    assert.match(patch!.body.body, /- #231\n- #233\n- #236/);
  });

  test("UT-056 upsert_promotion: 260 compared commits are paged to the end; every PR is listed", async () => {
    const commits = Array.from({ length: 260 }, (_, i) => ({ sha: `s${i}`, commit: { message: `change ${i} (#${1000 + i})` } }));
    h.gh.state.compare = { total_commits: 260, commits };
    const out = await h.call("upsert_promotion", { repo: REPO });
    assert.equal(out.included_prs.length, 260);
    assert.equal(out.included_prs.at(-1), 1259);
    assert.equal(h.gh.requests.filter(r => r.path.includes("/compare/")).length, 3);
    assert.match(writes()[0]!.body.body, /- #1259\n$/);
  });

  test("UT-056 upsert_promotion: comparison beyond the paging cap → github_unavailable; nothing written", async () => {
    const commits = Array.from({ length: MAX_COMPARE_PAGES * 100 + 1 }, (_, i) => ({ sha: `s${i}`, commit: { message: `c (#${i + 1})` } }));
    h.gh.state.compare = { total_commits: commits.length, commits };
    const err = await failure(h.call("upsert_promotion", { repo: REPO }));
    assert.equal(err.code, "github_unavailable");
    assert.match(err.message, /comparison too large/);
    assert.deepEqual(writes(), []);
  });

  test("UT-056 upsert_promotion: no open promotion → POST staging → main by the app; created:true", async () => {
    const out = await h.call("upsert_promotion", { repo: REPO });
    assert.deepEqual(out, { created: true, number: 240, url: `https://github.com/${REPO}/pull/240`, head_sha: PROMO_HEAD, included_prs: [231, 233, 236] });
    const [post] = writes();
    assert.deepEqual([post!.body.head, post!.body.base], ["staging", "main"]);
    assert.ok(!h.gh.requests.some(r => r.path.endsWith("/reviews") && r.method === "POST"), "the app never approves a promotion");
    assert.match(h.lines.at(-1)!, /tool=upsert_promotion repo=\S+ pr=240 head_sha=c0ffee123456 outcome=ok/);
  });

  test("UT-056 includedPrs: squash and merge-commit subjects, unique and sorted; other lines ignored", () => {
    const commit = (message: string) => ({ commit: { message } });
    assert.deepEqual(includedPrs([commit("b (#9)"), commit("Merge pull request #3 from x/y"), commit("a (#9)"), commit("chore\n\nsee (#4)"), commit("no ref")]), [3, 9]);
  });

  test("UT-050 merge_gate kind=promotion: operator approval on the app's PR head → ready; human-authored → not_app_authored", async () => {
    h.gh.state.pr = pull(240, BOT, "staging", "main", HEAD);
    h.gh.state.reviews = [review("octocat", "APPROVED", HEAD)];
    const gate = { repo: REPO, number: 240, kind: "promotion" };
    assert.deepEqual(await h.call("merge_gate", gate), { ready: true, head_sha: HEAD, reasons: [] });
    h.gh.state.pr.user = { login: "octocat", type: "User" };
    assert.deepEqual((await h.call("merge_gate", gate)).reasons, ["not_app_authored"]);
  });

  test("UT-054 promotion tools: GITHUB_APP_PROMOTION unset or another repo → invalid_input before any HTTP call", async () => {
    await h.close();
    h = await harness({ GITHUB_APP_PROMOTION: undefined });
    for (const call of [h.call("upsert_promotion", { repo: REPO }), h.call("merge_gate", { repo: REPO, number: 240, kind: "promotion" })]) {
      assert.equal((await failure(call)).code, "invalid_input");
    }
    await h.close();
    h = await harness({ GITHUB_APP_REPOS: `${REPO},acme/other` });
    assert.match((await failure(h.call("upsert_promotion", { repo: "acme/other" }))).message, /not the promotion repository/);
    assert.equal(h.fetches(), 0);
  });
});
