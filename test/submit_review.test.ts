import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { marker } from "../src/rules.ts";
import { BOT, dxInput, HEAD, OLD_HEAD, REPO, review, SLUG, threadNode } from "./fixtures.ts";
import { failure, harness, TEST_KEY } from "./helpers.ts";

let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const MAJOR = dxInput().findings as any[];

describe("submit_review", () => {
  test("UT-020 submit_review: one POST on the current head with commit_id, derived event and pass-1 marker", async () => {
    const result = await h.call("submit_review", dxInput());
    assert.deepEqual(result, {
      review_id: 2849190057,
      event: "REQUEST_CHANGES",
      pass: 1,
      inline: 1,
      moved_to_summary: [{ path: "apps/reports/README.md", line: 3, reason: "not_in_diff" }],
      url: `https://github.com/${REPO}/pull/231#pullrequestreview-2849190057`,
    });
    const posts = h.posts();
    assert.equal(posts.length, 1);
    const body = posts[0]!.body;
    assert.equal(body.commit_id, HEAD);
    assert.equal(body.event, "REQUEST_CHANGES");
    assert.equal(body.body.split("\n")[0], marker(HEAD, 1));
    assert.match(body.body, /### Outside the diff\n\n- \*\*nit\*\* `apps\/reports\/README.md:3` — Typo/);
    assert.ok(!("event" in (dxInput() as object)));
    // Only minor/nit → APPROVE (UT-002 through the tool).
    h.gh.state.reviews = [];
    h.gh.state.pr.head.sha = OLD_HEAD;
    const approve = await h.call("submit_review", dxInput({ head_sha: OLD_HEAD, findings: [{ ...MAJOR[0], severity: "minor" }] }));
    assert.equal(approve.event, "APPROVE");
    assert.equal(h.posts()[1]!.body.event, "APPROVE");
  });

  test("UT-021 submit_review: inline comments are prefixed with severity and title", async () => {
    await h.call("submit_review", dxInput());
    assert.deepEqual(h.posts()[0]!.body.comments, [
      { path: "apps/reports/src/export.ts", line: 41, side: "RIGHT", body: "major: Unescaped delimiter\n\nValues containing `;` break the row; quote fields per RFC 4180." },
    ]);
  });

  test("UT-001 submit_review: zero findings → APPROVE with the summary only", async () => {
    const result = await h.call("submit_review", dxInput({ findings: [] }));
    assert.equal(result.event, "APPROVE");
    assert.deepEqual(h.posts()[0]!.body.comments, []);
    assert.equal(h.posts()[0]!.body.body, `${marker(HEAD, 1)}\n\nExport path reviewed end to end; one blocking issue in CSV escaping.`);
  });

  test("UT-004 submit_review: a blocker moved to the summary still yields REQUEST_CHANGES", async () => {
    const result = await h.call("submit_review", dxInput({ summary: "approve", findings: [{ path: "docs/x.md", line: 1, severity: "blocker", title: "Gone", body: "b" }] }));
    assert.equal(result.event, "REQUEST_CHANGES");
    assert.equal(result.inline, 0);
    assert.equal(h.posts()[0]!.body.event, "REQUEST_CHANGES");
  });

  test("UT-005 submit_review: severity critical → invalid_input naming findings[0].severity; no HTTP call", async () => {
    const error = await failure(h.call("submit_review", dxInput({ findings: [{ ...MAJOR[0], severity: "critical" }] })));
    assert.equal(error.code, "invalid_input");
    assert.equal(error.toolCode, "tool_invalid_input");
    assert.match(error.message, /^findings\[0\]\.severity/);
    assert.equal(h.fetches(), 0);
    const event = await failure(h.call("submit_review", dxInput({ event: "APPROVE" })));
    assert.equal(event.code, "invalid_input");
    assert.equal(h.fetches(), 0);
  });

  test("UT-022 submit_review: draft, closed or merged → pr_not_reviewable; no POST", async () => {
    for (const patch of [{ draft: true }, { state: "closed" }, { state: "closed", merged: true, merged_at: "2026-11-17T00:00:00Z" }]) {
      Object.assign(h.gh.state.pr, { draft: false, state: "open", merged: false, merged_at: null }, patch);
      const error = await failure(h.call("submit_review", dxInput()));
      assert.equal(error.code, "pr_not_reviewable");
    }
    assert.equal(h.posts().length, 0);
  });

  test("UT-023 submit_review: stale head_sha → head_moved naming the current head; no POST", async () => {
    const error = await failure(h.call("submit_review", dxInput({ head_sha: OLD_HEAD })));
    assert.equal(error.code, "head_moved");
    assert.match(error.message, new RegExp(`current head is ${HEAD}`));
    assert.equal(error.recovery, "end with stale: and let the dispatcher review the new head");
    assert.equal(h.posts().length, 0);
  });

  test("UT-024 submit_review: base other than the repo's delivery_base → base_not_reviewable; no POST", async () => {
    h.gh.state.pr.base = { ref: "main", repo: { default_branch: "main" } };
    const error = await failure(h.call("submit_review", dxInput()));
    assert.deepEqual([error.code, error.toolCode, error.recovery], ["base_not_reviewable", "tool_invalid_input", "the app reviews only pull requests into the repository's delivery_base"]);
    assert.match(error.message, /targets main, not delivery_base \(staging\)/);
    assert.equal(h.posts().length, 0);
  });

  test("UT-024 submit_review: delivery_base = main reviews PRs into the default branch", async () => {
    const m = await harness({}, `[repos."${REPO}"]\ndelivery_base = "main"\n`);
    m.gh.state.pr.base = { ref: "main", repo: { default_branch: "main" } };
    assert.equal((await m.call("submit_review", dxInput())).pass, 1);
    m.gh.state.pr.base = { ref: "staging", repo: { default_branch: "main" } };
    m.gh.state.reviews = [];
    assert.equal((await failure(m.call("submit_review", dxInput()))).code, "base_not_reviewable");
    await m.close();
  });

  test("UT-025 submit_review: repository outside the allowlist → repo_not_allowed; no HTTP call at all", async () => {
    const other = "acme/other";
    const inputs: [string, Record<string, unknown>][] = [
      ["submit_review", dxInput({ repo: other })],
      ["pr_context", { repo: other, number: 231 }],
      ["merge_gate", { repo: other, number: 231, kind: "delivery" }],
    ];
    for (const [tool, input] of inputs) {
      const error = await failure(h.call(tool, input));
      assert.equal(error.code, "repo_not_allowed");
      assert.equal(error.toolCode, "tool_invalid_input");
    }
    assert.equal(h.fetches(), 0);
  });

  test("UT-026 submit_review: 51 findings → too_many_findings; 4 001-character body → field_too_long", async () => {
    const many = Array.from({ length: 51 }, () => ({ ...MAJOR[1] }));
    assert.equal((await failure(h.call("submit_review", dxInput({ findings: many })))).code, "too_many_findings");
    const long = await failure(h.call("submit_review", dxInput({ findings: [{ ...MAJOR[0], body: "x".repeat(4001) }] })));
    assert.equal(long.code, "field_too_long");
    assert.match(long.message, /findings\[0\]\.body/);
    assert.equal((await failure(h.call("submit_review", dxInput({ summary: "s".repeat(8001) })))).code, "field_too_long");
    // Exactly at the limits is accepted.
    await h.call("submit_review", dxInput({ summary: "s".repeat(8000), findings: [...Array.from({ length: 49 }, () => ({ ...MAJOR[1] })), { ...MAJOR[0], body: "x".repeat(4000) }] }));
    assert.equal(h.posts().length, 1);
  });

  test("UT-027 submit_review: GitHub 429 with x-ratelimit-reset → rate_limited with ISO reset; nothing posted", async () => {
    h.gh.respond = request =>
      request.path.endsWith("/pulls/231") ? { status: 429, body: { message: "rate" }, headers: { "x-ratelimit-reset": "1763402640", "x-ratelimit-remaining": "0" } } : undefined;
    const error = await failure(h.call("submit_review", dxInput()));
    assert.equal(error.code, "rate_limited");
    assert.equal(error.toolCode, "tool_unavailable");
    assert.match(error.message, /resets at 2025-11-17T18:04:00\.000Z/);
    assert.equal(h.posts().length, 0);
  });

  test("UT-028 submit_review: reviews re-read before POST already hold pass 1 → already_reviewed_head; no POST", async () => {
    h.gh.state.reviewsBeforePost = [review(BOT, "APPROVED", HEAD, `${marker(HEAD, 1)}\n\nconcurrent`)];
    const error = await failure(h.call("submit_review", dxInput()));
    assert.equal(error.code, "already_reviewed_head");
    assert.equal(h.posts().length, 0);
    // A sequential second call is refused too (US-010.AC-3); a human's marker-like review is not the app's.
    h.gh.state.reviews = [review("octocat", "COMMENTED", HEAD, marker(HEAD, 1))];
    await h.call("submit_review", dxInput());
    assert.equal((await failure(h.call("submit_review", dxInput()))).code, "already_reviewed_head");
    assert.equal(h.posts().length, 1);
  });

  const contest = (commit = HEAD, replier = "octocat") =>
    threadNode("PRRT_1", false, [
      { login: SLUG, bot: true, body: "major: Unescaped delimiter", at: "2026-11-18T13:02:11Z" },
      { login: replier, body: "Contest: …", at: "2026-11-18T13:20:40Z" },
    ], commit);
  const pass1 = () => review(BOT, "CHANGES_REQUESTED", HEAD, `${marker(HEAD, 1)}\n\npass one`, 2849182211);

  test("UT-031 submit_review: contested head with rereview → pass 2 posted on the same head", async () => {
    h.gh.state.reviews = [pass1()];
    h.gh.state.threads = [contest()];
    const result = await h.call("submit_review", dxInput({ rereview: true, findings: [] }));
    assert.equal(result.pass, 2);
    assert.equal(result.event, "APPROVE");
    assert.equal(h.posts().length, 1);
    assert.equal(h.posts()[0]!.body.commit_id, HEAD);
    assert.match(h.lines.at(-1)!, / pass=2 event=APPROVE /);
  });

  test("UT-032 submit_review: pass 2 body starts with the pass=2 marker", async () => {
    h.gh.state.reviews = [pass1()];
    h.gh.state.threads = [contest()];
    await h.call("submit_review", dxInput({ rereview: true }));
    assert.equal(h.posts()[0]!.body.body.split("\n")[0], marker(HEAD, 2));
    assert.equal(h.posts()[0]!.body.body.split("\n")[0], `<!-- github-app-review head=${HEAD} pass=2 -->`);
  });

  test("UT-033 submit_review: rereview without a contest, without pass 1, or after pass 2 → rereview_not_eligible; no POST", async () => {
    const states: [string, any[], any[]][] = [
      ["no reply", [pass1()], []],
      ["reply on an old head thread", [pass1()], [contest(OLD_HEAD)]],
      ["no pass 1", [], [contest()]],
      ["pass 2 exists", [pass1(), review(BOT, "APPROVED", HEAD, `${marker(HEAD, 2)}\n\npass two`, 2849182212)], [contest()]],
    ];
    for (const [name, reviews, threads] of states) {
      Object.assign(h.gh.state, { reviews, threads });
      const error = await failure(h.call("submit_review", dxInput({ rereview: true })));
      assert.equal(error.code, "rereview_not_eligible", name);
      assert.equal(error.toolCode, "tool_invalid_input");
      assert.equal(error.recovery, "the executor must change code or reply on a bot thread");
    }
    assert.equal(h.posts().length, 0);
    // Race guard: a concurrent pass 2 seen in the re-read before POST refuses this one.
    Object.assign(h.gh.state, { reviews: [pass1()], threads: [contest()] });
    h.gh.state.reviewsBeforePost = [pass1(), review(BOT, "APPROVED", HEAD, marker(HEAD, 2), 2849182212)];
    assert.equal((await failure(h.call("submit_review", dxInput({ rereview: true })))).code, "rereview_not_eligible");
    assert.equal(h.posts().length, 0);
    // EC-2: a contest on an old head is head_moved.
    assert.equal((await failure(h.call("submit_review", dxInput({ rereview: true, head_sha: OLD_HEAD })))).code, "head_moved");
    // A non-boolean flag is invalid input before any HTTP call.
    const fetches = h.fetches();
    assert.equal((await failure(h.call("submit_review", dxInput({ rereview: "yes" })))).code, "invalid_input");
    assert.equal(h.fetches(), fetches);
  });

  test("UT-073 logs: one line per call with no PEM, token, finding body or summary", async () => {
    await h.call("submit_review", dxInput());
    await failure(h.call("submit_review", dxInput()));
    assert.equal(h.lines.length, 2);
    assert.match(h.lines[0]!, /^github-app-review: tool=submit_review repo=acme\/widgets pr=231 head_sha=9f2c1e0a7b3d pass=1 event=REQUEST_CHANGES inline=1 moved=1 outcome=ok github_status=- duration_ms=\d+\n$/);
    assert.match(h.lines[1]!, /outcome=already_reviewed_head/);
    const logs = h.lines.join("");
    for (const secret of ["PRIVATE KEY", TEST_KEY.split("\n")[1]!, "ghs_", "ghp_", "RFC 4180", "exprot", "Export path reviewed"]) {
      assert.ok(!logs.includes(secret), secret);
    }
  });
});
