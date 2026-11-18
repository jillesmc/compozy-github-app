import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { doctorHandler, MAX_OPEN_PRS } from "../src/doctor.ts";
import { marker } from "../src/rules.ts";
import { BOT, HEAD, REPO, review } from "./fixtures.ts";
import { failure, harness } from "./helpers.ts";

const now = Date.parse("2026-11-17T17:05:00Z");

describe("doctor and credentials", () => {
  test("UT-060 doctor: fixtures for app, installation, token, repo → the _dx.md report lines", async () => {
    const h = await harness();
    h.deps.now = () => now;
    h.gh.state.tokenExpiresAt = new Date(now + 59 * 60_000 + 30_000).toISOString();
    const handler = (await import("../src/doctor.ts")).doctorHandler(h.deps);
    const result = (await handler({ input: {} } as never)) as any;
    assert.equal(
      result.content[0].text,
      [
        "app: widgets-reviewer (id 123456)",
        "installation: 7890123 on acme (selected repositories)",
        "token mint: ok (expires in 59m)",
        "repos:",
        "  acme/widgets: ok (pull_requests: write, contents: write, checks: read, statuses: read)",
        "duplicate reviews: none",
        "delivery base: staging",
        "promotion: staging -> main, approvers: octocat",
        "rate limit: 4987/5000 (resets 18:04Z)",
      ].join("\n")
    );
    assert.equal(result.structured.token_mint.ok, true);
    await h.close();
  });

  test("UT-061 credentials: GITHUB_APP_PRIVATE_KEY unset → every tool credential_absent; zero HTTP calls", async () => {
    const h = await harness({ GITHUB_APP_PRIVATE_KEY: undefined });
    const inputs: [string, Record<string, unknown>][] = [
      ["pr_context", { repo: REPO, number: 231 }],
      ["submit_review", { repo: REPO, number: 231 }],
      ["merge_gate", { repo: REPO, number: 231, kind: "delivery" }],
    ];
    for (const [tool, input] of inputs) {
      const error = await failure(h.call(tool, input));
      assert.equal(error.code, "credential_absent");
      assert.equal(error.toolCode, "tool_unavailable");
      assert.equal(error.recovery, "run compozy extension secrets set github-app-review --env GITHUB_APP_PRIVATE_KEY --value-stdin");
    }
    const doctor = await failure(h.call("doctor"));
    assert.equal(doctor.code, "credential_absent");
    assert.equal(
      doctor.message,
      "app: unknown; token mint: failed (credential_absent: run compozy extension secrets set github-app-review --env GITHUB_APP_PRIVATE_KEY --value-stdin)"
    );
    assert.equal(h.fetches(), 0);
    await h.close();
  });

  test("UT-062 credentials: key rejected (401) → doctor token mint: failed (401); tools credential_invalid", async () => {
    const h = await harness();
    h.gh.state.rejectJwt = true;
    const doctor = await failure(h.call("doctor"));
    assert.equal(doctor.code, "credential_invalid");
    assert.equal(doctor.message, "app: unknown; token mint: failed (401)");
    const tool = await failure(h.call("pr_context", { repo: REPO, number: 231 }));
    assert.equal(tool.code, "credential_invalid");
    assert.equal(tool.toolCode, "tool_unavailable");
    await h.close();
  });

  test("UT-063 credentials: allowlisted repo absent from the installation → repo_not_installed; doctor marks it", async () => {
    const h = await harness({ GITHUB_APP_REPOS: `${REPO},acme/missing` });
    const doctor = await h.call("doctor");
    assert.deepEqual(doctor.repos.map((r: any) => `${r.repo}: ${r.status}`), [
      "acme/widgets: ok",
      "acme/missing: not installed",
    ]);
    const error = await failure(h.call("pr_context", { repo: "acme/missing", number: 231 }));
    assert.equal(error.code, "repo_not_installed");
    assert.equal(error.toolCode, "tool_unavailable");
    // The installed repository keeps working.
    assert.equal((await h.call("pr_context", { repo: REPO, number: 231 })).head_sha.length, 40);
    await h.close();
  });

  test("UT-060 doctor: two app reviews with the same pass marker on one head → one duplicate line", async () => {
    const h = await harness();
    h.gh.state.pulls = [h.gh.state.pr];
    h.gh.state.reviews = [
      review(BOT, "APPROVED", HEAD, `${marker(HEAD, 1)}\n\na`, 1),
      review(BOT, "APPROVED", HEAD, `${marker(HEAD, 1)}\n\nb`, 2),
      review(BOT, "APPROVED", HEAD, `${marker(HEAD, 2)}\n\nc`, 3),
      review("octocat", "COMMENTED", HEAD, marker(HEAD, 1), 4),
    ];
    const handler = (await import("../src/doctor.ts")).doctorHandler(h.deps);
    const text: string = ((await handler({ input: {} } as never)) as any).content[0].text;
    assert.match(text, /\nduplicate reviews:\n  acme\/widgets#231 head 9f2c1e0a7b3d pass=1: 2 reviews\ndelivery base: staging\npromotion:/);
    assert.ok(h.gh.requests.some(r => r.path === `/repos/${REPO}/pulls` ));
    await h.close();
  });

  test("UT-060 doctor: more than 200 open PRs → duplicate reviews: incomplete; doctor still succeeds", async () => {
    const h = await harness();
    h.gh.state.pulls = Array.from({ length: MAX_OPEN_PRS + 1 }, (_, i) => ({ ...h.gh.state.pr, number: 1000 + i }));
    const result = (await doctorHandler(h.deps)({ input: {} } as never)) as any;
    assert.match(result.content[0].text, /\nduplicate reviews: incomplete \(more than 200 open PRs\)\ndelivery base: staging\npromotion:/);
    assert.ok(!h.gh.requests.some(r => r.path.endsWith("/reviews")), "no per-PR scan past the cap");
    await h.close();
  });

  test("UT-060 doctor: a scan slower than its budget → duplicate reviews: unknown (scan timed out); exit 0", async () => {
    const h = await harness();
    h.gh.state.pulls = [h.gh.state.pr];
    const fetchFast = h.deps.fetch!;
    h.deps.fetch = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/reviews?per_page=100&page=1")) await new Promise(resolve => setTimeout(resolve, 300));
      return fetchFast(url, init);
    }) as typeof fetch;
    h.deps.doctorScanMs = 50;
    const result = (await doctorHandler(h.deps)({ input: {} } as never)) as any;
    assert.match(result.content[0].text, /\nduplicate reviews: unknown \(scan timed out\)\ndelivery base: staging\npromotion: .*\nrate limit: 4987\/5000/);
    assert.equal(result.structured.token_mint.ok, true);
    await new Promise(resolve => setTimeout(resolve, 350)); // let the abandoned scan settle before closing the fake
    await h.close();
  });

  test("UT-060 doctor: rate limit read through the GitHub client; no raw token in doctor.ts", async () => {
    const h = await harness();
    await h.call("doctor");
    const rate = h.gh.requests.find(r => r.path === "/rate_limit")!;
    assert.match(String(rate.headers.authorization), /^Bearer ghs_/);
    const source = readFileSync(new URL("../src/doctor.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "\.\/http\.ts"|\.token\b|authorization/);
    await h.close();
  });

  test("UT-061 config: GITHUB_APP_BASE unset → credential_absent naming it; zero HTTP calls", async () => {
    const h = await harness({ GITHUB_APP_BASE: undefined });
    const error = await failure(h.call("pr_context", { repo: REPO, number: 231 }));
    assert.equal(error.code, "credential_absent");
    assert.match(error.message, /GITHUB_APP_BASE not set/);
    assert.equal(h.fetches(), 0);
    await h.close();
  });

  test("UT-061 config: GITHUB_APP_PROMOTION must promote GITHUB_APP_BASE into another branch → config_invalid", async () => {
    for (const promotion of [`${REPO}:develop->main`, `${REPO}:staging->staging`, "not a promotion"]) {
      const h = await harness({ GITHUB_APP_PROMOTION: promotion });
      const error = await failure(h.call("merge_gate", { repo: REPO, number: 231, kind: "delivery" }));
      assert.deepEqual([error.code, error.toolCode], ["config_invalid", "tool_unavailable"], promotion);
      assert.match(error.message, /GITHUB_APP_PROMOTION/);
      assert.equal(h.fetches(), 0);
      await h.close();
    }
    // Unset is fine: promotion is optional.
    const h = await harness({ GITHUB_APP_PROMOTION: undefined });
    assert.equal((await h.call("merge_gate", { repo: REPO, number: 231, kind: "delivery" })).head_sha.length, 40);
    await h.close();
  });
});
