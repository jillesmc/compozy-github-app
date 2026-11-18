// `cursor` provider adapter: `cursor-agent acp` from a pinned copy of the cursor-agent package (ADR-004).
//
// Login location (read from the CLI, not documented): on Linux the CLI always uses a file store at
// `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json` ({accessToken, refreshToken, apiKey?}) and its config dir
// `$XDG_CONFIG_HOME/cursor` (cli-config.json). The leaf `cursor/` is fixed, so the adapter asks the core to
// bind the session copy at /home/reviewer/.config/cursor (`loginMount`) and sets XDG_CONFIG_HOME to its parent.
//
// ACP: the agent sends Cursor extension requests to the client after tool calls (`cursor/update_todos`,
// `cursor/task`) and for questions/plans (`cursor/ask_question`, `cursor/create_plan`, `cursor/generate_image`).
// They carry data only; a client that does not serve them answers -32601 and the agent falls back.
import path from "node:path";
import { readRegular } from "../files.ts";
import { IN } from "../profile.ts";
import { accessTokenOf, authInfoIdentity, getMeIdentity } from "./cursor-identity.ts";
import { IdentityError, RefreshError, type AdapterOptions, type ProviderAdapter, type RefreshNeed } from "./types.ts";

export const CURSOR_AGENT_VERSION = "2026.10.16-e3cb207";
const LOGIN_FILE = "auth.json";
const CONFIG_FILE = "cli-config.json";
const MAX_LOGIN = 64 * 1024;
const MAX_CONFIG = 1024 * 1024;
export const CURSOR_LOGIN_MOUNT = path.posix.join(IN.home, ".config", "cursor");

// Synthetic, well-shaped values for the self-check only: never real tokens or accounts.
const fakeLogin = (tag: string) =>
  JSON.stringify({ accessToken: `self-check-${tag}-access`, refreshToken: `self-check-${tag}-refresh` });

// Pre-session refresh (S10b): the pinned cursor-agent 2026.10.16-e3cb207 has NO browser-login refresh flow.
// Its stored `refreshToken` is only checked for presence (status, about, ACP auth) and never sent anywhere;
// the only renewal it does is API-key exchange (`POST <api>/auth/exchange_user_api_key`), which R-29 forbids
// for the reviewer login. Its ACP LOGIN-mode auth check treats an access token with < 300 s left as logged
// out. So the access token's JWT `exp` (unverified, only to decide) is compared with the session budget plus
// margin, and `refresh` always refuses: the operator logs in again on the host (docs, Cursor step 2).
export function cursorRefreshNeeded(loginText: string, untilMs: number): RefreshNeed {
  let doc: unknown;
  try {
    doc = JSON.parse(loginText);
  } catch {
    return "refresh";
  }
  const access = (doc as { accessToken?: unknown } | null)?.accessToken;
  if (typeof access !== "string" || access.length === 0) return "not-refreshable";
  try {
    const exp = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8"))?.exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp * 1000 > untilMs ? "valid" : "refresh";
  } catch {
    return "refresh";
  }
}

export function cursorAdapter(opts: AdapterOptions = {}): ProviderAdapter {
  return {
    id: "cursor",
    acpCommand: (prefix) => [path.posix.join(prefix, "cursor-agent"), "acp"],
    configEnv: (copyDir) => {
      if (path.posix.basename(copyDir) !== "cursor") throw new Error(`cursor login copy must be mounted at .../cursor, not ${copyDir}`);
      return {
        XDG_CONFIG_HOME: path.posix.dirname(copyDir),
        NO_OPEN_BROWSER: "1", // the login flow must never try to open a browser inside
      };
    },
    loginMount: CURSOR_LOGIN_MOUNT,
    copyIn: [LOGIN_FILE],
    loginFile: LOGIN_FILE,
    // PROVISIONAL until confirmed by IT-020 (operator-assisted): the API host of a session (auth, dashboard,
    // agent service) per the CLI's service-urls (prod apiUrl). Left out on purpose: api3.cursor.sh (metrics),
    // *.ingest.us.sentry.io (crash reports), statsig hosts, cursor.com/downloads.cursor.com (website, updates),
    // repo42.cursor.sh (repository indexing), api2direct.cursor.sh (private-worker bridge).
    egressHosts: ["api2.cursor.sh"],
    extraAgentMethods: ["cursor/update_todos", "cursor/task", "cursor/ask_question", "cursor/create_plan", "cursor/generate_image"],
    async identity(loginFile, signal) {
      const text = readRegular(loginFile, MAX_LOGIN);
      if (text === null) throw new IdentityError("unavailable");
      return getMeIdentity(accessTokenOf(text), { baseUrl: opts.identityBaseUrl, fetch: opts.fetch, timeoutMs: opts.timeoutMs }, signal);
    },
    async startIdentity(loginDir) {
      // The host login must itself be a browser login (R-29): an API key or other credential there refuses.
      const login = readRegular(path.join(loginDir, LOGIN_FILE), MAX_LOGIN);
      if (login === null) throw new IdentityError("unavailable");
      accessTokenOf(login);
      const text = readRegular(path.join(loginDir, CONFIG_FILE), MAX_CONFIG);
      if (text === null) throw new IdentityError("unavailable");
      return authInfoIdentity(text);
    },
    refreshNeeded: cursorRefreshNeeded,
    refresh: async () => {
      throw new RefreshError("unavailable", "cursor-agent has no browser-login refresh flow; log in again on the host");
    },
    selfCheckFixture: () => ({
      files: {
        [LOGIN_FILE]: fakeLogin("host"),
        [CONFIG_FILE]: JSON.stringify({ version: 1, authInfo: { authId: "auth0|user_self_check_0001", userId: 100001, teamId: 200001 } }),
      },
      forgedLogin: fakeLogin("forged"),
    }),
  };
}
