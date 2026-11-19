/**
 * IT setup against the ISOLATED CompozyOS home (scripts/it-env.sh); never touches the operator's home.
 * 1. Copies the newest dist/gen-* generation to $IT_PKG and adds `[subprocess] env` with
 *    GITHUB_APP_API_URL (the fake GitHub; the shipped package defaults to api.github.com) and
 *    GITHUB_APP_POLICY_FILE ($IT_POLICY_DIR/policy.toml, never the operator's ~/.config).
 * 2. Installs that copy (--replace) and binds the three credentials, with a throwaway RSA key made here.
 * 3. Writes the two-repo policy working copy; nothing is staged or approved (scripts/it.ts does that).
 * Usage: bun run build && scripts/it-env.sh extension build . && bun scripts/it-setup.ts [fake-url]
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

const url = process.argv[2] ?? "http://127.0.0.1:8790";
const pkg = process.env.IT_PKG ?? "/tmp/ghar-it/pkg";
const policyDir = process.env.IT_POLICY_DIR ?? "/tmp/ghar-it/policy";
if (!policyDir.startsWith("/tmp/")) throw new Error("IT_POLICY_DIR must be under /tmp (never the operator's policy)");
const env = new URL("./it-env.sh", import.meta.url).pathname;
const run = (args: string[], input?: string) => {
  const out = spawnSync(env, args, { encoding: "utf8", ...(input === undefined ? {} : { input }) });
  if (out.status !== 0) throw new Error(`${args.join(" ")}: exit ${out.status}\n${out.stderr}`);
  return out.stdout;
};

const generation = readdirSync("dist")
  .filter(name => name.startsWith("gen-"))
  .map(name => `dist/${name}`)
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!generation) throw new Error("no dist/gen-* generation; run compozy extension build first");
cpSync(generation, pkg, { recursive: true });
const manifest = `${pkg}/extension.toml`;
writeFileSync(manifest, readFileSync(manifest, "utf8").replace("[subprocess]\n", `[subprocess]\n  env = { GITHUB_APP_API_URL = "${url}", GITHUB_APP_POLICY_FILE = "${policyDir}/policy.toml" }\n`));
run(["extension", "install", pkg, "--replace", "--allow-unverified", "--yes"]);
process.stdout.write(`installed ${generation} as ${pkg} (GITHUB_APP_API_URL=${url}, policy ${policyDir})\n`);

rmSync(policyDir, { recursive: true, force: true });
mkdirSync(policyDir, { recursive: true });
writeFileSync(`${policyDir}/policy.toml`, `[repos."acme/widgets"]
delivery_base = "staging"
promotion = { head = "staging", base = "main" }
approvers = ["octocat"]

[repos."acme/gadgets"]
delivery_base = "develop"
promotion = { head = "develop", base = "release" }
approvers = ["hubot"]
`);
process.stdout.write(`wrote ${policyDir}/policy.toml (not staged)\n`);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const values: Record<string, string> = {
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  GITHUB_APP_ID: "123456",
  GITHUB_APP_INSTALLATION_ID: "7890123",
};
// A digest left over from an earlier run would approve nothing new, but start from "unset".
spawnSync(env, ["extension", "secrets", "unset", "github-app-review", "--env", "GITHUB_APP_POLICY_DIGEST"], { encoding: "utf8" });
for (const [key, value] of Object.entries(values)) {
  run(["extension", "secrets", "set", "github-app-review", "--env", key, "--value-stdin"], value);
  process.stdout.write(`bound ${key}\n`);
}
// Restart the subprocess so it starts with the bound environment.
run(["extension", "disable", "github-app-review"]);
run(["extension", "enable", "github-app-review"]);
