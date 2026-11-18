import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { bwrapArgs, checkCwd, inspectClientLine, loginMountOf, sandboxEnv, IN, PROTECTED_ENV } from "../../bin/sandbox/profile.ts";

const CWD = "/home/op/.compozy/worktrees/ws/rev-231";
const sessionNew = (mcpServers: unknown, cwd: unknown = CWD) =>
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers } });

describe("ACP stdio tap", () => {
  test("session/new with the loopback bridge allows its port", () => {
    const line = sessionNew([{ type: "http", name: "compozy-hosted-tools", url: "http://127.0.0.1:41234/mcp", headers: [] }]);
    assert.deepEqual(inspectClientLine(line, CWD), { kind: "allow", ports: [41234] });
  });

  test("session/load and localhost are tapped the same way", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/load", params: { sessionId: "s", cwd: CWD, mcpServers: [{ type: "http", url: "http://localhost:5000/" }] } });
    assert.deepEqual(inspectClientLine(line, CWD), { kind: "allow", ports: [5000] });
  });

  test("messages without mcpServers and non-JSON lines pass unchanged", () => {
    assert.deepEqual(inspectClientLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), CWD), { kind: "pass" });
    assert.deepEqual(inspectClientLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "s", prompt: [] } }), CWD), { kind: "pass" });
    assert.deepEqual(inspectClientLine("not json", CWD), { kind: "pass" });
    assert.deepEqual(inspectClientLine(sessionNew([]), CWD), { kind: "pass" });
  });

  const rejected: [string, unknown][] = [
    ["remote https", [{ type: "http", url: "https://evil.example/mcp" }]],
    ["non-loopback http", [{ type: "http", url: "http://10.0.0.1:8080/" }]],
    ["implicit port", [{ type: "http", url: "http://127.0.0.1/mcp" }]],
    ["stdio server", [{ name: "x", command: "/usr/bin/compozy", args: [] }]],
    ["not a URL", [{ type: "http", url: "::" }]],
    ["mcpServers not an array", { a: 1 }],
  ];
  for (const [name, servers] of rejected) {
    test(`fails closed on ${name}`, () => {
      assert.equal(inspectClientLine(sessionNew(servers), CWD).kind, "reject");
    });
  }

  test("fails closed when cwd is not the bound session cwd", () => {
    assert.equal(inspectClientLine(sessionNew([], "/home/op"), CWD).kind, "reject");
    assert.equal(inspectClientLine(sessionNew([], `${CWD}/../other`), CWD).kind, "reject");
    assert.deepEqual(inspectClientLine(sessionNew([], `${CWD}/sub`), CWD), { kind: "pass" });
  });
});

describe("cwd guard (R-11)", () => {
  const home = "/home/op";
  const git = { hasGit: true };
  const refused = [
    "/", "/home", home, `${home}/.ssh`, `${home}/.config/gh`, `${home}/.compozy`, `${home}/.compozy/worktrees`,
    `${home}/.compozy/worktrees/ws`, `${home}/.claude`,
    "/run", "/run/user/1000", "/run/docker", "/var/run", "/var/run/docker", "/var", "/tmp", "/dev", "/dev/shm",
    "/proc", "/proc/1", "/sys", "/sys/fs",
  ];
  for (const cwd of refused) {
    test(`refuses ${cwd}`, () => assert.notEqual(checkCwd(cwd, home, git), null));
  }
  for (const cwd of [CWD, `${home}/data/projects/repo`, "/srv/checkout", "/tmp/review-231"]) {
    test(`accepts git checkout ${cwd}`, () => assert.equal(checkCwd(cwd, home, git), null));
  }
  test("refuses a cwd without .git", () => {
    assert.match(checkCwd(CWD, home, { hasGit: false }) ?? "", /not a git checkout/);
  });
  test("--worktree-root: cwd must be strictly inside one of the roots", () => {
    const roots = [`${home}/.compozy/worktrees`, "/srv/reviews"];
    assert.equal(checkCwd(CWD, home, { hasGit: true, roots }), null);
    assert.equal(checkCwd("/srv/reviews/pr-231", home, { hasGit: true, roots }), null);
    assert.match(checkCwd(`${home}/data/projects/repo`, home, { hasGit: true, roots }) ?? "", /--worktree-root/);
    assert.match(checkCwd("/srv/reviews", home, { hasGit: true, roots }) ?? "", /--worktree-root/);
    assert.match(checkCwd("/srv/reviews-evil/x", home, { hasGit: true, roots }) ?? "", /--worktree-root/);
  });
});

describe("environment allowlist", () => {
  test("operator variables never reach the sandbox", () => {
    const env = sandboxEnv({
      GH_TOKEN: "x", GH_TOKEN_ALT: "x", JIRA_API_TOKEN: "x", SPACELIFT_API_TOKEN: "x", SONARQUBE_CLI_TOKEN: "x",
      SSH_AUTH_SOCK: "/run/ssh", COMPOZY_TOKEN: "x", ANTHROPIC_API_KEY: "x", CLAUDE_CODE_OAUTH_TOKEN: "x",
      HOME: "/home/op", PATH: "/home/op/bin", LANG: "en_US.UTF-8",
    });
    assert.deepEqual(Object.keys(env).filter((k) => /^(GH_|JIRA_|SPACELIFT_|SONARQUBE_|COMPOZY_|SSH_|ANTHROPIC_)/.test(k) || k === "CLAUDE_CODE_OAUTH_TOKEN"), []);
    assert.equal(env.HOME, IN.home);
    assert.ok(!env.PATH?.includes("/home/op"));
    assert.equal(env.LANG, "en_US.UTF-8");
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:3128");
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined); // provider specifics come only from the adapter
  });

  test("adapter env is merged but cannot override egress, PATH or the trust store", () => {
    const env = sandboxEnv({}, { CLAUDE_CONFIG_DIR: IN.login, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    assert.equal(env.CLAUDE_CONFIG_DIR, IN.login);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    for (const k of PROTECTED_ENV) assert.throws(() => sandboxEnv({}, { [k]: "x" }), new RegExp(`may not set ${k}`));
  });
});

describe("bubblewrap profile", () => {
  const args = bwrapArgs(
    { cwd: CWD, loginCopy: "/tmp/rs/login", loginMount: IN.login, nodeBin: "/n/bin/node", acpPrefix: "/a/claude", sandboxDir: "/r/bin/sandbox", gatewayDir: "/tmp/rs/gw", etcDir: "/tmp/rs/etc", env: { HOME: IN.home } },
    ["/bin/true"],
  );
  const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [`${args[i + 1]} -> ${args[i + 2]}`] : []));

  test("no network namespace sharing, dies with parent, clean env", () => {
    assert.ok(args.includes("--unshare-all"));
    assert.ok(!args.includes("--share-net"));
    assert.ok(args.includes("--die-with-parent"));
    assert.ok(args.includes("--clearenv"));
  });

  test("worktree is read-only and the only writable host path is the dedicated claude config", () => {
    assert.ok(pairs("--ro-bind").includes(`${CWD} -> ${CWD}`));
    assert.deepEqual(pairs("--bind"), [`/tmp/rs/login -> ${IN.login}`]);
    assert.ok(pairs("--ro-bind").includes(`/a/claude -> ${IN.acpPrefix}`));
    assert.doesNotMatch(args.join(" "), /--(ro-)?bind \/home\/op /);
  });

  test("forwarder wraps the agent command", () => {
    const i = args.indexOf("--", args.indexOf("--setenv"));
    assert.deepEqual(args.slice(i + 1), [IN.node, "--disable-warning=ExperimentalWarning", `${IN.sandboxDir}/forwarder.ts`, IN.gatewaySock, "--", "/bin/true"]);
  });
});

describe("ADR-004 adapter loginMount (where the session login copy is bound inside)", () => {
  test("default is IN.login; an adapter may move it below the sandbox HOME", () => {
    assert.equal(loginMountOf({}), IN.login);
    assert.equal(loginMountOf({ loginMount: `${IN.home}/.config/cursor` }), `${IN.home}/.config/cursor`);
    const args = bwrapArgs(
      { cwd: CWD, loginCopy: "/tmp/rs/login", loginMount: `${IN.home}/.config/cursor`, nodeBin: "/n/bin/node", acpPrefix: "/a/cursor", sandboxDir: "/r/bin/sandbox", gatewayDir: "/tmp/rs/gw", etcDir: "/tmp/rs/etc", env: { HOME: IN.home } },
      ["/bin/true"],
    );
    const binds = args.flatMap((a, i) => (a === "--bind" ? [`${args[i + 1]} -> ${args[i + 2]}`] : []));
    assert.deepEqual(binds, [`/tmp/rs/login -> ${IN.home}/.config/cursor`]);
    assert.ok(args.indexOf("--bind") > args.indexOf(IN.home), "bound after the HOME tmpfs");
  });
  test("anything outside the sandbox HOME, relative or not normalized is refused", () => {
    for (const bad of [IN.home, `${IN.home}/`, "/opt/acp", "/run/reviewer", "/etc/x", "relative/cursor", `${IN.home}/../etc`, `${IN.home}/a/../b`, `${IN.home}/a/`]) {
      assert.throws(() => loginMountOf({ loginMount: bad }), /must be a normalized absolute path/, bad);
    }
  });
});
