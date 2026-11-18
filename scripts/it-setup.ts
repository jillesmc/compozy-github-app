/**
 * IT setup against the ISOLATED CompozyOS home (scripts/it-env.sh); never touches the operator's home.
 * 1. Copies the newest dist/gen-* generation to $IT_PKG and adds `[subprocess] env.GITHUB_APP_API_URL`
 *    pointing at the fake GitHub (test-only manifest; the shipped package defaults to api.github.com).
 * 2. Installs that copy (--replace) and binds the six variables, with a throwaway RSA key made here.
 * Usage: bun run build && scripts/it-env.sh extension build . && bun scripts/it-setup.ts [fake-url]
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const url = process.argv[2] ?? "http://127.0.0.1:8790";
const pkg = process.env.IT_PKG ?? "/tmp/ghar-it/pkg";
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
writeFileSync(manifest, readFileSync(manifest, "utf8").replace("[subprocess]\n", `[subprocess]\n  env = { GITHUB_APP_API_URL = "${url}" }\n`));
run(["extension", "install", pkg, "--replace", "--allow-unverified", "--yes"]);
process.stdout.write(`installed ${generation} as ${pkg} (GITHUB_APP_API_URL=${url})\n`);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const values: Record<string, string> = {
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  GITHUB_APP_ID: "123456",
  GITHUB_APP_INSTALLATION_ID: "7890123",
  GITHUB_APP_REPOS: "acme/widgets",
  GITHUB_APP_BASE: "staging",
  GITHUB_APP_PROMOTION: "acme/widgets:staging->main",
  GITHUB_APP_PROMOTION_APPROVERS: "octocat",
};
for (const [key, value] of Object.entries(values)) {
  run(["extension", "secrets", "set", "github-app-review", "--env", key, "--value-stdin"], value);
  process.stdout.write(`bound ${key}\n`);
}
// Restart the subprocess so it starts with the bound environment.
run(["extension", "disable", "github-app-review"]);
run(["extension", "enable", "github-app-review"]);
