import { describe, expect, it } from "vitest";
import { artifactScaffoldValue, renderArtifactScaffold } from "../src/orderScaffold.js";
import { planAmendmentRequestSchema } from "../src/protocol.js";
import { BUILD_DISCIPLINE_NOTE, STEP_DEFINITIONS } from "../src/steps.js";

describe("orderScaffold", () => {
  it("offers a request without a product pin and keeps revision ancestry separate", () => {
    const ctx = {
      stepId: "R6.revise" as const, issue: 1, issueSessionId: "s", agent: "codex",
      actionId: "10000000-0000-4000-8000-000000000001", baselineSha: "a".repeat(40), automationDigest: "b".repeat(64),
      inputs: [{ kind: "implementation", agent: "codex", commitSha: "c".repeat(40), path: ".signals/issue-1/implementation-ready-codex.json" }],
      eligibleChoices: [], round: 2, approvedPaths: ["src/product.ts"], scopeHash: "d".repeat(64)
    };
    expect(artifactScaffoldValue(ctx)).toMatchObject({ scopeHash: ctx.scopeHash, basedOn: ["c".repeat(40)], round: 2 });
    const rendered = renderArtifactScaffold(ctx);
    expect(rendered).toContain('"artifact": "plan-amendment-request"');
    expect(rendered).toContain('"scopeHash": "' + ctx.scopeHash + '"');
    expect(rendered).toContain("unstaged");
    expect(rendered).toContain('"explanation": "<discovered omission>"');
    expect(rendered).not.toContain('"rationale"');
    const requestJson = [...rendered.matchAll(/```json\n([\s\S]*?)\n```/g)][1]![1]!;
    expect(planAmendmentRequestSchema.parse({ ...JSON.parse(requestJson),
      additionalPaths: [{ path: "test/product.test.ts", reason: "Regression coverage" }]
    })).toMatchObject({ explanation: "<discovered omission>" });
    const ballot = artifactScaffoldValue({ ...ctx, stepId: "R4.amend-ballot" });
    expect(ballot).toEqual({ actionId: ctx.actionId, disposition: "approve", rationale: "<one sentence>" });
  });

  it("renders a filled join JSON scaffold", () => {
    const ctx = {
      stepId: "R1.join" as const,
      issue: 1,
      issueSessionId: "issue-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent: "antigravity",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: null,
      approvedPaths: []
    };
    expect(artifactScaffoldValue(ctx)).toEqual({
      protocolVersion: 1,
      issue: 1,
      issueSessionId: ctx.issueSessionId,
      agent: "antigravity",
      artifact: "participation-ready",
      baselineSha: ctx.baselineSha,
      automationDigest: ctx.automationDigest
    });
    const rendered = renderArtifactScaffold(ctx);
    expect(rendered).toContain("```json");
    expect(rendered).toContain('"artifact": "participation-ready"');
  });

  it("renders JSON for implementation-ready", () => {
    const rendered = renderArtifactScaffold({
      stepId: "R4.implement",
      issue: 1,
      issueSessionId: "s",
      agent: "claude",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: null,
      approvedPaths: []
    });
    expect(rendered).toContain("```json");
    expect(rendered).toContain('"artifact": "implementation-ready"');
  });

  it("lists required plan headings for R2.plan", () => {
    const rendered = renderArtifactScaffold({
      stepId: "R2.plan",
      issue: 1,
      issueSessionId: "s",
      agent: "claude",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: null,
      approvedPaths: []
    });
    expect(rendered).toContain("## Exact File List to be changed or deleted");
    expect(rendered).toContain("## Exact file list to be created");
    expect(rendered).toContain("## Reuse and Scope");
    expect(rendered).toContain("## Tests");
    expect(rendered).toContain("## Alternatives Rejected");
    expect(rendered).toContain("## Risks and Mitigations");
    expect(rendered).toContain("## Conclusion");
    expect(rendered).toContain("AGENTS.md");
    expect(rendered).toContain("Paths cited only here do not expand");
    expect(rendered).toContain("fewest focused tests");
  });

  it("lists required review headings for R3.review", () => {
    const rendered = renderArtifactScaffold({
      stepId: "R3.review",
      issue: 1,
      issueSessionId: "s",
      agent: "codex",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: null,
      approvedPaths: []
    });
    expect(rendered).toContain("## Findings");
    expect(rendered).toContain("## Conclusion");
    expect(rendered).toContain("Plan-review findings must state");
    expect(rendered).toContain("reuses existing code and test support");
  });

  it("lists required comparison headings for R5.compare", () => {
    const rendered = renderArtifactScaffold({
      stepId: "R5.compare",
      issue: 1,
      issueSessionId: "s",
      agent: "cursor",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: null,
      approvedPaths: []
    });
    expect(rendered).toContain("## Comparison");
    expect(rendered).toContain("(or Findings)");
    expect(rendered).toContain("no em dash or subtitle");
    expect(rendered).toContain("file path and line number");
    expect(rendered).toContain("reuses existing code and tests");
    expect(rendered).not.toContain("```json");
  });

  it("renders only the minimal private response JSON for ballot steps", () => {
    const plan = artifactScaffoldValue({
      stepId: "R3.plan-ballot",
      issue: 1,
      issueSessionId: "s",
      agent: "claude",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: ["claude", "codex"],
      round: null,
      approvedPaths: [],
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4"
    });
    expect(plan).toEqual({
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4",
      choice: "<eligible-agent-id>",
      rationale: "<one sentence>"
    });
    expect(plan).not.toHaveProperty("artifact");
    expect(plan).not.toHaveProperty("protocolVersion");

    const consensus = artifactScaffoldValue({
      stepId: "R6.ballot",
      issue: 1,
      issueSessionId: "s",
      agent: "claude",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: 1,
      approvedPaths: [],
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4"
    });
    expect(consensus).toEqual({
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4",
      disposition: "approve",
      rationale: "<one sentence>"
    });
  });

  it("fills the follow-up receipt and a replay-safe filing key", () => {
    const revision = "c".repeat(40);
    const actionId = "10000000-0000-4000-8000-000000000004";
    const ctx = {
      stepId: "R6.follow-up" as const,
      issue: 177,
      issueSessionId: "issue-177:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent: "codex",
      actionId,
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [{ kind: "revision", agent: "cursor", commitSha: revision, path: ".signals/issue-177/revision-ready-cursor-round-3.json" }],
      eligibleChoices: [],
      round: 3,
      approvedPaths: [],
      filing: {
        repository: "acme/app",
        concludingIssueUrl: "https://github.com/acme/app/issues/177",
        concludingIssueNumber: 177,
        revisionSha: revision,
        filingKey: `coord-follow-up:issue-177:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:codex:${revision}`
      }
    };
    const value = artifactScaffoldValue(ctx);
    expect(value).toMatchObject({
      artifact: "follow-up-ready",
      actionId,
      round: 3,
      revisionCommitSha: revision,
      followUpIssueUrl: "<https://github.com/owner/repo/issues/N>"
    });
    const rendered = renderArtifactScaffold(ctx);
    expect(rendered).toContain("already published");
    expect(rendered).toContain("gh issue list --repo acme/app --state all");
    expect(rendered).toContain("--body-file objections.md");
    expect(rendered).toContain(ctx.filing.filingKey);
    expect(rendered).not.toContain(`coord-follow-up:${actionId}`);
    expect(rendered).toContain("https://github.com/acme/app/issues/177");
  });

  it("limits build discipline to planning, implementation, and revision tasks", () => {
    expect(
      Object.values(STEP_DEFINITIONS)
        .filter((definition) => definition.task.includes(BUILD_DISCIPLINE_NOTE))
        .map((definition) => definition.id)
    ).toEqual(["R2.plan", "R4.implement", "R6.revise"]);
  });
});
