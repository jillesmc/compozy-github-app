import { pathToFileURL } from "node:url";

import { Extension, type ExtensionOptions } from "@compozy/extension-sdk";

import { REQUIRED_ENV } from "./config.ts";
import { doctorHandler } from "./doctor.ts";
import { trustSystemCertificates } from "./system-ca.ts";
import { toolHandler, type ToolDeps, type ToolDefinition } from "./tools/common.ts";
import { mergeGateTool } from "./tools/merge_gate.ts";
import { prContextTool } from "./tools/pr_context.ts";
import { submitReviewTool } from "./tools/submit_review.ts";
import { upsertPromotionTool } from "./tools/upsert_promotion.ts";

export const EXTENSION_VERSION = "0.2.0";
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
      requires_env: [...REQUIRED_ENV],
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
        "it reports app identity, installation, token mint, allowlisted repositories and rate limit.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      readOnly: true,
      command: { verb: "doctor", summary: "Check the GitHub App credentials, installation and allowlisted repositories" },
    },
    doctorHandler(toolDeps)
  );
  return extension;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  // Before any request: hosts behind TLS inspection need the OS CA store.
  trustSystemCertificates();
  void createExtension().start();
}
