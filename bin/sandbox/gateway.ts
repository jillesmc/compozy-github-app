// reviewer-gateway: the sandbox's only egress (ADR-002, ADR-004). Runs outside the sandbox, holds no secret.
// Listens on one unix socket that is bind-mounted into the sandbox and passes exactly:
//   - CONNECT <host>:443 for the selected provider adapter's egress hosts (--egress-host, repeatable)
//   - plain HTTP to 127.0.0.1:<port> for ports the wrapper allowed (the session's MCP bridge)
// Everything else gets 403 and a log line. Ports are allowed only through the gateway's stdin, which the
// wrapper owns; the sandbox cannot add ports.
//
// Socket protocol: each connection starts with an HTTP/1.x request head. The in-sandbox forwarder opens
// one extra control connection with the head "WATCH * REVIEWER/1"; the gateway sends "allow <port>\n" on
// it and waits for "listening <port>\n" before confirming the allow to the wrapper ("ok <port>").
import net from "node:net";
import fs from "node:fs";
import readline from "node:readline";

export const WATCH_LINE = "WATCH * REVIEWER/1";
const MAX_HEAD = 16 * 1024;
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost"]);

export type Decision =
  | { ok: true; kind: "connect"; host: string; port: number }
  | { ok: true; kind: "bridge"; host: "127.0.0.1"; port: number }
  | { ok: false; target: string; reason: string };

function splitHostPort(s: string): { host: string; port: number } | null {
  const m = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(s.trim());
  const [, host, portText] = m ?? [];
  if (!host || !portText) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: host.toLowerCase(), port };
}

// Pure allowlist decision over one request head (request line + headers, no body).
export function decide(head: string, allowedPorts: ReadonlySet<number>, egressHosts: ReadonlySet<string>): Decision {
  const lines = head.split("\r\n");
  const requestLine = lines[0] ?? "";
  const [method = "", target = "", version = ""] = requestLine.split(" ");
  if (!method || !target || !/^HTTP\/1\.[01]$/.test(version)) {
    return { ok: false, target: requestLine.slice(0, 120), reason: "malformed request" };
  }
  if (method === "CONNECT") {
    const hp = splitHostPort(target);
    if (hp && egressHosts.has(hp.host) && hp.port === 443) {
      return { ok: true, kind: "connect", host: hp.host, port: 443 };
    }
    return { ok: false, target: `CONNECT ${target}`, reason: "not allowlisted" };
  }
  let authority: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    if (!target.toLowerCase().startsWith("http://")) {
      return { ok: false, target: `${method} ${target}`, reason: "only plain http to the bridge" };
    }
    authority = target.slice(7).split(/[/?#]/, 1)[0];
  } else {
    const host = lines.slice(1).find((l) => /^host:/i.test(l));
    authority = host?.slice(5).trim();
  }
  const hp = authority ? splitHostPort(authority) : null;
  if (hp && LOOPBACK_NAMES.has(hp.host) && allowedPorts.has(hp.port)) {
    return { ok: true, kind: "bridge", host: "127.0.0.1", port: hp.port };
  }
  return {
    ok: false,
    target: `${method} ${authority ?? target}`.slice(0, 200),
    reason: "not allowlisted",
  };
}

export type GatewayOptions = {
  socketPath: string;
  log: (line: string) => void;
  egressHosts: readonly string[]; // CONNECT <host>:443 allowlist (the provider adapter's egressHosts)
  daemonPort?: number;
  watchTimeoutMs?: number;
};

export type Gateway = {
  allow(port: number): Promise<void>;
  allowed(): ReadonlySet<number>;
  close(): Promise<void>;
  ready: Promise<void>;
};

function refuse(sock: net.Socket, status: string, text: string) {
  const body = `reviewer-gateway: ${text}\n`;
  sock.resume(); // drain whatever follows so the peer's FIN is seen and the socket closes
  sock.end(
    `HTTP/1.1 ${status}\r\nX-Reviewer-Gateway: refused\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

export function startGateway(opts: GatewayOptions): Gateway {
  const egress = new Set(opts.egressHosts.map((h) => h.toLowerCase()));
  const daemonPort = opts.daemonPort ?? 2123;
  const watchTimeoutMs = opts.watchTimeoutMs ?? 10_000;
  const allowed = new Set<number>();
  const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  let watcher: net.Socket | null = null;
  const queued: number[] = [];

  function onWatcher(sock: net.Socket) {
    if (watcher) {
      opts.log("refuse WATCH (second watcher)");
      return refuse(sock, "403 Forbidden", "watcher already attached");
    }
    watcher = sock;
    readline.createInterface({ input: sock }).on("line", (line) => {
      const [verb, p] = line.trim().split(" ");
      const port = Number(p);
      const waiter = pending.get(port);
      if (!waiter) return;
      pending.delete(port);
      if (verb === "listening") {
        allowed.add(port);
        opts.log(`allow-port ${port}`);
        waiter.resolve();
      } else {
        waiter.reject(new Error(`forwarder could not listen on ${port}: ${line}`));
      }
    });
    sock.on("close", () => {
      for (const [port, w] of pending) w.reject(new Error(`forwarder gone before port ${port}`));
      pending.clear();
    });
    for (const port of queued.splice(0)) sock.write(`allow ${port}\n`);
  }

  function handle(sock: net.Socket) {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), 10_000);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > MAX_HEAD) {
          clearTimeout(timer);
          sock.off("data", onData);
          opts.log("refuse oversized request head");
          refuse(sock, "431 Request Header Fields Too Large", "request head too large");
        }
        return;
      }
      clearTimeout(timer);
      sock.off("data", onData);
      const head = buf.subarray(0, end).toString("latin1");
      if (head === WATCH_LINE) return onWatcher(sock);
      const d = decide(head, allowed, egress);
      if (!d.ok) {
        opts.log(`refuse ${d.target} (${d.reason})`);
        return refuse(sock, "403 Forbidden", `refused ${d.target}`);
      }
      const upstream = net.connect(d.port, d.kind === "connect" ? d.host : "127.0.0.1");
      upstream.on("connect", () => {
        opts.log(d.kind === "connect" ? `pass CONNECT ${d.host}:${d.port}` : `pass bridge 127.0.0.1:${d.port}`);
        if (d.kind === "connect") {
          sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(buf.subarray(end + 4));
        } else {
          upstream.write(buf);
        }
        sock.pipe(upstream);
        upstream.pipe(sock);
      });
      upstream.on("error", (e) => {
        if (!sock.writableEnded && upstream.bytesRead === 0 && upstream.bytesWritten === 0) {
          opts.log(`upstream error ${d.host}:${d.port} (${(e as NodeJS.ErrnoException).code ?? e.message})`);
          refuse(sock, "502 Bad Gateway", `upstream ${d.host}:${d.port} unreachable`);
        } else sock.destroy();
      });
      sock.on("error", () => upstream.destroy());
      sock.on("close", () => upstream.destroy());
    };
    sock.on("data", onData);
    sock.on("error", () => clearTimeout(timer));
  }

  try {
    fs.unlinkSync(opts.socketPath);
  } catch {}
  const conns = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    conns.add(sock);
    sock.on("close", () => conns.delete(sock));
    handle(sock);
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => resolve());
  });

  return {
    ready,
    allowed: () => allowed,
    allow(port: number) {
      if (!Number.isInteger(port) || port < 1 || port > 65535 || port === daemonPort) {
        opts.log(`refuse allow-port ${port} (invalid or daemon port)`);
        return Promise.reject(new Error(`port ${port} cannot be allowed`));
      }
      if (allowed.has(port)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          pending.delete(port);
          reject(new Error(`forwarder did not confirm port ${port} within ${watchTimeoutMs} ms`));
        }, watchTimeoutMs);
        pending.set(port, {
          resolve: () => (clearTimeout(t), resolve()),
          reject: (e) => (clearTimeout(t), reject(e)),
        });
        if (watcher) watcher.write(`allow ${port}\n`);
        else queued.push(port);
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of conns) c.destroy();
        server.close(() => resolve());
      }),
  };
}

// CLI: reviewer-gateway --socket PATH --egress-host HOST [--egress-host HOST]... [--log FILE] [--daemon-port 2123]
// stdin: "allow <port>" lines; stdout: "ready egress=<h1,h2>", "ok <port>", "fail <port> <reason>".
// Exits when stdin closes.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const socketPath = flag("--socket");
  const egressHosts = args.flatMap((a, i) => (a === "--egress-host" && args[i + 1] ? [args[i + 1]!] : []));
  if (!socketPath || egressHosts.length === 0) {
    process.stderr.write("usage: reviewer-gateway --socket PATH --egress-host HOST... [--log FILE] [--daemon-port N]\n");
    process.exit(2);
  }
  const logFile = flag("--log");
  const log = (line: string) => {
    const l = `${new Date().toISOString()} reviewer-gateway[${process.pid}] ${line}\n`;
    process.stderr.write(l);
    if (logFile) fs.appendFileSync(logFile, l);
  };
  const gw = startGateway({ socketPath, log, egressHosts, daemonPort: Number(flag("--daemon-port") ?? 2123) });
  const egress = [...new Set(egressHosts.map((h) => h.toLowerCase()))].sort().join(",");
  gw.ready.then(
    () => {
      log(`listening ${socketPath} egress=${egress}`);
      process.stdout.write(`ready egress=${egress}\n`);
    },
    (e) => {
      log(`cannot listen: ${e.message}`);
      process.exit(1);
    },
  );
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const m = /^allow (\d+)$/.exec(line.trim());
    if (!m) return void process.stdout.write(`fail 0 bad-command\n`);
    const port = Number(m[1]);
    gw.allow(port).then(
      () => process.stdout.write(`ok ${port}\n`),
      (e) => process.stdout.write(`fail ${port} ${e.message}\n`),
    );
  }).on("close", () => {
    log("stdin closed, exiting");
    gw.close().finally(() => process.exit(0));
  });
}
