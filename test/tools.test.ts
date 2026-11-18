import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { BOT, HEAD, OLD_HEAD, REPO, review, SLUG, threadNode } from "./fixtures.ts";
import { failure, harness } from "./helpers.ts";

let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

describe("pr_context and merge_gate over the fake GitHub", () => {
  test("pr_context: _dx.md shape with commentable lines, app reviews and app threads (paged)", async () => {
    h.gh.state.reviews = [review(BOT, "CHANGES_REQUESTED", OLD_HEAD, `<!-- github-app-review head=${OLD_HEAD} pass=1 -->\n\nx`, 2849182211), review("octocat", "COMMENTED", OLD_HEAD)];
    h.gh.state.threadPageSize = 1;
    h.gh.state.threads = [
      threadNode("PRRT_1", false, [
        { login: SLUG, bot: true, body: "major: …", at: "2026-11-18T13:02:11Z" },
        { login: "octocat", body: "Contest: …", at: "2026-11-18T13:20:40Z" },
      ]),
      threadNode("PRRT_2", false, [{ login: "octocat", body: "human thread", at: "2026-11-18T13:00:00Z" }]),
    ];
    const out = await h.call("pr_context", { repo: REPO, number: 231 });
    assert.deepEqual(Object.keys(out), ["head_sha", "base_ref", "head_ref", "author", "state", "is_draft", "title", "body", "files", "files_truncated", "commentable", "app_reviews", "app_threads", "conventions"]);
    assert.deepEqual(out.conventions, { ref: "staging", review_md: null, factory_toml: null });
    assert.equal(out.head_sha, HEAD);
    assert.equal(out.state, "open");
    assert.equal(out.files_truncated, false);
    assert.deepEqual(out.files, [{ path: "apps/reports/src/export.ts", status: "modified", additions: 42, deletions: 3 }]);
    assert.deepEqual(out.commentable[0], { path: "apps/reports/src/export.ts", side: "RIGHT", lines: [10, 11, 12, 40, 41] });
    assert.deepEqual(out.app_reviews, [{ id: 2849182211, state: "CHANGES_REQUESTED", commit_id: OLD_HEAD, pass: 1, submitted_at: "2026-11-18T13:00:00Z" }]);
    assert.equal(out.app_threads.length, 1);
    assert.equal(out.app_threads[0].commit_id, HEAD);
    assert.deepEqual(out.app_threads[0].comments.map((c: any) => [c.author, c.is_app]), [[BOT, true], ["octocat", false]]);
    assert.equal(h.gh.requests.filter(r => r.path === "/graphql").length, 2);
  });

  test("pr_context: conventions come from the base branch, never the PR head", async () => {
    h.gh.state.contents = { "REVIEW.md": "# Rules\n", ".compozy/factory/factory.toml": "[review]\nrepo = \"x/y\"\n" };
    const out = await h.call("pr_context", { repo: REPO, number: 231 });
    assert.deepEqual(out.conventions, { ref: "staging", review_md: "# Rules\n", factory_toml: "[review]\nrepo = \"x/y\"\n" });
    assert.equal(h.gh.requests.filter(r => r.path.includes("/contents/")).length, 2);
  });

  test("UT-012 pr_context: more changed files than listed → files_truncated", async () => {
    h.gh.state.pr.changed_files = 3001;
    assert.equal((await h.call("pr_context", { repo: REPO, number: 231 })).files_truncated, true);
  });

  test("UT-040 merge_gate: kind=staging over a fixture meeting BR-7 → ready; flip a condition → its reason", async () => {
    h.gh.state.reviews = [review(BOT, "APPROVED", HEAD)];
    assert.deepEqual(await h.call("merge_gate", { repo: REPO, number: 231, kind: "delivery" }), { ready: true, head_sha: HEAD, reasons: [] });
    h.gh.state.checkRuns.push({ name: "lint", status: "completed", conclusion: "failure" });
    h.gh.state.threads = [threadNode("PRRT_9", false, [{ login: "x", body: "y", at: "2026-11-18T13:00:00Z" }])];
    assert.deepEqual((await h.call("merge_gate", { repo: REPO, number: 231, kind: "delivery" })).reasons, ["checks_failed", "unresolved_threads"]);
    assert.equal((await failure(h.call("merge_gate", { repo: REPO, number: 231, kind: "main" }))).code, "invalid_input");
  });

  test("UT-027 merge_gate: GitHub 5xx → github_unavailable (tool_backend_failed); 422 → github_rejected", async () => {
    h.gh.respond = () => ({ status: 502 });
    const down = await failure(h.call("merge_gate", { repo: REPO, number: 231, kind: "delivery" }));
    assert.deepEqual([down.code, down.toolCode], ["github_unavailable", "tool_backend_failed"]);
    h.gh.respond = request => (request.method === "POST" && request.path.endsWith("/reviews") ? { status: 422, body: { message: "Validation Failed", errors: ["Line could not be resolved"] } } : undefined);
    const { dxInput } = await import("./fixtures.ts");
    const rejected = await failure(h.call("submit_review", dxInput()));
    assert.equal(rejected.code, "github_rejected");
    assert.match(rejected.message, /Line could not be resolved/);
  });
});
