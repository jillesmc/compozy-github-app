import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { commentableLines } from "../src/github.ts";
import { deriveEvent, marker, parsePass, partitionAnchors, passFor, deliveryGate, type AppReview, type AppThread, type Finding, type PrSnapshot, type Severity } from "../src/rules.ts";
import { BOT, EXPORT_PATCH, HEAD, OLD_HEAD } from "./fixtures.ts";

const finding = (severity: Severity, extra: Partial<Finding> = {}): Finding => ({
  path: "apps/reports/src/export.ts",
  line: 41,
  severity,
  title: "t",
  body: "b",
  ...extra,
});

describe("event derivation", () => {
  test("UT-001 deriveEvent: zero findings → APPROVE", () => {
    assert.equal(deriveEvent([]), "APPROVE");
  });
  test("UT-002 deriveEvent: minor and nit → APPROVE", () => {
    assert.equal(deriveEvent([finding("minor"), finding("nit")]), "APPROVE");
  });
  test("UT-003 deriveEvent: nit then major → REQUEST_CHANGES; blocker alone too", () => {
    assert.equal(deriveEvent([finding("nit"), finding("major")]), "REQUEST_CHANGES");
    assert.equal(deriveEvent([finding("blocker")]), "REQUEST_CHANGES");
  });
});

describe("anchors", () => {
  const commentable = commentableLines("apps/reports/src/export.ts", EXPORT_PATCH);

  test("UT-010 partitionAnchors: export.ts:41 RIGHT with commentable [40,41] → inline", () => {
    assert.deepEqual(commentable, [
      { path: "apps/reports/src/export.ts", side: "RIGHT", lines: [10, 11, 12, 40, 41] },
      { path: "apps/reports/src/export.ts", side: "LEFT", lines: [10, 11, 12] },
    ]);
    const out = partitionAnchors([finding("major", { side: "RIGHT" }), finding("nit", { start_line: 40 })], commentable);
    assert.equal(out.inline.length, 2);
    assert.deepEqual(out.moved, []);
  });

  test("UT-011 partitionAnchors: path absent → not_in_diff; LEFT on a right-only line → side_mismatch", () => {
    const readme = finding("nit", { path: "apps/reports/README.md", line: 3 });
    const left = finding("minor", { side: "LEFT", line: 41 });
    const outside = finding("minor", { line: 200 });
    const startOutside = finding("minor", { line: 41, start_line: 30 });
    const otherPath = finding("minor", { path: "apps/reports/src/other.ts", line: 41 });
    const out = partitionAnchors([readme, left, outside, startOutside, otherPath], commentable);
    assert.deepEqual(out.inline, []);
    assert.deepEqual(out.moved.map(m => m.reason), ["not_in_diff", "side_mismatch", "not_in_diff", "not_in_diff", "not_in_diff"]);
  });

  test("UT-012 partitionAnchors: truncated file list, unseen path → not_in_diff", () => {
    // With files_truncated the commentable set only covers the files GitHub listed.
    const out = partitionAnchors([finding("blocker", { path: "apps/unseen/file-3001.ts", line: 1 })], commentable);
    assert.deepEqual(out.moved.map(m => m.reason), ["not_in_diff"]);
    assert.equal(deriveEvent([out.moved[0]!.finding]), "REQUEST_CHANGES");
  });
});

describe("pass selection", () => {
  test("UT-030 passFor: pass 1 on old head H1, current head H2 → pass 1", () => {
    const appReviews = [{ id: 1, state: "CHANGES_REQUESTED", commit_id: OLD_HEAD, pass: 1 as const, submitted_at: "2026-11-18T13:00:00Z" }];
    assert.deepEqual(passFor({ headSha: HEAD, appReviews, threads: [], rereview: false }), { pass: 1 });
  });
  test("UT-030 passFor: pass 1 already on the head → already_reviewed_head; unmarked app review ignored", () => {
    const marked = [{ id: 1, state: "APPROVED", commit_id: HEAD, pass: 1 as const, submitted_at: "2026-11-18T13:00:00Z" }];
    assert.deepEqual(passFor({ headSha: HEAD, appReviews: marked, threads: [], rereview: false }), { refused: "already_reviewed_head" });
    const unmarked = [{ id: 2, state: "COMMENTED", commit_id: HEAD, pass: null, submitted_at: "2026-11-18T13:00:00Z" }];
    assert.deepEqual(passFor({ headSha: HEAD, appReviews: unmarked, threads: [], rereview: false }), { pass: 1 });
  });
  const pass1 = { id: 1, state: "CHANGES_REQUESTED", commit_id: HEAD, pass: 1 as const, submitted_at: "2026-11-18T13:00:00Z" };
  const contestOn = (commit: string, replier = "octocat"): AppThread => ({
    id: "PRRT_1",
    is_resolved: false,
    path: "apps/reports/src/export.ts",
    line: 41,
    commit_id: commit,
    comments: [
      { author: BOT, is_app: true, body: "major: …", created_at: "2026-11-18T13:02:11Z" },
      { author: replier, is_app: false, body: "Contest: …", created_at: "2026-11-18T13:20:40Z" },
    ],
  });
  test("UT-031 passFor: pass 1 on H, non-bot reply after it on a bot thread of H, rereview → pass 2", () => {
    assert.deepEqual(passFor({ headSha: HEAD, appReviews: [pass1], threads: [contestOn(HEAD)], rereview: true }), { pass: 2 });
    // App reviews on other heads do not move the reference time.
    const later = { ...pass1, id: 9, commit_id: OLD_HEAD, submitted_at: "2026-11-18T15:00:00Z" };
    assert.deepEqual(passFor({ headSha: HEAD, appReviews: [pass1, later], threads: [contestOn(HEAD)], rereview: true }), { pass: 2 });
    // Without the flag the same state is a duplicate review.
    assert.deepEqual(passFor({ headSha: HEAD, appReviews: [pass1], threads: [contestOn(HEAD)], rereview: false }), { refused: "already_reviewed_head" });
  });
  test("UT-033 passFor: rereview without a non-bot reply on H, without pass 1, or after pass 2 → rereview_not_eligible", () => {
    const refused = { refused: "rereview_not_eligible" };
    const uncontested = { ...contestOn(HEAD), comments: contestOn(HEAD).comments.slice(0, 1) };
    const cases: [string, AppReview[], AppThread[]][] = [
      ["no threads", [pass1], []],
      ["bot comment only", [pass1], [uncontested]],
      ["reply by another bot", [pass1], [contestOn(HEAD, "dependabot[bot]")]],
      ["reply on a thread of an old head", [pass1], [contestOn(OLD_HEAD)]],
      ["no pass 1 on the head", [{ ...pass1, commit_id: OLD_HEAD }], [contestOn(HEAD)]],
      ["unmarked app review only", [{ ...pass1, pass: null, submitted_at: "2026-11-18T13:00:00Z" }], [contestOn(HEAD)]],
      ["pass 2 already exists", [pass1, { ...pass1, id: 2, pass: 2 }], [contestOn(HEAD)]],
      ["reply older than pass 1", [{ ...pass1, submitted_at: "2026-11-18T14:00:00Z" }], [contestOn(HEAD)]],
      ["reply at the same instant as pass 1", [{ ...pass1, submitted_at: "2026-11-18T13:20:40Z" }], [contestOn(HEAD)]],
      ["reply older than a later unmarked app review", [pass1, { ...pass1, id: 3, pass: null, submitted_at: "2026-11-18T14:00:00Z" }], [contestOn(HEAD)]],
      ["duplicate pass 1 (concurrent race), reply between them", [{ ...pass1, submitted_at: "2026-11-18T12:00:00Z" }, { ...pass1, id: 2, submitted_at: "2026-11-18T14:00:00Z" }], [contestOn(HEAD)]],
      ["duplicate pass 1, reply after both", [{ ...pass1, submitted_at: "2026-11-18T12:00:00Z" }, { ...pass1, id: 2 }], [contestOn(HEAD)]],
      ["missing submitted_at", [{ ...pass1, submitted_at: "" }], [contestOn(HEAD)]],
    ];
    for (const [name, appReviews, threads] of cases) {
      assert.deepEqual(passFor({ headSha: HEAD, appReviews, threads, rereview: true }), refused, name);
    }
  });
  test("UT-020 marker: first line format and parsePass round trip", () => {
    assert.equal(marker(HEAD, 1), `<!-- github-app-review head=${HEAD} pass=1 -->`);
    assert.equal(parsePass(`${marker(HEAD, 2)}\n\nsummary`), 2);
    assert.equal(parsePass(`summary\n${marker(HEAD, 1)}`), null);
  });
});

const ready = (): PrSnapshot => ({
  state: "open",
  base_ref: "staging",
  head_ref: "feature",
  head_sha: HEAD,
  author: "octocat",
  author_is_app: false,
  reviews: [{ author: BOT, is_app: true, state: "APPROVED", commit_id: HEAD }],
  checks: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }],
  mergeable: "MERGEABLE",
  threads: [{ is_resolved: true }],
  history_complete: true,
});

describe("staging gate", () => {
  test("UT-040 deliveryGate: all BR-7 conditions → ready", () => {
    assert.deepEqual(deliveryGate(ready(), "staging"), { ready: true, head_sha: HEAD, reasons: [] });
    // The delivery branch is configuration (GITHUB_APP_BASE), e.g. main.
    assert.deepEqual(deliveryGate({ ...ready(), base_ref: "main" }, "main").reasons, []);
    assert.deepEqual(deliveryGate(ready(), "main").reasons, ["base_mismatch"]);
    // Pass 1 CHANGES_REQUESTED then pass 2 APPROVE on the same head is ready (latest per author).
    const s = ready();
    s.reviews = [{ author: BOT, is_app: true, state: "CHANGES_REQUESTED", commit_id: HEAD }, ...s.reviews];
    assert.deepEqual(deliveryGate(s, "staging").reasons, []);
    // A later COMMENTED review does not replace an author's effective approval.
    s.reviews.push({ author: BOT, is_app: true, state: "COMMENTED", commit_id: HEAD });
    assert.deepEqual(deliveryGate(s, "staging").reasons, []);
  });
  test("UT-041 deliveryGate: latest app approval on an older commit → approval_not_on_head", () => {
    const s = ready();
    s.reviews = [{ author: BOT, is_app: true, state: "APPROVED", commit_id: OLD_HEAD }];
    assert.deepEqual(deliveryGate(s, "staging").reasons, ["approval_not_on_head"]);
  });
  test("UT-042 deliveryGate: no app review → no_app_approval_on_head; human approval does not count", () => {
    const s = ready();
    s.reviews = [{ author: "someone", is_app: false, state: "APPROVED", commit_id: HEAD }];
    assert.deepEqual(deliveryGate(s, "staging").reasons, ["no_app_approval_on_head"]);
    s.reviews = [{ author: BOT, is_app: true, state: "COMMENTED", commit_id: HEAD }];
    assert.deepEqual(deliveryGate(s, "staging").reasons, ["no_app_approval_on_head"]);
  });
  test("UT-043 deliveryGate: human CHANGES_REQUESTED on head → changes_requested; on an old head it does not", () => {
    const s = ready();
    s.reviews.push({ author: "gitstream-cm[bot]", is_app: false, state: "CHANGES_REQUESTED", commit_id: HEAD });
    assert.deepEqual(deliveryGate(s, "staging").reasons, ["changes_requested"]);
    s.reviews[1]!.commit_id = OLD_HEAD;
    assert.deepEqual(deliveryGate(s, "staging").reasons, []);
    // The app's own CHANGES_REQUESTED on the head: no approval and changes requested.
    s.reviews = [{ author: BOT, is_app: true, state: "CHANGES_REQUESTED", commit_id: HEAD }];
    assert.deepEqual(deliveryGate(s, "staging").reasons, ["no_app_approval_on_head", "changes_requested"]);
  });
  test("UT-044 deliveryGate: in_progress → checks_pending; failure → checks_failed", () => {
    const s = ready();
    s.checks.push({ status: "in_progress", conclusion: null });
    assert.deepEqual(deliveryGate(s, "staging").reasons, ["checks_pending"]);
    s.checks = [{ status: "completed", conclusion: "failure" }];
    assert.deepEqual(deliveryGate(s, "staging").reasons, ["checks_failed"]);
    s.checks = [{ status: "completed", conclusion: "neutral" }];
    assert.deepEqual(deliveryGate(s, "staging").reasons, ["checks_failed"]);
  });
  test("UT-045 deliveryGate: CONFLICTING → not_mergeable; one unresolved thread → unresolved_threads", () => {
    const s = ready();
    s.mergeable = "CONFLICTING";
    assert.deepEqual(deliveryGate(s, "staging").reasons, ["not_mergeable"]);
    s.mergeable = "MERGEABLE";
    s.threads.push({ is_resolved: false });
    assert.deepEqual(deliveryGate(s, "staging").reasons, ["unresolved_threads"]);
  });
  test("UT-046 deliveryGate: every condition failing → one reason each, stable order", () => {
    const s: PrSnapshot = {
      ...ready(),
      state: "closed",
      base_ref: "main",
      reviews: [{ author: "human", is_app: false, state: "CHANGES_REQUESTED", commit_id: HEAD }],
      checks: [{ status: "queued", conclusion: null }, { status: "completed", conclusion: "failure" }],
      mergeable: "CONFLICTING",
      threads: [{ is_resolved: false }],
    };
    const expected = ["pr_not_open", "base_mismatch", "no_app_approval_on_head", "changes_requested", "checks_pending", "checks_failed", "not_mergeable", "unresolved_threads"];
    assert.deepEqual(deliveryGate(s, "staging"), { ready: false, head_sha: HEAD, reasons: expected });
    s.reviews.reverse();
    assert.deepEqual(deliveryGate(s, "staging").reasons, expected);
  });
});
