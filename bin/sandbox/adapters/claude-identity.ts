// Claude account identity (ADR-004, R-18). Undocumented contract, isolated here and validated strictly.
//
// Endpoint, as called by the Claude Code CLI itself with an OAuth access token (claude-agent-sdk 0.3.x
// native CLI, `BASE_API_URL` = https://api.anthropic.com):
//   GET <base>/api/oauth/profile
//   Authorization: Bearer <OAuth access token>, Content-Type: application/json, Cache-Control: no-cache
//   (no anthropic-beta header; the CLI uses a 10 s timeout)
//   200 -> { account: { uuid, email, ... }, organization: { uuid, ... } }
// Only account.uuid and organization.uuid are read. Any other status, a network error or a timeout is
// "unavailable"; any deviation from that shape is "shape". Nothing from the answer is ever logged.
//
// Start identity: the dedicated login dir's `.claude.json` `oauthAccount` {accountUuid, organizationUuid},
// written by the CLI at /login on the host. Read offline, before bwrap starts. The sandbox can never write
// the host's copy: nothing is ever copied back (S10a).
import { IdentityError, type Identity } from "./types.ts";
import { parseJsonObject } from "../files.ts";

export const DEFAULT_BASE_URL = "https://api.anthropic.com";
export const PROFILE_PATH = "/api/oauth/profile";
export const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BODY = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

// The OAuth access token of a Claude login file (`.credentials.json`).
export function accessTokenOf(loginText: string): string {
  const oauth = parseJsonObject(loginText)?.claudeAiOauth;
  if (!isObject(oauth) || typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
    throw new IdentityError("shape");
  }
  return oauth.accessToken;
}

// Identity recorded by the CLI in `.claude.json` at /login.
export function oauthAccountIdentity(claudeJsonText: string): Identity {
  const doc = parseJsonObject(claudeJsonText);
  if (!doc) throw new IdentityError("shape");
  const acct = doc.oauthAccount;
  if (acct === undefined) throw new IdentityError("unavailable");
  if (!isObject(acct) || !isUuid(acct.accountUuid) || !isUuid(acct.organizationUuid)) throw new IdentityError("shape");
  return { account: acct.accountUuid.toLowerCase(), org: acct.organizationUuid.toLowerCase() };
}

export type ProfileOptions = { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };

// Asks the provider who owns `accessToken`. Never follows redirects; never logs anything.
export async function profileIdentity(accessToken: string, opts: ProfileOptions, signal: AbortSignal): Promise<Identity> {
  const f = opts.fetch ?? fetch;
  const url = new URL(PROFILE_PATH, opts.baseUrl ?? DEFAULT_BASE_URL);
  const sig = AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)]);
  let body: string;
  try {
    const res = await f(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": "reviewer-sandbox",
      },
      redirect: "manual",
      signal: sig,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new IdentityError("unavailable");
    }
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BODY) throw new IdentityError("shape");
    body = await res.text();
  } catch (e) {
    if (e instanceof IdentityError) throw e;
    throw new IdentityError("unavailable"); // network error, TLS error, abort, timeout
  }
  if (body.length > MAX_BODY) throw new IdentityError("shape");
  const doc = parseJsonObject(body);
  if (!doc || !isObject(doc.account) || !isObject(doc.organization)) throw new IdentityError("shape");
  const { uuid: account } = doc.account;
  const { uuid: org } = doc.organization;
  if (!isUuid(account) || !isUuid(org)) throw new IdentityError("shape");
  return { account: account.toLowerCase(), org: org.toLowerCase() };
}
