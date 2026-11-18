import type { ExtensionToolHandler, JSONValue, ToolResult } from "@compozy/extension-sdk";

import { createAppAuth, type AppAuth } from "../auth.ts";
import { allowedRepo, loadConfig, type Config, type Env, type Promotion } from "../config.ts";
import { causeCode, reviewError, ReviewError, toolError } from "../errors.ts";
import { createGitHub, type GitHub } from "../github.ts";
import { parsePass, type AppReview } from "../rules.ts";

export interface ToolDeps {
  env: Env;
  fetch?: typeof fetch;
  now?: () => number;
  stderr?: { write(line: string): unknown };
  /** Doctor's duplicate-review scan budget in ms (default 10 000); tests shorten it. */
  doctorScanMs?: number;
}

/** Per-process state behind the tools: config, the key holder and the app slug. */
export interface Runtime {
  config: Config;
  auth: AppAuth;
  now: () => number;
  slug(): Promise<string>;
  github(repo: string): GitHub;
}

/** Fields of the one log line per call (spec › Monitoring); never bodies, tokens or key material. */
export type LogFields = Partial<Record<"repo" | "pr" | "head_sha" | "pass" | "event" | "inline" | "moved", string | number>>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONValue;
  readOnly: boolean;
  handle(input: Record<string, unknown>, rt: Runtime, log: LogFields): Promise<ToolResult | string>;
}

const runtimes = new WeakMap<ToolDeps, { fingerprint: string; runtime: Runtime }>();

/** Loads config on every call (credential_absent before any I/O); reuses auth while the key is unchanged. */
export function runtime(deps: ToolDeps): Runtime {
  const config = loadConfig(deps.env);
  const fingerprint = JSON.stringify([config.appId, config.installationId, config.privateKey, config.apiUrl]);
  const cached = runtimes.get(deps);
  if (cached?.fingerprint === fingerprint) return { ...cached.runtime, config };
  const now = deps.now ?? Date.now;
  const http = { fetch: deps.fetch };
  const auth = createAppAuth({ ...http, appId: config.appId, installationId: config.installationId, privateKey: config.privateKey, apiUrl: config.apiUrl, now });
  let slug: Promise<string> | undefined;
  const rt: Runtime = {
    config,
    auth,
    now,
    slug() {
      slug ??= auth.appGet("/app").then(app => String(app?.slug ?? ""));
      slug.catch(() => (slug = undefined));
      return slug;
    },
    github: repo => createGitHub({ ...http, apiUrl: config.apiUrl, repo, tokens: auth, now }),
  };
  runtimes.set(deps, { fingerprint, runtime: rt });
  return rt;
}

/** SDK handler: one log line per call; failures become CompozyOS tool errors. */
export function toolHandler(tool: ToolDefinition, deps: ToolDeps): ExtensionToolHandler {
  return async ({ input }) => {
    const started = Date.now();
    const log: LogFields = {};
    let outcome = "ok";
    let status: number | undefined;
    try {
      const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      return await tool.handle(raw, runtime(deps), log);
    } catch (error) {
      outcome = causeCode(error);
      status = error instanceof ReviewError ? error.httpStatus : undefined;
      throw toolError(error);
    } finally {
      const fields = { tool: tool.name, ...log, outcome, github_status: status ?? "-", duration_ms: Date.now() - started };
      (deps.stderr ?? process.stderr).write(`github-app-review: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
    }
  };
}

/** A JSON result whose text is the same JSON (agents and `compozy tool invoke -o json`). */
export function jsonResult(value: JSONValue): ToolResult {
  const text = JSON.stringify(value);
  return { content: [{ type: "text", text }], structured: value, truncated: false, bytes: Buffer.byteLength(text), duration_ms: 0 };
}

export const REPO_SCHEMA = { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", description: "owner/name, must be allowlisted" };
export const NUMBER_SCHEMA = { type: "integer", minimum: 1, description: "pull request number" };

/** Shared input: an allowlisted repo and a PR number (repo checked before any HTTP call). */
export function target(input: Record<string, unknown>, rt: Runtime, log: LogFields) {
  const repo = allowedRepo(input.repo, rt.config);
  const number = input.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw reviewError("invalid_input", "number must be a positive integer");
  }
  log.repo = repo.full;
  log.pr = number;
  return { repo, number, gh: rt.github(repo.full), base: `/repos/${repo.owner}/${repo.name}` };
}

/** This app's reviews, in submission order, with the pass parsed from the body marker. */
export function appReviews(reviews: any[], slug: string): AppReview[] {
  return reviews
    .filter(review => review?.user?.login === `${slug}[bot]`)
    .map(review => ({ id: review.id, state: review.state, commit_id: review.commit_id, pass: parsePass(review.body), submitted_at: String(review.submitted_at ?? "") }));
}

/** PR lifecycle as the gates see it. */
export const prState = (pr: any): "open" | "closed" | "merged" => (pr.merged || pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed");

/** Rejects any input key the schema does not declare (the agent cannot pass e.g. an `event`). */
export function onlyKeys(input: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(input).find(key => !allowed.includes(key));
  if (extra) throw reviewError("invalid_input", `${extra}: unknown field`);
}

/** The `GITHUB_APP_PROMOTION` setting for `repo` (case-insensitive), refused before any HTTP call. */
export function promotionTarget(rt: Runtime, repo: string): Promotion {
  const promotion = rt.config.promotion;
  if (!promotion) throw reviewError("invalid_input", "GITHUB_APP_PROMOTION is not set or not owner/name:head->base");
  if (promotion.repo.toLowerCase() !== repo.toLowerCase()) throw reviewError("invalid_input", `repo: ${repo} is not the promotion repository`);
  return promotion;
}
