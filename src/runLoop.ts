import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { shellQuote } from "./agentHookSync.js";
import { clearCompletion, clearReady, createActionId, readAction, readCompletion, readReady, writeAction, type ReadyReceipt } from "./action.js";
import {
  AGENT_OBSERVABILITY_WATCHDOG_MS,
  containmentCoverage,
  decideLifecycleNudge,
  markActionInjectionDeferred,
  markActionInjected,
  markActionWorkflowComplete,
  markInjectedActionAbsent,
  mutateAgentLifecycle,
  orderAgentAction,
  readAgentLifecycle,
  stopObservationWarning,
  hasStopReadiness,
  type AgentLifecycleEntry
} from "./agentLifecycle.js";
import {
  archiveAcceptedResponse,
  clearAgentResponse,
  parseBallotResponse,
  readAgentResponse,
  responseDigest
} from "./ballotResponse.js";
import {
  assertEvidenceBranchSafe,
  ballotBatchKindForStep,
  createEvidenceCommit,
  prepareBallotBatch,
  reconcileEvidencePublication,
  resolveEvidenceParentSha,
  type BallotAcceptedSemantics
} from "./ballotPublication.js";
import { computeInputSetHash, evaluateEvidence, extractApprovedPaths, type EvidenceMirror } from "./evidence.js";
import { verifyFinalization } from "./finalization.js";
import { inspectRangeChanges, selectCandidateVerification, selectVerification } from "./changeClassification.js";
import { runVerification, type RunVerificationResult } from "./verificationRunner.js";
import { createVerificationIngestor, verificationMeasurement } from "./verificationLog.js";
import { BareMirror, GitCommandError, hermeticGitEnv, isTransientGitFailure } from "./mirror.js";
import {
  materializeBoundInputs,
  pruneSupersededWorktrees,
  worktreeLabelsFor
} from "./materializedInputs.js";
import { renderArtifactScaffold } from "./orderScaffold.js";
import {
  agentResponsePath,
  agentRuntimePaths,
  evidenceWorktreePath,
  resourceBindingPaths,
  type IssueRuntimePaths
} from "./paths.js";
import { finishBinding, readBindingRecord, readCodexQuota, reserveBinding, type CodexQuotaReader } from "./codexQuota.js";
import {
  assessCodexLimits,
  codexClearsBlockers,
  codexHelperVersion,
  HOLDING_CLASSES,
  latestDeadline,
  mergeCodexBlockers,
  RESOURCE_WINDOW_LIMIT,
  type ResourceEvidence
} from "./resourceEvidence.js";
import { decide } from "./machine.js";
import {
  appendJournal,
  bindOwnerGuidance,
  ownerGuidanceFor,
  resetOwnerGuidance,
  suspendOwnerGuidance,
  cursorsStateSchema,
  emptyResourceObservation,
  readConfig,
  readCursorsState,
  readJournal,
  readStartState,
  releaseResourceHold,
  replaceCursor,
  requireStateMutation,
  StateConflictError,
  type AcceptedResponse,
  type AcceptedSubmission,
  type BallotBatch,
  type CheckCommand,
  type ConsensusDerived,
  type CursorsState,
  type DerivedInputCitation,
  type DerivedInputKind,
  type ImplementationSelectionDerived,
  type PlanSelectionDerived,
  type StartState
} from "./state.js";
import {
  BRANCH_PREPARED_NOTE,
  STEP_DEFINITIONS,
  isBallotStep,
  roundForStep,
  type BallotStepId,
  coordMergesPullRequest,
  describeWorkflowStep,
  type BoundInput,
  type CandidateResults,
  type ChangeScopeEntry,
  type MaterializedInputs,
  type EvidenceObservation,
  type InternalOrder,
  type MachineDecision,
  type WorkflowStepId
} from "./steps.js";
import { containmentPolicy, ingestContainmentProbe } from "./shellGuard.js";
import { holdRecoveryCommand, holdDescription, issueCommand, renderIssueReport } from "./issueReport.js";
import { inspectStartupAgent } from "./doctor.js";
import {
  assessFollowUpIssue,
  followUpFilingKey,
  formatFinalizationPullRequest,
  githubRepositoryFromOrigin,
  readGitHubIssueSnapshot
} from "./githubIssue.js";
import { prepareAgentIssueBranches } from "./prepareAgentBranch.js";
import { harnessPromptReadiness, TmuxController, type IdleOverride } from "./tmux.js";
import { sha256, sha256OfFile } from "./hash.js";

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };
export type ProcessRunner = (argv: readonly string[], cwd: string) => Promise<ProcessResult>;

export const runArgv: ProcessRunner = (argv, cwd) =>
  new Promise((resolvePromise, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new Error("Cannot run an empty argv."));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: command === "git" ? hermeticGitEnv() : process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
  });

export type PullRequestInput = {
  repository: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
};
export type PullRequestOpener = (input: PullRequestInput) => Promise<{ url: string }>;
export type PullRequestMerger = (input: { url: string }) => Promise<void>;

export const openDraftPullRequest: PullRequestOpener = async (input) => {
  const existing = await runArgv(
    ["gh", "pr", "list", "--repo", input.repository, "--head", input.head, "--state", "all", "--json", "url", "--limit", "1"],
    process.cwd()
  );
  if (existing.exitCode === 0) {
    try {
      const rows = JSON.parse(existing.stdout) as Array<{ url?: unknown }>;
      if (typeof rows[0]?.url === "string" && rows[0].url !== "") return { url: rows[0].url };
    } catch {
      // Fall through to create; gh's structured output should normally parse.
    }
  }
  const result = await runArgv(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      input.repository,
      ...(input.draft ? ["--draft"] : []),
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body
    ],
    process.cwd()
  );
  if (result.exitCode !== 0) throw new Error(`PR creation failed: ${result.stderr.trim()}`);
  return { url: result.stdout.trim() };
};

export const mergePullRequest: PullRequestMerger = async (input) => {
  const ready = await runArgv(["gh", "pr", "ready", input.url], process.cwd());
  if (ready.exitCode !== 0 && !/not a draft/i.test(`${ready.stderr}${ready.stdout}`)) {
    throw new Error(`marking PR ready failed: ${ready.stderr.trim() || ready.stdout.trim()}`);
  }
  const merged = await runArgv(["gh", "pr", "merge", input.url, "--merge", "--delete-branch"], process.cwd());
  if (merged.exitCode !== 0) throw new Error(`PR merge failed: ${merged.stderr.trim() || merged.stdout.trim()}`);
};

export { githubRepositoryFromOrigin } from "./githubIssue.js";

export type RunLoopDependencies = {
  mirror?: BareMirror;
  tmux?: TmuxController | null;
  processRunner?: ProcessRunner;
  pullRequestOpener?: PullRequestOpener;
  pullRequestMerger?: PullRequestMerger;
  now?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  actionId?: () => string;
  log?: (message: string) => void;
  verbose?: (message: string) => void;
  /** @deprecated Minimum wait before checking for lost delivery, never resend authority. */
  nudgeRetryMs?: number;
  /** One-shot Codex quota read for an owner-bound home (#140). */
  codexQuota?: CodexQuotaReader;
};

/** Kept as a public compatibility alias; elapsed time no longer authorizes a nudge. */
export const NUDGE_RETRY_MS = AGENT_OBSERVABILITY_WATCHDOG_MS;

const inputFromSubmission = (submission: AcceptedSubmission, kind: string, usePin = false): BoundInput => ({
  agent: submission.agent,
  commitSha: usePin ? (submission.productPin ?? submission.submissionSha) : submission.submissionSha,
  path: submission.path,
  kind
});

const acceptedAt = (
  cursors: CursorsState,
  stepId: WorkflowStepId,
  activeOnly = true,
  round?: number | null
): AcceptedSubmission[] =>
  cursors.accepted.filter(
    (submission) =>
      submission.stepId === stepId &&
      (!activeOnly || cursors.activeRoster.includes(submission.agent)) &&
      (round === undefined || submission.round === round)
  );

const acceptedResponsesAt = (
  cursors: CursorsState,
  stepId: BallotStepId,
  activeOnly = true,
  round?: number | null
): AcceptedResponse[] =>
  cursors.acceptedResponses.filter(
    (response) =>
      response.stepId === stepId &&
      (!activeOnly || cursors.activeRoster.includes(response.agent)) &&
      (round === undefined || response.round === round)
  );

const publishedBallotBatch = (
  cursors: CursorsState,
  stepId: BallotStepId,
  round: number | null
): BallotBatch | null => {
  const kind = ballotBatchKindForStep(stepId);
  const closed = acceptedResponsesAt(cursors, stepId, true, round);
  if (!hasCompleteActiveDenominator(cursors, closed)) return null;
  return (
    cursors.ballotBatches.find((batch) => {
      if (
        batch.kind !== kind ||
        batch.round !== round ||
        batch.status !== "published" ||
        batch.activeRoster.length !== cursors.activeRoster.length ||
        !batch.activeRoster.every((agent, index) => agent === cursors.activeRoster[index])
      ) {
        return false;
      }
      if (batch.responses.length !== closed.length) return false;
      return cursors.activeRoster.every((agent, index) => {
        const response = closed.find((candidate) => candidate.agent === agent);
        const entry = batch.responses[index];
        return (
          response !== undefined &&
          entry !== undefined &&
          entry.agent === agent &&
          entry.actionId === response.actionId &&
          entry.responseSha256 === response.responseSha256
        );
      });
    }) ?? null
  );
};

const pendingOrFailedBallotBatch = (
  cursors: CursorsState,
  stepId: WorkflowStepId,
  round: number | null
): BallotBatch | null => {
  if (!isBallotStep(stepId)) {
    return null;
  }
  const kind = ballotBatchKindForStep(stepId);
  return (
    [...cursors.ballotBatches]
      .reverse()
      .find(
        (batch) =>
          batch.kind === kind &&
          batch.round === round &&
          (batch.status === "pending" || batch.status === "failed") &&
          batch.activeRoster.length === cursors.activeRoster.length &&
          batch.activeRoster.every((agent, index) => agent === cursors.activeRoster[index])
      ) ?? null
  );
};

export const deterministicWinner = (
  cursors: CursorsState,
  stepId: "R3.plan-ballot" | "R5.compare-ballot",
  eligible: readonly string[]
): string | null => {
  const counts = new Map<string, number>();
  for (const response of acceptedResponsesAt(cursors, stepId)) {
    if (response.choice === undefined || !eligible.includes(response.choice)) continue;
    counts.set(response.choice, (counts.get(response.choice) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let winner: string | null = null;
  let best = -1;
  for (const agent of cursors.activeRoster) {
    if (!eligible.includes(agent)) continue;
    const count = counts.get(agent) ?? 0;
    if (count > best) {
      winner = agent;
      best = count;
    }
  }
  return winner;
};

export const deriveDecisionId = (
  kind: "plan-selection" | "implementation-selection" | "consensus",
  inputSetHash: string,
  round?: number | null
): string => (round == null ? `${kind}:${inputSetHash}` : `${kind}:${inputSetHash}:r${round}`);

const lengthPrefixed = (value: string): string => `${Buffer.byteLength(value, "utf8")}:${value}`;

const canonicalDerivedCitation = (citation: DerivedInputCitation): string =>
  [
    citation.kind,
    citation.agent,
    citation.submissionSha,
    citation.path,
    citation.productPin ?? "",
    citation.evidenceCommitSha ?? "",
    citation.actionId ?? ""
  ]
    .map(lengthPrefixed)
    .join("");

/**
 * Hash exactly the policy inputs, not merely the agent-authored artifact set.
 * The decision kind, ordered denominator, consensus round, and sorted exact
 * citations are all length-prefixed so neither delimiters nor roster changes
 * can alias another decision.
 */
export const computeDerivedInputSetHash = (
  kind: "plan-selection" | "implementation-selection" | "consensus",
  activeRoster: readonly string[],
  inputs: readonly DerivedInputCitation[],
  round?: number | null,
  domain?: string
): string => {
  const citations = inputs.map(canonicalDerivedCitation).sort();
  const fields = [
    "coordinator-derived-decision-v1",
    kind,
    ...(domain === undefined ? [] : [domain]),
    round == null ? "" : String(round),
    String(activeRoster.length),
    ...activeRoster,
    String(citations.length),
    ...citations
  ];
  return sha256(fields.map(lengthPrefixed).join(""));
};

const submissionCitation = (submission: AcceptedSubmission, kind: DerivedInputKind): DerivedInputCitation => ({
  kind,
  agent: submission.agent,
  submissionSha: submission.submissionSha,
  path: submission.path,
  ...(submission.productPin === undefined ? {} : { productPin: submission.productPin })
});

const responseCitation = (
  response: AcceptedResponse,
  kind: DerivedInputKind,
  batch: BallotBatch
): DerivedInputCitation => ({
  kind,
  agent: response.agent,
  submissionSha: response.responseSha256,
  path: response.path,
  evidenceCommitSha: batch.commitSha,
  actionId: response.actionId
});

const hasCompleteActiveDenominator = (
  cursors: CursorsState,
  submissions: readonly { agent: string }[]
): boolean =>
  submissions.length === cursors.activeRoster.length &&
  cursors.activeRoster.every((agent) => submissions.some((submission) => submission.agent === agent));

export const computePlanSelectionDerived = (
  cursors: CursorsState,
  now: string,
  supersedes = cursors.derived.planSelection?.decisionId ?? null
): PlanSelectionDerived | null => {
  const plans = acceptedAt(cursors, "R2.plan");
  const planEligible = plans.map((submission) => submission.agent);
  const ballots = acceptedResponsesAt(cursors, "R3.plan-ballot");
  if (!hasCompleteActiveDenominator(cursors, ballots)) return null;
  const batch = publishedBallotBatch(cursors, "R3.plan-ballot", null);
  if (batch === null) return null;
  const winner = deterministicWinner(cursors, "R3.plan-ballot", planEligible);
  if (winner === null) return null;
  const inputs = [
    ...plans.map((submission) => submissionCitation(submission, "plan")),
    ...ballots.map((response) => responseCitation(response, "plan-ballot", batch))
  ];
  const inputSetHash = computeDerivedInputSetHash("plan-selection", cursors.activeRoster, inputs);
  return {
    kind: "plan-selection",
    algorithm: "plurality-active-roster-v1",
    inputSetHash,
    activeRoster: [...cursors.activeRoster],
    inputs,
    decisionId: deriveDecisionId("plan-selection", inputSetHash),
    supersedes,
    decidedAt: now,
    selectedAgents: [winner]
  };
};

export const computeImplementationSelectionDerived = (
  cursors: CursorsState,
  now: string,
  supersedes = cursors.derived.implementationSelection?.decisionId ?? null
): ImplementationSelectionDerived | null => {
  const implementations = acceptedAt(cursors, "R4.implement");
  const implementationEligible = implementations.map((submission) => submission.agent);
  const ballots = acceptedResponsesAt(cursors, "R5.compare-ballot");
  if (!hasCompleteActiveDenominator(cursors, ballots)) return null;
  const batch = publishedBallotBatch(cursors, "R5.compare-ballot", null);
  if (batch === null) return null;
  const winner = deterministicWinner(cursors, "R5.compare-ballot", implementationEligible);
  if (winner === null) return null;
  const implementation = implementations.find((submission) => submission.agent === winner);
  if (implementation?.productPin === undefined) return null;
  const inputs = [
    ...implementations.map((submission) => submissionCitation(submission, "implementation")),
    ...ballots.map((response) => responseCitation(response, "comparison-ballot", batch))
  ];
  const inputSetHash = computeDerivedInputSetHash("implementation-selection", cursors.activeRoster, inputs);
  return {
    kind: "implementation-selection",
    algorithm: "plurality-active-roster-v1",
    inputSetHash,
    activeRoster: [...cursors.activeRoster],
    inputs,
    decisionId: deriveDecisionId("implementation-selection", inputSetHash),
    supersedes,
    decidedAt: now,
    winner,
    implementationPin: implementation.productPin,
    reviser: winner
  };
};

const historicalConsensusBatch = (cursors: CursorsState, round: number): BallotBatch | null => {
  const closed = acceptedResponsesAt(cursors, "R6.ballot", true, round);
  if (!hasCompleteActiveDenominator(cursors, closed)) return null;
  return (
    cursors.ballotBatches.find((batch) => {
      if (batch.kind !== "consensus-ballot-batch" || batch.round !== round || batch.status !== "published") return false;
      if (batch.activeRoster.length <= cursors.activeRoster.length) return false;
      if (!cursors.activeRoster.every((agent) => batch.activeRoster.includes(agent))) return false;
      return cursors.activeRoster.every((agent) => {
        const response = closed.find((candidate) => candidate.agent === agent);
        return (
          response !== undefined &&
          batch.responses.some(
            (entry) =>
              entry.agent === agent &&
              entry.actionId === response.actionId &&
              entry.responseSha256 === response.responseSha256
          )
        );
      });
    }) ?? null
  );
};

const consensusBatchForDerivation = (cursors: CursorsState, round: number): BallotBatch | null =>
  publishedBallotBatch(cursors, "R6.ballot", round) ?? historicalConsensusBatch(cursors, round);

export const computeConsensusDerived = (
  cursors: CursorsState,
  round: number,
  now: string,
  supersedes = cursors.derived.consensus?.decisionId ?? null
): ConsensusDerived | null => {
  const revision = acceptedAt(cursors, "R6.revise", true, round).find(
    (submission) => submission.agent === cursors.derived.implementationSelection?.reviser
  );
  if (revision?.productPin === undefined) return null;
  const ballots = acceptedResponsesAt(cursors, "R6.ballot", true, round);
  if (!hasCompleteActiveDenominator(cursors, ballots)) return null;
  if (ballots.some((ballot) => ballot.disposition !== "approve" && ballot.disposition !== "revise" && ballot.disposition !== "escalate")) {
    return null;
  }
  const allApprove = ballots.every((ballot) => ballot.disposition === "approve");
  if (!allApprove && round !== 3) return null;
  const batch = consensusBatchForDerivation(cursors, round);
  if (batch === null) return null;
  const inputs = [
    submissionCitation(revision, "revision"),
    ...ballots.map((response) => responseCitation(response, "consensus-ballot", batch))
  ];
  if (allApprove) {
    const inputSetHash = computeDerivedInputSetHash("consensus", cursors.activeRoster, inputs, round);
    return {
      kind: "consensus",
      algorithm: "unanimous-active-roster-v1",
      inputSetHash,
      activeRoster: [...cursors.activeRoster],
      inputs,
      decisionId: deriveDecisionId("consensus", inputSetHash, round),
      supersedes,
      decidedAt: now,
      round,
      consensusPin: revision.productPin
    };
  }
  const objectors = cursors.activeRoster.filter((agent) => {
    const ballot = ballots.find((candidate) => candidate.agent === agent);
    return ballot?.disposition === "revise" || ballot?.disposition === "escalate";
  });
  if (objectors.length === 0) return null;
  const inputSetHash = computeDerivedInputSetHash(
    "consensus",
    cursors.activeRoster,
    inputs,
    round,
    "revision-limit-active-roster-v1"
  );
  return {
    kind: "consensus",
    algorithm: "revision-limit-active-roster-v1",
    inputSetHash,
    activeRoster: [...cursors.activeRoster],
    inputs,
    decisionId: deriveDecisionId("consensus", inputSetHash, round),
    supersedes,
    decidedAt: now,
    round: 3,
    consensusPin: revision.productPin,
    objectors
  };
};

type DerivedDecisionRecord = PlanSelectionDerived | ImplementationSelectionDerived | ConsensusDerived;

export const derivedDecisionJournalDetails = (record: DerivedDecisionRecord): Record<string, unknown> => ({
  kind: record.kind,
  decisionId: record.decisionId,
  inputSetHash: record.inputSetHash,
  algorithm: record.algorithm,
  activeRoster: [...record.activeRoster],
  inputs: record.inputs.map((input) => ({ ...input })),
  supersedes: record.supersedes,
  ...(record.kind === "plan-selection"
    ? { selectedAgents: [...record.selectedAgents] }
    : record.kind === "implementation-selection"
      ? {
          winner: record.winner,
          implementationPin: record.implementationPin,
          reviser: record.reviser
        }
      : {
          round: record.round,
          consensusPin: record.consensusPin,
          ...(record.algorithm === "revision-limit-active-roster-v1" ? { objectors: [...record.objectors] } : {})
        })
});

export const deriveBoundInputs = (
  start: StartState,
  cursors: CursorsState,
  stepId: WorkflowStepId,
  round: number | null
): BoundInput[] => {
  if (stepId === "R4.amend-ballot") {
    const pending = cursors.pendingAmendment ?? null;
    return pending === null ? [] : [
      { ...pending.request, kind: "amendment-request" },
      ...pending.plans.map((plan) => ({ ...plan, kind: "selected-plan" })),
      ...amendmentScopeInputs(cursors)
    ];
  }
  if (stepId === "R3.review") return acceptedAt(cursors, "R2.plan").map((value) => inputFromSubmission(value, "plan"));
  if (stepId === "R3.plan-ballot") {
    return [
      ...acceptedAt(cursors, "R2.plan").map((value) => inputFromSubmission(value, "plan")),
      ...acceptedAt(cursors, "R3.review").map((value) => inputFromSubmission(value, "review"))
    ];
  }
  if (stepId === "R4.implement") {
    const selectedAgents =
      cursors.derived.planSelection?.selectedAgents.filter((agent) => cursors.activeRoster.includes(agent)) ?? [];
    const planAgents =
      selectedAgents.length > 0
        ? selectedAgents
        : cursors.activeRoster.length === 1
          ? [...cursors.activeRoster]
          : [];
    return acceptedAt(cursors, "R2.plan")
      .filter((submission) => planAgents.includes(submission.agent))
      .map((value) => inputFromSubmission(value, "selected-plan"));
  }
  if (stepId === "R5.compare" || stepId === "R5.compare-ballot") {
    return acceptedAt(cursors, "R4.implement").map((value) => inputFromSubmission(value, "implementation", true));
  }
  if (stepId === "R6.revise") {
    if ((round ?? 1) > 1) {
      return acceptedAt(cursors, "R6.revise", true, (round ?? 1) - 1).map((value) =>
        inputFromSubmission(value, "prior-revision", true)
      );
    }
    const derived = cursors.derived.implementationSelection;
    const selected = acceptedAt(cursors, "R4.implement").find(
      (value) => value.agent === derived?.winner && value.productPin === derived.implementationPin
    );
    return selected === undefined ? [] : [inputFromSubmission(selected, "implementation", true)];
  }
  if (stepId === "R6.ballot") {
    return acceptedAt(cursors, "R6.revise", true, round).map((value) => inputFromSubmission(value, "revision", true));
  }
  if (stepId === "R6.follow-up") {
    const revision = acceptedAt(cursors, "R6.revise", true, round).find(
      (submission) =>
        submission.agent === cursors.derived.implementationSelection?.reviser && submission.productPin !== undefined
    );
    if (revision === undefined) return [];
    const batch = consensusBatchForDerivation(cursors, round ?? 3);
    const ballots = acceptedResponsesAt(cursors, "R6.ballot", true, round);
    const evidence =
      batch === null
        ? []
        : ballots.flatMap((response) => {
            const index = batch.responses.findIndex(
              (entry) =>
                entry.agent === response.agent &&
                entry.actionId === response.actionId &&
                entry.responseSha256 === response.responseSha256
            );
            const path = index < 0 ? undefined : batch.paths[index];
            if (path === undefined) return [];
            return [{ agent: response.agent, commitSha: batch.commitSha, path, kind: "consensus-ballot" }];
          });
    return [inputFromSubmission(revision, "revision", true), ...evidence];
  }
  if (stepId === "R7.finalize") {
    const consensus = cursors.derived.consensus;
    if (consensus !== null) {
      const revisionCitation = consensus.inputs.find((input) => input.kind === "revision");
      const revision = acceptedAt(cursors, "R6.revise", false, consensus.round).find(
        (submission) =>
          submission.submissionSha === revisionCitation?.submissionSha &&
          submission.productPin === consensus.consensusPin
      );
      return revision === undefined ? [] : [inputFromSubmission(revision, "consensus", true)];
    }
    const implementation = cursors.derived.implementationSelection;
    const selectedPlanAgent = cursors.derived.planSelection?.selectedAgents[0];
    const fallbackAgent = cursors.activeRoster.length === 1 ? cursors.activeRoster[0] : undefined;
    const winner = implementation?.winner ?? selectedPlanAgent ?? fallbackAgent;
    const accepted = acceptedAt(cursors, "R4.implement").find(
      (submission) =>
        submission.agent === winner &&
        (implementation === null || submission.productPin === implementation.implementationPin)
    );
    return accepted === undefined ? [] : [inputFromSubmission(accepted, "consensus", true)];
  }
  return [];
};

const selectedPlanAgents = (cursors: CursorsState): string[] => {
  const selected =
    cursors.derived.planSelection?.selectedAgents.filter((agent) => cursors.activeRoster.includes(agent)) ?? [];
  return selected.length > 0 ? selected : cursors.activeRoster.length === 1 ? [...cursors.activeRoster] : [];
};

export const selectedPlanInputs = (cursors: CursorsState): BoundInput[] =>
  acceptedAt(cursors, "R2.plan").filter((plan) => selectedPlanAgents(cursors).includes(plan.agent))
    .map((plan) => inputFromSubmission(plan, "selected-plan"));

const approvedAmendments = (cursors: CursorsState): NonNullable<CursorsState["amendments"]> => {
  const hash = computeInputSetHash(selectedPlanInputs(cursors));
  return (cursors.amendments ?? []).filter((record) => record.outcome === "approved" && record.evidenceSha !== null &&
    computeInputSetHash(record.plans.map((plan) => ({ ...plan, kind: "selected-plan" }))) === hash);
};

const amendmentPaths = (cursors: CursorsState): string[] =>
  [...new Set(approvedAmendments(cursors).flatMap((record) => record.proposal.additionalPaths.map((entry) => entry.path)))].sort();

const amendmentScopeInputs = (cursors: CursorsState): BoundInput[] => approvedAmendments(cursors).flatMap((record) => [
  { ...record.request, kind: "approved-amendment-request" },
  ...record.ballots.map((ballot) => ({ ...ballot, kind: "amendment-approval" }))
]);

const scopeHashFor = (cursors: CursorsState, paths: readonly string[]): string => sha256(JSON.stringify([
  "approved-scope-v1", computeInputSetHash(selectedPlanInputs(cursors)), [...paths].sort(),
  approvedAmendments(cursors).map((record) => [record.sequence, record.request, record.evidenceSha])
]));

const scopeInputsFor = (cursors: CursorsState, stepId: WorkflowStepId): BoundInput[] =>
  stepId === "R4.implement" || stepId === "R6.revise" ? amendmentScopeInputs(cursors) : [];

const approvedPathsForOrder = (cursors: CursorsState, stepId: WorkflowStepId): string[] => {
  if (stepId !== "R4.implement" && stepId !== "R6.revise") return [];
  const selectedAgents = selectedPlanAgents(cursors);
  return [
    ...new Set(
      acceptedAt(cursors, "R2.plan")
        .filter((submission) => selectedAgents.includes(submission.agent))
        .flatMap((submission) => submission.approvedPaths ?? []).concat(amendmentPaths(cursors))
    )
  ].sort();
};

/**
 * Re-extract the selected plan file map so extractor upgrades apply mid-issue
 * without wiping frozen plan-acceptance paths.
 */
export const resolveApprovedPaths = async (
  mirror: Pick<EvidenceMirror, "readBlob">,
  cursors: CursorsState,
  stepId: WorkflowStepId
): Promise<string[]> => {
  const frozen = approvedPathsForOrder(cursors, stepId);
  if (stepId !== "R4.implement" && stepId !== "R6.revise") return frozen;
  const selectedAgents = selectedPlanAgents(cursors);
  const plans = acceptedAt(cursors, "R2.plan").filter((submission) => selectedAgents.includes(submission.agent));
  if (plans.length === 0) return frozen;
  const paths = new Set<string>();
  for (const plan of plans) {
    const blob = await mirror.readBlob(plan.submissionSha, plan.path);
    if (blob === null) continue;
    for (const path of extractApprovedPaths(blob)) paths.add(path);
  }
  return paths.size > 0 ? [...new Set([...paths, ...amendmentPaths(cursors)])].sort() : frozen;
};

/** Kinds whose bound `commitSha` is a product pin with a diff worth resolving. */
const PINNED_INPUT_KINDS = new Set(["implementation", "revision", "prior-revision"]);

/** Cap on rendered paths per pin; a large diff must not unbound the action. */
export const CHANGE_SCOPE_PATH_LIMIT = 200;

/**
 * Resolve the changed paths of each pinned bound input once, memoised per pin,
 * so four agents comparing the same four pins cost four diffs rather than
 * sixteen. A pin whose diff cannot be read is omitted rather than fatal: the
 * scope is advisory and must never block action preparation.
 */
export const resolveChangeScope = async (
  mirror: Pick<EvidenceMirror, "changedPaths">,
  start: StartState,
  inputs: readonly BoundInput[]
): Promise<ChangeScopeEntry[]> => {
  const pinned = inputs.filter((input) => PINNED_INPUT_KINDS.has(input.kind));
  if (pinned.length === 0) return [];
  // `null` records a pin whose diff could not be read. Caching the failure as
  // well as the success is what makes "one diff per distinct pin" hold on the
  // unreadable path too: without it, four inputs sharing one broken pin cost
  // four failing git invocations per tick instead of one.
  const byPin = new Map<string, readonly string[] | null>();
  const scope: ChangeScopeEntry[] = [];
  for (const input of pinned) {
    let cached = byPin.get(input.commitSha);
    if (cached === undefined) {
      try {
        cached = [...(await mirror.changedPaths(start.baselineSha, input.commitSha))].sort();
      } catch {
        cached = null;
      }
      byPin.set(input.commitSha, cached);
    }
    if (cached === null) continue;
    scope.push({
      agent: input.agent,
      commitSha: input.commitSha,
      paths: cached.slice(0, CHANGE_SCOPE_PATH_LIMIT),
      truncated: cached.length > CHANGE_SCOPE_PATH_LIMIT
    });
  }
  return scope;
};

/** Another live runner holds this input's verification: keep the submission and
 * re-evaluate it on a later tick instead of running the same key unlocked. */
const waitingObservation = (observation: EvidenceObservation, command: string): EvidenceObservation => ({
  ...observation,
  status: "retry",
  outstanding: [`waiting for another coordinator's verification of ${command} for this input; re-evaluating on a later tick`]
});

export const buildOrder = (
  paths: IssueRuntimePaths,
  start: StartState,
  cursors: CursorsState,
  agent: string,
  stepId: WorkflowStepId,
  round: number | null,
  actionId = createActionId(),
  outstanding: readonly string[] = [],
  approvedPathOverride?: readonly string[],
  changeScope: readonly ChangeScopeEntry[] = [],
  materialized?: MaterializedInputs
): InternalOrder => {
  const definition = STEP_DEFINITIONS[stepId];
  // Join requests the initial probe; durable protocol guidance covers restarts
  // and configuration changes without repeating it or changing action digests.
  const runtime = agentRuntimePaths(paths, agent);
  const branch = start.branchTemplate.replaceAll("{issue}", String(start.issue)).replaceAll("{agent}", agent);
  const correction = outstanding.length === 0 ? "" : `\n\nCorrect these outstanding items:\n${outstanding.map((item) => `- ${item}`).join("\n")}`;
  const inputs = deriveBoundInputs(start, cursors, stepId, round);
  const candidateResults = candidateResultsFor(cursors, inputs);
  const planChoices = acceptedAt(cursors, "R2.plan").map((submission) => submission.agent);
  const implementationChoices = acceptedAt(cursors, "R4.implement").map((submission) => submission.agent);
  const approvedPaths =
    approvedPathOverride === undefined ? approvedPathsForOrder(cursors, stepId) : [...approvedPathOverride];
  const isWork = stepId === "R4.implement" || stepId === "R6.revise";
  const scopeHash = isWork ? scopeHashFor(cursors, approvedPaths) : undefined;
  const scopeInputs = scopeInputsFor(cursors, stepId);
  const lastAmendment = cursors.amendments?.at(-1);
  const amendmentNotice = isWork && lastAmendment !== undefined && lastAmendment.outcome !== "approved"
    ? `\n\nThe last amendment was ${lastAmendment.outcome}; it grants no additional paths. Reasons: ${JSON.stringify(lastAmendment.rationale)}` : "";
  const eligibleChoices =
    stepId === "R3.plan-ballot"
      ? planChoices
      : stepId === "R5.compare-ballot"
        ? implementationChoices
        : [];
  const revisionSha = inputs.find((input) => input.kind === "revision")?.commitSha ?? "";
  let concludingIssueUrl = "";
  let concludingIssueNumber = start.issue;
  if (stepId === "R6.follow-up") {
    try {
      const snapshot = readGitHubIssueSnapshot(paths.issueSnapshot);
      concludingIssueUrl = snapshot.url;
      concludingIssueNumber = snapshot.number;
    } catch {
      concludingIssueUrl = "";
    }
  }
  const scaffold = renderArtifactScaffold({
    stepId,
    issue: start.issue,
    issueSessionId: start.issueSessionId,
    agent,
    baselineSha: start.baselineSha,
    automationDigest: start.automationDigest,
    inputs,
    eligibleChoices,
    round,
    approvedPaths,
    actionId,
    scopeHash,
    ...(cursors.derived.consensus === null || stepId !== "R7.finalize"
      ? {}
      : { conclusion: cursors.derived.consensus.algorithm }),
    ...(stepId !== "R6.follow-up"
      ? {}
      : {
          filing: {
            repository: githubRepositoryFromOrigin(start.origin),
            concludingIssueUrl,
            concludingIssueNumber,
            revisionSha,
            filingKey: revisionSha === "" ? "" : followUpFilingKey(start.issueSessionId, agent, revisionSha)
          }
        })
  });
  const binding =
    scaffold === ""
      ? ""
      : definition.submissionMode === "response"
        ? `\n\nBound inputs below are authoritative. Your response JSON must contain only the scaffold fields.`
        : `\n\nUse protocolVersion 1. Bound values below are authoritative; do not invent alternate digests or citations.`;
  return {
    actionId,
    issue: start.issue,
    agent,
    stepId,
    evidenceId: definition.evidenceId,
    submissionMode: definition.submissionMode,
    requiredPath: definition.submissionMode === "git" ? definition.requiredPath(start.issue, agent, round) : "",
    responsePath: definition.submissionMode === "response" ? agentResponsePath(paths, agent, actionId) : null,
    ...(definition.submissionMode === "response"
      ? { publishPath: definition.requiredPath(start.issue, agent, round) }
      : {}),
    completePath: runtime.complete,
    branch,
    round,
    issueSessionId: start.issueSessionId,
    baselineSha: start.baselineSha,
    automationDigest: start.automationDigest,
    task: `${definition.task}${BRANCH_PREPARED_NOTE}${binding}${scaffold}${correction}${amendmentNotice}`,
    inputs,
    approvedPaths,
    scopeHash,
    scopeRequired: isWork && approvedAmendments(cursors).length > 0,
    exactApprovedPaths: isWork ? amendmentPaths(cursors) : [],
    scopeInputs,
    contextPaths: [...start.contextPaths],
    ownerGuidance: ownerGuidanceFor(cursors, stepId, round),
    changeScope,
    ...(materialized === undefined ? {} : { materialized }),
    ...(start.verification?.mode === "coordinator" ? { verificationMode: "coordinator" as const } : {}),
    ...(candidateResults.length === 0 ? {} : { candidateResults }),
    activeRoster: [...cursors.activeRoster],
    eligibleChoices
  };
};

/** Coordinator results already recorded for each bound product pin, so every
 * reader of this action receives the same execution's results. */
const candidateResultsFor = (cursors: CursorsState, inputs: readonly BoundInput[]): CandidateResults[] =>
  cursors.accepted.flatMap((submission) =>
    (submission.stepId === "R4.implement" || submission.stepId === "R6.revise") && submission.checkResults !== undefined &&
    submission.productPin !== undefined && inputs.some((input) => input.commitSha === submission.productPin)
      ? [{ agent: submission.agent, commitSha: submission.productPin, results: submission.checkResults }]
      : []);

/**
 * The operator-facing sentence for each refusal code. Every code in
 * `GateReason`, `PromptBlockedReason`, and `NudgeWaitCode` has an entry, so a
 * journal line always says what was actually observed.
 */
const DEFERRAL_RATIONALE: Readonly<Record<string, string>> = {
  "pane-dead": "the agent terminal is gone; restore it before retrying",
  "owner-typing": "the pane is in copy mode or the owner is typing in it",
  "input-off": "the pane has input disabled",
  "foreground-mismatch": "the foreground process is not this agent's harness",
  "trust-dialog": "the application is waiting for you to answer its folder-trust prompt; inspect its terminal",
  "claude-no-prompt": "no idle prompt is visible in the pane",
  "claude-usage-wait": "Claude is waiting for a usage limit; coordinator input is blocked",
  "cursor-turn-chrome": "the agent is still working; no intervention needed",
  "antigravity-turn-chrome": "the agent is still working; no intervention needed",
  "antigravity-verify-overlay": "the account-verify overlay is up and discards keystrokes",
  "antigravity-no-prompt": "no idle prompt is visible in the pane",
  "codex-turn-chrome": "the agent is still working; no intervention needed",
  "no-idle-sentinel": "coord cannot confirm the agent is ready for input; inspect its terminal, and type there if it is idle",
  "codex-composer-not-ready": "the Codex composer is not empty or no longer holds exactly this action's message",
  "pane-capture-unavailable": "coord cannot read the terminal to check whether input is safe; inspect the agent terminal",
  "lifecycle-changed": "new agent activity or completion interrupted the readiness check; waiting rather than typing",
  "unmatched-action": "activity reports refer to a different task; inspect the agent's current assignment",
  "workflow-complete": "this agent already published its work for this action",
  "pending-input": "the agent has queued input of its own",
  "background-active": "the agent has background work running",
  unknown: "no activity confirmation has arrived yet; normal just after launch, otherwise inspect the agent's trust prompt and hook setup",
  queued: "the agent has accepted work that has not started",
  working: "the agent is working; no intervention needed unless its terminal is visibly idle",
  "idle-transition-already-used": "this task was already sent while the agent was idle; waiting for fresh activity"
};

const deferralRationale = (code: string): string =>
  DEFERRAL_RATIONALE[code] ?? "the terminal or lifecycle layer refused delivery";

// Delivery protection is independent of the wait before checking for lost delivery.
const NUDGE_REPEAT_DELAYS_MS = [60_000, 120_000, 240_000];
const OBSERVATION_INTERVAL_MS = 60_000;
const UNKNOWN_DEFERRAL_LIMIT = 8;
/** A provider deadline authorizes one recheck this long after it, never a resume. */
const DEADLINE_RECHECK_MS = 30_000;
const RESOURCE_RETRY_DELAYS_MS = [300_000, 600_000];
const RESOURCE_MAX_STARTS = 6;

type Hold = CursorsState["holds"][number];
type HoldEnrichment = { evidence: ResourceEvidence; resetsAt: string | null; retryOwner?: Hold["retryOwner"] };

const pollSleep = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const finish = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  };
  const timer = setTimeout(finish, milliseconds);
  signal?.addEventListener("abort", finish, { once: true });
});

export class CoordinatorRunLoop {
  private readonly mirror: BareMirror;
  private readonly tmux: TmuxController | null;
  private readonly processRunner: ProcessRunner;
  private readonly pullRequestOpener: PullRequestOpener;
  private readonly pullRequestMerger: PullRequestMerger;
  private readonly now: () => string;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly actionId: () => string;
  private readonly log: (message: string) => void;
  private readonly verbose: (message: string) => void;
  private readonly lostDeliveryDelayMs: number;
  private readonly codexQuota: CodexQuotaReader;
  /** Last RN/round announced on `log`, so resume and first prepare do not repeat. */
  private loggedPhaseKey: string | null = null;
  /** Local probes are advisory; restarting may probe again without changing workflow state. */
  private readonly paneObservations = new Map<string, { identity: string; nextAt: number; available: boolean }>();
  private readonly ingestVerificationMeasurements = createVerificationIngestor();
  private readonly ownerReminders = new Map<string, { actionId: string; digest: string; sessionId: string | null; sequence: number | undefined }>();
  private readonly receiptMessages = new Map<string, string>();
  private readonly stopWarnings = new Map<string, string>();
  private startupReported = false;

  /** Capture menu identities now, not after the owner selects a possibly stale row. */
  reminders(): readonly { label: string; request(): string }[] {
    const state = readCursorsState(this.paths);
    return state.activeRoster.flatMap((agent) => {
      const cursor = state.agents[agent];
      if (cursor?.actionId == null || cursor.status !== "ordered") return [];
      const path = agentRuntimePaths(this.paths, agent).action;
      if (!existsSync(path)) return [];
      const entry = readAgentLifecycle(this.paths).agents[agent];
      const request = { actionId: cursor.actionId, digest: sha256OfFile(path), sessionId: entry?.sessionId ?? null,
        sequence: entry?.hookReceipt?.sequence };
      return [{ label: agent, request: () => {
        const current = readCursorsState(this.paths);
        if (current.paused || current.completed || current.abandoned) throw new Error("Release pauses/holds before requesting a reminder; completed work cannot be reminded.");
        if (current.agents[agent]?.actionId !== request.actionId || !current.activeRoster.includes(agent)) throw new Error("That task is no longer current; open the reminder menu again.");
        this.ownerReminders.set(agent, request);
        return `Reminder requested for ${agent}; the running coordinator will check readiness, not restart the task.`;
      } }];
    });
  }

  private reportStopWarnings(): void {
    const state = readAgentLifecycle(this.paths);
    for (const agent of readCursorsState(this.paths).activeRoster) {
      const entry = state.agents[agent];
      const warning = entry === undefined ? null : stopObservationWarning(agent, entry);
      const identity = warning === null ? null : `${entry?.sessionId}:${warning}`;
      if (identity !== null && this.stopWarnings.get(agent) !== identity) this.log(`[WARN] ${warning}`);
      if (identity === null) this.stopWarnings.delete(agent);
      else this.stopWarnings.set(agent, identity);
    }
  }

  /** Installation is not runtime trust; this diagnostic never grants delivery authority. */
  async reportStartup(): Promise<void> {
    if (this.startupReported) return;
    const start = readStartState(this.paths);
    const active = readCursorsState(this.paths).activeRoster;
    const lifecycle = readAgentLifecycle(this.paths);
    for (const agent of start.agents.filter((entry) => active.includes(entry.id))) {
      for (const message of inspectStartupAgent(start, agent)) this.log(`[WARN] ${agent.id}: ${message}`);
      const entry = lifecycle.agents[agent.id];
      const coverage = containmentCoverage(entry, containmentPolicy(agent.root, agent.id)?.binding ?? null);
      this.log(`${coverage.hook === "active" && entry?.hookReceipt ? "[OK]" : "[WARN]"} ${agent.id}: ` +
        (coverage.hook === "active" && entry?.hookReceipt ? "current-session hook activity and actual-tool guard refusal observed." :
          `runtime hook trust/activity not yet verified for issue ${start.issue}; inspect the terminal's trust prompt and hook setup, then restart the agent if repaired.`));
    }
    if (this.tmux !== null && typeof this.tmux.issueEnvironmentDiagnostic === "function") this.log(await this.tmux.issueEnvironmentDiagnostic(start.issue));
    if (this.tmux !== null && typeof this.tmux.agentPlacementDiagnostics === "function") {
      for (const line of await this.tmux.agentPlacementDiagnostics(start.issue, start.agents.filter((entry) => active.includes(entry.id)))) this.log(line);
    }
    this.startupReported = true;
  }

  constructor(readonly paths: IssueRuntimePaths, dependencies: RunLoopDependencies = {}) {
    const start = readStartState(paths);
    this.mirror = dependencies.mirror ?? new BareMirror(paths.mirror, start.origin);
    this.tmux = dependencies.tmux === undefined ? new TmuxController(undefined, paths.tmuxNamespace, undefined, undefined, undefined, paths.terminalGroup) : dependencies.tmux;
    this.processRunner = dependencies.processRunner ?? runArgv;
    this.pullRequestOpener = dependencies.pullRequestOpener ?? openDraftPullRequest;
    this.pullRequestMerger = dependencies.pullRequestMerger ?? mergePullRequest;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.sleep = dependencies.sleep ?? pollSleep;
    this.actionId = dependencies.actionId ?? createActionId;
    this.log = dependencies.log ?? ((message) => process.stdout.write(`${message}\n`));
    this.verbose = dependencies.verbose ?? (() => undefined);
    this.lostDeliveryDelayMs = dependencies.nudgeRetryMs ?? AGENT_OBSERVABILITY_WATCHDOG_MS;
    this.codexQuota = dependencies.codexQuota ?? ((input) => readCodexQuota(input));
  }

  async initializeEffects(): Promise<void> {
    const start = readStartState(this.paths);
    const authority = readCursorsState(this.paths);
    this.authority(authority);
    // Resume used to swallow a config read failure to null, and null used to
    // mean "skip the overlay restore entirely". The restore no longer depends on
    // resolving a root — it falls back to the overlay already in the clone — so
    // the remaining job here is to report the failure instead of hiding it.
    //
    // Deliberately not defaulting to this checkout the way `coord start` does:
    // synthesising a root makes the restore render a protocol overlay into
    // clones that were never installed against it, adding an untracked
    // AGENTS.md that an agent's `git add -A` then sweeps into its commit.
    let installRoot: string | null = null;
    if (existsSync(start.configPath)) {
      try {
        installRoot = readConfig(start.configPath).coordination?.installRoot ?? null;
      } catch (error) {
        this.log(
          `could not read ${start.configPath} for the install root ` +
            `(${error instanceof Error ? error.message : String(error)}); ` +
            "restoring the AGENTS.md overlay from each clone's own copy"
        );
      }
    }
    prepareAgentIssueBranches({
      agents: start.agents,
      issue: start.issue,
      branchTemplate: start.branchTemplate,
      baselineSha: start.baselineSha,
      baseBranch: start.baseBranch,
      installRoot,
      log: (message) => this.log(message.trimEnd())
    });
    this.authority(authority);
    await this.mirror.initialize();
    this.authority(authority);
    if (this.tmux !== null) {
      await this.tmux.ensureSession(start.issue, start.agents, () => this.authority(authority));
      this.authority(authority);
      const opened = await this.tmux.openOwnerAgentClients(start.issue, start.agents, { onlyMissing: true });
      this.authority(authority);
      if (opened.status === "opened" && opened.count > 0) {
        this.log(`Opened ${opened.count} Terminal window(s), one per agent tmux client.`);
      } else if (opened.status === "failed") {
        this.log(`Could not open Terminal windows (${opened.error}). Attach manually with coord attach ${start.issue} --coord-runtime ${shellQuote(start.coordRoot)}.`);
      }
    }
  }

  private authority(cursors: CursorsState, allowCompleted = false): CursorsState {
    const current = readCursorsState(this.paths);
    if (current.stateRevision !== cursors.stateRevision) {
      throw new StateConflictError("Coordinator authority changed during an effect.");
    }
    if (current.paused || current.abandoned || (!allowCompleted && current.completed)) {
      throw new StateConflictError("Coordinator authority no longer permits this effect.");
    }
    return current;
  }

  private mutate(
    cursors: CursorsState,
    mutation: (current: CursorsState) => CursorsState
  ): CursorsState {
    return requireStateMutation(this.paths, cursors.stateRevision, mutation);
  }

  private ensureActionSafety(cursors: CursorsState, agent: string, actionId: string): CursorsState {
    if (cursors.actionSafety[agent]?.actionId === actionId) return cursors;
    return this.mutate(cursors, (current) => ({ ...current, actionSafety: {
      ...current.actionSafety, [agent]: {
        actionId, sends: 0, lastSendAt: null, reserved: false, deferrals: [], holdGeneration: 0,
        observationChecks: 0, nextObservationAt: null, activityAt: this.now(), resource: emptyResourceObservation()
      }
    } }));
  }

  private hold(
    cursors: CursorsState, agent: string, reason: Hold["reason"], evidenceId: string, enrichment?: HoldEnrichment
  ): CursorsState {
    const safety = cursors.actionSafety[agent]!;
    evidenceId = `${reason}:${safety.holdGeneration}:${evidenceId}`;
    if (cursors.holds.some((hold) => hold.evidenceId === evidenceId)) return cursors;
    const now = this.now();
    let created: Hold | null = null;
    const next = this.mutate(cursors, (current) => {
      const result = this.holdMutation(readStartState(this.paths), current, agent, reason, evidenceId, enrichment, now);
      created = result.hold;
      return result.state;
    });
    const hold = created as Hold | null;
    if (hold !== null) {
      const cause = hold.evidence === null ? "cause/reset unknown" :
        `${hold.evidence.failureClass}; reset ${hold.resetsAt ?? "unknown"}`;
      this.verbose(`Hold diagnostic: ${reason}; ${cause}`);
      this.log(`[ACTION] Issue ${this.paths.issue}: ${agent}: ${holdDescription(reason)}. ` +
        `Inspect the agent, then ${holdRecoveryCommand(this.paths.issue, next, hold, this.paths.coordRoot)}; add --run only if the coordinator was stopped.`);
    }
    return next;
  }

  /**
   * One hold transition for use inside a single state mutation. A new hold for
   * an owner-bound Codex agent is also the watchdog trigger for one quota read.
   */
  private holdMutation(
    start: StartState, current: CursorsState, agent: string, reason: Hold["reason"], evidenceId: string,
    enrichment: HoldEnrichment | undefined, now: string
  ): { state: CursorsState; hold: Hold | null } {
    const safety = current.actionSafety[agent]!;
    if (current.holds.some((hold) => hold.evidenceId === evidenceId)) return { state: current, hold: null };
    let hold: Hold = {
      id: randomUUID(), agent, actionId: safety.actionId,
      sessionId: readAgentLifecycle(this.paths).agents[agent]?.sessionId ?? null,
      reason, evidenceId, observedAt: now,
      resetsAt: enrichment?.resetsAt ?? null, confidence: enrichment?.resetsAt ? "exact" : "unknown",
      retryOwner: enrichment?.retryOwner ?? (reason === "vendor-wait" ? "vendor" : "owner"),
      evidence: enrichment?.evidence ?? null
    };
    const event = appendJournal(this.paths, { type: "hold-created", agent, actionId: safety.actionId,
      details: { ...hold, eventId: `hold:${evidenceId}` } }, now);
    // Recover the same hold if the append survived but cursor replacement did not.
    hold = { ...hold, id: String(event.details.id), observedAt: event.at };
    if (!current.paused) appendJournal(this.paths, { type: "paused", details: { hold: hold.id, eventId: `pause:${hold.id}` } }, now);
    const bound = start.agents.find((candidate) => candidate.id === agent)?.codexQuota !== undefined;
    const resource = safety.resource;
    const trigger = bound && reason !== "vendor-failure" && resource.terminal === null && resource.nextAt === null;
    return {
      hold,
      state: {
        ...current, paused: true, holds: [...current.holds, hold], updatedAt: now,
        actionSafety: trigger
          ? { ...current.actionSafety, [agent]: { ...safety, resource: { ...resource, nextAt: now } } }
          : current.actionSafety
      }
    };
  }

  /** Update one resource hold's evidence on a meaningful transition only. */
  private enrichMutation(current: CursorsState, holdId: string, enrichment: HoldEnrichment, now: string): CursorsState {
    const hold = current.holds.find((entry) => entry.id === holdId);
    if (hold === undefined) return current;
    const next: Hold = {
      ...hold, evidence: enrichment.evidence, resetsAt: enrichment.resetsAt,
      confidence: enrichment.resetsAt === null ? "unknown" : "exact",
      retryOwner: enrichment.retryOwner ?? hold.retryOwner
    };
    const identity = (value: Hold) => JSON.stringify([value.evidence?.failureClass, value.evidence?.windows, value.resetsAt, value.retryOwner]);
    if (identity(next) === identity(hold) && hold.evidence?.episodeId === next.evidence?.episodeId) return current;
    appendJournal(this.paths, { type: "hold-updated", agent: hold.agent, actionId: hold.actionId, details: {
      hold: hold.id, failureClass: next.evidence?.failureClass, confidence: next.confidence, resetsAt: next.resetsAt,
      retryOwner: next.retryOwner, eventId: `hold-update:${hold.id}:${sha256(identity(next))}`
    } }, now);
    return { ...current, holds: current.holds.map((entry) => (entry.id === holdId ? next : entry)), updatedAt: now };
  }

  private observationEvidence(agent: string, actionId: string): string {
    const entry = readAgentLifecycle(this.paths).agents[agent];
    return `${actionId}:observation:${entry?.sessionId ?? "none"}:${entry?.lastEventAt ?? "none"}`;
  }

  /** A receipt proves only readiness for a never-sent action, never completion. */
  private readyForNextAction(
    cursors: CursorsState, agent: string, actionId: string, actionDigest: string, entry: AgentLifecycleEntry | undefined
  ): ReadyReceipt | null {
    const safety = cursors.actionSafety[agent];
    if (safety?.actionId !== actionId || safety.sends !== 0 || safety.reserved || entry === undefined ||
      entry.action?.actionId !== actionId || entry.action.actionDigest !== actionDigest ||
      entry.action.delivery !== "ordered" || entry.action.injectedAt !== null || entry.action.workflowCompleteAt !== null ||
      entry.execution === "queued" || (entry.backgroundActive === true && !hasStopReadiness(entry)) || (entry.pendingInputCount ?? 0) > 0) return null;
    const receipt = readReady(agentRuntimePaths(this.paths, agent).ready, this.paths.completesRoot);
    if (receipt === null || receipt.actionId !== cursors.agents[agent]?.lastAcceptedActionId || receipt.actionId === actionId) return null;
    const lastHook = Math.max(Date.parse(entry.hookReceipt?.at ?? "") || 0, Date.parse(entry.lastEventAt ?? "") || 0);
    // Hook timestamps have millisecond precision; do not infer ordering within
    // that millisecond from the filesystem's finer-grained timestamp.
    const writtenAt = Math.floor(receipt.mtimeMs);
    return writtenAt > lastHook && writtenAt <= Date.parse(this.now()) ? receipt : null;
  }

  /** One reservation path for initial, idle, reissue and lost-delivery sends. */
  private async deliver(
    start: StartState, cursors: CursorsState, agent: string, actionId: string, actionDigest: string,
    reason: "initial" | "idle" | "reissue" | "owner"
  ): Promise<CursorsState> {
    const config = start.agents.find((candidate) => candidate.id === agent);
    if (this.tmux === null || config === undefined || !["nudge", "both"].includes(config.delivery)) return cursors;
    cursors = this.ensureActionSafety(cursors, agent, actionId);
    const safety = cursors.actionSafety[agent]!;
    if (safety.reserved) return this.hold(cursors, agent, "delivery-uncertain", `${actionId}:uncertain:${safety.sends}`);
    // A current Stop permits queued delivery even while background tasks remain.
    const entry = readAgentLifecycle(this.paths).agents[agent];
    const receipt = this.readyForNextAction(cursors, agent, actionId, actionDigest, entry);
    // Before the first send there is nothing to duplicate, so a `working`
    // record left by a Stop that never reached this issue may be overruled —
    // but only with current file or terminal idle proof.
    const staleWorking = entry?.execution === "working" && safety.sends === 0 &&
      entry.action?.actionId === actionId && entry.action.actionDigest === actionDigest &&
      entry.action.delivery === "ordered" && entry.action.injectedAt === null;
    const owner = reason === "owner";
    if ((entry?.execution === "working" && !staleWorking && !owner) || (owner && entry?.execution === "queued") || (entry?.backgroundActive === true && !hasStopReadiness(entry)) ||
      (entry?.pendingInputCount ?? 0) > 0) return cursors;
    // Lifecycle hooks write without touching cursor authority, so the override
    // re-reads them immediately before the batch (or each AGY key).
    const lifecycleSnapshot = (value: typeof entry): string => JSON.stringify([value?.sessionId, value?.turnId,
      value?.lastEventAt, value?.execution, value?.pendingInputCount, value?.backgroundActive, value?.stoppedAt]);
    const observed = lifecycleSnapshot(entry);
    const hookSequence = entry?.hookReceipt?.sequence;
    const staleOverride: IdleOverride | undefined = hasStopReadiness(entry) || receipt !== null || staleWorking || owner ? {
      source: hasStopReadiness(entry) ? "stop-hook" : receipt !== null ? "ready-file" : "idle-sentinel",
      lifecycle: () => {
        const latest = readAgentLifecycle(this.paths).agents[agent];
        if (latest?.action?.actionId === actionId && latest.action.actionDigest === actionDigest &&
          latest.action.delivery === "accepted" && latest.hookReceipt?.sequence !== hookSequence &&
            (latest.action.acceptedAt !== entry?.action?.acceptedAt || latest.action.turnId !== entry?.action?.turnId)) return "accepted";
        if (owner && (latest?.hookReceipt?.sequence !== hookSequence ||
          readCompletion(agentRuntimePaths(this.paths, agent).complete).status !== "missing")) return "changed";
        if (receipt !== null && (latest?.hookReceipt?.sequence !== hookSequence ||
          readReady(agentRuntimePaths(this.paths, agent).ready, this.paths.completesRoot)?.identity !== receipt.identity)) return "changed";
        return lifecycleSnapshot(latest) === observed ? "unchanged" : "changed";
      }
    } : undefined;
    if (safety.sends >= 4) return this.hold(cursors, agent, "nudge-loop", `${actionId}:budget:${safety.lastSendAt}`);
    const delay = NUDGE_REPEAT_DELAYS_MS[safety.sends - 1] ?? 0;
    if (safety.lastSendAt !== null && Date.parse(this.now()) - Date.parse(safety.lastSendAt) < delay) return cursors;
    let sentAt = this.now();
    const reserve = (): void => {
      this.authority(cursors);
      sentAt = this.now();
      cursors = this.mutate(cursors, (current) => ({ ...current, actionSafety: {
        ...current.actionSafety, [agent]: { ...safety, sends: safety.sends + 1, lastSendAt: sentAt, reserved: true }
      } }));
    };
    // An exception or lost authority after any key is ambiguous: leave the durable charge intact.
    let result;
    try {
      result = await this.tmux.nudge(start.issue, config, agentRuntimePaths(this.paths, agent).action,
        () => {
          this.authority(cursors);
          if (owner && (!existsSync(agentRuntimePaths(this.paths, agent).action) ||
              sha256OfFile(agentRuntimePaths(this.paths, agent).action) !== actionDigest)) {
            throw new StateConflictError("The reminder's task changed during delivery.");
          }
        }, actionId, actionDigest, reserve, staleOverride);
    } catch (error) {
      this.authority(cursors);
      if (error instanceof StateConflictError) throw error;
      cursors = this.reconcileSubmitted(cursors, agent);
      return cursors.actionSafety[agent]?.reserved
        ? this.hold(cursors, agent, "delivery-uncertain", `${actionId}:uncertain:${safety.sends + 1}`) : cursors;
    }
    this.authority(cursors);
    // Native retry ownership remains known even if earlier keys were ambiguous.
    // Leave any reservation charged until explicit owner recovery.
    if (result.status === "busy" && result.reason === "claude-usage-wait") {
      return this.hold(cursors, agent, "vendor-wait", this.observationEvidence(agent, actionId));
    }
    if (result.status !== "sent" && result.stage === "mid-send") {
      cursors = this.reconcileSubmitted(cursors, agent);
      return cursors.actionSafety[agent]?.reserved
        ? this.hold(cursors, agent, "delivery-uncertain", `${actionId}:uncertain:${safety.sends + 1}`) : cursors;
    }
    if (result.status === "sent") {
      if (owner) this.log(`[OK] Reminder sent to ${agent} for its current task.`);
      markActionInjected(this.paths, agent, actionId, actionDigest, sentAt);
      if (receipt !== null) {
        clearReady(agentRuntimePaths(this.paths, agent).ready, this.paths.completesRoot, receipt);
        this.log(`Issue ${start.issue}: ${agent}'s ready file for its last accepted action confirmed readiness; delivered action ${actionId}.`);
      } else if (staleWorking) {
        this.log(
          `Issue ${start.issue}: ${agent}'s lifecycle hooks still report it mid-turn, but its pane shows COORD-IDLE; ` +
            `delivered action ${actionId}. No Stop event from ${agent} reached this issue — ` +
            `check that its hooks run with COORD_ISSUE=${start.issue}.`
        );
      }
      return this.mutate(cursors, (current) => {
        appendJournal(this.paths, { type: "nudged", agent, actionId,
          details: { actionDigest, readiness: result.detail ?? "vendor-prompt", [reason]: true,
            ...(staleOverride !== undefined ? { lifecycleOverride: entry?.execution } : {}) } }, this.now());
        return { ...current, actionSafety: { ...current.actionSafety, [agent]: {
          ...current.actionSafety[agent]!, reserved: false, lastSendAt: this.now()
        } } };
      });
    }
    if (result.status === "gone") return this.hold(cursors, agent, "harness-gone", this.observationEvidence(agent, actionId));
    if (result.status === "busy") {
      if (entry?.action?.retryableInjectionAt === null) markActionInjectionDeferred(this.paths, agent, actionId, actionDigest, this.now());
      return this.journalDeferral(start, cursors, agent, actionId, actionDigest, "scrape", result.reason,
        deferralRationale(result.reason), result.detail);
    }
    return cursors;
  }

  /** A correlated submit callback resolves this attempt, including after a crash or timeout. */
  private reconcileSubmitted(cursors: CursorsState, agent: string): CursorsState {
    const safety = cursors.actionSafety[agent];
    const entry = readAgentLifecycle(this.paths).agents[agent];
    const action = entry?.action;
    if (safety === undefined || !safety.reserved || safety.lastSendAt === null ||
        action?.delivery !== "accepted" || action.actionId !== safety.actionId ||
        cursors.agents[agent]?.actionId !== action.actionId || action.sessionId !== entry?.sessionId ||
        action.acceptedAt === null || Date.parse(action.acceptedAt) < Date.parse(safety.lastSendAt)) return cursors;
    const path = agentRuntimePaths(this.paths, agent).action;
    if (!existsSync(path) || sha256OfFile(path) !== action.actionDigest) return cursors;
    const matched = cursors.holds.filter((hold) => hold.reason === "delivery-uncertain" &&
      hold.agent === agent && hold.actionId === action.actionId &&
      (hold.sessionId === null || hold.sessionId === action.sessionId));
    return this.mutate(cursors, (current) => {
      const holds = current.holds.filter((hold) => !matched.some((match) => match.id === hold.id));
      for (const hold of matched) appendJournal(this.paths, { type: "hold-released", agent, actionId: action.actionId,
        details: { hold: hold.id, automatic: true, reason: "prompt-submitted", eventId: `hold-release:${hold.id}` } }, this.now());
      return { ...current, holds, paused: current.manualPaused || holds.length > 0,
        actionSafety: { ...current.actionSafety, [agent]: { ...current.actionSafety[agent]!, reserved: false } } };
    });
  }

  /** Quiet work is normal. Only explicit pane conditions can hold unfinished work. */
  private async observeUnfinished(start: StartState, cursors: CursorsState, agent: string, actionId: string): Promise<CursorsState> {
    if (this.tmux === null) return cursors;
    const safety = cursors.actionSafety[agent]!;
    if (safety.reserved) return this.hold(cursors, agent, "delivery-uncertain", `${actionId}:uncertain:${safety.sends}`);
    const now = this.now();
    const identity = `${actionId}:${safety.holdGeneration}`;
    const previous = this.paneObservations.get(agent);
    if (previous?.identity === identity && Date.parse(now) < previous.nextAt) return cursors;
    // Schedule before inspection so failed reads also stay bounded.
    const observation = { identity, nextAt: Date.parse(now) + OBSERVATION_INTERVAL_MS, available: false };
    this.paneObservations.set(agent, observation);
    const evidence = this.observationEvidence(agent, actionId);
    const target = this.tmux.target(start.issue, agent);
    const pane = await this.tmux.inspectPane(target).catch((error) => {
      this.verbose(`Issue ${start.issue}: ${agent} pane inspection failed: ${error}`);
      return null;
    });
    this.authority(cursors);
    if (pane === null) return cursors;
    if (!pane.alive) return this.hold(cursors, agent, "harness-gone", evidence);
    if (agent === "claude") {
      const text = await this.tmux.capturePane(target).catch((error) => {
        this.verbose(`Issue ${start.issue}: ${agent} pane capture failed: ${error}`);
        return null;
      });
      this.authority(cursors);
      if (text === null) return cursors;
      const config = start.agents.find((candidate) => candidate.id === agent);
      const readiness = harnessPromptReadiness(text, config?.id ?? agent, actionId);
      if (!readiness.ready && readiness.reason === "claude-usage-wait") return this.hold(cursors, agent, "vendor-wait", evidence);
    }
    observation.available = true;
    return cursors;
  }

  private codexBinding(start: StartState, agent: string): NonNullable<StartState["agents"][number]["codexQuota"]> | undefined {
    return agent === "codex" ? start.agents.find((candidate) => candidate.id === agent)?.codexQuota : undefined;
  }

  private setResource(
    current: CursorsState, agent: string, update: Partial<CursorsState["actionSafety"][string]["resource"]>
  ): CursorsState {
    const safety = current.actionSafety[agent]!;
    return { ...current, actionSafety: { ...current.actionSafety, [agent]: { ...safety, resource: { ...safety.resource, ...update } } } };
  }

  /**
   * Observation-only resource work (#140). It may ingest correlated vendor
   * failure evidence, run one due authorized quota read, and release only a
   * resource hold whose evidence cleared. It never prepares, delivers,
   * accepts, publishes or nudges, so it also runs while the issue is held.
   * A manual pause stops it entirely.
   */
  private async observeResources(start: StartState, cursors: CursorsState, agent: string): Promise<CursorsState> {
    if (cursors.manualPaused) return cursors;
    const safety = cursors.actionSafety[agent];
    if (safety === undefined || cursors.agents[agent]?.actionId !== safety.actionId) return cursors;
    cursors = this.ingestFailure(start, cursors, agent, safety.actionId);
    cursors = this.consumeClaudeDeadline(cursors, agent);
    const binding = this.codexBinding(start, agent);
    if (binding === undefined) return cursors;
    if (cursors.resourceBindingChecks[agent] === undefined) {
      // The initial binding check is one persisted trigger, not a read per restart.
      const now = this.now();
      cursors = this.mutate(cursors, (current) => this.setResource(
        { ...current, resourceBindingChecks: { ...current.resourceBindingChecks, [agent]: now } },
        agent, { nextAt: current.actionSafety[agent]!.resource.nextAt ?? now }
      ));
    }
    return this.observeCodexQuota(start, cursors, agent, binding);
  }

  /** Turn a correlated, current-episode failure into (or onto) a resource hold. */
  private ingestFailure(start: StartState, cursors: CursorsState, agent: string, actionId: string): CursorsState {
    const entry = readAgentLifecycle(this.paths).agents[agent];
    const failure = entry?.lastFailure ?? null;
    if (entry === undefined || failure === null || failure.actionId !== actionId || failure.sessionId !== entry.sessionId) return cursors;
    const episode = failure.evidence.episodeId;
    const safety = cursors.actionSafety[agent]!;
    if (!HOLDING_CLASSES.has(failure.evidence.failureClass) || safety.resource.episode === episode) return cursors;
    const mine = (hold: Hold) => hold.agent === agent && hold.actionId === actionId;
    const existing = cursors.holds.find((hold) => mine(hold) && hold.reason === "vendor-failure");
    // The pane reader's native-wait hold is the only accepted proof of vendor retry ownership.
    const nativeWait = cursors.holds.some((hold) => mine(hold) && hold.reason === "vendor-wait");
    const enrichment: HoldEnrichment = { evidence: failure.evidence, resetsAt: failure.resetsAt, retryOwner: nativeWait ? "vendor" : "owner" };
    const now = this.now();
    let created: Hold | null = null;
    const next = this.mutate(cursors, (current) => {
      let state: CursorsState;
      if (existing !== undefined) state = this.enrichMutation(current, existing.id, enrichment, now);
      else {
        const result = this.holdMutation(start, current, agent, "vendor-failure",
          `vendor-failure:${safety.holdGeneration}:failure:${episode}`, enrichment, now);
        created = result.hold;
        state = result.state;
      }
      return this.setResource(state, agent, { episode });
    });
    const hold = created as Hold | null;
    if (hold !== null) {
      this.log(`[ACTION] Issue ${start.issue}: ${agent}: ${holdDescription("vendor-failure")} (${failure.evidence.failureClass}; provider recheck time ${hold.resetsAt ?? "unknown"}, not guaranteed availability). ` +
        `Inspect the agent, then ${holdRecoveryCommand(this.paths.issue, next, hold, this.paths.coordRoot)}; add --run only if the coordinator was stopped.`);
    }
    return next;
  }

  /**
   * One cached re-evaluation at a Claude provider deadline plus 30 seconds,
   * without a prompt. A render, an omitted expired window or native activity
   * is not a fresh capacity fetch, so the hold stays for owner release.
   */
  private consumeClaudeDeadline(cursors: CursorsState, agent: string): CursorsState {
    const safety = cursors.actionSafety[agent]!;
    const hold = cursors.holds.find((entry) => entry.agent === agent && entry.actionId === safety.actionId &&
      entry.reason === "vendor-failure" && entry.evidence?.vendor === "claude" && entry.resetsAt !== null);
    const deadline = hold?.resetsAt ?? null;
    if (hold === undefined || deadline === null || safety.resource.consumedDeadlines.includes(deadline)) return cursors;
    const now = this.now();
    if (Date.parse(now) < Date.parse(deadline) + DEADLINE_RECHECK_MS) return cursors;
    return this.mutate(cursors, (current) => {
      const resource = current.actionSafety[agent]!.resource;
      appendJournal(this.paths, { type: "hold-updated", agent, actionId: hold.actionId, details: {
        hold: hold.id, deadline, outcome: "owner-release-required", eventId: `deadline:${hold.id}:${deadline}`
      } }, now);
      return this.setResource(current, agent, {
        consumedDeadlines: [...resource.consumedDeadlines, deadline].slice(-16),
        terminal: resource.terminal ?? "Claude capacity cannot be proven without a prompt"
      });
    });
  }

  /**
   * At most one bounded Codex App Server read when a persisted trigger is due.
   * The start is reserved durably, under the binding exclusion, before spawn;
   * the result applies only under the latest revision.
   */
  private async observeCodexQuota(
    start: StartState, cursors: CursorsState, agent: string, binding: NonNullable<StartState["agents"][number]["codexQuota"]>
  ): Promise<CursorsState> {
    let resource = cursors.actionSafety[agent]!.resource;
    const now = this.now();
    if (resource.terminal !== null || resource.nextAt === null || Date.parse(now) < Date.parse(resource.nextAt)) return cursors;
    const actionId = cursors.actionSafety[agent]!.actionId;
    const bindingPaths = resourceBindingPaths(this.paths.coordRoot, binding.codexHome, binding.accountId);
    const terminate = (state: CursorsState, reason: string): CursorsState => this.mutate(state, (current) => {
      appendJournal(this.paths, { type: "resource-observation", agent, actionId,
        details: { outcome: "owner-required", reason, eventId: `resource-terminal:${actionId}` } }, now);
      return this.setResource(current, agent, { terminal: reason, nextAt: null, inFlight: null });
    });
    if (resource.inFlight !== null) {
      const record = readBindingRecord(bindingPaths);
      if (record === null || record.inFlight?.reservation === resource.inFlight) {
        return terminate(cursors, "a quota helper from an earlier run was never proved reaped");
      }
      // The binding never recorded this reservation, so no helper started; the start stays spent.
      cursors = this.mutate(cursors, (current) => this.setResource(current, agent, { inFlight: null }));
      resource = cursors.actionSafety[agent]!.resource;
    }
    if (resource.starts >= RESOURCE_MAX_STARTS) return terminate(cursors, "the quota observation budget for this action is spent");
    const reservation = randomUUID();
    const lifecycle = readAgentLifecycle(this.paths);
    const session = lifecycle.agents[agent]?.sessionId ?? null;
    let reserved: CursorsState | null = null;
    const outcome = reserveBinding(this.paths.coordRoot, bindingPaths,
      { reservation, issue: this.paths.issue, agent, startedAt: now },
      () => {
        reserved = this.mutate(cursors, (current) =>
          this.setResource(current, agent, { starts: resource.starts + 1, inFlight: reservation, nextAt: null }));
      });
    if (outcome.status === "unknown") return terminate(cursors, "the quota binding record is unreadable");
    if (outcome.status === "busy") {
      // Coalesced with another reader of the same binding; nothing was spent.
      return resource.nextAt === outcome.retryAt ? cursors : this.mutate(cursors, (current) =>
        this.setResource(current, agent, { nextAt: outcome.retryAt }));
    }
    cursors = reserved!;
    const result = await this.codexQuota({ codexHome: binding.codexHome });
    if (result.reaped) finishBinding(this.paths.coordRoot, bindingPaths, reservation);
    // A pause, action change or retirement during the read invalidates any decision made before it.
    const latest = readCursorsState(this.paths);
    const safety = latest.actionSafety[agent];
    if (latest.abandoned || latest.completed || safety?.actionId !== actionId ||
      latest.agents[agent]?.actionId !== actionId || safety.resource.inFlight !== reservation) return latest;
    // So do a rebinding and any lifecycle change for the agent (session, turn, stop). The lifecycle
    // lock is held from that check through the cursor mutation, so no hook event can land in between.
    let applied = latest;
    mutateAgentLifecycle(this.paths, (lifecycleAfter) => {
      const stale = lifecycleAfter.stateRevision !== lifecycle.stateRevision ||
        (lifecycleAfter.agents[agent]?.sessionId ?? null) !== session ||
        JSON.stringify(this.codexBinding(readStartState(this.paths), agent)) !== JSON.stringify(binding);
      const later = this.now();
      applied = this.mutate(latest, (current) =>
        this.applyCodexResult(start, current, agent, binding.accountId, binding.validatedVersion, result, stale, later));
      return lifecycleAfter;
    });
    return applied;
  }

  private applyCodexResult(
    start: StartState, current: CursorsState, agent: string, accountId: string, validatedVersion: string | undefined,
    result: Awaited<ReturnType<CodexQuotaReader>>, stale: boolean, now: string
  ): CursorsState {
    const safety = current.actionSafety[agent]!;
    const actionId = safety.actionId;
    const base = safety.resource;
    let resource: Partial<typeof base> = { inFlight: null };
    let state = current;
    const terminal = (reason: string): void => {
      appendJournal(this.paths, { type: "resource-observation", agent, actionId,
        details: { outcome: "owner-required", reason, eventId: `resource-terminal:${actionId}` } }, now);
      resource = { ...resource, terminal: reason, nextAt: null };
    };
    const existing = state.holds.find((hold) => hold.agent === agent && hold.actionId === actionId && hold.reason === "vendor-failure");
    const holdOn = (evidence: ResourceEvidence, resetsAt: string | null): void => {
      state = existing !== undefined
        ? this.enrichMutation(state, existing.id, { evidence, resetsAt }, now)
        : this.holdMutation(start, state, agent, "vendor-failure",
          `vendor-failure:${safety.holdGeneration}:codex:${actionId}`, { evidence, resetsAt }, now).state;
    };
    const evidence = (failureClass: ResourceEvidence["failureClass"], windows: ResourceEvidence["windows"], detail: string | null): ResourceEvidence =>
      ({ vendor: "codex", failureClass, classConfidence: failureClass === "auth-account" ? "reported" : "confirmed",
        windows, detail, episodeId: `${actionId}:codex`, observedAt: now });

    if (!result.reaped) terminal("the quota helper was not proved reaped");
    else if (result.status === "failed") {
      const failures = base.failures + 1;
      resource = { ...resource, failures: Math.min(failures, 3) };
      const delay = RESOURCE_RETRY_DELAYS_MS[failures - 1];
      if (delay === undefined) terminal("three quota reads failed");
      else resource = { ...resource, nextAt: new Date(Date.parse(now) + delay).toISOString() };
    } else if (stale) {
      // The snapshot predates the change: it can neither hold nor release. Retry under the binding spacing.
      resource = { ...resource, nextAt: now };
    } else if (result.status === "identity" || result.limits.accountId !== accountId) {
      // Never infer identity from another field or the coordinator's own default account.
      const detail = result.status === "identity" ? "the bound CODEX_HOME has no ChatGPT account"
        : result.limits.accountId === null ? "the limits carried no account id" : "the limits belong to a different account";
      holdOn(evidence("auth-account", [], detail), null);
      terminal("the bound Codex account could not be confirmed");
    } else {
      // Only an owner-validated CLI version, answering for the bound home, may release automatically.
      const validated = validatedVersion !== undefined && result.helper.codexHome !== null &&
        codexHelperVersion(result.helper.userAgent) === validatedVersion;
      const assessment = assessCodexLimits(result.limits, now);
      if (assessment.status === "exhausted") {
        const classification = assessment.classification;
        // Every unresolved earlier blocker stays; a partial snapshot never narrows the set.
        const prior = existing?.evidence?.vendor === "codex" ? existing.evidence.windows : [];
        const blockers = classification.failureClass === "usage-window"
          ? mergeCodexBlockers(prior, result.limits, classification.windows) : classification.windows;
        const overflow = blockers.length > RESOURCE_WINDOW_LIMIT;
        const deadline = classification.failureClass === "usage-window" && !overflow ? latestDeadline(blockers, now) : null;
        holdOn(evidence(classification.failureClass, blockers.slice(0, RESOURCE_WINDOW_LIMIT), null), deadline);
        if (overflow) terminal("more blocked windows than can be tracked");
        else if (deadline !== null && !base.consumedDeadlines.includes(deadline)) {
          // Consumed when scheduled: each epoch authorizes exactly one recheck.
          resource = { ...resource, nextAt: new Date(Date.parse(deadline) + DEADLINE_RECHECK_MS).toISOString(),
            consumedDeadlines: [...base.consumedDeadlines, deadline].slice(-16) };
        } else terminal(deadline === null ? "no exact provider deadline" : "the provider deadline did not advance");
      } else if (existing !== undefined && state.manualPaused) {
        terminal("a manual pause arrived during the quota read");
      } else if (existing !== undefined && !validated) {
        terminal("automatic recovery is not validated for this Codex installation");
      } else if (existing !== undefined) {
        const cleared = existing.evidence?.vendor === "codex" &&
          existing.evidence.failureClass === "usage-window" && codexClearsBlockers(result.limits, existing.evidence.windows, now);
        if (cleared) {
          appendJournal(this.paths, { type: "hold-released", agent, actionId, details: {
            hold: existing.id, automatic: true, eventId: `hold-release:${existing.id}`
          } }, now);
          state = releaseResourceHold(state, existing.id, now);
        } else terminal("fresh limits did not affirmatively clear every blocked window");
      }
      // A clear read with no resource hold records nothing: zero credits with ordinary usage allowed is not a hold.
    }
    return this.setResource(state, agent, resource);
  }

  private logPhase(
    issue: number,
    stepId: WorkflowStepId | null,
    round: number | null,
    from?: WorkflowStepId
  ): void {
    const key = `${stepId ?? "complete"}:${round ?? ""}`;
    if (from === undefined && this.loggedPhaseKey === key) return;
    this.loggedPhaseKey = key;
    const to = describeWorkflowStep(stepId, round);
    this.log(from === undefined ? `Issue ${issue}: ${to}` : `Issue ${issue}: ${from} → ${to}`);
  }

  /**
   * Drop worktrees the current bound set no longer needs.
   *
   * Kept non-fatal: a worktree that cannot be unregistered is wasted disk, and
   * failing action preparation over it would stall an issue for a reason no
   * agent can act on. Wipe re-runs the same cleanup.
   */
  private async pruneMaterializedWorktrees(
    cursors: CursorsState,
    boundInputs: readonly BoundInput[]
  ): Promise<void> {
    try {
      const removed = await pruneSupersededWorktrees({
        mirror: this.mirror,
        paths: this.paths,
        keep: worktreeLabelsFor(this.paths, boundInputs)
      });
      for (const target of removed) this.verbose(`pruned superseded worktree ${target}`);
    } catch (error) {
      this.verbose(`could not prune superseded worktrees: ${(error as Error).message}`);
    }
    this.authority(cursors);
  }

  private async prepareAction(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    stepId: WorkflowStepId,
    round: number | null
  ): Promise<CursorsState> {
    const cursor = cursors.agents[agent];
    if (cursor === undefined) throw new Error(`Unknown agent ${agent}.`);
    const approvedPaths = await resolveApprovedPaths(this.mirror, cursors, stepId);
    const boundInputs = deriveBoundInputs(start, cursors, stepId, round);
    const changeScope = await resolveChangeScope(this.mirror, start, boundInputs);
    // Export the bound artifacts before the action naming them is published, so
    // an agent that reads the action the instant it lands finds every listed
    // path already there.
    const materialized = await materializeBoundInputs({
      mirror: this.mirror,
      paths: this.paths,
      inputs: [...boundInputs, ...scopeInputsFor(cursors, stepId)]
    });
    for (const omission of materialized.omitted) {
      this.log(`Issue ${start.issue}: could not materialize ${omission}; the action still cites the pin`);
    }
    await this.pruneMaterializedWorktrees(cursors, boundInputs);
    this.authority(cursors);
    const order = buildOrder(
      this.paths,
      start,
      cursors,
      agent,
      stepId,
      round,
      this.actionId(),
      [],
      approvedPaths,
      changeScope,
      materialized
    );
    const runtime = agentRuntimePaths(this.paths, agent);
    let next = this.mutate(cursors, (current) => {
      writeAction(this.paths.coordRoot, runtime.action, order);
      const preparedDigest = sha256OfFile(runtime.action);
      appendJournal(
        this.paths,
        {
          type: "action-prepared",
          agent,
          actionId: order.actionId,
          details: {
            requiredPath: order.requiredPath,
            submissionMode: order.submissionMode,
            ...(order.responsePath === null ? {} : { responsePath: order.responsePath }),
            ...(order.publishPath === undefined ? {} : { publishPath: order.publishPath }),
            actionDigest: preparedDigest
          }
        },
        this.now()
      );
      return replaceCursor(
        current,
        agent,
        {
          stepId,
          evidenceId: order.evidenceId,
          actionId: order.actionId,
          submissionMode: order.submissionMode,
          actionDigest: preparedDigest,
          status: "ordered",
          attempt: cursor.attempt + 1,
          submissionSha: null,
          outstanding: []
        },
        this.now()
      );
    });
    const actionDigest = sha256OfFile(runtime.action);
    orderAgentAction(this.paths, agent, order.actionId, actionDigest, this.now());
    next = this.ensureActionSafety(next, agent, order.actionId);
    return this.deliver(start, next, agent, order.actionId, actionDigest, "initial");
  }

  /** Refresh bound paths on an in-flight implement/revise order after extractor upgrades. */
  private async rewriteOrderedAction(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    actionId: string
  ): Promise<CursorsState> {
    const cursor = cursors.agents[agent];
    if (cursor === undefined || cursor.stepId === null) return cursors;
    const runtime = agentRuntimePaths(this.paths, agent);
    if (!existsSync(runtime.action)) return cursors;
    const previous = readAction(runtime.action).body;
    const approvedPaths = await resolveApprovedPaths(this.mirror, cursors, cursor.stepId);
    this.authority(cursors);
    const round = roundForStep(cursor.stepId, cursors.issueCursor.round);
    const boundInputs = deriveBoundInputs(start, cursors, cursor.stepId, round);
    const changeScope = await resolveChangeScope(this.mirror, start, boundInputs);
    const materialized = await materializeBoundInputs({
      mirror: this.mirror,
      paths: this.paths,
      inputs: [...boundInputs, ...scopeInputsFor(cursors, cursor.stepId)]
    });
    const order = buildOrder(
      this.paths,
      start,
      cursors,
      agent,
      cursor.stepId,
      round,
      actionId,
      cursor.outstanding,
      approvedPaths,
      changeScope,
      materialized
    );
    writeAction(this.paths.coordRoot, runtime.action, order);
    if (readAction(runtime.action).body !== previous) {
      this.verbose(`refreshed ${agent} action ${actionId} with current approved paths`);
    }
    return cursors;
  }

  /**
   * Record one delivery refusal with a machine-readable code.
   *
   * Both sides of the disagreement go on a single event: when the pane scrape
   * refuses while hooks say the agent is idle and healthy, `splitBrain` marks
   * it so status and debug do not have to be reconciled across two axes. The
   * line reaches normal stdout when the workflow is actually waiting on this
   * agent or when the two layers disagree. Already-seen codes stay silent in
   * both the journal and stdout, including across restarts.
   */
  private journalDeferral(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    actionId: string,
    actionDigest: string,
    layer: "scrape" | "lifecycle",
    code: string,
    human: string,
    detail?: string
  ): CursorsState {
    cursors = this.ensureActionSafety(cursors, agent, actionId);
    const safety = cursors.actionSafety[agent]!;
    if (safety.deferrals.includes(code)) return cursors;
    const unknown = !Object.hasOwn(DEFERRAL_RATIONALE, code);
    const unknownCount = safety.deferrals.filter((key) => !Object.hasOwn(DEFERRAL_RATIONALE, key)).length;
    // Keep distinct unexpected diagnostics, then emit one explicit overflow row.
    const key = unknown && unknownCount >= UNKNOWN_DEFERRAL_LIMIT ? "unrecognized-overflow" : code;
    if (safety.deferrals.includes(key)) return cursors;
    const entry = readAgentLifecycle(this.paths).agents[agent];
    const splitBrain =
      layer === "scrape" && entry?.execution === "idle" && entry.health !== "degraded";
    // The workflow is blocked on this delivery only while the action is out and
    // unanswered. A deferral for an agent that is verifying or waiting on a peer
    // is background detail, so it belongs in the journal but not on stdout.
    const gateWaiting = cursors.agents[agent]?.status === "ordered";
    const next = this.mutate(cursors, (current) => {
      appendJournal(
        this.paths,
        {
          type: "nudge-deferred",
          agent,
          actionId,
          details: {
            eventId: `deferral:${start.issueSessionId}:${agent}:${actionId}:${key}`,
            layer,
            code,
            ...(key === "unrecognized-overflow" ? { furtherUnknownCodesSuppressed: true } : {}),
            human,
            ...(detail === undefined ? {} : { detail }),
            ...(splitBrain ? { splitBrain: true } : {}),
            gateWaiting,
            actionDigest,
            hooks: {
              execution: entry?.execution ?? "unknown",
              health: entry?.health ?? "unknown",
              pendingInputCount: entry?.pendingInputCount ?? null,
              backgroundActive: entry?.backgroundActive ?? null
            }
          }
        },
        this.now()
      );
      return { ...current, actionSafety: { ...current.actionSafety, [agent]: {
        ...safety, deferrals: [...safety.deferrals, key]
      } } };
    });
    const message = splitBrain
      ? `[WARN] Issue ${start.issue}: ${agent}'s activity report says idle but its terminal refuses input; ${human}`
      : `[WAIT] Issue ${start.issue}: waiting to send to ${agent}; ${human}`;
    this.verbose(`Delivery diagnostic: ${code}${detail === undefined ? "" : ` (${detail})`}`);
    if (gateWaiting || splitBrain) this.log(message);
    else this.verbose(message);
    return next;
  }

  private async maybeLifecycleNudge(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    actionId: string,
    reason: "idle" | "reissue" = "idle"
  ): Promise<CursorsState> {
    const config = start.agents.find((candidate) => candidate.id === agent);
    if (config === undefined) return cursors;
    if (config.delivery !== "nudge" && config.delivery !== "both") return cursors;
    const runtime = agentRuntimePaths(this.paths, agent);
    if (!existsSync(runtime.action)) return cursors;
    // An unavailable observation must not trigger another pane probe through lost-delivery recovery.
    const observation = this.paneObservations.get(agent);
    if (observation?.identity === `${actionId}:${cursors.actionSafety[agent]?.holdGeneration}` &&
      !observation.available && Date.parse(this.now()) < observation.nextAt) return cursors;

    if (reason === "idle") {
      cursors = await this.rewriteOrderedAction(start, cursors, agent, actionId);
    }
    const actionDigest = sha256OfFile(runtime.action);
    orderAgentAction(this.paths, agent, actionId, actionDigest, this.now());

    if (reason === "idle") {
      const entry = readAgentLifecycle(this.paths).agents[agent];
      if (entry === undefined) return cursors;
      // An action that is still only ordered has never been sent. Retrying a
      // prior busy readiness rejection cannot create a duplicate; tmux
      // must still positively prove the pane is prompt-ready below. Once a
      // send succeeds, only a lifecycle idle transition can authorize more.
      if (entry.action?.delivery !== "ordered" || entry.action.retryableInjectionAt === null) {
        const decision = decideLifecycleNudge(entry, actionId, actionDigest);
        // A never-sent action against `working` is decided by deliver(), on current idle proof.
        const neverSentWorking = decision.code === "working" &&
          entry.action?.delivery === "ordered" && entry.action.injectedAt === null;
        const fileReady = this.readyForNextAction(cursors, agent, actionId, actionDigest, entry) !== null;
        if (decision.kind === "wait" && !neverSentWorking && !fileReady) {
          const injected = entry.action;
          const observedAfterInjection =
            injected !== null &&
            injected !== undefined &&
            injected.injectedAt !== null &&
            entry.lastEventAt !== null &&
            Date.parse(entry.lastEventAt) >= Date.parse(injected.injectedAt);
          const tmux = this.tmux;
          // A send that was never accepted and whose delivery delay has elapsed can be
          // retried, but only on the positive scrape proof below. Elapsed time
          // and a missing `complete` never authorize a retry on their own.
          const deliveryDelayElapsed =
            injected !== null &&
            injected !== undefined &&
            injected.injectedAt !== null &&
            Date.parse(this.now()) - Date.parse(injected.injectedAt) >= this.lostDeliveryDelayMs;
          const canProveLostInjection =
            tmux !== null &&
            injected?.delivery === "injected" &&
            injected.turnId === null &&
            (entry.pendingInputCount ?? 0) === 0 &&
            entry.backgroundActive !== true &&
            ((entry.execution === "queued" && observedAfterInjection) ||
              (entry.execution === "unknown" && deliveryDelayElapsed && !observedAfterInjection) ||
              (entry.execution === "idle" &&
                decision.code === "idle-transition-already-used" &&
                deliveryDelayElapsed));
          if (
            !canProveLostInjection ||
            tmux === null ||
            !(await tmux.actionAbsentAtReadyPrompt(start.issue, config, actionId, () => this.authority(cursors)))
          ) {
            return this.journalDeferral(
              start,
              cursors,
              agent,
              actionId,
              actionDigest,
              "lifecycle",
              decision.code,
              deferralRationale(decision.code)
            );
          }
          this.authority(cursors);
          markInjectedActionAbsent(this.paths, agent, actionId, actionDigest, this.now());
          appendJournal(
            this.paths,
            {
              type: "agent-lifecycle",
              agent,
              actionId,
              details: { actionDigest, event: "prompt-ready-action-absent", execution: entry.execution }
            },
            this.now()
          );
          this.verbose(`retrying ${agent}: ready prompt no longer contains action ${actionId}`);
        }
      }
    }

    return this.deliver(start, cursors, agent, actionId, actionDigest, reason);
  }

  private accept(start: StartState, cursors: CursorsState, decision: Extract<MachineDecision, { type: "accept-submission" }>): CursorsState {
    const cursor = cursors.agents[decision.agent];
    if (cursor === undefined || cursor.stepId === null || cursor.actionId === null) return cursors;
    const round = roundForStep(cursor.stepId, cursors.issueCursor.round);
    const path = STEP_DEFINITIONS[cursor.stepId].requiredPath(start.issue, decision.agent, round);
    if (cursor.stepId === "R1.join") {
      const clone = start.agents.find((agent) => agent.id === decision.agent)?.root;
      const policy = clone === undefined ? null : containmentPolicy(clone, decision.agent);
      const coverage = containmentCoverage(readAgentLifecycle(this.paths).agents[decision.agent], policy?.binding ?? null);
      appendJournal(this.paths, { type: "agent-lifecycle", agent: decision.agent, actionId: cursor.actionId,
        details: { kind: "containment-coverage", ...coverage, eventId: `containment-join:${cursor.actionId}` } }, this.now());
      if (coverage.hook !== "active") this.log(`WARNING: ${decision.agent} containment hook=${coverage.hook} shim=${coverage.shim}. ` +
        (coverage.shim !== "active" ? "No verified containment layer. " : "Only PATH shim coverage observed. ") +
        "Check native hook support/trust and run the probes in the actual harness shell tool.\n");
    }
    const accepted: AcceptedSubmission = {
      stepId: cursor.stepId,
      agent: decision.agent,
      round,
      submissionSha: decision.submissionSha,
      path,
      acceptedAt: this.now(),
      ...(decision.productPin === undefined ? {} : { productPin: decision.productPin }),
      ...(decision.disposition === undefined ? {} : { disposition: decision.disposition }),
      ...(decision.approvedPaths === undefined ? {} : { approvedPaths: [...decision.approvedPaths] }),
      ...(decision.choice === undefined ? {} : { choice: decision.choice }),
      ...(decision.checkResults === undefined
        ? {}
        : { checkResults: decision.checkResults.map((result) => ({ ...result, argv: [...result.argv] })) }),
      ...(decision.followUpIssueUrl === undefined ? {} : { followUpIssueUrl: decision.followUpIssueUrl }),
      ...(decision.followUpIssueNumber === undefined ? {} : { followUpIssueNumber: decision.followUpIssueNumber })
    };
    const withoutPrior = cursors.accepted.filter(
      (item) => !(item.stepId === accepted.stepId && item.agent === accepted.agent && item.round === accepted.round)
    );
    const next = this.mutate(cursors, (current) => {
      appendJournal(
        this.paths,
        {
          type: "verify-result",
          agent: decision.agent,
          actionId: cursor.actionId as string,
          submissionSha: decision.submissionSha,
          details: { ok: true }
        },
        this.now()
      );
      const runtime = agentRuntimePaths(this.paths, decision.agent);
      clearCompletion(runtime.complete);
      if (existsSync(runtime.action)) unlinkSync(runtime.action);
      const publication =
        accepted.stepId === "R7.finalize" && accepted.productPin !== undefined
          ? {
              status: "pending" as const,
              finalSha: accepted.productPin,
              branch: `${start.branchTemplate
                .replaceAll("{issue}", String(start.issue))
                .replaceAll("{agent}", decision.agent)}-final`,
              url: null,
              error: null,
              attempts: current.publication.attempts
            }
          : current.publication;
      if (publication.status === "pending") {
        appendJournal(
          this.paths,
          {
            type: "publication-pending",
            agent: decision.agent,
            actionId: cursor.actionId as string,
            details: { finalSha: publication.finalSha, branch: publication.branch }
          },
          this.now()
        );
      }
      return cursorsStateSchema.parse({
        ...current,
        publication,
        agents: {
          ...current.agents,
          [decision.agent]: {
            ...cursor,
            lastAcceptedActionId: cursor.actionId,
            actionId: null,
            submissionMode: null,
            actionDigest: null,
            status: "waiting-peer",
            submissionSha: null,
            outstanding: [],
            updatedAt: this.now()
          }
        },
        accepted: [...withoutPrior, accepted],
        updatedAt: this.now()
      });
    });
    const completion = markActionWorkflowComplete(this.paths, decision.agent, cursor.actionId, this.now());
    this.log(`[OK] ${decision.agent}: submission validated and accepted (commit ${decision.submissionSha.slice(0, 12)}).`);
    this.reportStopWarnings();
    if (completion.clearedDegraded) {
      // The agent published and pushed, so the earlier watchdog warning is
      // disproven. Retract it explicitly rather than leaving it standing.
      appendJournal(
        this.paths,
        {
          type: "agent-observability-recovered",
          agent: decision.agent,
          actionId: cursor.actionId,
          details: { reason: "workflow-complete-after-degraded" }
        },
        this.now()
      );
      this.log(
        `Issue ${start.issue}: ${decision.agent} completed its work; the earlier lifecycle warning is cleared.`
      );
    }
    return next;
  }

  /** Retire runtime orders only; Git work and accepted product pins are untouched. */
  private amendmentTransition(cursors: CursorsState, to: WorkflowStepId, round: number | null): CursorsState {
    const agents = { ...cursors.agents };
    const retirements = [...(cursors.amendmentRetirements ?? [])];
    for (const agent of cursors.activeRoster) {
      const cursor = agents[agent];
      if (cursor === undefined) continue;
      if (cursor.actionId !== null) retirements.push({ agent, actionId: cursor.actionId });
      const accepted = cursors.accepted.some((entry) => entry.agent === agent && entry.stepId === to && entry.round === round);
      agents[agent] = { ...cursor, stepId: to, evidenceId: STEP_DEFINITIONS[to].evidenceId,
        actionId: null, actionDigest: null, submissionMode: null, submissionSha: null,
        status: accepted ? "waiting-peer" : "idle", outstanding: [], updatedAt: this.now() };
    }
    const next = to === "R4.amend-ballot" ? suspendOwnerGuidance(cursors) : resetOwnerGuidance(cursors);
    return cursorsStateSchema.parse({ ...next, agents, amendmentRetirements: retirements,
      issueCursor: { stepId: to, gateId: STEP_DEFINITIONS[to].gateId, round }, updatedAt: this.now() });
  }

  private retireAmendmentActions(cursors: CursorsState): CursorsState {
    if ((cursors.amendmentRetirements ?? []).length === 0) return cursors;
    return this.mutate(cursors, (current) => {
      for (const retired of current.amendmentRetirements ?? []) {
        const cursor = current.agents[retired.agent];
        // A later owner recovery may already have prepared a different order.
        if (cursor?.actionId == null || cursor.actionId === retired.actionId) {
          const runtime = agentRuntimePaths(this.paths, retired.agent);
          clearCompletion(runtime.complete);
          if (existsSync(runtime.action)) unlinkSync(runtime.action);
        }
        clearAgentResponse(agentResponsePath(this.paths, retired.agent, retired.actionId));
      }
      return cursorsStateSchema.parse({ ...current, amendmentRetirements: [] });
    });
  }

  private beginAmendment(cursors: CursorsState, decision: Extract<MachineDecision, { type: "begin-amendment" }>): CursorsState {
    const source = cursors.issueCursor;
    if (cursors.pendingAmendment != null || (source.stepId !== "R4.implement" && source.stepId !== "R6.revise")) return cursors;
    const plans = selectedPlanInputs(cursors).map(({ agent, commitSha, path }) => ({ agent, commitSha, path }));
    if (plans.length === 0) throw new Error("Cannot open an amendment without selected plan evidence.");
    const pending = {
      sequence: (cursors.amendmentSequence ?? 0) + 1,
      request: { agent: decision.agent, commitSha: decision.submissionSha,
        path: STEP_DEFINITIONS[source.stepId].requiredPath(decision.request.issue, decision.agent, source.round) },
      proposal: decision.request, plans, activeRoster: [...cursors.activeRoster],
      resume: { stepId: source.stepId, round: source.round }, requestedAt: this.now()
    };
    const next = this.mutate(cursors, (current) => {
      const event = appendJournal(this.paths, { type: "amendment-requested", agent: decision.agent,
        actionId: decision.request.actionId, submissionSha: decision.submissionSha,
        details: { sequence: pending.sequence, scopeHash: decision.request.scopeHash,
          eventId: `amendment-request:${pending.sequence}:${decision.request.actionId}:${decision.submissionSha}` } }, this.now());
      return this.amendmentTransition(cursorsStateSchema.parse({ ...current,
        agents: { ...current.agents, [decision.agent]: {
          ...current.agents[decision.agent], lastAcceptedActionId: decision.request.actionId
        } },
        pendingAmendment: { ...pending, requestedAt: event.at }, amendmentSequence: pending.sequence }), "R4.amend-ballot", pending.sequence);
    });
    return this.retireAmendmentActions(next);
  }

  private resolveAmendment(cursors: CursorsState, approved: boolean): CursorsState {
    const pending = cursors.pendingAmendment ?? null;
    if (pending === null) return cursors;
    const batch = publishedBallotBatch(cursors, "R4.amend-ballot", pending.sequence);
    if (batch === null) throw new Error("Cannot resolve an amendment without its published ballot batch.");
    const responses = acceptedResponsesAt(cursors, "R4.amend-ballot", true, pending.sequence);
    const unanimous = responses.every((response) => response.disposition === "approve");
    if (approved !== unanimous) throw new Error("Amendment decision does not match the accepted judgments.");
    const record = { ...pending, outcome: approved ? "approved" : "rejected", evidenceSha: batch.commitSha,
      ballots: responses.map((response) => ({ agent: response.agent, commitSha: batch.commitSha, path: response.path })),
      rationale: responses.filter((response) => response.disposition !== "approve")
        .map((response) => `${response.agent}: ${response.rationale}`).join("; "), decidedAt: this.now() };
    const next = this.mutate(cursors, (current) => {
      const event = appendJournal(this.paths, { type: "amendment-decided", details: {
        sequence: pending.sequence, outcome: record.outcome, evidenceSha: batch.commitSha,
        eventId: `amendment-decision:${pending.sequence}:${batch.commitSha}`
      } }, this.now());
      return this.amendmentTransition(cursorsStateSchema.parse({ ...current,
        pendingAmendment: null, amendments: [...(current.amendments ?? []), { ...record, decidedAt: event.at }] }), pending.resume.stepId, pending.resume.round);
    });
    return this.retireAmendmentActions(next);
  }

  private async reissue(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    outstanding: readonly string[]
  ): Promise<CursorsState> {
    const cursor = cursors.agents[agent];
    if (cursor === undefined || cursor.stepId === null || cursor.actionId === null) return cursors;
    this.log(`[WAIT] ${agent}: submission needs correction; preparing its correction instructions (no owner action needed).`);
    const runtime = agentRuntimePaths(this.paths, agent);
    const actionId = cursor.actionId;
    const stepId = cursor.stepId;
    const round = roundForStep(stepId, cursors.issueCursor.round);
    const approvedPaths = await resolveApprovedPaths(this.mirror, cursors, stepId);
    const boundInputs = deriveBoundInputs(start, cursors, stepId, round);
    const changeScope = await resolveChangeScope(this.mirror, start, boundInputs);
    // A reissue is a rewrite of the same action, and it must carry the same
    // materialized paths. Omitting them here was the worst possible place to
    // lose them: the agent is being asked to correct something, and the retry
    // would arrive with `## Bound input files` gone while the shim still
    // refuses the reads it replaced. The packet is content-addressed, so this
    // resolves to the directory already on disk rather than writing anything.
    const materialized = await materializeBoundInputs({
      mirror: this.mirror,
      paths: this.paths,
      inputs: [...boundInputs, ...scopeInputsFor(cursors, stepId)]
    });
    this.authority(cursors);
    const order = buildOrder(
      this.paths,
      start,
      cursors,
      agent,
      stepId,
      round,
      actionId,
      outstanding,
      approvedPaths,
      changeScope,
      materialized
    );
    // Git artifacts are public; private response validation can contain ballot values.
    const diagnostic = order.submissionMode === "response"
      ? `${outstanding.length} validation finding(s); see its task file.` : outstanding.join("; ");
    this.verbose(`reissued ${agent} action ${actionId}: ${diagnostic}`);
    const next = this.mutate(cursors, (current) => {
      appendJournal(
        this.paths,
        { type: "verify-result", agent, actionId, details: { ok: false, outstanding } },
        this.now()
      );
      clearCompletion(runtime.complete);
      writeAction(this.paths.coordRoot, runtime.action, order);
      const actionDigest = sha256OfFile(runtime.action);
      return replaceCursor(
        current,
        agent,
        {
          status: "ordered",
          attempt: cursor.attempt + 1,
          submissionSha: null,
          outstanding: [...outstanding],
          submissionMode: order.submissionMode,
          actionDigest
        },
        this.now()
      );
    });
    return this.maybeLifecycleNudge(start, next, agent, actionId, "reissue");
  }

  private acceptResponse(
    start: StartState,
    cursors: CursorsState,
    decision: Extract<MachineDecision, { type: "accept-response" }>
  ): CursorsState {
    const cursor = cursors.agents[decision.agent];
    if (cursor === undefined || cursor.stepId === null || cursor.actionId === null) return cursors;
    if (!isBallotStep(cursor.stepId)) {
      return cursors;
    }
    const round = roundForStep(cursor.stepId, cursors.issueCursor.round);
    const canonicalPath = STEP_DEFINITIONS[cursor.stepId].requiredPath(start.issue, decision.agent, round);
    const responsePath = agentResponsePath(this.paths, decision.agent, cursor.actionId);
    const read = readAgentResponse(responsePath, this.paths.issueRoot);
    if (read.status !== "read") {
      throw new Error(`Cannot accept response for ${decision.agent}: response file is ${read.status}.`);
    }
    const digest = responseDigest(read.bytes);
    if (digest !== decision.responseSha256) {
      throw new Error(
        `Cannot accept response for ${decision.agent}: digest ${digest} does not match decision ${decision.responseSha256}.`
      );
    }
    const archivePath = archiveAcceptedResponse(this.paths, decision.agent, cursor.actionId, read.bytes);
    void archivePath;
    const accepted: AcceptedResponse = {
      stepId: cursor.stepId,
      agent: decision.agent,
      actionId: cursor.actionId,
      round,
      responseSha256: decision.responseSha256,
      rationale: decision.rationale,
      path: canonicalPath,
      acceptedAt: this.now(),
      ...(decision.choice === undefined ? {} : { choice: decision.choice }),
      ...(decision.disposition === undefined ? {} : { disposition: decision.disposition })
    };
    const withoutPrior = cursors.acceptedResponses.filter(
      (item) => !(item.stepId === accepted.stepId && item.agent === accepted.agent && item.round === accepted.round)
    );
    const next = this.mutate(cursors, (current) => {
      appendJournal(
        this.paths,
        {
          type: "response-accepted",
          agent: decision.agent,
          actionId: cursor.actionId as string,
          details: {
            responseSha256: decision.responseSha256,
            path: canonicalPath,
            ...(decision.choice === undefined ? {} : { choice: decision.choice }),
            ...(decision.disposition === undefined ? {} : { disposition: decision.disposition })
          }
        },
        this.now()
      );
      const runtime = agentRuntimePaths(this.paths, decision.agent);
      clearAgentResponse(responsePath);
      clearCompletion(runtime.complete);
      if (existsSync(runtime.action)) unlinkSync(runtime.action);
      return cursorsStateSchema.parse({
        ...current,
        agents: {
          ...current.agents,
          [decision.agent]: {
            ...cursor,
            lastAcceptedActionId: cursor.actionId,
            actionId: null,
            submissionMode: null,
            actionDigest: null,
            status: "waiting-peer",
            submissionSha: null,
            outstanding: [],
            updatedAt: this.now()
          }
        },
        acceptedResponses: [...withoutPrior, accepted],
        updatedAt: this.now()
      });
    });
    const completion = markActionWorkflowComplete(this.paths, decision.agent, cursor.actionId, this.now());
    this.log(`[OK] ${decision.agent}: private response validated and accepted.`);
    this.reportStopWarnings();
    if (completion.clearedDegraded) {
      appendJournal(
        this.paths,
        {
          type: "agent-observability-recovered",
          agent: decision.agent,
          actionId: cursor.actionId,
          details: { reason: "workflow-complete-after-degraded" }
        },
        this.now()
      );
      this.log(
        `Issue ${start.issue}: ${decision.agent} completed its work; the earlier lifecycle warning is cleared.`
      );
    }
    return next;
  }

  private async publishBallotBatch(
    start: StartState,
    cursors: CursorsState,
    decision: Extract<MachineDecision, { type: "publish-ballot-batch" }>
  ): Promise<CursorsState> {
    if (
      decision.stepId !== "R3.plan-ballot" &&
      decision.stepId !== "R5.compare-ballot" &&
      decision.stepId !== "R6.ballot" &&
      decision.stepId !== "R4.amend-ballot"
    ) {
      return cursors;
    }
    const kind = ballotBatchKindForStep(decision.stepId);
    const round = decision.round;
    const branch = assertEvidenceBranchSafe({
      branchTemplate: start.branchTemplate,
      issue: start.issue,
      agentIds: start.originalRoster,
      baseBranch: start.baseBranch
    });
    let batch = pendingOrFailedBallotBatch(cursors, decision.stepId, round);
    let next = cursors;

    if (batch === null) {
      const responses = acceptedResponsesAt(cursors, decision.stepId, true, round);
      if (!hasCompleteActiveDenominator(cursors, responses)) {
        return cursors;
      }
      const semantics: BallotAcceptedSemantics[] = responses.map((response) => ({
        agent: response.agent,
        actionId: response.actionId,
        responseSha256: response.responseSha256,
        rationale: response.rationale,
        ...(response.choice === undefined ? {} : { choice: response.choice }),
        ...(response.disposition === undefined ? {} : { disposition: response.disposition })
      }));
      const boundInputs = deriveBoundInputs(start, cursors, decision.stepId, round);
      const prepared = prepareBallotBatch({
        kind,
        issue: start.issue,
        issueSessionId: start.issueSessionId,
        round,
        activeRoster: cursors.activeRoster,
        boundInputs,
        responses: semantics
      });
      const parentSha =
        cursors.evidence.tip ??
        resolveEvidenceParentSha({ baselineSha: start.baselineSha, batches: cursors.ballotBatches });
      const superseded = [...cursors.ballotBatches]
        .reverse()
        .find(
          (candidate) =>
            candidate.kind === kind &&
            candidate.round === round &&
            candidate.status === "invalidated"
        );
      const removePaths =
        superseded === undefined
          ? []
          : superseded.paths.filter((path) => !prepared.paths.includes(path));
      const worktree = evidenceWorktreePath(this.paths, `ballot-${kind.replace(/[^a-z0-9-]/g, "-")}`);
      this.authority(cursors);
      const commitSha = await createEvidenceCommit({
        mirror: this.mirror,
        worktreePath: worktree,
        parentSha,
        files: prepared.files,
        ...(removePaths.length > 0 ? { removePaths } : {}),
        message: prepared.message
      });
      this.authority(cursors);
      const now = this.now();
      const frozen: BallotBatch = {
        batchId: this.actionId(),
        kind,
        round,
        inputSetHash: prepared.inputSetHash,
        activeRoster: [...cursors.activeRoster],
        responses: prepared.activeRoster.map((agent) => {
          const response = responses.find((candidate) => candidate.agent === agent);
          if (response === undefined) throw new Error(`Missing accepted response for ${agent}.`);
          return {
            agent: response.agent,
            actionId: response.actionId,
            responseSha256: response.responseSha256
          };
        }),
        paths: [...prepared.paths],
        branch,
        parentSha,
        commitSha,
        status: "pending",
        attempts: 0,
        error: null,
        supersedes: superseded?.batchId ?? null,
        createdAt: now,
        updatedAt: now
      };
      next = this.mutate(cursors, (current) => {
        appendJournal(
          this.paths,
          {
            type: "ballot-batch-pending",
            details: {
              batchId: frozen.batchId,
              kind: frozen.kind,
              round: frozen.round,
              commitSha: frozen.commitSha,
              parentSha: frozen.parentSha,
              branch: frozen.branch,
              inputSetHash: frozen.inputSetHash
            }
          },
          now
        );
        return cursorsStateSchema.parse({
          ...current,
          evidence: {
            branch: current.evidence.branch ?? branch,
            tip: current.evidence.tip
          },
          ballotBatches: [...current.ballotBatches, frozen],
          updatedAt: now
        });
      });
      batch = frozen;
    }

    const parentSha = batch.parentSha;
    const commitSha = batch.commitSha;
    let remoteTip: string | null = null;
    try {
      const fetched = await this.mirror.fetchBranch(branch);
      this.authority(next);
      if (fetched.ok) remoteTip = fetched.tip;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.recordBallotBatchFailure(next, batch.batchId, message, true);
    }

    const reconcile = reconcileEvidencePublication({ commitSha, parentSha, remoteTip });
    if (reconcile.outcome === "conflict") {
      return this.recordBallotBatchFailure(
        next,
        batch.batchId,
        `evidence branch tip ${reconcile.remoteTip} diverged from expected parent ${parentSha}`,
        false
      );
    }

    try {
      if (reconcile.outcome === "push") {
        this.log(`[WAIT] Pushing evidence branch ${branch}...`);
        await this.mirror.publishBranch(commitSha, branch);
        this.log(`[OK] Evidence branch ${branch} pushed.`);
        this.authority(next);
      }
      const publishedAt = this.now();
      return this.mutate(next, (current) => {
        appendJournal(
          this.paths,
          {
            type: "ballot-batch-published",
            details: {
              batchId: batch.batchId,
              kind: batch.kind,
              round: batch.round,
              commitSha,
              branch,
              inputSetHash: batch.inputSetHash
            }
          },
          publishedAt
        );
        return cursorsStateSchema.parse({
          ...current,
          evidence: { branch, tip: commitSha },
          ballotBatches: current.ballotBatches.map((candidate) =>
            candidate.batchId === batch.batchId
              ? {
                  ...candidate,
                  status: "published" as const,
                  attempts: candidate.attempts + 1,
                  error: null,
                  updatedAt: publishedAt
                }
              : candidate
          ),
          updatedAt: publishedAt
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient =
        error instanceof GitCommandError
          ? error.transient
          : isTransientGitFailure(message);
      return this.recordBallotBatchFailure(next, batch.batchId, message, transient);
    }
  }

  private recordBallotBatchFailure(
    cursors: CursorsState,
    batchId: string,
    error: string,
    transient: boolean
  ): CursorsState {
    const failedAt = this.now();
    this.verbose(`ballot batch ${batchId} publication failed${transient ? " (transient)" : ""}: ${error}`);
    return this.mutate(cursors, (current) => {
      appendJournal(
        this.paths,
        {
          type: "ballot-batch-failed",
          details: { batchId, error }
        },
        failedAt
      );
      return cursorsStateSchema.parse({
        ...current,
        ballotBatches: current.ballotBatches.map((candidate) =>
          candidate.batchId === batchId
            ? {
                ...candidate,
                status: "failed" as const,
                attempts: candidate.attempts + 1,
                error,
                updatedAt: failedAt
              }
            : candidate
        ),
        updatedAt: failedAt
      });
    });
  }

  private advance(cursors: CursorsState, decision: Extract<MachineDecision, { type: "advance-step" }>): CursorsState {
    const agents = { ...cursors.agents };
    for (const agent of cursors.activeRoster) {
      const cursor = agents[agent];
      if (cursor !== undefined) {
        agents[agent] = {
          ...cursor,
          stepId: decision.to,
          evidenceId: decision.to === null ? null : STEP_DEFINITIONS[decision.to].evidenceId,
          actionId: null,
          submissionMode: null,
          actionDigest: null,
          status: decision.to === null ? "complete" : "idle",
          submissionSha: null,
          outstanding: [],
          updatedAt: this.now()
        };
      }
    }
    const issueCursor =
      decision.to === null
        ? cursors.issueCursor
        : { stepId: decision.to, gateId: STEP_DEFINITIONS[decision.to].gateId, round: decision.round };
    return this.mutate(cursors, (current) => {
      appendJournal(
        this.paths,
        { type: "gate-advanced", details: { from: decision.from, to: decision.to, round: decision.round } },
        this.now()
      );
      return cursorsStateSchema.parse({
        ...current,
        issueCursor,
        completed: decision.to === null,
        agents,
        updatedAt: this.now()
      });
    });
  }

  async verifyFollowUpReceipt(
    start: StartState,
    order: InternalOrder,
    observation: EvidenceObservation
  ): Promise<EvidenceObservation> {
    if (observation.status !== "satisfied" || order.evidenceId !== "follow-up-published" || observation.followUpIssueUrl === undefined) {
      return observation;
    }
    const revisionSha = order.inputs.find((input) => input.kind === "revision")?.commitSha;
    if (revisionSha === undefined) {
      return { ...observation, status: "rejected", outstanding: ["follow-up receipt is not bound to the final revision"] };
    }
    let parent;
    try {
      parent = readGitHubIssueSnapshot(this.paths.issueSnapshot);
    } catch (error) {
      return {
        ...observation,
        status: "retry",
        outstanding: [`concluding issue snapshot is unavailable: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
    if (parent.number !== start.issue) {
      return {
        ...observation,
        status: "retry",
        outstanding: [`concluding issue snapshot number ${parent.number} does not match issue ${start.issue}`]
      };
    }
    const assessed = await assessFollowUpIssue({
      origin: start.origin,
      parentIssue: parent.number,
      parentUrl: parent.url,
      agent: order.agent,
      issueSessionId: start.issueSessionId,
      revisionSha,
      followUpUrl: observation.followUpIssueUrl,
      cwd: this.mirror.path,
      runner: (argv, cwd) => this.processRunner(argv, cwd)
    });
    if (assessed.status === "retry") return { ...observation, status: "retry", outstanding: [assessed.reason] };
    if (assessed.status === "reject") return { ...observation, status: "rejected", outstanding: [assessed.reason] };
    return { ...observation, followUpIssueUrl: assessed.url, followUpIssueNumber: assessed.number };
  }

  async verifyFinalizationChecks(
    start: StartState,
    order: InternalOrder,
    observation: EvidenceObservation,
    cursors: CursorsState
  ): Promise<EvidenceObservation> {
    if (observation.status !== "satisfied" || order.stepId !== "R7.finalize" || observation.productPin === undefined) return observation;
    const consensusSha = order.inputs.find((input) => input.kind === "consensus")?.commitSha;
    if (consensusSha === undefined) return { ...observation, status: "rejected", outstanding: ["no consensus pin is bound to finalization"] };
    const verified = verifyFinalization({ root: this.mirror.path, issue: start.issue, consensusSha, finalSha: observation.productPin });
    if (!verified.ok) return { ...observation, status: "rejected", outstanding: [verified.details] };

    // Evidence cleanup is the final commit, not the full issue change. Always
    // classify from the frozen issue baseline, never the cleanup's parent.
    const selected = selectVerification(inspectRangeChanges(this.mirror.path, start.baselineSha, observation.productPin),
      start, "finalization", start.checks);
    const checked = await this.runGateVerification(start, order, cursors, "finalization", observation.productPin, selected,
      selected.commands);
    if (checked.status === "waiting") return waitingObservation(observation, checked.waitingFor);
    if (checked.status === "failed") {
      return {
        ...observation,
        status: "rejected",
        outstanding: [
          `finalization check (tier: checks) ${checked.failure}: ${checked.stderr.trim()}` +
            ` (log: ${checked.failed.logPath})${checked.note === null ? "" : `; ${checked.note}`}`
        ]
      };
    }
    return { ...observation, checkResults: checked.results };
  }

  /**
   * Coordinator-mode gate for every implementation/revision product pin. A
   * failure is a rejected observation, so the agent receives a reissued action
   * naming the command and its log; only success receipts are ever reused, so
   * a failed pin fails again after a restart.
   */
  async verifyCandidateChecks(
    start: StartState,
    order: InternalOrder,
    observation: EvidenceObservation,
    cursors: CursorsState
  ): Promise<EvidenceObservation> {
    if (observation.status !== "satisfied" || observation.productPin === undefined ||
      (order.stepId !== "R4.implement" && order.stepId !== "R6.revise") || start.verification?.mode !== "coordinator") {
      return observation;
    }
    const pin = observation.productPin;
    const selected = selectCandidateVerification(inspectRangeChanges(this.mirror.path, start.baselineSha, pin), start);
    const verified = await this.runGateVerification(start, order, cursors, "candidate", pin, selected, selected.commands);
    this.authority(cursors);
    appendJournal(this.paths, { type: "candidate-check", agent: order.agent, actionId: order.actionId, details: {
      pin, classification: selected.kind, reason: selected.reason, expanded: selected.expanded,
      outcome: verified.status,
      commands: verified.results.map((result) => ({ name: result.name, exitCode: result.exitCode, reused: result.reused === true,
        joined: result.joined === true, receiptId: result.receiptId ?? null, logPath: result.logPath ?? null }))
    } }, this.now());
    if (verified.status === "waiting") return waitingObservation(observation, verified.waitingFor);
    if (verified.status === "failed") {
      return {
        ...observation,
        status: "rejected",
        outstanding: [
          `candidate check ${verified.failure} (log: ${verified.failed.logPath})` +
            `${verified.note === null ? "" : `; ${verified.note}`}`
        ]
      };
    }
    return { ...observation, checkResults: verified.results };
  }

  private async runGateVerification(
    start: StartState,
    order: InternalOrder,
    cursors: CursorsState,
    phase: "candidate" | "finalization",
    pin: string,
    classification: { kind: "coordination" | "documentation" | "product"; reason: string; inputIdentity: string },
    commands: readonly CheckCommand[]
  ): Promise<RunVerificationResult> {
    if (commands.length === 0) {
      const at = this.now();
      this.authority(cursors);
      appendJournal(this.paths, { type: "verification-run", agent: order.agent, actionId: order.actionId,
        details: verificationMeasurement({ trigger: "coordinator", phase,
          inputIdentity: classification.inputIdentity, classification: classification.kind, reason: classification.reason,
          command: null, startedAt: at, completedAt: at, exitCode: 0, skipReason: classification.reason,
          cacheReason: "not cached: nothing selected" }) }, at);
      return { status: "passed", results: [] };
    }
    return runVerification({
      paths: this.paths, start, mirror: this.mirror, processRunner: this.processRunner, now: () => this.now(),
      checkpoint: () => { this.authority(cursors); },
      journal: (type, details, at) => appendJournal(this.paths, { type, agent: order.agent, actionId: order.actionId, details }, at),
      progress: (message) => this.log(`${order.agent}: ${message}`),
      phase, pin, classification, commands
    });
  }

  private async publishAcceptedFinalization(start: StartState, cursors: CursorsState): Promise<CursorsState> {
    if (cursors.publication.status !== "pending" && cursors.publication.status !== "failed") return cursors;
    const { finalSha, branch } = cursors.publication;
    const authority = this.authority(cursors, true);
    let openedUrl = cursors.publication.url;
    try {
      if (finalSha === null || branch === null) throw new Error("Pending publication is missing its final pin or branch.");
      const repository = githubRepositoryFromOrigin(start.origin);
      if (repository === null) throw new Error(`Cannot derive a GitHub repository from origin ${start.origin}.`);
      const issueSnapshot = readGitHubIssueSnapshot(this.paths.issueSnapshot);
      if (issueSnapshot.number !== start.issue) {
        throw new Error(
          `GitHub issue snapshot number ${issueSnapshot.number} does not match start issue ${start.issue}.`
        );
      }
      this.log(`[WAIT] Pushing final branch ${branch}...`);
      await this.mirror.publishBranch(finalSha, branch);
      this.log(`[OK] Final branch ${branch} pushed.`);
      this.authority(authority, true);
      const draft = !coordMergesPullRequest(start.prPolicy);
      const capped = cursors.derived.consensus?.algorithm === "revision-limit-active-roster-v1";
      const followUpUrls = cursors.accepted
        .filter(
          (submission) =>
            submission.stepId === "R6.follow-up" &&
            submission.followUpIssueUrl !== undefined &&
            cursors.activeRoster.includes(submission.agent)
        )
        .map((submission) => submission.followUpIssueUrl as string);
      let resultUrl = openedUrl;
      const alreadyOpen = resultUrl !== null;
      if (resultUrl === null) {
        const { title, body } = formatFinalizationPullRequest({
          issue: start.issue,
          title: issueSnapshot.title,
          finalSha,
          draft,
          evidenceBranch: cursors.evidence.branch,
          evidenceTip: cursors.evidence.tip,
          ...(capped ? { capped: true, followUpUrls } : {})
        });
        this.log("[WAIT] Opening the pull request...");
        const result = await this.pullRequestOpener({
          repository,
          base: start.baseBranch,
          head: branch,
          title,
          body,
          draft
        });
        resultUrl = result.url;
        this.log(`[OK] Pull request: ${resultUrl}`);
      } else {
        this.log(`[OK] Pull request already open: ${resultUrl}`);
      }
      openedUrl = resultUrl;
      this.authority(authority, true);
      if (coordMergesPullRequest(start.prPolicy)) {
        this.log("[WAIT] Merging the pull request...");
        await this.pullRequestMerger({ url: resultUrl });
        this.log("[OK] Pull request merged.");
        this.authority(authority, true);
      }
      return this.mutate(authority, (current) => {
        if (!alreadyOpen) {
          appendJournal(
            this.paths,
            { type: "pr-created", agent: current.derived.implementationSelection?.reviser ?? undefined, details: { url: resultUrl, branch, finalSha } },
            this.now()
          );
        }
        if (coordMergesPullRequest(start.prPolicy)) {
          appendJournal(this.paths, { type: "pr-merged", details: { url: resultUrl, branch, finalSha } }, this.now());
        }
        return cursorsStateSchema.parse({
          ...current,
          publication: {
            status: "completed",
            finalSha,
            branch,
            url: resultUrl,
            error: null,
            attempts: current.publication.attempts + 1
          },
          updatedAt: this.now()
        });
      });
    } catch (error) {
      const latest = readCursorsState(this.paths);
      if (latest.stateRevision !== authority.stateRevision || latest.paused || latest.abandoned) return latest;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Owner action required: finalization publication failed: ${message}`);
      return this.mutate(latest, (current) => {
        appendJournal(
          this.paths,
          { type: "publication-failed", details: { error: message, branch, finalSha, url: openedUrl } },
          this.now()
        );
        return cursorsStateSchema.parse({
          ...current,
          publication: {
            status: "failed",
            finalSha,
            branch,
            url: openedUrl,
            error: message,
            attempts: current.publication.attempts + 1
          },
          updatedAt: this.now()
        });
      });
    }
  }

  private persistDerivedDecision(
    start: StartState,
    cursors: CursorsState,
    kind: "plan-selection" | "implementation-selection" | "consensus",
    derive: (current: CursorsState, now: string, supersedes: string | null) => DerivedDecisionRecord | null,
    advance: Extract<MachineDecision, { type: "advance-step" }>
  ): CursorsState {
    const slot =
      kind === "plan-selection"
        ? "planSelection"
        : kind === "implementation-selection"
          ? "implementationSelection"
          : "consensus";
    const lastEvent = readJournal(this.paths)
      .filter((event) => event.type === "decision-derived" && event.details.kind === kind)
      .at(-1);
    const lastDecisionId =
      typeof lastEvent?.details.decisionId === "string" ? lastEvent.details.decisionId : null;
    const next = this.mutate(cursors, (current) => {
      const existing = current.derived[slot];
      let record = derive(current, this.now(), existing?.decisionId ?? lastDecisionId);
      if (record === null) throw new Error(`Cannot derive ${kind} from the current accepted evidence.`);
      if (lastDecisionId === record.decisionId && lastEvent !== undefined) {
        record = {
          ...record,
          supersedes:
            typeof lastEvent.details.supersedes === "string" ? lastEvent.details.supersedes : null,
          decidedAt: lastEvent.at
        } as DerivedDecisionRecord;
      }
      if (existing?.decisionId === record.decisionId) return current;
      const event = appendJournal(
        this.paths,
        {
          type: "decision-derived",
          details: derivedDecisionJournalDetails(record)
        },
        record.decidedAt
      );
      record = { ...record, decidedAt: event.at } as DerivedDecisionRecord;
      return cursorsStateSchema.parse({
        ...current,
        derived: { ...current.derived, [slot]: record },
        updatedAt: record.decidedAt
      });
    });
    this.logPhase(start.issue, advance.to, advance.round, advance.from);
    return this.advance(next, advance);
  }

  private applyDerivedPlanSelection(start: StartState, cursors: CursorsState): CursorsState {
    return this.persistDerivedDecision(
      start,
      cursors,
      "plan-selection",
      (current, now, supersedes) => computePlanSelectionDerived(current, now, supersedes),
      {
      type: "advance-step",
      from: "R3.plan-ballot",
      to: "R4.implement",
      round: null
      }
    );
  }

  private applyDerivedImplementationSelection(start: StartState, cursors: CursorsState): CursorsState {
    return this.persistDerivedDecision(
      start,
      cursors,
      "implementation-selection",
      (current, now, supersedes) => computeImplementationSelectionDerived(current, now, supersedes),
      {
      type: "advance-step",
      from: "R5.compare-ballot",
      to: "R6.revise",
      round: 1
      }
    );
  }

  private applyDerivedConsensus(start: StartState, cursors: CursorsState, round: number): CursorsState {
    return this.persistDerivedDecision(
      start,
      cursors,
      "consensus",
      (current, now, supersedes) => {
        const record = computeConsensusDerived(current, round, now, supersedes);
        return record?.algorithm === "unanimous-active-roster-v1" ? record : null;
      },
      {
      type: "advance-step",
      from: "R6.ballot",
      to: "R7.finalize",
      round: null
      }
    );
  }

  private applyDerivedRevisionLimit(start: StartState, cursors: CursorsState, round: number): CursorsState {
    return this.persistDerivedDecision(
      start,
      cursors,
      "consensus",
      (current, now, supersedes) => {
        const record = computeConsensusDerived(current, round, now, supersedes);
        return record?.algorithm === "revision-limit-active-roster-v1" ? record : null;
      },
      {
        type: "advance-step",
        from: "R6.ballot",
        to: "R6.follow-up",
        round
      }
    );
  }

  private retireTerminalQuestion(cursors: CursorsState): CursorsState {
    const question = cursors.ownerQuestion;
    if (question === null) return cursors;
    return this.mutate(cursors, (current) => {
      if (current.ownerQuestion?.id !== question.id) return current;
      appendJournal(
        this.paths,
        {
          type: "terminal-question-retired",
          details: {
            questionId: question.id,
            kind: question.kind,
            round: question.round,
            eventId: `terminal-question-retired:${question.id}`
          }
        },
        this.now()
      );
      return cursorsStateSchema.parse({
        ...current,
        ownerQuestion: null,
        updatedAt: this.now()
      });
    });
  }

  private async applyDecisions(start: StartState, cursors: CursorsState, decisions: readonly MachineDecision[]): Promise<CursorsState> {
    let next = cursors;
    for (const decision of decisions) {
      if (next.paused || next.abandoned) return next;
      if (decision.type === "prepare-action") {
        if (bindOwnerGuidance(next, decision.stepId, decision.round, this.now()) !== next) {
          next = this.mutate(next, (current) => {
            // The revision CAS rejects concurrent owner changes; derive the
            // snapshot from the locked state as well, rather than a prior copy.
            const bound = bindOwnerGuidance(current, decision.stepId, decision.round, this.now());
            const snapshot = bound.ownerGuidance!.bound!;
            const event = appendJournal(this.paths, { type: "owner-guidance-bound", details: {
              stepId: snapshot.stepId, round: snapshot.round, generation: snapshot.generation,
              entryIds: snapshot.entries.map((entry) => entry.id),
              eventId: `guidance-bound:${snapshot.generation}:${snapshot.stepId}:${snapshot.round}`
            } }, snapshot.boundAt);
            return { ...bound, ownerGuidance: { ...bound.ownerGuidance!, bound: { ...snapshot, boundAt: event.at } } };
          });
        }
        this.logPhase(start.issue, decision.stepId, decision.round);
        next = await this.prepareAction(start, next, decision.agent, decision.stepId, decision.round);
      } else if (decision.type === "begin-amendment") next = this.beginAmendment(next, decision);
      else if (decision.type === "resolve-amendment") next = this.resolveAmendment(next, decision.approved);
      else if (decision.type === "accept-submission") next = this.accept(start, next, decision);
      else if (decision.type === "accept-response") next = this.acceptResponse(start, next, decision);
      else if (decision.type === "publish-ballot-batch") {
        next = await this.publishBallotBatch(start, next, decision);
      } else if (decision.type === "reissue-action") next = await this.reissue(start, next, decision.agent, decision.outstanding);
      else if (decision.type === "retry-verification") {
        next = this.mutate(next, (current) =>
          replaceCursor(current, decision.agent, { status: "intent", outstanding: [...decision.outstanding] }, this.now())
        );
      } else if (decision.type === "derive-plan-selection") {
        next = this.applyDerivedPlanSelection(start, next);
      } else if (decision.type === "derive-implementation-selection") {
        next = this.applyDerivedImplementationSelection(start, next);
      } else if (decision.type === "derive-consensus") {
        next = this.applyDerivedConsensus(start, next, decision.round);
      } else if (decision.type === "derive-revision-limit") {
        next = this.applyDerivedRevisionLimit(start, next, decision.round);
      } else if (decision.type === "retire-terminal-question") {
        next = this.retireTerminalQuestion(next);
      } else if (decision.type === "advance-step") {
        this.logPhase(start.issue, decision.to, decision.round, decision.from);
        next = this.advance(next, decision);
      } else if (decision.type === "owner-action-required") {
        if (next.ownerQuestion === null) {
          next = this.mutate(next, (current) => {
            const id = this.actionId();
            appendJournal(
              this.paths,
              {
                type: "owner-question",
                details: {
                  id,
                  kind: decision.kind,
                  round: decision.round,
                  allowedAnswers: decision.allowedAnswers,
                  reason: decision.reason
                }
              },
              this.now()
            );
            return cursorsStateSchema.parse({
              ...current,
              ownerQuestion: {
                id,
                kind: decision.kind,
                round: decision.round,
                allowedAnswers: [...decision.allowedAnswers],
                createdAt: this.now()
              },
              updatedAt: this.now()
            });
          });
        }
        this.log(
          `Owner action required: ${decision.reason}. Answer with: ${issueCommand(`answer ${next.ownerQuestion?.id ?? "<question-id>"} <${decision.allowedAnswers.join("|")}>`, start.issue, start.coordRoot)}`
        );
      }
    }
    return next;
  }

  async runTick(options: { observeOnly?: boolean } = {}): Promise<CursorsState> {
    const start = readStartState(this.paths);
    try {
      let cursors = readCursorsState(this.paths);
      this.reportStopWarnings();
      for (const [agent, request] of this.ownerReminders) {
        if (cursors.paused || cursors.abandoned || cursors.completed || !cursors.activeRoster.includes(agent) ||
            cursors.agents[agent]?.actionId !== request.actionId) {
          this.ownerReminders.delete(agent);
          this.log(`[WAIT] ${agent}: reminder cancelled because its task or pause state changed; select it again when appropriate.`);
        }
      }
      if (cursors.abandoned || cursors.completed) return cursors;
      for (const agent of start.agents) {
        if (cursors.activeRoster.includes(agent.id)) {
          ingestContainmentProbe(this.paths, agent.root, agent.id);
          this.ingestVerificationMeasurements(this.paths, agent.root, agent.id, start, this.now());
        }
      }
      for (const agent of cursors.activeRoster) cursors = this.reconcileSubmitted(cursors, agent);
      if (cursors.paused) {
        // Observation-only while held: no preparation, delivery, acceptance or publication.
        for (const agent of cursors.activeRoster) {
          if (!cursors.paused) break;
          cursors = await this.observeResources(start, cursors, agent);
        }
        return cursors;
      }
      // A pause can be released after run() skips initialization but before
      // this read. Keep that poll effect-free until initialization succeeds.
      if (options.observeOnly === true) return cursors;
      cursors = this.retireAmendmentActions(cursors);
      const observations: EvidenceObservation[] = [];

      for (const dropped of cursors.droppedAgents) clearCompletion(agentRuntimePaths(this.paths, dropped).complete);
      for (const agent of cursors.activeRoster) {
      if (cursors.paused) return cursors;
      const cursor = cursors.agents[agent];
      if (cursor === undefined || cursor.actionId === null || cursor.stepId === null) continue;
      const runtime = agentRuntimePaths(this.paths, agent);
      const completion = readCompletion(runtime.complete);
      if (completion.status !== "missing") {
        this.ownerReminders.delete(agent);
        const identity = `${cursor.actionId}:${JSON.stringify(completion)}`;
        if (this.receiptMessages.get(agent) !== identity) {
          this.receiptMessages.set(agent, identity);
          this.log(`[WAIT] ${agent}: completion marker received; checking the submission.`);
        }
      }
      if (this.tmux !== null && ["ordered", "intent", "verifying"].includes(cursor.status)) {
        cursors = this.ensureActionSafety(cursors, agent, cursor.actionId);
        cursors = await this.observeResources(start, cursors, agent);
        if (cursors.paused) return cursors;
        cursors = await this.observeUnfinished(start, cursors, agent, cursor.actionId);
        if (cursors.paused) return cursors;
      }
      if (completion.status === "missing") {
        const request = this.ownerReminders.get(agent);
        if (request !== undefined) {
          this.ownerReminders.delete(agent);
          const entry = readAgentLifecycle(this.paths).agents[agent];
          const config = start.agents.find((candidate) => candidate.id === agent);
          if (cursor.status !== "ordered" || request.actionId !== cursor.actionId || !existsSync(runtime.action) ||
              request.digest !== sha256OfFile(runtime.action) || request.sessionId !== (entry?.sessionId ?? null) ||
              request.sequence !== entry?.hookReceipt?.sequence || entry?.action?.actionId !== request.actionId ||
              entry.action.actionDigest !== request.digest || entry.action.workflowCompleteAt !== null ||
              this.tmux === null || config === undefined || !["nudge", "both"].includes(config.delivery)) {
            this.log(`[WARN] ${agent}: reminder not sent; task/activity changed or terminal delivery is unavailable. Inspect the terminal and reopen n if appropriate.`);
          } else {
            const sends = cursors.actionSafety[agent]?.sends ?? 0;
            cursors = await this.deliver(start, cursors, agent, request.actionId, request.digest, "owner");
            const after = cursors.actionSafety[agent];
            if ((after?.sends ?? 0) === sends || after?.reserved) this.log(`[WAIT] ${agent}: reminder deferred by readiness, send spacing or a hold; inspect the terminal, use r for a hold, or type directly if needed.`);
          }
          continue;
        }
        if (this.tmux !== null) {
          if (cursor.status === "ordered") {
            cursors = await this.maybeLifecycleNudge(start, cursors, agent, cursor.actionId);
            if (cursors.paused) return cursors;
          }
        }
        continue;
      }

      if (completion.status === "malformed") {
        cursors = await this.reissue(start, cursors, agent, [completion.message]);
        continue;
      }

      const submissionMode = STEP_DEFINITIONS[cursor.stepId].submissionMode;
      const round = roundForStep(cursor.stepId, cursors.issueCursor.round);

      if (submissionMode === "response") {
        if (completion.kind !== "response") {
          cursors = await this.reissue(start, cursors, agent, [
            "response actions require a `response <actionId>` completion marker, not a commit SHA"
          ]);
          continue;
        }
        if (completion.actionId !== cursor.actionId) {
          cursors = await this.reissue(start, cursors, agent, [
            `response marker actionId ${completion.actionId} does not match ordered action ${cursor.actionId}`
          ]);
          continue;
        }

        const responsePath = agentResponsePath(this.paths, agent, cursor.actionId);
        const read = readAgentResponse(responsePath, this.paths.issueRoot);
        if (read.status === "missing") {
          cursors = await this.reissue(start, cursors, agent, [
            `response file is missing at ${responsePath}; write the JSON response before the completion marker`
          ]);
          continue;
        }
        if (read.status !== "read") {
          cursors = await this.reissue(start, cursors, agent, [
            `response file at ${responsePath} is ${read.status}`
          ]);
          continue;
        }

        const planChoices = acceptedAt(cursors, "R2.plan").map((submission) => submission.agent);
        const implementationChoices = acceptedAt(cursors, "R4.implement").map((submission) => submission.agent);
        const eligibleChoices =
          cursor.stepId === "R3.plan-ballot"
            ? planChoices
            : cursor.stepId === "R5.compare-ballot"
              ? implementationChoices
              : [];
        const parsed = parseBallotResponse(
          read.bytes.toString("utf8"),
          cursor.stepId,
          cursor.actionId,
          eligibleChoices
        );
        if (!parsed.ok) {
          cursors = await this.reissue(start, cursors, agent, parsed.outstanding);
          continue;
        }

        const digest = responseDigest(read.bytes);
        cursors = this.mutate(cursors, (current) => {
          appendJournal(
            this.paths,
            {
              type: "intent-seen",
              agent,
              actionId: cursor.actionId as string,
              details: { kind: "response", responseSha256: digest }
            },
            this.now()
          );
          return replaceCursor(current, agent, { status: "verifying", submissionSha: null }, this.now());
        });

        const value = parsed.value;
        observations.push({
          agent,
          actionId: cursor.actionId,
          submissionSha: digest,
          status: "satisfied",
          outstanding: [],
          responseSha256: digest,
          rationale: value.rationale,
          ...("choice" in value ? { choice: value.choice } : {}),
          ...("disposition" in value ? { disposition: value.disposition } : {})
        });
        continue;
      }

      if (completion.kind !== "sha") {
        cursors = await this.reissue(start, cursors, agent, [
          "git actions require a 40-character commit SHA completion marker, not a response marker"
        ]);
        continue;
      }

      cursors = this.mutate(cursors, (current) => {
        appendJournal(
          this.paths,
          { type: "intent-seen", agent, actionId: cursor.actionId as string, submissionSha: completion.sha, details: {} },
          this.now()
        );
        return replaceCursor(current, agent, { status: "verifying", submissionSha: completion.sha }, this.now());
      });
      const approvedPaths = await resolveApprovedPaths(this.mirror, cursors, cursor.stepId);
      this.authority(cursors);
      const order = buildOrder(
        this.paths,
        start,
        cursors,
        agent,
        cursor.stepId,
        round,
        cursor.actionId,
        cursor.outstanding,
        approvedPaths
      );
      let observation = await evaluateEvidence(order, completion.sha, this.mirror as EvidenceMirror, () =>
        this.authority(cursors)
      );
      this.authority(cursors);
      observation = await this.verifyFollowUpReceipt(start, order, observation);
      this.authority(cursors);
      observation = await this.verifyFinalizationChecks(start, order, observation, cursors);
      this.authority(cursors);
      observation = await this.verifyCandidateChecks(start, order, observation, cursors);
      this.authority(cursors);
      observations.push(observation);
      }

      if (cursors.paused) return cursors;

      const pendingBatch = pendingOrFailedBallotBatch(
        cursors,
        cursors.issueCursor.stepId,
        roundForStep(cursors.issueCursor.stepId, cursors.issueCursor.round)
      );
      if (pendingBatch !== null && pendingBatch.status === "pending") {
        cursors = await this.publishBallotBatch(start, cursors, {
          type: "publish-ballot-batch",
          stepId: cursors.issueCursor.stepId,
          round: roundForStep(cursors.issueCursor.stepId, cursors.issueCursor.round)
        });
      }

      if (observations.length > 0) cursors = await this.applyDecisions(start, cursors, decide({ start, cursors, observations }));
      if (cursors.paused) return cursors;
      if (cursors.publication.status === "pending" || cursors.publication.status === "failed") {
        cursors = await this.publishAcceptedFinalization(start, cursors);
        if (cursors.publication.status !== "completed") return cursors;
      }

      for (let progress = 0; progress < 4; progress += 1) {
        const decisions = decide({ start, cursors }).filter((decision) => decision.type !== "wait");
        if (decisions.length === 0) break;
        cursors = await this.applyDecisions(start, cursors, decisions);
        if (cursors.paused) return cursors;
        if (cursors.publication.status === "pending" || cursors.publication.status === "failed") {
          cursors = await this.publishAcceptedFinalization(start, cursors);
          if (cursors.publication.status !== "completed") return cursors;
        }
        if (decisions.every((decision) => decision.type === "owner-action-required")) break;
      }
      const waiting = cursors.activeRoster
        .map((agent) => {
          const cursor = cursors.agents[agent];
          if (cursor === undefined) return null;
          if (cursor.status === "idle" && cursor.actionId === null) return null;
          return `${agent}=${cursor.status}${cursor.outstanding.length > 0 ? `(${cursor.outstanding.length} correction(s))` : ""}`;
        })
        .filter((item): item is string => item !== null);
      this.verbose(
        `tick ${cursors.issueCursor.stepId ?? "done"} roster=${cursors.activeRoster.join(",")} waiting=${waiting.join(";") || "none"}`
      );
      return cursors;
    } catch (error) {
      if (error instanceof StateConflictError) return readCursorsState(this.paths);
      throw error;
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    const stopped = () => signal?.aborted === true;
    if (stopped()) return;
    const start = readStartState(this.paths);
    let cursors = readCursorsState(this.paths);
    const finished = (state: CursorsState): boolean => state.completed || state.abandoned;
    if (finished(cursors)) {
      this.log(renderIssueReport(start, cursors, readAgentLifecycle(this.paths)).trimEnd());
      return;
    }
    this.logPhase(start.issue, cursors.issueCursor.stepId, cursors.issueCursor.round);
    // Pauses retain the runner, not workflow authority. runTick remains
    // observation-only while held, and manual pause also stops quota reads.
    let initialized = false;
    let diagnosed = false;
    let lastPausedReport: string | null = null;
    while (!stopped()) {
      cursors = readCursorsState(this.paths);
      try {
        if (!finished(cursors)) {
          if (!initialized && !cursors.paused) {
            await this.initializeEffects();
            initialized = true;
          }
          if (!diagnosed) { await this.reportStartup(); diagnosed = true; }
          if (stopped()) return;
          cursors = await this.runTick({ observeOnly: !initialized });
        }
      } catch (error) {
        // An owner command can revoke initialization authority during a slow
        // mirror/UI effect. Reobserve on the next poll; never mask real errors.
        if (!(error instanceof StateConflictError)) throw error;
        cursors = readCursorsState(this.paths);
      }
      if (stopped()) return;
      if (finished(cursors)) {
        this.log(renderIssueReport(start, cursors, readAgentLifecycle(this.paths)).trimEnd());
        return;
      }
      const report = cursors.paused ? renderIssueReport(start, cursors, readAgentLifecycle(this.paths)).trimEnd() : null;
      if (report !== null && report !== lastPausedReport) this.log(report);
      lastPausedReport = report;
      // The default sleep cancels its timer; the wrapper also permits injected
      // sleeps that do not implement cancellation, without retaining listeners.
      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([
          this.sleep(start.pollIntervalMs, signal),
          new Promise<void>((resolve) => {
            onAbort = resolve;
            if (stopped()) resolve();
            else signal?.addEventListener("abort", onAbort, { once: true });
          })
        ]);
      } finally {
        if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      }
    }
  }
}
