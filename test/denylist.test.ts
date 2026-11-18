import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// This repository is public: no tracked file may carry company-specific data. The literals are stored
// base64-encoded so this file does not contain them in clear; matching is case-insensitive.
const DENYLIST = [
  "bWFkZWlyYW1hZGVpcmE=",
  "bW9ub3JlcG8tcGxhdGZvcm0=",
  "UExBVEZPUk0t",
  "NTgwNDcyOA==",
  "MTgzMDM0Mjg1",
  "MzIyNjg5OA==",
  "amlsbGVz",
  "ZW50ZXJwcmlzZS1haS1wci1yZXZpZXdlcg==",
].map(encoded => Buffer.from(encoded, "base64").toString("utf8").toLowerCase());

const ROOT = new URL("..", import.meta.url).pathname;
// A clone has a .git directory; a worktree has a .git file. Neither means no history to check.
const noGit = existsSync(join(ROOT, ".git")) ? false : "no .git at the repository root (not a git checkout): denylist not checked";

test("denylist: no tracked file contains a company-specific literal", { skip: noGit }, () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(files.length > 0, "git ls-files listed no files");
  const hits: string[] = [];
  for (const file of files) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue; // deleted in the working tree
    readFileSync(path, "utf8").split("\n").forEach((line, index) => {
      const lower = line.toLowerCase();
      for (const word of DENYLIST) if (lower.includes(word)) hits.push(`${file}:${index + 1}: denylisted literal #${DENYLIST.indexOf(word) + 1}`);
    });
  }
  assert.deepEqual(hits, [], `denylisted literals found:\n${hits.join("\n")}`);
});
