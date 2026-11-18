/**
 * IT-001, IT-002, IT-003, IT-004, IT-005, IT-006 through a real, ISOLATED CompozyOS daemon (scripts/it-env.sh) and the
 * fake GitHub (bun test/fake-github.ts --port 8790). Prerequisites (README › Development): isolated
 * daemon started, workspace $IT_WS registered, `bun scripts/it-setup.ts` run. IT-006 unsets the key last.
 * Usage: bun scripts/it.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import { marker } from "../src/rules.ts";
import { BOT, dxInput, HEAD, OLD_HEAD, PROMO_HEAD, REPO, SLUG, threadNode } from "../test/fixtures.ts";

const FAKE = process.env.FAKE_URL ?? "http://127.0.0.1:8790";
const WS = process.env.IT_WS ?? "/tmp/ghar-it/ws";
const ENV = new URL("./it-env.sh", import.meta.url).pathname;

// Production grants the mutating tools through each agent's `tools:` allowlist, with only
// `tools.policy.trusted_sources` set (trusted sources alone pass read-only tools). The ITs call
// as this test agent so they run under that same policy.
const AGENT = "it-reviewer";
mkdirSync(`${WS}/.compozy/agents/${AGENT}`, { recursive: true });
writeFileSync(`${WS}/.compozy/agents/${AGENT}/AGENT.md`, `---
name: ${AGENT}
display_name: IT reviewer
description: Test-only agent whose tool allowlist grants the github-app-review tools in the isolated IT home.
kind: on_demand
provider: claude
permissions: approve-all
tools:
${["pr_context", "submit_review", "merge_gate", "upsert_promotion"].map(t => `  - ext__github_app_review__${t}`).join("\n")}
---

Test-only; never started as a session.
`);

function compozy(args: string[], input?: string) {
  const run = spawnSync(ENV, args, { cwd: WS, encoding: "utf8", ...(input ? { input } : {}) });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
const invoke = (tool: string, input: unknown) =>
  compozy(["tool", "invoke", `ext__github_app_review__${tool}`, "--workspace", WS, "--agent", AGENT, "--input", JSON.stringify(input), "-o", "json"]);
const fake = async (path: string, body?: unknown) =>
  (await fetch(`${FAKE}${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
const posts = async () => (await fake("/_fake/requests")).filter((r: any) => r.method === "POST" && r.path.endsWith("/reviews"));
const report = (id: string, line: string) => process.stdout.write(`${id}: ${line}\n`);

// IT-001: the _dx.md input → one review POST, one inline comment, README finding in the body.
await fake("/_fake/reset");
const it1 = invoke("submit_review", dxInput());
report("IT-001", `exit ${it1.status}`);
assert.equal(it1.status, 0, it1.stderr);
const result = JSON.parse(it1.stdout).result.structured;
assert.deepEqual(Object.keys(result), ["review_id", "event", "pass", "inline", "moved_to_summary", "url"]);
assert.equal(result.event, "REQUEST_CHANGES");
assert.equal(result.pass, 1);
assert.equal(result.inline, 1);
assert.deepEqual(result.moved_to_summary, [{ path: "apps/reports/README.md", line: 3, reason: "not_in_diff" }]);
const [post] = await posts();
assert.equal((await posts()).length, 1);
assert.equal(post.body.commit_id, HEAD);
assert.equal(post.body.comments.length, 1);
assert.match(post.body.body, /Outside the diff[\s\S]*apps\/reports\/README\.md:3/);
report("IT-001", `ok ${JSON.stringify(result)}`);

// Policy: without an agent allowlist, trusted_sources alone refuses the mutating tool (no POST) and
// passes the read-only merge_gate.
await fake("/_fake/reset");
const bare = compozy(["tool", "invoke", "ext__github_app_review__submit_review", "--workspace", WS, "--input", JSON.stringify(dxInput()), "-o", "json"]);
assert.notEqual(bare.status, 0);
assert.match(bare.stdout + bare.stderr, /tool_denied/);
assert.equal((await posts()).length, 0);
const bareGate = compozy(["tool", "invoke", "ext__github_app_review__merge_gate", "--workspace", WS, "--input", JSON.stringify({ repo: REPO, number: 231, kind: "delivery" }), "-o", "json"]);
assert.equal(bareGate.status, 0, bareGate.stderr);
report("IT-001", "policy ok (no agent: submit_review tool_denied, no POST; merge_gate allowed)");

// IT-002: stale head_sha → non-zero exit, Cause head_moved, no POST.
await fake("/_fake/reset");
const it2 = invoke("submit_review", dxInput({ head_sha: OLD_HEAD }));
const human = compozy(["tool", "invoke", "ext__github_app_review__submit_review", "--workspace", WS, "--agent", AGENT, "--input", JSON.stringify(dxInput({ head_sha: OLD_HEAD }))]);
report("IT-002", `exit ${it2.status}; json: ${it2.stdout.replace(/\s+/g, " ").trim()}`);
report("IT-002", `human exit ${human.status}: ${(human.stdout + human.stderr).trim()}`);
assert.notEqual(it2.status, 0);
assert.match(it2.stdout + it2.stderr, /head_moved: head_sha 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d is not the current head; current head is 9f2c1e0a7b3d4c5e6f708192a3b4c5d6e7f80912/);
assert.equal((await posts()).length, 0);
report("IT-002", "ok (no POST)");

// IT-003: pass 1 plus a non-bot reply on its thread → rereview posts pass 2; a second call is refused.
await fake("/_fake/reset");
await fake("/_fake/state", {
  reviews: [{ id: 2849182211, user: { login: BOT, type: "Bot" }, state: "CHANGES_REQUESTED", commit_id: HEAD, body: `${marker(HEAD, 1)}\n\npass one`, submitted_at: "2026-11-18T13:00:00Z" }],
  threads: [threadNode("PRRT_1", false, [
    { login: SLUG, bot: true, body: "major: Unescaped delimiter", at: "2026-11-18T13:02:11Z" },
    { login: "octocat", body: "Contest: …", at: "2026-11-18T13:20:40Z" },
  ])],
});
const it3 = invoke("submit_review", dxInput({ rereview: true }));
report("IT-003", `pass 2 exit ${it3.status}`);
assert.equal(it3.status, 0, it3.stderr);
const pass2 = JSON.parse(it3.stdout).result.structured;
assert.equal(pass2.pass, 2);
const [rereviewPost] = await posts();
assert.equal((await posts()).length, 1);
assert.equal(rereviewPost.body.commit_id, HEAD);
assert.equal(rereviewPost.body.body.split("\n")[0], marker(HEAD, 2));
report("IT-003", `ok ${JSON.stringify(pass2)}`);
const again = invoke("submit_review", dxInput({ rereview: true }));
report("IT-003", `second call exit ${again.status}; json: ${again.stdout.replace(/\s+/g, " ").trim()}`);
assert.notEqual(again.status, 0);
assert.match(again.stdout + again.stderr, /rereview_not_eligible: /);
assert.equal((await posts()).length, 1);
report("IT-003", "ok (second call refused, no POST)");

// IT-004: merge_gate kind=delivery ready over a BR-7 fixture; flip one condition → its reason.
await fake("/_fake/reset");
await fake("/_fake/state", { reviews: [{ id: 1, user: { login: BOT, type: "Bot" }, state: "APPROVED", commit_id: HEAD, body: "" }] });
const gate = { repo: "acme/widgets", number: 231, kind: "delivery" };
const ready = JSON.parse(invoke("merge_gate", gate).stdout).result.structured;
report("IT-004", `ready fixture → ${JSON.stringify(ready)}`);
assert.deepEqual(ready, { ready: true, head_sha: HEAD, reasons: [] });
await fake("/_fake/state", { mergeable: "CONFLICTING" });
const blocked = JSON.parse(invoke("merge_gate", gate).stdout).result.structured;
report("IT-004", `mergeable=CONFLICTING → ${JSON.stringify(blocked)}`);
assert.deepEqual(blocked, { ready: false, head_sha: HEAD, reasons: ["not_mergeable"] });

// IT-005: upsert_promotion opens the staging → main PR as the app; operator approval → ready.
await fake("/_fake/reset");
const it5 = invoke("upsert_promotion", { repo: REPO });
assert.equal(it5.status, 0, it5.stderr);
const opened = JSON.parse(it5.stdout).result.structured;
report("IT-005", `upsert_promotion → ${JSON.stringify(opened)}`);
assert.deepEqual(opened, { created: true, number: 240, url: `https://github.com/${REPO}/pull/240`, head_sha: PROMO_HEAD, included_prs: [231, 233, 236] });
const created = (await fake("/_fake/requests")).filter((r: any) => r.method === "POST" && r.path.endsWith("/pulls"));
assert.deepEqual(created.map((r: any) => [r.body.head, r.body.base]), [["staging", "main"]]);
const promo = { repo: REPO, number: 240, kind: "promotion" };
const pending = JSON.parse(invoke("merge_gate", promo).stdout).result.structured;
report("IT-005", `before approval → ${JSON.stringify(pending)}`);
assert.deepEqual(pending, { ready: false, head_sha: PROMO_HEAD, reasons: ["promotion_not_approved"] });
await fake("/_fake/state", { reviews: [{ id: 2, user: { login: "octocat", type: "User" }, state: "APPROVED", commit_id: PROMO_HEAD, body: "" }] });
const approved = JSON.parse(invoke("merge_gate", promo).stdout).result.structured;
report("IT-005", `operator approved head → ${JSON.stringify(approved)}`);
assert.deepEqual(approved, { ready: true, head_sha: PROMO_HEAD, reasons: [] });

// IT-006: no key bound → doctor exits 1 with the credential_absent line.
const unset = compozy(["extension", "secrets", "unset", "github-app-review", "--env", "GITHUB_APP_PRIVATE_KEY"]);
assert.equal(unset.status, 0, unset.stderr);
// Restart the subprocess so it starts without the key.
for (const verb of ["disable", "enable"]) assert.equal(compozy(["extension", verb, "github-app-review"]).status, 0);
const doctor = compozy(["extension", "exec", "github-app-review", "--cmd", "doctor", "-o", "json"]);
const doctorHuman = compozy(["extension", "exec", "github-app-review", "--cmd", "doctor"]);
report("IT-006", `exit ${doctor.status}; json: ${doctor.stdout.replace(/\s+/g, " ").trim()}`);
report("IT-006", `human exit ${doctorHuman.status}: ${(doctorHuman.stdout + doctorHuman.stderr).trim()}`);
assert.equal(doctor.status, 1);
assert.match(doctor.stdout, /"operator_cause": "credential_absent: .*token mint: failed \(credential_absent: /);
report("IT-*", "all passed");
