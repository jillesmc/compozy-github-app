import { pathToFileURL } from "node:url";

import { Extension, type ExtensionOptions } from "@compozy/extension-sdk";

import { OPTIONAL_ENV, REQUIRED_ENV } from "./config.ts";
import { doctorHandler } from "./doctor.ts";
import { policyHandler } from "./policy-cmd.ts";
import { trustSystemCertificates } from "./system-ca.ts";
import { toolHandler, type ToolDeps, type ToolDefinition } from "./tools/common.ts";
import { mergeGateTool } from "./tools/merge_gate.ts";
import { prContextTool } from "./tools/pr_context.ts";
import { submitReviewTool } from "./tools/submit_review.ts";
import { upsertPromotionTool } from "./tools/upsert_promotion.ts";

export const EXTENSION_VERSION = "0.3.0";
/** The TS SDK describe payload carries a stale built-in floor; the spec requires CompozyOS ≥ 0.7.3. */
export const MIN_COMPOZY_VERSION = "0.7.3";

/** Agent tools; CompozyOS exposes them as ext__github_app_review__<name> (underscores). */
export const TOOLS: ToolDefinition[] = [prContextTool, submitReviewTool, mergeGateTool, upsertPromotionTool];

class GitHubAppReviewExtension extends Extension {
  public override describe(): ReturnType<Extension["describe"]> {
    const payload = super.describe();
    return { ...payload, sdk: { ...payload.sdk, min_compozy_version: MIN_COMPOZY_VERSION } };
  }
}

/** The only module that builds the SDK Extension and reads process.env. */
export function createExtension(options: ExtensionOptions = {}, deps: Partial<ToolDeps> = {}): Extension {
  const extension = new GitHubAppReviewExtension(
    {
      name: "github-app-review",
      version: EXTENSION_VERSION,
      description: "GitHub App pull request review: context, review submission, merge gate and promotion PR",
      subprocess: { command: "node", args: ["index.js"] },
      capabilities: { provides: [] },
      permissions: { requires: [] },
      requires_env: [...REQUIRED_ENV, ...OPTIONAL_ENV],
    },
    options
  );
  const toolDeps: ToolDeps = { ...deps, env: deps.env ?? process.env };
  for (const tool of TOOLS) {
    const { name, description, inputSchema, readOnly } = tool;
    extension.tool(name, { description, inputSchema, readOnly }, toolHandler(tool, toolDeps));
  }
  extension.tool(
    "doctor",
    {
      description:
        "Operator command (compozy extension exec github-app-review --cmd doctor). Agents should not call this tool: " +
        "it reports app identity, installation, token mint, the approved policy and its repositories, and rate limit.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      readOnly: true,
      command: { verb: "doctor", summary: "Check the GitHub App credentials, installation and approved policy repositories" },
    },
    doctorHandler(toolDeps)
  );
  const empty = { type: "object", additionalProperties: false, properties: {} } as const;
  extension.tool(
    "policy",
    {
      description:
        "Operator command (compozy extension exec github-app-review --cmd policy). Agents should not call this tool: " +
        "it shows the policy working-copy digest, the active approved digest, the approval state and the repo diff.",
      inputSchema: empty,
      readOnly: true,
      command: { verb: "policy", summary: "Show the policy working copy, the active approved version and the repo diff" },
    },
    policyHandler("policy", toolDeps)
  );
  extension.tool(
    "policy_stage",
    {
      description:
        "Operator command (compozy extension exec github-app-review --cmd policy-stage). Agents should not call this tool: " +
        "it copies the schema-checked policy working copy to policies/<sha256>.toml and prints the line that activates it.",
      inputSchema: empty,
      // Declared read-only so a trusted source (the recommended policy) lets the operator run it: it
      // touches no GitHub or approval state, only an idempotent content-addressed copy of the working
      // copy; GITHUB_APP_POLICY_DIGEST alone activates a version.
      readOnly: true,
      command: { verb: "policy-stage", summary: "Stage the policy working copy as an immutable digest-addressed version" },
    },
    policyHandler("policy-stage", toolDeps)
  );
  return extension;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  // Before any request: hosts behind TLS inspection need the OS CA store.
  trustSystemCertificates();
  void createExtension().start();
}
