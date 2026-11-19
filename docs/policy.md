# Policy file (github-app-review ≥ 0.3.0)

The policy decides which repositories the app serves, which branch it reviews and gates in each, which
promotion it may open there, and who approves that promotion. It is operator configuration, never
project configuration: it is not read from any repository, and the extension honors it only at a digest
the operator approved.

## Files

| File | Written by | Read by tools |
| --- | --- | --- |
| Working copy: `GITHUB_APP_POLICY_FILE` (must be an absolute path, else `config_invalid` naming the variable), else `$XDG_CONFIG_HOME/compozy-github-app/policy.toml` (only when `XDG_CONFIG_HOME` is absolute), else `$HOME/.config/compozy-github-app/policy.toml` (the OS home directory when `HOME` is unset or relative) | the operator (editor, or factory tooling) | never |
| Approved versions: `<dir of the working copy>/policies/<sha256>.toml` | `--cmd policy-stage`, or any tool that writes the same bytes under the same name | the one named by `GITHUB_APP_POLICY_DIGEST` |

A version file is a **byte-for-byte copy** of the working copy; its name is the lowercase hex sha256 of
those bytes followed by `.toml`. `policy-stage` creates the `policies/` directory with mode `0700`, writes
the file with mode `0444` through a temporary file and `rename`, and never overwrites: a file with that
name and the same bytes is `unchanged`; with other bytes it refuses (`config_invalid`). If the temporary
file `<version>.<pid>.tmp` already exists (a stale one) or the write or `rename` fails, it removes the
temporary file, writes nothing and refuses with `config_invalid`. Versions are kept;
switching `GITHUB_APP_POLICY_DIGEST` moves every repository from one approved version to the next at once.

## Approval (every agent tool, every call)

1. `GITHUB_APP_POLICY_DIGEST` (whitespace trimmed) must be 64 lowercase hex characters; unset, empty or
   anything else → `policy_unapproved`.
2. The extension reads `policies/<digest>.toml` **once** into a buffer. Absent → `policy_unapproved`; any
   other read failure → `config_invalid` naming the path.
3. `sha256(buffer)` must equal the digest, else `policy_unapproved`.
4. The **same buffer** is decoded (strict UTF-8, else `config_invalid`) and parsed (below; any deviation
   → `config_invalid` naming the path and line). The parsed policy is frozen and used for the whole call.

All of this happens before credentials are used or any network call is made, and nothing ever falls back
to another version. The operator commands `policy` and `policy-stage` skip this check, need no credentials
and make no network call, so the first approval is possible.

## Format

A strict subset of TOML. A file in this subset is valid TOML with the same meaning; TOML outside the
subset is refused rather than interpreted.

```toml
# Comments and blank lines anywhere.
[repos."acme/widgets"]
delivery_base = "staging"
promotion = { head = "staging", base = "main" }   # optional
approvers = ["octocat"]                           # required when promotion is set

[repos."acme/gadgets"]
delivery_base = "main"
```

Lexical rules (line by line; a trailing `\r` is ignored):

- The file is UTF-8 without a byte order mark; a BOM is refused.
- Whitespace is space and tab only. Any other Unicode whitespace (no-break space, U+2028, …) is not
  whitespace: outside a comment it is unexpected text and refused (inside strings the schema refuses it).
- A line is blank, a comment (`#` first non-blank character), a table header, or `key = value`, each
  optionally followed by spaces/tabs and a `# comment`.
- The only table header is `[repos."<owner>/<name>"]` (or with single quotes); spaces/tabs are allowed
  only right after `[` and right before `]`, never around `repos` or the `.` (TOML itself allows
  whitespace around the dot; this subset refuses it, so a TOML parser used for staging must check it
  separately). No other table, no array of tables, no dotted keys, no key before the first header.
- Keys are bare (`[A-Za-z0-9_-]+`); a key may appear once per table.
- A value is one of: a string (`"…"` without backslashes, or `'…'`), an array of strings on one line
  (`["a", "b"]`, a trailing comma allowed), or an inline table of string values on one line
  (`{ head = "a", base = "b" }`, no trailing comma). No escapes, multi-line strings, multi-line arrays,
  numbers, booleans or nested tables.
- Control characters other than tab are refused anywhere in the file.

Schema rules (per `[repos."…"]` table):

| Key | Required | Rule |
| --- | --- | --- |
| table name | — | `owner/name` matching `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`; unique case-insensitively (lookups are case-insensitive) |
| `delivery_base` | yes | branch name matching `^[A-Za-z0-9._/-]+$` |
| `promotion` | no | inline table with exactly `head` and `base`, both branch names; `head` equals `delivery_base`; `base` differs from it |
| `approvers` | when `promotion` is set (then non-empty) | array of GitHub logins matching `^[A-Za-z0-9-]+$` |

Any other key is refused. A file with no table is valid and serves no repository (every tool answers
`repo_not_allowed`).

## Commands

```console
$ compozy extension exec github-app-review --cmd policy
working   /home/user/.config/compozy-github-app/policy.toml  digest <sha256>
active    unset (GITHUB_APP_POLICY_DIGEST)
state     not staged; run compozy extension exec github-app-review --cmd policy-stage
repos     + acme/widgets
$ compozy extension exec github-app-review --cmd policy-stage
staged    /home/user/.config/compozy-github-app/policies/<sha256>.toml
activate  printf <sha256> | compozy extension secrets set github-app-review --env GITHUB_APP_POLICY_DIGEST --value-stdin
```

`policy` is read-only and always exits 0. Lines: `working` (path, digest of the working copy, or the
error that stops it from parsing), `active` (`unset`, `<digest> (policies/<digest>.toml)`, or
`<digest> unapproved|invalid (<cause>)`), `state` (`approved`, `staged, not active; activate: …`, or
`not staged`), then one `repos` line per repository that differs between the working copy and the active
version: `+` added, `-` removed, `~` changed. `-o json` carries the same as `working`, `active`,
`working_staged`, `working_active` and `repos` (`added`, `removed`, `changed`).

`policy-stage` refuses an absent or invalid working copy with `config_invalid` and writes nothing. It
prints `staged` or `unchanged` with the version path, and the `secrets set` line unless that digest is
already active. It is declared read-only (it changes no GitHub or approval state), so a
`trusted_sources = ["extension:github-app-review"]` policy lets the operator run it.

Agents can invoke it too (`ext__github_app_review__policy_stage`, like every extension tool), and that
is harmless: it only copies the operator's working copy under the name of its own sha256 (so a version
file always hashes to its name), it refuses an existing version with different bytes, and it never sets
`GITHUB_APP_POLICY_DIGEST` — a staged version approves nothing until the operator activates it.

After `secrets set`, verify with `policy -o json`: `result.structured.active.state` is `approved`,
`active.digest` is the staged digest and `working_active` is `true`. A running extension keeps the
environment it started with, so it still reports the old digest (or `unset`) until it is restarted
(`compozy extension disable github-app-review && compozy extension enable github-app-review`); then check
again.

Reading the output: the human `compozy extension exec` view of a successful command shows only the
invocation summary; the text above is `result.content` in `-o json`. Because the digest is bound as an
extension secret, CompozyOS redacts it from tool text once it is active (`active    [REDACTED] (…)`, and
the working digest too when equal). The `state` line and the `structured` fields are not affected; use
them to verify.

## Limit

Agents that run as the operator's OS user with terminal access can write a version file and run
`compozy extension secrets set` themselves. The digest blocks edits that skip the approval step; it does
not separate two processes of the same user. The same holds for every extension secret today.
