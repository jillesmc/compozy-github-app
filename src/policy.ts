// Operator policy (ADR-002, BR-15): which repositories the app serves, on which branches, approved by whom.
// The format is a strict TOML subset, documented in docs/policy.md; anything outside it is config_invalid.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { reviewError } from "./errors.ts";

export const POLICY_FILE_ENV = "GITHUB_APP_POLICY_FILE";
export const POLICY_DIGEST_ENV = "GITHUB_APP_POLICY_DIGEST";

export interface RepoPolicy {
  /** `owner/name` as written in the policy. */
  repo: string;
  /** The branch the app reviews and gates for delivery PRs. */
  delivery_base: string;
  promotion: Readonly<{ head: string; base: string }> | null;
  approvers: readonly string[];
}
/** An approved version: its digest, its file and its repositories keyed by lowercase `owner/name`. */
export interface Policy {
  digest: string;
  path: string;
  repos: ReadonlyMap<string, Readonly<RepoPolicy>>;
}

export type ReadFile = (path: string) => Buffer;
type Env = Record<string, string | undefined>;

export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const LOGIN = /^[A-Za-z0-9-]+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9_-]+/;
const HEADER = /^\[[ \t]*repos\.("[^"]*"|'[^']*')[ \t]*\][ \t]*(?:#.*)?$/;
/** TOML whitespace is space and tab only (G-4); other Unicode whitespace is refused as text. */
const trimTOML = (text: string) => text.replace(/^[ \t]+|[ \t]+$/g, "");

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Working copy (`GITHUB_APP_POLICY_FILE`, else `$XDG_CONFIG_HOME` or `~/.config`) and the sibling `policies/` dir. */
export function policyPaths(env: Env): { working: string; versions: string } {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const home = env.HOME?.trim();
  const config = xdg && isAbsolute(xdg) ? xdg : join(home && isAbsolute(home) ? home : homedir(), ".config");
  const file = env[POLICY_FILE_ENV]?.trim();
  if (file && !isAbsolute(file)) throw reviewError("config_invalid", `${POLICY_FILE_ENV} must be an absolute path`);
  const working = file || join(config, "compozy-github-app", "policy.toml");
  return { working, versions: join(dirname(working), "policies") };
}

type Value = string | string[] | Record<string, string>;

/** One value of the subset: a string, an array of strings, or an inline table of strings. */
function parseValue(line: string, at: number, fail: (message: string) => never): { value: Value; end: number } {
  let i = at;
  const space = () => {
    while (line[i] === " " || line[i] === "\t") i++;
  };
  const text = (): string => {
    const quote = line[i];
    if (quote !== '"' && quote !== "'") fail("expected a quoted string");
    const end = line.indexOf(quote!, i + 1);
    if (end < 0) fail("unterminated string");
    const value = line.slice(i + 1, end);
    if (quote === '"' && value.includes("\\")) fail("escapes are not supported");
    i = end + 1;
    return value;
  };
  let value: Value;
  if (line[i] === "[") {
    const items: string[] = [];
    i++;
    for (space(); line[i] !== "]"; space()) {
      items.push(text());
      space();
      if (line[i] === ",") i++;
      else if (line[i] !== "]") fail("expected , or ] in array");
    }
    i++;
    value = items;
  } else if (line[i] === "{") {
    const table: Record<string, string> = {};
    i++;
    for (space(); line[i] !== "}"; ) {
      const key = KEY.exec(line.slice(i))?.[0];
      if (!key) fail("expected a key in inline table");
      if (key in table) fail(`duplicate key ${key}`);
      i += key.length;
      space();
      if (line[i++] !== "=") fail("expected = in inline table");
      space();
      table[key] = text();
      space();
      if (line[i] === ",") {
        i++;
        space();
        if (line[i] === "}") fail("trailing comma in inline table");
      } else if (line[i] !== "}") fail("expected , or } in inline table");
    }
    i++;
    value = table;
  } else value = text();
  space();
  if (i < line.length && line[i] !== "#") fail("unexpected text after value");
  return { value, end: i };
}

/** Parses and validates the policy text; `config_invalid` naming the path (and line) on any deviation. */
export function parsePolicy(source: string, path: string): Map<string, Readonly<RepoPolicy>> {
  const raw = new Map<string, { repo: string; line: number; fields: Record<string, Value> }>();
  let current: { fields: Record<string, Value> } | null = null;
  source.split("\n").forEach((full, index) => {
    const line = full.endsWith("\r") ? full.slice(0, -1) : full;
    const fail = (message: string): never => {
      throw reviewError("config_invalid", `${path}:${index + 1}: ${message}`);
    };
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line)) fail("control character");
    const trimmed = trimTOML(line);
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const header = HEADER.exec(trimmed);
    if (header) {
      const repo = header[1]!.slice(1, -1);
      if (!REPO.test(repo)) fail(`repos."${repo}": expected owner/name`);
      if (raw.has(repo.toLowerCase())) fail(`repos."${repo}": duplicate repository`);
      current = { fields: {} };
      raw.set(repo.toLowerCase(), { repo, line: index + 1, ...current });
      return;
    }
    if (trimmed.startsWith("[")) fail('only [repos."owner/name"] tables are allowed');
    if (!current) fail('key outside a [repos."owner/name"] table');
    const assignment = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*/.exec(trimmed) ?? fail("expected key = value");
    const key = assignment[1]!;
    if (key in current!.fields) fail(`duplicate key ${key}`);
    current!.fields[key] = parseValue(trimmed, assignment[0].length, fail).value;
  });
  const repos = new Map<string, Readonly<RepoPolicy>>();
  for (const [lower, { repo, line, fields }] of raw) {
    const fail = (message: string): never => {
      throw reviewError("config_invalid", `${path}:${line}: repos."${repo}": ${message}`);
    };
    const unknown = Object.keys(fields).find(key => !["delivery_base", "promotion", "approvers"].includes(key));
    if (unknown) fail(`unknown key ${unknown}`);
    const branch = (value: Value | undefined, name: string): string =>
      typeof value === "string" && BRANCH.test(value) ? value : fail(`${name} must be a branch name ([A-Za-z0-9._/-]+)`);
    const deliveryBase = branch(fields.delivery_base, "delivery_base");
    let promotion: RepoPolicy["promotion"] = null;
    if (fields.promotion !== undefined) {
      const p = fields.promotion;
      if (typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join() !== "base,head") fail("promotion must be { head = \"…\", base = \"…\" }");
      promotion = Object.freeze({ head: branch((p as Record<string, string>).head, "promotion.head"), base: branch((p as Record<string, string>).base, "promotion.base") });
      if (promotion.head !== deliveryBase) fail(`promotion.head must equal delivery_base (${deliveryBase})`);
      if (promotion.base === deliveryBase) fail("promotion.base must differ from delivery_base");
    }
    const approvers = fields.approvers ?? [];
    if (!Array.isArray(approvers) || approvers.some(login => !LOGIN.test(login))) fail("approvers must be an array of GitHub logins");
    if (promotion && (approvers as string[]).length === 0) fail("approvers are required when promotion is set");
    repos.set(lower, Object.freeze({ repo, delivery_base: deliveryBase, promotion, approvers: Object.freeze([...(approvers as string[])]) }));
  }
  return repos;
}

/** UTF-8 text of the buffer, or `config_invalid` naming the path. */
export function decode(bytes: Buffer, path: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.startsWith("\uFEFF")) throw new Error("bom");
    return text;
  } catch (error) {
    throw reviewError("config_invalid", `${path}: ${(error as Error).message === "bom" ? "byte order mark (BOM) not allowed" : "not valid UTF-8"}`);
  }
}

/**
 * BR-15: reads `policies/<GITHUB_APP_POLICY_DIGEST>.toml` once, checks the sha256 of that buffer and
 * parses the same buffer. Unset or malformed digest, absent file or mismatch → `policy_unapproved`;
 * an unreadable or malformed approved file → `config_invalid`. Never a fallback.
 */
export function loadPolicy(env: Env, read: ReadFile = readFileSync): Policy {
  const digest = env[POLICY_DIGEST_ENV]?.trim() ?? "";
  if (!digest) throw reviewError("policy_unapproved", `${POLICY_DIGEST_ENV} is not set`);
  if (!DIGEST.test(digest)) throw reviewError("policy_unapproved", `${POLICY_DIGEST_ENV} is not a lowercase sha256 hex digest`);
  const path = join(policyPaths(env).versions, `${digest}.toml`);
  let bytes: Buffer;
  try {
    bytes = read(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw reviewError("policy_unapproved", `${path} does not exist`);
    throw reviewError("config_invalid", `${path} is unreadable (${code ?? "error"})`);
  }
  if (sha256(bytes) !== digest) throw reviewError("policy_unapproved", `${path} does not hash to ${POLICY_DIGEST_ENV}`);
  return Object.freeze({ digest, path, repos: parsePolicy(decode(bytes, path), path) });
}
