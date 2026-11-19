import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { sha256 } from "../src/policy.ts";
import { failure, harness, TWO_REPOS } from "./helpers.ts";

// factory-roles BR-15 / N2: operator commands, exempt from approval; no credentials, no network.
describe("factory-roles operator commands policy and policy-stage (N2)", () => {
  test("UT-053 digest unset, working copy present → policy shows the working digest and active unset; policy-stage writes once", async () => {
    const h = await harness({ GITHUB_APP_POLICY_DIGEST: undefined, GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined });
    h.policy.remove();
    mkdirSync(h.policy.dir);
    writeFileSync(h.policy.working, TWO_REPOS);
    const digest = sha256(Buffer.from(TWO_REPOS));
    const version = join(h.policy.dir, "policies", `${digest}.toml`);
    const status = await h.call("policy");
    assert.deepEqual(status, {
      working: { path: h.policy.working, digest, error: null },
      active: { digest: null, path: null, state: "unset", error: null },
      working_staged: false,
      working_active: false,
      repos: { added: ["acme/widgets", "acme/gadgets"], removed: [], changed: [] },
    });
    const staged = await h.call("policy-stage");
    const activate = `printf ${digest} | compozy extension secrets set github-app-review --env GITHUB_APP_POLICY_DIGEST --value-stdin`;
    assert.deepEqual(staged, { status: "staged", digest, path: version, activate });
    assert.ok(readFileSync(version).equals(Buffer.from(TWO_REPOS)), "byte copy of the working copy");
    assert.equal(statSync(version).mode & 0o777, 0o444);
    assert.deepEqual(await h.call("policy-stage"), { status: "unchanged", digest, path: version, activate });
    assert.equal((await h.call("policy")).working_staged, true);
    // Activate it: tools now serve it; policy reports it active.
    h.deps.env.GITHUB_APP_POLICY_DIGEST = digest;
    const active = await h.call("policy");
    assert.deepEqual([active.active.state, active.working_active], ["approved", true]);
    assert.deepEqual((await h.call("policy-stage")).activate, null);
    assert.equal(h.fetches(), 0);
    assert.equal(h.gh.requests.length, 0);
    // One log line per command, codes only.
    assert.equal(h.lines.length, 6);
    for (const line of h.lines) assert.match(line, /^github-app-review: tool=policy(-stage)? outcome=ok\n$/);
    await h.close();
  });

  test("UT-053 policy text: working, active, state and repo diff lines", async () => {
    const h = await harness();
    chmodSync(h.policy.working, 0o644);
    writeFileSync(h.policy.working, TWO_REPOS.replace('approvers = ["octocat"]', 'approvers = ["hubot"]'));
    const handler = (await import("../src/policy-cmd.ts")).policyHandler("policy", h.deps);
    const text: string = ((await handler({ input: {} } as never)) as any).content[0].text;
    const digest = sha256(readFileSync(h.policy.working));
    assert.equal(text, [
      `working   ${h.policy.working}  digest ${digest}`,
      `active    ${h.policy.digest} (policies/${h.policy.digest}.toml)`,
      "state     not staged; run compozy extension exec github-app-review --cmd policy-stage",
      "repos     + acme/gadgets",
      "repos     ~ acme/widgets",
    ].join("\n"));
    await h.close();
  });

  test("UT-053 G-7 policy: a relative GITHUB_APP_POLICY_FILE is reported in working.error, never thrown", async () => {
    const h = await harness({ GITHUB_APP_POLICY_FILE: "rel/policy.toml" });
    const status = await h.call("policy");
    assert.deepEqual(status.working, { path: "rel/policy.toml", digest: null, error: "config_invalid: GITHUB_APP_POLICY_FILE must be an absolute path" });
    assert.equal(status.active.state, "invalid");
    assert.equal((await failure(h.call("policy-stage"))).code, "config_invalid");
    assert.equal(h.fetches(), 0);
    await h.close();
  });

  test("UT-053 G-3 policy-stage: a stale temp file → config_invalid, temp removed, nothing staged; the next run stages", async () => {
    const h = await harness({ GITHUB_APP_POLICY_DIGEST: undefined });
    chmodSync(h.policy.working, 0o644);
    writeFileSync(h.policy.working, TWO_REPOS);
    const digest = sha256(Buffer.from(TWO_REPOS));
    const version = join(h.policy.dir, "policies", `${digest}.toml`);
    const tmp = `${version}.${process.pid}.tmp`;
    writeFileSync(tmp, "stale");
    const error = await failure(h.call("policy-stage"));
    assert.deepEqual([error.code, error.message], ["config_invalid", `${version} could not be written (EEXIST)`]);
    assert.ok(!existsSync(tmp) && !existsSync(version));
    assert.equal((await h.call("policy-stage")).status, "staged");
    assert.ok(readFileSync(version).equals(Buffer.from(TWO_REPOS)));
    await h.close();
  });

  test("UT-053 policy-stage: invalid or missing working copy → config_invalid, nothing written; policy reports the error", async () => {
    const h = await harness({ GITHUB_APP_POLICY_DIGEST: undefined }, '[repos."a/b"]\n');
    const before = readdirSync(join(h.policy.dir, "policies"));
    const error = await failure(h.call("policy-stage"));
    assert.deepEqual([error.code, error.message], ["config_invalid", `${h.policy.working}:1: repos."a/b": delivery_base must be a branch name ([A-Za-z0-9._/-]+)`]);
    assert.deepEqual(readdirSync(join(h.policy.dir, "policies")), before);
    assert.match((await h.call("policy")).working.error, /^config_invalid: .*delivery_base must be a branch name/);
    const gone = await harness({ GITHUB_APP_POLICY_FILE: join(h.policy.dir, "absent.toml") });
    assert.equal((await failure(gone.call("policy-stage"))).message, `${join(h.policy.dir, "absent.toml")} does not exist`);
    assert.ok(!existsSync(join(h.policy.dir, "absent.toml")));
    assert.equal(h.fetches() + gone.fetches(), 0);
    await h.close();
    await gone.close();
  });
});
