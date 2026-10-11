import { describe, expect, it } from "vitest";
import {
  computeInputSetHash,
  evaluateEvidence,
  extractApprovedPaths,
  isFileMapPath,
  type EvidenceMirror
} from "../src/evidence.js";
import type { EvidenceId, InternalOrder, WorkflowStepId } from "../src/steps.js";

const sha = (character: string): string => character.repeat(40);

const order = (overrides: Partial<InternalOrder> = {}): InternalOrder => ({
  actionId: "179da8c7-ae22-47eb-b6eb-211ceea6b732",
  issue: 1,
  agent: "codex",
  stepId: "R2.plan",
  evidenceId: "plan-published",
  submissionMode: "git" as const,
  requiredPath: ".plans/issue-1/plan.md",
  responsePath: null,
  completePath: "/runtime/issue-1/agents/codex/complete",
  branch: "issue-1/codex",
  round: null,
  issueSessionId: `issue-1:${sha("a")}`,
  baselineSha: sha("a"),
  automationDigest: "b".repeat(64),
  task: "Plan",
  inputs: [],
  approvedPaths: [],
  activeRoster: ["codex"],
  eligibleChoices: [],
  ...overrides
});

const mirror = (blob: string | null, overrides: Partial<EvidenceMirror> = {}): EvidenceMirror => ({
  fetchBranch: async () => ({ ok: true, ref: "refs/remotes/origin/issue-1/codex", tip: sha("f") }),
  isReachable: async () => true,
  isAncestor: async () => true,
  readBlob: async () => blob,
  changedPaths: async () => ["src/product.ts"],
  validatePhasePin: async () => ({ ok: true }),
  ...overrides
});

describe("agreed file-map amendments", () => {
  it.each(["R4.implement", "R6.revise"] as const)("admits a bound request, not readiness, from %s", async (stepId) => {
    const action = order({ stepId, evidenceId: stepId === "R4.implement" ? "implementation-pinned" : "revision-pinned",
      approvedPaths: ["src/product.ts"], scopeHash: "a".repeat(64) });
    const request = { protocolVersion: 1, artifact: "plan-amendment-request", issue: 1, agent: action.agent,
      issueSessionId: action.issueSessionId, actionId: action.actionId, inputSetHash: computeInputSetHash(action.inputs),
      scopeHash: action.scopeHash, explanation: "The regression assertion was omitted.",
      additionalPaths: [{ path: "test/product.test.ts", reason: "Tests the changed behavior." }] };
    const accepted = await evaluateEvidence(action, sha("e"), mirror(JSON.stringify(request)));
    expect(accepted).toMatchObject({ status: "satisfied", amendmentRequest: request });
    expect(accepted.productPin).toBeUndefined();
    for (const patch of [{ actionId: "10000000-0000-4000-8000-000000000001" }, { scopeHash: "b".repeat(64) },
      { inputSetHash: "c".repeat(64) }, { issueSessionId: "other" },
      { additionalPaths: [{ path: "src/product.ts", reason: "Already covered." }] }]) {
      expect((await evaluateEvidence(action, sha("e"), mirror(JSON.stringify({ ...request, ...patch })))).status).toBe("rejected");
    }
  });

  it.each(["R4.implement", "R6.revise"] as const)("enforces exact approved additions and current scope for %s", async (stepId) => {
    const input = { kind: "implementation", agent: "claude", commitSha: sha("2"), path: ".signals/issue-1/implementation-ready-claude.json" };
    const action = order({ stepId, evidenceId: stepId === "R4.implement" ? "implementation-pinned" : "revision-pinned",
      round: stepId === "R6.revise" ? 2 : null, inputs: [input], approvedPaths: ["src/product.ts"], scopeHash: "a".repeat(64) });
    const artifact = { protocolVersion: 1, issue: 1, issueSessionId: action.issueSessionId, agent: action.agent,
      inputSetHash: computeInputSetHash(action.inputs), ...(stepId === "R4.implement"
        ? { artifact: "implementation-ready", implementationCommitSha: sha("d"), approvedPaths: action.approvedPaths }
        : { artifact: "revision-ready", revisedBranchHead: sha("d"), basedOn: [input.commitSha], round: 2 }) };
    const verify = (target: InternalOrder, patch: object, changed = ["test/product.test.ts"]) =>
      evaluateEvidence(target, sha("e"), mirror(JSON.stringify({ ...artifact, ...patch }), { changedPaths: async () => changed }));
    expect((await verify(action, {})).status).toBe("rejected");
    const amended = { ...action, approvedPaths: ["src/product.ts", "test/product.test.ts"],
      exactApprovedPaths: ["test/product.test.ts"], scopeRequired: true, scopeHash: "b".repeat(64) };
    const ready = { scopeHash: amended.scopeHash, ...(stepId === "R4.implement" ? { approvedPaths: amended.approvedPaths } : {}) };
    expect((await verify(amended, ready)).status).toBe("satisfied");
    expect((await verify(amended, { ...ready, scopeHash: undefined })).status).toBe("rejected");
    expect((await verify(amended, { ...ready, scopeHash: action.scopeHash })).status).toBe("rejected");
    expect((await verify(amended, ready, ["test/product.test.ts/child"])).status).toBe("rejected");
    expect((await verify(amended, ready, ["src/other.ts"])).status).toBe("rejected");
  });
});

describe("plan file-map path extraction", () => {
  it("accepts nested repository paths including monorepo prefixes", () => {
    expect(isFileMapPath("packages/core/src/domain/model.ts")).toBe(true);
    expect(isFileMapPath("apps/web/src/session/mapSessionVideo.test.ts")).toBe(true);
    expect(isFileMapPath("src/product.ts")).toBe(true);
    expect(isFileMapPath("test/product.test.ts")).toBe(true);
    expect(isFileMapPath("cmd/coord/main.go")).toBe(true);
    expect(isFileMapPath("packages/core/src/**")).toBe(true);
    expect(isFileMapPath("apps/web/")).toBe(true);
    expect(isFileMapPath("package.json")).toBe(true);
  });

  it("rejects identifiers, escapes, and coordination prefixes", () => {
    expect(isFileMapPath("VIDEO_DOMAINS")).toBe(false);
    expect(isFileMapPath("toDomain")).toBe(false);
    expect(isFileMapPath("workouts")).toBe(false);
    expect(isFileMapPath("/abs/path.ts")).toBe(false);
    expect(isFileMapPath("packages/../secret.ts")).toBe(false);
    expect(isFileMapPath(".plans/issue-1/plan.md")).toBe(false);
    expect(isFileMapPath(".signals/issue-1/participation-ready-codex.json")).toBe(false);
    expect(isFileMapPath(".code-reviews/issue-1/review.md")).toBe(false);
  });

  it("keeps monorepo file-map paths and drops bare identifiers from a plan", () => {
    const plan = `# Reuse and Scope
- \`packages/core/src/domain/read-only.ts\`

## Exact File Map
- \`packages/core/src/domain/model.ts\`
- \`apps/web/src/session/mapSessionVideo.test.ts\`
- \`VIDEO_DOMAINS\`
- \`toDomain\`
- \`workouts\`
- \`SessionVideo.tsx\`
`;
    expect(extractApprovedPaths(plan)).toEqual([
      "SessionVideo.tsx",
      "apps/web/src/session/mapSessionVideo.test.ts",
      "packages/core/src/domain/model.ts"
    ]);
  });

  it("expands a single bash brace group in backticked file-map paths", () => {
    const plan = `# Plan
- \`scripts/setup_{antigravity,claude,codex,cursor}.sh\`
- \`scripts/start_isolated_{antigravity,claude,codex}_agents.sh\`
- \`scripts/start_isolated_cursor_agents.sh\`
`;
    expect(extractApprovedPaths(plan)).toEqual([
      "scripts/setup_antigravity.sh",
      "scripts/setup_claude.sh",
      "scripts/setup_codex.sh",
      "scripts/setup_cursor.sh",
      "scripts/start_isolated_antigravity_agents.sh",
      "scripts/start_isolated_claude_agents.sh",
      "scripts/start_isolated_codex_agents.sh",
      "scripts/start_isolated_cursor_agents.sh"
    ]);
  });

  it("does not treat nested or empty brace groups as file-map paths", () => {
    expect(extractApprovedPaths("- `scripts/{a,{b,c}}.sh`\n")).toEqual([]);
    expect(extractApprovedPaths("- `scripts/{a,}.sh`\n")).toEqual([]);
  });
});

describe("evidence evaluation", () => {
  it("validates a plan at the submitted SHA and extracts its approved file map", async () => {
    const plan = `# Plan

## Exact File Map
- \`src/product.ts\`
- \`test/product.test.ts\`

## Reuse and Scope
### Existing helper
Reuse the existing product helper at \`src/existing-helper.ts\`; no new files are needed.

## Tests
Run tests.

## Alternatives Rejected
None.

## Risks and Mitigations
Keep pins immutable.

## Conclusion
Implement it.
`;
    const result = await evaluateEvidence(order(), sha("c"), mirror(plan));
    expect(result).toMatchObject({
      status: "satisfied",
      approvedPaths: ["src/product.ts", "test/product.test.ts"]
    });
  });

  it("accepts the split changed/created file-list headings", async () => {
    const plan = `# Plan

## Exact File List to be changed or deleted
- \`src/product.ts\`

## Exact file list to be created
- \`test/product.test.ts\`

## Reuse and Scope
Reuse the existing product helper at \`src/existing-helper.ts\`; no new files are needed.

## Tests
Run tests.

## Alternatives Rejected
None.

## Risks and Mitigations
Keep pins immutable.

## Conclusion
Implement it.
`;
    const result = await evaluateEvidence(order(), sha("c"), mirror(plan));
    expect(result).toMatchObject({
      status: "satisfied",
      approvedPaths: ["src/product.ts", "test/product.test.ts"]
    });
  });

  it("rejects a plan that omits the reuse and scope section", async () => {
    const plan = `# Plan

## Exact File Map
- \`src/product.ts\`

## Tests
Run tests.

## Alternatives Rejected
None.

## Risks and Mitigations
Keep pins immutable.

## Conclusion
Implement it.
`;
    const result = await evaluateEvidence(order(), sha("c"), mirror(plan));
    expect(result).toMatchObject({
      status: "rejected",
      outstanding: expect.arrayContaining(["plan is missing a non-empty Reuse and Scope section"])
    });
  });

  it("extracts monorepo file-map paths from a plan and ignores identifiers", async () => {
    const plan = `# Plan

## Exact File Map
- \`packages/core/src/domain/model.ts\`
- \`apps/web/src/session/mapSessionVideo.test.ts\`
- \`VIDEO_DOMAINS\`
- \`toDomain\`

## Scope and Reuse
Reuse the existing helper at \`packages/core/src/domain/existing.ts\`; no new files are needed.

## Tests
Run tests.

## Alternatives Rejected
None.

## Risks and Mitigations
Keep pins immutable.

## Conclusion
Implement it.
`;
    const result = await evaluateEvidence(order(), sha("c"), mirror(plan));
    expect(result).toMatchObject({
      status: "satisfied",
      approvedPaths: [
        "apps/web/src/session/mapSessionVideo.test.ts",
        "packages/core/src/domain/model.ts"
      ]
    });
  });

  it("accepts implementation changes under an extracted packages/ file-map entry", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const approvedPaths = ["packages/core/src/domain/model.ts"];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: sha("d"),
      approvedPaths
    });
    expect(
      await evaluateEvidence(
        action,
        sha("e"),
        mirror(blob, { changedPaths: async () => ["packages/core/src/domain/model.ts"] })
      )
    ).toMatchObject({ status: "satisfied", productPin: sha("d") });
  });

  it("returns retry without an artifact verdict when origin fetch fails", async () => {
    const result = await evaluateEvidence(
      order(),
      sha("c"),
      mirror(null, { fetchBranch: async () => ({ ok: false, transient: true, error: "network timeout" }) })
    );
    expect(result).toMatchObject({ status: "retry", outstanding: ["origin fetch failed: network timeout"] });
  });

  it("treats a permanently absent expected branch as rejected evidence", async () => {
    const result = await evaluateEvidence(
      order(),
      sha("c"),
      mirror(null, { fetchBranch: async () => ({ ok: false, transient: false, error: "remote ref missing" }) })
    );
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding.join(" ")).toContain("could not be fetched");
  });

  it("checks participation-readiness session, baseline, and digest fields", async () => {
    const action = order({
      stepId: "R1.join",
      evidenceId: "join-published",
      requiredPath: ".signals/issue-1/participation-ready-codex.json"
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "participation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      baselineSha: sha("0"),
      automationDigest: action.automationDigest
    });
    expect(await evaluateEvidence(action, sha("c"), mirror(blob))).toMatchObject({
      status: "rejected",
      outstanding: ["participation-readiness baselineSha does not match the issue baseline"]
    });
  });

  it("rejects implementation paths outside the selected plan map", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths: ["src/product.ts"]
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: sha("d"),
      approvedPaths: ["src/product.ts"]
    });
    const result = await evaluateEvidence(
      action,
      sha("e"),
      mirror(blob, { changedPaths: async () => ["src/product.ts", "docs/unapproved.md"] })
    );
    expect(result.status).toBe("rejected");
    expect(result.outstanding.join(" ")).toContain("docs/unapproved.md");
  });

  it.each(["automation", "automation/", "automation/**"] as const)(
    "accepts Git's per-file listing for a deleted directory when the map names %s",
    async (mapEntry) => {
      const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
      const action = order({
        stepId: "R4.implement",
        evidenceId: "implementation-pinned",
        requiredPath: ".signals/issue-1/implementation-ready-codex.json",
        inputs,
        approvedPaths: [mapEntry]
      });
      const blob = JSON.stringify({
        protocolVersion: 1,
        artifact: "implementation-ready",
        issue: 1,
        issueSessionId: action.issueSessionId,
        agent: "codex",
        inputSetHash: computeInputSetHash(inputs),
        implementationCommitSha: sha("d"),
        approvedPaths: [mapEntry]
      });
      const result = await evaluateEvidence(
        action,
        sha("e"),
        mirror(blob, {
          changedPaths: async () => ["automation/src/foo.ts", "automation/package.json"]
        })
      );
      expect(result).toMatchObject({ status: "satisfied", productPin: sha("d") });
    }
  );

  it.each([
    ["implementation-pinned" as EvidenceId, "R4.implement" as WorkflowStepId, "the implementation signal"],
    ["revision-pinned" as EvidenceId, "R6.revise" as WorkflowStepId, "the revision signal"]
  ])(
    "names %s in outcome language, never by its evidence id, in pin-lineage rejections",
    async (evidenceId, stepId, subject) => {
      const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
      const action = order({
        stepId,
        evidenceId,
        requiredPath: ".signals/issue-1/implementation-ready-codex.json",
        inputs,
        approvedPaths: ["src/product.ts"],
        ...(stepId === "R6.revise" ? { round: 1 } : {})
      });
      const blob = JSON.stringify(
        stepId === "R6.revise"
          ? {
              protocolVersion: 1,
              artifact: "revision-ready",
              issue: 1,
              issueSessionId: action.issueSessionId,
              agent: "codex",
              inputSetHash: computeInputSetHash(inputs),
              round: 1,
              revisedBranchHead: sha("d"),
              basedOn: [sha("2")]
            }
          : {
              protocolVersion: 1,
              artifact: "implementation-ready",
              issue: 1,
              issueSessionId: action.issueSessionId,
              agent: "codex",
              inputSetHash: computeInputSetHash(inputs),
              implementationCommitSha: sha("d"),
              approvedPaths: ["src/product.ts"]
            }
      );
      // Echo the subject the evaluator supplies, exactly as pinValidation does.
      const result = await evaluateEvidence(
        action,
        sha("e"),
        mirror(blob, {
          validatePhasePin: async ({ subject: supplied }) => ({
            ok: false,
            reason: "history-rewrite",
            details: `${supplied} pins ${sha("d")}, which is not an ancestor of current origin tip.`
          })
        })
      );
      const outstanding = result.outstanding.join(" ");
      expect(outstanding).toContain(subject);
      expect(outstanding).not.toContain(evidenceId);
    }
  );

  it("does not let an implementation rewrite the bound file map to a directory prefix", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths: ["automation"]
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: sha("d"),
      approvedPaths: ["automation/"]
    });
    const result = await evaluateEvidence(action, sha("e"), mirror(blob));
    expect(result.status).toBe("rejected");
    expect(result.outstanding.join(" ")).toContain("do not match the selected plan file map");
  });

  it("does not treat a file map entry as a prefix of a sibling path", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths: ["src/product.ts"]
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: sha("d"),
      approvedPaths: ["src/product.ts"]
    });
    const result = await evaluateEvidence(
      action,
      sha("e"),
      mirror(blob, { changedPaths: async () => ["src/product.ts.bak", "src/other.ts"] })
    );
    expect(result.status).toBe("rejected");
    expect(result.outstanding.join(" ")).toContain("src/product.ts.bak");
    expect(result.outstanding.join(" ")).toContain("src/other.ts");
  });

  it("does not treat a directory glob as a string prefix of a sibling name", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths: ["automation/**"]
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: sha("d"),
      approvedPaths: ["automation/**"]
    });
    const result = await evaluateEvidence(
      action,
      sha("e"),
      mirror(blob, { changedPaths: async () => ["automation-extra/foo.ts"] })
    );
    expect(result.status).toBe("rejected");
    expect(result.outstanding.join(" ")).toContain("automation-extra/foo.ts");
  });

  it("rejects a coordination signal commit used as its own product pin", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths: ["src/product.ts"]
    });
    const submission = sha("d");
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: submission,
      approvedPaths: ["src/product.ts"]
    });
    const result = await evaluateEvidence(action, submission, mirror(blob));
    expect(result.outstanding).toContain("product pin must differ from the coordination signal commit");
  });

  it.each([
    ["R1.join", "join-published"],
    ["R2.plan", "plan-published"],
    ["R3.review", "review-published"],
    ["R3.plan-ballot", "plan-response-accepted"],
    ["R4.implement", "implementation-pinned"],
    ["R5.compare", "comparison-published"],
    ["R5.compare-ballot", "comparison-response-accepted"],
    ["R6.revise", "revision-pinned"],
    ["R6.ballot", "consensus-response-accepted"],
    ["R7.finalize", "finalization-verified"]
  ] as const)("rejects missing required-path evidence for %s", async (stepId, evidenceId) => {
    const result = await evaluateEvidence(
      order({ stepId: stepId as WorkflowStepId, evidenceId: evidenceId as EvidenceId, requiredPath: `.missing/${stepId}` }),
      sha("c"),
      mirror(null)
    );
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding.join(" ")).toContain("is missing");
  });

  it.each([
    ["R1.join", "join-published"],
    ["R3.plan-ballot", "plan-response-accepted"],
    ["R4.implement", "implementation-pinned"],
    ["R5.compare-ballot", "comparison-response-accepted"],
    ["R6.revise", "revision-pinned"],
    ["R6.ballot", "consensus-response-accepted"],
    ["R7.finalize", "finalization-verified"]
  ] as const)("rejects malformed structured evidence for %s", async (stepId, evidenceId) => {
    const result = await evaluateEvidence(
      order({ stepId: stepId as WorkflowStepId, evidenceId: evidenceId as EvidenceId }),
      sha("c"),
      mirror("not-json")
    );
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding.join(" ")).toMatch(/invalid|artifact/);
  });

  it.each([
    ["R2.plan", "plan-published"],
    ["R3.review", "review-published"],
    ["R5.compare", "comparison-published"]
  ] as const)("rejects mechanically incomplete markdown evidence for %s", async (stepId, evidenceId) => {
    const result = await evaluateEvidence(
      order({ stepId: stepId as WorkflowStepId, evidenceId: evidenceId as EvidenceId }),
      sha("c"),
      mirror("# Incomplete\n")
    );
    expect(result).toMatchObject({ status: "rejected" });
  });

  it("rejects repository artifacts for plan ballot response steps", async () => {
    const plan = { agent: "claude", commitSha: sha("1"), path: ".plans/issue-1/plan.md", kind: "plan" };
    const review = { agent: "claude", commitSha: sha("2"), path: ".plans/issue-1/review.md", kind: "review" };
    const ballotOrder = order({
      stepId: "R3.plan-ballot",
      evidenceId: "plan-response-accepted",
      submissionMode: "response",
      requiredPath: "",
      responsePath: "/runtime/issue-1/agents/codex/responses/179da8c7-ae22-47eb-b6eb-211ceea6b732.json",
      inputs: [plan, review],
      activeRoster: ["codex", "claude"],
      eligibleChoices: ["claude"]
    });
    const result = await evaluateEvidence(ballotOrder, sha("c"), mirror("{}"));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding).toContain("ballot steps cannot be satisfied through a repository artifact");
  });

  it("rejects a comparison that omits a bound implementation pin", async () => {
    const input = {
      agent: "claude",
      commitSha: sha("2"),
      path: ".signals/issue-1/implementation-ready-claude.json",
      kind: "implementation"
    };
    const action = order({
      stepId: "R5.compare",
      evidenceId: "comparison-published",
      requiredPath: ".code-reviews/issue-1/comparison.md",
      inputs: [input]
    });
    const result = await evaluateEvidence(action, sha("c"), mirror("# Comparison\n\nNo bound pin is cited.\n"));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding).toContain(`comparison does not cite implementation pin ${input.commitSha}`);
  });

  it("rejects repository artifacts for comparison ballot response steps", async () => {
    const implementation = {
      agent: "claude",
      commitSha: sha("2"),
      path: ".signals/issue-1/implementation-ready-claude.json",
      kind: "implementation"
    };
    const action = order({
      stepId: "R5.compare-ballot",
      evidenceId: "comparison-response-accepted",
      submissionMode: "response",
      requiredPath: "",
      responsePath: "/runtime/issue-1/agents/codex/responses/179da8c7-ae22-47eb-b6eb-211ceea6b732.json",
      inputs: [implementation],
      activeRoster: ["claude", "codex"],
      eligibleChoices: ["claude"]
    });
    const result = await evaluateEvidence(action, sha("c"), mirror("{}"));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding).toContain("ballot steps cannot be satisfied through a repository artifact");
  });

  it("requires revision lineage, approved paths, and immutable phase separation", async () => {
    const input = {
      agent: "claude",
      commitSha: sha("2"),
      path: ".signals/issue-1/implementation-ready-claude.json",
      kind: "implementation"
    };
    const action = order({
      stepId: "R6.revise",
      evidenceId: "revision-pinned",
      requiredPath: ".signals/issue-1/revision-ready-codex-round-1.json",
      round: 1,
      inputs: [input],
      approvedPaths: ["src/product.ts"]
    });
    const artifact = {
      protocolVersion: 1,
      artifact: "revision-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(action.inputs),
      round: 1,
      revisedBranchHead: sha("d"),
      basedOn: [input.commitSha]
    };
    const unrelated = await evaluateEvidence(
      action,
      sha("e"),
      mirror(JSON.stringify(artifact), {
        isAncestor: async (base, tip) => !(base === input.commitSha && tip === artifact.revisedBranchHead)
      })
    );
    expect(unrelated.outstanding.join(" ")).toContain("does not descend from its exact authorized input pin");

    const escaped = await evaluateEvidence(
      action,
      sha("e"),
      mirror(JSON.stringify(artifact), { changedPaths: async () => ["docs/unapproved.md"] })
    );
    expect(escaped.outstanding.join(" ")).toContain("outside the approved file map");

    const postPin = await evaluateEvidence(
      action,
      sha("e"),
      mirror(JSON.stringify(artifact), {
        changedPaths: async () => ["src/product.ts"],
        validatePhasePin: async () => ({ ok: false, reason: "post-pin-implementation-change", details: "post-pin product change" })
      })
    );
    expect(postPin.outstanding).toContain("post-pin product change");

    expect(
      await evaluateEvidence(
        action,
        sha("e"),
        mirror(JSON.stringify(artifact), { changedPaths: async () => ["src/product.ts"] })
      )
    ).toMatchObject({ status: "satisfied", productPin: artifact.revisedBranchHead });
  });
});


describe("follow-up filing receipts", () => {
  it("binds a receipt to this action, published ballot set and exact revision", async () => {
    const action = order({ stepId: "R6.follow-up", evidenceId: "follow-up-published", round: 3,
      requiredPath: ".signals/issue-1/follow-up-ready-codex-round-3.json",
      inputs: [
        { agent: "claude", kind: "revision", commitSha: sha("c"), path: ".signals/issue-1/revision.json" },
        { agent: "codex", kind: "consensus-ballot", commitSha: sha("d"), path: ".code-reviews/issue-1/ballot.json" }
      ] });
    const receipt = { protocolVersion: 1, issue: 1, issueSessionId: action.issueSessionId, agent: "codex",
      artifact: "follow-up-ready", actionId: action.actionId, inputSetHash: computeInputSetHash(action.inputs),
      round: 3, revisionCommitSha: sha("c"), followUpIssueUrl: "https://github.com/acme/app/issues/2" };
    expect(await evaluateEvidence(action, sha("f"), mirror(JSON.stringify(receipt))))
      .toMatchObject({ status: "satisfied", followUpRequest: receipt });
    for (const patch of [{ actionId: "10000000-0000-4000-8000-000000000001" }, { inputSetHash: "a".repeat(64) },
      { issue: 2 }, { agent: "claude" }, { round: 2 }, { revisionCommitSha: sha("b") }, { issueSessionId: "old-session" }]) {
      expect((await evaluateEvidence(action, sha("f"), mirror(JSON.stringify({ ...receipt, ...patch })))).status).toBe("rejected");
    }
  });
});
