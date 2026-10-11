import { readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAction } from "../src/action.js";
import { computeInputSetHash, evaluateEvidence, type EvidenceMirror } from "../src/evidence.js";
import {
  AGENT_FACING_BANNED_TERMS,
  AGENT_FACING_PROSE_FILES,
  agentFacingSubject,
  agentFacingSubjects,
  findAgentLanguageViolations,
  shellEmittedText
} from "../src/agentLanguage.js";
import { renderAgentsProtocolBlock } from "../src/agentsProtocol.js";
import { HookPolicyError, resolveWorkspaceConfig, runVerifyPhase, verifyCommands } from "../src/hookPolicy.js";
import { AGENTS_PROTOCOL_MARKERS, removeManagedBlock } from "../src/productIgnore.js";
import { coordinatorConfigSchema } from "../src/state.js";
import { COORD_IDLE_SENTINEL } from "../src/tmux.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { buildOrder } from "../src/runLoop.js";
import {
  cursorsStateSchema,
  initializeOperationalState,
  readCursorsState,
  readStartState,
  writeCursorsState
} from "../src/state.js";
import { STEP_DEFINITIONS, type WorkflowStepId } from "../src/steps.js";
import { renderNudgeText } from "../src/tmux.js";

const repoRoot = new URL("..", import.meta.url).pathname;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-language-"));
  roots.push(root);
  const paths = issueRuntimePaths(root, 1);
  createIssueRuntime(paths, ["claude", "codex"]);
  initializeOperationalState(paths, {
    issue: 1,
    issueSessionId: `issue-1:${"a".repeat(40)}`,
    baselineSha: "a".repeat(40),
    profile: "consensus",
    originalRoster: ["claude", "codex"],
    branchTemplate: "issue-{issue}/{agent}",
    baseBranch: "main",
    maxRevisionRounds: 3,
    prPolicy: "owner-only",
    automationDigest: "b".repeat(64),
    automationDigestScheme: "sha256-length-prefixed-v1",
    automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
    trustedSourceCommit: "c".repeat(40),
    origin: "/origin.git",
    coordRoot: root,
    configPath: join(root, "config.json"),
    agents: [
      { id: "claude", root: "/clones/claude", launcher: "start-claude.sh", delivery: "pull" },
      { id: "codex", root: "/clones/codex", launcher: "start-codex.sh", delivery: "pull" }
    ],
    checks: [{ name: "check", argv: ["node", "-e", "process.exit(0)"] }],
    pollIntervalMs: 100,
    contextPaths: ["docs/repo-map.md"]
  });
  return paths;
};

/** Accepted submissions for every step that later steps bind as inputs. */
const seedAcceptedSubmissions = (paths: ReturnType<typeof fixture>) => {
  const now = "2026-08-21T00:00:00.000Z";
  const current = readCursorsState(paths);
  const accepted = [
    ...current.activeRoster.map((agent) => ({
      stepId: "R2.plan" as const,
      agent,
      round: null,
      submissionSha: "1".repeat(40),
      path: `.plans/issue-1/plan.md`,
      approvedPaths: ["src/steps.ts"],
      acceptedAt: now
    })),
    ...current.activeRoster.map((agent) => ({
      stepId: "R3.review" as const,
      agent,
      round: null,
      submissionSha: "2".repeat(40),
      path: `.plans/issue-1/review.md`,
      acceptedAt: now
    })),
    ...current.activeRoster.map((agent) => ({
      stepId: "R3.plan-ballot" as const,
      agent,
      round: null,
      submissionSha: "3".repeat(40),
      choice: "claude",
      path: `.plans/issue-1/ballot-${agent}.json`,
      acceptedAt: now
    })),
    ...current.activeRoster.map((agent) => ({
      stepId: "R4.implement" as const,
      agent,
      round: null,
      submissionSha: "4".repeat(40),
      productPin: "5".repeat(40),
      path: `.signals/issue-1/implementation-ready-${agent}.json`,
      acceptedAt: now
    })),
    ...current.activeRoster.map((agent) => ({
      stepId: "R5.compare-ballot" as const,
      agent,
      round: null,
      submissionSha: "6".repeat(40),
      choice: "codex",
      path: `.code-reviews/issue-1/ballot-${agent}.json`,
      acceptedAt: now
    })),
    {
      stepId: "R6.revise" as const,
      agent: "codex",
      round: 1,
      submissionSha: "7".repeat(40),
      productPin: "8".repeat(40),
      path: ".signals/issue-1/revision-ready-codex-round-1.json",
      acceptedAt: now
    },
    ...current.activeRoster.map((agent) => ({
      stepId: "R6.ballot" as const,
      agent,
      round: 1,
      submissionSha: "9".repeat(40),
      disposition: "approve" as const,
      path: `.code-reviews/issue-1/consensus-ballot-${agent}-round-1.json`,
      acceptedAt: now
    }))
  ];
  writeCursorsState(
    paths,
    cursorsStateSchema.parse({
      ...current,
      derived: {
        planSelection: {
          kind: "plan-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "a".repeat(64),
          activeRoster: current.activeRoster,
          inputs: [
            {
              kind: "plan",
              agent: "claude",
              submissionSha: "1".repeat(40),
              path: ".plans/issue-1/plan.md"
            }
          ],
          decisionId: `plan-selection:${"a".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          selectedAgents: ["claude"]
        },
        implementationSelection: {
          kind: "implementation-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "b".repeat(64),
          activeRoster: current.activeRoster,
          inputs: [
            {
              kind: "implementation",
              agent: "codex",
              submissionSha: "4".repeat(40),
              path: ".signals/issue-1/implementation-ready-codex.json",
              productPin: "5".repeat(40)
            }
          ],
          decisionId: `implementation-selection:${"b".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          winner: "codex",
          implementationPin: "5".repeat(40),
          reviser: "codex"
        },
        consensus: null
      },
      accepted,
      updatedAt: now
    })
  );
};

const everyStep = Object.keys(STEP_DEFINITIONS) as WorkflowStepId[];
const roundOf = (stepId: WorkflowStepId): number | null => (stepId.startsWith("R6.") ? 1 : null);

const sampleChangeScope = [
  { agent: "claude", commitSha: "1".repeat(40), paths: ["src/steps.ts"], truncated: false }
] as const;

const renderEveryStep = (paths: ReturnType<typeof fixture>, outstanding: readonly string[] = []): Map<WorkflowStepId, string> => {
  const start = readStartState(paths);
  const cursors = readCursorsState(paths);
  const rendered = new Map<WorkflowStepId, string>();
  for (const stepId of everyStep) {
    const order = buildOrder(
      paths,
      start,
      cursors,
      "codex",
      stepId,
      roundOf(stepId),
      "b2337d85-6617-4e9f-8ace-901453764aa4",
      outstanding,
      undefined,
      sampleChangeScope
    );
    rendered.set(stepId, renderAction(order));
  }
  return rendered;
};

const walkFiles = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...walkFiles(path));
      continue;
    }
    found.push(path);
  }
  return found;
};

describe("agent-facing language", () => {
  it("keeps internal vocabulary out of every generated action type", () => {
    const paths = fixture();
    for (const [stepId, body] of renderEveryStep(paths)) {
      expect(body).toContain("## Repo context");
      expect(body).toContain("## Changed paths for the bound pins");
      expect(findAgentLanguageViolations(body), stepId).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of every generated action once inputs are bound", () => {
    const paths = fixture();
    seedAcceptedSubmissions(paths);
    const rendered = renderEveryStep(paths);
    // Prove the seeding actually produced bound citations, so this is not a
    // second pass over the same empty-input bodies.
    expect(rendered.get("R3.plan-ballot")).toContain('"actionId"');
    expect(rendered.get("R3.plan-ballot")).toContain('"choice"');
    expect(rendered.get("R3.plan-ballot")).toContain('"rationale"');
    expect(rendered.get("R3.plan-ballot")).not.toContain('"artifact": "plan-ballot"');
    expect(rendered.get("R3.plan-ballot")).toContain("1".repeat(40));
    expect(rendered.get("R3.plan-ballot")).toContain("submissionMode: response");
    for (const [stepId, body] of rendered) {
      expect(findAgentLanguageViolations(body), stepId).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of the correction block", () => {
    const paths = fixture();
    seedAcceptedSubmissions(paths);
    const outstanding = agentFacingSubjects().map(
      (subject) => `${subject} pins ${"e".repeat(40)}, which is not an ancestor of current origin tip.`
    );
    for (const [stepId, body] of renderEveryStep(paths, outstanding)) {
      expect(body).toContain("Correct these outstanding items:");
      expect(findAgentLanguageViolations(body), stepId).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of a correction block built from real evidence output", async () => {
    const paths = fixture();
    seedAcceptedSubmissions(paths);
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    const stepId: WorkflowStepId = "R4.implement";
    const order = buildOrder(paths, start, cursors, "codex", stepId, null, "b2337d85-6617-4e9f-8ace-901453764aa4");
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: order.issue,
      issueSessionId: order.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(order.inputs),
      implementationCommitSha: "d".repeat(40),
      approvedPaths: [...order.approvedPaths]
    });
    const mirror: EvidenceMirror = {
      fetchBranch: async () => ({ ok: true, ref: "refs/remotes/origin/issue-1/codex", tip: "f".repeat(40) }),
      isReachable: async () => true,
      isAncestor: async () => true,
      readBlob: async () => blob,
      changedPaths: async () => ["src/steps.ts"],
      // Echo whatever subject the evaluator supplies, exactly as pinValidation does.
      validatePhasePin: async ({ subject }) => ({
        ok: false,
        reason: "history-rewrite",
        details: `${subject} pins ${"d".repeat(40)}, which is not an ancestor of current origin tip.`
      })
    };
    const observation = await evaluateEvidence(order, "e".repeat(40), mirror);

    // The strings under test come from the evaluator, not from this test, so a
    // regression in `pinErrors` reaches the rendered action instead of being
    // masked by feeding the subject map back through the renderer.
    expect(observation.status).toBe("rejected");
    expect(observation.outstanding.length).toBeGreaterThan(0);
    expect(findAgentLanguageViolations(observation.outstanding.join(" "))).toEqual([]);

    const reissued = renderAction(
      buildOrder(
        paths,
        start,
        cursors,
        "codex",
        stepId,
        null,
        "b2337d85-6617-4e9f-8ace-901453764aa4",
        observation.outstanding
      )
    );
    expect(reissued).toContain("Correct these outstanding items:");
    expect(findAgentLanguageViolations(reissued)).toEqual([]);
  });

  it("covers every workflow step and every evidence id", () => {
    expect(everyStep).toHaveLength(12);
    const subjects = new Set<string>();
    for (const stepId of everyStep) {
      const subject = agentFacingSubject(STEP_DEFINITIONS[stepId].evidenceId);
      expect(subject, stepId).toBeTruthy();
      subjects.add(subject);
    }
    expect(subjects.size).toBe(12);
    for (const subject of agentFacingSubjects()) {
      expect(findAgentLanguageViolations(subject), subject).toEqual([]);
    }
  });

  it("renders the follow-up task without internal vocabulary", () => {
    const body = renderEveryStep(fixture()).get("R6.follow-up");
    expect(body).toContain("already published");
    expect(body).toContain("gh issue list");
    expect(body).toContain("--body-file");
    expect(findAgentLanguageViolations(body ?? "")).toEqual([]);
  });

  it("keeps internal vocabulary out of the injected text", () => {
    const path = "/runtime/issue-1/agents/codex/action.md";
    const actionId = "b2337d85-6617-4e9f-8ace-901453764aa4";
    const digest = "a".repeat(64);
    for (const text of [
      renderNudgeText(path),
      renderNudgeText(path, actionId),
      renderNudgeText(path, actionId, digest)
    ]) {
      expect(findAgentLanguageViolations(text), text).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of every agent-facing prose file", () => {
    for (const relativePath of AGENT_FACING_PROSE_FILES) {
      const raw =
        relativePath === "AGENTS.md"
          ? removeManagedBlock(
              execSync("git show HEAD:AGENTS.md", { cwd: repoRoot, encoding: "utf8" }),
              relativePath,
              AGENTS_PROTOCOL_MARKERS
            ).content
          : readFileSync(join(repoRoot, relativePath), "utf8");
      expect(findAgentLanguageViolations(raw), relativePath).toEqual([]);
    }
  });

  it("scans the instruction files an agent actually loads", () => {
    expect(AGENT_FACING_PROSE_FILES).toContain("AGENTS.md");
    for (const relativePath of AGENT_FACING_PROSE_FILES) {
      const absolutePath = join(repoRoot, relativePath);
      expect(statSync(absolutePath).size).toBeGreaterThan(0);
    }
  });

  it("keeps internal vocabulary out of hook diagnostics an agent sees", () => {
    const verifyFixture = (overrides: Record<string, unknown> = {}) =>
      coordinatorConfigSchema.parse({
        project: "myserver",
        origin: "https://github.com/example/myserver.git",
        agents: [{ id: "claude", root: "../myserver-claude", launcher: "start-claude.sh" }],
        branch: "issue-{issue}/{agent}",
        checks: [{ name: "test", argv: ["node", "-e", "process.exit(0)"] }],
        ...overrides
      });
    expect(() => verifyCommands(verifyFixture(), "precommit")).toThrow(HookPolicyError);
    try {
      verifyCommands(verifyFixture(), "precommit");
    } catch (error) {
      expect(findAgentLanguageViolations((error as HookPolicyError).message)).toEqual([]);
    }

    const logs: string[] = [];
    runVerifyPhase({
      clone: repoRoot,
      config: verifyFixture({
        verify: {
          precommit: [{ name: "check", argv: ["node", "-e", "process.exit(0)"] }],
          prepush: []
        }
      }),
      phase: "precommit",
      runner: () => 0,
      log: (line) => logs.push(line)
    });
    runVerifyPhase({
      clone: repoRoot,
      config: verifyFixture({
        verify: {
          precommit: [{ name: "check", argv: ["node", "-e", "process.exit(0)"] }],
          prepush: []
        }
      }),
      phase: "prepush",
      runner: () => 0,
      log: (line) => logs.push(line)
    });
    expect(findAgentLanguageViolations(logs.join(""))).toEqual([]);

    const bareClone = mkdtempSync(join(tmpdir(), "coord-language-bare-"));
    roots.push(bareClone);
    execSync("git init", { cwd: bareClone, stdio: "ignore" });
    expect(() => resolveWorkspaceConfig(bareClone)).toThrow(HookPolicyError);
    try {
      resolveWorkspaceConfig(bareClone);
    } catch (error) {
      expect(findAgentLanguageViolations((error as HookPolicyError).message)).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of hook-emitted text", () => {
    const hookRoots = [join(repoRoot, "githooks"), join(repoRoot, "templates/hooks")];
    const walked = hookRoots.flatMap((root) => walkFiles(root));
    expect(walked.length).toBeGreaterThanOrEqual(8);
    for (const path of walked) {
      expect(findAgentLanguageViolations(shellEmittedText(readFileSync(path, "utf8"))), path).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of the installed agent guidance", () => {
    expect(findAgentLanguageViolations(renderAgentsProtocolBlock(repoRoot))).toEqual([]);
    expect(
      findAgentLanguageViolations(readFileSync(join(repoRoot, "templates/product/AGENTS.md"), "utf8"))
    ).toEqual([]);
  });

  it("installs the exact idle line the terminal readiness check matches", () => {
    // The sentinel is a contract between the protocol block an agent reads and
    // the matcher in src/tmux.ts. A reword on either side must fail here rather
    // than silently stop proving that a pane is idle.
    const block = renderAgentsProtocolBlock(repoRoot);
    expect(block).toContain(COORD_IDLE_SENTINEL);
    expect(block).toContain("write `ready <actionId>`");
    expect(block).toContain("file is missing because");
    expect(findAgentLanguageViolations(COORD_IDLE_SENTINEL)).toEqual([]);
  });

  it("reports the leaks issue 88 removed", () => {
    expect(findAgentLanguageViolations("R1.join")).toContain("internal-step-id: R1.join");
    expect(findAgentLanguageViolations("gate-1-join")).toContain("gate-id: gate-1");
    expect(
      findAgentLanguageViolations("execute the new action even if you were not nudged")
    ).toContain("delivery-vocabulary: nudged");
    expect(findAgentLanguageViolations("implementation-pinned artifact pins abc")).toContain(
      "evidence-id: implementation-pinned"
    );
    expect(findAgentLanguageViolations("R7 finalization is deletion-only cleanup")).toContain(
      "internal-round-label: R7"
    );
    expect(findAgentLanguageViolations("they gate pull-request creation")).toContain("gate-vocabulary: gate");
    expect(findAgentLanguageViolations("the current phase")).toContain("phase-vocabulary: phase");
    expect(findAgentLanguageViolations('"artifact": "join"').some((entry) => entry.startsWith("participation-phase-name:"))).toBe(
      true
    );
    expect(findAgentLanguageViolations("must not commit ungated")).toContain("gate-vocabulary: ungated");
    expect(findAgentLanguageViolations("must not commit gated")).toContain("gate-vocabulary: gated");
    expect(findAgentLanguageViolations("still gating commits")).toContain("gate-vocabulary: gating");
    expect(findAgentLanguageViolations("the current step also appears")).toContain("workflow-sequence: current step");
    expect(findAgentLanguageViolations("the final cleanup step deletes")).toContain(
      "workflow-sequence: final cleanup step"
    );
    expect(findAgentLanguageViolations("ordinary join paths stay legal")).toEqual([]);
    expect(AGENT_FACING_BANNED_TERMS.length).toBeGreaterThan(0);
  });

  it("does not flag the outcome-named paths the workflow still publishes", () => {
    for (const path of [
      ".signals/issue-1/participation-ready-codex.json",
      ".signals/issue-1/implementation-ready-codex.json",
      ".signals/issue-1/revision-ready-codex-round-1.json",
      ".signals/issue-1/finalization-ready-codex.json"
    ]) {
      expect(findAgentLanguageViolations(path), path).toEqual([]);
    }
  });

  it("leaves internal identifiers untouched", () => {
    expect(STEP_DEFINITIONS["R1.join"].id).toBe("R1.join");
    expect(STEP_DEFINITIONS["R1.join"].gateId).toBe("gate-1-join");
    expect(STEP_DEFINITIONS["R1.join"].evidenceId).toBe("join-published");
  });
});
