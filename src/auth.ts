import { createPrivateKey, sign, type KeyObject } from "node:crypto";

import { reviewError } from "./errors.ts";
import { failure, send, type HttpDeps } from "./http.ts";

/** Refresh an installation token this long before its `expires_at`. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** What github.ts and the doctor get: tokens, never key material. */
export interface TokenProvider {
  token(repo: string): Promise<string>;
  invalidate(repo: string): void;
}

export interface Minted {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
}

export interface AppAuth extends TokenProvider {
  /** Mints (or reuses) the token for one policy repository; exposes its permissions. */
  mint(repo: string): Promise<Minted>;
  /** `GET <path>` authenticated as the app (JWT): `/app`, `/app/installations/{id}`. */
  appGet(path: string): Promise<any>;
}

export interface AuthOptions extends HttpDeps {
  appId: string;
  installationId: string;
  privateKey: string;
  apiUrl: string;
  now?: () => number;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** RS256 app JWT: iss = app id, iat = now − 60 s, exp = now + 9 min. */
export function appJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
  return `${unsigned}.${b64url(sign("sha256", Buffer.from(unsigned), key))}`;
}

/**
 * The only holder of the private key. Installation tokens are scoped to one policy repository
 * each (so a repo missing from the installation fails alone) and cached until 5 min before expiry.
 */
export function createAppAuth(options: AuthOptions): AppAuth {
  const now = options.now ?? Date.now;
  let key: KeyObject;
  try {
    key = createPrivateKey(options.privateKey);
  } catch {
    throw reviewError("credential_invalid", "GITHUB_APP_PRIVATE_KEY is not a valid private key");
  }
  const cache = new Map<string, Minted>();
  const jwt = () => `Bearer ${appJwt(options.appId, key, now())}`;
  const appFailure = (status: number, response: Parameters<typeof failure>[0]) =>
    status === 401 ? reviewError("credential_invalid", "GitHub rejected the app JWT (401); check the key and app id", 401) : failure(response, now);

  async function mint(repo: string): Promise<Minted> {
    const cached = cache.get(repo);
    if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached;
    cache.delete(repo);
    const response = await send(
      `${options.apiUrl}/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`,
      { method: "POST", authorization: jwt(), body: { repositories: [repo.split("/")[1]] } },
      options
    );
    if (response.status === 422 || response.status === 404) {
      const what = response.status === 404 ? `installation ${options.installationId} not found` : `${repo} is not in the installation`;
      throw reviewError(response.status === 404 ? "credential_invalid" : "repo_not_installed", what, response.status);
    }
    if (response.status !== 201 && response.status !== 200) throw appFailure(response.status, response);
    const minted: Minted = {
      token: String(response.body?.token ?? ""),
      expiresAt: Date.parse(response.body?.expires_at ?? "") || now(),
      permissions: response.body?.permissions ?? {},
    };
    cache.set(repo, minted);
    return minted;
  }

  return {
    mint,
    async token(repo) {
      return (await mint(repo)).token;
    },
    invalidate(repo) {
      cache.delete(repo);
    },
    async appGet(path) {
      const response = await send(`${options.apiUrl}${path}`, { method: "GET", authorization: jwt() }, options);
      if (response.status !== 200) throw appFailure(response.status, response);
      return response.body;
    },
  };
}
