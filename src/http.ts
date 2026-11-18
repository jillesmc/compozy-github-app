import { reviewError } from "./errors.ts";
import { networkFailureReason } from "./system-ca.ts";

export const REQUEST_TIMEOUT_MS = 10_000;

export interface HttpDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: any;
}

/** One GitHub call: JSON in and out, no redirects, network failures as `github_unavailable`. */
export async function send(
  url: string,
  init: { method: string; authorization: string; body?: unknown },
  deps: HttpDeps
): Promise<HttpResponse> {
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url, {
      method: init.method,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: init.authorization,
        "user-agent": "compozy-github-app-review",
        "x-github-api-version": "2022-11-28",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    const timedOut = (error as { name?: string }).name === "TimeoutError";
    throw reviewError("github_unavailable", timedOut ? "GitHub did not answer in time" : `GitHub unreachable: ${networkFailureReason(error)}`);
  }
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}

/** GitHub's own message, bounded; never echoes request content. */
export function githubMessage(response: HttpResponse): string {
  const message = typeof response.body?.message === "string" ? response.body.message : `HTTP ${response.status}`;
  const details = Array.isArray(response.body?.errors)
    ? response.body.errors.map((entry: any) => (typeof entry === "string" ? entry : entry?.message ?? entry?.code)).filter(Boolean)
    : [];
  return [message, ...details].join("; ").slice(0, 500);
}

/** 403/429 rate limits → `rate_limited` with the ISO reset time; otherwise undefined. */
export function rateLimit(response: HttpResponse, now: () => number): Error | undefined {
  if (response.status !== 429 && response.status !== 403) return undefined;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(response.headers.get("retry-after"));
  if (response.status === 403 && remaining !== "0" && !retryAfter) return undefined;
  const at = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now() + (retryAfter > 0 ? retryAfter * 1000 : 60_000);
  return reviewError("rate_limited", `GitHub rate limit; resets at ${new Date(at).toISOString()}`, response.status);
}

/** Generic mapping of a failed answer (callers handle 401 and the codes they own first). */
export function failure(response: HttpResponse, now: () => number): Error {
  const limited = rateLimit(response, now);
  if (limited) return limited;
  if (response.status >= 500) return reviewError("github_unavailable", `GitHub answered ${response.status}`, response.status);
  return reviewError("github_rejected", `GitHub ${response.status}: ${githubMessage(response)}`, response.status);
}
