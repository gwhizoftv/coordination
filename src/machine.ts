import { REVISION_LIMIT_ALGORITHM, type CursorsState, type StartState } from "./state.js";
import {
  STEP_DEFINITIONS,
  isBallotStep,
  roundForStep,
  participantsForStep,
  stepsForProfile,
  type EvidenceObservation,
  type MachineDecision,
  type WorkflowProfile,
  type WorkflowStepId
} from "./steps.js";

export type MachineInput = {
  start: StartState;
  cursors: CursorsState;
  observations?: readonly EvidenceObservation[];
};

const globalOrder: readonly WorkflowStepId[] = [
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


const effectiveProfile = (start: StartState, cursors: CursorsState): WorkflowProfile =>
  cursors.activeRoster.length === 1 ? "solo" : start.profile;

const normalizeCurrentStep = (
  current: WorkflowStepId,
  profile: WorkflowProfile
): WorkflowStepId | null => {
  const sequence = stepsForProfile(profile);
  if (sequence.includes(current)) return current;
  // Objections recorded at the revision limit are still owed after the roster
  // shrinks to one agent; only the follow-up step itself may advance past them.
  if (current === "R6.follow-up" && sequence.includes("R7.finalize")) return current;
  const currentRank = globalOrder.indexOf(current);
  return sequence.find((step) => globalOrder.indexOf(step) > currentRank) ?? null;
};

const nextStep = (current: WorkflowStepId, profile: WorkflowProfile): WorkflowStepId | null => {
  if (current === "R6.follow-up") return "R7.finalize";
  const sequence = stepsForProfile(profile);
  const index = sequence.indexOf(current);
  return index < 0 ? normalizeCurrentStep(current, profile) : (sequence[index + 1] ?? null);
};

const hasAccepted = (cursors: CursorsState, stepId: WorkflowStepId, agent: string, round: number | null): boolean =>
  cursors.accepted.some(
    (submission) => submission.stepId === stepId && submission.agent === agent && submission.round === round
  );

const hasResponse = (cursors: CursorsState, stepId: WorkflowStepId, agent: string, round: number | null): boolean =>
  cursors.acceptedResponses.some(
    (response) => response.stepId === stepId && response.agent === agent && response.round === round
  );

const hasPublishedBatch = (cursors: CursorsState, stepId: WorkflowStepId, round: number | null): boolean => {
  const kind =
    stepId === "R3.plan-ballot"
      ? "plan-ballot-batch"
      : stepId === "R5.compare-ballot"
        ? "comparison-ballot-batch"
        : stepId === "R4.amend-ballot"
          ? "amendment-ballot-batch"
        : stepId === "R6.ballot"
          ? "consensus-ballot-batch"
          : null;
  if (kind === null) return true;
  if (!isBallotStep(stepId)) return true;
  const closed = cursors.activeRoster.map((agent) =>
    cursors.acceptedResponses.find(
      (response) => response.stepId === stepId && response.agent === agent && response.round === round
    )
  );
  if (closed.some((response) => response === undefined)) return false;
  return cursors.ballotBatches.some((batch) => {
    if (batch.kind !== kind || batch.round !== round || batch.status !== "published") return false;
    if (!sameRoster(batch.activeRoster, cursors.activeRoster)) return false;
    if (batch.responses.length !== closed.length) return false;
    return closed.every((response, index) => {
      const entry = batch.responses[index];
      return (
        response !== undefined &&
        entry !== undefined &&
        entry.agent === response.agent &&
        entry.actionId === response.actionId &&
        entry.responseSha256 === response.responseSha256
      );
    });
  });
};

const sameRoster = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((agent, index) => agent === right[index]);

const needsPlanSelectionDerive = (cursors: CursorsState, profile: WorkflowProfile): boolean =>
  profile !== "solo" &&
  (cursors.derived.planSelection === null ||
    !sameRoster(cursors.derived.planSelection.activeRoster, cursors.activeRoster));

const needsImplementationSelectionDerive = (cursors: CursorsState): boolean =>
  cursors.derived.implementationSelection === null ||
  !sameRoster(cursors.derived.implementationSelection.activeRoster, cursors.activeRoster);

/** Active agents who still object under a revision-limit decision, in roster order. */
const activeObjectors = (cursors: CursorsState): string[] =>
  cursors.derived.consensus?.algorithm === REVISION_LIMIT_ALGORITHM
    ? (cursors.derived.consensus.objectors ?? [])
        .map((objector) => objector.agent)
        .filter((agent) => cursors.activeRoster.includes(agent))
    : [];

/**
 * A question raised at the revision limit by an earlier coordinator version:
 * its complete, published ballots now conclude the issue without an owner
 * answer, so the question is obsolete rather than pending.
 */
const obsoleteLimitQuestion = (start: StartState, cursors: CursorsState): boolean => {
  const question = cursors.ownerQuestion;
  if (question === null || question.round < start.maxRevisionRounds) return false;
  if (cursors.issueCursor.stepId !== "R6.ballot" || cursors.issueCursor.round !== question.round) return false;
  return (
    cursors.activeRoster.every((agent) => hasResponse(cursors, "R6.ballot", agent, question.round)) &&
    hasPublishedBatch(cursors, "R6.ballot", question.round)
  );
};

const needsConsensusDerive = (cursors: CursorsState, round: number): boolean =>
  cursors.derived.consensus === null ||
  cursors.derived.consensus.round !== round ||
  !sameRoster(cursors.derived.consensus.activeRoster, cursors.activeRoster);

export const decide = (input: MachineInput): readonly MachineDecision[] => {
  const { start, cursors } = input;
  if (cursors.abandoned) return [{ type: "wait", reason: "workflow was abandoned" }];
  if (cursors.completed) return [{ type: "wait", reason: "workflow is complete" }];
  if (cursors.paused) return [{ type: "wait", reason: "workflow is paused" }];

  // A request is not a ready signal. Serialize competing requests before any
  // source-step advancement, independent of observation arrival order.
  if (cursors.pendingAmendment == null && ["R4.implement", "R6.revise"].includes(cursors.issueCursor.stepId)) {
    for (const agent of cursors.activeRoster) {
      const proposal = input.observations?.find((item) => item.agent === agent && item.status === "satisfied" &&
        item.amendmentRequest !== undefined && item.actionId === cursors.agents[agent]?.actionId &&
        cursors.agents[agent]?.stepId === cursors.issueCursor.stepId);
      if (proposal?.amendmentRequest !== undefined) return [{
        type: "begin-amendment", agent, submissionSha: proposal.submissionSha, request: proposal.amendmentRequest
      }];
    }
  }

  const decisions: MachineDecision[] = [];
  for (const observation of input.observations ?? []) {
    if (!cursors.activeRoster.includes(observation.agent)) continue;
    const cursor = cursors.agents[observation.agent];
    if (cursor === undefined || cursor.actionId !== observation.actionId) continue;
    if (observation.status === "retry") {
      decisions.push({ type: "retry-verification", agent: observation.agent, outstanding: observation.outstanding });
    } else if (observation.status === "rejected") {
      decisions.push({ type: "reissue-action", agent: observation.agent, outstanding: observation.outstanding });
    } else if (observation.responseSha256 !== undefined && observation.rationale !== undefined) {
      decisions.push({
        type: "accept-response",
        agent: observation.agent,
        responseSha256: observation.responseSha256,
        rationale: observation.rationale,
        ...(observation.disposition === undefined ? {} : { disposition: observation.disposition }),
        ...(observation.choice === undefined ? {} : { choice: observation.choice })
      });
    } else {
      decisions.push({
        type: "accept-submission",
        agent: observation.agent,
        submissionSha: observation.submissionSha,
        ...(observation.productPin === undefined ? {} : { productPin: observation.productPin }),
        ...(observation.disposition === undefined ? {} : { disposition: observation.disposition }),
        ...(observation.approvedPaths === undefined ? {} : { approvedPaths: observation.approvedPaths }),
        ...(observation.choice === undefined ? {} : { choice: observation.choice }),
        ...(observation.checkResults === undefined ? {} : { checkResults: observation.checkResults }),
        ...(observation.followUpIssue === undefined ? {} : { followUpIssue: observation.followUpIssue })
      });
    }
  }
  if (decisions.length > 0) return decisions;
  if (cursors.issueCursor.stepId === "R4.amend-ballot") {
    const pending = cursors.pendingAmendment ?? null;
    if (pending === null || !sameRoster(pending.activeRoster, cursors.activeRoster)) {
      return [{ type: "wait", reason: "amendment request is missing or its roster changed" }];
    }
    const round = pending.sequence;
    const complete = cursors.activeRoster.every((agent) => hasResponse(cursors, "R4.amend-ballot", agent, round));
    if (complete) {
      if (!hasPublishedBatch(cursors, "R4.amend-ballot", round)) {
        if (cursors.ballotBatches.some((batch) => batch.kind === "amendment-ballot-batch" &&
          batch.round === round && batch.status === "pending" && sameRoster(batch.activeRoster, cursors.activeRoster))) {
          return [{ type: "wait", reason: "ballot evidence publication pending" }];
        }
        return [{ type: "publish-ballot-batch", stepId: "R4.amend-ballot", round }];
      }
      return [{ type: "resolve-amendment", approved: cursors.acceptedResponses
        .filter((response) => response.stepId === "R4.amend-ballot" && response.round === round && cursors.activeRoster.includes(response.agent))
        .every((response) => response.disposition === "approve") }];
    }
    return cursors.activeRoster.filter((agent) => !hasResponse(cursors, "R4.amend-ballot", agent, round) &&
      (cursors.agents[agent]?.actionId === null || cursors.agents[agent]?.stepId !== "R4.amend-ballot"))
      .map((agent) => ({ type: "prepare-action", agent, stepId: "R4.amend-ballot", round }));
  }
  if (cursors.ownerQuestion !== null && obsoleteLimitQuestion(start, cursors)) {
    return [{
      type: "retire-owner-question",
      questionId: cursors.ownerQuestion.id,
      kind: cursors.ownerQuestion.kind,
      round: cursors.ownerQuestion.round
    }];
  }
  if (cursors.ownerQuestion !== null) {
    return [
      {
        type: "owner-action-required",
        reason: `${cursors.ownerQuestion.kind} at revision round ${cursors.ownerQuestion.round}`,
        kind: cursors.ownerQuestion.kind,
        round: cursors.ownerQuestion.round,
        allowedAnswers: cursors.ownerQuestion.allowedAnswers
      }
    ];
  }

  const profile = effectiveProfile(start, cursors);
  const current = cursors.issueCursor.stepId;
  const normalized = normalizeCurrentStep(current, profile);
  if (normalized === null) return [{ type: "advance-step", from: current, to: null, round: null }];
  if (normalized !== current) {
    const round = normalized === "R6.revise" || normalized === "R6.ballot" ? (cursors.issueCursor.round ?? 1) : null;
    return [{ type: "advance-step", from: current, to: normalized, round }];
  }

  if (current === "R4.implement" && profile !== "solo" && needsPlanSelectionDerive(cursors, profile)) {
    return [{ type: "wait", reason: "canonical plan selection is missing or stale" }];
  }
  if ((current === "R6.revise" || current === "R6.ballot") && needsImplementationSelectionDerive(cursors)) {
    return [{ type: "wait", reason: "canonical implementation selection is missing or stale" }];
  }
  if (
    current === "R6.follow-up" &&
    (cursors.derived.consensus === null ||
      cursors.derived.consensus.round !== cursors.issueCursor.round ||
      !sameRoster(cursors.derived.consensus.activeRoster, cursors.activeRoster))
  ) {
    return [{ type: "wait", reason: "canonical revision-limit decision is missing or stale" }];
  }
  if (
    current === "R7.finalize" &&
    profile === "consensus" &&
    (cursors.derived.consensus === null ||
      !sameRoster(cursors.derived.consensus.activeRoster, cursors.activeRoster)) &&
    !cursors.accepted.some(
      (submission) =>
        submission.stepId === "R7.finalize" && cursors.activeRoster.includes(submission.agent)
    )
  ) {
    return [{ type: "wait", reason: "canonical consensus decision is missing" }];
  }
  if (current === "R7.finalize" && profile === "reviewed" && needsPlanSelectionDerive(cursors, profile)) {
    return [{ type: "wait", reason: "canonical plan selection is missing or stale" }];
  }

  const designated =
    current === "R4.implement"
      ? profile === "solo"
        ? cursors.activeRoster[0]
        : cursors.derived.planSelection?.selectedAgents[0]
      : current === "R6.revise"
        ? cursors.derived.implementationSelection?.reviser
        : current === "R7.finalize"
          ? profile === "consensus"
            ? cursors.derived.implementationSelection?.reviser
            : profile === "reviewed"
              ? cursors.derived.planSelection?.selectedAgents[0]
              : cursors.activeRoster[0]
        : cursors.activeRoster[0];
  const participants = participantsForStep(current, profile, cursors.activeRoster, designated, activeObjectors(cursors));
  const round = roundForStep(current, cursors.issueCursor.round);
  const complete = participants.every((agent) =>
    isBallotStep(current) ? hasResponse(cursors, current, agent, round) : hasAccepted(cursors, current, agent, round)
  );

  if (complete) {
    if (isBallotStep(current) && !hasPublishedBatch(cursors, current, round)) {
      const pending = cursors.ballotBatches.some(
        (batch) =>
          batch.status === "pending" &&
          ((current === "R3.plan-ballot" && batch.kind === "plan-ballot-batch") ||
            (current === "R5.compare-ballot" && batch.kind === "comparison-ballot-batch") ||
            (current === "R6.ballot" && batch.kind === "consensus-ballot-batch" && batch.round === round))
      );
      if (pending) return [{ type: "wait", reason: "ballot evidence publication pending" }];
      return [{ type: "publish-ballot-batch", stepId: current, round }];
    }

    if (current === "R6.ballot") {
      const currentRound = round ?? 1;
      const ballots = cursors.acceptedResponses.filter(
        (response) => response.stepId === current && response.round === round && participants.includes(response.agent)
      );
      // Below the limit an objection asks for more work. At the limit there is
      // no further round: the objections are recorded and the revision concludes.
      if (currentRound < start.maxRevisionRounds) {
        if (ballots.some((ballot) => ballot.disposition === "escalate")) {
          return [
            {
              type: "owner-action-required",
              reason: `consensus ballot round ${currentRound} requested escalation`,
              kind: "ballot-escalation",
              round: currentRound,
              allowedAnswers: ["retry", "revise", "abandon"]
            }
          ];
        }
        if (ballots.some((ballot) => ballot.disposition === "revise")) {
          return [{ type: "advance-step", from: current, to: "R6.revise", round: currentRound + 1 }];
        }
      }
      if (needsConsensusDerive(cursors, currentRound)) {
        return [{ type: "derive-consensus", round: currentRound }];
      }
      return cursors.derived.consensus?.algorithm === REVISION_LIMIT_ALGORITHM
        ? [{ type: "advance-step", from: current, to: "R6.follow-up", round: currentRound }]
        : [{ type: "advance-step", from: current, to: "R7.finalize", round: null }];
    }

    if (current === "R3.plan-ballot" && needsPlanSelectionDerive(cursors, profile)) {
      return [{ type: "derive-plan-selection" }];
    }
    if (current === "R5.compare-ballot" && needsImplementationSelectionDerive(cursors)) {
      return [{ type: "derive-implementation-selection" }];
    }

    const next = nextStep(current, profile);
    const nextRound = next === "R6.revise" || next === "R6.ballot" ? (round ?? 1) : null;
    return [{ type: "advance-step", from: current, to: next, round: nextRound }];
  }

  for (const agent of participants) {
    if (isBallotStep(current) ? hasResponse(cursors, current, agent, round) : hasAccepted(cursors, current, agent, round)) {
      continue;
    }
    const cursor = cursors.agents[agent];
    if (cursor === undefined || cursor.status === "dropped") continue;
    if (cursor.actionId === null || cursor.stepId !== current) {
      decisions.push({ type: "prepare-action", agent, stepId: current, round });
    }
  }

  return decisions.length > 0 ? decisions : [{ type: "wait", reason: `waiting for ${STEP_DEFINITIONS[current].gateId}` }];
};
