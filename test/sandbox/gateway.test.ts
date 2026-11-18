import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { decide, startGateway, WATCH_LINE } from "../../bin/sandbox/gateway.ts";

// The egress allowlist comes from the provider adapter (ADR-004); here the claude adapter's list.
const EGRESS: ReadonlySet<string> = new Set(["api.anthropic.com"]);

describe("decide", () => {
  const allowed = new Set([41234]);
  const head = (l: string, host?: string) => `${l}${host ? `\r\nHost: ${host}` : ""}`;

  const passes: [string, string | undefined, "connect" | "bridge"][] = [
    ["CONNECT api.anthropic.com:443 HTTP/1.1", undefined, "connect"],
    ["CONNECT API.ANTHROPIC.COM:443 HTTP/1.1", undefined, "connect"],
    ["POST /mcp HTTP/1.1", "127.0.0.1:41234", "bridge"],
    ["GET /mcp HTTP/1.1", "localhost:41234", "bridge"],
    ["POST http://127.0.0.1:41234/mcp HTTP/1.1", "127.0.0.1:41234", "bridge"],
  ];
  for (const [line, host, kind] of passes) {
    test(`passes ${line} (Host ${host})`, () => {
      const d = decide(head(line, host), allowed, EGRESS);
      assert.equal(d.ok && d.kind, kind);
    });
  }

  const refusals: [string, string | undefined][] = [
    ["CONNECT api.github.com:443 HTTP/1.1", undefined],
    ["CONNECT example.com:443 HTTP/1.1", undefined],
    ["CONNECT api.anthropic.com:80 HTTP/1.1", undefined],
    ["CONNECT 127.0.0.1:2123 HTTP/1.1", undefined],
    ["CONNECT 127.0.0.1:41234 HTTP/1.1", undefined],
    ["GET /api/workspaces HTTP/1.1", "127.0.0.1:2123"],
    ["GET http://127.0.0.1:2123/api/workspaces HTTP/1.1", "127.0.0.1:41234"],
    ["GET /mcp HTTP/1.1", "127.0.0.1:41235"],
    ["GET /mcp HTTP/1.1", "10.0.0.1:41234"],
    ["GET /mcp HTTP/1.1", "127.0.0.1"],
    ["GET /mcp HTTP/1.1", undefined],
    ["GET https://127.0.0.1:41234/mcp HTTP/1.1", undefined],
    ["GET http://api.anthropic.com/ HTTP/1.1", undefined],
    ["garbage", undefined],
  ];
  for (const [line, host] of refusals) {
    test(`refuses ${line} (Host ${host})`, () => {
      assert.equal(decide(head(line, host), allowed, EGRESS).ok, false);
    });
  }
});

// Live gateways on temp unix sockets; the test plays the in-sandbox forwarder's control channel.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function session(name: string) {
  const logs: string[] = [];
  const socketPath = path.join(tmp, `${name}.sock`);
  const gw = startGateway({ socketPath, log: (l) => logs.push(l), egressHosts: ["api.anthropic.com"], watchTimeoutMs: 1000 });
  await gw.ready;
  const bridge = http.createServer((_q, r) => r.end(`bridge-${name}`));
  await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", () => r()));
  const port = (bridge.address() as net.AddressInfo).port;
  const watcher = net.connect(socketPath);
  watcher.write(`${WATCH_LINE}\r\n\r\n`);
  watcher.on("data", (d) => {
    for (const m of d.toString().matchAll(/allow (\d+)/g)) watcher.write(`listening ${m[1]}\n`);
  });
  await gw.allow(port);
  return { gw, port, logs, socketPath, close: () => (watcher.destroy(), bridge.close(), gw.close()) };
}

function raw(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(socketPath, () => s.write(request));
    let out = "";
    s.on("data", (d) => (out += d));
    s.on("end", () => resolve(out));
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
    setTimeout(() => s.destroy(), 1500);
  });
}

describe("gateway sessions (IT-017 logic)", () => {
  test("each gateway passes only its own bridge port and logs refusals", async () => {
    const a = await session("A");
    const b = await session("B");
    try {
      const get = (p: number) => `GET / HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`;
      assert.match(await raw(a.socketPath, get(a.port)), /bridge-A/);
      assert.match(await raw(b.socketPath, get(b.port)), /bridge-B/);
      const cross = await raw(a.socketPath, get(b.port));
      assert.match(cross, /^HTTP\/1\.1 403/);
      assert.match(cross, /X-Reviewer-Gateway: refused/);
      assert.doesNotMatch(cross, /bridge-B/);
      assert.match(await raw(a.socketPath, "CONNECT api.github.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
      assert.match(await raw(a.socketPath, get(2123)), /^HTTP\/1\.1 403/);
      assert.ok(a.logs.includes(`allow-port ${a.port}`));
      assert.equal(a.logs.filter((l) => l.startsWith("allow-port")).length, 1);
      assert.ok(a.logs.some((l) => l.startsWith(`refuse GET 127.0.0.1:${b.port}`)));
      assert.ok(a.logs.some((l) => l.startsWith("refuse CONNECT api.github.com:443")));
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("the daemon port can never be allowed", async () => {
    const a = await session("C");
    try {
      await assert.rejects(a.gw.allow(2123));
      assert.equal(a.gw.allowed().has(2123), false);
    } finally {
      await a.close();
    }
  });

  test("allow fails closed when no forwarder confirms the port", async () => {
    const socketPath = path.join(tmp, "nowatch.sock");
    const gw = startGateway({ socketPath, log: () => {}, egressHosts: ["api.anthropic.com"], watchTimeoutMs: 200 });
    await gw.ready;
    await assert.rejects(gw.allow(40000), /did not confirm/);
    assert.equal(gw.allowed().size, 0);
    await gw.close();
  });
});
