import type { TokenProvider } from "./auth.ts";
import { reviewError } from "./errors.ts";
import { failure, send, type HttpDeps } from "./http.ts";
import type { Commentable } from "./rules.ts";

/** GitHub stops listing PR files here (US-001.EC-4). */
export const MAX_FILES = 3000;
const PAGE = 100;
/** Safety cap for exhaustive lists (reviews, check runs, threads, comments): 50 pages of 100. */
export const MAX_PAGES = 50;

export interface GitHubOptions extends HttpDeps {
  apiUrl: string;
  /** `owner/name`; tokens are minted for this repository. */
  repo: string;
  tokens: TokenProvider;
  now?: () => number;
}

export interface ThreadNode {
  id: string;
  is_resolved: boolean;
  path: string;
  line: number | null;
  /** Head the thread was opened on (its first comment's original commit). */
  commit_id: string | null;
  comments: { author: string; body: string; created_at: string }[];
}

export interface GitHub {
  /** Last HTTP status seen, for the log line. */
  lastStatus(): number;
  rest(method: string, path: string, body?: unknown): Promise<any>;
  /** Every page of a list endpoint (`key` selects the array of an object answer), up to `max` items. */
  paginate(path: string, max: number, key?: string): Promise<any[]>;
  /** Pages a list to exhaustion; `complete` is false when MAX_PAGES was hit (callers fail closed). */
  all(path: string, key?: string): Promise<{ items: any[]; complete: boolean }>;
  /** GraphQL `mergeable` and every review thread of a PR; `complete` is false when a paging cap was hit. */
  threads(number: number): Promise<{ mergeable: string; threads: ThreadNode[]; complete: boolean }>;
}

/** REST/GraphQL client for one repository. A 401 clears the cached token and retries once. */
export function createGitHub(options: GitHubOptions): GitHub {
  const now = options.now ?? Date.now;
  let status = 0;
  async function call(method: string, url: string, body?: unknown) {
    for (let attempt = 0; ; attempt++) {
      const token = await options.tokens.token(options.repo);
      const response = await send(url, { method, authorization: `Bearer ${token}`, body }, options);
      status = response.status;
      if (response.status === 401) {
        options.tokens.invalidate(options.repo);
        if (attempt === 0) continue;
        throw reviewError("credential_invalid", "GitHub rejected the installation token twice (401)", 401);
      }
      if (response.status === 404) throw reviewError("invalid_input", `not found on GitHub: ${new URL(url).pathname}`, 404);
      if (response.status >= 300) throw failure(response, now);
      return response;
    }
  }
  const rest = async (method: string, path: string, body?: unknown) => (await call(method, `${options.apiUrl}${path}`, body)).body;
  return {
    lastStatus: () => status,
    rest,
    async paginate(path, max, key) {
      const items: any[] = [];
      for (let page = 1; items.length < max; page++) {
        const separator = path.includes("?") ? "&" : "?";
        const answer = await rest("GET", `${path}${separator}per_page=${PAGE}&page=${page}`);
        const batch: any[] = (key ? answer?.[key] : answer) ?? [];
        items.push(...batch);
        if (batch.length < PAGE) break;
      }
      return items.slice(0, max);
    },
    async all(path, key) {
      const items: any[] = [];
      const separator = path.includes("?") ? "&" : "?";
      for (let page = 1; page <= MAX_PAGES; page++) {
        const answer = await rest("GET", `${path}${separator}per_page=${PAGE}&page=${page}`);
        const batch: any[] = (key ? answer?.[key] : answer) ?? [];
        items.push(...batch);
        if (batch.length < PAGE) return { items, complete: true };
      }
      return { items, complete: false };
    },
    async threads(number) {
      const [owner, name] = options.repo.split("/");
      const threads: ThreadNode[] = [];
      let mergeable = "UNKNOWN";
      const graphql = async (query: string, variables: Record<string, unknown>): Promise<any> => {
        const answer = await rest("POST", "/graphql", { query, variables });
        if (answer?.errors?.length) throw reviewError("github_rejected", `GraphQL: ${String(answer.errors[0]?.message ?? "error").slice(0, 300)}`);
        return answer?.data;
      };
      let complete = true;
      let cursor: string | null = null;
      let pages = 0;
      do {
        if (++pages > MAX_PAGES) {
          complete = false;
          break;
        }
        const pr: any = (await graphql(THREADS_QUERY, { owner, name, number, cursor }))?.repository?.pullRequest;
        if (!pr) throw reviewError("invalid_input", `pull request #${number} not found`);
        mergeable = pr.mergeable ?? "UNKNOWN";
        for (const node of pr.reviewThreads.nodes ?? []) {
          const nodes: any[] = [...(node.comments?.nodes ?? [])];
          // Page the thread's comments to the end (a contest can be the 101st comment).
          let info = node.comments?.pageInfo;
          for (let commentPages = 1; info?.hasNextPage; commentPages++) {
            if (commentPages >= MAX_PAGES) {
              complete = false;
              break;
            }
            const more = (await graphql(COMMENTS_QUERY, { id: node.id, cursor: info.endCursor }))?.node?.comments;
            nodes.push(...(more?.nodes ?? []));
            info = more?.pageInfo;
          }
          threads.push({
            id: node.id,
            is_resolved: !!node.isResolved,
            path: node.path,
            line: node.line ?? null,
            commit_id: nodes[0]?.originalCommit?.oid ?? null,
            comments: nodes.map((comment: any) => ({
              author: actorLogin(comment.author),
              body: String(comment.body ?? ""),
              created_at: comment.createdAt,
            })),
          });
        }
        cursor = pr.reviewThreads.pageInfo?.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
      } while (cursor);
      return { mergeable, threads, complete };
    },
  };
}

const COMMENT_FIELDS = "author{__typename login}body createdAt originalCommit{oid}";
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeable reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id isResolved path line comments(first:100){pageInfo{hasNextPage endCursor}nodes{${COMMENT_FIELDS}}}}}}}}`;
const COMMENTS_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{${COMMENT_FIELDS}}}}}}`;

/** GraphQL names a Bot `slug`; REST names it `slug[bot]`. Normalize to the REST form. */
function actorLogin(author: { __typename?: string; login?: string } | null): string {
  const login = author?.login ?? "ghost";
  return author?.__typename === "Bot" && !login.endsWith("[bot]") ? `${login}[bot]` : login;
}

/**
 * Commentable lines of a unified-diff patch: added and context lines on RIGHT (new numbering),
 * removed and context lines on LEFT (old numbering). No patch (binary, too large) → nothing.
 */
export function commentableLines(path: string, patch: string | undefined): Commentable[] {
  const right: number[] = [];
  const left: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of (patch ?? "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (text.startsWith("+")) right.push(newLine++);
    else if (text.startsWith("-")) left.push(oldLine++);
    else if (text.startsWith(" ")) {
      right.push(newLine++);
      left.push(oldLine++);
    }
  }
  const out: Commentable[] = [];
  if (right.length > 0) out.push({ path, side: "RIGHT", lines: right });
  if (left.length > 0) out.push({ path, side: "LEFT", lines: left });
  return out;
}
