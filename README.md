# github-app-review

CompozyOS extension that lets agents review pull requests as a GitHub App. The app key lives
only in the extension subprocess; agents call tools and never see a token. The extension enforces the
review rules in code:

- the review event is derived from the findings' severities (any `blocker`/`major` →
  `REQUEST_CHANGES`, otherwise `APPROVE`); the agent cannot choose it;
- a review is posted only on the PR's current head (`commit_id = head_sha`);
- one review per head (pass 1), plus one contested re-review of the same head (pass 2);
- only allowlisted repositories;
- findings outside the diff move to the review summary under "Outside the diff", never dropped;
- the app reviews only pull requests into one delivery branch, `GITHUB_APP_BASE` (for example `main`
  or `staging`); any other base is refused;
- optionally, the app opens a promotion PR from that branch into another one (`upsert_promotion`,
  e.g. `staging` → `main`) and a configured approver approves it on GitHub; the app never approves or
  merges it.

## Install

1. Create the GitHub App (organization Settings › Developer settings › GitHub Apps › New): webhook off;
   permissions Pull requests read/write, **Contents read/write** (an app approval only counts toward the
   ruleset with write access), Metadata, Checks and Commit statuses read. Install it on the selected
   repositories and download a private key.
2. Install the extension:

   ```console
   $ compozy extension install github:<owner>/compozy-github-app@v0.1.0 --allow-unverified --yes
   installed github-app-review 0.1.0 (global, all profiles)
   ```

3. Set the variables (or `compozy extension secrets bind ... --vault-ref <ref>` for an existing
   Vault reference):

   ```console
   $ compozy extension secrets set github-app-review --env GITHUB_APP_PRIVATE_KEY --value-stdin < app.private-key.pem
   $ printf '<app id>' | compozy extension secrets set github-app-review --value-stdin --env GITHUB_APP_ID
   $ printf '<installation id>' | compozy extension secrets set github-app-review --value-stdin --env GITHUB_APP_INSTALLATION_ID
   $ printf 'owner/repo' | compozy extension secrets set github-app-review --value-stdin --env GITHUB_APP_REPOS
   $ printf 'staging' | compozy extension secrets set github-app-review --value-stdin --env GITHUB_APP_BASE
   $ printf 'owner/repo:staging->main' | compozy extension secrets set github-app-review --value-stdin --env GITHUB_APP_PROMOTION
   $ printf 'login' | compozy extension secrets set github-app-review --value-stdin --env GITHUB_APP_PROMOTION_APPROVERS
   ```

   Delete the downloaded key file afterwards (`shred -u`).

| Variable | Meaning |
| --- | --- |
| `GITHUB_APP_ID` | App id |
| `GITHUB_APP_INSTALLATION_ID` | Installation id on the organization |
| `GITHUB_APP_PRIVATE_KEY` | The app private key (PEM); the only secret |
| `GITHUB_APP_REPOS` | Comma-separated `owner/name` allowlist |
| `GITHUB_APP_BASE` | The delivery branch the app reviews and gates, e.g. `main` or `staging` (required) |
| `GITHUB_APP_PROMOTION` | Optional `owner/name:head->base`, e.g. `acme/widgets:staging->main`; `head` must equal `GITHUB_APP_BASE` and `base` must differ from it (else `config_invalid`) |
| `GITHUB_APP_PROMOTION_APPROVERS` | Comma-separated GitHub logins allowed to approve promotions, e.g. `octocat` |

With a single-branch flow set `GITHUB_APP_BASE=main` and leave `GITHUB_APP_PROMOTION` unset. Every
variable is declared in `requires_env`; a missing `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_REPOS` or `GITHUB_APP_BASE` makes every tool fail with
`credential_absent` before any network call.

Installation tokens are minted per allowlisted repository (scoped to that one repository), cached until
5 minutes before they expire, and refreshed after a 401.

4. Check it:

   ```console
   $ compozy extension exec github-app-review --cmd doctor
   app: widgets-reviewer (id 123456)
   installation: 7890123 on acme (selected repositories)
   token mint: ok (expires in 59m)
   repos:
     acme/widgets: ok (pull_requests: write, contents: write, checks: read, statuses: read)
   duplicate reviews: none
   delivery base: staging
   promotion: staging -> main, approvers: octocat
   rate limit: 4987/5000 (resets 18:04Z)
   ```

   The doctor exits 1 when no token can be minted (missing or rejected key, or no allowlisted repository
   installed); the cause is in `-o json` under `error.details.operator_cause`, for example
   `token mint: failed (credential_absent: ...)` or `token mint: failed (401)`. A repository missing from
   the installation is listed as `not installed`. CompozyOS redacts values bound as extension secrets
   (repository names, approvers, ids) from tool text, so they can appear as `[REDACTED]`.

   `duplicate reviews` checks **open PRs only** (closed and merged PRs are not scanned; an accepted
   operator decision), up to 200 per installed repository, for a head with more
   than one app review carrying the same pass marker, the residual race of two concurrent `submit_review`
   calls. Each finding is one line under the heading, for example:

   ```text
   duplicate reviews:
     acme/widgets#231 head 9f2c1e0a7b3d pass=1: 2 reviews
   ```

   A PR whose review list exceeds the paging cap prints `<repo>#<n>: review history too large to check`.
   More than 200 open PRs prints `duplicate reviews: incomplete (more than 200 open PRs)` and skips the
   per-PR scan. The scan has a 10 s budget, well under the 25 s tool budget: past it the line is
   `duplicate reviews: unknown (scan timed out)`, and a failed read prints `duplicate reviews: unknown
   (<cause>)`. None of these fail the doctor; it still exits 0 when the token mint is ok.

## Tools

CompozyOS derives the tool IDs from the extension name with underscores:
`ext__github_app_review__<tool>`. Text fields that come from GitHub are untrusted data.

| Tool | Input | Returns |
| --- | --- | --- |
| `pr_context` (read) | `repo`, `number` | `head_sha`, refs, `author`, `state`, `is_draft`, `title`, `body`, `files`, `files_truncated`, `commentable` lines per path and side, `app_reviews` (with `pass`), `app_threads` (with the `commit_id` each was opened on) |
| `submit_review` (write) | `repo`, `number`, `head_sha`, `summary` (≤ 8 000), `findings` (≤ 50: `path`, `line`, `side?`, `start_line?`, `severity` `blocker\|major\|minor\|nit`, `title`, `body` ≤ 4 000), `rereview?` | `review_id`, `event`, `pass`, `inline`, `moved_to_summary`, `url` |
| `merge_gate` (read) | `repo`, `number`, `kind` (`delivery` \| `promotion`) | `ready`, `head_sha`, `reasons` |
| `upsert_promotion` (write) | `repo` (the `GITHUB_APP_PROMOTION` repository) | `created`, `number`, `url`, `head_sha`, `included_prs` |
| `doctor` (read; operator) | — | The doctor report; agents should not call it |

`merge_gate kind=delivery` is ready when: the PR is open with base `GITHUB_APP_BASE`; the app's latest review is
`APPROVED` on the current head; no `CHANGES_REQUESTED` on the current head; every check run on the head
succeeded or was skipped; GitHub reports it `MERGEABLE`; zero unresolved review threads. Reasons, one
per failed condition in this order: `pr_not_open`, `base_mismatch`, `no_app_approval_on_head` /
`approval_not_on_head`, `history_incomplete`, `changes_requested`, `checks_pending`, `checks_failed`,
`not_mergeable`, `unresolved_threads`.

Both gates read the PR's reviews and the head's check runs completely (pages of 100). If either list is
longer than the safety cap (50 pages), the gate never decides on a prefix: it answers `ready:false` with
`history_incomplete`. Review threads and each thread's comments are also paged to the end under the same
cap; a capped thread list also gives `history_incomplete`. `pr_context` reads the same complete lists
and fails with `github_unavailable` at the cap instead of returning a prefix.

`submit_review` with `rereview: true` posts pass 2 on the same head only when, on that head: exactly one
app pass-1 review exists (two pass-1 reviews from concurrent calls fail closed); no pass 2 exists; and an
app thread opened on that head has a comment from a non-bot author created after the app's latest review
of the head (`created_at` > `submitted_at`). Anything else fails `rereview_not_eligible`.

Before posting, `submit_review` re-reads the review history (complete, or it refuses with
`github_unavailable`) and then re-fetches the PR: if it is no longer open, became a draft, was retargeted
away from `GITHUB_APP_BASE`, or its head moved, it refuses (`pr_not_reviewable`, `base_not_reviewable`,
`head_moved`) and posts nothing. GitHub offers no compare-and-swap on reviews, so a change in the
moment between that last read and the POST remains possible; `commit_id` still pins the review to the
head that was checked.

Findings outside the diff keep their full text in the review body. If the assembled body (marker,
summary and those findings) exceeds 60 000 characters (GitHub's limit is 65 536), the call is refused with
`field_too_long` naming the review body, and nothing is posted.

`merge_gate kind=promotion` (BR-8) applies to the `GITHUB_APP_PROMOTION` repository only and is ready
when: the PR is open and authored by the app (`<slug>[bot]`); its base and head are the configured
promotion branches (else `base_mismatch`; the repository's default branch plays no part); the latest
`APPROVED`/`CHANGES_REQUESTED` review of a login in `GITHUB_APP_PROMOTION_APPROVERS` (case-insensitive;
never the app) is `APPROVED` on the current head; plus the delivery rules for changes requested, checks,
mergeability and threads. Reasons in order: `pr_not_open`, `not_app_authored`, `base_mismatch`,
`promotion_not_approved`, `history_incomplete`, `changes_requested`, `checks_pending`, `checks_failed`, `not_mergeable`,
`unresolved_threads`.

`upsert_promotion` compares `base...head` of `GITHUB_APP_PROMOTION`. No commits →
`{"created":false,"number":null,"url":null,"head_sha":null,"included_prs":[]}` and nothing is written.
An open `head → base` PR by another author → `promotion_conflict` naming it, nothing written. An open
PR by the app → its body is updated (`PATCH`) with the current PR list, `created:false`. Otherwise it
opens the PR (`POST`), `created:true`. `included_prs` are the `#N` references in the compared commits'
subjects (`title (#N)` squash or `Merge pull request #N` merge commits). The comparison is paged until
every commit is read; beyond the safety cap (50 pages of 100) it refuses with `github_unavailable`
("comparison too large") and writes nothing. Without
`GITHUB_APP_PROMOTION`, or for another repository, both promotion tools refuse with `invalid_input`.

`submit_review` writes the marker `<!-- github-app-review head=<sha> pass=<n> -->` as the first line of
every review body; the pass of earlier reviews is read back from it, so no local state is kept. Inline
comments start with `<severity>: <title>`.

Each call logs one line to the extension log (`compozy extension logs github-app-review --global`):
`tool`, `repo`, `pr`, `head_sha` (12 chars), `pass`, `event`, `inline`, `moved`, `outcome`,
`github_status`, `duration_ms`. Never bodies, tokens or key material.

## Errors

Tool errors reach agents as three lines: the CompozyOS code with its fixed text, then `Cause:` (the
extension code and message), then `Recovery:`. For example:

```text
tool_invalid_input: invalid tool request
Cause: head_moved: head_sha 1a2b… is not the current head; current head is 9f2c…
Recovery: end with stale: and let the dispatcher review the new head
```

| Cause starts with | First line | Recovery |
| --- | --- | --- |
| `credential_absent` | `tool_unavailable: tool unavailable` | `run compozy extension secrets set github-app-review --env GITHUB_APP_PRIVATE_KEY --value-stdin` |
| `config_invalid` (`GITHUB_APP_PROMOTION` malformed or not `GITHUB_APP_BASE->other`) | `tool_unavailable: tool unavailable` | `fix the named variable with compozy extension secrets set github-app-review --env <NAME> --value-stdin` |
| `credential_invalid` | `tool_unavailable: tool unavailable` | `re-bind the app private key; run compozy extension exec github-app-review --cmd doctor` |
| `repo_not_allowed` | `tool_invalid_input: invalid tool request` | `use an allowlisted repository` |
| `repo_not_installed` | `tool_unavailable: tool unavailable` | `install the app on the repository` |
| `invalid_input` | `tool_invalid_input: invalid tool request` | `fix the named field` |
| `too_many_findings` / `field_too_long` | `tool_invalid_input: invalid tool request` | `merge findings or shorten the text` |
| `field_too_long` (assembled review body over 60 000) | `tool_invalid_input: invalid tool request` | `split or shorten findings` |
| `pr_not_reviewable` | `tool_invalid_input: invalid tool request` | `review only open, non-draft PRs` |
| `base_not_reviewable` | `tool_invalid_input: invalid tool request` | `the app reviews only pull requests into GITHUB_APP_BASE` |
| `head_moved` | `tool_invalid_input: invalid tool request` | `end with stale: and let the dispatcher review the new head` |
| `already_reviewed_head` | `tool_invalid_input: invalid tool request` | `nothing to do for this head` |
| `rereview_not_eligible` | `tool_invalid_input: invalid tool request` | `the executor must change code or reply on a bot thread` |
| `promotion_conflict` (names the PR) | `tool_invalid_input: invalid tool request` | `operator closes or merges that PR` |
| `rate_limited` (reset time) | `tool_unavailable: tool unavailable` | `retry after the reset time` |
| `github_rejected` (GitHub message) | `tool_backend_failed: tool backend failed` | `report; anchors drifted` |
| `github_unavailable` (5xx, network, 10 s request timeout; review history, review threads or comparison too large to read completely) | `tool_backend_failed: tool backend failed` | `retry later; run compozy extension exec github-app-review --cmd doctor if it persists` |

The CLI (`compozy tool invoke`, `compozy extension exec`) prints only the first line in human output and
exits non-zero; `-o json` carries `operator_cause` and `operator_recovery`.

## Reviewer sandbox

The reviewer agent runs its provider's ACP agent inside a network-less bubblewrap sandbox
(`bin/reviewer-sandbox`). Its only egress is an allowlist gateway (`bin/reviewer-gateway`): the selected
provider adapter's API hosts and the session's MCP bridge port. The sandbox core is provider-neutral, and
one adapter per provider (`--provider claude|codex|cursor`, `--login-dir <dedicated login dir>`) supplies
the ACP command, config env, egress hosts and login identity. `claude`, `codex` and `cursor` are implemented
(the codex and cursor egress lists are provisional until IT-020).

Before each session the wrapper refreshes the dedicated login on the host when its token would expire
within the session budget (`--session-budget-min`, default 30, plus `--refresh-margin-min`, default 10),
checks that the refreshed login is the same account and organization, and saves it atomically. Nothing a
session writes ever comes back; any refresh failure leaves the host login untouched and refuses the
session (except a same-account refreshed token too short for the session budget, which is saved and still refuses the session) (`login-refresh refused (<reason>)` in the gateway log). Both scripts ship in the installed
package under `bin/`, so the `claude-reviewer` and `claude-reviewer-fallback` provider overlays point at
`~/.compozy/extensions/github-app-review/bin/reviewer-sandbox`. Setup, the overlays, `--self-check`, the
refresh rules and troubleshooting are in [docs/reviewer-sandbox.md](docs/reviewer-sandbox.md).

## Development

```console
$ bun install
$ bun run typecheck && bun test        # unit tests against the in-process fake GitHub
$ bun scripts/mutation.ts              # rules.ts mutation check; prints a table, exits 1 if a mutant survives
$ bun run build                        # dist/index.js plus bin/ and docs/ (shipped in the package)
```

`GITHUB_APP_API_URL` (optional, default `https://api.github.com`) points the extension at another GitHub
API base URL. It is not a declared variable: tests pass it in the injected environment, and the
integration tests set it through a test-only copy of the manifest (`[subprocess] env`).

### Integration tests through CompozyOS (isolated home)

`scripts/it-env.sh` runs `compozy` with `COMPOZY_HOME=/tmp/ghar-it/home` (override `IT_HOME`), its own
socket and HTTP port 2391 (override `IT_PORT`), with every inherited `COMPOZY_*` variable dropped. It
refuses port 2123 and the operator's `~/.compozy`. Its first run writes the isolated `config.toml`, and
it adds the recommended tool policy when missing (only under `$IT_HOME`):

```toml
[tools.policy]
trusted_sources = ["extension:github-app-review"]
```

In CompozyOS 0.7.4 a trusted source only passes read-only tools. The mutating `submit_review` and
`upsert_promotion` are granted by the calling agent's `tools:` allowlist (as the reviewer and merge
agents are in a real deployment), so `scripts/it.ts` writes a test-only `it-reviewer` agent into `$IT_WS` and invokes
every tool with `--agent it-reviewer`. `tools.policy.external_default` is not needed.

```console
$ bun test/fake-github.ts --port 8790 &                  # fake GitHub (control: /_fake/state, /_fake/reset, /_fake/requests)
$ scripts/it-env.sh daemon start
$ mkdir -p /tmp/ghar-it/ws && scripts/it-env.sh workspace add /tmp/ghar-it/ws
$ bun run build && scripts/it-env.sh extension build .
$ bun scripts/it-setup.ts                                # installs a test copy with GITHUB_APP_API_URL, binds a throwaway key
$ bun scripts/it.ts                                      # IT-001, IT-002, IT-003, IT-004, IT-005, IT-006
$ scripts/it-env.sh daemon stop
```
