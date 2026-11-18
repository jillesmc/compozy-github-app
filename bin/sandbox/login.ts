// Login handling for every provider (S10a, operator decision Q30 = c): refresh on the host BEFORE the session,
// never copy anything back after it.
//
// prepareLogin, run outside the sandbox before bwrap starts, holding the login dir's lock:
//   1. read the host login (regular file, size bound, never through a symlink); no login file: nothing to do;
//   2. ask the adapter whether it needs a refresh to stay valid for the session budget plus a margin;
//   3. if so: resolve the host login's identity, refresh through the provider's own flow with the host
//      refresh token, verify the refreshed login's identity (same account and organization; the adapter's
//      token-kind/audience checks), re-check that the lock is still ours and the host file unchanged since
//      it was read, then save exactly the set the wrapper obtained, atomically (temp + rename, mode 0600);
//   4. make the session's throwaway copy from the (possibly refreshed) host login: only the adapter's copyIn
//      files plus the marker. Whatever the session writes there is discarded with the copy.
// Any failure leaves the host login untouched and refuses to start the session (one exception, R-33: a
// same-account refreshed token shorter than the session budget is saved, and the session still refused).
// Every decision is one
// fixed-string audit line; identities appear only as short keyed hashes; no token, email or answer body.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readRegular } from "./files.ts";
import { IdentityError, RefreshError, type Identity, type ProviderAdapter } from "./adapters/types.ts";

export const MARKER = ".reviewer-sandbox";
const MAX_FILE = 4 * 1024 * 1024;
const MAX_LOGIN = 64 * 1024;
const STEP_TIMEOUT_MS = 10_000;

function statLogin(file: string): { mtimeMs: number; size: number; exists: boolean } {
  try {
    const st = fs.lstatSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size, exists: true };
  } catch {
    return { mtimeMs: 0, size: 0, exists: false };
  }
}

// Builds the session copy: only the adapter's copyIn files and the marker, regular files only.
export function copyLoginIn(adapter: ProviderAdapter, hostDir: string, copyDir: string): void {
  fs.mkdirSync(copyDir, { mode: 0o700 });
  for (const name of new Set([MARKER, ...adapter.copyIn])) {
    if (name.includes("/") || name.startsWith("..")) continue; // allowlist entries are plain file names
    const text = readRegular(path.join(hostDir, name), MAX_FILE);
    if (text !== null) fs.writeFileSync(path.join(copyDir, name), text, { mode: 0o600 });
  }
}

// Short keyed hash of an identity, for the audit log. The key is random per wrapper run, so hashes are
// comparable within one line but cannot be matched against a known account offline.
const HASH_KEY = crypto.randomBytes(32);
export function identityHash(id: Identity): string {
  return crypto.createHmac("sha256", HASH_KEY).update(`${id.account}\0${id.org ?? ""}`).digest("hex").slice(0, 12);
}

const sameIdentity = (a: Identity, b: Identity) => a.account === b.account && (a.org ?? null) === (b.org ?? null);

// ---- per-login-dir lock (R-28, R-31) ----------------------------------------------------------------
// An exclusive lock file in the dedicated login dir serializes the pre-session refresh and copy across
// wrapper processes. Fail-closed rules:
//   - publication is atomic: the token "<pid> <uuid> <epoch-ms>" is written to a private temp file that is
//     then hard-linked to the lock path (link fails with EEXIST), so a lock is never visible empty;
//   - a lock is NEVER taken over (R-31: any read-check-rename recovery can move a live replacement lock):
//     an existing lock is waited for up to the wait budget, then the session is refused ("login dir busy");
//     a lock orphaned by a crashed wrapper is removed by the operator (docs/reviewer-sandbox.md);
//   - the commit re-checks, right before its rename, that the lock still holds its own token
//     ("login lock lost" otherwise), so a lock taken away from a paused owner cannot lead to two commits.
// Node has no flock/fcntl binding without a dependency, hence the lock file.
export const LOCK_FILE = ".reviewer-sandbox.lock";
const LOCK_WAIT_MS = 60_000; // R-35: above another wrapper's worst-case refresh (three network steps of at most 10 s each)
const LOCK_POLL_MS = 25;

function tryLock(lockPath: string): string | null {
  const token = `${process.pid} ${crypto.randomUUID()} ${Date.now()}`;
  const tmp = `${lockPath}.new-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, lockPath); // atomic publication of a complete token
    return token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function ownsLock(lockPath: string, token: string): boolean {
  return readRegular(lockPath, 512) === token;
}

function unlock(lockPath: string, token: string): void {
  if (ownsLock(lockPath, token)) fs.rmSync(lockPath, { force: true });
}

// Runs `commit(owned)` while holding the login dir's lock; `owned()` re-checks ownership and must be called
// right before the commit's irreversible step. Returns null when the lock could not be taken in time.
export async function withLoginLock<T>(
  hostDir: string,
  commit: (owned: () => boolean) => T | Promise<T>,
  waitMs = LOCK_WAIT_MS,
): Promise<T | null> {
  const lockPath = path.join(hostDir, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = tryLock(lockPath);
    if (token) {
      try {
        return await commit(() => ownsLock(lockPath, token));
      } finally {
        unlock(lockPath, token);
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

// ---- pre-session refresh ----------------------------------------------------------------------------

export type Prepared = { ok: boolean; line: string };
const done = (what: string): Prepared => ({ ok: true, line: `login-refresh ${what}` });
const refused = (reason: string, extra = ""): Prepared => ({ ok: false, line: `login-refresh refused (${reason})${extra}` });
const identityReason = (e: unknown, which: string) =>
  `${e instanceof IdentityError && e.kind === "shape" ? "identity shape changed" : "identity unavailable"}: ${which}`;
const refreshReason = (e: unknown) =>
  e instanceof RefreshError ? (e.kind === "rejected" ? "refresh rejected" : e.kind === "shape" ? "refresh shape changed" : "refresh unavailable") : "refresh unavailable";

export type PrepareOptions = { untilMs: number; lockWaitMs?: number };

// Refreshes the host login if needed and builds the session copy. On refusal no copy is made.
export async function prepareLogin(adapter: ProviderAdapter, hostDir: string, copyDir: string, opts: PrepareOptions): Promise<Prepared> {
  const hostFile = path.join(hostDir, adapter.loginFile);
  let result: Prepared | null;
  try {
    result = await withLoginLock(hostDir, async (owned): Promise<Prepared> => {
      const before = statLogin(hostFile);
      const text = readRegular(hostFile, MAX_LOGIN);
      if (text === null) {
        if (before.exists) return refused("host login is not a regular file within bounds");
        copyLoginIn(adapter, hostDir, copyDir);
        return done("skipped (no login)");
      }
      let need: ReturnType<ProviderAdapter["refreshNeeded"]>;
      try {
        need = adapter.refreshNeeded(text, opts.untilMs);
      } catch {
        return refused("host login shape changed");
      }
      if (need !== "refresh") {
        copyLoginIn(adapter, hostDir, copyDir);
        return done(need === "valid" ? "skipped (token valid)" : "skipped (not refreshable)");
      }
      let start: Identity;
      try {
        const signal = AbortSignal.timeout(STEP_TIMEOUT_MS);
        start = adapter.startIdentity ? await adapter.startIdentity(hostDir, signal) : await adapter.identity(hostFile, signal);
      } catch (e) {
        return refused(identityReason(e, "host login"));
      }
      let next: string;
      try {
        next = await adapter.refresh(text, AbortSignal.timeout(STEP_TIMEOUT_MS));
      } catch (e) {
        return refused(refreshReason(e));
      }
      if (Buffer.byteLength(next) > MAX_LOGIN) return refused("refresh shape changed");
      const tmp = `${hostFile}.reviewer-sandbox-${process.pid}-${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, next, { mode: 0o600, flag: "wx" });
        fs.chmodSync(tmp, 0o600);
        let refreshed: Identity;
        try {
          refreshed = await adapter.identity(tmp, AbortSignal.timeout(STEP_TIMEOUT_MS));
        } catch (e) {
          return refused(identityReason(e, "refreshed login"));
        }
        if (!sameIdentity(refreshed, start)) {
          return refused("identity mismatch", ` before=${identityHash(start)} refreshed=${identityHash(refreshed)}`);
        }
        // R-33: a refreshed token that does not cover the session budget would make the CLI refresh inside the
        // session, where the result is discarded (and a rotating provider invalidates the saved refresh token).
        let covers: boolean;
        try {
          covers = adapter.refreshNeeded(next, opts.untilMs) !== "refresh";
        } catch {
          return refused("refresh shape changed");
        }
        if (!owned()) return refused("login lock lost");
        const now = statLogin(hostFile);
        if (readRegular(hostFile, MAX_LOGIN) !== text || now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
          return refused("host login changed during refresh");
        }
        fs.renameSync(tmp, hostFile);
        // Saved either way: the provider may already have rotated the old refresh token.
        if (!covers) return refused("refreshed token shorter than the session budget; saved, session not started");
        copyLoginIn(adapter, hostDir, copyDir);
        return done(`refreshed (same account) id=${identityHash(refreshed)}`);
      } finally {
        fs.rmSync(tmp, { force: true }); // gone after the rename; removes the candidate on every refusal
      }
    }, opts.lockWaitMs);
  } catch {
    return refused("internal error");
  }
  return result ?? refused("login dir busy");
}
