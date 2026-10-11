import { computeInputSetHash } from "./evidence.js";
import type { BoundInput, WorkflowStepId } from "./steps.js";

export type ArtifactScaffoldContext = {
  stepId: WorkflowStepId;
  issue: number;
  issueSessionId: string;
  agent: string;
  baselineSha: string;
  automationDigest: string;
  inputs: readonly BoundInput[];
  eligibleChoices: readonly string[];
  round: number | null;
  approvedPaths: readonly string[];
  actionId?: string;
  scopeHash?: string;
  /** Follow-up filing only: everything the objector needs to file and find its issue. */
  followUp?: FollowUpFiling;
  /** Finalization only: the base revision concluded at the revision limit with objections. */
  concludedWithObjections?: boolean;
};

export type FollowUpFiling = {
  /** `owner/name`, or null when the origin is not a GitHub repository. */
  repository: string | null;
  parentIssue: number;
  revisionSha: string;
  /** Stable across reissued actions so a retried filing finds the issue it already created. */
  filingKey: string;
};

const PLACEHOLDER_SHA = "<40-lowercase-hex-commit-sha>";

const common = (ctx: ArtifactScaffoldContext) => ({
  protocolVersion: 1 as const,
  issue: ctx.issue,
  issueSessionId: ctx.issueSessionId,
  agent: ctx.agent
});

const withHash = (ctx: ArtifactScaffoldContext) => ({
  ...common(ctx),
  inputSetHash: computeInputSetHash(ctx.inputs)
});

/**
 * Full minimal JSON body for JSON evidence steps. Known bindings are filled;
 * agent-authored commit SHAs use an explicit placeholder the agent must replace.
 */
export const artifactScaffoldValue = (ctx: ArtifactScaffoldContext): Record<string, unknown> | null => {
  switch (ctx.stepId) {
    case "R1.join":
      return {
        ...common(ctx),
        artifact: "participation-ready",
        baselineSha: ctx.baselineSha,
        automationDigest: ctx.automationDigest
      };
    case "R3.plan-ballot":
      return {
        actionId: ctx.actionId ?? "<action-uuid>",
        choice: "<eligible-agent-id>",
        rationale: "<one sentence>"
      };
    case "R4.implement":
      return {
        ...withHash(ctx),
        artifact: "implementation-ready",
        implementationCommitSha: PLACEHOLDER_SHA,
        ...(ctx.scopeHash === undefined ? {} : { scopeHash: ctx.scopeHash }),
        approvedPaths: ctx.approvedPaths.length > 0 ? [...ctx.approvedPaths] : ["<path-from-selected-plan>"]
      };
    case "R5.compare-ballot":
      return {
        actionId: ctx.actionId ?? "<action-uuid>",
        choice: "<eligible-agent-id>",
        rationale: "<one sentence>"
      };
    case "R6.revise":
      return {
        ...withHash(ctx),
        artifact: "revision-ready",
        round: ctx.round ?? 1,
        revisedBranchHead: PLACEHOLDER_SHA,
        ...(ctx.scopeHash === undefined ? {} : { scopeHash: ctx.scopeHash }),
        basedOn: ctx.inputs.map((input) => input.commitSha)
      };
    case "R4.amend-ballot":
    case "R6.ballot":
      return {
        actionId: ctx.actionId ?? "<action-uuid>",
        disposition: "approve",
        rationale: "<one sentence>"
      };
    case "R6.follow-up":
      return {
        ...withHash(ctx),
        artifact: "follow-up-ready",
        actionId: ctx.actionId ?? "<action-uuid>",
        round: ctx.round ?? 1,
        revisionCommitSha: ctx.followUp?.revisionSha ?? PLACEHOLDER_SHA,
        followUpIssueUrl: "<https://github.com/OWNER/REPO/issues/NUMBER of the issue you filed>"
      };
    case "R7.finalize":
      return {
        ...common(ctx),
        artifact: "finalization",
        consensusSha: ctx.inputs[0]?.commitSha ?? PLACEHOLDER_SHA,
        finalSha: PLACEHOLDER_SHA,
        // The coordinator runs the final profile independently at finalSha.
        // Do not prompt an agent to fabricate a successful coordinator result.
        checks: []
      };
    default:
      return null;
  }
};

const markdownHeadingScaffold = (ctx: ArtifactScaffoldContext): string => {
  switch (ctx.stepId) {
    case "R2.plan":
      return (
        "\n\nRequired markdown headings for this action (also in AGENTS.md; the list here is authoritative " +
        "for this action and may change). Each heading needs a non-empty body " +
        "(accepted aliases in parentheses):\n\n" +
        "## Exact File List to be changed or deleted\n" +
        "(or Exact File Map / File Map / File Creation Order / Proposed Architecture)\n\n" +
        "## Exact file list to be created\n" +
        "(or Exact File Map / File Map / File Creation Order / Proposed Architecture)\n\n" +
        "## Reuse and Scope\n" +
        "(or Reuse / Scope and Reuse)\n" +
        "Name the existing functions, types, helpers, tests, and fixtures the implementation will reuse, " +
        "and justify every new file. Paths cited only here do not expand what the implementation may change; " +
        "also list every path intended for change in a file-list section above.\n\n" +
        "## Tests\n" +
        "(or Test / Validation)\n" +
        "Propose the fewest focused tests that fail before the change and pass after it, and name the existing " +
        "test file each new case will join whenever one exists.\n\n" +
        "## Alternatives Rejected\n" +
        "(or Alternatives)\n\n" +
        "## Risks and Mitigations\n" +
        "(or Risks)\n\n" +
        "## Conclusion\n"
      );
    case "R3.review":
      return (
        "\n\nRequired markdown headings for this action (also in AGENTS.md; the list here is authoritative " +
        "for this action and may change). Each heading needs a non-empty body:\n\n" +
        "## Findings\n" +
        "(or Review Findings)\n\n" +
        "## Conclusion\n" +
        "(or Verdict)\n\n" +
        "Plan-review findings must state, in order: the plan claim or section; the rule that must hold; " +
        "a concrete failure if the plan is followed as written; then optionally the smallest correction. " +
        "The rule and the failure are the deliverable. Also evaluate whether the plan stays within the issue, " +
        "reuses existing code and test support, justifies every new file, and proposes only focused tests.\n"
      );
    case "R5.compare":
      return (
        "\n\nRequired markdown headings for this action (also in AGENTS.md; the list here is authoritative " +
        "for this action and may change). Use a heading line that is exactly the section name " +
        "(no em dash or subtitle on the same line). Each heading needs a non-empty body:\n\n" +
        "## Comparison\n" +
        "(or Findings)\n\n" +
        "Cite every bound implementation pin SHA from the inputs list below.\n\n" +
        "When a finding reviews implementation code, state in order: file path and line number; " +
        "the rule that must hold; a concrete failure that follows from breaking it; then optionally " +
        "the smallest illustrative test — or a fix sketch if a test cannot express it. Prefer a test over a fix. " +
        "Also compare whether each implementation stays within the issue, reuses existing code and tests, " +
        "avoids unnecessary files or refactors, and adds only focused coverage.\n"
      );
    default:
      return "";
  }
};

/** Issue-filing steps for a final-round objector; the coordinator verifies the issue on GitHub. */
export const followUpFilingInstructions = (ctx: ArtifactScaffoldContext): string => {
  const filing = ctx.followUp;
  if (ctx.stepId !== "R6.follow-up" || filing === undefined) return "";
  const repo = filing.repository === null ? "" : ` --repo ${filing.repository}`;
  const where = filing.repository ?? "this project's GitHub repository";
  const parentUrl = filing.repository === null
    ? `#${filing.parentIssue}` : `https://github.com/${filing.repository}/issues/${filing.parentIssue}`;
  return (
    `\n\nFile your remaining objections as one new issue in ${where}. You file it; the coordinator only checks it.\n\n` +
    "1. Search every issue state first, so a retried task reuses the issue you already filed:\n" +
    `   gh issue list${repo} --state all --search "${filing.filingKey} in:body" --json number,url,body\n` +
    `   If an issue whose body contains ${filing.filingKey} is listed, use its URL and skip step 2.\n` +
    "2. Otherwise write the body to a file and create exactly one issue:\n" +
    `   gh issue create${repo} --title "<descriptive title>" --body-file <file>\n` +
    "   The body must contain: each remaining objection with its concrete failure and the expected behavior; " +
    `the final revision ${filing.revisionSha}; the line \`Follow-up to #${filing.parentIssue} (${parentUrl})\` ` +
    "(a plain reference, not a closing keyword); and the line " +
    `\`Filing key: ${filing.filingKey}\`. If creation reports an error, search again before creating another.\n` +
    "3. Put that issue's URL in the receipt below, commit only the receipt, and push.\n\n" +
    `The coordinator reads the issue on GitHub before accepting the receipt: it must be a different issue in ${where} ` +
    `whose body names #${filing.parentIssue}, the final revision, and the filing key.`
  );
};

/** What the finalization base is, stated for the decision that authorized it. */
const finalizationBaseNotice = (ctx: ArtifactScaffoldContext): string =>
  ctx.stepId === "R7.finalize" && ctx.concludedWithObjections === true
    ? "\n\nThe bound consensus commit is the final allowed revision. It concluded with objections on record; " +
      "they are filed as follow-up issues, not addressed here. Finalize it unchanged apart from the permitted cleanup."
    : "";

export const renderArtifactScaffold = (ctx: ArtifactScaffoldContext): string => {
  const markdown = markdownHeadingScaffold(ctx);
  if (markdown !== "") return markdown;
  const value = artifactScaffoldValue(ctx);
  if (value === null) return "";
  const json = JSON.stringify(value, null, 2);
  const isResponse =
    ctx.stepId === "R3.plan-ballot" || ctx.stepId === "R5.compare-ballot" || ctx.stepId === "R6.ballot" || ctx.stepId === "R4.amend-ballot";
  const preamble = isResponse
    ? `\n\nWrite this JSON to the response path (replace any \`<...>\` placeholders):\n\n`
    : `\n\nWrite this JSON to the required path (replace any \`<...>\` placeholders; keep bound citations and digests exact):\n\n`;
  const request = ctx.scopeHash !== undefined && (ctx.stepId === "R4.implement" || ctx.stepId === "R6.revise")
    ? "\n\nIf the selected plan overlooked a necessary file, do not claim readiness or change the approved map yourself. " +
      "Instead, write the following alternative JSON at the same required path, commit and push ONLY that request artifact " +
      "(leave unfinished product edits unstaged), and submit its commit SHA using the same completion instructions. " +
      "The request is not approval; wait for the coordinator's new action before using additional paths. " +
      "Explain why each exact file is needed for the original behavior, not new scope. Product checks still apply to the eventual implementation.\n\n```json\n" +
      JSON.stringify({ ...withHash(ctx), artifact: "plan-amendment-request", actionId: ctx.actionId ?? "<action-uuid>",
        scopeHash: ctx.scopeHash, explanation: "<discovered omission>",
        additionalPaths: [{ path: "<exact-product-file-path>", reason: "<why the original plan needs this file>" }] }, null, 2) + "\n```"
    : "";
  return followUpFilingInstructions(ctx) + finalizationBaseNotice(ctx) + preamble + "```json\n" + `${json}\n` + "```" + request;
};
