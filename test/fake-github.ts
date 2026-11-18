/**
 * Fake GitHub REST/GraphQL over plain http on loopback: the only fake in the test suite (GitHub HTTP
 * boundary). Point the extension at it with GITHUB_APP_API_URL=http://127.0.0.1:<port>.
 *
 * In-process (tests):
 *   const gh = await startFakeGitHub();      // gh.url, gh.state (mutable), gh.requests
 *   gh.respond = req => ({ status: 503 })     // override one or all answers
 *
 * Standalone (IT through a CompozyOS daemon; Node 22+ or Bun):
 *   bun test/fake-github.ts --port 8790
 *   curl -X POST http://127.0.0.1:8790/_fake/state -d '{"pr":{"draft":true}}'   # shallow-merge state
 *   curl -X POST http://127.0.0.1:8790/_fake/reset                               # default fixture
 *   curl http://127.0.0.1:8790/_fake/requests                                    # [{method,path,body}]
 *
 * App endpoints need a `Bearer <jwt>`; repository endpoints need a `Bearer ghs_...` token.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

import { defaultState, pull, type FakeState } from "./fixtures.ts";

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}
export interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
export interface FakeGitHub {
  url: string;
  state: FakeState;
  requests: FakeRequest[];
  respond?: (request: FakeRequest) => FakeResponse | undefined;
  close(): Promise<void>;
}

const page = <T>(items: T[], query: URLSearchParams): T[] => {
  const size = Number(query.get("per_page") ?? 30);
  const index = Number(query.get("page") ?? 1);
  return items.slice((index - 1) * size, index * size);
};

function answer(fake: FakeGitHub, req: FakeRequest, query: URLSearchParams): FakeResponse {
  const s = fake.state;
  const auth = String(req.headers.authorization ?? "");
  if (req.path.startsWith("/app")) {
    if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth)) return { status: 401, body: { message: "A JSON web token could not be decoded" } };
    if (s.rejectJwt) return { status: 401, body: { message: "Bad credentials" } };
    if (req.path === "/app") return { status: 200, body: s.app };
    if (req.path === `/app/installations/${s.installation.id}`) return { status: 200, body: s.installation };
    if (req.path === `/app/installations/${s.installation.id}/access_tokens` && req.method === "POST") {
      const name = req.body?.repositories?.[0];
      if (!s.installedRepos.includes(name)) return { status: 422, body: { message: "There is at least one repository that does not exist or is not accessible to the parent installation." } };
      s.minted++;
      return { status: 201, body: { token: `ghs_fake${s.minted}`, expires_at: s.tokenExpiresAt, permissions: s.permissions } };
    }
    return { status: 404, body: { message: "Not Found" } };
  }
  if (!auth.startsWith("Bearer ghs_")) return { status: 401, body: { message: "Bad credentials" } };
  if (s.rejectTokens > 0) {
    s.rejectTokens--;
    return { status: 401, body: { message: "Bad credentials" } };
  }
  if (req.path === "/rate_limit") return { status: 200, body: { resources: { core: s.rateLimit } } };
  if (req.path === "/graphql") {
    // Comments are paged per thread like GitHub: `comments(first:N)` then `node(id){comments(after)}`.
    const comments = (thread: any, after: number) => {
      const all: any[] = thread.comments?.nodes ?? [];
      const more = after + s.commentPageSize < all.length;
      return { pageInfo: { hasNextPage: more, endCursor: more ? String(after + s.commentPageSize) : null }, nodes: all.slice(after, after + s.commentPageSize) };
    };
    if (req.body?.variables?.id) {
      const thread = s.threads.find(t => t.id === req.body.variables.id);
      return { status: 200, body: { data: { node: thread ? { comments: comments(thread, Number(req.body.variables.cursor ?? 0)) } : null } } };
    }
    const nodes = s.threads.map(thread => ({ ...thread, comments: comments(thread, 0) }));
    const after = req.body?.variables?.cursor ? Number(req.body.variables.cursor) : 0;
    const slice = nodes.slice(after, after + s.threadPageSize);
    const more = after + s.threadPageSize < nodes.length;
    const pullRequest = {
      mergeable: s.mergeable,
      reviewThreads: { pageInfo: { hasNextPage: more, endCursor: more ? String(after + s.threadPageSize) : null }, nodes: slice },
    };
    return { status: 200, body: { data: { repository: { pullRequest } } } };
  }
  const contents = `/repos/${s.repo}/contents/`;
  if (req.path.startsWith(contents) && req.method === "GET") {
    // Only the base branch holds the conventions: any other ref (e.g. the PR head) answers 404.
    const text = query.get("ref") === s.pr.base.ref ? s.contents[req.path.slice(contents.length)] : undefined;
    if (text === undefined) return { status: 404, body: { message: "Not Found" } };
    return { status: 200, body: { type: "file", encoding: "base64", size: text.length, content: Buffer.from(text).toString("base64") } };
  }
  const pulls = `/repos/${s.repo}/pulls`;
  if (req.path.startsWith(`/repos/${s.repo}/compare/`)) return { status: 200, body: { ...s.compare, commits: page(s.compare.commits, query) } };
  if (req.path === pulls && req.method === "GET") {
    const head = query.get("head")?.split(":")[1];
    const listed = s.pulls.filter(p => p.state === (query.get("state") ?? "open") && (!head || p.head.ref === head) && (!query.get("base") || p.base.ref === query.get("base")));
    return { status: 200, body: page(listed, query) };
  }
  if (req.path === pulls && req.method === "POST") {
    // The created PR becomes the fixture's `pr`, so merge_gate can read it (IT-005).
    const created = { ...pull(240, `${s.app.slug}[bot]`, req.body.head, req.body.base, s.compare.commits.at(-1)?.sha), title: req.body.title, body: req.body.body };
    s.pulls.push(created);
    s.pr = created;
    return { status: 201, body: created };
  }
  const existing = s.pulls.find(p => req.path === `${pulls}/${p.number}`);
  if (existing && req.method === "PATCH") {
    Object.assign(existing, req.body);
    return { status: 200, body: existing };
  }
  const base = `${pulls}/${s.pr.number}`;
  if (req.path === base && req.method === "GET") return { status: 200, body: s.pr };
  if (req.path === `${base}/files`) return { status: 200, body: page(s.files, query) };
  if (req.path === `${base}/reviews` && req.method === "GET") {
    const reviews = s.reviewsBeforePost ?? s.reviews;
    s.reviewsBeforePost = undefined;
    return { status: 200, body: page(reviews, query) };
  }
  if (req.path === `${base}/reviews` && req.method === "POST") {
    const id = 2849190057 + s.reviews.length;
    const review = { id, user: { login: `${s.app.slug}[bot]`, type: "Bot" }, state: req.body.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED", commit_id: req.body.commit_id, body: req.body.body, submitted_at: new Date().toISOString() };
    s.reviews.push(review);
    return { status: 200, body: { ...review, html_url: `https://github.com/${s.repo}/pull/${s.pr.number}#pullrequestreview-${id}` } };
  }
  if (req.path === `/repos/${s.repo}/commits/${s.pr.head.sha}/check-runs`) {
    return { status: 200, body: { total_count: s.checkRuns.length, check_runs: page(s.checkRuns, query) } };
  }
  return { status: 404, body: { message: "Not Found" } };
}

export async function startFakeGitHub(options: { port?: number } = {}): Promise<FakeGitHub> {
  const fake: FakeGitHub = { url: "", state: defaultState(), requests: [], close: async () => {} };
  const server = createServer(async (incoming, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(incoming.url ?? "/", "http://fake");
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    let out: FakeResponse;
    if (url.pathname === "/_fake/state" && incoming.method === "POST") {
      Object.assign(fake.state, body ?? {});
      out = { status: 200, body: { ok: true } };
    } else if (url.pathname === "/_fake/reset") {
      fake.state = defaultState();
      fake.requests = [];
      out = { status: 200, body: { ok: true } };
    } else if (url.pathname === "/_fake/requests") {
      out = { status: 200, body: fake.requests.map(({ method, path, body }) => ({ method, path, body })) };
    } else {
      const request: FakeRequest = { method: incoming.method ?? "GET", path: url.pathname, headers: incoming.headers, body };
      fake.requests.push(request);
      out = fake.respond?.(request) ?? answer(fake, request, url.searchParams);
    }
    res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
    res.end(out.body === undefined ? "" : JSON.stringify(out.body));
  });
  await new Promise<void>(resolve => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise(resolve => server.close(() => resolve()));
  return fake;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  const index = process.argv.indexOf("--port");
  const fake = await startFakeGitHub({ port: index > 0 ? Number(process.argv[index + 1]) : 8790 });
  process.stdout.write(`fake GitHub on ${fake.url}\n`);
}
