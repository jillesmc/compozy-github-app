import { reviewError } from "./errors.ts";

export const DEFAULT_API_URL = "https://api.github.com";

/** Declared in requires_env and set with `compozy extension secrets set|bind` (spec › Data Models). */
export const REQUIRED_ENV = [
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_REPOS",
  "GITHUB_APP_BASE",
  "GITHUB_APP_PROMOTION",
  "GITHUB_APP_PROMOTION_APPROVERS",
] as const;
/** Optional; only tests point it at a loopback fixture server. */
export const API_URL_ENV = "GITHUB_APP_API_URL";

export interface Promotion {
  repo: string;
  head: string;
  base: string;
}

export interface Config {
  appId: string;
  installationId: string;
  privateKey: string;
  repos: string[];
  /** The delivery branch the app reviews and gates (`GITHUB_APP_BASE`), e.g. `main` or `staging`. */
  base: string;
  promotion: Promotion | null;
  approvers: string[];
  apiUrl: string;
}

export type Env = Record<string, string | undefined>;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const list = (value: string | undefined) => (value ?? "").split(",").map(item => item.trim()).filter(Boolean);

/** Parses `owner/name:head->base`, or null when unset or malformed. */
export function parsePromotion(value: string | undefined): Promotion | null {
  const match = /^([^:\s]+):([^\s>-][^\s]*?)->(\S+)$/.exec((value ?? "").trim());
  return match && REPO.test(match[1]!) ? { repo: match[1]!, head: match[2]!, base: match[3]! } : null;
}

/**
 * Reads the extension configuration. The five variables every tool needs must be set
 * (`credential_absent`, before any network call); promotion settings are optional, but when
 * `GITHUB_APP_PROMOTION` is set it must promote `GITHUB_APP_BASE` into another branch (`config_invalid`).
 */
export function loadConfig(env: Env): Config {
  const missing = ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_REPOS", "GITHUB_APP_BASE"].filter(
    key => !env[key]?.trim()
  );
  if (missing.length > 0) {
    throw reviewError("credential_absent", `${missing.join(", ")} not set; run compozy extension secrets set github-app-review --env ${missing[0]} --value-stdin`);
  }
  const apiUrl = (env[API_URL_ENV]?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  const base = env.GITHUB_APP_BASE!.trim();
  const raw = env.GITHUB_APP_PROMOTION?.trim();
  const promotion = parsePromotion(raw);
  if (raw && !promotion) throw reviewError("config_invalid", "GITHUB_APP_PROMOTION must be owner/name:head->base");
  if (promotion && (promotion.head !== base || promotion.base === base)) {
    throw reviewError("config_invalid", `GITHUB_APP_PROMOTION must promote GITHUB_APP_BASE (${base}) into another branch; got ${promotion.head}->${promotion.base}`);
  }
  return {
    appId: env.GITHUB_APP_ID!.trim(),
    installationId: env.GITHUB_APP_INSTALLATION_ID!.trim(),
    privateKey: env.GITHUB_APP_PRIVATE_KEY!,
    repos: list(env.GITHUB_APP_REPOS).map(repo => repo.toLowerCase()),
    base,
    promotion,
    approvers: list(env.GITHUB_APP_PROMOTION_APPROVERS),
    apiUrl,
  };
}

/** BR-4: `owner/name` in the allowlist (case-insensitive), checked before any HTTP call. */
export function allowedRepo(value: unknown, config: Config): { owner: string; name: string; full: string } {
  if (typeof value !== "string" || !REPO.test(value)) throw reviewError("invalid_input", "repo must be owner/name");
  if (!config.repos.includes(value.toLowerCase())) {
    throw reviewError("repo_not_allowed", `${value} is not in GITHUB_APP_REPOS`);
  }
  const [owner, name] = value.split("/") as [string, string];
  return { owner, name, full: value };
}
