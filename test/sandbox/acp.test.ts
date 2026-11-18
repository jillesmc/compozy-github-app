import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AcpGuard, MAX_DEPTH, lineSplitter, structureProblem } from "../../bin/sandbox/acp.ts";

const rpc = (o: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", ...o });

describe("R-9 agent -> client filter", () => {
  test("allowlisted notifications and request_permission pass", () => {
    const g = new AcpGuard();
    for (const method of ["session/update", "_claude/sdkMessage", "auth/status_update", "_auth/status_update"]) {
      assert.equal(g.agentLine(rpc({ method, params: {} })).kind, "forward", method);
    }
    assert.equal(g.agentLine(rpc({ id: 0, method: "session/request_permission", params: {} })).kind, "forward");
  });

  const fatal = [
    rpc({ id: 9, method: "terminal/create", params: { sessionId: "S", command: "id" } }),
    rpc({ id: 9, method: "terminal/output", params: {} }),
    rpc({ id: 9, method: "fs/read_text_file", params: { path: "/home/op/.ssh/id_ed25519" } }),
    rpc({ id: 9, method: "fs/write_text_file", params: { path: "/home/op/.compozy/config.toml", content: "" } }),
    rpc({ method: "terminal/kill", params: {} }),
    rpc({ id: 9, method: "elicitation/create", params: {} }),
    rpc({ id: 9, method: "session/update", params: {} }), // notification method sent as a request
    rpc({ method: "session/request_permission", params: {} }), // request method sent as a notification
    rpc({ method: "_unknown/ext", params: {} }),
    rpc({ id: 1, result: {} }), // response to nothing the client asked
    rpc({ method: 7 }),
  ];
  for (const line of fatal) {
    test(`fails closed on ${line.slice(0, 70)}`, () => assert.equal(new AcpGuard().agentLine(line).kind, "fatal"));
  }

  test("drops non-JSON and non-JSON-RPC lines", () => {
    const g = new AcpGuard();
    for (const line of ["", "hello", "[1,2]", '{"id":1}', "{broken"]) assert.equal(g.agentLine(line).kind, "drop", line);
  });

  test("responses pass only once, for ids the client asked", () => {
    const g = new AcpGuard();
    g.clientLine(rpc({ id: 1, method: "initialize", params: {} }));
    g.clientLine(rpc({ id: "s-2", method: "session/new", params: {} }));
    assert.equal(g.agentLine(rpc({ id: 1, result: {} })).kind, "forward");
    assert.equal(g.agentLine(rpc({ id: "s-2", error: { code: 1, message: "x" } })).kind, "forward");
    assert.equal(g.agentLine(rpc({ id: 1, result: {} })).kind, "fatal");
    g.clientLine(rpc({ id: 3, method: "session/prompt", params: {} }));
    assert.equal(g.agentLine(rpc({ id: 3, result: {}, error: {} })).kind, "fatal");
  });
});

describe("R-9 initialize rewrite (the one deliberate client -> agent rewrite)", () => {
  test("removes fs and terminal client capabilities, keeps the rest", () => {
    const g = new AcpGuard();
    const line = rpc({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, _meta: { x: 1 } } } });
    const out = JSON.parse(g.clientLine(line));
    assert.deepEqual(out.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { x: 1 } });
    assert.equal(out.params.protocolVersion, 1);
  });

  test("adds the denial when clientCapabilities is absent", () => {
    const out = JSON.parse(new AcpGuard().clientLine(rpc({ id: 1, method: "initialize", params: { protocolVersion: 1 } })));
    assert.deepEqual(out.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  });

  test("other client lines keep their content", () => {
    const g = new AcpGuard();
    for (const line of [rpc({ id: 2, method: "session/new", params: { cwd: "/x", mcpServers: [] } }), "not json", rpc({ id: 0, result: { outcome: {} } })]) {
      assert.equal(g.clientLine(line), line);
    }
  });
});

describe("line splitter", () => {
  test("joins chunks, splits lines, keeps multi-byte characters intact", () => {
    const lines: string[] = [];
    const push = lineSplitter((l) => lines.push(l), () => assert.fail("overflow"));
    const bytes = Buffer.from('{"a":"é"}\n{"b":2}\r\npartial', "utf8");
    push(bytes.subarray(0, 8)); // splits inside the 2-byte "é"
    push(bytes.subarray(8));
    assert.deepEqual(lines, ['{"a":"é"}', '{"b":2}']);
  });

  test("reports overflow past the limit", () => {
    let overflow = false;
    lineSplitter(() => {}, () => (overflow = true), 4)(Buffer.from("123456"));
    assert.equal(overflow, true);
  });
});

describe("R-17 parse differential with Go (case-insensitive keys)", () => {
  // Go encoding/json matches keys case-insensitively, last match wins; JSON.parse is case-sensitive.
  const variants: [string, () => [AcpGuard, string]][] = [
    ["allowed method with a later Method", () => [new AcpGuard(), '{"jsonrpc":"2.0","method":"session/update","Method":"fs/write_text_file","params":{"path":"/x"}}']],
    ["allowed request with a later METHOD", () => [new AcpGuard(), '{"jsonrpc":"2.0","id":7,"method":"session/request_permission","METHOD":"terminal/create","params":{"command":"id"}}']],
    ["solicited response with a Method key", () => {
      const g = new AcpGuard();
      g.clientLine(rpc({ id: 3, method: "session/prompt", params: {} }));
      return [g, '{"jsonrpc":"2.0","id":3,"result":{},"Method":"terminal/create"}'];
    }],
    ["nested SessionId/sessionId duplicate", () => [new AcpGuard(), '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"A","SessionId":"B","update":{}}}']],
    ["deeply nested duplicate", () => [new AcpGuard(), '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"content":[{"type":"text","Type":"x"}]}}}']],
    ["exact same-case duplicate", () => [new AcpGuard(), '{"jsonrpc":"2.0","method":"session/update","method":"terminal/create","params":{}}']],
    ["Unicode fold (long s) duplicate", () => [new AcpGuard(), '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"A","\u017fessionId":"B"}}']],
    ["escaped key spelling", () => [new AcpGuard(), '{"jsonrpc":"2.0","method":"session/update","\u004dethod":"terminal/create","params":{}}']],
    ["unknown top-level key", () => [new AcpGuard(), '{"jsonrpc":"2.0","method":"session/update","params":{},"extra":1}']],
  ];
  for (const [name, make] of variants) {
    test(`fails closed: ${name}`, () => {
      const [g, line] = make();
      assert.equal(g.agentLine(line).kind, "fatal");
    });
  }

  test("structureProblem ignores string values that look like keys and handles escapes", () => {
    assert.equal(structureProblem('{"a":"b","c":["a","A"],"d":{"x":"\\"","X2":1}}'), null);
    assert.equal(structureProblem('{"a":{"k":1},"b":{"k":2}}'), null); // same key in sibling objects is fine
    assert.match(structureProblem('{"a":1,"b":{"x":1},"A":2}') ?? "", /duplicate key under case folding "a"/);
  });

  test("normal messages pass with the same semantic content, re-encoded", () => {
    const g = new AcpGuard();
    g.clientLine(rpc({ id: 2, method: "session/new", params: {} }));
    const lines = [
      '{ "params": {"sessionId":"S","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hé \\u2028"}}}, "method":"session/update", "jsonrpc":"2.0" }',
      '{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"S","toolCall":{},"options":[]}}',
      '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"S","modes":{"currentModeId":"auto"}}}',
    ];
    for (const line of lines) {
      const v = g.agentLine(line);
      assert.equal(v.kind, "forward");
      if (v.kind !== "forward") continue;
      assert.deepEqual(JSON.parse(v.line), JSON.parse(line));
      assert.match(v.line, /^\{"jsonrpc":"2\.0"/); // canonical key order
    }
  });

  test("client lines are re-encoded too", () => {
    const g = new AcpGuard();
    const line = '{ "id": 2, "jsonrpc": "2.0", "method": "session/new", "params": {"cwd":"/x","mcpServers":[]} }';
    const out = g.clientLine(line);
    assert.notEqual(out, line);
    assert.deepEqual(JSON.parse(out), JSON.parse(line));
  });
});

describe("R-20 pathological nesting", () => {
  const deep = (n: number) => `{"jsonrpc":"2.0","method":"session/update","params":${'{"a":'.repeat(n)}1${"}".repeat(n)}}`;

  test("20 000 nested objects are fatal and no exception escapes", () => {
    const v = new AcpGuard().agentLine(deep(20_000));
    assert.equal(v.kind, "fatal");
    assert.match(v.kind === "fatal" ? v.reason : "", /nesting deeper than 512/);
  });

  test("nesting right at the cap still passes, one deeper is fatal", () => {
    // depth = 1 (envelope) + n (params chain)
    assert.equal(new AcpGuard().agentLine(deep(MAX_DEPTH - 1)).kind, "forward");
    assert.equal(new AcpGuard().agentLine(deep(MAX_DEPTH)).kind, "fatal");
  });

  test("deep arrays count too", () => {
    const line = `{"jsonrpc":"2.0","method":"session/update","params":{"a":${"[".repeat(20_000)}${"]".repeat(20_000)}}}`;
    assert.equal(new AcpGuard().agentLine(line).kind, "fatal");
  });
});

describe("ADR-004 adapter extraAgentMethods", () => {
  const extra = ["cursor/update_todos", "cursor/ask_question"];
  test("listed methods pass as requests and notifications; unlisted ones stay fatal", () => {
    const g = new AcpGuard(extra);
    assert.equal(g.agentLine(rpc({ id: 5, method: "cursor/update_todos", params: { todos: [] } })).kind, "forward");
    assert.equal(g.agentLine(rpc({ method: "cursor/ask_question", params: {} })).kind, "forward");
    assert.equal(g.agentLine(rpc({ id: 6, method: "cursor/task", params: {} })).kind, "fatal");
    assert.equal(new AcpGuard().agentLine(rpc({ id: 5, method: "cursor/update_todos", params: {} })).kind, "fatal");
  });
  test("fs/* and terminal/* stay fatal and cannot be allowlisted", () => {
    const g = new AcpGuard(extra);
    assert.equal(g.agentLine(rpc({ id: 9, method: "terminal/create", params: {} })).kind, "fatal");
    for (const bad of ["fs/read_text_file", "terminal/create", "", "bad method", "ſs/x"]) {
      assert.throws(() => new AcpGuard([bad]), /cannot be allowlisted/, bad);
    }
  });
  test("a listed method still goes through the structure checks and the re-encoding", () => {
    const g = new AcpGuard(extra);
    assert.equal(g.agentLine('{"jsonrpc":"2.0","method":"cursor/ask_question","Method":"terminal/create","params":{}}').kind, "fatal");
    const v = g.agentLine('{"jsonrpc":"2.0","params":{"a":1},"method":"cursor/ask_question"}');
    assert.deepEqual(v, { kind: "forward", line: '{"jsonrpc":"2.0","method":"cursor/ask_question","params":{"a":1}}' });
  });
});
