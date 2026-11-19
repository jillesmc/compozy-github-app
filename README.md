# github-app-review

CompozyOS extension that lets agents review pull requests as a GitHub App. The app key lives
only in the extension subprocess; agents call tools and never see a token. The extension enforces the
review rules in code:

- the review event is derived from the findings' severities (any `blocker`/`major` →
  `REQUEST_CHANGES`, otherwise `APPROVE`); the agent cannot choose it;
- a review is posted only on the PR's current head (`commit_id = head_sha`);
- one review per head (pass 1), plus one contested re-review of the same head (pass 2);
- only repositories of the operator's **approved policy** (a digest-addressed file, see
  [docs/policy.md](docs/policy.md)); an unapproved or edited policy makes every tool refuse;
- findings outside the diff move to the review summary under "Outside the diff", never dropped;
- per repository, the app reviews only pull requests into its delivery branch (`delivery_base`, for
  example `main` or `staging`); any other base is refused;
- optionally, per repository, the app opens a promotion PR from that branch into another one
  (`upsert_promotion`, e.g. `staging` → `main`) and a policy approver approves it on GitHub; the app
  never approves or merges it.

## Install

1. Create the GitHub App (organization Settings › Developer settings › GitHub Apps › New): webhook off;
   permissions Pull requests read/write, **Contents read/write** (an app approval only counts toward the
   ruleset with write access), Metadata, Checks and Commit statuses read. Install it on the selected
   repositories and download a private key.
2. Install the extension:

   ```console
   $ compozy extension install github:<owner>/compozy-github-app@v0.3.0 --allow-unverified --yes
   installed github-app-review 0.3.0 (global, all profiles)
   ```

3. Set the credentials (or `compozy extension secrets bind ... --vault-ref <ref>` for an existing
   Vault reference):

   ```console
   $ compozy extension secrets set github-app-review --env GITHUB_APP_PRIVATE_KEY --value-stdin < app.private-key.pem
   $ printf '<app id>' | compozy extension secrets set github-app-review --value-stdin --env GITHUB_APP_ID
   $ printf '<installation id>' | compozy extension secrets set github-app-review --value-stdin --env GITHUB_APP_INSTALLATION_ID
   ```

   Delete the downloaded key file afterwards (`shred -u`).

| Variable | Meaning |
| --- | --- |
| `GITHUB_APP_ID` | App id (required) |
| `GITHUB_APP_INSTALLATION_ID` | Installation id on the organization (required) |
| `GITHUB_APP_PRIVATE_KEY` | The app private key (PEM); the only secret (required) |
| `GITHUB_APP_POLICY_DIGEST` | sha256 of the approved policy version to honor (optional: while unset every tool refuses with `policy_unapproved`) |
| `GITHUB_APP_POLICY_FILE` | Absolute path of the policy working copy (optional, else `config_invalid`; default `$XDG_CONFIG_HOME/compozy-github-app/policy.toml`, else `~/.config/compozy-github-app/policy.toml`) |

All five are declared in `requires_env`; the extension stays active while the two optional ones are
unset. A missing credential makes every tool fail with `credential_absent` before any network call.

4. Write the policy and approve it. The working copy holds one block per repository (exact format in
   [docs/policy.md](docs/policy.md)):

   ```toml
   [repos."acme/widgets"]
   delivery_base = "staging"
   promotion = { head = "staging", base = "main" }   # optional
   approvers = ["octocat"]                           # required when promotion is set
   ```

   Tools never read the working copy. `policy-stage` copies it, schema-checked, to the immutable
   `policies/<sha256>.toml` next to it, and the digest secret activates that version:

   ```console
   $ compozy extension exec github-app-review --cmd policy-stage
   staged    /home/user/.config/compozy-github-app/policies/9c1d…e7.toml
   activate  printf 9c1d…e7 | compozy extension secrets set github-app-review --env GITHUB_APP_POLICY_DIGEST --value-stdin
   $ printf 9c1d…e7 | compozy extension secrets set github-app-review --env GITHUB_APP_POLICY_DIGEST --value-stdin
   $ compozy extension exec github-app-review --cmd policy
   working   /home/user/.config/compozy-github-app/policy.toml  digest 9c1d…e7
   active    9c1d…e7 (policies/9c1d…e7.toml)
   state     approved (the working copy is the active version)
   ```

   A running extension keeps the environment it started with: if `policy -o json` still shows the old
   `active.digest` (or `unset`), restart the extension (`compozy extension disable github-app-review &&
   compozy extension enable github-app-review`) and check again. Once active, CompozyOS redacts the digest
   (a secret value) in tool text; the `state` line and the `structured` JSON fields stay readable (see
   [docs/policy.md](docs/policy.md#commands)). With a single-branch flow set `delivery_base = "main"` and
   omit `promotion`.

Installation tokens are minted per policy repository (scoped to that one repository), cached until
5 minutes before they expire, and refreshed after a 401.

5. Check it:

   ```console
   $ compozy extension exec github-app-review --cmd doctor
   app: widgets-reviewer (id 123456)
   installation: 7890123 on acme (selected repositories)
   token mint: ok (expires in 59m)
   policy: approved 9c1d…e7 (/home/user/.config/compozy-github-app/policies/9c1d…e7.toml)
   repos:
     acme/widgets: ok (pull_requests: write, contents: write, checks: read, statuses: read)
       delivery base: staging; promotion: staging -> main, approvers: octocat
   duplicate reviews: none
   rate limit: 4987/5000 (resets 18:04Z)
   ```

   The doctor exits 1 when the policy is not approved (`policy: unapproved (...)` or `invalid`) or no
   token can be minted (missing or rejected key, or no policy repository installed); the cause is in
   `-o json` under `error.details.operator_cause`, for example `token mint: failed (credential_absent: ...)`,
   `token mint: not attempted (policy unapproved)` or `token mint: failed (401)`. A repository missing from
   the installation is listed as `not installed`. CompozyOS redacts values bound as extension secrets
   (ids) from tool text, so they can appear as `[REDACTED]`.

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
| `pr_context` (read) | `repo`, `number` | `head_sha`, refs, `author`, `state`, `is_draft`, `title`, `body`, `files`, `files_truncated`, `commentable` lines per path and side, `app_reviews` (with `pass`), `app_threads` (with the `commit_id` each was opened on), `conventions` (`ref`, `review_md`, `factory_toml`: the `REVIEW.md` and `.compozy/factory/factory.toml` of the base branch, `null` when absent, so a PR never supplies the rules it is judged by) |
| `submit_review` (write) | `repo`, `number`, `head_sha`, `summary` (≤ 8 000), `findings` (≤ 50: `path`, `line`, `side?`, `start_line?`, `severity` `blocker\|major\|minor\|nit`, `title`, `body` ≤ 4 000), `rereview?` | `review_id`, `event`, `pass`, `inline`, `moved_to_summary`, `url` |
| `merge_gate` (read) | `repo`, `number`, `kind` (`delivery` \| `promotion`) | `ready`, `head_sha`, `reasons` |
| `upsert_promotion` (write) | `repo` (a policy repository with `promotion`), `key_pattern?` (regular expression of one work-item key, ≤ 200 chars) | `created`, `number`, `url`, `head_sha`, `included_prs` |
| `doctor` (read; operator) | — | The doctor report; agents should not call it |
| `policy` (read; operator, `--cmd policy`) | — | Working-copy digest, active digest, approval state, repo diff; no credentials or network |
| `policy_stage` (operator, `--cmd policy-stage`; declared read-only: it only writes the idempotent `policies/<sha256>.toml` copy and activates nothing) | — | Stages the working copy as `policies/<sha256>.toml`; no credentials or network |

Every agent tool loads the approved policy first, on every call, before any network call: unset or
mismatched `GITHUB_APP_POLICY_DIGEST`, or an absent version file → `policy_unapproved`; a version that
does not parse → `config_invalid`; a repository not in it → `repo_not_allowed`. `repo` resolves that
repository's `delivery_base`, `promotion` and `approvers`.

`merge_gate kind=delivery` is ready when: the PR is open with base the repository's `delivery_base`; the app's latest review is
`APPROVED` on the current head; no `CHANGES_REQUESTED` on the current head; every check run on the head
succeeded, was skipped or ended `neutral` (as GitHub treats it); GitHub reports it `MERGEABLE`; zero unresolved review threads. Reasons, one
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
away from the repository's `delivery_base`, or its head moved, it refuses (`pr_not_reviewable`, `base_not_reviewable`,
`head_moved`) and posts nothing. GitHub offers no compare-and-swap on reviews, so a change in the
moment between that last read and the POST remains possible; `commit_id` still pins the review to the
head that was checked.

Findings outside the diff keep their full text in the review body. If the assembled body (marker,
summary and those findings) exceeds 60 000 characters (GitHub's limit is 65 536), the call is refused with
`field_too_long` naming the review body, and nothing is posted.

`merge_gate kind=promotion` (BR-8) applies to a policy repository with `promotion` and is ready
when: the PR is open and authored by the app (`<slug>[bot]`); its base and head are the repository's
promotion branches (else `base_mismatch`; the repository's default branch plays no part); the latest
`APPROVED`/`CHANGES_REQUESTED` review of a login in the repository's `approvers` (case-insensitive;
never the app) is `APPROVED` on the current head; plus the delivery rules for changes requested, checks,
mergeability and threads. Reasons in order: `pr_not_open`, `not_app_authored`, `base_mismatch`,
`promotion_not_approved`, `history_incomplete`, `changes_requested`, `checks_pending`, `checks_failed`, `not_mergeable`,
`unresolved_threads`.

`upsert_promotion` compares `base...head` of the repository's `promotion`. No commits →
`{"created":false,"number":null,"url":null,"head_sha":null,"included_prs":[]}` and nothing is written.
An open `head → base` PR by another author → `promotion_conflict` naming it, nothing written. An open
PR by the app → its title and body are updated (`PATCH`) with the current PR list, `created:false`. Otherwise it
opens the PR (`POST`), `created:true`. `included_prs` are the `#N` references in the compared commits'
subjects (`title (#N)` squash or `Merge pull request #N` merge commits). The title is `KEY-1, KEY-2: Promote <head> to <base>`; keys that do not fit GitHub's 256 characters become `+N`, and no key leaves the plain `Promote <head> to <base>`. The keys depend on `key_pattern` (a regular expression of one whole key, e.g. a work adapter's key format):

- absent: Jira-shaped keys (`^[A-Z][A-Z0-9]+-\d+$`) from the same subjects, as before 0.3.0;
- a pattern that matches `#1` and `#205` (GitHub issues, e.g. `^#\d+$`): the issues each included PR
  closes, read from its body (`GET pulls/{n}`, one per included PR): `Closes|Fixes|Resolves #N` and the
  other GitHub closing keywords (`close`, `closed`, `fix`, `fixed`, `resolve`, `resolved`, any case, optional
  `:`). Same-repository `#N` only; the PR's own number, `Refs #N` and commit-message references are never keys;
- any other pattern: keys from the subjects like the default, with that pattern: the text before the
  first `:` of a squash subject, or the shortest `-`-separated prefix of a merge commit's branch
  (`Merge pull request #N from <owner>/<branch>`), when the pattern matches it whole.

A pattern that does not compile → `invalid_input` before any network call. A key is at most 20 characters of `[A-Za-z0-9#_.-]`; a supplied pattern runs at most once per distinct candidate and within a per-call budget (500 candidates or 250 ms spent matching; waiting on GitHub does not count), past which the title is the plain one. The comparison is paged until
every commit is read; beyond the safety cap (50 pages of 100) it refuses with `github_unavailable`
("comparison too large") and writes nothing. For a policy
repository without `promotion`, both promotion tools refuse with `invalid_input`.

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
| `policy_unapproved` (digest unset or not a sha256, version file absent, or its bytes do not hash to the digest) | `tool_unavailable: tool unavailable` | `operator stages and approves the policy: compozy extension exec github-app-review --cmd policy-stage, then set GITHUB_APP_POLICY_DIGEST` |
| `config_invalid` (policy file unreadable or malformed, naming the path and line) | `tool_unavailable: tool unavailable` | `operator fixes the named policy file; run compozy extension exec github-app-review --cmd policy` |
| `credential_invalid` | `tool_unavailable: tool unavailable` | `re-bind the app private key; run compozy extension exec github-app-review --cmd doctor` |
| `repo_not_allowed` | `tool_invalid_input: invalid tool request` | `use a repository of the approved policy; the operator adds others with policy-stage` |
| `repo_not_installed` | `tool_unavailable: tool unavailable` | `install the app on the repository` |
| `invalid_input` | `tool_invalid_input: invalid tool request` | `fix the named field` |
| `too_many_findings` / `field_too_long` | `tool_invalid_input: invalid tool request` | `merge findings or shorten the text` |
| `field_too_long` (assembled review body over 60 000) | `tool_invalid_input: invalid tool request` | `split or shorten findings` |
| `pr_not_reviewable` | `tool_invalid_input: invalid tool request` | `review only open, non-draft PRs` |
| `base_not_reviewable` | `tool_invalid_input: invalid tool request` | `the app reviews only pull requests into the repository's delivery_base` |
| `head_moved` | `tool_invalid_input: invalid tool request` | `end with stale: and let the dispatcher review the new head` |
| `already_reviewed_head` | `tool_invalid_input: invalid tool request` | `nothing to do for this head` |
| `rereview_not_eligible` | `tool_invalid_input: invalid tool request` | `the executor must change code or reply on a bot thread` |
| `promotion_conflict` (names the PR) | `tool_invalid_input: invalid tool request` | `operator closes or merges that PR` |
| `rate_limited` (reset time) | `tool_unavailable: tool unavailable` | `retry after the reset time` |
| `github_rejected` (GitHub message) | `tool_backend_failed: tool backend failed` | `report; anchors drifted` |
| `github_unavailable` (5xx, network, 10 s request timeout; review history, review threads or comparison too large to read completely) | `tool_backend_failed: tool backend failed` | `retry later; run compozy extension exec github-app-review --cmd doctor if it persists` |

The CLI (`compozy tool invoke`, `compozy extension exec`) prints only the first line in human output and
exits non-zero; `-o json` carries `operator_cause` and `operator_recovery`.

## Migrating from 0.2.x

BREAKING (0.3.0): `GITHUB_APP_REPOS`, `GITHUB_APP_BASE`, `GITHUB_APP_PROMOTION` and
`GITHUB_APP_PROMOTION_APPROVERS` are removed; 0.3.0 neither declares nor reads them, and until a policy
is approved every tool refuses with `policy_unapproved`. Move them to the policy working copy
`~/.config/compozy-github-app/policy.toml` ([docs/policy.md](docs/policy.md)), one block per repository
of the old `GITHUB_APP_REPOS`:

```toml
[repos."<owner/name>"]
delivery_base = "<GITHUB_APP_BASE>"
promotion = { head = "<head>", base = "<base>" }   # from GITHUB_APP_PROMOTION <owner/name>:<head>-><base>, on that repository only
approvers = ["<login>", ...]                       # GITHUB_APP_PROMOTION_APPROVERS, required with promotion
```

The old values are write-only secrets: take them from where you recorded them. Then stage and activate:

```console
$ compozy extension exec github-app-review --cmd policy-stage      # prints the secrets set line
$ printf <sha256> | compozy extension secrets set github-app-review --env GITHUB_APP_POLICY_DIGEST --value-stdin
$ compozy extension disable github-app-review && compozy extension enable github-app-review
$ compozy extension exec github-app-review --cmd policy -o json    # active.state "approved", working_active true
$ compozy extension secrets unset github-app-review --env GITHUB_APP_REPOS   # and the other three removed keys
```

`upsert_promotion` keeps its 0.2 title without `key_pattern`. The doctor report moves the delivery base
and promotion lines under each repository and adds a `policy:` line.

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
$ bun scripts/it-setup.ts                                # installs a test copy (API URL, policy file under /tmp/ghar-it/policy), binds a throwaway key
$ bun scripts/it.ts                                      # policy approval flow, two-repo policy, IT-001 … IT-006
$ scripts/it-env.sh daemon stop
```
