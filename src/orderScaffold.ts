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
  conclusion?: "unanimous-active-roster-v1" | "revision-limit-active-roster-v1";
  filing?: {
    repository: string | null;
    concludingIssueUrl: string;
    concludingIssueNumber: number;
    revisionSha: string;
    filingKey: string;
  };
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
    case "R6.follow-up": {
      const revision = ctx.inputs.find((input) => input.kind === "revision")?.commitSha ?? ctx.filing?.revisionSha ?? PLACEHOLDER_SHA;
      return {
        ...withHash(ctx),
        artifact: "follow-up-ready",
        actionId: ctx.actionId ?? "<action-uuid>",
        round: 3,
        revisionCommitSha: revision,
        followUpIssueUrl: "<https://github.com/owner/repo/issues/N>"
      };
    }
    case "R4.amend-ballot":
    case "R6.ballot":
      return {
        actionId: ctx.actionId ?? "<action-uuid>",
        disposition: "approve",
        rationale: "<one sentence>"
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

const followUpFilingNote = (ctx: ArtifactScaffoldContext): string => {
  if (ctx.stepId !== "R6.follow-up") return "";
  const filing = ctx.filing;
  const repository = filing?.repository ?? null;
  const revision = filing?.revisionSha || "(bound final revision)";
  const key = filing?.filingKey || "(filing key once the final revision is bound)";
  const issueNumber = filing?.concludingIssueNumber ?? ctx.issue;
  const issueUrl = filing?.concludingIssueUrl || "(concluding issue URL)";
  const repo = repository ?? "<owner/repo>";
  const search = `gh issue list --repo ${repo} --state all --search ${JSON.stringify(key)}`;
  const create = `gh issue create --repo ${repo} --title "<descriptive title>" --body-file objections.md`;
  return (
    "\n\nCreate one GitHub issue in the repository below. The review ballots are already published; do not file before they are public. " +
    "Search every issue state for the filing key and reuse a match, including after a retry. " +
    "If creation is uncertain, search again before creating another issue. " +
    "Write the body to a file and pass that file to gh issue create so multiline content stays intact. " +
    `The body must include the remaining objections, the expected behavior, revision ${revision}, filing key ${key}, ` +
    `and a backlink to ${issueUrl} or #${issueNumber}. Do not use Closes, Fixes, or Resolves with that issue.\n\n` +
    `Repository: ${repository ?? "(not a GitHub repository; report that instead of creating an issue)"}\n` +
    `Concluding issue: #${issueNumber}\n` +
    `Concluding issue URL: ${issueUrl}\n` +
    `Revision: ${revision}\n` +
    `Filing key: ${key}\n` +
    `Search: ${search}\n` +
    `Create: ${create}`
  );
};

const conclusionNote = (ctx: ArtifactScaffoldContext): string => {
  if (ctx.stepId !== "R7.finalize" || ctx.conclusion === undefined) return "";
  if (ctx.conclusion === "revision-limit-active-roster-v1") {
    return (
      "\n\nThis finalization base is the third-revision pin recorded by revision-limit-active-roster-v1. " +
      "Objections were not approvals. Remove only current-issue coordination files."
    );
  }
  return "\n\nThis finalization base is the pin recorded by unanimous-active-roster-v1.";
};

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
  return preamble + "```json\n" + `${json}\n` + "```" + request + followUpFilingNote(ctx) + conclusionNote(ctx);
};
