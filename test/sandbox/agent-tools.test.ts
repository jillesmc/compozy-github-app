import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { createExtension } from "../../src/index.ts";

// R-4: the shipped IT-016 agent must allowlist tool IDs the extension really exposes (SDK-derived,
// underscores), or the sandboxed session can never list or call them.
const AGENT = new URL("../../.compozy/agents/reviewer-selftest/AGENT.md", import.meta.url);

function allowlistedTools(markdown: string): string[] {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
  const block = /^tools:\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(frontmatter)?.[1] ?? "";
  return block.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
}

test("reviewer-selftest allowlists exactly pr_context by its real descriptor ID", () => {
  const markdown = fs.readFileSync(AGENT, "utf8");
  const described = (createExtension().describe().tools ?? []).map((t) => t.id);
  const allowed = allowlistedTools(markdown);
  assert.deepEqual(allowed, ["ext__github_app_review__pr_context"]);
  for (const id of allowed) assert.ok(described.includes(id), `${id} is not in describe().tools`);
  // Every tool ID mentioned anywhere in the agent (steps, expected reply) must exist too.
  const doc = fs.readFileSync(new URL("../../docs/reviewer-sandbox.md", import.meta.url), "utf8");
  for (const id of `${markdown}\n${doc}`.match(/ext__[\w-]+/g) ?? []) {
    assert.ok(described.includes(id), `${id} is not a real tool ID`);
  }
});
