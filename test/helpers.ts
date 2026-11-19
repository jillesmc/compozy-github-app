import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolResult } from "@compozy/extension-sdk";

import { doctorHandler } from "../src/doctor.ts";
import { policyHandler } from "../src/policy-cmd.ts";
import { sha256 } from "../src/policy.ts";
import { TOOLS } from "../src/index.ts";
import { toolHandler, type ToolDeps } from "../src/tools/common.ts";
import { startFakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { REPO } from "./fixtures.ts";

/** Throwaway RSA key generated at test time; never a real app key. */
export const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const TEST_KEY = KEYS.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** The `_dx.md` policy for the fixture repository (delivery into staging, promotion staging → main). */
export const DEFAULT_POLICY = `[repos."${REPO}"]
delivery_base = "staging"
promotion = { head = "staging", base = "main" }
approvers = ["octocat"]
`;

/** Two repositories with different branches; single quotes, comments and spacing of the subset. */
export const TWO_REPOS = `# operator policy
[repos."acme/widgets"]
delivery_base = "staging"
promotion = { head = "staging", base = "main" }   # optional
approvers = ["octocat"]

[repos.'acme/gadgets']
delivery_base = 'develop'
promotion = {head="develop",base="release/1.x"}
approvers = [ "octocat", "hubot", ]
`;

/** A temp policy home: the working copy and, unless `stage: false`, its approved `policies/<sha>.toml`. */
export function policyHome(text = DEFAULT_POLICY, { stage = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ghar-policy-"));
  const working = join(dir, "policy.toml");
  writeFileSync(working, text);
  const digest = sha256(Buffer.from(text));
  const version = join(dir, "policies", `${digest}.toml`);
  if (stage) {
    mkdirSync(join(dir, "policies"));
    writeFileSync(version, text);
  }
  return { dir, working, digest, version, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Credentials plus an approved policy (`GITHUB_APP_POLICY_FILE` and `GITHUB_APP_POLICY_DIGEST`). */
export function testEnv(url: string, overrides: Record<string, string | undefined> = {}, policy = policyHome()): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_INSTALLATION_ID: "7890123",
    GITHUB_APP_PRIVATE_KEY: TEST_KEY,
    GITHUB_APP_POLICY_FILE: policy.working,
    GITHUB_APP_POLICY_DIGEST: policy.digest,
    GITHUB_APP_API_URL: url,
    ...overrides,
  };
}

/** Fake GitHub + tool deps (approved `policyText`) with a counting fetch and captured log lines. */
export async function harness(envOverrides: Record<string, string | undefined> = {}, policyText = DEFAULT_POLICY) {
  const gh: FakeGitHub = await startFakeGitHub();
  const policy = policyHome(policyText);
  let fetches = 0;
  const lines: string[] = [];
  const deps: ToolDeps = {
    env: testEnv(gh.url, envOverrides, policy),
    fetch: ((url: string, init: RequestInit) => {
      fetches++;
      return fetch(url, init);
    }) as typeof fetch,
    stderr: { write: (line: string) => lines.push(line) },
  };
  const handlers = new Map(TOOLS.map(tool => [tool.name, toolHandler(tool, deps)]));
  handlers.set("doctor", doctorHandler(deps));
  handlers.set("policy", policyHandler("policy", deps));
  handlers.set("policy-stage", policyHandler("policy-stage", deps));
  return {
    gh,
    deps,
    policy,
    lines,
    fetches: () => fetches,
    posts: () => gh.requests.filter(request => request.method === "POST" && request.path.endsWith("/reviews")),
    async call(name: string, input: Record<string, unknown> = {}): Promise<any> {
      const result = (await handlers.get(name)!({ input } as never)) as ToolResult;
      return result.structured;
    },
    close: () => {
      policy.remove();
      return gh.close();
    },
  };
}

/** Decodes a CompozyOS tool error: `{code: tool_*, message, operator: {cause, recovery}}`. */
export async function failure(promise: Promise<unknown>): Promise<{ toolCode: string; code: string; message: string; recovery: string }> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: any }).data;
    assert.ok(data, String(error));
    assert.equal(data.operator.cause, data.message);
    const match = /^(\w+): ([\s\S]*)$/.exec(data.message);
    assert.ok(match, data.message);
    return { toolCode: data.code, code: match[1]!, message: match[2]!, recovery: data.operator.recovery };
  }
  throw new Error("expected a tool error");
}
