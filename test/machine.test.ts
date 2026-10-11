import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decide } from "../src/machine.js";
import { planAmendmentRequestSchema } from "../src/protocol.js";
import {
  cursorsStateSchema,
  initialCursors,
  startStateSchema,
  type AcceptedResponse,
  type AcceptedSubmission,
  type BallotBatch
} from "../src/state.js";

const now = "2026-08-11T12:00:00.000Z";
const roster = ["claude", "codex", "cursor", "antigravity"];

const responseDigest = (seed: string): string => createHash("sha256").update(seed, "utf8").digest("hex");
const gitSha = (seed: string): string =>
  createHash("sha256").update(`git:${seed}`, "utf8").digest("hex").slice(0, 40);
const actionIdFor = (agent: string): string => {
  const nibble = (agent.charCodeAt(0) % 10).toString();
  return `10000000-0000-4000-8000-${`${nibble}0`.padStart(12, "0")}`;
};
const acceptedResponseFixture = (input: {
  stepId: AcceptedResponse["stepId"];
  agent: string;
  round?: number | null;
  choice?: string;
  disposition?: AcceptedResponse["disposition"];
  acceptedAt?: string;
}): AcceptedResponse => {
  const actionId = actionIdFor(input.agent);
  return {
    stepId: input.stepId,
    agent: input.agent,
    actionId,
    round: input.round === undefined ? null : input.round,
    responseSha256: responseDigest(input.agent),
    rationale: "fixture rationale",
    path: `/runtime/accepted-responses/${input.agent}/${actionId}.json`,
    acceptedAt: input.acceptedAt ?? now,
    ...(input.choice === undefined ? {} : { choice: input.choice }),
    ...(input.disposition === undefined ? {} : { disposition: input.disposition })
  };
};
const publishedBallotBatchFixture = (input: {
  kind: BallotBatch["kind"];
  activeRoster: readonly string[];
  round?: number | null;
  commitSha?: string;
  createdAt?: string;
}): BallotBatch => {
  const createdAt = input.createdAt ?? now;
  const round = input.round === undefined ? null : input.round;
  return {
    batchId: "20000000-0000-4000-8000-000000000001",
    kind: input.kind,
    round,
    inputSetHash: responseDigest("batch"),
    activeRoster: [...input.activeRoster],
    responses: input.activeRoster.map((agent) => ({
      agent,
      actionId: actionIdFor(agent),
      responseSha256: responseDigest(agent)
    })),
    paths: input.activeRoster.map((agent) =>
      input.kind === "plan-ballot-batch"
        ? `.plans/issue-1/ballot-${agent}.json`
        : input.kind === "comparison-ballot-batch"
          ? `.code-reviews/issue-1/ballot-${agent}.json`
          : `.code-reviews/issue-1/consensus-ballot-${agent}-round-${round ?? 1}.json`
    ),
    branch: "issue-1/coordinator-evidence",
    parentSha: gitSha("a"),
    commitSha: input.commitSha ?? gitSha("b"),
    status: "published",
    attempts: 1,
    error: null,
    supersedes: null,
    createdAt,
    updatedAt: createdAt
  };
};

const start = startStateSchema.parse({
  formatVersion: 4,
  issue: 1,
  issueSessionId: `issue-1:${"a".repeat(40)}`,
  baselineSha: "a".repeat(40),
  profile: "consensus",
  originalRoster: roster,
  branchTemplate: "issue-{issue}/{agent}",
  baseBranch: "main",
  maxRevisionRounds: 3,
  prPolicy: "owner-only",
  automationDigest: "b".repeat(64),
  automationDigestScheme: "sha256-length-prefixed-v1",
  automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
  trustedSourceCommit: "c".repeat(40),
  origin: "/origin.git",
  coordRoot: "/runtime",
  configPath: "/config.json",
  agents: roster.map((id) => ({ id, root: `/clones/${id}`, launcher: `start-${id}.sh`, delivery: "pull" })),
  checks: [{ name: "check", argv: ["pnpm", "check"] }],
  pollIntervalMs: 1000,
  createdAt: now
});

const accepted = (
  stepId: AcceptedSubmission["stepId"],
  agent: string,
  round: number | null = null,
  disposition?: AcceptedSubmission["disposition"]
): AcceptedSubmission => ({
  stepId,
  agent,
  round,
  submissionSha: (agent.charCodeAt(0) % 10).toString().repeat(40),
  path: `.signals/issue-1/${agent}.json`,
  acceptedAt: now,
  ...(disposition === undefined ? {} : { disposition })
});

const consensusResponses = (round: number, reviseAgent: string | null, escalateAgent: string | null = null) =>
  roster.map((agent) =>
    acceptedResponseFixture({
      stepId: "R6.ballot",
      agent,
      round,
      acceptedAt: now,
      disposition:
        agent === escalateAgent ? "escalate" : agent === reviseAgent ? "revise" : "approve"
    })
  );

const consensusBatch = (round: number) =>
  publishedBallotBatchFixture({
    kind: "consensus-ballot-batch",
    activeRoster: roster,
    round,
    createdAt: now
  });

const implementationDerived = {
  kind: "implementation-selection" as const,
  algorithm: "plurality-active-roster-v1" as const,
  inputSetHash: "d".repeat(64),
  activeRoster: roster,
  inputs: [
    {
      kind: "implementation" as const,
      agent: "codex",
      submissionSha: "e".repeat(40),
      path: ".signals/issue-1/implementation-ready-codex.json",
      productPin: "d".repeat(40)
    }
  ],
  decisionId: `implementation-selection:${"d".repeat(64)}`,
  supersedes: null,
  decidedAt: now,
  winner: "codex",
  implementationPin: "d".repeat(40),
  reviser: "codex"
};

describe("pure workflow machine", () => {
  it.each(["consensus", "reviewed", "solo"] as const)("requires explicit amendment unanimity under %s", (profile) => {
    const activeRoster = profile === "solo" ? ["codex"] : roster;
    const pending = {
      sequence: 2,
      request: { agent: "codex", commitSha: gitSha("request"), path: ".signals/issue-1/revision-ready-codex-round-1.json" },
      proposal: {
        protocolVersion: 1, artifact: "plan-amendment-request", issue: 1,
        issueSessionId: start.issueSessionId, agent: "codex", actionId: actionIdFor("codex"),
        inputSetHash: responseDigest("inputs"), scopeHash: responseDigest("scope"),
        explanation: "Missing regression test", additionalPaths: [{ path: "test/product.test.ts", reason: "Regression coverage" }]
      },
      plans: [{ agent: "codex", commitSha: gitSha("plan"), path: ".plans/issue-1/plan.md" }],
      activeRoster, resume: { stepId: "R6.revise", round: 1 }, requestedAt: now
    };
    const base = cursorsStateSchema.parse({
      ...initialCursors(start, now), activeRoster, amendmentSequence: 2, pendingAmendment: pending,
      issueCursor: { stepId: "R4.amend-ballot", gateId: "gate-4-implementations", round: 2 },
      acceptedResponses: activeRoster.map((agent) => acceptedResponseFixture({ stepId: "R4.amend-ballot", agent, round: 1, disposition: "approve" }))
    });
    const context = { ...start, profile };
    expect(decide({ start: context, cursors: base })).toEqual(activeRoster.map((agent) => ({
      type: "prepare-action", agent, stepId: "R4.amend-ballot", round: 2
    })));
    const responses = activeRoster.map((agent) => acceptedResponseFixture({ stepId: "R4.amend-ballot", agent, round: 2, disposition: "approve" }));
    const complete = cursorsStateSchema.parse({ ...base, acceptedResponses: [...base.acceptedResponses, ...responses] });
    expect(decide({ start: context, cursors: complete })).toEqual([{ type: "publish-ballot-batch", stepId: "R4.amend-ballot", round: 2 }]);
    const published = cursorsStateSchema.parse({ ...complete, ballotBatches: [publishedBallotBatchFixture({ kind: "amendment-ballot-batch", activeRoster, round: 2 })] });
    expect(decide({ start: context, cursors: published })).toEqual([{ type: "resolve-amendment", approved: true }]);
    published.acceptedResponses.find((response) => response.round === 2)!.disposition = "revise";
    expect(decide({ start: context, cursors: published })).toEqual([{ type: "resolve-amendment", approved: false }]);
    expect(published.pendingAmendment?.resume).toEqual({ stepId: "R6.revise", round: 1 });
    const work = cursorsStateSchema.parse({ ...base, pendingAmendment: null,
      issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
      agents: Object.fromEntries(activeRoster.map((agent) => [agent, { ...base.agents[agent], stepId: "R4.implement", actionId: actionIdFor(agent) }]))
    });
    const observations = [...activeRoster].reverse().map((agent) => ({ agent, actionId: actionIdFor(agent),
      submissionSha: gitSha(agent), status: "satisfied" as const, outstanding: [],
      amendmentRequest: planAmendmentRequestSchema.parse({ ...pending.proposal, agent, actionId: actionIdFor(agent) }) }));
    expect(decide({ start: context, cursors: work, observations })).toEqual([{
      type: "begin-amendment", agent: activeRoster[0], submissionSha: gitSha(activeRoster[0]!), request: observations.at(-1)!.amendmentRequest
    }]);
  });

  it("orders all four consensus participants at the join gate", () => {
    const decisions = decide({ start, cursors: initialCursors(start, now) });
    expect(decisions).toEqual(
      roster.map((agent) => ({ type: "prepare-action", agent, stepId: "R1.join", round: null }))
    );
  });

  it("advances only after the active gate denominator is satisfied", () => {
    const base = initialCursors(start, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R2.plan", gateId: "gate-2-plans", round: null },
      accepted: roster.slice(0, 3).map((agent) => accepted("R2.plan", agent))
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "prepare-action", agent: "antigravity", stepId: "R2.plan", round: null }
    ]);
    const complete = cursorsStateSchema.parse({ ...cursors, accepted: roster.map((agent) => accepted("R2.plan", agent)) });
    expect(decide({ start, cursors: complete })).toEqual([
      { type: "advance-step", from: "R2.plan", to: "R3.review", round: null }
    ]);
  });

  it("degrades future work to solo checks when one active agent remains", () => {
    const base = initialCursors(start, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      activeRoster: ["claude"],
      droppedAgents: ["codex", "cursor", "antigravity"],
      issueCursor: { stepId: "R5.compare", gateId: "gate-5-comparison", round: null }
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "advance-step", from: "R5.compare", to: "R7.finalize", round: null }
    ]);
  });

  it("concludes round three by deriving consensus and scheduling only objectors for follow-up filing", () => {
    const base = initialCursors(start, now);
    const reviseCursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 3 },
      derived: { ...base.derived, implementationSelection: implementationDerived },
      acceptedResponses: consensusResponses(3, "codex"),
      ballotBatches: [consensusBatch(3)]
    });
    expect(decide({ start, cursors: reviseCursors })).toEqual([
      { type: "derive-consensus", round: 3 }
    ]);

    const escalateCursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 3 },
      derived: { ...base.derived, implementationSelection: implementationDerived },
      acceptedResponses: consensusResponses(3, null, "codex"),
      ballotBatches: [consensusBatch(3)]
    });
    expect(decide({ start, cursors: escalateCursors })).toEqual([
      { type: "derive-consensus", round: 3 }
    ]);

    const followUpCursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.follow-up", gateId: "gate-6-consensus", round: 3 },
      derived: {
        ...base.derived,
        implementationSelection: implementationDerived,
        consensus: {
          kind: "consensus",
          algorithm: "revision-limit-active-roster-v1",
          inputSetHash: "c".repeat(64),
          activeRoster: roster,
          inputs: [
            {
              kind: "revision",
              agent: "cursor",
              submissionSha: "e".repeat(40),
              path: ".signals/issue-1/revision-ready-cursor-round-3.json"
            }
          ],
          decisionId: `consensus:${"c".repeat(64)}:r3`,
          supersedes: null,
          decidedAt: now,
          round: 3,
          consensusPin: "d".repeat(40),
          objectors: ["codex"]
        }
      }
    });
    expect(decide({ start, cursors: followUpCursors })).toEqual([
      { type: "prepare-action", agent: "codex", stepId: "R6.follow-up", round: 3 }
    ]);

    const receiptAcceptedCursors = cursorsStateSchema.parse({
      ...followUpCursors,
      accepted: [
        {
          stepId: "R6.follow-up",
          agent: "codex",
          round: 3,
          submissionSha: "e".repeat(40),
          path: ".signals/issue-1/follow-up-ready-codex-round-3.json",
          acceptedAt: now,
          followUpIssue: 101,
          followUpUrl: "https://github.com/example/repo/issues/101"
        }
      ]
    });
    expect(decide({ start, cursors: receiptAcceptedCursors })).toEqual([
      { type: "advance-step", from: "R6.follow-up", to: "R7.finalize", round: null }
    ]);
  });

  it("routes revision work to the persisted authorized reviser", () => {
    const base = initialCursors(start, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.revise", gateId: "gate-6-consensus", round: 1 },
      derived: {
        planSelection: null,
        implementationSelection: {
          kind: "implementation-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "d".repeat(64),
          activeRoster: roster,
          inputs: [
            {
              kind: "implementation",
              agent: "cursor",
              submissionSha: "e".repeat(40),
              path: ".signals/issue-1/implementation-ready-cursor.json",
              productPin: "d".repeat(40)
            }
          ],
          decisionId: `implementation-selection:${"d".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          winner: "cursor",
          implementationPin: "d".repeat(40),
          reviser: "cursor"
        },
        consensus: null
      }
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "prepare-action", agent: "cursor", stepId: "R6.revise", round: 1 }
    ]);
  });

  it("routes reviewed implementation to the selected plan winner", () => {
    const reviewed = startStateSchema.parse({ ...start, profile: "reviewed" });
    const base = initialCursors(reviewed, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
      derived: {
        planSelection: {
          kind: "plan-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "d".repeat(64),
          activeRoster: reviewed.originalRoster,
          inputs: [
            {
              kind: "plan",
              agent: "cursor",
              submissionSha: "e".repeat(40),
              path: ".plans/issue-1/plan-cursor.md"
            }
          ],
          decisionId: `plan-selection:${"d".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          selectedAgents: ["cursor"]
        },
        implementationSelection: null,
        consensus: null
      }
    });
    expect(decide({ start: reviewed, cursors })).toEqual([
      { type: "prepare-action", agent: "cursor", stepId: "R4.implement", round: null }
    ]);
  });

  it("advances revise dispositions through round three and types escalations", () => {
    const base = initialCursors(start, now);
    const revision = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
      derived: { ...base.derived, implementationSelection: implementationDerived },
      acceptedResponses: consensusResponses(1, "codex"),
      ballotBatches: [consensusBatch(1)]
    });
    expect(decide({ start, cursors: revision })).toEqual([
      { type: "advance-step", from: "R6.ballot", to: "R6.revise", round: 2 }
    ]);
    const escalation = cursorsStateSchema.parse({
      ...revision,
      acceptedResponses: consensusResponses(1, null, "codex")
    });
    expect(decide({ start, cursors: escalation })).toEqual([
      {
        type: "owner-action-required",
        reason: "consensus ballot round 1 requested escalation",
        kind: "ballot-escalation",
        round: 1,
        allowedAnswers: ["retry", "revise", "abandon"]
      }
    ]);
  });

  it("does not advance a ballot gate before the evidence batch is published", () => {
    const base = initialCursors(start, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
      derived: { ...base.derived, implementationSelection: implementationDerived },
      acceptedResponses: consensusResponses(1, null),
      ballotBatches: []
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "publish-ballot-batch", stepId: "R6.ballot", round: 1 }
    ]);
  });

  it("ignores a published batch whose response digests no longer match the closed set", () => {
    const base = initialCursors(start, now);
    const responses = consensusResponses(1, null);
    const stale = publishedBallotBatchFixture({
      kind: "consensus-ballot-batch",
      activeRoster: base.activeRoster,
      round: 1,
      commitSha: "9".repeat(40)
    });
    stale.responses = stale.responses.map((entry) => ({
      ...entry,
      responseSha256: "f".repeat(64)
    }));
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
      derived: { ...base.derived, implementationSelection: implementationDerived },
      acceptedResponses: responses,
      ballotBatches: [stale],
      evidence: { branch: "issue-1/coordinator-evidence", tip: "9".repeat(40) }
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "publish-ballot-batch", stepId: "R6.ballot", round: 1 }
    ]);
  });

  it("keeps retry and rejection separate from acceptance", () => {
    const base = initialCursors(start, now);
    const actionId = "ce80f31a-6884-42cf-b0ff-b0fb27fc6cc8";
    const cursors = cursorsStateSchema.parse({
      ...base,
      agents: {
        ...base.agents,
        claude: { ...base.agents.claude, actionId, stepId: "R1.join", evidenceId: "join-published", status: "verifying" }
      }
    });
    expect(
      decide({
        start,
        cursors,
        observations: [
          { agent: "claude", actionId, submissionSha: "d".repeat(40), status: "retry", outstanding: ["fetch failed"] }
        ]
      })
    ).toEqual([{ type: "retry-verification", agent: "claude", outstanding: ["fetch failed"] }]);
  });

  it("processes an in-flight satisfied observation before repeating an owner question", () => {
    const base = initialCursors(start, now);
    const actionId = "ce80f31a-6884-42cf-b0ff-b0fb27fc6cc8";
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
      ownerQuestion: {
        id: "10000000-0000-4000-8000-000000000001",
        kind: "ballot-escalation",
        round: 1,
        allowedAnswers: ["retry", "revise", "abandon"],
        createdAt: now
      },
      agents: {
        ...base.agents,
        claude: {
          ...base.agents.claude,
          actionId,
          stepId: "R6.ballot",
          evidenceId: "consensus-response-accepted",
          submissionMode: "response",
          status: "verifying"
        }
      }
    });
    expect(
      decide({
        start,
        cursors,
        observations: [
          {
            agent: "claude",
            actionId,
            submissionSha: "d".repeat(40),
            status: "satisfied",
            outstanding: [],
            disposition: "approve",
            responseSha256: "e".repeat(64),
            rationale: "Looks good."
          }
        ]
      })
    ).toEqual([
      {
        type: "accept-response",
        agent: "claude",
        responseSha256: "e".repeat(64),
        rationale: "Looks good.",
        disposition: "approve"
      }
    ]);
  });
});
