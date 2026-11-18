import { RPCError } from "@compozy/extension-sdk";

/** Extension cause codes (`_dx.md` › Errors). */
export type ReviewErrorCode =
  | "credential_absent"
  | "credential_invalid"
  | "repo_not_allowed"
  | "repo_not_installed"
  | "invalid_input"
  | "too_many_findings"
  | "field_too_long"
  | "pr_not_reviewable"
  | "base_not_reviewable"
  | "config_invalid"
  | "head_moved"
  | "already_reviewed_head"
  | "rereview_not_eligible"
  | "promotion_conflict"
  | "rate_limited"
  | "github_rejected"
  | "github_unavailable";

/** A refusal or GitHub failure; `toolError` turns it into the CompozyOS tool error shape. */
export class ReviewError extends Error {
  readonly code: ReviewErrorCode;
  /** HTTP status behind the failure, for the log line only. */
  readonly httpStatus: number | undefined;
  /** Overrides the code's default recovery line. */
  readonly recovery: string | undefined;
  public constructor(code: ReviewErrorCode, message: string, httpStatus?: number, recovery?: string) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.recovery = recovery;
  }
}

export const reviewError = (code: ReviewErrorCode, message: string, httpStatus?: number, recovery?: string) =>
  new ReviewError(code, message, httpStatus, recovery);

const SECRETS_SET = "run compozy extension secrets set github-app-review --env GITHUB_APP_PRIVATE_KEY --value-stdin";
const DOCTOR = "compozy extension exec github-app-review --cmd doctor";

/** CompozyOS first-line code and recovery per cause code (`_dx.md` › Errors). */
const MAPPING: Record<ReviewErrorCode | "extension_failed", [string, string]> = {
  credential_absent: ["tool_unavailable", SECRETS_SET],
  credential_invalid: ["tool_unavailable", `re-bind the app private key; run ${DOCTOR}`],
  repo_not_allowed: ["tool_invalid_input", "use an allowlisted repository"],
  repo_not_installed: ["tool_unavailable", "install the app on the repository"],
  invalid_input: ["tool_invalid_input", "fix the named field"],
  too_many_findings: ["tool_invalid_input", "merge findings or shorten the text"],
  field_too_long: ["tool_invalid_input", "merge findings or shorten the text"],
  pr_not_reviewable: ["tool_invalid_input", "review only open, non-draft PRs"],
  base_not_reviewable: ["tool_invalid_input", "the app reviews only pull requests into GITHUB_APP_BASE"],
  config_invalid: ["tool_unavailable", "fix the named variable with compozy extension secrets set github-app-review --env <NAME> --value-stdin"],
  head_moved: ["tool_invalid_input", "end with stale: and let the dispatcher review the new head"],
  already_reviewed_head: ["tool_invalid_input", "nothing to do for this head"],
  rereview_not_eligible: ["tool_invalid_input", "the executor must change code or reply on a bot thread"],
  promotion_conflict: ["tool_invalid_input", "operator closes or merges that PR"],
  rate_limited: ["tool_unavailable", "retry after the reset time"],
  github_rejected: ["tool_backend_failed", "report; anchors drifted"],
  github_unavailable: ["tool_backend_failed", `retry later; run ${DOCTOR} if it persists`],
  extension_failed: ["tool_backend_failed", `retry later; run ${DOCTOR} if it persists`],
};

const MAX_ERROR_CHARS = 1000;

/** The cause code of any thrown value (`extension_failed` for unexpected errors). */
export const causeCode = (error: unknown): ReviewErrorCode | "extension_failed" =>
  error instanceof ReviewError ? error.code : "extension_failed";

/**
 * Tool failure as JSON-RPC -32000 whose `data` is a CompozyOS ToolError
 * `{code: tool_*, message, operator: {cause, recovery}}`; agents see the `tool_*` line, then
 * `Cause: <code>: <text>` and `Recovery: <text>` (the usual CompozyOS extension error shape).
 */
export function toolError(error: unknown): RPCError {
  const code = causeCode(error);
  const text = error instanceof ReviewError ? error.message : "github-app-review failed unexpectedly";
  const [toolCode, fallback] = MAPPING[code];
  const recovery = (error instanceof ReviewError && error.recovery) || fallback;
  const message = `${code}: ${text}`.slice(0, MAX_ERROR_CHARS);
  return new RPCError(-32000, message, { code: toolCode, message, operator: { cause: message, recovery } });
}
