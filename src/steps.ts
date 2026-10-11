import type { PlanAmendmentRequest } from "./protocol.js";

export const DEFAULT_MAX_REVISION_ROUNDS = 3;

export type WorkflowProfile = "solo" | "reviewed" | "consensus";
/** `owner-only` is a legacy alias of `coord-open-unmerged` (opens a PR; owner merges). */
export type PrPolicy = "owner-only" | "coord-open-unmerged" | "coord-merged";
export const DEFAULT_PR_POLICY: PrPolicy = "coord-open-unmerged";

export const coordMergesPullRequest = (policy: PrPolicy): boolean => policy === "coord-merged";

export type EvidenceId =
  | "join-published"
  | "plan-published"
  | "review-published"
  | "plan-response-accepted"
  | "implementation-pinned"
  | "amendment-response-accepted"
  | "comparison-published"
  | "comparison-response-accepted"
  | "revision-pinned"
  | "consensus-response-accepted"
  | "follow-up-published"
  | "finalization-verified";

export type WorkflowStepId =
  | "R1.join"
  | "R2.plan"
  | "R3.review"
  | "R3.plan-ballot"
  | "R4.implement"
  | "R4.amend-ballot"
  | "R5.compare"
  | "R5.compare-ballot"
  | "R6.revise"
  | "R6.ballot"
  | "R6.follow-up"
  | "R7.finalize";

export type GateId =
  | "gate-1-join"
  | "gate-2-plans"
  | "gate-3-selection"
  | "gate-4-implementations"
  | "gate-5-comparison"
  | "gate-6-consensus"
  | "gate-7-finalized";

/**
 * Appended to every action, not only the first one.
 *
 * Coordination checks the clone out and re-sets the skip-worktree bit before
 * any agent starts, but an agent that compacts, restarts, or reads only the
 * action in front of it has no memory of that. It used to be told once, on the
 * first action of the run, which is exactly the wrong place for a fact it needs
 * on every step.
 */
export const BRANCH_PREPARED_NOTE =
  "\n\nCoordination has already checked this clone out on the branch named below " +
  "and re-set the skip-worktree bit on AGENTS.md. Do not create that branch, " +
  "switch to it, or clear skip-worktree to make a checkout work. If the clone " +
  "looks wrong, report that instead of repairing it by hand.";

export const BUILD_DISCIPLINE_NOTE =
  "\n\nKeep the work within the issue and make the smallest change that fully solves it. " +
  "Inspect and reuse existing functions, types, helpers, tests, and fixtures before creating new ones. " +
  "Justify every new file, abstraction, and dependency; avoid unrelated cleanup and speculative flexibility. " +
  "Add the fewest focused tests needed, prefer extending an existing test file, and still run every required check.";

export type StepDefinition = {
  id: WorkflowStepId;
  gateId: GateId;
  evidenceId: EvidenceId;
  participants: "all" | "implementer" | "reviser" | "objectors";
  submissionMode: "git" | "response";
  /**
   * Git steps: repository-relative artifact path the agent must publish.
   * Response steps: canonical evidence-branch path used later as `publishPath`
   * (not an agent write target).
   */
  requiredPath: (issue: number, agent: string, round: number | null) => string;
  task: string;
};

export const CONTAINMENT_PROBE_NOTE = `\n\nContainment check (once per agent session or hook/policy configuration change, not per action):
Through your actual harness shell tool in this clone, request only \`git status --porcelain\`.
This harmless diagnostic is expected to be refused; do not work around it.
Then, through that same tool, run \`coord containment-probe --issue <current-issue-number> --resolved-git "$(command -v git)" --tool-result <hook-denied|shim-refused|executed|unknown> --vendor-version <actual-cli-version>\`.
Use hook-denied ONLY if the harness rejected the tool request before execution.
Use shim-refused ONLY for the coordinator shim's exit 2 refusal message, executed if Git actually ran, or unknown if you cannot tell. Do not invent a version.
The command queues an agent-reported observation in this clone's ignored .coord directory; the coordinator records it separately from the hook's emitted response. No owner-runtime write grant is needed.
Missing hooks, session identity, unsupported versions or failed recording leave coverage unverified; report the exact gap and continue.\n`;

export const STEP_DEFINITIONS: Readonly<Record<WorkflowStepId, StepDefinition>> = {
  "R1.join": {
    id: "R1.join",
    gateId: "gate-1-join",
    evidenceId: "join-published",
    participants: "all",
    submissionMode: "git",
    requiredPath: (issue, agent) => `.signals/issue-${issue}/participation-ready-${agent}.json`,
    task: `Publish the participation-readiness artifact for this issue.${CONTAINMENT_PROBE_NOTE}`
  },
  "R2.plan": {
    id: "R2.plan",
    gateId: "gate-2-plans",
    evidenceId: "plan-published",
    participants: "all",
    submissionMode: "git",
    requiredPath: (issue) => `.plans/issue-${issue}/plan.md`,
    task: `Write and publish a mechanically complete implementation plan.${BUILD_DISCIPLINE_NOTE}`
  },
  "R3.review": {
    id: "R3.review",
    gateId: "gate-3-selection",
    evidenceId: "review-published",
    participants: "all",
    submissionMode: "git",
    requiredPath: (issue) => `.plans/issue-${issue}/review.md`,
    task: "Review the bound peer plans and publish the review."
  },
  "R3.plan-ballot": {
    id: "R3.plan-ballot",
    gateId: "gate-3-selection",
    evidenceId: "plan-response-accepted",
    participants: "all",
    submissionMode: "response",
    requiredPath: (issue, agent) => `.plans/issue-${issue}/ballot-${agent}.json`,
    task: "Submit a plan ballot judgment as a private response with your choice and rationale. Do not commit or push."
  },
  "R4.implement": {
    id: "R4.implement",
    gateId: "gate-4-implementations",
    evidenceId: "implementation-pinned",
    participants: "implementer",
    submissionMode: "git",
    requiredPath: (issue, agent) => `.signals/issue-${issue}/implementation-ready-${agent}.json`,
    task: `Implement the selected plan and publish an implementation-ready signal that pins the product commit.${BUILD_DISCIPLINE_NOTE}`
  },
  "R4.amend-ballot": {
    id: "R4.amend-ballot",
    gateId: "gate-4-implementations",
    evidenceId: "amendment-response-accepted",
    participants: "all",
    submissionMode: "response",
    requiredPath: (issue, agent, sequence) => `.plans/issue-${issue}/amendment-ballot-${agent}-${sequence ?? 1}.json`,
    task: "Judge whether every requested file addition is necessary to finish the original selected plan, not expand its intended behavior. Approve only if all additions are justified; revise rejects the request with reasons, not a request to edit product code. Submit only a private response; do not commit or push."
  },
  "R5.compare": {
    id: "R5.compare",
    gateId: "gate-5-comparison",
    evidenceId: "comparison-published",
    participants: "all",
    submissionMode: "git",
    requiredPath: (issue) => `.code-reviews/issue-${issue}/comparison.md`,
    task: "Compare the exact bound implementation pins and publish the comparison."
  },
  "R5.compare-ballot": {
    id: "R5.compare-ballot",
    gateId: "gate-5-comparison",
    evidenceId: "comparison-response-accepted",
    participants: "all",
    submissionMode: "response",
    requiredPath: (issue, agent) => `.code-reviews/issue-${issue}/ballot-${agent}.json`,
    task: "Submit a comparison ballot judgment as a private response with your choice and rationale. Do not commit or push."
  },
  "R6.revise": {
    id: "R6.revise",
    gateId: "gate-6-consensus",
    evidenceId: "revision-pinned",
    participants: "reviser",
    submissionMode: "git",
    requiredPath: (issue, agent, round) =>
      `.signals/issue-${issue}/revision-ready-${agent}-round-${round ?? 1}.json`,
    task: `Prepare the requested revision and publish a signal pinning the revised product commit.${BUILD_DISCIPLINE_NOTE}`
  },
  "R6.ballot": {
    id: "R6.ballot",
    gateId: "gate-6-consensus",
    evidenceId: "consensus-response-accepted",
    participants: "all",
    submissionMode: "response",
    requiredPath: (issue, agent, round) =>
      `.code-reviews/issue-${issue}/consensus-ballot-${agent}-round-${round ?? 1}.json`,
    task: "Submit a consensus ballot judgment as a private response with your disposition and rationale. Do not commit or push."
  },
  "R6.follow-up": {
    id: "R6.follow-up",
    gateId: "gate-6-consensus",
    evidenceId: "follow-up-published",
    participants: "objectors",
    submissionMode: "git",
    requiredPath: (issue, agent, round) =>
      `.signals/issue-${issue}/follow-up-ready-${agent}-round-${round ?? 1}.json`,
    task: "The final revision round has ended with your objection on record. The revision will be finalized and " +
      "proposed as a pull request. File your remaining objections as one new GitHub issue, then publish a receipt citing it."
  },
  "R7.finalize": {
    id: "R7.finalize",
    gateId: "gate-7-finalized",
    evidenceId: "finalization-verified",
    participants: "reviser",
    submissionMode: "git",
    requiredPath: (issue, agent) => `.signals/issue-${issue}/finalization-ready-${agent}.json`,
    task: "Finalize the consensus commit, remove only current-issue coordination files, and publish finalization evidence."
  }
};

export const describeWorkflowStep = (stepId: WorkflowStepId | null, round: number | null): string => {
  if (stepId === null) return "complete";
  return round === null ? stepId : `${stepId} (round ${round})`;
};

/** Amendment sequence numbers never consume product revision rounds. */
export const roundForStep = (stepId: WorkflowStepId, round: number | null): number | null =>
  stepId.startsWith("R6.") || stepId === "R4.amend-ballot" ? (round ?? 1) : null;

export type BallotStepId = "R3.plan-ballot" | "R5.compare-ballot" | "R6.ballot" | "R4.amend-ballot";
export const isBallotStep = (stepId: WorkflowStepId): stepId is BallotStepId =>
  ["R3.plan-ballot", "R5.compare-ballot", "R6.ballot", "R4.amend-ballot"].includes(stepId);

const consensusSteps: readonly WorkflowStepId[] = [
  "R1.join",
  "R2.plan",
  "R3.review",
  "R3.plan-ballot",
  "R4.implement",
  "R5.compare",
  "R5.compare-ballot",
  "R6.revise",
  "R6.ballot",
  "R6.follow-up",
  "R7.finalize"
];

const reviewedSteps: readonly WorkflowStepId[] = [
  "R1.join",
  "R2.plan",
  "R3.review",
  "R3.plan-ballot",
  "R4.implement",
  "R7.finalize"
];

const soloSteps: readonly WorkflowStepId[] = ["R1.join", "R2.plan", "R4.implement", "R7.finalize"];

export const stepsForProfile = (profile: WorkflowProfile): readonly WorkflowStepId[] => {
  if (profile === "consensus") return consensusSteps;
  if (profile === "reviewed") return reviewedSteps;
  return soloSteps;
};

export const participantsForStep = (
  stepId: WorkflowStepId,
  profile: WorkflowProfile,
  activeRoster: readonly string[],
  reviser?: string,
  objectors: readonly string[] = []
): readonly string[] => {
  const step = STEP_DEFINITIONS[stepId];
  if (activeRoster.length === 0) return [];
  if (step.participants === "all") return activeRoster;
  if (step.participants === "objectors") return activeRoster.filter((agent) => objectors.includes(agent));
  const designated = reviser !== undefined && activeRoster.includes(reviser) ? reviser : activeRoster[0] as string;
  if (step.participants === "reviser") return [designated];
  return profile === "consensus" ? activeRoster : [designated];
};

export type BoundInput = {
  agent: string;
  commitSha: string;
  path: string;
  kind: string;
};

/**
 * Changed paths of one bound pin, resolved by the coordinator so that N agents
 * comparing the same pins do not each re-derive the same diff. Advisory only:
 * `approvedPaths` remains the sole authority over what an implementation may
 * touch.
 */
export type ChangeScopeEntry = {
  agent: string;
  commitSha: string;
  paths: readonly string[];
  /** True when `paths` was capped and does not list the whole diff. */
  truncated: boolean;
};

/**
 * One bound coordination artifact exported from the mirror to a file an agent
 * can read. The `commitSha`/`path` pair remains the citation authority; this is
 * a convenience copy, and `sha256` is what proves the copy is faithful.
 */
export type MaterializedInputEntry = {
  kind: string;
  agent: string;
  commitSha: string;
  path: string;
  sha256: string;
  localPath: string;
};

/** One detached worktree at a bound product pin. */
export type MaterializedWorktree = {
  kind: string;
  agent: string;
  commitSha: string;
  localPath: string;
};

/**
 * What the coordinator exported for one action. Advisory in exactly the way
 * `changeScope` is: the pins in the action remain the sole authority, and a
 * consumer that ignores this field still has everything it needs.
 */
export type MaterializedInputs = {
  /** Null when the action binds no coordination markdown. */
  inputSetHash: string | null;
  packetDir: string | null;
  manifestPath: string | null;
  entries: readonly MaterializedInputEntry[];
  worktrees: readonly MaterializedWorktree[];
  /**
   * Bound inputs that could not be exported, described for the operator log.
   * Never rendered into an action: an agent is told where files *are*, and the
   * pins it already has cover everything else.
   */
  omitted: readonly string[];
};

export type InternalOrder = {
  actionId: string;
  issue: number;
  agent: string;
  stepId: WorkflowStepId;
  evidenceId: EvidenceId;
  submissionMode: "git" | "response";
  /** Git: artifact path. Response: unused (empty string); canonical path is `publishPath`. */
  requiredPath: string;
  /** Absolute runtime response path for response actions; null for Git actions. */
  responsePath: string | null;
  /** Canonical repository path for later coordinator publication (response ballots). */
  publishPath?: string;
  completePath: string;
  branch: string;
  round: number | null;
  issueSessionId: string;
  baselineSha: string;
  automationDigest: string;
  task: string;
  inputs: readonly BoundInput[];
  approvedPaths: readonly string[];
  scopeHash?: string;
  scopeRequired?: boolean;
  scopeInputs?: readonly BoundInput[];
  exactApprovedPaths?: readonly string[];
  /**
   * Advisory, and optional on purpose: an added hint must not become a required
   * argument at every site that builds an order, and rendering must cope with
   * its absence rather than making callers supply an empty list.
   */
  contextPaths?: readonly string[];
  /** Frozen advisory text for this workflow cohort, never the live queue. */
  ownerGuidance?: readonly string[];
  changeScope?: readonly ChangeScopeEntry[];
  /** Optional for the same reason as `changeScope`: rendering copes without it. */
  materialized?: MaterializedInputs;
  activeRoster: readonly string[];
  eligibleChoices: readonly string[];
  /** Optional: orders built before coordinator verification render as local mode. */
  verificationMode?: "local" | "coordinator";
  candidateResults?: readonly CandidateResults[];
};

export type CheckResult = {
  name: string;
  argv: readonly string[];
  exitCode: number;
  /** Satisfied by a trusted coordinator receipt for equivalent inputs. */
  reused?: boolean;
  /** Satisfied by another runner's execution this request waited for. */
  joined?: boolean;
  receiptId?: string;
  logPath?: string;
  attempts?: number;
};

/** Coordinator results for one bound product pin, rendered for every reader. */
export type CandidateResults = { agent: string; commitSha: string; results: readonly CheckResult[] };

export type EvidenceObservation = {
  agent: string;
  actionId: string;
  submissionSha: string;
  status: "satisfied" | "rejected" | "retry";
  outstanding: readonly string[];
  productPin?: string;
  disposition?: "approve" | "revise" | "escalate";
  approvedPaths?: readonly string[];
  choice?: string;
  checkResults?: readonly CheckResult[];
  /** Present when the observation came from a private ballot response. */
  responseSha256?: string;
  rationale?: string;
  amendmentRequest?: PlanAmendmentRequest;
  /** Follow-up receipts: the issue the objector cites; the run loop verifies it on GitHub before acceptance. */
  followUpIssue?: FollowUpIssue;
};

/** A verified GitHub follow-up issue for objections that outlived the revision limit. */
export type FollowUpIssue = { number: number; url: string };

export type MachineDecision =
  | { type: "begin-amendment"; agent: string; submissionSha: string; request: PlanAmendmentRequest }
  | { type: "resolve-amendment"; approved: boolean }
  | { type: "prepare-action"; agent: string; stepId: WorkflowStepId; round: number | null }
  | {
      type: "accept-submission";
      agent: string;
      submissionSha: string;
      productPin?: string;
      disposition?: "approve" | "revise" | "escalate";
      approvedPaths?: readonly string[];
      choice?: string;
      checkResults?: readonly CheckResult[];
      followUpIssue?: FollowUpIssue;
    }
  | {
      type: "accept-response";
      agent: string;
      responseSha256: string;
      choice?: string;
      disposition?: "approve" | "revise" | "escalate";
      rationale: string;
    }
  | { type: "publish-ballot-batch"; stepId: WorkflowStepId; round: number | null }
  | { type: "reissue-action"; agent: string; outstanding: readonly string[] }
  | { type: "retry-verification"; agent: string; outstanding: readonly string[] }
  | { type: "advance-step"; from: WorkflowStepId; to: WorkflowStepId | null; round: number | null }
  | { type: "derive-plan-selection" }
  | { type: "derive-implementation-selection" }
  | { type: "derive-consensus"; round: number }
  /** A legacy question at the revision limit whose ballots now conclude the issue on their own. */
  | { type: "retire-owner-question"; questionId: string; kind: "ballot-escalation" | "revision-limit"; round: number }
  | { type: "wait"; reason: string }
  | {
      type: "owner-action-required";
      reason: string;
      kind: "ballot-escalation" | "revision-limit";
      round: number;
      allowedAnswers: readonly ("retry" | "revise" | "abandon")[];
    };
