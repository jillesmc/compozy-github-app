# compozy-github-app

CompozyOS extension `github-app-review`: a GitHub App that reviews pull requests opened by agents. Agents call
tools (`pr_context`, `submit_review`, `merge_gate`, later `upsert_promotion`) plus an operator `doctor`;
only the extension subprocess holds the app key and installation tokens. The design contract, when present,
lives in `.compozy/tasks/github-app-review/` (kept local, not tracked). Implement exactly that contract;
record any deviation in the spec before coding it. README and `docs/` describe the shipped behaviour.

## Stack

- TypeScript, ESM, Node.js >= 22 at runtime, `@compozy/extension-sdk` pinned to `0.7.3`.
- Build: `bun run build` (`tsc --noEmit` + `bun build src/index.ts --target=node --outfile=dist/index.js`
  + copy `bin/` and `docs/` into `dist/` so the package ships the reviewer sandbox), then `compozy extension build` produces the installable generation under `dist/gen-<hash>`.
- Tests: `bun test`. Fakes only at the GitHub HTTP boundary (in-process `node:http` server in
  `test/fake-github.ts`); inject `fetch` and the clock. Test keys are throwaway RSA keys generated at
  test time. No real GitHub calls in automated tests.
- `bin/` (reviewer sandbox and gateway, slice S3) runs under Node >= 24 type stripping, imports nothing
  from `src/`, and is type-checked by `tsc` like the rest (`allowImportingTsExtensions` + `noEmit`); its
  tests in `test/sandbox/` use `node:test` like the other suites.
- Runtime dependencies: only `@compozy/extension-sdk`; Node built-ins otherwise (JWT RS256 with
  `node:crypto`).

## Rules

- Only `src/index.ts` builds the SDK `Extension` and reads `process.env`.
- Only `src/auth.ts` touches the private key (JWT, installation tokens). `src/github.ts` takes a token
  provider and never imports `auth.ts` internals.
- `src/rules.ts` is pure (no I/O, no imports from `github.ts`/`auth.ts`) and is the mutation target:
  after changing it run `bun scripts/mutation.ts`; every mutant must be killed.
- Never log, return, or persist the key or a token; log lines carry codes and counts only, never
  review bodies or summaries (UT-073). Never follow redirects with a token (`redirect: "manual"`).
- The review event is derived from severities, never taken from input. Never push or merge; review and
  approve only PRs whose base is `GITHUB_APP_BASE`, and never approve a promotion PR.
- No company-specific data in tracked files: examples use `acme/widgets`, `octocat` and
  `/home/user`; `test/denylist.test.ts` enforces it.
- Keep source files cohesive and small (< 300 lines); extract before growing.
- Test IDs from `_tests.md` appear in test names (e.g. `UT-020 submit_review: ...`).
- Integration tests run only against an isolated CompozyOS home (`scripts/it-env.sh`); never install
  into or change the operator's `~/.compozy` or daemon on port 2123.
- Before committing: `bun run typecheck && bun test` pass with zero errors.
- Commits: `<type>: <description>` with `feat|fix|refactor|perf|docs|test|build|ci`, no scopes.
  Never change `user.*`, `user.signingkey`, or signing settings.
- Docs, code, commits and specs in English.
