// In-sandbox forwarder (ADR-002). Runs as the sandbox's first process, then execs the agent command.
// Relays 127.0.0.1:3128 (HTTPS_PROXY) and every port the gateway announces (the session MCP bridge
// port) to the gateway unix socket, byte for byte. It decides nothing: the gateway enforces the allowlist.
// Usage: node forwarder.ts <gateway.sock> -- <command> [args...]
import net from "node:net";
import readline from "node:readline";
import { spawn } from "node:child_process";

const WATCH_LINE = "WATCH * REVIEWER/1";
const PROXY_PORT = 3128;

const sep = process.argv.indexOf("--");
const sockPath = process.argv[2] ?? "";
const [bin = "", ...binArgs] = process.argv.slice(sep + 1);
if (sep < 0 || !sockPath || !bin) {
  process.stderr.write("usage: forwarder.ts <gateway.sock> -- <command> [args...]\n");
  process.exit(2);
}

function die(msg: string): never {
  process.stderr.write(`reviewer-forwarder: ${msg}\n`);
  process.exit(1);
}

function relay(port: number): Promise<void> {
  const server = net.createServer((client) => {
    const gw = net.connect(sockPath);
    client.pipe(gw);
    gw.pipe(client);
    client.on("error", () => gw.destroy());
    gw.on("error", () => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

await relay(PROXY_PORT).catch((e) => die(`cannot listen on ${PROXY_PORT}: ${e.message}`));

const control = net.connect(sockPath);
control.on("error", (e) => die(`gateway control: ${e.message}`));
control.write(`${WATCH_LINE}\r\n\r\n`);
readline.createInterface({ input: control }).on("line", (line) => {
  const m = /^allow (\d+)$/.exec(line.trim());
  if (!m) return;
  const port = Number(m[1]);
  relay(port).then(
    () => control.write(`listening ${port}\n`),
    (e) => control.write(`error ${port} ${e.code ?? e.message}\n`),
  );
});

const child = spawn(bin, binArgs, { stdio: "inherit" });
child.on("error", (e) => die(`cannot start ${bin}: ${e.message}`));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
// Fail closed: without the gateway there is no egress and no new port, so stop the agent.
control.on("close", () => {
  child.kill("SIGTERM");
  die("gateway control channel closed");
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
