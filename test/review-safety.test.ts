import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { MAX_PAGES } from "../src/github.ts";
import { marker } from "../src/rules.ts";
import { MAX_REVIEW_BODY } from "../src/tools/submit_review.ts";
import { BOT, dxInput, HEAD, OLD_HEAD, pull, REPO, review, SLUG, threadNode } from "./fixtures.ts";
import { failure, harness } from "./helpers.ts";

let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const pass1 = (id = 2849182211, at = "2026-11-18T13:00:00Z") => review(BOT, "CHANGES_REQUESTED", HEAD, `${marker(HEAD, 1)}\n\npass one`, id, at);
const pass2 = () => review(BOT, "APPROVED", HEAD, `${marker(HEAD, 2)}\n\npass two`, 2849182212, "2026-11-18T13:30:00Z");
const contest = (replyAt = "2026-11-18T13:20:40Z") =>
  threadNode("PRRT_1", false, [
    { login: SLUG, bot: true, body: "major: Unescaped delimiter", at: "2026-11-18T13:02:11Z" },
    { login: "octocat", body: "Contest: …", at: replyAt },
  ]);
const comments = (count: number) => Array.from({ length: count }, (_, i) => review("someone", "COMMENTED", OLD_HEAD, "", 10_000 + i));
const gate = (kind = "delivery") => h.call("merge_gate", { repo: REPO, number: h.gh.state.pr.number, kind });

describe("R-1 pass 2 eligibility through the handler", () => {
  test("UT-033 submit_review: reply older than pass 1 → rereview_not_eligible; no POST", async () => {
    Object.assign(h.gh.state, { reviews: [pass1(undefined, "2026-11-18T14:00:00Z")], threads: [contest("2026-11-18T13:00:00Z")] });
    assert.equal((await failure(h.call("submit_review", dxInput({ rereview: true, findings: [] })))).code, "rereview_not_eligible");
    assert.equal(h.posts().length, 0);
  });

  test("UT-033 submit_review: duplicate pass 1 on the head (concurrent race) → rereview_not_eligible; no POST", async () => {
    const reviews = [pass1(1, "2026-11-18T12:00:00Z"), pass1(2, "2026-11-18T14:00:00Z")];
    for (const replyAt of ["2026-11-18T13:00:00Z", "2026-11-18T15:00:00Z"]) {
      Object.assign(h.gh.state, { reviews, threads: [contest(replyAt)] });
      assert.equal((await failure(h.call("submit_review", dxInput({ rereview: true, findings: [] })))).code, "rereview_not_eligible", replyAt);
    }
    assert.equal(h.posts().length, 0);
  });

  test("UT-031 submit_review: reply after pass 1 → pass 2", async () => {
    Object.assign(h.gh.state, { reviews: [pass1()], threads: [contest()] });
    assert.equal((await h.call("submit_review", dxInput({ rereview: true, findings: [] }))).pass, 2);
  });
});

describe("R-2 PR re-validated right before the POST", () => {
  const during = (path: string, change: () => void) => {
    let done = false;
    h.gh.respond = request => {
      if (!done && request.path.endsWith(path)) {
        done = true;
        change();
      }
      return undefined;
    };
  };

  test("UT-023 submit_review: head moves during the files read → head_moved; no POST", async () => {
    during("/files", () => (h.gh.state.pr.head.sha = OLD_HEAD));
    const error = await failure(h.call("submit_review", dxInput({ findings: [] })));
    assert.equal(error.code, "head_moved");
    assert.match(error.message, new RegExp(`current head is ${OLD_HEAD}`));
    assert.equal(h.posts().length, 0);
  });

  test("UT-024 submit_review: base retargeted away from GITHUB_APP_BASE during the reads → base_not_reviewable; no POST", async () => {
    during("/files", () => (h.gh.state.pr.base = { ref: "main", repo: { default_branch: "main" } }));
    assert.equal((await failure(h.call("submit_review", dxInput({ findings: [] })))).code, "base_not_reviewable");
    during("/reviews", () => (h.gh.state.pr.draft = true));
    h.gh.state.pr.base = { ref: "staging", repo: { default_branch: "main" } };
    assert.equal((await failure(h.call("submit_review", dxInput({ findings: [] })))).code, "pr_not_reviewable");
    assert.equal(h.posts().length, 0);
  });
});

describe("R-3 complete review and check histories", () => {
  test("UT-028 submit_review: pass 1 and pass 2 after 1 000 other reviews → pass 3 refused; no POST", async () => {
    h.gh.state.reviews = [...comments(1000), pass1(), pass2()];
    assert.equal((await failure(h.call("submit_review", dxInput()))).code, "already_reviewed_head");
    h.gh.state.threads = [contest("2026-11-18T13:40:00Z")];
    assert.equal((await failure(h.call("submit_review", dxInput({ rereview: true })))).code, "rereview_not_eligible");
    assert.equal(h.posts().length, 0);
  });

  test("UT-028 submit_review: review history beyond the paging cap → github_unavailable; no POST", async () => {
    h.gh.state.reviews = comments(MAX_PAGES * 100 + 1);
    const error = await failure(h.call("submit_review", dxInput()));
    assert.equal(error.code, "github_unavailable");
    assert.match(error.message, /too large/);
    assert.equal(h.posts().length, 0);
  });

  test("UT-043 merge_gate: a CHANGES_REQUESTED after 1 000 reviews blocks; checks: a failure after 1 000 successes blocks", async () => {
    h.gh.state.reviews = [review(BOT, "APPROVED", HEAD), ...comments(999), review("human", "CHANGES_REQUESTED", HEAD, "", 99)];
    assert.deepEqual((await gate()).reasons, ["changes_requested"]);
    h.gh.state.reviews = [review(BOT, "APPROVED", HEAD)];
    h.gh.state.checkRuns = [...Array.from({ length: 1000 }, (_, i) => ({ name: `c${i}`, status: "completed", conclusion: "success" })), { name: "late", status: "completed", conclusion: "failure" }];
    assert.deepEqual((await gate()).reasons, ["checks_failed"]);
  });

  test("UT-046 merge_gate: reviews or checks beyond the paging cap → not ready, history_incomplete", async () => {
    h.gh.state.reviews = [review(BOT, "APPROVED", HEAD), ...comments(MAX_PAGES * 100)];
    assert.deepEqual(await gate(), { ready: false, head_sha: HEAD, reasons: ["history_incomplete"] });
    h.gh.state.reviews = [review(BOT, "APPROVED", HEAD)];
    h.gh.state.checkRuns = Array.from({ length: MAX_PAGES * 100 + 1 }, (_, i) => ({ name: `c${i}`, status: "completed", conclusion: "success" }));
    assert.deepEqual((await gate()).reasons, ["history_incomplete"]);
  });

  test("UT-053 merge_gate kind=promotion: approval superseded after 1 000 reviews blocks; cap → history_incomplete", async () => {
    h.gh.state.pr = pull(240, BOT, "staging", "main", HEAD);
    h.gh.state.reviews = [review("octocat", "APPROVED", HEAD), ...comments(1000), review("octocat", "CHANGES_REQUESTED", HEAD, "", 98)];
    assert.deepEqual((await gate("promotion")).reasons, ["promotion_not_approved", "changes_requested"]);
    h.gh.state.reviews = [review("octocat", "APPROVED", HEAD)];
    assert.deepEqual((await gate("promotion")).reasons, []);
    h.gh.state.reviews = [review("octocat", "APPROVED", HEAD), ...comments(MAX_PAGES * 100)];
    assert.deepEqual((await gate("promotion")).reasons, ["history_incomplete"]);
  });
});

describe("R-5 thread comments paged to the end", () => {
  test("UT-031 submit_review: a contest that is comment 101+ of an app thread → pass 2", async () => {
    const bot = Array.from({ length: 120 }, (_, i) => ({ login: SLUG, bot: true, body: `bot ${i}`, at: "2026-11-18T13:02:11Z" }));
    h.gh.state.threads = [threadNode("PRRT_1", false, [...bot, { login: "octocat", body: "Contest: …", at: "2026-11-18T13:20:40Z" }])];
    h.gh.state.reviews = [pass1()];
    assert.equal((await h.call("submit_review", dxInput({ rereview: true, findings: [] }))).pass, 2);
    assert.equal(h.gh.requests.filter(r => r.path === "/graphql").length, 2);
    const context = await h.call("pr_context", { repo: REPO, number: 231 });
    assert.equal(context.app_threads[0].comments.length, 121);
    assert.equal(context.app_threads[0].comments.at(-1).author, "octocat");
  });
});

describe("R-7 moved findings keep their full text", () => {
  const outside = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ path: `docs/f${i}.md`, line: 1, severity: "major", title: `T${i}`, body: `${i}:`.padEnd(4000, String.fromCharCode(97 + (i % 26))) }));

  test("UT-026 submit_review: 16 moved findings × 4 000 characters → field_too_long on the review body; no POST", async () => {
    const error = await failure(h.call("submit_review", dxInput({ findings: outside(16) })));
    assert.equal(error.code, "field_too_long");
    assert.match(error.message, /^review body .* \(max 60000\)$/);
    assert.equal(error.recovery, "split or shorten findings");
    assert.equal(h.posts().length, 0);
  });

  test("UT-026 submit_review: under the limit, every moved finding's full text is in the body", async () => {
    const findings = outside(14);
    const result = await h.call("submit_review", dxInput({ findings }));
    assert.equal(result.moved_to_summary.length, 14);
    const body: string = h.posts()[0]!.body.body;
    assert.ok(body.length <= MAX_REVIEW_BODY);
    for (const f of findings) assert.ok(body.includes(f.body) && body.includes(`\`${f.path}:1\` — ${f.title}`), f.path);
  });
});

describe("R-12 / R-14 capped histories outside submit_review", () => {
  test("UT-012 pr_context: review history beyond the paging cap → github_unavailable", async () => {
    h.gh.state.reviews = comments(MAX_PAGES * 100 + 1);
    const error = await failure(h.call("pr_context", { repo: REPO, number: 231 }));
    assert.deepEqual([error.code, error.toolCode], ["github_unavailable", "tool_backend_failed"]);
    assert.match(error.message, /too large/);
  });

  test("UT-046 merge_gate: review threads beyond the paging cap → not ready, history_incomplete", async () => {
    h.gh.state.reviews = [review(BOT, "APPROVED", HEAD)];
    h.gh.state.threadPageSize = 1;
    h.gh.state.threads = Array.from({ length: MAX_PAGES + 1 }, (_, i) => threadNode(`PRRT_${i}`, true, [{ login: "x", body: "y", at: "2026-11-18T13:00:00Z" }]));
    assert.deepEqual(await gate(), { ready: false, head_sha: HEAD, reasons: ["history_incomplete"] });
    // submit_review keeps refusing at the cap when it needs the threads (pass 2).
    h.gh.state.reviews = [pass1()];
    const error = await failure(h.call("submit_review", dxInput({ rereview: true, findings: [] })));
    assert.equal(error.code, "github_unavailable");
    assert.equal(h.posts().length, 0);
  });
});
