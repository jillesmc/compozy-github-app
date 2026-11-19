import { reviewError } from "./errors.ts";
import { loadPolicy, REPO, type Policy, type ReadFile, type RepoPolicy } from "./policy.ts";

export const DEFAULT_API_URL = "https://api.github.com";

/** Credentials only (US-005); set with `compozy extension secrets set|bind`. */
export const REQUIRED_ENV = ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"] as const;
/**
 * Optional: the approved policy digest and the working-copy path (BR-15). The SDK has no optional-env
 * field, so they are declared in `requires_env` too (that lets `secrets set --env` accept them); the
 * daemon keeps the extension active while they are unset, and the code treats them as optional.
 */
export const OPTIONAL_ENV = ["GITHUB_APP_POLICY_DIGEST", "GITHUB_APP_POLICY_FILE"] as const;
/** Optional; only tests point it at a loopback fixture server. */
export const API_URL_ENV = "GITHUB_APP_API_URL";

export interface Credentials {
  appId: string;
  installationId: string;
  privateKey: string;
  apiUrl: string;
}
export interface Config extends Credentials {
  /** The approved policy version, read once for this call and never changed during it. */
  policy: Policy;
}

export type Env = Record<string, string | undefined>;

/** The three credentials every tool needs (`credential_absent`, before any network call). */
export function loadCredentials(env: Env): Credentials {
  const missing = ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID"].filter(key => !env[key]?.trim());
  if (missing.length > 0) {
    throw reviewError("credential_absent", `${missing.join(", ")} not set; run compozy extension secrets set github-app-review --env ${missing[0]} --value-stdin`);
  }
  return {
    appId: env.GITHUB_APP_ID!.trim(),
    installationId: env.GITHUB_APP_INSTALLATION_ID!.trim(),
    privateKey: env.GITHUB_APP_PRIVATE_KEY!,
    apiUrl: (env[API_URL_ENV]?.trim() || DEFAULT_API_URL).replace(/\/+$/, ""),
  };
}

/** Credentials, then the approved policy (BR-15); both before any network call. */
export function loadConfig(env: Env, read?: ReadFile): Config {
  const credentials = loadCredentials(env);
  return { ...credentials, policy: loadPolicy(env, read) };
}

/** BR-6: `owner/name` present in the approved policy (case-insensitive), checked before any HTTP call. */
export function allowedRepo(value: unknown, config: Config): { owner: string; name: string; full: string; policy: Readonly<RepoPolicy> } {
  if (typeof value !== "string" || !REPO.test(value)) throw reviewError("invalid_input", "repo must be owner/name");
  const policy = config.policy.repos.get(value.toLowerCase());
  if (!policy) throw reviewError("repo_not_allowed", `${value} is not in the approved policy`);
  const [owner, name] = value.split("/") as [string, string];
  return { owner, name, full: value, policy };
}
