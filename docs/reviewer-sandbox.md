# Reviewer sandbox

`bin/reviewer-sandbox` runs the reviewer agent's ACP agent inside bubblewrap with **no network**. Its only
way out is a per-sandbox `bin/reviewer-gateway`, which passes exactly two kinds of destinations:

- `CONNECT <host>:443` for the selected provider adapter's egress hosts (Claude: `api.anthropic.com`), and
- plain HTTP to `127.0.0.1:<bridge port>`, the CompozyOS MCP bridge of that one session.

Everything else is refused with `403` and logged. The design is in ADR-002 (isolation) and ADR-004
(provider adapters), in the spec directory. This page covers the adapter model, setup, the self-check, and
the operator steps.

## Provider adapters

The sandbox is a provider-neutral core plus one adapter per provider CLI (`bin/sandbox/adapters/`):

| Provider | Status | ACP agent | Login dir copy-in | Login file | Egress hosts |
| --- | --- | --- | --- | --- | --- |
| `claude` | implemented | `claude-agent-acp` | `.credentials.json`, `.claude.json` | `.credentials.json` | `api.anthropic.com` |
| `codex` | implemented (egress provisional) | `codex-acp` (bundled `codex` binary) | `auth.json`, `config.toml` | `auth.json` | `chatgpt.com`, `auth.openai.com`, `api.openai.com` |
| `cursor` | implemented ([Cursor](#cursor-adapter)) | `cursor-agent acp` (pinned copy) | `auth.json` | `auth.json` | `api2.cursor.sh` (provisional until IT-020) |

The core owns bubblewrap with `--unshare-net`, the read-only worktree under `--worktree-root`, the forwarder
and gateway, the ACP stdio guard (R-9, R-17, R-20), the per-session throwaway login copy, the
pre-session login refresh (S10a, R-18, R-21), the audit log and `--self-check`. An adapter supplies only the
`ProviderAdapter` fields (`bin/sandbox/adapters/types.ts`):

- `acpCommand(prefix)`: the ACP command, from the provider's pre-installed, read-only prefix;
- `configEnv(copyDir)`: env pointing the CLI at the session's login copy;
- `copyIn`: the files of the dedicated login dir copied in;
- `loginFile`: the login file the core refreshes on the host before a session (nothing ever comes back);
- `egressHosts`: the gateway's CONNECT allowlist;
- `identity(loginFile, signal)`: the account behind a login, resolved outside the sandbox;
- `startIdentity(loginDir, signal)` (optional): the host login's identity, read offline (for a login whose
  access token may already be expired); without it the core calls `identity` on the host login file;
- `refreshNeeded(loginText, untilMs)`: `refresh`, `valid` or `not-refreshable` (API-key mode), offline;
- `refresh(loginText, signal)`: one refresh through the provider's own flow with the host refresh token;
  returns the complete login text to save (the merge rule is the adapter's, below);
- `loginMount` (optional): where the session copy is bound inside, for a CLI whose login lives at a fixed
  leaf directory (Cursor: `/home/reviewer/.config/cursor`); default `/home/reviewer/.reviewer-login`. It must
  be a normalized absolute path below `/home/reviewer`;
- `extraAgentMethods` (optional): agent→client JSON-RPC methods the ACP guard forwards in addition to the
  core allowlist (Cursor: its `cursor/*` extension requests). `fs/*` and `terminal/*` can never be listed;
- `selfCheckFixture()`: synthetic files for the self-check's refresh refusal probe (a login that needs a
  refresh).

An unknown `--provider` fails at start with `unknown provider <p>`.

## What the sandbox sees

| Inside | Source | Mode |
| --- | --- | --- |
| `/usr`, `/etc/ssl`, `/etc/ca-certificates`, `/etc/alternatives` | host | read-only |
| session cwd (same absolute path) | the worktree CompozyOS starts the session in | read-only |
| `/opt/node/bin/node` | the host `node` binary the wrapper runs on | read-only |
| `/opt/acp` | the provider's ACP install prefix (`--acp-prefix`) | read-only |
| `/opt/reviewer-sandbox` | `bin/sandbox` (forwarder, probes) | read-only |
| `/run/reviewer/gw.sock` | this sandbox's gateway socket | read-only mount |
| `/home/reviewer` (HOME), `/tmp` | tmpfs | empty, discarded on exit |
| `/home/reviewer/.reviewer-login` (or the adapter's `loginMount`, Cursor: `/home/reviewer/.config/cursor`) | a per-session copy of the adapter's `copyIn` files from `--login-dir` | read-write, discarded on exit |
| `/etc/passwd`, `/etc/group`, `/etc/hosts` | generated (user `reviewer`) | read-only |

The environment is built from an allowlist (`sandboxEnv` in `bin/sandbox/profile.ts`): `HOME`, `PATH`,
`USER`, proxy variables pointing at `127.0.0.1:3128`, `NO_PROXY=127.0.0.1,localhost`,
`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` (system trust store, so a corporate TLS-inspection CA works),
`LANG`/`LC_ALL`/`LC_CTYPE`/`TZ`/`TERM` when set, plus the adapter's `configEnv` (Claude: `CLAUDE_CONFIG_DIR`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`). An adapter cannot override `PATH`, the proxy variables or the
trust store. No `GH_*`, `JIRA_*`, `SPACELIFT_*`, `SONARQUBE_*`, `SSH_AUTH_SOCK`, `COMPOZY_*` or anything
else from the host reaches it.

How a session starts:

1. CompozyOS runs the overlay command. The wrapper resolves the adapter (`--provider`) and the process cwd
   (or `--cwd`). It accepts the cwd only if:
   - it is a git checkout (has `.git`);
   - it is strictly inside one of the `--worktree-root` directories (mandatory outside `--self-check`;
     without one the wrapper refuses to start);
   - it does not overlap `/run`, `/var/run`, `/dev`, `/proc` or `/sys`, and is not `/tmp` itself or an
     ancestor of it;
   - it does not contain the operator HOME, and is not inside a HOME dot-directory other than a managed
     worktree `~/.compozy/worktrees/<workspace>/<name>`.
2. Outside the sandbox, before bwrap starts, it snapshots the host login file and resolves the start
   identity (below). It then copies only the adapter's `copyIn` files (regular files, never through a
   symlink) and the marker into its private temp dir. It starts its own gateway with the adapter's egress
   hosts, then bubblewrap (`--unshare-all`, `--die-with-parent`, `--new-session`, `--clearenv`). Inside,
   `forwarder.ts` listens on `127.0.0.1:3128` and starts the adapter's ACP command.
3. The wrapper owns the ACP stdio in both directions (`bin/sandbox/acp.ts`). CompozyOS, the ACP client,
   serves `fs/*` and `terminal/*` requests on the host, so this channel is guarded like the network:
   - **Client → agent.** For `session/new` and `session/load` (any message with `params.mcpServers`), it
     checks `params.cwd` is the bound cwd, takes each MCP URL's port (only
     `http://127.0.0.1|localhost:<port>` is accepted), and asks the gateway to allow it. The gateway asks
     the forwarder to listen on that port and confirms; only then is the message forwarded. One deliberate
     content rewrite: `initialize` gets `clientCapabilities.fs = {readTextFile:false, writeTextFile:false}`
     and `terminal = false`, so the agent never relies on host file or terminal access. Every JSON line is
     forwarded as the `JSON.stringify` re-encoding of what the tap parsed, so the agent reads exactly what
     the tap checked.
   - **Agent → client.** Every line must be a JSON-RPC 2.0 object whose top-level keys are only
     `jsonrpc`, `id`, `method`, `params`, `result`, `error` (case-sensitive). No object at any depth may
     hold two keys that are equal under case folding (`method`/`Method`, `sessionId`/`SessionId`, exact
     duplicates). CompozyOS decodes with Go `encoding/json`, which matches keys case-insensitively, so
     without this a line could read as `session/update` here and as `fs/write_text_file` there (R-17).
     What passes is forwarded as a canonical re-encoding, never the raw line. Responses pass only once, and
     only for request ids the client sent. Agent requests pass only for `session/request_permission`;
     agent notifications only for `session/update`, `_claude/sdkMessage` (CompozyOS opts into it through
     `emitRawSDKMessages`), `auth/status_update` and `_auth/status_update` (both sent by claude-agent-acp
     0.108.0 after `session/new`), plus the selected adapter's `extraAgentMethods` (Cursor: `cursor/*`).
     Non-JSON lines are dropped and logged.
   - The agent's stdin, stdout and stderr are socketpairs owned by the wrapper, so no other process in the
     sandbox can reopen them through `/proc/<pid>/fd` (`open` fails with `ENXIO`). Taking them with
     `pidfd_getfd` or `ptrace` needs ptrace rights over the adapter process, which the kernel's Yama module
     denies to same-uid processes when `kernel.yama.ptrace_scope >= 1`. The self-check fails when the
     value is 0 or Yama is absent (`R-17 kernel.yama.ptrace_scope >= 1`).
4. Fail closed: a stdio or remote MCP server, a foreign cwd, the daemon port (`2123`), a port the
   forwarder cannot confirm, or any agent message that is `fs/*`, `terminal/*`, not allowlisted, or an
   unsolicited response stops the sandbox and the wrapper exits `1`. The CompozyOS session then reports
   `failed`. Nothing from the refused message reaches CompozyOS.
5. After bwrap has exited, the temp dir is removed. Nothing written inside comes back, not the login file
   (S10a: whatever the session refreshed or wrote there is discarded) and not, for example, `CLAUDE.md`, `settings*.json`, `agents/`, `commands/`,
   `skills/`, `plugins/`, hooks, MCP servers or `.claude.json`. If the wrapper is killed with `SIGKILL`, the
   copy stays in `/tmp/reviewer-sandbox-*` (mode 0700) until removed by hand.

## Pre-session login refresh (S10a, R-18, ADR-004)

The login is refreshed on the host, before the session, and nothing a session writes ever comes back
(operator decision Q30 = c). Before bwrap starts, outside the sandbox, the wrapper:

1. takes the login dir's lock (below), waiting up to 60 s for another wrapper, else refuses
   (`login dir busy`);
2. reads the host `loginFile` through one `O_NOFOLLOW | O_NONBLOCK` descriptor (a symlink, FIFO or
   oversized file is refused; no login file at all: nothing to refresh);
3. asks the adapter whether the access token is missing, expired, or expires before
   `now + --session-budget-min (default 30) + --refresh-margin-min (default 10)` minutes. If not, or the
   login is in API-key mode, no network call is made and the session starts with a copy of the host login;
4. otherwise resolves the host login's identity, refreshes once with the host refresh token through the
   provider's own flow (host-side, timeout 8 s, redirects never followed, bounded body, strict shape),
   and resolves the refreshed login's identity with the adapter's checks (same account and organization;
   token kind and audience for Codex). Any network error, timeout, non-200, shape change or mismatch
   refuses;
5. checks that the lock is still its own and the host file is unchanged since step 2 (content, size,
   mtime), so an operator re-login or another wrapper's refresh is never overwritten;
6. saves exactly the refreshed login atomically (temp file, then rename, mode 0600), then builds the
   session copy from it.

Any refusal leaves the host login untouched (one exception: `refreshed token shorter than the session
budget`, where the same-account refreshed login is saved; see below): the wrapper exits `1` before bwrap
starts, and the CompozyOS
session reports `failed`. Every decision is one fixed-string audit line in the gateway log. Identities appear
only as 12-hex-digit keyed hashes, with a random key per wrapper run. Tokens, emails and provider answers
never appear. Sample lines:

```text
2026-11-17T23:50:01.101Z reviewer-sandbox[41001] login-refresh skipped (token valid)
2026-11-17T23:50:02.101Z reviewer-sandbox[41002] login-refresh skipped (not refreshable)
2026-11-17T23:50:03.101Z reviewer-sandbox[41003] login-refresh skipped (no login)
2026-11-17T23:51:12.202Z reviewer-sandbox[41004] login-refresh refreshed (same account) id=3f9a0c7d21be
2026-11-17T23:52:23.303Z reviewer-sandbox[41005] login-refresh refused (identity mismatch) before=3f9a0c7d21be refreshed=8b14e2a90f6c
2026-11-17T23:53:34.404Z reviewer-sandbox[41006] login-refresh refused (refresh rejected)
2026-11-17T23:53:35.404Z reviewer-sandbox[41007] login-refresh refused (refresh unavailable)
2026-11-17T23:53:36.404Z reviewer-sandbox[41008] login-refresh refused (refresh shape changed)
2026-11-17T23:54:45.505Z reviewer-sandbox[41009] login-refresh refused (identity shape changed: refreshed login)
2026-11-17T23:55:56.606Z reviewer-sandbox[41010] login-refresh refused (identity unavailable: host login)
2026-11-17T23:56:07.707Z reviewer-sandbox[41011] login-refresh refused (host login changed during refresh)
2026-11-17T23:56:14.222Z reviewer-sandbox[41012] login-refresh refused (login dir busy)
2026-11-17T23:56:16.333Z reviewer-sandbox[41013] login-refresh refused (login lock lost)
2026-11-17T23:57:18.808Z reviewer-sandbox[41014] login-refresh refused (host login is not a regular file within bounds)
2026-11-17T23:57:19.808Z reviewer-sandbox[41015] login-refresh refused (host login shape changed)
2026-11-17T23:58:20.909Z reviewer-sandbox[41016] login-refresh refused (refreshed token shorter than the session budget; saved, session not started)
```

`refreshed token shorter than the session budget` (R-33): the provider issued a token that would expire
during the session, so the CLI would refresh inside the sandbox and that result would be discarded. The
refreshed login IS saved (the old refresh token may already be rotated); lower `--session-budget-min`
or `--refresh-margin-min`, or retry later.
`refresh rejected` is a 4xx from the token endpoint (usually a revoked or already-rotated refresh token);
`refresh unavailable` is a network error, timeout, redirect or 5xx; `refresh shape changed` is an answer
or a host login the strict reader does not accept.

**Operational effect:** the reviewer needs no periodic re-login while its refresh token is valid and its
account unchanged: each session starts with a token valid for the session budget. A token the session
refreshes itself is discarded with the copy, so a provider that rotates refresh tokens on use could
invalidate the host's refresh token after an in-session refresh; the budget plus margin is chosen so the
CLI has no reason to refresh during a review. Raise `--session-budget-min` for longer reviews. After
`login-refresh refused (refresh rejected)`, or any identity refusal, log in again on the host (setup
step 2). The refresh flows below are undocumented contracts, isolated per adapter: re-check them, and
re-run the self-check, on every CLI upgrade.

**Refresh hosts.** The refresh runs on the host, so its host need not be in the sandbox egress:

| Provider | Refresh endpoint (host-side) | In sandbox egress |
| --- | --- | --- |
| `claude` | `https://platform.claude.com/v1/oauth/token` | no (`api.anthropic.com` only) |
| `codex` | `https://auth.openai.com/oauth/token` | yes (the CLI refreshes in-session too; that result is discarded) |
| `cursor` | none: the pinned cursor-agent has no browser-login refresh flow; a session needing a refresh is refused | n/a |

### The login-dir lock (`.reviewer-sandbox.lock`)

- **Format.** The lock is `<login-dir>/.reviewer-sandbox.lock`, containing `<pid> <uuid> <epoch-ms>`. It is
  published atomically (a hard link of a complete temp file), so it is never visible empty. It is held
  for the pre-session refresh check, the refresh and the session copy, and removed by its owner.
- **It is never taken over.** Not when it is old, not when its pid is dead, alive or reused, and not when
  it is empty, malformed or unreadable (R-31: an automatic takeover can race a live replacement lock). A
  wrapper that finds a lock waits up to 60 s (one refresh is at most three 10 s steps), then refuses with
  `login-refresh refused (login dir busy)` and leaves the host login unchanged. So two concurrent
  wrappers are serialized: one refreshes, the other then finds the token valid. A lock left by a crashed
  wrapper (or its `.lock.new-*` temp file) stays until you delete it.
- **When you may delete it by hand.** Only when no `reviewer-sandbox` wrapper is running for that login dir
  (`pgrep -af reviewer-sandbox` shows none using it). Delete it, then re-run the session. Deleting it
  while a wrapper is refreshing can let two refreshes overlap.

### Claude refresh (an undocumented contract, a known risk)

`bin/sandbox/adapters/claude-refresh.ts` isolates it. It is the flow the installed Claude Code CLI
(claude-agent-sdk 0.3.x native CLI, production OAuth config) uses itself:

- `POST https://platform.claude.com/v1/oauth/token`, `Content-Type: application/json`
- body `{"grant_type":"refresh_token","refresh_token":<claudeAiOauth.refreshToken>,"client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","scope":<claudeAiOauth.scopes joined by " ">}`
- `200` → `access_token` (required), `expires_in` (required, seconds, at most a year), `refresh_token` and
  `scope` (optional)
- needed when `claudeAiOauth.expiresAt` (epoch ms) is missing or not after the session budget plus margin;
  a login without `claudeAiOauth` (API key) is not refreshable.

Merge rule (as the CLI): in `.credentials.json` `claudeAiOauth`, set `accessToken`, `refreshToken` (the
returned one, else the old one), `expiresAt = now + expires_in * 1000` and `scopes` (the returned `scope`
split on spaces, else the old ones). Every other field of `claudeAiOauth` (for example
`subscriptionType`) and every other top-level key stay as they are. The refreshed token's identity is then
checked against the start identity, below.

### Claude identity (an undocumented contract, a known risk)

`bin/sandbox/adapters/claude-identity.ts` isolates it. It was taken from the installed Claude Code CLI
(claude-agent-sdk 0.3.x), which calls it itself with an OAuth access token:

- `GET https://api.anthropic.com/api/oauth/profile`
- headers `Authorization: Bearer <OAuth access token>`, `Content-Type: application/json`,
  `Cache-Control: no-cache` (no `anthropic-beta` header); the wrapper sends `User-Agent: reviewer-sandbox`
- `200` → `{ "account": { "uuid", ... }, "organization": { "uuid", ... } }`; only the two `uuid` fields are
  read, and both must be UUIDs
- timeout 5 s; redirects are never followed; the answer is never logged.

The start identity comes from the dedicated login dir's `.claude.json` `oauthAccount`
(`accountUuid`, `organizationUuid`). The CLI writes it at `/login` on the host, and it is read offline
before bwrap starts. The sandbox can never write the host's copy: nothing is ever copied back. Calling the
endpoint with the host's token instead would fail exactly when a refresh is needed (that token is expired
by then).

The endpoint is not a published API. If its path, auth or answer shape changes, every refresh is
refused (`identity unavailable` or `identity shape changed`), and the operator logs in again on the host
until this module is updated. Re-check it, and re-run the self-check, on every claude-agent-acp upgrade.

Residual risk accepted by the operator (D16): the reviewer's own login in the session copy is readable
inside. With no network, it can leave only through the provider API or the review text. Nothing written inside
comes back, so it cannot be replaced from inside.

## Codex adapter

`--provider codex` runs `@agentclientprotocol/codex-acp` from the prefix
`${XDG_DATA_HOME:-~/.local/share}/reviewer-sandbox/codex`.

**Codex binary.** In ACP mode, codex-acp runs `$CODEX_PATH app-server` when `CODEX_PATH` is set. Otherwise
it runs the bundled `@openai/codex/bin/codex.js` with the current node, which execs the native binary
from the `@openai/codex-linux-x64` package. The sandbox env never carries `CODEX_PATH`, so the binary
always comes from the read-only prefix, never from the host's `PATH`.

**Config env.** `CODEX_HOME=/home/reviewer/.reviewer-login`, the session copy.

**Copy-in.** `auth.json` (the login) and `config.toml`, which is optional and carries the operator's model
and opt-out settings. Nothing else of the dedicated dir is used: no `AGENTS.md`, `history.jsonl` or
`sessions/`.

**Egress (provisional, taken from the Codex CLI 0.166 code; confirmed by IT-020, operator-assisted):**

- `chatgpt.com`: model traffic in ChatGPT login mode (`https://chatgpt.com/backend-api/codex`);
- `auth.openai.com`: token refresh (`https://auth.openai.com/oauth/token`);
- `api.openai.com`: model traffic in API-key mode (`https://api.openai.com/v1`).

Left out are `ab.chatgpt.com` (OTLP metrics), update checks and docs/help hosts. A start without a login
also tried `github.com`, `api.github.com` and `files.openai.com`. The gateway refused and logged them, and
IT-020 decides whether a review needs any of them. Codex has no env opt-out for non-essential traffic; set
it in the dedicated dir's `config.toml`:

```toml
check_for_update_on_startup = false

[analytics]
enabled = false
```

### One-time install and login

```console
$ npm install --prefix ~/.local/share/reviewer-sandbox/codex --save-exact --omit=dev --no-audit --no-fund \
    @agentclientprotocol/codex-acp@2.7.0 @openai/codex@0.166.0
$ install -d -m 700 ~/.codex-reviewer && touch ~/.codex-reviewer/.reviewer-sandbox
$ CODEX_HOME=~/.codex-reviewer ~/.local/share/reviewer-sandbox/codex/node_modules/.bin/codex login
```

Log in with "Sign in with ChatGPT" using the reviewer account. API-key mode works for sessions and is never refreshed
(below).

### Codex identity (an undocumented contract, a known risk)

`bin/sandbox/adapters/codex-identity.ts` isolates it. The rules:

- **ChatGPT login mode.** `auth.json` `tokens.id_token` and `tokens.access_token` are RS256 JWTs from
  `https://auth.openai.com`. Their claims are trusted only after the signature verifies against the
  issuer's JWKS, `https://auth.openai.com/.well-known/jwks.json`. The JWKS is fetched by the wrapper,
  outside the sandbox, with a 5 s timeout, no redirects and a 256 KiB bound, and must contain RSA keys only.
- **The identity** is the id_token's `https://api.openai.com/auth` claims: account = `chatgpt_user_id` (or
  `user_id`), org = `chatgpt_account_id`.
- **The id_token** must have `iss = https://auth.openai.com` and the Codex CLI client id
  (`app_EMoamEEZ73f0CkXaXp7hrann`) in `aud`.
- **The access_token** must be signed by the same issuer and carry the same `chatgpt_account_id`, and the
  same user id when it carries one. It is checked against its own contract (R-30): `aud` must include the
  API audience `https://api.openai.com/v1` and must not be the CLI client id, and it must differ from the
  id_token. So an id_token presented as the access token, or any other audience, is refused as a shape
  change.
- **`exp` is not checked.** This is an identity comparison, not an authentication, and the host's tokens
  are usually expired when a refresh is needed. An expired host login still resolves.
- **The start identity** comes from the same check on the host `auth.json`, before the refresh.
- **API-key mode** (`auth_mode: "apikey"`, or no `tokens`) and every other credential kind have no
  verifiable identity (`identity unavailable`); API-key logins are not refreshable, so the session starts
  without a refresh. A ChatGPT login that also carries `OPENAI_API_KEY`,
  `personal_access_token`, `agent_identity` or `bedrock_*` is refused as a shape change.
- **Failure cases.** An unknown signing key (a rotated issuer key) gives `identity unavailable`. A bad
  signature, the wrong issuer or audience, or a changed claim or JWKS shape gives `identity shape changed`.
  Either way, log in again on the host.

### Codex refresh (an undocumented contract, a known risk)

`bin/sandbox/adapters/codex-refresh.ts` isolates it. It is the flow the Codex CLI 0.166 uses itself (its
login crate; the CLI's override variable is `CODEX_REFRESH_TOKEN_URL_OVERRIDE`):

- `POST https://auth.openai.com/oauth/token`, `Content-Type: application/x-www-form-urlencoded`
- body `grant_type=refresh_token&refresh_token=<tokens.refresh_token>&client_id=app_EMoamEEZ73f0CkXaXp7hrann&refresh_reason=scheduled`
- `200` → `access_token` (required), `id_token` and `refresh_token` (optional; non-empty strings when present)
- needed when `tokens.access_token`'s JWT `exp` (decoded unverified, only to decide) is missing or not after
  the session budget plus margin; `auth_mode` other than `chatgpt`, or no `tokens`, is not refreshable.

Merge rule (as the CLI): in `auth.json` `tokens`, set `access_token`, and `id_token` / `refresh_token` to
the returned values (else keep the old ones); set `last_refresh` to now (ISO 8601). `tokens.account_id`,
`auth_mode`, `OPENAI_API_KEY` and every other field stay as they are. The saved tokens must then pass every
identity rule above against the host login's identity.

### Overlay

```toml
[providers.codex-reviewer]
display_name = "Codex (reviewer sandbox)"
harness = "acp"
runtime_provider = "codex"
auth_mode = "native_cli"
session_mcp_transport = "http"
command = "/home/user/.compozy/extensions/github-app-review/bin/reviewer-sandbox --provider codex --login-dir /home/user/.codex-reviewer --worktree-root /home/user/.compozy/worktrees"
```

### IT-018 and IT-020 with `codex-reviewer` (operator)

1. Install and log in as above.
2. Run the self-check from a checkout. It must end with `self-check --provider codex: all ... passed`:

   ```console
   $ ~/.compozy/extensions/github-app-review/bin/reviewer-sandbox --provider codex --login-dir ~/.codex-reviewer --self-check
   ```

3. Add the overlay block to `~/.compozy/config.toml` and apply the config.
4. Run a session with `reviewer-selftest`. Switch its provider to `codex-reviewer` (and its model to a
   Codex model), or add `codex-reviewer` to the front of its `fallback_chain`. Then:

   ```console
   $ cd ~/src/compozy-github-app
   $ : > ~/.local/state/reviewer-sandbox/gateway.log
   $ compozy session new --agent reviewer-selftest --name ghar-it020-codex --new-worktree ghar-it020-codex
   $ compozy session prompt <session-id> "selftest: acme/widgets #<open PR>"
   ```

5. It passes when:
   - the reply is `selftest: ok tools=ext__github_app_review__pr_context head=<sha>`;
   - the session's gateway lines show exactly one `allow-port`;
   - `pass CONNECT` appears only for the hosts the session needed;
   - one `login-refresh` line appears before the session starts.

   Record every `refuse CONNECT` line. If the session failed because a host was refused, propose adding
   that host to `egressHosts` in `bin/sandbox/adapters/codex.ts`; telemetry and update hosts stay out.
   Then remove `(provisional)` here and in the code.
6. Stop and remove the session: `compozy session stop <id>`, `compozy session remove <id>`.

## Requirements

- bubblewrap ≥ 0.8 (`bwrap --version`) with unprivileged user namespaces.
- Node ≥ 24: it runs the `.ts` files with type stripping, and `--use-system-ca` makes the host-side identity
  check trust the OS store. The wrapper uses `node` from the CompozyOS daemon `PATH`, or
  `REVIEWER_NODE=/abs/path/to/node`.
- `curl` and `bash` in `/usr/bin` (self-check probes only).

## One-time setup

### 1. Install the provider's ACP agent into its prefix

The sandbox never runs `npx` (no network inside). Each provider has its own prefix,
`${XDG_DATA_HOME:-~/.local/share}/reviewer-sandbox/<provider>`. Override it with `--acp-prefix DIR` or
`REVIEWER_ACP_PREFIX`. Pin the version you tested:

```console
$ npm install --prefix ~/.local/share/reviewer-sandbox/claude --omit=dev --no-audit --no-fund \
    @agentclientprotocol/claude-agent-acp@0.108.0
```

An install made for an earlier version of this page under `~/.local/share/reviewer-sandbox/acp` is not
read any more. Move it (`mv ~/.local/share/reviewer-sandbox/acp ~/.local/share/reviewer-sandbox/claude`)
or pass `--acp-prefix ~/.local/share/reviewer-sandbox/acp`. Re-run the install with a new version to
upgrade, then re-run the self-check.

### 2. Prepare the dedicated login directories

One per overlay. Never use the operator's everyday login dir: the wrapper refuses `~`, `~/.claude`,
`~/.codex`, `~/.cursor`, `~/.config/cursor`, and any directory without the marker file.

```console
$ install -d -m 700 ~/.claude-reviewer ~/.claude-reviewer-fallback
$ touch ~/.claude-reviewer/.reviewer-sandbox ~/.claude-reviewer-fallback/.reviewer-sandbox
```

Log in each directory with its account (`claude-reviewer` = the primary account,
`claude-reviewer-fallback` = the fallback account). Use a fresh login, not a copy of another directory's
login: two copies of one OAuth refresh token can invalidate each other when either refreshes.

```console
$ CLAUDE_CONFIG_DIR=~/.claude-reviewer claude            # then /login with the primary account, then /exit
$ CLAUDE_CONFIG_DIR=~/.claude-reviewer-fallback claude   # then /login with the fallback account, then /exit
```

Only the adapter's `copyIn` files are used (Claude: `.credentials.json` and `.claude.json`). Settings,
`CLAUDE.md`, MCP servers, hooks and plugins in the directory never reach a session.

### 3. Run the self-check (before enabling the overlays, and after every wrapper, gateway or ACP change)

Run it from a checkout (the cwd is the bound "worktree"). It probes the real local daemon, so it runs on the
operator host, not in hosted CI:

```console
$ cd ~/src/compozy-github-app
$ ~/.compozy/extensions/github-app-review/bin/reviewer-sandbox --provider claude --login-dir ~/.claude-reviewer --self-check
$ ~/.compozy/extensions/github-app-review/bin/reviewer-sandbox --provider claude --login-dir ~/.claude-reviewer-fallback --self-check   # IT-014
```

It starts five sandboxes at once, each with its own gateway, all in the same bubblewrap profile the
provider's ACP agent gets:

- **A and B** each get a fake bridge listener and run `bin/sandbox/probes.sh`.
- **C** runs an agent that writes `terminal/create` on its stdout, through the same agent→client pump as
  normal mode.
- **D** runs an agent that prints a 20 000-deep message.
- **E** exercises the identity refusal path with synthetic data only:
  - a temporary host login dir built from the adapter's fixture (a known start identity);
  - a forged, well-shaped login written inside;
  - the adapter's identity check pointed at a closed local port.

One line per probe; exit `0` only when all pass:

```text
ok [A] IT-010 env has only allowlisted names
ok [A] IT-010 no GH_/JIRA_/SPACELIFT_/SONARQUBE_/COMPOZY_/SSH_AUTH_SOCK
ok [A] IT-011 HOME is not the operator HOME
ok [A] IT-011 /home/user/.config/gh absent
...
ok [A] IT-011 login copy is the dedicated mount (/home/reviewer/.reviewer-login)
ok [A] IT-012 write on worktree fails with EROFS
ok [A] IT-013 127.0.0.1:2123 direct: no HTTP answer
ok [A] IT-013 127.0.0.1:2123 via proxy: refused by gateway
...
ok [A] IT-015 api.anthropic.com TLS handshake via HTTPS_PROXY (HTTP 404)
ok [A] runtime claude ACP present (/opt/node/bin/node /opt/acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js)
ok [A] R-9 no process stdio reopenable via /proc/<pid>/fd (9 tried)
ok [A] R-17 kernel.yama.ptrace_scope >= 1 (3)
ok [A] R-9 injected terminal/create on agent stdout refused by the wrapper filter (agent requested terminal/create)
ok [A] R-10 login copy writable inside (instructions, settings, agents/)
ok [A] R-18 forged claude login written inside (.credentials.json)
ok [A] IT-017 own bridge port 37213 reachable
ok [A] IT-017 other bridge port 38197 via proxy: refused by gateway
...
ok [A] R-18 session-written login never reaches the host (.credentials.json unchanged; login-refresh skipped (token valid))
ok [A] adapter claude: gateway allowlist = egressHosts (api.anthropic.com)
...
ok [C] R-9 injected terminal/create refused (session stopped after 157 ms; 1 line forwarded before it; reason: agent requested terminal/create)
ok [D] R-20 20000-deep agent message refused, temp dir removed (reason: nesting deeper than 512; forwarded 0; temp dir gone)
ok [E] adapter claude: near-expiry login with an unreachable refresh endpoint (127.0.0.1:36769): session refused before start (login-refresh refused (refresh unavailable)); fixture host dir unchanged
ok [host] R-10/R-18 writes to the login copy inside (instructions, settings, agents/, forged login) did not reach the host login dir
self-check --provider claude: all 44 probes passed
```

IT-011 note: the worktree is bound at its own absolute path (ACP `session/new` carries the host cwd), so
its ancestor directories exist inside as bare mount points. The probe requires each of them (for example
`/home/user`, `/home/user/.compozy`) to hold exactly one entry, the next path component. It also checks
that `~/.config/gh`, `~/.ssh`, `~/.claude`, `~/.codex`, `~/.cursor`, `~/.config/cursor`,
`~/.compozy/config.toml` and `~/.gitconfig` are absent.

## Overlays (`~/.compozy/config.toml`, operator-authored)

One overlay per (provider, login dir), with the wrapper path of the installed extension. No
`session_env`: nothing from the operator overlays is injected.

```toml
[providers.claude-reviewer]
display_name = "Claude (reviewer sandbox)"
harness = "acp"
runtime_provider = "claude"
auth_mode = "native_cli"
session_mcp_transport = "http"
command = "/home/user/.compozy/extensions/github-app-review/bin/reviewer-sandbox --provider claude --login-dir /home/user/.claude-reviewer --worktree-root /home/user/.compozy/worktrees"

[providers.claude-reviewer-fallback]
display_name = "Claude fallback (reviewer sandbox)"
harness = "acp"
runtime_provider = "claude"
auth_mode = "native_cli"
session_mcp_transport = "http"
command = "/home/user/.compozy/extensions/github-app-review/bin/reviewer-sandbox --provider claude --login-dir /home/user/.claude-reviewer-fallback --worktree-root /home/user/.compozy/worktrees"
```

The `cursor-reviewer` overlay is in [Cursor adapter](#cursor-adapter). The `codex-reviewer` overlay follows
the same pattern (`--provider codex`) once its adapter exists.

Required: `--provider claude|codex|cursor` and `--login-dir DIR`. Outside `--self-check`, also
`--worktree-root DIR` (repeatable; the cwd must be strictly inside one of them). Typically that is
`/home/user/.compozy/worktrees`, the root under which CompozyOS creates the managed worktrees handed to
the reviewer agent.

Optional flags:

- `--acp-prefix DIR`: the provider's ACP install prefix (default above);
- `--gateway-log FILE`: default `~/.local/state/reviewer-sandbox/gateway.log`;
- `--daemon-port N`: default `2123`; the gateway never allows it;
- `--session-budget-min N`, `--refresh-margin-min N`: whole minutes, 0..1440, defaults `30` and `10`; the
  pre-session refresh keeps the login valid for their sum;
- `--cwd DIR`: default is the process cwd CompozyOS starts the provider in.

## Gateway log

Every sandbox appends to `~/.local/state/reviewer-sandbox/gateway.log` (also on the wrapper's stderr).
Targets only, never headers or bodies:

```text
2026-11-17T19:10:16.566Z reviewer-gateway[209526] listening /tmp/reviewer-sandbox-49vpHa/gw/gw.sock egress=api.anthropic.com
2026-11-17T19:10:16.865Z reviewer-gateway[209526] allow-port 46669
2026-11-17T19:10:17.406Z reviewer-gateway[209526] pass bridge 127.0.0.1:46669
2026-11-17T19:10:18.120Z reviewer-gateway[209526] pass CONNECT api.anthropic.com:443
2026-11-17T19:09:35.783Z reviewer-gateway[203861] refuse CONNECT api.github.com:443 (not allowlisted)
```

There is one `allow-port` per session MCP bridge, and the pid tells sessions apart. The wrapper appends one
`reviewer-sandbox[<pid>] login-refresh skipped|refreshed|refused (<reason>)` line per session, before it
starts (see above).

## Enabling it and proving the bridge (IT-016, IT-014)

These change operator state; the operator runs them.

1. Install the extension build that contains `bin/` and bind its secrets (`README.md`).
2. Do the one-time setup above and run both self-checks. Both must end with
   `self-check --provider claude: all ... passed`.
3. Add the two overlay blocks to `~/.compozy/config.toml` and apply the config.
4. IT-016, from the extension repo (it ships `.compozy/agents/reviewer-selftest`). The session must run in
   a managed worktree, because the wrapper only accepts a cwd under `--worktree-root`:

   ```console
   $ cd ~/src/compozy-github-app
   $ : > ~/.local/state/reviewer-sandbox/gateway.log
   $ compozy session new --agent reviewer-selftest --name ghar-it016 --new-worktree ghar-it016
   $ compozy session prompt <session-id> "selftest: acme/widgets #<open PR>"
   ```

   It passes when all of these hold:
   - the final message is `selftest: ok tools=ext__github_app_review__pr_context head=<sha>`;
   - the gateway log for that session's pid shows exactly one `allow-port` line;
   - besides refusals, it shows only `pass bridge` and `pass CONNECT api.anthropic.com:443` lines;
   - one `login-refresh` line appears before the session starts.

   If the session fails at start, read the wrapper's `reviewer-sandbox:` line in the session's provider
   stderr (for example a refused cwd or a non-http MCP server).
5. IT-014: repeat step 4 with the agent's provider switched to `claude-reviewer-fallback` (or let the
   fallback chain take it). Keep the `--login-dir ~/.claude-reviewer-fallback` self-check output.
6. Stop and remove the test session: `compozy session stop <id>`, `compozy session remove <id>`.

## Cursor adapter

`--provider cursor` runs `cursor-agent acp` (the same ACP mode CompozyOS's built-in `cursor` provider uses)
from a pinned, read-only copy of the cursor-agent package. Code: `bin/sandbox/adapters/cursor.ts` and
`cursor-identity.ts`.

| Field | Value |
| --- | --- |
| ACP command | `/opt/acp/cursor-agent acp` (the package's launcher; it runs the bundled `node` on `index.js`) |
| Pinned version | `2026.10.16-e3cb207` (`CURSOR_AGENT_VERSION`) |
| `loginMount` | `/home/reviewer/.config/cursor` |
| `configEnv` | `XDG_CONFIG_HOME=/home/reviewer/.config`, `NO_OPEN_BROWSER=1` |
| `copyIn` / `loginFile` | `auth.json` / `auth.json` |
| `extraAgentMethods` | `cursor/update_todos`, `cursor/task`, `cursor/ask_question`, `cursor/create_plan`, `cursor/generate_image` |
| `egressHosts` | `api2.cursor.sh` (**provisional**, confirmed by IT-020, operator-assisted) |

**Where the login lives (read from the CLI, not documented).** On Linux, cursor-agent always stores its
login in a file, `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json` (`accessToken`, `refreshToken`, optional
`apiKey`), and keeps its config, `cli-config.json`, in the same `cursor/` directory. The `cursor/` leaf is
fixed; there is no flag or variable for the auth file itself. So the adapter binds the session copy at
`/home/reviewer/.config/cursor` (the generic `loginMount` option) and points `XDG_CONFIG_HOME` at its
parent. Only `auth.json` is copied in; `cli-config.json`, `mcp.json`, permissions and approvals in the
dedicated dir never reach a session. Everything else the CLI writes (its config, `~/.cursor` data, the
compile cache) lands in the throwaway copy or the tmpfs HOME.

**ACP extension requests.** After tool calls the agent sends `cursor/update_todos` and `cursor/task`
requests to the client, and `cursor/ask_question`, `cursor/create_plan` and `cursor/generate_image` for
questions and plans. They carry data only. A client that does not serve them answers `-32601`, and the
agent falls back. Without the allowlist entry each one would stop the session (fail closed).

### 1. Install the pinned cursor-agent into its prefix

The sandbox runs only `${XDG_DATA_HOME:-~/.local/share}/reviewer-sandbox/cursor` (or `--acp-prefix` /
`REVIEWER_ACP_PREFIX`), never the live `~/.local/bin/cursor-agent`. Install the pinned version with Cursor's
own installer once, then copy its versioned directory (no network; the script checks the version and
makes the copy read-only):

```console
$ ~/src/compozy-github-app/scripts/install-cursor-acp.sh          # pinned 2026.10.16-e3cb207
installed cursor-agent 2026.10.16-e3cb207 into /home/user/.local/share/reviewer-sandbox/cursor
```

To upgrade, bump `CURSOR_AGENT_VERSION`, run `scripts/install-cursor-acp.sh <version>`, re-check the
identity contract below and the egress list (IT-020), and re-run the self-check.

### 2. Dedicated login directory

Log in with the reviewer's own Cursor account, freshly (never a copy of `~/.config/cursor`). The CLI writes
to `$XDG_CONFIG_HOME/cursor`, so a temporary `XDG_CONFIG_HOME` whose `cursor` entry is a symlink to the
dedicated dir makes it store the login there. `HOME` is also temporary, so nothing is written to the
operator's `~/.cursor`:

```console
$ install -d -m 700 /home/user/.cursor-reviewer && touch /home/user/.cursor-reviewer/.reviewer-sandbox
$ T=$(mktemp -d) && ln -s /home/user/.cursor-reviewer "$T/cursor" \
    && HOME="$T" XDG_CONFIG_HOME="$T" ~/.local/share/reviewer-sandbox/cursor/cursor-agent login \
    && HOME="$T" XDG_CONFIG_HOME="$T" ~/.local/share/reviewer-sandbox/cursor/cursor-agent status; rm -rf "$T"
$ ls -A /home/user/.cursor-reviewer
.reviewer-sandbox  auth.json  cli-config.json
```

If no browser opens, open the URL `login` prints. After it, `/home/user/.cursor-reviewer` holds `auth.json` (the login) and `cli-config.json` with
`authInfo` (the start identity, below). Verified offline with a scratch HOME and synthetic files: the CLI
reads and removes the login at `$XDG_CONFIG_HOME/cursor/auth.json` through that symlink, and writes its
config there.

### 3. Self-check

```console
$ cd ~/src/compozy-github-app
$ ~/.compozy/extensions/github-app-review/bin/reviewer-sandbox --provider cursor --login-dir /home/user/.cursor-reviewer --self-check
...
ok [A] IT-011 login copy is the dedicated mount (/home/reviewer/.config/cursor)
ok [A] IT-015 api2.cursor.sh TLS handshake via HTTPS_PROXY (HTTP 200)
ok [A] runtime cursor ACP present (/opt/acp/cursor-agent)
ok [A] adapter cursor: gateway allowlist = egressHosts (api2.cursor.sh)
ok [E] adapter cursor: near-expiry login with an unreachable refresh endpoint (127.0.0.1:35781): session refused before start (login-refresh refused (refresh unavailable)); fixture host dir unchanged
self-check --provider cursor: all 44 probes passed
```

### 4. Overlay

```toml
[providers.cursor-reviewer]
display_name = "Cursor (reviewer sandbox)"
harness = "acp"
runtime_provider = "cursor"
auth_mode = "native_cli"
session_mcp_transport = "http"
command = "/home/user/.compozy/extensions/github-app-review/bin/reviewer-sandbox --provider cursor --login-dir /home/user/.cursor-reviewer --worktree-root /home/user/.compozy/worktrees"
```

### Cursor identity (an undocumented contract, a known risk)

`bin/sandbox/adapters/cursor-identity.ts` isolates it. It is the call `cursor-agent status` (alias `whoami`)
and `cursor-agent login` make themselves, a Connect unary RPC:

- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe`
- headers `Authorization: Bearer <auth.json accessToken>`, `Content-Type: application/proto`,
  `Connect-Protocol-Version: 1`, `x-cursor-client-type: cli`, `x-ghost-mode: true`; body: an empty
  `GetMeRequest` (zero bytes); the wrapper sends `User-Agent: reviewer-sandbox`
- `200 application/proto` → `GetMeResponse`; only field 1 `auth_id` (string, the account), field 2
  `user_id` (int32, must be positive) and field 7 `team_id` (optional int32, the "organization") are read.
  The reader is strict: a wrong wire type, a repeated field, a group, a truncated message, invalid UTF-8,
  a missing `auth_id`/`user_id`, or a non-protobuf answer is a shape change
- timeout 5 s; redirects are never followed; the answer is never logged.

The start identity comes from the dedicated dir's `cli-config.json` `authInfo` (`authId`, `userId`,
`teamId`), which `cursor-agent login` writes on the host from the same `GetMe` answer. It is read offline
before bwrap starts; the sandbox can never write that file (it is not copied in, and nothing is ever copied
back). Should a Cursor refresh flow exist in a later pinned version, a refreshed login would be saved only
when `GetMe` for its token names the same `auth_id` and the same `team_id` (or no team on both sides).

**Browser login only (R-29).** `GetMe` verifies the access token and nothing else, so the login file may hold
nothing that check does not vouch for. The CLI's file store writes `accessToken`, `refreshToken`, `apiKey`
and `bedrockCredentials`; `cursor-agent login` (browser login) writes only `accessToken` and
`refreshToken`. Any other key, including an `apiKey` (in the ACP's LOGIN mode a present API key clears the
login at the next start) or `bedrockCredentials`, makes the identity a shape change: a host login with such a key
refuses every refresh (`identity shape changed: host login`). So the reviewer's dedicated login must be a browser login,
not an API key.

The token claims (a JWT) are not used: their signature cannot be verified offline. If the endpoint, its auth
or its answer changes, every refresh is refused (`identity unavailable` or `identity shape changed`); log
in again (step 2) until this module is updated.

**Refresh: none in the pinned CLI (S10b; an undocumented behaviour, re-check on every upgrade).** In
cursor-agent `2026.10.16-e3cb207` the stored `refreshToken` is only checked for presence (`status`,
`about`, the ACP auth check) and is never sent to Cursor. The CLI's only token renewal is API-key exchange
(`POST https://api2.cursor.sh/auth/exchange_user_api_key`), which a browser login does not have and R-29
forbids. Its ACP auth check in LOGIN mode treats an access token with less than 300 s left as logged out.
So `cursorRefreshNeeded` compares the `accessToken` JWT `exp` (unverified, only to decide) with the session
budget plus margin; a login without an `accessToken` is not refreshable. `refresh` always throws
`RefreshError("unavailable")` without any network call: a Cursor session starts while the host token is
fresh and is refused (`login-refresh refused (refresh unavailable)`) once it is not. Then log in again on
the host (step 2). Reproducing a refresh endpoint the CLI never calls would be a guess, so none is used.

### Cursor egress (provisional until IT-020)

Derived from the CLI's code (`service-urls`: production `apiUrl`): `api2.cursor.sh` carries auth, the
dashboard and the agent service. Left out on purpose, so the gateway refuses and logs them:
`api3.cursor.sh` (metrics), `*.ingest.us.sentry.io` (crash reports; no opt-out variable exists),
statsig hosts (the CLI already disables its network traffic), `cursor.com` and `downloads.cursor.com`
(website, update checks; no opt-out variable exists), `repo42.cursor.sh` (repository indexing),
`api2direct.cursor.sh` (private-worker bridge). IT-020 records one real review session's gateway log and
either confirms the list or adds the hosts a review needs.

### IT-016 / IT-020 with `cursor-reviewer` (operator)

1. Install the extension build that contains this adapter, then steps 1–4 above; the self-check must end
   with `self-check --provider cursor: all 44 probes passed`.
2. For this run only, edit `.compozy/agents/reviewer-selftest/AGENT.md` in your checkout: `provider:
   cursor-reviewer`, `model:` one of the IDs `cursor-agent models` lists for the reviewer account (run it as
   in step 2 of the login, with the temporary `HOME`/`XDG_CONFIG_HOME`), and remove `fallback_chain` so the
   session cannot fall back to Claude. Revert the edit afterwards.
3. Run IT-016 as in [Enabling it](#enabling-it-and-proving-the-bridge-it-016-it-014), with
   `ghar-it020-cursor` as the session and worktree name, after `: > ~/.local/state/reviewer-sandbox/gateway.log`.
4. IT-020 passes when IT-016's conditions hold, the session's pid shows only `pass bridge` and
   `pass CONNECT <host>:443` lines for hosts in `egressHosts` (plus refusals), and the agent produced the
   review without an ACP refusal (`refused agent message` in the wrapper stderr). Every `refuse CONNECT` host
   the review needed is the egress-list change to make; every `refused agent message: request|notification
   <m> is not allowlisted` is an `extraAgentMethods` change to make.
5. Keep the gateway log lines of that pid (targets only) as the IT-020 evidence, then stop and remove the
   session.

Residual risk (as for Claude, D16): the reviewer's own Cursor login is readable inside the session copy.
With no network but `api2.cursor.sh`, it can leave only through the provider API or the review text, and nothing
written inside comes back.


## Development

Code:

- Core:
  - `bin/sandbox/profile.ts`: client tap, cwd guard, env allowlist, bubblewrap profile (pure);
  - `bin/sandbox/acp.ts`: the ACP guard for both directions (pure);
  - `bin/sandbox/login.ts`: the login-dir lock, the identity-checked pre-session refresh and the copy-in;
  - `bin/sandbox/files.ts`: the race-free reader;
  - `bin/sandbox/options.ts`: command-line options;
  - `bin/sandbox/sandbox.ts`: validation, launch, the agent pump;
  - `bin/sandbox/wrapper.ts` (normal mode) and `bin/sandbox/selfcheck.ts`;
  - `bin/sandbox/gateway.ts`;
  - `bin/sandbox/forwarder.ts` and `bin/sandbox/probes.sh`, both run inside the sandbox.
- Adapters: `bin/sandbox/adapters/` (`types.ts` is the contract; `index.ts` is the registry; `claude.ts` and
  `claude-identity.ts`, `claude-refresh.ts`; `codex.ts`, `codex-identity.ts`, `codex-refresh.ts`; `cursor.ts`
  and `cursor-identity.ts`; `refresh-http.ts` is the shared token-endpoint call).

There is no dependency on `src/` or on any npm package.

Adding a provider (S8 `codex`, S9 `cursor`):

1. Implement `ProviderAdapter` in `bin/sandbox/adapters/<p>.ts`, with its identity and its refresh each
   in their own module behind an injectable base URL and fetch.
2. Register the factory in `index.ts`.
3. Establish `egressHosts` from one real session's gateway `refuse CONNECT` lines.
4. Run `--self-check --provider <p>`. Every core probe and both adapter probes apply unchanged.

Tests: `bun test test/sandbox` covers:

- the client tap, cwd guard, env and profile;
- the ACP guard and the `initialize` rewrite;
- the pre-session refresh with a test double (not needed, refreshed, mismatch, every error kind, host
  changed, lock lost, two concurrent wrappers, session-written login), the lock across real processes and
  the race-free reader;
- the Claude adapter with fake token and profile endpoints (UT-080..UT-082);
- the Codex adapter with fake token and JWKS endpoints (UT-084..UT-086);
- the Cursor adapter with a fake `GetMe` endpoint, the strict protobuf reader and the refresh refusal
  (UT-087..UT-089);
- the gateway allowlist and two concurrent gateways;
- wrapper start failures and the crash path;
- agent tool IDs.
