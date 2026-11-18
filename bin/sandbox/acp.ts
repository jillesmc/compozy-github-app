// ACP channel guard (R-9, R-17). The ACP stdio is the sandbox's second channel to the host: CompozyOS, the
// ACP client, serves fs/* and terminal/* requests on the host. The wrapper therefore owns both directions:
//   - client -> agent: request ids are remembered; `initialize` loses the fs and terminal client
//     capabilities (the one deliberate content rewrite);
//   - agent -> client: only allowlisted methods and responses to remembered request ids pass. Non-JSON
//     lines are dropped; anything else (fs/*, terminal/*, unknown methods, unsolicited responses) is fatal.
// R-17: CompozyOS decodes with Go encoding/json, which matches keys case-insensitively (last match wins).
// So a line must not mean one thing here and another there: top-level keys must be exactly the JSON-RPC
// set (case-sensitive), no object at any depth may hold two keys that are equal under case folding, and
// what is forwarded, in both directions, is the re-encoding of what was checked, never the raw line.
// No I/O; unit-tested in test/sandbox/acp.test.ts.
import { StringDecoder } from "node:string_decoder";

// Agent -> client requests the reviewer needs.
export const AGENT_REQUESTS: ReadonlySet<string> = new Set([
  "session/request_permission", // tool permission prompts (answered by CompozyOS from the agent's permissions)
]);

// Agent -> client notifications (data only, no host action).
export const AGENT_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "session/update", // streamed message chunks, tool calls, plans, available commands
  "_claude/sdkMessage", // raw SDK task messages; CompozyOS opts in via _meta.claudeCode.emitRawSDKMessages
  "auth/status_update", // login state, sent by claude-agent-acp 0.108.0 right after session/new
  "_auth/status_update", // same, extension spelling, also sent by 0.108.0
]);

export type AgentVerdict =
  | { kind: "forward"; line: string }
  | { kind: "drop"; reason: string }
  | { kind: "fatal"; reason: string };

const RPC_KEYS = ["jsonrpc", "id", "method", "params", "result", "error"] as const;
type Msg = { [K in (typeof RPC_KEYS)[number]]?: unknown };

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Case folding close to Go's encoding/json key matching (simple Unicode folding, incl. U+017F and U+212A).
const fold = (key: string) => key.toUpperCase().toLowerCase();

// Deeper JSON is refused (R-20): JSON.stringify recurses and would throw on it.
export const MAX_DEPTH = 512;

// Returns why the raw text is unacceptable, or null: a key that repeats (under case folding) inside one
// object at any depth, or nesting deeper than MAX_DEPTH. Works on the raw text because JSON.parse already
// collapsed exact duplicates. Iterative, expects valid JSON.
export function structureProblem(text: string): string | null {
  const stack: (Set<string> | null)[] = []; // a Set per open object, null per open array
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const raw = text.slice(i, j + 1);
      i = j;
      const top = stack[stack.length - 1];
      if (!top) continue;
      let k = j + 1;
      while (k < text.length && " \t\r\n".includes(text[k] ?? "")) k++;
      if (text[k] !== ":") continue; // a value, not a key
      const key = fold(JSON.parse(raw) as string);
      if (top.has(key)) return `duplicate key under case folding ${JSON.stringify(key)}`;
      top.add(key);
    } else if (c === "{" || c === "[") {
      stack.push(c === "{" ? new Set() : null);
      if (stack.length > MAX_DEPTH) return `nesting deeper than ${MAX_DEPTH}`;
    }
    else if (c === "}" || c === "]") stack.pop();
  }
  return null;
}

// Canonical re-encoding: only the JSON-RPC keys, fixed order.
function encode(msg: Msg): string {
  const out: Record<string, unknown> = {};
  for (const k of RPC_KEYS) if (k in msg) out[k] = msg[k];
  return JSON.stringify(out);
}

const idKey = (id: unknown) => JSON.stringify(id);

export class AcpGuard {
  private pending = new Set<string>();
  private extra: ReadonlySet<string>;

  // `extraAgentMethods`: an adapter's additional agent->client method names (ADR-004). They may never be
  // fs/* or terminal/*: those stay fatal whatever the adapter says.
  constructor(extraAgentMethods: readonly string[] = []) {
    for (const m of extraAgentMethods) {
      if (!/^[A-Za-z_][\w./-]*$/.test(m) || m.startsWith("fs/") || m.startsWith("terminal/")) {
        throw new Error(`agent method ${JSON.stringify(m)} cannot be allowlisted`);
      }
    }
    this.extra = new Set(extraAgentMethods);
  }

  // Client -> agent (CompozyOS, trusted). Returns the line to forward: the re-encoding of the parsed
  // message with every key kept, plus the initialize capability rewrite. Non-JSON lines pass unchanged.
  clientLine(line: string): string {
    const msg = parseObject(line);
    if (!msg) return line;
    if (typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) this.pending.add(idKey(msg.id));
    if (msg.method === "initialize" && msg.params && typeof msg.params === "object") {
      const params = msg.params as { clientCapabilities?: unknown };
      const caps = params.clientCapabilities && typeof params.clientCapabilities === "object" ? params.clientCapabilities : {};
      params.clientCapabilities = { ...caps, fs: { readTextFile: false, writeTextFile: false }, terminal: false };
    }
    return JSON.stringify(msg);
  }

  // Agent -> client. Never throws: any internal error is fatal (R-20).
  agentLine(line: string): AgentVerdict {
    try {
      return this.checkAgentLine(line);
    } catch (e) {
      return { kind: "fatal", reason: `guard error: ${(e as Error).message}` };
    }
  }

  private checkAgentLine(line: string): AgentVerdict {
    if (line.trim() === "") return { kind: "drop", reason: "empty line" };
    const parsed = parseObject(line);
    if (!parsed || parsed.jsonrpc !== "2.0") return { kind: "drop", reason: "not a JSON-RPC 2.0 object" };
    const extra = Object.keys(parsed).filter((k) => !(RPC_KEYS as readonly string[]).includes(k));
    if (extra.length) return { kind: "fatal", reason: `unexpected top-level key ${JSON.stringify(extra[0])}` };
    const problem = structureProblem(line);
    if (problem !== null) return { kind: "fatal", reason: problem };
    const msg = parsed as Msg;
    if (msg.method !== undefined) {
      const m = msg.method;
      if (typeof m !== "string") return { kind: "fatal", reason: "non-string method" };
      if (m.startsWith("fs/") || m.startsWith("terminal/")) return { kind: "fatal", reason: `agent requested ${m}` };
      if ("result" in msg || "error" in msg) return { kind: "fatal", reason: `message mixes method ${m} and a response` };
      const isRequest = msg.id !== undefined;
      if ((isRequest ? AGENT_REQUESTS.has(m) : AGENT_NOTIFICATIONS.has(m)) || this.extra.has(m)) return { kind: "forward", line: encode(msg) };
      return { kind: "fatal", reason: `${isRequest ? "request" : "notification"} ${m} is not allowlisted` };
    }
    const key = idKey(msg.id);
    if (msg.id === undefined || ("result" in msg) === ("error" in msg) || "params" in msg || !this.pending.has(key)) {
      return { kind: "fatal", reason: `unsolicited or malformed response id=${String(key)}` };
    }
    this.pending.delete(key);
    return { kind: "forward", line: encode(msg) };
  }
}

// Splits a byte stream into lines; calls onLine for each complete line. Fails past maxLine bytes.

export function lineSplitter(onLine: (line: string) => void, onOverflow: () => void, maxLine = 64 * 1024 * 1024) {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  return (chunk: Buffer) => {
    buf += decoder.write(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
    if (buf.length > maxLine) {
      buf = "";
      onOverflow();
    }
  };
}
