import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import type { ToolResult } from "@compozy/extension-sdk";

import { doctorHandler } from "../src/doctor.ts";
import { TOOLS } from "../src/index.ts";
import { toolHandler, type ToolDeps } from "../src/tools/common.ts";
import { startFakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { REPO } from "./fixtures.ts";

/** Throwaway RSA key generated at test time; never a real app key. */
export const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const TEST_KEY = KEYS.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

export function testEnv(url: string, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_INSTALLATION_ID: "7890123",
    GITHUB_APP_PRIVATE_KEY: TEST_KEY,
    GITHUB_APP_REPOS: REPO,
    GITHUB_APP_BASE: "staging",
    GITHUB_APP_PROMOTION: `${REPO}:staging->main`,
    GITHUB_APP_PROMOTION_APPROVERS: "octocat",
    GITHUB_APP_API_URL: url,
    ...overrides,
  };
}

/** Fake GitHub + tool deps with a counting fetch and captured log lines. */
export async function harness(envOverrides: Record<string, string | undefined> = {}) {
  const gh: FakeGitHub = await startFakeGitHub();
  let fetches = 0;
  const lines: string[] = [];
  const deps: ToolDeps = {
    env: testEnv(gh.url, envOverrides),
    fetch: ((url: string, init: RequestInit) => {
      fetches++;
      return fetch(url, init);
    }) as typeof fetch,
    stderr: { write: (line: string) => lines.push(line) },
  };
  const handlers = new Map(TOOLS.map(tool => [tool.name, toolHandler(tool, deps)]));
  handlers.set("doctor", doctorHandler(deps));
  return {
    gh,
    deps,
    lines,
    fetches: () => fetches,
    posts: () => gh.requests.filter(request => request.method === "POST" && request.path.endsWith("/reviews")),
    async call(name: string, input: Record<string, unknown> = {}): Promise<any> {
      const result = (await handlers.get(name)!({ input } as never)) as ToolResult;
      return result.structured;
    },
    close: () => gh.close(),
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
