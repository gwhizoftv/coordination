import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import {
  appendJournal,
  enqueueOwnerGuidance,
  bindOwnerGuidance,
  ownerGuidanceFor,
  resetOwnerGuidance,
  suspendOwnerGuidance,
  consensusDerivedSchema,
  cursorsStateSchema,
  dropAgent,
  implementationSelectionDerivedSchema,
  initializeOperationalState,
  mutateCursorsState,
  planSelectionDerivedSchema,
  readCursorsState,
  readJournal,
  readStartState,
  replaceCursor,
  setPaused,
  releaseHold,
  releaseResourceHold,
  StateConflictError,
  startStateSchema,
  coordinatorConfigSchema,
  writeCursorsState
} from "../src/state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const initialize = () => {
  const workspace = mkdtempSync(join(tmpdir(), "coord-state-"));
  roots.push(workspace);
  const root = join(workspace, "coord-runtime");
  mkdirSync(root, { recursive: true });
  const paths = issueRuntimePaths(root, 1, join(workspace, "completes"));
  createIssueRuntime(paths, ["claude", "codex"]);
  return {
    paths,
    ...initializeOperationalState(
      paths,
      {
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
        origin: "file:///origin.git",
        coordRoot: root,
        configPath: join(root, "config.json"),
        agents: [
          { id: "claude", root: "/clones/claude", launcher: "start-claude.sh", delivery: "nudge" },
          { id: "codex", root: "/clones/codex", launcher: "start-codex.sh", delivery: "pull" }
        ],
        checks: [{ name: "check", argv: ["pnpm", "check"] }],
        pollIntervalMs: 1000
      },
      "2026-08-11T10:00:00.000Z"
    )
  };
};

describe("operational state", () => {
  it("defaults legacy accepted action identity and preserves it across ordering and restart", () => {
    const { paths, cursors } = initialize();
    const legacy = JSON.parse(JSON.stringify(cursors));
    delete legacy.agents.codex.lastAcceptedActionId;
    const parsed = cursorsStateSchema.parse(legacy);
    expect(parsed.agents.codex.lastAcceptedActionId).toBeNull();
    const id = "10000000-0000-4000-8000-000000000001";
    const accepted = replaceCursor(parsed, "codex", { lastAcceptedActionId: id });
    writeCursorsState(paths, replaceCursor(accepted, "codex", { actionId: "20000000-0000-4000-8000-000000000002", status: "ordered" }));
    expect(readCursorsState(paths).agents.codex.lastAcceptedActionId).toBe(id);
  });

  it("defaults old guidance state and freezes each cohort without draining later advice on reissue", () => {
    const { paths, cursors } = initialize();
    const legacy = { ...cursors };
    delete legacy.ownerGuidance;
    let state = cursorsStateSchema.parse(legacy);
    expect(state.ownerGuidance).toEqual({ pending: [], bound: null, suspended: null, generation: 0 });
    const entry = { id: "10000000-0000-4000-8000-000000000001", text: "First advice", enqueuedAt: state.updatedAt };
    writeCursorsState(paths, enqueueOwnerGuidance(state, entry));
    state = cursorsStateSchema.parse(bindOwnerGuidance(readCursorsState(paths), "R6.ballot", 1, state.updatedAt));
    writeCursorsState(paths, enqueueOwnerGuidance(state, { ...entry, id: "10000000-0000-4000-8000-000000000002", text: "Next advice" }));
    const restarted = readCursorsState(paths);
    expect(bindOwnerGuidance(restarted, "R6.ballot", 1, state.updatedAt)).toBe(restarted);
    expect(ownerGuidanceFor(restarted, "R6.ballot", 1)).toEqual(["First advice"]);
    expect(restarted.ownerGuidance!.pending).toHaveLength(1);
    const retry = bindOwnerGuidance(resetOwnerGuidance(restarted), "R6.ballot", 1, state.updatedAt);
    expect(ownerGuidanceFor(retry, "R6.ballot", 1)).toEqual(["Next advice"]);
    expect(ownerGuidanceFor(retry, "R6.ballot", 2)).toEqual([]);
    expect(retry.ownerGuidance!.pending).toEqual([]);
  });

  it("preserves pending advice across legacy in-flight work and restores interrupted amendment work", () => {
    const { cursors } = initialize();
    const entry = { id: "10000000-0000-4000-8000-000000000001", text: "Product advice", enqueuedAt: cursors.updatedAt };
    const queued = enqueueOwnerGuidance(cursors, entry);
    const inFlight = bindOwnerGuidance({ ...queued, agents: { ...queued.agents,
      codex: { ...queued.agents.codex!, stepId: "R4.implement", actionId: entry.id } } }, "R4.implement", null, cursors.updatedAt);
    expect(ownerGuidanceFor(inFlight, "R4.implement", null)).toEqual([]);
    expect(inFlight.ownerGuidance!.pending).toHaveLength(1);
    const product = bindOwnerGuidance(queued, "R4.implement", null, cursors.updatedAt);
    const ballot = bindOwnerGuidance(suspendOwnerGuidance(product), "R4.amend-ballot", 1, cursors.updatedAt);
    expect(ownerGuidanceFor(ballot, "R4.amend-ballot", 1)).toEqual([]);
    const resumed = bindOwnerGuidance(resetOwnerGuidance(ballot), "R4.implement", null, cursors.updatedAt);
    expect(ownerGuidanceFor(resumed, "R4.implement", null)).toEqual(["Product advice"]);
    expect(resumed.ownerGuidance!.suspended).toBeNull();
  });

  it("rejects blank, multiline, control, oversized and overflowing guidance without changing state", () => {
    const { cursors } = initialize();
    const entry = { id: "10000000-0000-4000-8000-000000000001", text: "Advice", enqueuedAt: cursors.updatedAt };
    for (const text of [" ", "\nadvice", "advice\n", "a\tb", "a\x1bb", "a".repeat(2001)]) {
      expect(() => enqueueOwnerGuidance(cursors, { ...entry, text })).toThrow();
    }
    let full = cursors;
    for (let i = 0; i < 32; i++) full = enqueueOwnerGuidance(full, { ...entry, id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}` });
    expect(() => enqueueOwnerGuidance(full, { ...entry, id: "20000000-0000-4000-8000-000000000001" })).toThrow(/full/);
    expect(() => enqueueOwnerGuidance({ ...cursors, completed: true }, entry)).toThrow(/completed/);
    expect(cursors.ownerGuidance!.pending).toEqual([]);
  });

  it("defaults old format-4 amendment state and durably cancels a pending proposal on drop", () => {
    const { paths, start, cursors } = initialize();
    const legacy = { ...cursors };
    delete legacy.amendmentSequence;
    delete legacy.pendingAmendment;
    delete legacy.amendments;
    delete legacy.amendmentRetirements;
    expect(cursorsStateSchema.parse(legacy)).toMatchObject({ amendmentSequence: 0, pendingAmendment: null, amendments: [], amendmentRetirements: [] });
    const pending = {
      sequence: 3, request: { agent: "codex", commitSha: "d".repeat(40), path: ".signals/issue-1/implementation-ready-codex.json" },
      proposal: {
        protocolVersion: 1, artifact: "plan-amendment-request", issue: 1, issueSessionId: start.issueSessionId,
        agent: "codex", actionId: "10000000-0000-4000-8000-000000000001", inputSetHash: "e".repeat(64), scopeHash: "f".repeat(64),
        explanation: "Necessary regression", additionalPaths: [{ path: "test/product.test.ts", reason: "Missing test" }]
      },
      plans: [{ agent: "codex", commitSha: "c".repeat(40), path: ".plans/issue-1/plan.md" }],
      activeRoster: cursors.activeRoster, resume: { stepId: "R6.revise", round: 2 }, requestedAt: start.createdAt
    };
    writeCursorsState(paths, cursorsStateSchema.parse({ ...cursors, amendmentSequence: 3, pendingAmendment: pending,
      issueCursor: { stepId: "R4.amend-ballot", gateId: "gate-4-implementations", round: 3 } }));
    expect(readCursorsState(paths).pendingAmendment).toEqual(pending);
    writeCursorsState(paths, dropAgent(readCursorsState(paths), "claude"));
    const after = readCursorsState(paths);
    expect(after.pendingAmendment).toBeNull();
    expect(after.amendmentSequence).toBe(3);
    expect(after.amendments).toEqual([expect.objectContaining({ ...pending, outcome: "cancelled", evidenceSha: null, ballots: [] })]);
    expect(after.issueCursor).toEqual({ stepId: "R6.revise", gateId: "gate-6-consensus", round: 2 });
    expect(after.agents.codex?.actionId).toBeNull();
  });

  it("keeps manual and independent holds separate and requires an explicit breaker reset", () => {
    const { paths } = initialize();
    const now = "2026-09-22T12:00:00.000Z";
    const actionId = "10000000-0000-4000-8000-000000000001";
    const id = "20000000-0000-4000-8000-000000000001";
    const otherId = "20000000-0000-4000-8000-000000000002";
    const original = readCursorsState(paths);
    const hold = { id, agent: "codex", actionId, sessionId: null, reason: "nudge-loop", evidenceId: "budget",
      observedAt: now, resetsAt: null, confidence: "unknown", retryOwner: "owner" };
    const held = cursorsStateSchema.parse({ ...original, paused: true, manualPaused: true,
      agents: { ...original.agents, codex: { ...original.agents.codex, actionId } },
      actionSafety: { codex: { actionId, sends: 4, lastSendAt: now, activityAt: now } },
      holds: [hold, { ...hold, id: otherId, reason: "unobservable", evidenceId: "missing" }] });
    expect(() => releaseHold(held, id, false, now)).toThrow(/reset-nudge-budget/);
    expect(() => releaseHold(held, otherId, true, now)).toThrow(/Only a nudge-loop/);
    expect(() => releaseHold({ ...held, abandoned: true }, id, true, now)).toThrow(/retired/);
    expect(() => releaseHold({ ...held, agents: original.agents }, id, true, now)).toThrow(/retired/);
    const plain = setPaused(held, false, now);
    expect(plain.paused).toBe(true);
    expect(plain.holds).toHaveLength(2);
    const released = releaseHold(held, id, true, now);
    expect(released.paused).toBe(true);
    expect(released.manualPaused).toBe(true);
    expect(released.holds.map((entry) => entry.id)).toEqual([otherId]);
    expect(released.actionSafety.codex).toMatchObject({ sends: 0, reserved: false, holdGeneration: 1 });
    expect(released.agents).toEqual(held.agents);
    const last = releaseHold(released, otherId, false, now);
    expect(last.paused).toBe(true); // still manually paused
    expect(setPaused(last, false, now).paused).toBe(false);
  });
  it("releases only a usage-window resource hold and leaves action safety verbatim", () => {
    const { paths } = initialize();
    const now = "2026-09-22T12:00:00.000Z";
    const actionId = "10000000-0000-4000-8000-000000000001";
    const original = readCursorsState(paths);
    // A baseline-shaped hold (no evidence, null reset) still parses.
    const unobservable = { id: "20000000-0000-4000-8000-000000000001", agent: "codex", actionId, sessionId: null,
      reason: "unobservable", evidenceId: "missing", observedAt: now, resetsAt: null, confidence: "unknown", retryOwner: "owner" };
    const window = { source: "codex-app-server", limitId: "codex", window: "primary", usedPercent: 100, windowDurationMins: 300,
      resetsAt: "2026-09-22T15:00:00.000Z" };
    const evidence = { vendor: "codex", failureClass: "usage-window", classConfidence: "confirmed", windows: [window],
      detail: null, episodeId: `${actionId}:codex`, observedAt: now };
    const resource = { ...unobservable, id: "20000000-0000-4000-8000-000000000002", reason: "vendor-failure",
      evidenceId: "quota", resetsAt: window.resetsAt, confidence: "exact", evidence };
    const safety = { actionId, sends: 3, lastSendAt: now, reserved: true, holdGeneration: 2, activityAt: now,
      resource: { starts: 4, consumedDeadlines: [window.resetsAt] } };
    const held = cursorsStateSchema.parse({ ...original, paused: true, manualPaused: true,
      agents: { ...original.agents, codex: { ...original.agents.codex, actionId } },
      actionSafety: { codex: safety }, holds: [unobservable, resource] });
    const released = releaseResourceHold(held, resource.id, now);
    expect(released.holds.map((hold) => hold.id)).toEqual([unobservable.id]);
    expect(released.manualPaused).toBe(true);
    expect(released.paused).toBe(true);
    expect(released.actionSafety.codex).toEqual(held.actionSafety.codex);
    expect(() => releaseResourceHold(held, unobservable.id, now)).toThrow(/usage-window/);
    const billing = cursorsStateSchema.parse({ ...held, holds: [{ ...resource, evidence: { ...evidence, failureClass: "billing" } }] });
    expect(() => releaseResourceHold(billing, resource.id, now)).toThrow(/usage-window/);
    expect(() => releaseResourceHold({ ...held, agents: original.agents }, resource.id, now)).toThrow(/retired/);
    // Deadline confidence is exact only with a provider epoch.
    expect(() => cursorsStateSchema.parse({ ...held, holds: [{ ...resource, resetsAt: null }] })).toThrow();
    const owner = releaseHold(held, resource.id, false, now);
    expect(owner.actionSafety.codex?.resource).toEqual(held.actionSafety.codex?.resource);
  });

  it("accepts a codexQuota binding only as an absolute home on the codex agent", () => {
    const config = {
      project: "p", origin: "https://github.com/example/p.git", branch: "issue-{issue}/{agent}",
      checks: [{ name: "check", argv: ["true"] }],
      agents: [{ id: "codex", root: "/c", launcher: "start-codex.sh", codexQuota: { codexHome: "/home/o/.codex", accountId: "acct" } }]
    };
    expect(coordinatorConfigSchema.parse(config).agents[0]?.codexQuota).toEqual({ codexHome: "/home/o/.codex", accountId: "acct" });
    const withBinding = (agent: Record<string, unknown>) => ({ ...config, agents: [{ ...config.agents[0], ...agent }] });
    expect(() => coordinatorConfigSchema.parse(withBinding({ codexQuota: { codexHome: "relative/.codex", accountId: "acct" } }))).toThrow();
    expect(() => coordinatorConfigSchema.parse(withBinding({ codexQuota: { codexHome: "/home/o/../o/.codex", accountId: "acct" } }))).toThrow();
    expect(() => coordinatorConfigSchema.parse(withBinding({ codexQuota: { codexHome: "/home/o/.codex", accountId: " " } }))).toThrow();
    expect(coordinatorConfigSchema.parse(withBinding({ codexQuota: { codexHome: "/home/o/.codex", accountId: "acct", validatedVersion: "0.156.1" } }))
      .agents[0]?.codexQuota?.validatedVersion).toBe("0.156.1");
    expect(() => coordinatorConfigSchema.parse(withBinding({ codexQuota: { codexHome: "/home/o/.codex", accountId: "acct", validatedVersion: "latest" } }))).toThrow();
    expect(() => coordinatorConfigSchema.parse(withBinding({ id: "claude", launcher: "start-claude.sh" }))).toThrow(/only valid on the codex agent/);
  });

  it("writes strict versioned start, cursor, and journal state atomically", () => {
    const { paths } = initialize();
    expect(readStartState(paths)).toMatchObject({ formatVersion: 4, maxRevisionRounds: 3 });
    expect(readCursorsState(paths).activeRoster).toEqual(["claude", "codex"]);
    expect(readJournal(paths).map((event) => event.type)).toEqual(["started"]);
    appendJournal(paths, { type: "paused", details: {} }, "2026-08-11T10:01:00.000Z");
    expect(readJournal(paths).at(-1)?.sequence).toBe(1);
  });

  it("freezes a verification policy at start, and still parses a start.json written without one", () => {
    const { paths } = initialize();
    const legacy = readStartState(paths);
    expect(legacy.verification).toBeUndefined();
    expect(legacy.verificationDigest).toBeUndefined();
    const verification = { mode: "coordinator" as const, maxConcurrentExpensive: 2,
      coordinated: { precommit: [], prepush: [] },
      candidate: { checks: [{ name: "check", argv: ["pnpm", "check"] }], covers: { prefixes: ["src/"], files: [] }, rules: [] } };
    writeFileSync(paths.start, JSON.stringify({ ...legacy, verification, verificationDigest: "d".repeat(64) }));
    expect(readStartState(paths)).toMatchObject({ verification, verificationDigest: "d".repeat(64) });
  });

  it("persists pause and drop state but refuses a zero-agent workflow", () => {
    const { paths, cursors } = initialize();
    let next = setPaused(cursors, true, "2026-08-11T10:01:00.000Z");
    next = dropAgent(next, "codex", "2026-08-11T10:02:00.000Z");
    writeCursorsState(paths, next);
    expect(readCursorsState(paths)).toMatchObject({ paused: true, activeRoster: ["claude"], droppedAgents: ["codex"] });
    expect(() => dropAgent(next, "claude")).toThrow("final active agent");
  });

  it("fails closed on an unsupported revision limit or unknown state fields", () => {
    const { cursors, start } = initialize();
    expect(cursorsStateSchema.safeParse({ ...cursors, mystery: true }).success).toBe(false);
    expect(cursorsStateSchema.safeParse({ ...cursors, formatVersion: 1 }).success).toBe(false);
    expect(startStateSchema.safeParse({ ...start, maxRevisionRounds: 4 }).success).toBe(false);
  });

  it("rejects runtime format version 2 with wipe and restart guidance", () => {
    const { paths } = initialize();
    writeFileSync(
      paths.cursors,
      `${JSON.stringify({ ...readCursorsState(paths), formatVersion: 2 }, null, 2)}\n`
    );
    expect(() => readCursorsState(paths)).toThrow(/Wipe this issue/);
  });

  it("rejects runtime format version 3 with wipe and restart guidance", () => {
    const { paths } = initialize();
    writeFileSync(
      paths.cursors,
      `${JSON.stringify({ ...readCursorsState(paths), formatVersion: 3 }, null, 2)}\n`
    );
    expect(() => readCursorsState(paths)).toThrow(/Wipe this issue/);
  });

  it("rejects stale whole-state writes after an owner control revision", () => {
    const { paths } = initialize();
    const stale = readCursorsState(paths);
    const paused = mutateCursorsState(paths, (current) => setPaused(current, true, "2026-08-11T10:01:00.000Z"));
    expect(paused.state.stateRevision).toBe(stale.stateRevision + 1);
    const staleWrite = mutateCursorsState(paths, () => stale, stale.stateRevision);
    expect(staleWrite.applied).toBe(false);
    expect(staleWrite.state.paused).toBe(true);
    expect(new StateConflictError("conflict").name).toBe("StateConflictError");
  });
});

describe("derived decision state", () => {
  const inputSetHash = "d".repeat(64);
  const decidedAt = "2026-08-11T10:00:00.000Z";
  const base = {
    inputSetHash,
    activeRoster: ["claude", "codex"],
    inputs: [
      {
        kind: "plan" as const,
        agent: "codex",
        submissionSha: "a".repeat(40),
        path: ".plans/issue-1/plan.md"
      }
    ],
    supersedes: null,
    decidedAt
  };

  it("requires a cited input and a hash-bound identity for every derived decision", () => {
    const records = [
      {
        schema: planSelectionDerivedSchema,
        value: {
          ...base,
          kind: "plan-selection" as const,
          algorithm: "plurality-active-roster-v1" as const,
          decisionId: `plan-selection:${inputSetHash}`,
          selectedAgents: ["codex"]
        }
      },
      {
        schema: implementationSelectionDerivedSchema,
        value: {
          ...base,
          kind: "implementation-selection" as const,
          algorithm: "plurality-active-roster-v1" as const,
          decisionId: `implementation-selection:${inputSetHash}`,
          winner: "codex",
          implementationPin: "b".repeat(40),
          reviser: "codex"
        }
      },
      {
        schema: consensusDerivedSchema,
        value: {
          ...base,
          kind: "consensus" as const,
          algorithm: "unanimous-active-roster-v1" as const,
          decisionId: `consensus:${inputSetHash}:r2`,
          round: 2,
          consensusPin: "b".repeat(40)
        }
      }
    ];

    for (const { schema, value } of records) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, inputs: [] }).success).toBe(false);
      expect(schema.safeParse({ ...value, decisionId: "arbitrary" }).success).toBe(false);
      expect(schema.safeParse({ ...value, decisionId: value.decisionId.replace(inputSetHash, "e".repeat(64)) }).success).toBe(
        false
      );
    }
  });

  it("binds consensus decision identities to their persisted round", () => {
    const value = {
      ...base,
      kind: "consensus" as const,
      algorithm: "unanimous-active-roster-v1" as const,
      decisionId: `consensus:${inputSetHash}:r2`,
      round: 1,
      consensusPin: "b".repeat(40)
    };
    expect(consensusDerivedSchema.safeParse(value).success).toBe(false);
  });

  it("records a revision-limit conclusion only at the final round, with ordered objectors", () => {
    const unanimous = {
      ...base,
      kind: "consensus" as const,
      algorithm: "unanimous-active-roster-v1" as const,
      decisionId: `consensus:${inputSetHash}:r3`,
      round: 3,
      consensusPin: "b".repeat(40)
    };
    const concluded = {
      ...unanimous,
      activeRoster: ["claude", "codex", "cursor"],
      algorithm: "revision-limit-active-roster-v1" as const,
      objectors: [{ agent: "claude", disposition: "revise" as const }, { agent: "cursor", disposition: "escalate" as const }]
    };
    // Existing persisted unanimous records still load unchanged.
    expect(consensusDerivedSchema.safeParse(unanimous).success).toBe(true);
    expect(consensusDerivedSchema.safeParse(concluded).success).toBe(true);
    const malformed = [
      { ...unanimous, objectors: concluded.objectors },
      { ...concluded, objectors: undefined },
      { ...concluded, objectors: [] },
      { ...concluded, round: 2, decisionId: `consensus:${inputSetHash}:r2` },
      { ...concluded, objectors: [...concluded.objectors].reverse() },
      { ...concluded, objectors: [{ agent: "antigravity", disposition: "revise" as const }] },
      { ...concluded, objectors: [{ agent: "claude", disposition: "approve" }] }
    ];
    for (const value of malformed) expect(consensusDerivedSchema.safeParse(value).success).toBe(false);
  });
});

const configFixture = (contextPaths?: unknown) => ({
  project: "coordination",
  origin: "https://github.com/example/coordination.git",
  agents: [{ id: "claude", root: "../coordination-claude", launcher: "start-claude.sh" }],
  branch: "issue-{issue}/{agent}",
  checks: [{ name: "check", argv: ["pnpm", "check"] }],
  ...(contextPaths === undefined ? {} : { contextPaths })
});

describe("context paths", () => {
  it("defaults to an empty list and accepts confined product-relative files", () => {
    expect(coordinatorConfigSchema.parse(configFixture()).contextPaths).toEqual([]);
    expect(coordinatorConfigSchema.parse(configFixture(["docs/repo-map.md"])).contextPaths).toEqual([
      "docs/repo-map.md"
    ]);
  });

  it("refuses escapes and duplicates the way digest paths are refused", () => {
    expect(coordinatorConfigSchema.safeParse(configFixture(["/etc/passwd"])).success).toBe(false);
    expect(coordinatorConfigSchema.safeParse(configFixture(["../secrets.md"])).success).toBe(false);
    expect(coordinatorConfigSchema.safeParse(configFixture(["a/../../b.md"])).success).toBe(false);
    expect(coordinatorConfigSchema.safeParse(configFixture(["docs/x.md", "docs/x.md"])).success).toBe(false);
  });

  /**
   * An issue started before this field existed must keep running after the
   * upgrade: start.json is strict, so a missing key has to parse, not fail.
   */
  it("parses a start state written before the field existed", () => {
    const { start } = initialize();
    const legacy: Record<string, unknown> = { ...start };
    delete legacy.contextPaths;
    const parsed = startStateSchema.safeParse(legacy);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(parsed.success && parsed.data.contextPaths).toEqual([]);
  });

  /**
   * The defaulted field must not become a required constructor argument: every
   * existing `initializeOperationalState` call site omits it.
   */
  it("keeps the field optional at the typed initializer boundary", () => {
    const { start } = initialize();
    expect(start.contextPaths).toEqual([]);
  });
});
