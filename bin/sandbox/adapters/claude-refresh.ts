// Claude pre-session refresh (S10a). Undocumented contract, isolated here and validated strictly.
//
// Flow, as the Claude Code CLI itself refreshes (claude-agent-sdk 0.3.x native CLI, production config:
// TOKEN_URL https://platform.claude.com/v1/oauth/token, CLIENT_ID 9d1c250a-e61b-44d9-88ed-5944d1962f5e):
//   POST <TOKEN_URL>, Content-Type: application/json
//   { grant_type: "refresh_token", refresh_token, client_id, scope: <stored scopes joined by " "> }
//   200 -> { access_token, refresh_token?, expires_in, scope?, ... } (the CLI keeps the old refresh token when
//   none is returned, and sets expiresAt = now + expires_in * 1000)
// Saved (merge rule, as the CLI does): in `.credentials.json` `claudeAiOauth`, replace accessToken,
// refreshToken (when returned), expiresAt and scopes (when returned); keep every other field and every other
// top-level key of the host file as is. The refresh host (platform.claude.com) is a host-side call; it is
// not in the sandbox egress.
import { parseJsonObject } from "../files.ts";
import { isPlainObject, nonEmptyString, postForJson, type RefreshHttpOptions } from "./refresh-http.ts";
import { RefreshError, type RefreshNeed } from "./types.ts";

export const DEFAULT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export function claudeRefreshNeeded(loginText: string, untilMs: number): RefreshNeed {
  const oauth = parseJsonObject(loginText)?.claudeAiOauth;
  if (!isPlainObject(oauth)) return "not-refreshable"; // not an OAuth login: nothing to refresh
  if (!nonEmptyString(oauth.accessToken) || typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt)) return "refresh";
  return oauth.expiresAt <= untilMs ? "refresh" : "valid";
}

export type ClaudeRefreshOptions = RefreshHttpOptions & { tokenUrl?: string; now?: () => number };

export async function claudeRefresh(loginText: string, opts: ClaudeRefreshOptions, signal: AbortSignal): Promise<string> {
  const doc = parseJsonObject(loginText);
  const oauth = doc?.claudeAiOauth;
  if (!doc || !isPlainObject(oauth) || !nonEmptyString(oauth.refreshToken)) throw new RefreshError("shape");
  const scopes = oauth.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((x) => nonEmptyString(x) && !/\s/.test(x))) throw new RefreshError("shape");
  const body = JSON.stringify({ grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: CLAUDE_CLIENT_ID, scope: scopes.join(" ") });
  const answer = await postForJson(new URL(opts.tokenUrl ?? DEFAULT_TOKEN_URL), body, "application/json", opts, signal);
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn, scope } = answer;
  if (!nonEmptyString(access)) throw new RefreshError("shape");
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 366 * 24 * 3600) throw new RefreshError("shape");
  if (refresh !== undefined && !nonEmptyString(refresh)) throw new RefreshError("shape");
  if (scope !== undefined && typeof scope !== "string") throw new RefreshError("shape");
  const now = (opts.now ?? Date.now)();
  const nextScopes = typeof scope === "string" && scope.trim() ? scope.trim().split(/\s+/) : scopes;
  return JSON.stringify({
    ...doc,
    claudeAiOauth: { ...oauth, accessToken: access, refreshToken: refresh ?? oauth.refreshToken, expiresAt: now + expiresIn * 1000, scopes: nextScopes },
  });
}
