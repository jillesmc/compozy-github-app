/** Recorded-shape GitHub fixtures for the `_dx.md` example (PR #231). */
export const REPO = "acme/widgets";
export const HEAD = "9f2c1e0a7b3d4c5e6f708192a3b4c5d6e7f80912";
export const OLD_HEAD = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
/** Head of `staging` in the promotion fixture (`_dx.md` upsert_promotion example). */
export const PROMO_HEAD = "c0ffee1234567890abcdef1234567890abcdef12";
export const SLUG = "widgets-reviewer";
export const BOT = `${SLUG}[bot]`;

/** RIGHT lines 10, 11, 12, 40, 41; LEFT lines 10, 11, 12. */
export const EXPORT_PATCH = "@@ -10,3 +10,3 @@ export\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n@@ -38,2 +40,2 @@\n+const x = 5;\n+const y = 6;";

export interface FakeState {
  repo: string;
  app: { id: number; slug: string };
  installation: { id: number; account: { login: string }; repository_selection: string };
  installedRepos: string[];
  permissions: Record<string, string>;
  tokenExpiresAt: string;
  minted: number;
  rejectJwt: boolean;
  /** Answer this many repository calls with 401. */
  rejectTokens: number;
  rateLimit: { limit: number; remaining: number; reset: number };
  pr: any;
  files: any[];
  reviews: any[];
  /** One-shot reviews list for the next GET (simulates a concurrent pass 1). */
  reviewsBeforePost?: any[];
  checkRuns: { name: string; status: string; conclusion: string | null }[];
  mergeable: string;
  threads: any[];
  threadPageSize: number;
  /** Comments returned per thread page (GitHub: up to 100). */
  commentPageSize: number;
  /** `GET compare/{base}...{head}` answer (promotion). */
  compare: { total_commits: number; commits: { sha: string; commit: { message: string } }[] };
  /** Open/closed PRs listed by `GET /pulls`; `POST /pulls` adds one and makes it `pr`. */
  pulls: any[];
}

export function defaultState(): FakeState {
  return {
    repo: REPO,
    app: { id: 123456, slug: SLUG },
    installation: { id: 7890123, account: { login: "acme" }, repository_selection: "selected" },
    installedRepos: ["widgets"],
    permissions: { pull_requests: "write", contents: "write", checks: "read", statuses: "read", metadata: "read" },
    tokenExpiresAt: "2099-01-01T00:00:00Z",
    minted: 0,
    rejectJwt: false,
    rejectTokens: 0,
    rateLimit: { limit: 5000, remaining: 4987, reset: Date.parse("2026-11-17T18:04:00Z") / 1000 },
    pr: {
      number: 231,
      state: "open",
      draft: false,
      merged: false,
      merged_at: null,
      title: "WID-18120: export CSV",
      body: "...",
      user: { login: "octocat" },
      changed_files: 1,
      head: { sha: HEAD, ref: "WID-18120-export-csv" },
      base: { ref: "staging", repo: { default_branch: "main" } },
    },
    files: [{ filename: "apps/reports/src/export.ts", status: "modified", additions: 42, deletions: 3, patch: EXPORT_PATCH }],
    reviews: [],
    checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }],
    mergeable: "MERGEABLE",
    threads: [],
    threadPageSize: 100,
    commentPageSize: 100,
    compare: {
      total_commits: 3,
      commits: [
        { sha: "a1", commit: { message: "WID-18120: export CSV (#231)" } },
        { sha: "a2", commit: { message: "Merge pull request #233 from acme/WID-18121\n\nfix" } },
        { sha: PROMO_HEAD, commit: { message: "WID-18122: totals (#236)" } },
      ],
    },
    pulls: [],
  };
}

/** The `_dx.md` submit_review input. */
export function dxInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: REPO,
    number: 231,
    head_sha: HEAD,
    summary: "Export path reviewed end to end; one blocking issue in CSV escaping.",
    findings: [
      { path: "apps/reports/src/export.ts", line: 41, severity: "major", title: "Unescaped delimiter", body: "Values containing `;` break the row; quote fields per RFC 4180." },
      { path: "apps/reports/README.md", line: 3, severity: "nit", title: "Typo", body: "\"exprot\" → \"export\"." },
    ],
    ...overrides,
  };
}

/** A review by `login` on `commit`, as GitHub REST lists it. */
export function review(login: string, state: string, commit: string, body = "", id = 1, submitted = "2026-11-18T13:00:00Z"): any {
  return { id, user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" }, state, commit_id: commit, body, submitted_at: submitted };
}

/** A GraphQL review-thread node (Bot logins without `[bot]`, as GraphQL returns them). */
export function threadNode(id: string, resolved: boolean, comments: { login: string; bot?: boolean; body: string; at: string }[], commit = HEAD): any {
  return {
    id,
    isResolved: resolved,
    path: "apps/reports/src/export.ts",
    line: 41,
    comments: { nodes: comments.map(c => ({ author: { __typename: c.bot ? "Bot" : "User", login: c.login }, body: c.body, createdAt: c.at, originalCommit: { oid: commit } })) },
  };
}

/** A PR from `head` into `base` as GitHub REST lists it. */
export function pull(number: number, login: string, head = "staging", base = "main", sha = PROMO_HEAD): any {
  return {
    number,
    state: "open",
    draft: false,
    merged: false,
    merged_at: null,
    title: `Promote ${head} to ${base}`,
    body: "",
    user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
    html_url: `https://github.com/${REPO}/pull/${number}`,
    head: { sha, ref: head },
    base: { ref: base, repo: { default_branch: "main" } },
  };
}
