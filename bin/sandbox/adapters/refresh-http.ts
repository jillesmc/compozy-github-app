// Shared token-endpoint call for the adapters' pre-session refresh (S10a). Runs on the host, outside the
// sandbox. Short timeout, never follows redirects, bounded body, JSON object only. Maps every failure to a
// RefreshError kind; nothing from the request or the answer is ever logged.
import { parseJsonObject } from "../files.ts";
import { RefreshError } from "./types.ts";

export const DEFAULT_REFRESH_TIMEOUT_MS = 8000;
const MAX_BODY = 64 * 1024;

export type RefreshHttpOptions = { fetch?: typeof fetch; timeoutMs?: number };

export async function postForJson(
  url: URL,
  body: string,
  contentType: string,
  opts: RefreshHttpOptions,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const f = opts.fetch ?? fetch;
  const sig = AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS)]);
  let text: string;
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "Content-Type": contentType, Accept: "application/json", "User-Agent": "reviewer-sandbox" },
      body,
      redirect: "manual",
      signal: sig,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new RefreshError(res.status >= 400 && res.status < 500 ? "rejected" : "unavailable");
    }
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BODY) throw new RefreshError("shape");
    text = await res.text();
  } catch (e) {
    if (e instanceof RefreshError) throw e;
    throw new RefreshError("unavailable"); // network error, TLS error, abort, timeout
  }
  if (text.length > MAX_BODY) throw new RefreshError("shape");
  const doc = parseJsonObject(text);
  if (!doc) throw new RefreshError("shape");
  return doc;
}

export const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 16 * 1024;
export const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
