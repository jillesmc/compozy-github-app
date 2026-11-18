// Cursor account identity (ADR-004). Undocumented contract, isolated here and validated strictly.
//
// Endpoint, as called by `cursor-agent status` (alias `whoami`), by `cursor-agent login` and by the CLI's own
// startup (cursor-agent 2026.10.16-e3cb207, API base https://api2.cursor.sh): the Connect unary RPC
//   POST <base>/aiserver.v1.DashboardService/GetMe
//   Authorization: Bearer <accessToken of auth.json>, Content-Type: application/proto,
//   Connect-Protocol-Version: 1, x-cursor-client-type: cli; body: an empty GetMeRequest (zero bytes)
//   200 application/proto -> GetMeResponse { 1 auth_id string, 2 user_id int32, ..., 7 team_id int32? }
// Only auth_id, user_id and team_id are read: account = auth_id (user_id must be a positive int32),
// org = team_id when present. Any other status, a network error or a timeout is "unavailable"; any
// deviation from that shape (content type, wire types, duplicates, missing fields, bad UTF-8, size) is
// "shape". Nothing from the answer is ever logged.
//
// Start identity: the dedicated login dir's `cli-config.json` `authInfo` {authId, userId, teamId?}, written by
// `cursor-agent login` on the host from the same GetMe answer. Read offline, before bwrap starts. The sandbox
// can never write that file: it is not copied in, and nothing is ever copied back (S10a).
import { IdentityError, type Identity } from "./types.ts";
import { parseJsonObject } from "../files.ts";

export const DEFAULT_BASE_URL = "https://api2.cursor.sh";
export const GET_ME_PATH = "/aiserver.v1.DashboardService/GetMe";
export const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BODY = 64 * 1024;
const MAX_TOKEN = 16 * 1024;
const MAX_AUTH_ID = 512;
const INT32_MAX = 2 ** 31 - 1;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isUserId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= INT32_MAX;
// An auth id is a provider subject such as `auth0|user_...` or `google-oauth2|...`: printable, no spaces.
const isAuthId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_AUTH_ID && /^[\x21-\x7e]+$/.test(v);

const identityOf = (authId: string, teamId: number | undefined): Identity =>
  teamId === undefined ? { account: authId } : { account: authId, org: String(teamId) };

// Fields of a browser-login `auth.json` (R-29). The CLI's file store writes {accessToken, refreshToken,
// apiKey, bedrockCredentials}; `cursor-agent login` calls setAuthentication(accessToken, refreshToken) with no
// API key, and JSON drops the undefined `apiKey`/`bedrockCredentials`. Only GetMe verifies `accessToken`, so
// any other credential material (an `apiKey`, which makes LOGIN-mode startup clear the login; Bedrock keys;
// any unknown key) cannot be vouched for and is a shape change: the login is refused.
export const BROWSER_LOGIN_FIELDS: readonly string[] = ["accessToken", "refreshToken"];

const isToken = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_TOKEN && !/[\s\x00-\x1f]/.test(v);

// The OAuth access token of a browser-login Cursor login file: exactly `accessToken` and an optional
// `refreshToken`, both well-formed token strings; anything else is a shape change.
export function accessTokenOf(loginText: string): string {
  const doc = parseJsonObject(loginText);
  if (!doc || Object.keys(doc).some((k) => !BROWSER_LOGIN_FIELDS.includes(k))) throw new IdentityError("shape");
  if (!isToken(doc.accessToken) || (doc.refreshToken !== undefined && !isToken(doc.refreshToken))) {
    throw new IdentityError("shape");
  }
  return doc.accessToken;
}

// Identity recorded by `cursor-agent login` in `cli-config.json` (`authInfo`).
export function authInfoIdentity(cliConfigText: string): Identity {
  const doc = parseJsonObject(cliConfigText);
  if (!doc) throw new IdentityError("shape");
  const info = doc.authInfo;
  if (info === undefined) throw new IdentityError("unavailable");
  if (!isObject(info) || !isAuthId(info.authId) || !isUserId(info.userId)) throw new IdentityError("shape");
  if (info.teamId !== undefined && !isUserId(info.teamId)) throw new IdentityError("shape");
  return identityOf(info.authId, info.teamId as number | undefined);
}

// ---- strict protobuf reader for GetMeResponse ----------------------------------------------------------

function varint(buf: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 10; i++) {
    const b = buf[at + i];
    if (b === undefined) throw new IdentityError("shape");
    value += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) {
      if (!Number.isSafeInteger(value)) throw new IdentityError("shape");
      return [value, at + i + 1];
    }
  }
  throw new IdentityError("shape");
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

// Decodes the three fields read; unknown fields are skipped by wire type. Duplicates, groups, a known field
// with the wrong wire type, a truncated message or a missing auth_id/user_id are a shape change.
export function decodeGetMe(buf: Uint8Array): Identity {
  const seen = new Set<number>();
  let authId: unknown;
  let userId: unknown;
  let teamId: number | undefined;
  let at = 0;
  while (at < buf.length) {
    const [key, next] = varint(buf, at);
    at = next;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 0) throw new IdentityError("shape");
    const known = field === 1 || field === 2 || field === 7;
    if (known && seen.has(field)) throw new IdentityError("shape");
    seen.add(field);
    if (wire === 0) {
      const [v, n] = varint(buf, at);
      at = n;
      if (field === 1) throw new IdentityError("shape");
      if (field === 2) userId = v;
      if (field === 7) {
        if (!isUserId(v)) throw new IdentityError("shape");
        teamId = v;
      }
    } else if (wire === 2) {
      const [len, n] = varint(buf, at);
      if (n + len > buf.length) throw new IdentityError("shape");
      if (field === 2 || field === 7) throw new IdentityError("shape");
      if (field === 1) {
        try {
          authId = utf8.decode(buf.subarray(n, n + len));
        } catch {
          throw new IdentityError("shape");
        }
      }
      at = n + len;
    } else if (wire === 1 || wire === 5) {
      if (known) throw new IdentityError("shape");
      at += wire === 1 ? 8 : 4;
      if (at > buf.length) throw new IdentityError("shape");
    } else {
      throw new IdentityError("shape"); // groups (3, 4) and invalid wire types
    }
  }
  if (!isAuthId(authId) || !isUserId(userId)) throw new IdentityError("shape");
  return identityOf(authId, teamId);
}

export type GetMeOptions = { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };

// Asks Cursor who owns `accessToken`. Never follows redirects; never logs anything.
export async function getMeIdentity(accessToken: string, opts: GetMeOptions, signal: AbortSignal): Promise<Identity> {
  const f = opts.fetch ?? fetch;
  const url = new URL(GET_ME_PATH, opts.baseUrl ?? DEFAULT_BASE_URL);
  const sig = AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)]);
  let body: Uint8Array;
  try {
    const res = await f(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/proto",
        "Connect-Protocol-Version": "1",
        "x-cursor-client-type": "cli",
        "x-ghost-mode": "true",
        "User-Agent": "reviewer-sandbox",
      },
      body: new Uint8Array(0),
      redirect: "manual",
      signal: sig,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new IdentityError("unavailable");
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/proto" || Number(res.headers.get("content-length") ?? 0) > MAX_BODY) {
      await res.body?.cancel().catch(() => {});
      throw new IdentityError("shape");
    }
    body = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof IdentityError) throw e;
    throw new IdentityError("unavailable"); // network error, TLS error, abort, timeout
  }
  if (body.length > MAX_BODY) throw new IdentityError("shape");
  return decodeGetMe(body);
}
