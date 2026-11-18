/**
 * Mutation check for src/rules.ts (`_tests.md` › Strategy): each gate/derivation predicate is replaced
 * by `(<predicate> || true)`, one mutant at a time, and `bun test` must fail for every mutant.
 * Run: bun scripts/mutation.ts   (restores src/rules.ts afterwards; exits 1 if a mutant survives)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src/rules.ts";
const PREDICATES = [
  "match ?",
  "BLOCKING.has(finding.severity)",
  "entry.path === finding.path",
  "entry.lines.includes(finding.line)",
  "finding.start_line === undefined || entry.lines.includes(finding.start_line)",
  "entry.side === side && covers(entry)",
  "entry.side !== side && covers(entry)",
  "input.rereview",
  "review.commit_id === input.headSha",
  "review.pass !== null",
  "thread.commit_id === input.headSha",
  '!comment.author.endsWith("[bot]")',
  "onHead.length > 0",
  "!onHead.some(review => review.pass === 2)",
  // R-1: reply after the latest app review of the head; exactly one pass 1
  "r.commit_id === input.headSha",
  "Date.parse(comment.created_at) > latest",
  "firstPasses === 1",
  // R-3: incomplete history fails closed
  "!pr.history_complete",
  'review.state === "APPROVED" || review.state === "CHANGES_REQUESTED"',
  'pr.state !== "open"',
  "pr.base_ref !== base",
  "review => review.is_app",
  'app.state === "APPROVED"',
  "app.commit_id === head",
  'app?.state === "APPROVED"',
  'review.state === "CHANGES_REQUESTED" && review.commit_id === head',
  "review.commit_id === head)",
  'check.status !== "completed"',
  'check.status === "completed" && !PASSING_CHECK.has(check.conclusion ?? "")',
  'pr.mergeable !== "MERGEABLE"',
  "!thread.is_resolved",
  // BR-8 promotionGate
  "!pr.author_is_app",
  "pr.base_ref !== cfg.base",
  "pr.head_ref !== cfg.head",
  "approvers.has(r.author.toLowerCase())",
  "!r.is_app",
  'r.state === "APPROVED"',
  "r.commit_id === pr.head_sha",
  "!approved",
];

const mutate = (source: string, predicate: string): string => {
  const at = source.indexOf(predicate);
  if (at < 0 || source.indexOf(predicate, at + 1) >= 0) throw new Error(`predicate not found exactly once: ${predicate}`);
  if (predicate === "match ?") return source.replace(predicate, "(match || true) ?");
  if (predicate === "review => review.is_app") return source.replace(predicate, "review => (review.is_app || true)");
  if (predicate === "review.commit_id === head)") return source.replace(predicate, "(review.commit_id === head || true))");
  return source.replace(predicate, `(${predicate} || true)`);
};

const original = readFileSync(FILE, "utf8");
const rows: string[] = [];
let survived = 0;
try {
  for (const [index, predicate] of PREDICATES.entries()) {
    writeFileSync(FILE, mutate(original, predicate));
    const run = spawnSync("bun", ["test"], { encoding: "utf8" });
    const output = `${run.stdout}${run.stderr}`;
    const failed = /(\d+) fail/.exec(output)?.[1] ?? "?";
    const killers = [...new Set([...output.matchAll(/\(fail\)[^>]*> (U[TI]-\d+)/g)].map(m => m[1]))].join(", ");
    const killed = run.status !== 0;
    if (!killed) survived++;
    rows.push(`| M${index + 1} | \`${predicate}\` | ${killed ? "killed" : "SURVIVED"} | ${failed} | ${killers} |`);
  }
} finally {
  writeFileSync(FILE, original);
}
process.stdout.write(["| Mutant | Predicate (`|| true`) | Result | Failing tests | Killed by |", "| --- | --- | --- | --- | --- |", ...rows].join("\n") + "\n");
process.exit(survived === 0 ? 0 : 1);
