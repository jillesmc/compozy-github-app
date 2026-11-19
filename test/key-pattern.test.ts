import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { closedIssues, includedKeys, isIssueKey, KEY_BUDGET_MS, keyMatcher, keyPattern, MAX_KEY_CANDIDATES, promotionTitle } from "../src/tools/upsert_promotion.ts";
import { PROMO_HEAD, pull, REPO } from "./fixtures.ts";
import { failure, harness } from "./helpers.ts";

// factory-roles OQ-2: `upsert_promotion` `key_pattern` (Jira default; `#<n>` from the closing keywords).
const DEVELOP = `[repos."${REPO}"]\ndelivery_base = "develop"\npromotion = { head = "develop", base = "main" }\napprovers = ["octocat"]\n`;
const commit = (sha: string, message: string) => ({ sha, commit: { message } });

let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness({}, DEVELOP);
  h.gh.state.compare = {
    total_commits: 3,
    commits: [commit("a1", "WID-1: x (#231)"), commit("a2", "Merge pull request #233 from acme/WID-2-y\n\nFixes #77"), commit(PROMO_HEAD, "chore: tidy")],
  };
  h.gh.state.pr.body = "Closes #194";
  h.gh.state.pulls = [{ ...pull(233, "octocat", "WID-2-y", "develop"), state: "closed", body: "Fixes #205\nRefs #9" }];
});
afterEach(async () => {
  await h.close();
});
const title = () => h.gh.requests.find(r => r.method === "POST" && r.path.endsWith("/pulls"))!.body.title;
const prReads = () => h.gh.requests.filter(r => r.method === "GET" && /\/pulls\/\d+$/.test(r.path)).map(r => r.path);

describe("upsert_promotion key_pattern", () => {
  test("UT-024 without key_pattern: Jira keys from the commit subjects → WID-1, WID-2: Promote develop to main (default unchanged)", async () => {
    const out = await h.call("upsert_promotion", { repo: REPO });
    assert.deepEqual(out.included_prs, [231, 233]);
    assert.equal(title(), "WID-1, WID-2: Promote develop to main");
    assert.deepEqual(prReads(), [], "no PR body is read for subject keys");
  });

  test("UT-024 the Jira key_format regex passed explicitly gives the default title", async () => {
    await h.call("upsert_promotion", { repo: REPO, key_pattern: "^[A-Z][A-Z0-9]+-\\d+$" });
    assert.equal(title(), "WID-1, WID-2: Promote develop to main");
  });

  test("UT-032 key_pattern for #<n>: issues the included PRs close → #194, #205: Promote develop to main", async () => {
    const out = await h.call("upsert_promotion", { repo: REPO, key_pattern: "^#\\d+$" });
    assert.deepEqual(out.included_prs, [231, 233]);
    assert.equal(title(), "#194, #205: Promote develop to main");
    assert.deepEqual(prReads(), [`/repos/${REPO}/pulls/231`, `/repos/${REPO}/pulls/233`], "one GET per included PR");
    // #231/#233 (PR numbers), #9 (not a closing keyword) and #77 (commit message, not the PR body) are not keys.
    assert.doesNotMatch(title(), /#231|#233|#9\b|#77/);
  });

  test("UT-033 key_pattern for #<n>: a PR without a closing keyword adds nothing; none at all → plain title", async () => {
    h.gh.state.pr.body = "Implements the export.\n\nRefs #194";
    await h.call("upsert_promotion", { repo: REPO, key_pattern: "^#[0-9]+$" });
    assert.equal(title(), "#205: Promote develop to main");
    h.gh.requests = [];
    h.gh.state.pulls[0].body = null;
    h.gh.state.pulls = [h.gh.state.pulls[0]];
    await h.call("upsert_promotion", { repo: REPO, key_pattern: "^#[0-9]+$" });
    assert.equal(title(), "Promote develop to main");
  });

  test("UT-033 key_pattern for #<n>: an included number that is not a PR (404) adds no key", async () => {
    h.gh.state.pulls = [];
    await h.call("upsert_promotion", { repo: REPO, key_pattern: "^#\\d+$" });
    assert.equal(title(), "#194: Promote develop to main");
  });

  test("UT-032 invalid key_pattern → invalid_input before any HTTP call", async () => {
    for (const key_pattern of ["(", "", "x".repeat(201), 5]) {
      const error = await failure(h.call("upsert_promotion", { repo: REPO, key_pattern }));
      assert.equal(error.code, "invalid_input", String(key_pattern));
    }
    assert.equal(h.fetches(), 0);
  });

  test("UT-032 G-1 a nested-quantifier key_pattern never runs on long subjects: ^(a+)+$ finishes fast, no key", () => {
    const subjects = [`${"a".repeat(60)}!: x (#1)`, `Merge pull request #2 from acme/${"a".repeat(60)}!-y`, `${"a".repeat(40)}: z (#3)`];
    const started = performance.now();
    const keys = includedKeys(subjects.map(message => ({ commit: { message } })), keyPattern("^(a+)+$")!);
    assert.ok(performance.now() - started < 1000, "bounded backtracking");
    assert.deepEqual(keys, []);
    // Default and #<n> behaviour unchanged.
    assert.deepEqual(includedKeys([{ commit: { message: "WID-18120: export (#231)" } }]), ["WID-18120"]);
    assert.ok(isIssueKey(keyPattern("^#\\d+$")!));
  });

  test("UT-032 G-1 a filter-passing 20-char candidate with ^(a+)+$ finishes < 1 s; repeats run once", () => {
    const evil = keyPattern("^(a+)+$")!;
    let runs = 0;
    const counting = new RegExp(evil.source);
    const exec = counting.exec.bind(counting);
    counting.exec = (text: string) => (runs++, exec(text));
    const subject = `${"a".repeat(19)}_: x`; // 20 characters before ':', passes the candidate filter
    const started = performance.now();
    assert.deepEqual(includedKeys(Array(50).fill({ commit: { message: subject } }), counting), []);
    assert.ok(performance.now() - started < 1000, "bounded");
    assert.equal(runs, 1, "a repeated candidate is matched once");
  });

  test("UT-032 G-1 many distinct candidates stop at the per-call budget → plain title", () => {
    const evil = keyPattern("^(a+)+$")!;
    const commits = Array.from({ length: 400 }, (_, i) => ({ commit: { message: `${"a".repeat(14)}${String(i).padStart(4, "0")}_: x` } }));
    const started = performance.now();
    const keys = includedKeys(commits, evil);
    assert.ok(performance.now() - started < KEY_BUDGET_MS + 1000, "stops near the time budget");
    assert.equal(promotionTitle("develop", "main", keys), "Promote develop to main");
    // The candidate budget, with a cheap pattern and a frozen clock.
    const many = Array.from({ length: MAX_KEY_CANDIDATES + 1 }, (_, i) => ({ commit: { message: `K-${i}: x` } }));
    const match = keyMatcher(keyPattern("^K-\\d+$")!, () => 0);
    assert.deepEqual(includedKeys(many, undefined, match), []);
    assert.equal(match.exhausted, true);
    assert.equal(includedKeys(many.slice(0, MAX_KEY_CANDIDATES), keyPattern("^K-\\d+$")!).length, MAX_KEY_CANDIDATES);
    // The built-in Jira default has no budget.
    assert.equal(includedKeys(Array.from({ length: 600 }, (_, i) => ({ commit: { message: `WID-${i}: x` } }))).length, 600);
  });

  test("UT-032 G-8 the budget counts regex time only: 300 ms between candidates keeps #194, #205; a slow regex still exhausts", () => {
    let t = 0;
    const waiting = keyMatcher(keyPattern("^#\\d+$")!, () => t);
    for (const issue of ["#194", "#205"]) {
      t += 300; // simulated GET pulls/{n} latency, outside test()
      assert.equal(waiting.test(issue), true, issue);
    }
    assert.equal(waiting.exhausted, false);
    let clock = 0;
    const slow = keyMatcher(keyPattern("^#\\d+$")!, () => (clock += 100)); // every run measures 100 ms
    assert.deepEqual(["#1", "#2", "#3", "#4"].map(k => slow.test(k)), [true, true, true, false]);
    assert.equal(slow.exhausted, true);
  });

  test("UT-032 G-8 upsert_promotion with slow PR reads (300 ms each) keeps the #<n> keys", async () => {
    const fast = h.deps.fetch!;
    h.deps.fetch = (async (url: string, init: RequestInit) => {
      if (/\/pulls\/\d+$/.test(new URL(url).pathname)) await new Promise(resolve => setTimeout(resolve, 300));
      return fast(url, init);
    }) as typeof fetch;
    await h.call("upsert_promotion", { repo: REPO, key_pattern: "^#\\d+$" });
    assert.equal(title(), "#194, #205: Promote develop to main");
  });

  test("UT-032 G-1 valid keys still pass the candidate filter: ACME-123, ABCDEFGHIJ-1234567, WID-2, #194/#205", () => {
    const jira = keyPattern("^[A-Z][A-Z0-9]+-\\d+$")!;
    const subjects = ["ACME-123: a (#1)", "ABCDEFGHIJ-1234567: b (#2)", "Merge pull request #3 from acme/WID-2-y"];
    assert.deepEqual(includedKeys(subjects.map(message => ({ commit: { message } })), jira), ["ACME-123", "ABCDEFGHIJ-1234567", "WID-2"]);
    const issue = keyPattern("^#\\d+$")!;
    const match = keyMatcher(issue);
    assert.deepEqual(closedIssues("Closes #194\nFixes #205").filter(k => match.test(k)), ["#194", "#205"]);
  });

  test("UT-032 closedIssues, isIssueKey and includedKeys: closing keywords, whole-key matches", () => {
    assert.deepEqual(closedIssues("Closes #1, fixed #2. RESOLVES: #3\nclose #4 fix #5 resolved #6 Refs #7 acme/x#8 closes acme/y#9 prefix#10"), ["#1", "#2", "#3", "#4", "#5", "#6"]);
    assert.ok(isIssueKey(keyPattern("^#\\d+$")!));
    assert.ok(!isIssueKey(keyPattern("^[A-Z][A-Z0-9]+-\\d+$")!));
    assert.ok(!isIssueKey(keyPattern("#1")!), "matches #1 but not #205");
    const subjects = ["ENG-12: a (#1)", "Merge pull request #2 from acme/ENG-34-b", "Merge pull request #3 from acme/feature/ENG-5-c", "ENG-6x: d"];
    assert.deepEqual(includedKeys(subjects.map(message => ({ commit: { message } })), keyPattern("ENG-\\d+")!), ["ENG-12", "ENG-34"]);
    assert.equal(keyPattern(undefined), null);
  });
});
