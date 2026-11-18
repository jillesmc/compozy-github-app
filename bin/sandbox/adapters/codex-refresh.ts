// Codex pre-session refresh (S10a). Undocumented contract, isolated here and validated strictly.
//
// Flow, as the Codex CLI 0.166 itself refreshes (login crate; endpoint overridable in the CLI by
// CODEX_REFRESH_TOKEN_URL_OVERRIDE):
//   POST https://auth.openai.com/oauth/token, Content-Type: application/x-www-form-urlencoded
//   grant_type=refresh_token & refresh_token & client_id=<Codex CLI client id> & refresh_reason=scheduled
//   200 -> RefreshResponse { id_token?, access_token?, refresh_token? } (the CLI keeps each old value that is
//   not returned)
// Saved (merge rule, as the CLI does): in auth.json `tokens`, replace id_token / access_token / refresh_token
// with the returned values (access_token is required here, the other two when returned), set `last_refresh`
// to now; keep `tokens.account_id`, `auth_mode`, `OPENAI_API_KEY` and every other field as is. The refreshed
// tokens are then verified by codex-identity (signatures, issuer, audiences, same account and org).
// auth.openai.com is also in the sandbox egress (the CLI refreshes in-session too; that result is discarded).
import { parseJsonObject } from "../files.ts";
import { CODEX_CLIENT_ID, decodeJwt } from "./codex-identity.ts";
import { isPlainObject, nonEmptyString, postForJson, type RefreshHttpOptions } from "./refresh-http.ts";
import { RefreshError, type RefreshNeed } from "./types.ts";

export const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";

export function codexRefreshNeeded(loginText: string, untilMs: number): RefreshNeed {
  const doc = parseJsonObject(loginText);
  if (!doc) return "refresh"; // unparsable: the refresh step refuses it as a shape change
  if (doc.auth_mode !== undefined && doc.auth_mode !== null && doc.auth_mode !== "chatgpt") return "not-refreshable";
  if (doc.tokens === undefined || doc.tokens === null) return "not-refreshable"; // API-key login
  const tokens = doc.tokens;
  if (!isPlainObject(tokens) || !nonEmptyString(tokens.access_token)) return "refresh";
  let exp: unknown;
  try {
    exp = decodeJwt(tokens.access_token).payload.exp; // deciding only: signatures are verified after a refresh
  } catch {
    return "refresh";
  }
  return typeof exp === "number" && Number.isFinite(exp) && exp * 1000 > untilMs ? "valid" : "refresh";
}

export type CodexRefreshOptions = RefreshHttpOptions & { tokenUrl?: string; now?: () => number };

export async function codexRefresh(loginText: string, opts: CodexRefreshOptions, signal: AbortSignal): Promise<string> {
  const doc = parseJsonObject(loginText);
  const tokens = doc?.tokens;
  if (!doc || !isPlainObject(tokens) || !nonEmptyString(tokens.refresh_token)) throw new RefreshError("shape");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: CODEX_CLIENT_ID,
    refresh_reason: "scheduled",
  }).toString();
  const answer = await postForJson(new URL(opts.tokenUrl ?? DEFAULT_TOKEN_URL), body, "application/x-www-form-urlencoded", opts, signal);
  const { id_token: id, access_token: access, refresh_token: refresh } = answer;
  if (!nonEmptyString(access)) throw new RefreshError("shape");
  for (const v of [id, refresh]) if (v !== undefined && v !== null && !nonEmptyString(v)) throw new RefreshError("shape");
  return JSON.stringify({
    ...doc,
    tokens: {
      ...tokens,
      access_token: access,
      id_token: nonEmptyString(id) ? id : tokens.id_token,
      refresh_token: nonEmptyString(refresh) ? refresh : tokens.refresh_token,
    },
    last_refresh: new Date((opts.now ?? Date.now)()).toISOString(),
  });
}
