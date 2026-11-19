import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { loadConfig, OPTIONAL_ENV, REQUIRED_ENV } from "../src/config.ts";
import { createExtension } from "../src/index.ts";
import { parsePolicy, policyPaths, sha256 } from "../src/policy.ts";
import { HEAD, REPO, review, BOT } from "./fixtures.ts";
import { DEFAULT_POLICY, failure, harness, policyHome, TEST_KEY, TWO_REPOS } from "./helpers.ts";

// factory-roles (ADR-002, BR-15): approved, digest-addressed policy versions. Test IDs are the
// factory-roles `_tests.md` IDs.

const ALL_TOOLS: [string, Record<string, unknown>][] = [
  ["pr_context", { repo: REPO, number: 231 }],
  ["submit_review", { repo: REPO, number: 231, head_sha: HEAD, summary: "s", findings: [] }],
  ["merge_gate", { repo: REPO, number: 231, kind: "delivery" }],
  ["upsert_promotion", { repo: REPO }],
];

const creds = (extra: Record<string, string | undefined>) => ({ GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY: TEST_KEY, ...extra });

describe("factory-roles policy loading", () => {
  test("UT-012 loadConfig: credentials + staged policies/<sha>.toml + GITHUB_APP_POLICY_DIGEST=<sha> → repos from that version", () => {
    const p = policyHome(TWO_REPOS);
    const config = loadConfig(creds({ GITHUB_APP_POLICY_FILE: p.working, GITHUB_APP_POLICY_DIGEST: p.digest }));
    assert.deepEqual(Object.keys(config).sort(), ["apiUrl", "appId", "installationId", "policy", "privateKey"]);
    assert.equal(config.policy.digest, p.digest);
    assert.equal(config.policy.path, p.version);
    assert.deepEqual([...config.policy.repos.values()], [
      { repo: "acme/widgets", delivery_base: "staging", promotion: { head: "staging", base: "main" }, approvers: ["octocat"] },
      { repo: "acme/gadgets", delivery_base: "develop", promotion: { head: "develop", base: "release/1.x" }, approvers: ["octocat", "hubot"] },
    ]);
    // Passed immutably through the call.
    assert.ok(Object.isFrozen(config.policy) && Object.isFrozen(config.policy.repos.get("acme/gadgets")));
    p.remove();
  });

  test("UT-012 policyPaths: GITHUB_APP_POLICY_FILE, else $XDG_CONFIG_HOME, else ~/.config; versions in the sibling policies/", () => {
    assert.deepEqual(policyPaths({ HOME: "/home/user" }), { working: "/home/user/.config/compozy-github-app/policy.toml", versions: "/home/user/.config/compozy-github-app/policies" });
    assert.equal(policyPaths({ HOME: "/home/user", XDG_CONFIG_HOME: "/home/user/xdg" }).working, "/home/user/xdg/compozy-github-app/policy.toml");
    assert.equal(policyPaths({ HOME: "/home/user", XDG_CONFIG_HOME: "relative" }).working, "/home/user/.config/compozy-github-app/policy.toml");
    assert.deepEqual(policyPaths({ HOME: "/home/user", GITHUB_APP_POLICY_FILE: "/srv/p/policy.toml" }), { working: "/srv/p/policy.toml", versions: "/srv/p/policies" });
    // G-5: a relative GITHUB_APP_POLICY_FILE is refused; a relative HOME falls back to os.homedir().
    for (const file of ["policy.toml", "./p/policy.toml"]) {
      assert.throws(() => policyPaths({ HOME: "/home/user", GITHUB_APP_POLICY_FILE: file }), (error: any) => error.code === "config_invalid" && error.message === "GITHUB_APP_POLICY_FILE must be an absolute path");
    }
    assert.equal(policyPaths({ HOME: "rel" }).working, join(homedir(), ".config", "compozy-github-app", "policy.toml"));
  });

  test("UT-020 env: REQUIRED_ENV is the three credentials; digest and file optional in requires_env; removed keys neither declared nor read", async () => {
    assert.deepEqual([...REQUIRED_ENV], ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"]);
    assert.deepEqual([...OPTIONAL_ENV], ["GITHUB_APP_POLICY_DIGEST", "GITHUB_APP_POLICY_FILE"]);
    assert.deepEqual([...createExtension().describe().requires_env!].sort(), [...REQUIRED_ENV, ...OPTIONAL_ENV].sort());
    const removed = /GITHUB_APP_(REPOS|BASE|PROMOTION|PROMOTION_APPROVERS)\b/;
    for (const file of readdirSync(new URL("../src", import.meta.url), { recursive: true }) as string[]) {
      if (file.endsWith(".ts")) assert.doesNotMatch(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), removed, file);
    }
    // Old values in the environment change nothing: the policy alone decides.
    const h = await harness({ GITHUB_APP_REPOS: "acme/other", GITHUB_APP_BASE: "main", GITHUB_APP_PROMOTION: "acme/other:main->x", GITHUB_APP_PROMOTION_APPROVERS: "mallory" });
    h.gh.state.reviews = [review(BOT, "APPROVED", HEAD)];
    assert.deepEqual(await h.call("merge_gate", { repo: REPO, number: 231, kind: "delivery" }), { ready: true, head_sha: HEAD, reasons: [] });
    assert.equal((await failure(h.call("pr_context", { repo: "acme/other", number: 1 }))).code, "repo_not_allowed");
    await h.close();
  });

  test("UT-013 every tool: repo absent from the approved policy → repo_not_allowed; no HTTP request", async () => {
    const h = await harness();
    for (const [tool, input] of ALL_TOOLS) {
      const error = await failure(h.call(tool, { ...input, repo: "acme/other" }));
      assert.deepEqual([error.code, error.toolCode], ["repo_not_allowed", "tool_invalid_input"], tool);
      assert.equal(error.message, "acme/other is not in the approved policy");
    }
    assert.equal(h.fetches(), 0);
    await h.close();
  });

  test("UT-014 approved but malformed or unreadable version → config_invalid naming the path; no HTTP request", async () => {
    const bad = 'repos = "acme/widgets"\n';
    const h = await harness({}, bad);
    for (const [tool, input] of ALL_TOOLS) {
      const error = await failure(h.call(tool, input));
      assert.deepEqual([error.code, error.toolCode], ["config_invalid", "tool_unavailable"], tool);
      assert.equal(error.message, `${h.policy.version}:1: key outside a [repos."owner/name"] table`);
    }
    const nonUtf8 = Buffer.from([0x5b, 0xff, 0x5d]);
    const n = await harness({ GITHUB_APP_POLICY_DIGEST: sha256(nonUtf8) });
    mkdirSync(join(n.policy.dir, "policies"), { recursive: true });
    writeFileSync(join(n.policy.dir, "policies", `${sha256(nonUtf8)}.toml`), nonUtf8);
    assert.match((await failure(n.call("pr_context", { repo: REPO, number: 231 }))).message, /\.toml: not valid UTF-8$/);
    // G-4: a UTF-8 BOM is refused, not stripped.
    const bom = Buffer.from(`\uFEFF${DEFAULT_POLICY}`);
    writeFileSync(join(n.policy.dir, "policies", `${sha256(bom)}.toml`), bom);
    n.deps.env.GITHUB_APP_POLICY_DIGEST = sha256(bom);
    assert.match((await failure(n.call("pr_context", { repo: REPO, number: 231 }))).message, /\.toml: byte order mark \(BOM\) not allowed$/);
    // Unreadable (a directory where the version file should be).
    const digest = "a".repeat(64);
    mkdirSync(join(n.policy.dir, "policies", `${digest}.toml`));
    n.deps.env.GITHUB_APP_POLICY_DIGEST = digest;
    const unreadable = await failure(n.call("pr_context", { repo: REPO, number: 231 }));
    assert.equal(unreadable.code, "config_invalid");
    assert.equal(unreadable.message, `${join(n.policy.dir, "policies", `${digest}.toml`)} is unreadable (EISDIR)`);
    assert.equal(h.fetches() + n.fetches(), 0);
    await h.close();
    await n.close();
  });

  test("UT-014 parsePolicy: the documented subset only; each deviation → config_invalid with path and line", () => {
    const cases: [string, string][] = [
      ['delivery_base = "main"', ':1: key outside a [repos."owner/name"] table'],
      ['[repos]\n', ':1: only [repos."owner/name"] tables are allowed'],
      ['[repos."acme"]\ndelivery_base = "main"', ':1: repos."acme": expected owner/name'],
      ['[repos."a/b"]\ndelivery_base = "main"\n[repos."A/B"]\ndelivery_base = "main"', ':3: repos."A/B": duplicate repository'],
      ['[repos."a/b"]\ndelivery_base = "main"\ndelivery_base = "dev"', ":3: duplicate key delivery_base"],
      ['[repos."a/b"]\ndelivery_base = main', ":2: expected a quoted string"],
      ['[repos."a/b"]\ndelivery_base = "ma\\"in"', ":2: escapes are not supported"],
      ['[repos."a/b"]\ndelivery_base = "main" x', ":2: unexpected text after value"],
      ['[repos."a/b"]\ndelivery_base = "main', ":2: unterminated string"],
      ['[repos."a/b"]\ndelivery_base', ":2: expected key = value"],
      ['[repos."a/b"]\napprovers = ["a" "b"]', ":2: expected , or ] in array"],
      ['[repos."a/b"]\npromotion = { head = "a", }', ":2: trailing comma in inline table"],
      ['[repos."a/b"]\npromotion = { head = "a", head = "b" }', ":2: duplicate key head"],
      ['[repos."a/b"]\npromotion = { head "a" }', ":2: expected = in inline table"],
      ['[repos."a/b"]\nbase = "main"', ':1: repos."a/b": unknown key base'],
      ['[repos."a/b"]\n', ':1: repos."a/b": delivery_base must be a branch name ([A-Za-z0-9._/-]+)'],
      ['[repos."a/b"]\ndelivery_base = "has space"', ':1: repos."a/b": delivery_base must be a branch name ([A-Za-z0-9._/-]+)'],
      ['[repos."a/b"]\ndelivery_base = ["main"]', ':1: repos."a/b": delivery_base must be a branch name ([A-Za-z0-9._/-]+)'],
      ['[repos."a/b"]\ndelivery_base = "main"\npromotion = "main->x"', ':1: repos."a/b": promotion must be { head = "…", base = "…" }'],
      ['[repos."a/b"]\ndelivery_base = "main"\npromotion = { head = "main" }', ':1: repos."a/b": promotion must be { head = "…", base = "…" }'],
      ['[repos."a/b"]\ndelivery_base = "main"\napprovers = "octocat"', ':1: repos."a/b": approvers must be an array of GitHub logins'],
      ['[repos."a/b"]\ndelivery_base = "main"\napprovers = ["octo cat"]', ':1: repos."a/b": approvers must be an array of GitHub logins'],
      ['[repos."a/b"]\ndelivery_base = "ma\u0001in"', ':2: control character'],
      // G-4: TOML whitespace is space and tab only.
      ['[repos ."a/b"]\ndelivery_base = "main"', ':1: only [repos."owner/name"] tables are allowed'],
      ['[repos."a/b"]\n\u00a0delivery_base = "main"', ":2: expected key = value"],
      ['[repos."a/b"]\ndelivery_base = "main"\u2028', ":2: unexpected text after value"],
      ['[repos."a/b"]\u2028\ndelivery_base = "main"', ':1: only [repos."owner/name"] tables are allowed'],
    ];
    for (const [text, expected] of cases) {
      assert.throws(() => parsePolicy(text, "/p.toml"), (error: any) => error.code === "config_invalid" && error.message === `/p.toml${expected}`, text);
    }
    // CRLF, comments, blank lines, single quotes, spaces around = and an empty policy are accepted.
    assert.equal(parsePolicy('\r\n# c\r\n[repos."a/b"] # c\r\n  delivery_base\t=  "main"  # c\r\n', "/p.toml").get("a/b")!.delivery_base, "main");
    assert.equal(parsePolicy("# nothing yet\n", "/p.toml").size, 0);
  });

  test("UT-015 promotion without approvers (or not from delivery_base) → config_invalid", () => {
    const promo = (rest: string) => `[repos."a/b"]\ndelivery_base = "staging"\n${rest}`;
    const cases: [string, string][] = [
      [promo('promotion = { head = "staging", base = "main" }'), "approvers are required when promotion is set"],
      [promo('promotion = { head = "staging", base = "main" }\napprovers = []'), "approvers are required when promotion is set"],
      [promo('promotion = { head = "develop", base = "main" }\napprovers = ["octocat"]'), "promotion.head must equal delivery_base (staging)"],
      [promo('promotion = { head = "staging", base = "staging" }\napprovers = ["octocat"]'), "promotion.base must differ from delivery_base"],
    ];
    for (const [text, expected] of cases) {
      assert.throws(() => parsePolicy(text, "/p.toml"), (error: any) => error.code === "config_invalid" && error.message === `/p.toml:1: repos."a/b": ${expected}`, text);
    }
    // Approvers without promotion are allowed (unused).
    assert.equal(parsePolicy(promo('approvers = ["octocat"]'), "/p.toml").get("a/b")!.promotion, null);
  });

  test("UT-016 merge_gate kind=delivery: each repo gates on its own delivery_base", async () => {
    const h = await harness({}, TWO_REPOS);
    h.gh.state.installedRepos = ["widgets", "gadgets"];
    const gate = async (repo: string, base: string) => {
      h.gh.state.repo = repo;
      h.gh.state.pr.base = { ref: base, repo: { default_branch: "main" } };
      h.gh.state.reviews = [review(BOT, "APPROVED", HEAD)];
      return (await h.call("merge_gate", { repo, number: 231, kind: "delivery" })).reasons;
    };
    assert.deepEqual(await gate("acme/widgets", "staging"), []);
    assert.deepEqual(await gate("acme/gadgets", "staging"), ["base_mismatch"]);
    assert.deepEqual(await gate("acme/gadgets", "develop"), []);
    assert.deepEqual(await gate("acme/widgets", "develop"), ["base_mismatch"]);
    await h.close();
  });
});

describe("factory-roles policy approval (BR-15)", () => {
  test("UT-038 staged version but GITHUB_APP_POLICY_DIGEST unset → policy_unapproved for every tool; zero HTTP requests", async () => {
    for (const digest of [undefined, "", "not-a-digest", "A".repeat(64)]) {
      const h = await harness({ GITHUB_APP_POLICY_DIGEST: digest });
      for (const [tool, input] of ALL_TOOLS) {
        const error = await failure(h.call(tool, input));
        assert.deepEqual([error.code, error.toolCode], ["policy_unapproved", "tool_unavailable"], `${tool} ${digest}`);
        assert.match(error.recovery, /--cmd policy-stage, then set GITHUB_APP_POLICY_DIGEST/);
      }
      assert.equal(h.fetches(), 0);
      assert.equal(h.gh.requests.length, 0);
      await h.close();
    }
  });

  test("UT-039 file edited after approval (repo added) → policy_unapproved for every tool, the new repo too; zero HTTP requests", async () => {
    const h = await harness();
    chmodSync(h.policy.version, 0o644);
    writeFileSync(h.policy.version, `${DEFAULT_POLICY}\n[repos."acme/other"]\ndelivery_base = "main"\n`);
    for (const repo of [REPO, "acme/other"]) {
      for (const [tool, input] of ALL_TOOLS) {
        const error = await failure(h.call(tool, { ...input, repo }));
        assert.equal(error.code, "policy_unapproved", `${tool} ${repo}`);
        assert.equal(error.message, `${h.policy.version} does not hash to GITHUB_APP_POLICY_DIGEST`);
      }
    }
    // The approved digest of a version that is gone is not a fallback to anything else.
    const missing = await harness({ GITHUB_APP_POLICY_DIGEST: "b".repeat(64) });
    assert.match((await failure(missing.call("pr_context", { repo: REPO, number: 231 }))).message, /policies\/b{64}\.toml does not exist$/);
    assert.equal(h.gh.requests.length + missing.gh.requests.length, 0);
    await h.close();
    await missing.close();
  });

  test("UT-040 bytes hash to the digest → tools resolve the repo's branches; --cmd policy reports it active", async () => {
    const h = await harness();
    h.gh.state.reviews = [review(BOT, "APPROVED", HEAD)];
    assert.deepEqual(await h.call("merge_gate", { repo: REPO, number: 231, kind: "delivery" }), { ready: true, head_sha: HEAD, reasons: [] });
    const status = await h.call("policy");
    assert.equal(status.active.state, "approved");
    assert.equal(status.active.digest, h.policy.digest);
    assert.equal(status.working_active, true);
    assert.deepEqual(status.repos, { added: [], removed: [], changed: [] });
    await h.close();
  });

  test("UT-054 the version is read once: replaced after the read, the call uses the buffer it hashed", async () => {
    const h = await harness();
    h.gh.state.reviews = [review(BOT, "APPROVED", HEAD)];
    const reads: string[] = [];
    h.deps.readFile = path => {
      const bytes = readFileSync(path);
      reads.push(path);
      chmodSync(path, 0o644);
      writeFileSync(path, `[repos."${REPO}"]\ndelivery_base = "main"\n`); // other bytes, after the read
      return bytes;
    };
    assert.deepEqual((await h.call("merge_gate", { repo: REPO, number: 231, kind: "delivery" })).reasons, []);
    assert.deepEqual(reads, [h.policy.version]);
    // The next call reads the replaced bytes, which parse but do not hash to the digest.
    h.deps.readFile = undefined;
    assert.equal((await failure(h.call("merge_gate", { repo: REPO, number: 231, kind: "delivery" }))).code, "policy_unapproved");
    await h.close();
  });
});
