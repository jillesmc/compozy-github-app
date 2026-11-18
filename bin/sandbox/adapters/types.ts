// Provider adapter contract (ADR-004, S10a). The sandbox core (bwrap, gateway, ACP guard, pre-session refresh,
// per-session login copy, audit log, self-check) is provider-neutral; an adapter supplies only what differs
// per provider CLI.

export type ProviderId = "claude" | "codex" | "cursor";

// An account identity as resolved by the provider. Compared with deep equality; logged only as keyed hashes.
export type Identity = { account: string; org?: string };

// Why an identity could not be resolved. Each kind maps to one fixed audit reason.
//   unavailable: missing/unreadable login, network error, timeout, non-200 answer.
//   shape:       the login file or the provider's answer does not have the expected shape.
export class IdentityError extends Error {
  readonly kind: "unavailable" | "shape";
  constructor(kind: "unavailable" | "shape") {
    super(`identity ${kind}`);
    this.kind = kind;
  }
}

// Why a pre-session refresh failed. Each kind maps to one fixed audit reason (S10a).
//   rejected:    the provider answered 4xx (expired, revoked or reused refresh token, bad client).
//   unavailable: network error, timeout, 5xx, redirect, or the adapter cannot refresh (not implemented).
//   shape:       the host login or the provider's answer does not have the expected shape.
export class RefreshError extends Error {
  readonly kind: "rejected" | "unavailable" | "shape";
  constructor(kind: "rejected" | "unavailable" | "shape", message?: string) {
    super(message ?? `refresh ${kind}`);
    this.kind = kind;
  }
}

// What a host login needs before a session: a refresh, nothing (still valid long enough), or nothing because
// it cannot be refreshed at all (API-key mode, no OAuth login).
export type RefreshNeed = "refresh" | "valid" | "not-refreshable";

export interface ProviderAdapter {
  id: ProviderId;
  /** ACP command run inside the sandbox, rooted at the read-only ACP install prefix mounted at `prefix`. */
  acpCommand(prefix: string): string[];
  /** Env pointing the CLI at the per-session login copy (mounted at `copyDir` inside the sandbox). */
  configEnv(copyDir: string): Record<string, string>;
  /** Files of the dedicated login dir copied into the per-session copy (regular files only, by name). */
  copyIn: string[];
  /**
   * The login file. It is refreshed, if needed, on the host before the session (outside the sandbox) and then
   * copied in like the other copyIn files. Nothing a session writes ever comes back (S10a).
   */
  loginFile: string;
  /**
   * Optional: absolute path inside the sandbox, under /home/reviewer, where the per-session login copy is
   * bound, for a CLI whose login lives at a fixed leaf (e.g. `$XDG_CONFIG_HOME/cursor`). Default: IN.login.
   * `configEnv` receives this path as `copyDir`.
   */
  loginMount?: string;
  /** Egress allowed through the gateway: CONNECT host:443 only. */
  egressHosts: string[];
  /**
   * Optional: extra agent->client JSON-RPC method names (requests or notifications) the ACP guard forwards in
   * addition to the core allowlist. Never fs/*, terminal/* or anything else that makes the client act on the host.
   */
  extraAgentMethods?: string[];
  /**
   * Account identity of a login file, resolved OUTSIDE the sandbox (may call the provider). Used to check that
   * a refreshed login belongs to the same account and organization as the host login before the refresh.
   */
  identity(loginFile: string, signal: AbortSignal): Promise<Identity>;
  /**
   * Identity of the dedicated host login before a refresh, resolved outside the sandbox. Defaults to
   * identity(<loginDir>/<loginFile>); an adapter whose expired access token cannot be resolved online reads a
   * host-only record instead (e.g. claude's `.claude.json` oauthAccount).
   */
  startIdentity?(loginDir: string, signal: AbortSignal): Promise<Identity>;
  /**
   * Pure: does this host login need a refresh to stay valid until `untilMs` (epoch ms)? A missing or
   * unparsable expiry means "refresh"; a login with nothing to refresh (API key) means "not-refreshable".
   */
  refreshNeeded(loginText: string, untilMs: number): RefreshNeed;
  /**
   * Refreshes the host login OUTSIDE the sandbox through the provider's own flow, with the host login's
   * refresh token, and returns the complete new login file text: the new token set merged into the host
   * file's other fields exactly where the CLI itself keeps them. Throws RefreshError on any failure.
   */
  refresh(loginText: string, signal: AbortSignal): Promise<string>;
  /**
   * Self-check fixture: synthetic files for a temporary host login dir whose login needs a refresh (with a
   * known start identity), and a forged, well-shaped login that a probe writes inside the sandbox. Never
   * real tokens.
   */
  selfCheckFixture(): { files: Record<string, string>; forgedLogin: string };
}

// Options every adapter factory accepts; the self-check and tests point identity and refresh at local endpoints.
export type AdapterOptions = { identityBaseUrl?: string; refreshBaseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
