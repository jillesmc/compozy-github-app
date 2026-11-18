// `codex` provider adapter: @agentclientprotocol/codex-acp + the Codex CLI it drives (ADR-004).
//
// codex-acp (ACP mode) spawns `$CODEX_PATH app-server` when CODEX_PATH is set, else the bundled
// `@openai/codex/bin/codex.js` with the current node, which execs the native binary of the
// `@openai/codex-linux-x64` package. The sandbox env never carries CODEX_PATH, so the binary always comes
// from the read-only ACP prefix, never from the host's PATH.
import path from "node:path";
import { readRegular } from "../files.ts";
import { IN } from "../profile.ts";
import { codexIdentity } from "./codex-identity.ts";
import { codexRefresh, codexRefreshNeeded } from "./codex-refresh.ts";
import { IdentityError, type AdapterOptions, type ProviderAdapter } from "./types.ts";

export const CODEX_ACP_ENTRY = "node_modules/@agentclientprotocol/codex-acp/dist/index.js";
const LOGIN_FILE = "auth.json";
const MAX_LOGIN = 64 * 1024;

// Synthetic, well-shaped (but unsigned) values for the self-check only: never real tokens or accounts.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (tag: string) =>
  `${b64({ alg: "RS256", kid: "self-check" })}.${b64({
    iss: "https://auth.openai.com",
    aud: ["app_EMoamEEZ73f0CkXaXp7hrann"],
    "https://api.openai.com/auth": { chatgpt_user_id: `user-self-check-${tag}`, chatgpt_account_id: "00000000-0000-4000-8000-00000000c001" },
  })}.${Buffer.from(`self-check-${tag}`).toString("base64url")}`;
const fakeLogin = (tag: string) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: fakeJwt(tag), access_token: fakeJwt(`${tag}-access`), refresh_token: `self-check-${tag}-refresh`, account_id: "00000000-0000-4000-8000-00000000c001" },
    last_refresh: "2026-01-01T00:00:00Z",
  });

export function codexAdapter(opts: AdapterOptions = {}): ProviderAdapter {
  return {
    id: "codex",
    acpCommand: (prefix) => [IN.node, path.posix.join(prefix, CODEX_ACP_ENTRY)],
    configEnv: (copyDir) => ({ CODEX_HOME: copyDir }),
    // auth.json is the login; config.toml (optional) carries the operator's model and opt-out settings.
    copyIn: [LOGIN_FILE, "config.toml"],
    loginFile: LOGIN_FILE,
    // PROVISIONAL, from the Codex CLI 0.166 code; confirmed by IT-020 (operator-assisted):
    //   chatgpt.com      ChatGPT-mode model traffic (https://chatgpt.com/backend-api/codex)
    //   auth.openai.com  token refresh (https://auth.openai.com/oauth/token)
    //   api.openai.com   API-key-mode model traffic (https://api.openai.com/v1)
    // Left out: ab.chatgpt.com (OTLP metrics), update checks, docs and help hosts.
    egressHosts: ["chatgpt.com", "auth.openai.com", "api.openai.com"],
    async identity(loginFile, signal) {
      const text = readRegular(loginFile, MAX_LOGIN);
      if (text === null) throw new IdentityError("unavailable");
      return codexIdentity(text, { jwksUrl: opts.identityBaseUrl ? new URL("/.well-known/jwks.json", opts.identityBaseUrl).href : undefined, fetch: opts.fetch, timeoutMs: opts.timeoutMs }, signal);
    },
    refreshNeeded: codexRefreshNeeded,
    refresh: (loginText, signal) =>
      codexRefresh(loginText, { tokenUrl: opts.refreshBaseUrl ? new URL("/oauth/token", opts.refreshBaseUrl).href : undefined, fetch: opts.fetch, timeoutMs: opts.timeoutMs }, signal),
    selfCheckFixture: () => ({ files: { [LOGIN_FILE]: fakeLogin("host") }, forgedLogin: fakeLogin("forged") }),
  };
}
