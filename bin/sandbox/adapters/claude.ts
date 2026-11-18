// `claude` provider adapter: claude-agent-acp + the Claude Code CLI it drives (ADR-004).
import path from "node:path";
import { readRegular } from "../files.ts";
import { IN } from "../profile.ts";
import { accessTokenOf, oauthAccountIdentity, profileIdentity } from "./claude-identity.ts";
import { claudeRefresh, claudeRefreshNeeded } from "./claude-refresh.ts";
import { IdentityError, type AdapterOptions, type ProviderAdapter } from "./types.ts";

export const CLAUDE_ACP_ENTRY = "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
const LOGIN_FILE = ".credentials.json";
const STATE_FILE = ".claude.json";
const MAX_LOGIN = 64 * 1024;
const MAX_STATE = 4 * 1024 * 1024;

// Synthetic, well-shaped values for the self-check only: never real tokens or accounts.
const FIXTURE_ACCOUNT = "00000000-0000-4000-8000-00000000a001";
const FIXTURE_ORG = "00000000-0000-4000-8000-00000000b001";
const fakeLogin = (tag: string) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `self-check-${tag}-access`,
      refreshToken: `self-check-${tag}-refresh`,
      expiresAt: 1, // expired: the self-check exercises the refresh refusal path
      scopes: ["user:inference"],
      subscriptionType: "team",
    },
  });

export function claudeAdapter(opts: AdapterOptions = {}): ProviderAdapter {
  return {
    id: "claude",
    acpCommand: (prefix) => [IN.node, path.posix.join(prefix, CLAUDE_ACP_ENTRY)],
    configEnv: (copyDir) => ({
      CLAUDE_CONFIG_DIR: copyDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }),
    copyIn: [LOGIN_FILE, STATE_FILE],
    loginFile: LOGIN_FILE,
    egressHosts: ["api.anthropic.com"],
    async identity(loginFile, signal) {
      const text = readRegular(loginFile, MAX_LOGIN);
      if (text === null) throw new IdentityError("unavailable");
      return profileIdentity(accessTokenOf(text), { baseUrl: opts.identityBaseUrl, fetch: opts.fetch, timeoutMs: opts.timeoutMs }, signal);
    },
    async startIdentity(loginDir) {
      const text = readRegular(path.join(loginDir, STATE_FILE), MAX_STATE);
      if (text === null) throw new IdentityError("unavailable");
      return oauthAccountIdentity(text);
    },
    refreshNeeded: claudeRefreshNeeded,
    refresh: (loginText, signal) =>
      claudeRefresh(loginText, { tokenUrl: opts.refreshBaseUrl ? new URL("/v1/oauth/token", opts.refreshBaseUrl).href : undefined, fetch: opts.fetch, timeoutMs: opts.timeoutMs }, signal),
    selfCheckFixture: () => ({
      files: {
        [LOGIN_FILE]: fakeLogin("host"),
        [STATE_FILE]: JSON.stringify({ oauthAccount: { accountUuid: FIXTURE_ACCOUNT, organizationUuid: FIXTURE_ORG } }),
      },
      forgedLogin: fakeLogin("forged"),
    }),
  };
}
