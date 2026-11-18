// Codex account identity (ADR-004, R-18). Undocumented contract, isolated here and validated strictly.
//
// Login file: $CODEX_HOME/auth.json, as written by the Codex CLI (`AuthDotJson`): `auth_mode`,
// `OPENAI_API_KEY`, `tokens` {id_token, access_token, refresh_token, account_id}, `last_refresh`, and other
// credential kinds (`personal_access_token`, `agent_identity`, `bedrock_*`).
//
// ChatGPT login mode: `tokens.id_token` and `tokens.access_token` are RS256 JWTs issued by
// https://auth.openai.com (OIDC discovery: jwks_uri https://auth.openai.com/.well-known/jwks.json, RS256
// only). Their claims are trusted ONLY after the signature verifies against that JWKS, fetched outside the
// sandbox. Identity = the `https://api.openai.com/auth` claim object of the id_token:
//   account = chatgpt_user_id (or user_id), org = chatgpt_account_id.
// The id_token must have iss = https://auth.openai.com and the Codex CLI client id in aud; the access_token
// must be signed by the same issuer and carry the same chatgpt_account_id (and user id, when present).
// R-30: the two tokens are checked against their own contracts. The access token is an API bearer token:
// its `aud` must include the API audience https://api.openai.com/v1 (the base URL the CLI sends it to) and
// must NOT be the CLI client id (that is the ID-token audience); it must also differ from the ID token. An
// ID token presented as the access token, or any other audience, is a shape change.
// `exp` is deliberately NOT checked: this is an identity comparison, not an authentication, and the host
// copy's tokens are usually expired by the time a refresh happens.
//
// API-key mode and every other credential kind carry no verifiable identity: always "unavailable" (API-key
// logins are not refreshed, so identity is never needed for them). A ChatGPT login that
// also carries another credential kind is a shape change. Nothing from tokens or the JWKS is ever logged.
import crypto from "node:crypto";
import { parseJsonObject } from "../files.ts";
import { IdentityError, type Identity } from "./types.ts";

export const ISSUER = "https://auth.openai.com";
export const DEFAULT_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // the Codex CLI's OAuth client id
export const AUTH_CLAIM = "https://api.openai.com/auth";
export const API_AUDIENCE = "https://api.openai.com/v1"; // access-token audience
export const DEFAULT_TIMEOUT_MS = 5000;
const MAX_JWKS = 256 * 1024;
const OTHER_CREDENTIALS = ["OPENAI_API_KEY", "personal_access_token", "agent_identity", "bedrock_api_key", "bedrock_access_keys"];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const shape = () => new IdentityError("shape");

// The two tokens of a ChatGPT-mode auth.json; throws "unavailable" for API-key and other modes.
export function chatgptTokens(authText: string): { idToken: string; accessToken: string } {
  const doc = parseJsonObject(authText);
  if (!doc) throw shape();
  if (doc.auth_mode !== undefined && doc.auth_mode !== null && doc.auth_mode !== "chatgpt") throw new IdentityError("unavailable");
  const tokens = doc.tokens;
  if (tokens === undefined || tokens === null) throw new IdentityError("unavailable"); // API-key login
  for (const k of OTHER_CREDENTIALS) if (doc[k] !== undefined && doc[k] !== null) throw shape();
  if (!isObject(tokens) || !nonEmpty(tokens.id_token) || !nonEmpty(tokens.access_token)) throw shape();
  return { idToken: tokens.id_token, accessToken: tokens.access_token };
}

type Jwt = { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer };

export function decodeJwt(token: string): Jwt {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw shape();
  const [h, p, s] = parts as [string, string, string];
  const header = parseJsonObject(Buffer.from(h, "base64url").toString("utf8"));
  const payload = parseJsonObject(Buffer.from(p, "base64url").toString("utf8"));
  if (!header || !payload) throw shape();
  return { header, payload, signingInput: `${h}.${p}`, signature: Buffer.from(s, "base64url") };
}

export type JwksOptions = { jwksUrl?: string; fetch?: typeof fetch; timeoutMs?: number };

// The issuer's RSA signing keys by kid. Fetched outside the sandbox; any deviation is fatal.
export async function fetchJwks(opts: JwksOptions, signal: AbortSignal): Promise<Map<string, crypto.KeyObject>> {
  const f = opts.fetch ?? fetch;
  const sig = AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)]);
  let body: string;
  try {
    const res = await f(new URL(opts.jwksUrl ?? DEFAULT_JWKS_URL), { method: "GET", headers: { Accept: "application/json" }, redirect: "manual", signal: sig });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new IdentityError("unavailable");
    }
    if (Number(res.headers.get("content-length") ?? 0) > MAX_JWKS) throw shape();
    body = await res.text();
  } catch (e) {
    if (e instanceof IdentityError) throw e;
    throw new IdentityError("unavailable");
  }
  if (body.length > MAX_JWKS) throw shape();
  const keys = parseJsonObject(body)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw shape();
  const out = new Map<string, crypto.KeyObject>();
  for (const k of keys) {
    if (!isObject(k) || !nonEmpty(k.kid) || k.kty !== "RSA" || !nonEmpty(k.n) || !nonEmpty(k.e)) throw shape();
    if (k.alg !== undefined && k.alg !== "RS256") continue;
    if (k.use !== undefined && k.use !== "sig") continue;
    try {
      out.set(k.kid, crypto.createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" }));
    } catch {
      throw shape();
    }
  }
  if (out.size === 0) throw shape();
  return out;
}

// Verifies an RS256 signature against the JWKS and returns the payload. `exp` is not checked (see above).
export function verifyJwt(token: string, keys: Map<string, crypto.KeyObject>): Record<string, unknown> {
  const jwt = decodeJwt(token);
  if (jwt.header.alg !== "RS256" || !nonEmpty(jwt.header.kid)) throw shape();
  const key = keys.get(jwt.header.kid);
  if (!key) throw new IdentityError("unavailable"); // unknown kid: rotated away or not the issuer's
  if (!crypto.verify("sha256", Buffer.from(jwt.signingInput), key, jwt.signature)) throw shape();
  if (jwt.payload.iss !== ISSUER) throw shape();
  return jwt.payload;
}

function authClaims(payload: Record<string, unknown>): { user?: string; org: string } {
  const auth = payload[AUTH_CLAIM];
  if (!isObject(auth) || !nonEmpty(auth.chatgpt_account_id)) throw shape();
  const user = nonEmpty(auth.chatgpt_user_id) ? auth.chatgpt_user_id : nonEmpty(auth.user_id) ? auth.user_id : undefined;
  return { user, org: auth.chatgpt_account_id };
}

export async function codexIdentity(authText: string, opts: JwksOptions, signal: AbortSignal): Promise<Identity> {
  const { idToken, accessToken } = chatgptTokens(authText);
  const keys = await fetchJwks(opts, signal);
  const id = verifyJwt(idToken, keys);
  const aud = id.aud;
  if (!(aud === CODEX_CLIENT_ID || (Array.isArray(aud) && aud.includes(CODEX_CLIENT_ID)))) throw shape();
  const idClaims = authClaims(id);
  if (!idClaims.user) throw shape();
  if (accessToken === idToken) throw shape();
  const at = verifyJwt(accessToken, keys);
  const atAud = Array.isArray(at.aud) ? at.aud : [at.aud];
  if (!atAud.includes(API_AUDIENCE) || atAud.includes(CODEX_CLIENT_ID)) throw shape();
  const atClaims = authClaims(at);
  if (atClaims.org !== idClaims.org || (atClaims.user !== undefined && atClaims.user !== idClaims.user)) throw shape();
  return { account: idClaims.user, org: idClaims.org };
}
