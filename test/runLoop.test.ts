import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAction, writeAction } from "../src/action.js";
import { computeInputSetHash } from "../src/evidence.js";
import { writeCloneAgentsProtocol } from "../src/agentsProtocol.js";
import { git, repoRoot } from "./support/workspaceFixture.js";
import { decideLifecycleNudge, initialAgentLifecycle, observeAgentLifecycle, readAgentLifecycle } from "../src/agentLifecycle.js";
import { BareMirror } from "../src/mirror.js";
import { agentResponsePath, agentRuntimePaths, createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import {
  materializeBoundInputs,
  pruneSupersededWorktrees,
  worktreeLabelsFor
} from "../src/materializedInputs.js";
import {
  buildOrder,
  computeDerivedInputSetHash,
  computePlanSelectionDerived,
  computeConsensusDerived,
  CoordinatorRunLoop,
  derivedDecisionJournalDetails,
  deterministicWinner,
  githubRepositoryFromOrigin,
  NUDGE_RETRY_MS,
  resolveApprovedPaths,
  resolveChangeScope,
  CHANGE_SCOPE_PATH_LIMIT
} from "../src/runLoop.js";
import {
  cursorsStateSchema,
  appendJournal,
  dropAgent,
  initializeOperationalState,
  mutateCursorsState,
  readCursorsState,
  readJournal,
  readStartState,
  setPaused,
  releaseHold,
  writeCursorsState
} from "../src/state.js";
import { TmuxController } from "../src/tmux.js";
import type { CodexQuotaReader, CodexQuotaResult } from "../src/codexQuota.js";
import { readBindingRecord } from "../src/codexQuota.js";
import { parseClaudeRateLimits, parseCodexRateLimits } from "../src/resourceEvidence.js";
import { resourceBindingPaths } from "../src/paths.js";
import type { RunLoopDependencies } from "../src/runLoop.js";
import { writeAgentResponse } from "../src/ballotResponse.js";
import { queueOwnerGuidance, dropOwnerAgent } from "../src/ownerControls.js";
import type { ConsensusBallotResponse } from "../src/protocol.js";
import type { AcceptedResponse, AcceptedSubmission, BallotBatch } from "../src/state.js";
import { createHash, randomUUID } from "node:crypto";
import { hookVerificationRecorder, createVerificationIngestor, verificationMeasurement } from "../src/verificationLog.js";
import * as stateModule from "../src/state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const responseDigestFixture = (seed: string): string =>
  createHash("sha256").update(seed, "utf8").digest("hex");
const gitShaFixture = (seed: string): string =>
  createHash("sha256").update(`git:${seed}`, "utf8").digest("hex").slice(0, 40);
const actionIdFor = (agent: string, index = 0): string => {
  const nibble = (agent.charCodeAt(0) % 10).toString();
  const suffix = `${nibble}${index}`.padStart(12, "0").slice(-12);
  return `10000000-0000-4000-8000-${suffix}`;
};
const acceptedResponseFixture = (input: {
  stepId: AcceptedResponse["stepId"];
  agent: string;
  round?: number | null;
  choice?: string;
  disposition?: AcceptedResponse["disposition"];
  acceptedAt?: string;
  actionId?: string;
  responseSha256?: string;
  rationale?: string;
  path?: string;
}): AcceptedResponse => {
  const actionId = input.actionId ?? actionIdFor(input.agent);
  return {
    stepId: input.stepId,
    agent: input.agent,
    actionId,
    round: input.round === undefined ? null : input.round,
    responseSha256: input.responseSha256 ?? responseDigestFixture(input.agent),
    rationale: input.rationale ?? "fixture rationale",
    path: input.path ?? `/runtime/accepted-responses/${input.agent}/${actionId}.json`,
    acceptedAt: input.acceptedAt ?? "2026-08-11T12:00:00.000Z",
    ...(input.choice === undefined ? {} : { choice: input.choice }),
    ...(input.disposition === undefined ? {} : { disposition: input.disposition })
  };
};
const publishedBallotBatchFixture = (input: {
  kind: BallotBatch["kind"];
  activeRoster: readonly string[];
  round?: number | null;
  commitSha?: string;
  parentSha?: string;
  inputSetHash?: string;
  createdAt?: string;
  status?: BallotBatch["status"];
  batchId?: string;
}): BallotBatch => {
  const now = input.createdAt ?? "2026-08-11T12:00:00.000Z";
  const round = input.round === undefined ? null : input.round;
  return {
    batchId: input.batchId ?? "20000000-0000-4000-8000-000000000001",
    kind: input.kind,
    round,
    inputSetHash: input.inputSetHash ?? responseDigestFixture("batch"),
    activeRoster: [...input.activeRoster],
    responses: input.activeRoster.map((agent) => ({
      agent,
      actionId: actionIdFor(agent),
      responseSha256: responseDigestFixture(agent)
    })),
    paths: input.activeRoster.map((agent) =>
      input.kind === "plan-ballot-batch"
        ? `.plans/issue-1/ballot-${agent}.json`
        : input.kind === "comparison-ballot-batch"
          ? `.code-reviews/issue-1/ballot-${agent}.json`
          : `.code-reviews/issue-1/consensus-ballot-${agent}-round-${round ?? 1}.json`
    ),
    branch: "issue-1/coordinator-evidence",
    parentSha: input.parentSha ?? gitShaFixture("a"),
    commitSha: input.commitSha ?? gitShaFixture("b"),
    status: input.status ?? "published",
    attempts: 1,
    error: null,
    supersedes: null,
    createdAt: now,
    updatedAt: now
  };
};

const fixture = (options: { prPolicy?: "owner-only" | "coord-open-unmerged" | "coord-merged"; origin?: string } = {}) => {
  const workspace = mkdtempSync(join(tmpdir(), "coord-loop-"));
  roots.push(workspace);
  // Coord root and mailbox both inside the fixture's own directory, so the
  // receipts this test writes and clears cannot be seen by a parallel worker
  // and are removed with the rest of the fixture.
  const root = join(workspace, "coord-runtime");
  mkdirSync(root, { recursive: true });
  const paths = issueRuntimePaths(root, 1, join(workspace, "completes"));
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
    prPolicy: options.prPolicy ?? "owner-only",
    automationDigest: "b".repeat(64),
    automationDigestScheme: "sha256-length-prefixed-v1",
    automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
    trustedSourceCommit: "c".repeat(40),
    origin: options.origin ?? "/origin.git",
    coordRoot: root,
    configPath: join(root, "config.json"),
    agents: [
      { id: "claude", root: "/clones/claude", launcher: "start-claude.sh", delivery: "pull" },
      { id: "codex", root: "/clones/codex", launcher: "start-codex.sh", delivery: "pull" }
    ],
    checks: [{ name: "check", argv: ["node", "-e", "process.exit(0)"] }],
    pollIntervalMs: 100
  });
  return { root, paths };
};

const safetyFixture = (vendor = "codex", dependencies: RunLoopDependencies = {}) => {
  const { paths } = fixture();
  let nowMs = Date.parse("2026-09-22T12:00:00.000Z");
  const now = () => new Date(nowMs).toISOString();
  const start = readStartState(paths);
  writeFileSync(paths.start, JSON.stringify({ ...start, profile: "solo", originalRoster: [vendor],
    agents: [{ ...start.agents[0], id: vendor, delivery: "both", harnessProcess: "harness", nudgePrelude: [], nudgeSubmit: ["Enter"] }] }));
  createIssueRuntime(paths, [vendor]);
  const current = readCursorsState(paths);
  writeCursorsState(paths, cursorsStateSchema.parse({ ...current, activeRoster: [vendor], agents: { [vendor]: current.agents.codex } }));
  writeFileSync(paths.agentLifecycle, JSON.stringify(initialAgentLifecycle([vendor], now())));
  const ui = { foreground: "harness", busy: false, dead: false, text: "❯ Antigravity Gemini >", failSubmit: false,
    failInspect: false, failCapture: false, waitAtCapture: Infinity, sends: 0, inspections: 0, captures: 0,
    onCapture: undefined as (() => void) | undefined, onSend: undefined as (() => void) | undefined };
  const messages: string[] = [];
  const tmux = new TmuxController(async (args) => {
    if (args[0] === "display-message") {
      ui.inspections++;
      if (ui.failInspect) throw new Error("inspection unavailable");
      return { exitCode: 0, stdout: `${ui.dead ? 1 : 0}\t${ui.foreground}\t${ui.busy ? 1 : 0}\t0\n`, stderr: "" };
    }
    if (args[0] === "capture-pane") {
      ui.captures++;
      ui.onCapture?.();
      if (ui.failCapture) throw new Error("capture unavailable");
      return { exitCode: 0, stdout: ui.captures >= ui.waitAtCapture ? "Usage limit reset · continuing automatically\n❯" : ui.text, stderr: "" };
    }
    if (args[0] === "send-keys" && args.includes("-l")) { ui.sends++; ui.onSend?.(); }
    if (args[0] === "send-keys" && args.includes("Enter") && ui.sends > 0 && ui.failSubmit) throw new Error("connection lost");
    return { exitCode: 0, stdout: "", stderr: "" };
  }, undefined, undefined, undefined, async () => undefined);
  // Every tick uses a new coordinator: all protections must be durable.
  const makeLoop = (extra: RunLoopDependencies = {}) => new CoordinatorRunLoop(paths, { tmux, now, nudgeRetryMs: 1,
    log: (message) => messages.push(message), ...dependencies, ...extra });
  const tick = () => makeLoop().runTick();
  let turn = 0;
  const working = () => {
    const action = readAgentLifecycle(paths).agents[vendor]!.action!;
    observeAgentLifecycle(paths, vendor, { kind: "prompt-submitted", eventName: "prompt", sessionId: "session", turnId: `turn-${++turn}`,
      actionId: action.actionId, actionDigest: action.actionDigest }, now());
  };
  const stop = () => observeAgentLifecycle(paths, vendor, { kind: "stopped", eventName: "stop", sessionId: "session",
    turnId: `turn-${turn}`, backgroundActive: false }, now());
  return { paths, ui, messages, now, tick, makeLoop, working, stop, advance: (ms: number) => { nowMs += ms; } };
};

describe("owner reminders and advisory diagnostics", () => {
  it("rejects a stale menu selection rather than reminding a replacement action", async () => {
    const f = safetyFixture("claude"), loop = f.makeLoop();
    await loop.runTick();
    const selected = loop.reminders()[0]!;
    mutateCursorsState(f.paths, (state) => ({ ...state,
      agents: { ...state.agents, claude: { ...state.agents.claude!, actionId: randomUUID() } }
    }));
    expect(() => selected.request()).toThrow("no longer current");
    expect(f.ui.sends).toBe(1);
  });
  it("reminds the same accepted task only on explicit request and fresh idle proof, retaining spacing and budget", async () => {
    const f = safetyFixture("claude"), loop = f.makeLoop();
    await loop.runTick(); f.advance(1); f.working();
    const runtime = agentRuntimePaths(f.paths, "claude");
    const before = readFileSync(runtime.action, "utf8");
    const id = readCursorsState(f.paths).agents.claude!.actionId;
    f.ui.text = `${id}\nCOORD-IDLE: waiting for the next coordinator action file`;
    expect(loop.reminders()[0]!.request()).toContain("requested");
    await loop.runTick(); // minimum spacing still applies
    expect(f.ui.sends).toBe(1);
    f.advance(60_000);
    await loop.runTick(); // explicit request was consumed; automatic stale-working sends remain forbidden
    expect(f.ui.sends).toBe(1);
    loop.reminders()[0]!.request();
    loop.reminders()[0]!.request(); // one queued request, not two
    await loop.runTick();
    expect(f.ui.sends).toBe(2);
    expect(readCursorsState(f.paths).actionSafety.claude).toMatchObject({ sends: 2, reserved: false });
    expect(readCursorsState(f.paths).agents.claude).toMatchObject({ actionId: id, status: "ordered" });
    expect(readFileSync(runtime.action, "utf8")).toBe(before);
    expect(readAgentLifecycle(f.paths).agents.claude?.execution).toBe("working");
    expect(f.messages.join("\n")).toContain("[OK] Reminder sent");
    for (const delay of [120_000, 240_000]) {
      f.advance(delay); loop.reminders()[0]!.request(); await loop.runTick();
    }
    f.advance(240_000); loop.reminders()[0]!.request();
    const held = await loop.runTick();
    expect(f.ui.sends).toBe(4);
    expect(held.holds[0]?.reason).toBe("nudge-loop");
    expect(held.actionSafety.claude?.sends).toBe(4);
    expect(() => loop.reminders()[0]!.request()).toThrow("Release pauses/holds");
  });

  it.each(["no-idle", "queued", "background", "session", "digest", "pause", "foreground", "typing", "missing-capture", "new-hook"])(
    "refuses a queued reminder on %s without resetting its allowance", async (veto) => {
      const f = safetyFixture("claude"), loop = f.makeLoop();
      await loop.runTick(); f.advance(1); f.working(); f.advance(60_000);
      const runtime = agentRuntimePaths(f.paths, "claude");
      const id = readCursorsState(f.paths).agents.claude!.actionId;
      f.ui.text = `${id}\nCOORD-IDLE: waiting for the next coordinator action file`;
      if (veto === "queued" || veto === "background") observeAgentLifecycle(f.paths, "claude", {
        kind: "status", eventName: "status", sessionId: "session", pendingInputCount: veto === "queued" ? 1 : 0,
        backgroundActive: veto === "background"
      }, f.now());
      loop.reminders()[0]!.request();
      if (veto === "no-idle") f.ui.text = "Working...\n❯ ";
      if (veto === "session") observeAgentLifecycle(f.paths, "claude", { kind: "session-start", eventName: "SessionStart", sessionId: "new-session" }, f.now());
      if (veto === "digest") writeFileSync(runtime.action, `${readFileSync(runtime.action, "utf8")}\nchanged\n`);
      if (veto === "pause") mutateCursorsState(f.paths, (state) => setPaused(state, true, f.now()));
      if (veto === "foreground") f.ui.foreground = "bash";
      if (veto === "typing") f.ui.busy = true;
      if (veto === "missing-capture") f.ui.failCapture = true;
      if (veto === "new-hook") f.ui.onCapture = () => { f.working(); f.ui.onCapture = undefined; };
      await loop.runTick();
      expect(f.ui.sends).toBe(1);
      expect(readCursorsState(f.paths).actionSafety.claude?.sends).toBe(1);
      expect(readCursorsState(f.paths).agents.claude?.actionId).toBe(id);
      expect(f.messages.join("\n")).not.toContain("[OK] Reminder sent");
    });

  it("keeps a charged reservation when owner authority changes after reminder text", async () => {
    const f = safetyFixture("claude"), loop = f.makeLoop();
    await loop.runTick(); f.advance(1); f.working(); f.advance(60_000);
    f.ui.text = "COORD-IDLE: waiting for the next coordinator action file";
    loop.reminders()[0]!.request();
    f.ui.onSend = () => {
      if (f.ui.sends === 2) mutateCursorsState(f.paths, (state) => setPaused(state, true, f.now()));
    };
    await loop.runTick();
    expect(f.ui.sends).toBe(2);
    expect(readCursorsState(f.paths).actionSafety.claude).toMatchObject({ sends: 2, reserved: true });
    expect(readCursorsState(f.paths).manualPaused).toBe(true);
  });

  it("keeps startup and missing-Stop diagnostics advisory and avoids warning on every poll", async () => {
    const f = safetyFixture("claude"), loop = f.makeLoop();
    await loop.reportStartup();
    await loop.reportStartup(); // the foreground run reuses the already-diagnosed startup instance
    expect(f.messages.join("\n")).toContain("runtime hook trust/activity not yet verified");
    expect(f.messages.filter((message) => message.includes("claude: runtime hook trust/activity not yet verified"))).toHaveLength(1);
    // Per-agent tmux placement is reported once, from the same startup pass.
    expect(f.messages.filter((message) => /^\[(OK|WARN)\] claude: (running in|the pane in) coord-/.test(message))).toHaveLength(1);
    await loop.runTick(); f.advance(1); f.working(); f.advance(1); f.working();
    await loop.runTick(); await loop.runTick();
    expect(f.messages.filter((message) => message.includes("No Stop hook from claude after 2 observed turns"))).toHaveLength(1);
    expect(readCursorsState(f.paths).holds).toEqual([]);
    expect(readAgentLifecycle(f.paths).agents.claude).toMatchObject({ health: "healthy", execution: "working" });
    expect(f.ui.sends).toBe(1);
  });
});

const QUOTA_BASE = Date.parse("2026-09-22T12:00:00.000Z");
const hoursFromBase = (hours: number): number => QUOTA_BASE / 1000 + hours * 3600;
const codexLimits = (weeklyPercent: number, resetHours: number, extra: Record<string, unknown> = {}, buckets?: Record<string, unknown>) => {
  const bucket = { limitId: "codex", limitName: null, normalModelSlug: null, credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null, spendControlReached: false, planType: "plus",
    rateLimitReachedType: weeklyPercent >= 100 ? "rate_limit_reached" : null,
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: hoursFromBase(2) },
    secondary: { usedPercent: weeklyPercent, windowDurationMins: 10_080, resetsAt: hoursFromBase(resetHours) } };
  return { status: "ok" as const, reaped: true as const, helper: { userAgent: "codex_cli_rs/0.156.1 (fake)", codexHome: "/owner/.codex" },
    limits: parseCodexRateLimits({ ordinaryUsageAllowed: weeklyPercent < 100,
    rateLimits: bucket, rateLimitsByLimitId: buckets ?? { codex: bucket }, rateLimitResetCredits: null, accountId: "acct-1",
    rateLimitUpsell: null, ...extra }) };
};

/** A codex safety fixture bound to one owner-confirmed home/account, with a scripted reader. */
const quotaFixture = (results: CodexQuotaResult[], during?: () => void, validatedVersion: string | null = "0.156.1", onClock?: () => void) => {
  const reads: string[] = [];
  let clock: () => string = () => "";
  const reader: CodexQuotaReader = async () => {
    reads.push(clock());
    during?.();
    return results.shift() ?? { status: "failed", error: "unscripted", reaped: true };
  };
  const f = safetyFixture("codex", { codexQuota: reader, ...(onClock === undefined ? {} : { now: () => { onClock(); return clock(); } }) });
  clock = f.now;
  const start = readStartState(f.paths);
  writeFileSync(f.paths.start, JSON.stringify({ ...start, agents: [{ ...start.agents[0], codexQuota: {
    codexHome: "/owner/.codex", accountId: "acct-1", ...(validatedVersion === null ? {} : { validatedVersion }) } }] }));
  return { ...f, reads };
};

describe("runner waiting and initialization", () => {
  it("freezes advice before the first recipient and keeps it across partial preparation, restart and reissue", async () => {
    const { paths } = fixture();
    queueOwnerGuidance(paths, "Cohort advice");
    const mirror = new BareMirror(paths.mirror, "/origin.git", async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "" }));
    let count = 0;
    const loop = new CoordinatorRunLoop(paths, { mirror, tmux: null, log: () => undefined, actionId: () => {
      if (++count === 2) queueOwnerGuidance(paths, "Next cohort only");
      return `10000000-0000-4000-8000-${String(count).padStart(12, "0")}`;
    } });
    await loop.runTick(); // concurrent advice invalidates the second preparation's CAS
    expect(readCursorsState(paths).agents.codex!.actionId).toBeNull();
    const restarted = new CoordinatorRunLoop(paths, { mirror, tmux: null, log: () => undefined });
    await restarted.runTick();
    for (const agent of ["claude", "codex"]) {
      const text = readFileSync(agentRuntimePaths(paths, agent).action, "utf8");
      expect(text).toContain("- Cohort advice");
      expect(text).not.toContain("Next cohort only");
    }
    const actionId = readCursorsState(paths).agents.codex!.actionId;
    writeFileSync(agentRuntimePaths(paths, "codex").complete, "malformed\n");
    await restarted.runTick();
    expect(readCursorsState(paths).agents.codex!.actionId).toBe(actionId);
    expect(readFileSync(agentRuntimePaths(paths, "codex").action, "utf8")).toContain("- Cohort advice");
    expect(readCursorsState(paths).ownerGuidance!.pending.map((entry) => entry.text)).toEqual(["Next cohort only"]);
    expect(readJournal(paths).filter((entry) => entry.type === "owner-guidance-bound")).toHaveLength(1);
    expect(readJournal(paths).filter((entry) => entry.type === "owner-guidance-queued")).toHaveLength(2);
    mutateCursorsState(paths, (current) => cursorsStateSchema.parse({ ...current,
      accepted: current.activeRoster.map((agent) => ({ stepId: "R1.join", agent, round: null,
        submissionSha: "c".repeat(40), path: `.signals/issue-1/participation-ready-${agent}.json`, acceptedAt: current.updatedAt })),
      agents: Object.fromEntries(current.activeRoster.map((agent) => [agent,
        { ...current.agents[agent], status: "waiting-peer", actionId: null, submissionSha: null, outstanding: [] }]))
    }));
    await restarted.runTick();
    expect(readCursorsState(paths).issueCursor.stepId).toBe("R2.plan");
    for (const agent of ["claude", "codex"]) {
      const text = readFileSync(agentRuntimePaths(paths, agent).action, "utf8");
      expect(text).toContain("- Next cohort only");
      expect(text).not.toContain("- Cohort advice");
    }
    expect(readCursorsState(paths).ownerGuidance!.pending).toEqual([]);
  });

  it("does not tick after an abort during slow initialization", async () => {
    const { paths } = fixture();
    const controller = new AbortController();
    const mirror = new BareMirror(paths.mirror, "/origin.git", async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "" }));
    const loop = new CoordinatorRunLoop(paths, { mirror, tmux: null, log: () => undefined });
    loop.initializeEffects = async () => { controller.abort(); };
    const tick = vi.spyOn(loop, "runTick");
    await loop.run(controller.signal);
    expect(tick).not.toHaveBeenCalled();
  });

  it.each([false, true])("cancels poll waiting immediately with injected sleep=%s and never starts another tick", async (injected) => {
    vi.useFakeTimers();
    try {
      const { paths } = fixture();
      mutateCursorsState(paths, (current) => setPaused(current, true));
      const controller = new AbortController();
      const loop = new CoordinatorRunLoop(paths, { tmux: null, log: () => undefined,
        ...(injected ? { sleep: () => new Promise<void>(() => {}) } : {}) });
      const tick = vi.spyOn(loop, "runTick");
      const running = loop.run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(injected ? 0 : 1);
      controller.abort();
      await running;
      expect(vi.getTimerCount()).toBe(0);
      expect(tick).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each(["manual", "hold"])("waits through a %s pause and continues in the same runner after release", async (kind) => {
    const f = safetyFixture("claude");
    await f.tick();
    mutateCursorsState(f.paths, (current) => kind === "manual" ? setPaused(current, true, f.now()) :
      cursorsStateSchema.parse({ ...current, paused: true, holds: [{
        id: "20000000-0000-4000-8000-000000000001", agent: "claude", actionId: current.agents.claude!.actionId,
        sessionId: null, reason: "unobservable", evidenceId: "legacy", observedAt: f.now(), resetsAt: null,
        confidence: "unknown", retryOwner: "owner"
      }] }));
    const journal = readFileSync(f.paths.journal, "utf8");
    let initializations = 0;
    let sleeps = 0;
    const mirror = new BareMirror(f.paths.mirror, "/origin.git", async (args) => {
      if (args[0] === "init") initializations++;
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    await f.makeLoop({ tmux: null, mirror, sleep: async (ms) => {
      expect(ms).toBe(readStartState(f.paths).pollIntervalMs);
      sleeps++;
      if (sleeps <= 2) {
        expect(initializations).toBe(0);
        expect(f.ui.sends).toBe(1);
        expect(readFileSync(f.paths.journal, "utf8")).toBe(journal);
      }
      if (sleeps === 2) mutateCursorsState(f.paths, (current) => kind === "manual"
        ? setPaused(current, false, f.now()) : releaseHold(current, current.holds[0]!.id, false, f.now()));
      if (sleeps === 3) {
        expect(initializations).toBe(1);
        expect(readCursorsState(f.paths).paused).toBe(false);
        mutateCursorsState(f.paths, (current) => cursorsStateSchema.parse({ ...current,
          ...(kind === "manual" ? { completed: true } : { abandoned: true }) }));
      }
      if (sleeps > 3) throw new Error("runner did not stop at terminal state");
    } }).run();
    expect(sleeps).toBe(3);
    expect(initializations).toBe(1);
    expect(f.messages.filter((message) => message.includes("Issue 1: paused"))).toHaveLength(1);
  });

  it("defers workflow effects when an owner resumes between the initialization check and the tick", async () => {
    const { paths } = fixture();
    mutateCursorsState(paths, (current) => setPaused(current, true));
    let initializations = 0;
    let sleeps = 0;
    let ticks = 0;
    const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
      if (args[0] === "init") initializations++;
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { mirror, tmux: null, log: () => undefined, sleep: async () => {
      sleeps++;
      expect(readCursorsState(paths).paused).toBe(false);
      expect(initializations).toBe(sleeps === 1 ? 0 : 1);
      for (const agent of ["claude", "codex"]) {
        expect(existsSync(agentRuntimePaths(paths, agent).action)).toBe(sleeps !== 1);
        if (sleeps === 1) expect(readCursorsState(paths).agents[agent]!.actionId).toBeNull();
        else expect(readCursorsState(paths).agents[agent]!.actionId).not.toBeNull();
      }
      if (sleeps === 2) mutateCursorsState(paths, (current) => cursorsStateSchema.parse({ ...current, abandoned: true }));
      if (sleeps > 2) throw new Error("runner did not stop at terminal state");
    } });
    const runTick = loop.runTick.bind(loop);
    loop.runTick = async (...args) => {
      // Model another process releasing the pause after run() decides not to
      // initialize, but before the real tick reads the latest durable state.
      if (++ticks === 1) mutateCursorsState(paths, (current) => setPaused(current, false));
      return runTick(...args);
    };
    await loop.run();
    expect(sleeps).toBe(2);
    expect(ticks).toBe(2);
  });

  it.each([true, false])("reobserves initialization conflicts with paused=%s without hiding other errors", async (pauseOnConflict) => {
    const { paths } = fixture();
    let initializations = 0;
    let sleeps = 0;
    const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
      if (args[0] === "init" && ++initializations === 1) {
        mutateCursorsState(paths, (current) => setPaused(current, pauseOnConflict));
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { mirror, tmux: null, log: () => undefined, sleep: async () => {
      sleeps++;
      if (sleeps === 1) {
        expect(readCursorsState(paths).paused).toBe(pauseOnConflict);
        for (const agent of ["claude", "codex"]) {
          expect(readCursorsState(paths).agents[agent]!.actionId).toBeNull();
          expect(existsSync(agentRuntimePaths(paths, agent).action)).toBe(false);
        }
        mutateCursorsState(paths, (current) => setPaused(current, false));
      } else {
        expect(initializations).toBe(2);
        expect(readCursorsState(paths).agents.codex!.actionId).not.toBeNull();
        mutateCursorsState(paths, (current) => cursorsStateSchema.parse({ ...current, abandoned: true }));
      }
    } });
    await loop.run();
    expect(sleeps).toBe(2);
    mutateCursorsState(paths, (current) => cursorsStateSchema.parse({ ...current, abandoned: false }));
    const failedMirror = new BareMirror(paths.mirror, "/origin.git", async () => { throw new Error("fatal mirror error"); });
    await expect(new CoordinatorRunLoop(paths, { mirror: failedMirror, tmux: null, log: () => undefined }).run())
      .rejects.toThrow("fatal mirror error");
  });
});

describe("vendor resource evidence and recovery", () => {
  const claudeFailure = (f: ReturnType<typeof safetyFixture>, error: string, details: string | null, fiveHour: number) => {
    observeAgentLifecycle(f.paths, "claude", { kind: "telemetry", eventName: "status-line", sessionId: "session",
      rateLimits: parseClaudeRateLimits({ rate_limits: { five_hour: { used_percentage: fiveHour, resets_at: hoursFromBase(2) } } })! }, f.now());
    f.advance(1_000);
    observeAgentLifecycle(f.paths, "claude", { kind: "failed", eventName: "StopFailure", sessionId: "session", backgroundActive: false,
      failure: { vendor: "claude", error, errorDetails: details, lastAssistantMessage: null } }, f.now());
  };

  it("holds a matching Claude window with its exact deadline and rechecks once through run() without a prompt", async () => {
    const f = safetyFixture("claude");
    await f.tick();
    f.advance(1); f.working();
    claudeFailure(f, "rate_limit", null, 100);
    const held = await f.tick();
    expect(held.holds).toEqual([expect.objectContaining({ reason: "vendor-failure", retryOwner: "owner", confidence: "exact",
      resetsAt: new Date(hoursFromBase(2) * 1000).toISOString(), evidence: expect.objectContaining({ failureClass: "usage-window" }) })]);
    expect(held.actionSafety.claude?.sends).toBe(1);
    const journal = readFileSync(f.paths.journal, "utf8");
    const cursors = readFileSync(f.paths.cursors, "utf8");
    const untilRecheck = Date.parse(held.holds[0]!.resetsAt!) + 29_000 - Date.parse(f.now());
    for (let i = 0; i < 1000; i++) { f.advance(untilRecheck / 1000); await f.tick(); }
    expect(readFileSync(f.paths.journal, "utf8")).toBe(journal);
    expect(readFileSync(f.paths.cursors, "utf8")).toBe(cursors);
    let sleeps = 0;
    // The recheck is bounded, but the runner keeps waiting for owner release.
    const controller = new AbortController();
    await f.makeLoop({ sleep: async () => {
      sleeps++; f.advance(1_000);
      if (sleeps === 5) controller.abort();
    } }).run(controller.signal);
    expect(sleeps).toBe(5);
    const after = readCursorsState(f.paths);
    expect(after.holds).toEqual(held.holds);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-updated")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ outcome: "owner-release-required" }) })
    ]);
    expect(f.messages.at(-1)).toContain("owner release required");
    expect(f.messages.filter((message) => message.includes("Issue 1: paused"))).toHaveLength(2);
    expect(f.ui.sends).toBe(1);
    // An owner release is not re-held by the same failure episode.
    mutateCursorsState(f.paths, (current) => releaseHold(current, held.holds[0]!.id, false, f.now()));
    expect((await f.tick()).holds.filter((hold) => hold.reason === "vendor-failure")).toEqual([]);
  });

  it.each([
    ["a model-family restriction", "rate_limit", "Opus weekly limit reached", 100, "usage-window"],
    ["a spend restriction", "billing_error", null, 100, "billing"]
  ])("keeps waiting on %s at an unknown reset without new effects", async (_label, error, details, fiveHour, failureClass) => {
    const f = safetyFixture("claude");
    await f.tick();
    f.advance(1); f.working();
    claudeFailure(f, error, details, fiveHour);
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ reason: "vendor-failure", resetsAt: null, confidence: "unknown", evidence: { failureClass } });
    let sleeps = 0;
    const journal = readFileSync(f.paths.journal, "utf8");
    const cursors = readFileSync(f.paths.cursors, "utf8");
    const controller = new AbortController();
    await f.makeLoop({ sleep: async () => { if (++sleeps === 3) controller.abort(); } }).run(controller.signal);
    expect(sleeps).toBe(3);
    expect(readFileSync(f.paths.cursors, "utf8")).toBe(cursors);
    expect(readFileSync(f.paths.journal, "utf8")).toBe(journal);
    expect(f.ui.sends).toBe(1);
    expect(f.messages.filter((message) => message.includes("Issue 1: paused"))).toHaveLength(1);
    f.advance(7 * 86400_000);
    for (let i = 0; i < 200; i++) await f.tick();
    expect(readFileSync(f.paths.journal, "utf8")).toBe(journal);
  });

  it("leaves throttling and unknown Claude failures on the budgeted #126 path", async () => {
    const f = safetyFixture("claude");
    await f.tick();
    f.advance(1); f.working();
    claudeFailure(f, "rate_limit", null, 20);
    expect((await f.tick()).holds).toEqual([]);
    expect(readAgentLifecycle(f.paths).agents.claude?.lastFailure?.evidence.failureClass).toBe("throttled");
  });

  it("bounds Codex reads across restarts: spacing, delayed retries, shifted deadlines and six starts", async () => {
    const f = quotaFixture([
      codexLimits(20, 50),
      codexLimits(100, 50),
      { status: "failed", error: "exit 1", reaped: true },
      codexLimits(100, 60),
      codexLimits(100, 70),
      codexLimits(100, 80)
    ]);
    await f.tick(); // prepares and sends the action
    expect(f.ui.sends).toBe(1);
    await f.tick(); // one persisted initial binding check
    expect(f.reads).toHaveLength(1);
    for (let i = 0; i < 20; i++) await f.tick();
    expect(f.reads).toHaveLength(1); // no idle polling
    f.ui.dead = true;
    f.advance(60_000);
    await f.tick(); // #126 harness-gone hold is the watchdog trigger
    for (let i = 0; i < 5000; i++) { f.advance(60_000); await f.tick(); }
    expect(f.reads).toHaveLength(6);
    const gaps = f.reads.slice(1).map((at, index) => Date.parse(at) - Date.parse(f.reads[index]!));
    expect(gaps.every((gap) => gap >= 300_000)).toBe(true);
    // The failed read retried after five minutes, not at the next tick.
    expect(Date.parse(f.reads[3]!) - Date.parse(f.reads[2]!)).toBe(300_000);
    expect(Date.parse(f.reads[2]!)).toBeGreaterThanOrEqual(hoursFromBase(50) * 1000 + 30_000);
    const final = readCursorsState(f.paths);
    expect(final.actionSafety.codex?.resource).toMatchObject({ starts: 6, terminal: "the quota observation budget for this action is spent" });
    expect(final.holds.map((hold) => hold.reason)).toEqual(["harness-gone", "vendor-failure"]);
    expect(final.actionSafety.codex?.sends).toBe(1);
    const events = readJournal(f.paths);
    expect(events.filter((event) => event.type === "hold-created")).toHaveLength(2);
    expect(events.filter((event) => event.type === "resource-observation")).toHaveLength(1);
    expect(events.filter((event) => event.type === "hold-updated")).toHaveLength(3); // one per shifted deadline
  });

  it.each([
    ["releases only its resource hold on complete fresh clearance", codexLimits(30, 200), undefined, false],
    ["keeps the hold when a previously blocked window is missing", (() => {
      const other = { limitId: "other", primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null }, secondary: null };
      return codexLimits(30, 200, { rateLimits: other }, { other });
    })(), undefined, true],
    ["keeps the hold when the deadline did not advance", codexLimits(100, 50), undefined, true],
    ["keeps the hold when a manual pause arrives during the read", codexLimits(30, 200), "pause", true],
    ["keeps the hold when the agent's lifecycle changes during the read", codexLimits(30, 200), "lifecycle", true],
    ["keeps the hold when the binding changes during the read", codexLimits(30, 200), "rebind", true]
  ])("%s", async (_label, second, during, stillHeld) => {
    let pause = false;
    const f = quotaFixture([codexLimits(100, 50), second], () => {
      if (!pause) return;
      if (during === "pause") mutateCursorsState(f.paths, (current) => setPaused(current, true, f.now()));
      if (during === "lifecycle") observeAgentLifecycle(f.paths, "codex", { kind: "stopped", eventName: "Stop", sessionId: "session" }, f.now());
      if (during === "rebind") {
        const start = readStartState(f.paths);
        writeFileSync(f.paths.start, JSON.stringify({ ...start, agents: [{ ...start.agents[0], codexQuota: {
          ...start.agents[0]!.codexQuota, codexHome: "/other/.codex" } }] }));
      }
    });
    await f.tick();
    const held = await f.tick();
    expect(held.holds).toEqual([expect.objectContaining({ reason: "vendor-failure", confidence: "exact",
      evidence: expect.objectContaining({ vendor: "codex", failureClass: "usage-window" }) })]);
    expect(f.ui.sends).toBe(1);
    pause = during !== undefined;
    f.advance(hoursFromBase(50) * 1000 + 30_000 - Date.parse(f.now()));
    const after = await f.tick();
    expect(f.reads).toHaveLength(2);
    expect(after.holds.length === 1).toBe(stillHeld);
    if (during === "lifecycle" || during === "rebind") {
      // A stale snapshot neither holds nor releases; it re-queues a read under the binding spacing.
      expect(after.actionSafety.codex?.resource).toMatchObject({ terminal: null, nextAt: f.now() });
    }
    const released = readJournal(f.paths).filter((event) => event.type === "hold-released");
    expect(released).toHaveLength(stillHeld ? 0 : 1);
    if (!stillHeld) {
      expect(released[0]?.details).toMatchObject({ automatic: true });
      expect(after.paused).toBe(false);
      expect(after.actionSafety.codex).toEqual(held.actionSafety.codex && { ...held.actionSafety.codex,
        resource: after.actionSafety.codex?.resource }); // the send budget was never refilled
    }
  });

  const bucketLimits = (windows: Record<string, [percent: number, resetHours: number, duration?: number]>, unreported: string[] = []) => {
    const buckets = Object.fromEntries(Object.entries(windows).map(([limitId, [usedPercent, hours, duration]]) => [limitId, {
      limitId, rateLimitReachedType: null, secondary: null,
      ...(unreported.includes(limitId) ? {} : { spendControlReached: false }),
      primary: { usedPercent, windowDurationMins: duration ?? 300, resetsAt: hoursFromBase(hours) } }]));
    return { status: "ok" as const, reaped: true as const, helper: { userAgent: "codex_cli_rs/0.156.1", codexHome: "/owner/.codex" },
      limits: parseCodexRateLimits({ ordinaryUsageAllowed: Object.values(windows).every(([percent]) => percent < 100),
        rateLimits: Object.values(buckets)[0], rateLimitsByLimitId: buckets, accountId: "acct-1" }) };
  };

  it("retains an earlier blocker that a later partial snapshot omits, so it can never clear by absence", async () => {
    const f = quotaFixture([
      bucketLimits({ a: [100, 50], b: [100, 40] }),
      bucketLimits({ a: [100, 70] }), // b omitted, a's deadline advanced
      bucketLimits({ a: [10, 90] }) // a clear, b still omitted
    ]);
    await f.tick();
    await f.tick();
    for (const hours of [50, 70]) {
      f.advance(hoursFromBase(hours) * 1000 + 30_000 - Date.parse(f.now()));
      await f.tick();
      if (hours === 50) {
        const hold = readCursorsState(f.paths).holds[0]!;
        expect(hold.evidence?.windows.map((window) => window.limitId).sort()).toEqual(["a", "b"]);
        expect(hold.resetsAt).toBe(new Date(hoursFromBase(70) * 1000).toISOString());
      }
    }
    expect(f.reads).toHaveLength(3);
    expect(readCursorsState(f.paths).holds).toHaveLength(1);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-released")).toHaveLength(0);
  });

  it.each([
    // Each third read would clear the hold if the earlier blocker had been dropped or overwritten.
    ["a below-limit window whose bucket omits its restriction fields",
      bucketLimits({ a: [100, 70], b: [20, 40] }, ["b"]), bucketLimits({ a: [10, 90] }), "b"],
    ["a new blocker with a different window length",
      bucketLimits({ a: [100, 70, 60] }), bucketLimits({ a: [10, 90, 60], b: [10, 90] }), "a"]
  ])("keeps an earlier blocker past %s", async (_label, second, third, kept) => {
    const f = quotaFixture([bucketLimits({ a: [100, 50], b: [100, 40] }), second, third]);
    await f.tick();
    await f.tick();
    for (const hours of [50, 70]) {
      f.advance(hoursFromBase(hours) * 1000 + 30_000 - Date.parse(f.now()));
      await f.tick();
      if (hours === 50) {
        // The original 300-minute window survives beside anything newer.
        expect(readCursorsState(f.paths).holds[0]?.evidence?.windows
          .some((window) => window.limitId === kept && window.windowDurationMins === 300)).toBe(true);
      }
    }
    expect(f.reads).toHaveLength(3);
    expect(readCursorsState(f.paths).holds).toHaveLength(1);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-released")).toHaveLength(0);
  });

  it("holds lifecycle exclusion from the staleness check through the cursor update", async () => {
    let afterRead = false;
    let lockHeld: boolean | null = null;
    let lockPath = "";
    const f = quotaFixture([codexLimits(100, 50), codexLimits(30, 200)], () => { afterRead = true; }, "0.156.1", () => {
      // The first clock read after the helper returns is taken inside the fenced section.
      if (afterRead && lockHeld === null) lockHeld = existsSync(lockPath);
    });
    lockPath = `${f.paths.agentLifecycle}.lock`;
    await f.tick();
    await f.tick();
    afterRead = false;
    lockHeld = null;
    f.advance(hoursFromBase(50) * 1000 + 30_000 - Date.parse(f.now()));
    await f.tick();
    expect(lockHeld).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fails closed when a read reports more blockers than evidence can carry", async () => {
    const f = quotaFixture([bucketLimits(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`b${index}`, [100, 50]])))]);
    await f.tick();
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ resetsAt: null, confidence: "unknown" });
    expect(held.holds[0]?.evidence?.windows).toHaveLength(16);
    expect(held.actionSafety.codex?.resource.terminal).toBe("more blocked windows than can be tracked");
    for (let i = 0; i < 200; i++) { f.advance(600_000); await f.tick(); }
    expect(f.reads).toHaveLength(1);
  });

  it.each([
    ["no owner-validated version", null, codexLimits(30, 200)],
    ["a helper reporting another version", "0.156.1", { ...codexLimits(30, 200), helper: { userAgent: "codex_cli_rs/0.157.0", codexHome: "/owner/.codex" } }],
    ["a helper that does not state its version", "0.156.1", { ...codexLimits(30, 200), helper: { userAgent: null, codexHome: "/owner/.codex" } }]
  ])("keeps a cleared usage-window hold for the owner with %s", async (_label, validatedVersion, second) => {
    const f = quotaFixture([codexLimits(100, 50), second], undefined, validatedVersion);
    await f.tick();
    await f.tick();
    f.advance(hoursFromBase(50) * 1000 + 30_000 - Date.parse(f.now()));
    const after = await f.tick();
    expect(f.reads).toHaveLength(2);
    expect(after.holds).toHaveLength(1);
    expect(after.actionSafety.codex?.resource.terminal).toBe("automatic recovery is not validated for this Codex installation");
    expect(readJournal(f.paths).filter((event) => event.type === "hold-released")).toHaveLength(0);
  });

  it.each([
    ["a different account", codexLimits(20, 50, { accountId: "acct-2" })],
    ["no account id", codexLimits(20, 50, { accountId: null })],
    ["a non-ChatGPT account", { status: "identity" as const, error: "api key", reaped: true }]
  ])("sends %s to the owner as an account hold without further reads", async (_label, result) => {
    const f = quotaFixture([result]);
    await f.tick();
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ reason: "vendor-failure", evidence: { failureClass: "auth-account" } });
    for (let i = 0; i < 500; i++) { f.advance(600_000); await f.tick(); }
    expect(f.reads).toHaveLength(1);
  });

  it("never starts a second helper over one that was not proved reaped", async () => {
    const f = quotaFixture([{ status: "failed", error: "helper timed out", reaped: false }]);
    await f.tick();
    await f.tick();
    const binding = readBindingRecord(resourceBindingPaths(f.paths.coordRoot, "/owner/.codex", "acct-1"));
    expect(binding?.inFlight).not.toBeNull();
    f.ui.dead = true;
    for (let i = 0; i < 200; i++) { f.advance(600_000); await f.tick(); }
    expect(f.reads).toHaveLength(1);
    expect(readCursorsState(f.paths).actionSafety.codex?.resource.terminal).toMatch(/not proved reaped/);
  });
});

describe("durable delivery safety", () => {
  it.each(["claude", "codex"])("keeps %s minute-boundary probes out of durable cursor state", async (vendor) => {
    const f = safetyFixture(vendor);
    await f.tick(); f.advance(1); f.working();
    const loop = f.makeLoop();
    await loop.runTick();
    const before = readFileSync(f.paths.cursors, "utf8");
    const inspections = f.ui.inspections;
    for (let minute = 0; minute < 10; minute++) {
      f.advance(60_000);
      await loop.runTick();
      expect(readFileSync(f.paths.cursors, "utf8")).toBe(before);
    }
    expect(f.ui.inspections - inspections).toBe(10);
    await f.tick(); // even a restarted advisory probe must not rewrite authority
    expect(readFileSync(f.paths.cursors, "utf8")).toBe(before);
  });

  it("retains distinct unknown deferral diagnostics with a bounded overflow record", async () => {
    const f = safetyFixture();
    await f.tick();
    const start = readStartState(f.paths);
    const action = readAgentLifecycle(f.paths).agents.codex!.action!;
    let current = readCursorsState(f.paths);
    for (let index = 0; index < 12; index++) {
      current = f.makeLoop()["journalDeferral"](start, current, "codex", action.actionId, action.actionDigest,
        "scrape", `new-reason-${index}`, "unknown refusal", `diagnostic-${index}`);
    }
    const events = readJournal(f.paths).filter((event) => event.type === "nudge-deferred");
    expect(events).toHaveLength(9); // eight distinct unknown codes plus one overflow
    expect(events[0]?.details).toMatchObject({ code: "new-reason-0", detail: "diagnostic-0" });
    expect(events[1]?.details).toMatchObject({ code: "new-reason-1", detail: "diagnostic-1" });
    expect(events.at(-1)?.details.furtherUnknownCodesSuppressed).toBe(true);
    expect(current.actionSafety.codex?.deferrals).toHaveLength(9);
    const before = readFileSync(f.paths.cursors, "utf8");
    f.makeLoop()["journalDeferral"](start, current, "codex", action.actionId, action.actionDigest,
      "scrape", "new-reason-1", "changed wording", "changed diagnostic");
    expect(readFileSync(f.paths.cursors, "utf8")).toBe(before);
  });

  it("deduplicates A/B/A and append-before-cursor recovery without repeated writes", async () => {
    const f = safetyFixture();
    f.ui.foreground = "bash";
    await f.tick();
    await f.tick(); // initial local observation
    const before = readFileSync(f.paths.cursors, "utf8");
    const lifecycleBefore = readFileSync(f.paths.agentLifecycle, "utf8");
    for (let i = 0; i < 30; i++) await f.tick();
    expect(readFileSync(f.paths.cursors, "utf8")).toBe(before);
    expect(readFileSync(f.paths.agentLifecycle, "utf8")).toBe(lifecycleBefore);
    f.ui.busy = true;
    await f.tick();
    f.ui.busy = false;
    await f.tick();
    const events = () => readJournal(f.paths).filter((event) => event.type === "nudge-deferred");
    expect(events().map((event) => event.details.code)).toEqual(["foreground-mismatch", "owner-typing"]);
    mutateCursorsState(f.paths, (current) => ({ ...current, actionSafety: { codex: { ...current.actionSafety.codex!, deferrals: [] } } }));
    await f.tick(); // journal append already durable; cursor replacement had not happened
    expect(events()).toHaveLength(2);
    expect(readCursorsState(f.paths).actionSafety.codex?.sends).toBe(0);
  });

  it.each(["codex", "claude", "cursor", "antigravity"])("bounds %s across restarts, fresh idle epochs and the diagnostic knob", async (vendor) => {
    const f = safetyFixture(vendor);
    await f.tick();
    expect(f.ui.sends).toBe(1);
    for (const [i, delay] of [60_000, 120_000, 240_000].entries()) {
      f.advance(1); f.working(); f.stop();
      f.advance(delay - 2);
      await f.tick();
      expect(f.ui.sends).toBe(i + 1);
      f.advance(1);
      await f.tick();
      expect(f.ui.sends).toBe(i + 2);
    }
    f.advance(1); f.working();
    expect((await f.tick()).paused).toBe(false); // do not interrupt the last working attempt
    f.advance(1); f.stop();
    const held = await f.tick();
    expect(held.holds).toEqual([expect.objectContaining({ reason: "nudge-loop", agent: vendor, confidence: "unknown", resetsAt: null })]);
    const journal = readFileSync(f.paths.journal, "utf8");
    const action = readFileSync(agentRuntimePaths(f.paths, vendor).action, "utf8");
    writeFileSync(agentRuntimePaths(f.paths, vendor).complete, "incoming bytes\n");
    f.advance(7 * 86400_000);
    for (let i = 0; i < 1000; i++) await f.tick();
    expect(readFileSync(f.paths.journal, "utf8")).toBe(journal);
    expect(readFileSync(agentRuntimePaths(f.paths, vendor).action, "utf8")).toBe(action);
    expect(readFileSync(agentRuntimePaths(f.paths, vendor).complete, "utf8")).toBe("incoming bytes\n");
    expect(f.ui.sends).toBe(4);
    expect(held.activeRoster).toEqual([vendor]);
    expect(held.actionSafety[vendor]?.sends).toBe(4);
  });

  it("charges partial sends and does not retry them on restart", async () => {
    const f = safetyFixture(); f.ui.failSubmit = true;
    const held = await f.tick();
    expect(held.holds[0]?.reason).toBe("delivery-uncertain");
    expect(held.actionSafety.codex).toMatchObject({ sends: 1, reserved: true });
    f.ui.failSubmit = false;
    f.advance(60_000); await f.tick();
    expect(f.ui.sends).toBe(1);
    const released = releaseHold(held, held.holds[0]!.id, false, f.now());
    expect(released.actionSafety.codex).toMatchObject({ sends: 1, reserved: false });
  });

  it.each(["codex", "claude", "cursor"])("reconciles %s's delayed submit hook without pane confirmation or another send", async (vendor) => {
    const f = safetyFixture(vendor);
    f.ui.failSubmit = true;
    const held = await f.tick();
    expect(held.holds[0]?.reason).toBe("delivery-uncertain");
    f.ui.failSubmit = false;
    f.ui.text = "Working... still rendering the previous turn";
    f.advance(1);
    f.working(); // exact current action UUID/digest, with no Working or empty-composer proof
    const recovered = await f.tick();
    expect(recovered.holds).toEqual([]);
    expect(recovered.paused).toBe(false);
    expect(recovered.actionSafety[vendor]).toMatchObject({ sends: 1, reserved: false });
    expect(readAgentLifecycle(f.paths).agents[vendor].action?.delivery).toBe("accepted");
    expect(f.ui.sends).toBe(1);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-released")).toHaveLength(1);
    await f.tick();
    expect(f.ui.sends).toBe(1);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-released")).toHaveLength(1);
  });

  it.each([false, true])("accepts a matching hook during the batch, transport failure=%s", async (failSubmit) => {
    const f = safetyFixture();
    f.ui.failSubmit = failSubmit;
    f.ui.onSend = () => { f.advance(1); f.working(); };
    const after = await f.tick();
    expect(after.holds).toEqual([]);
    expect(after.actionSafety.codex).toMatchObject({ sends: 1, reserved: false });
    expect(readAgentLifecycle(f.paths).agents.codex.action?.delivery).toBe("accepted");
    expect(f.ui.sends).toBe(1);
  });

  it("does not clear uncertainty for an unmatched hook or a prior attempt's acceptance", async () => {
    const f = safetyFixture(); f.ui.failSubmit = true;
    await f.tick();
    const action = readAgentLifecycle(f.paths).agents.codex.action!;
    f.advance(1);
    observeAgentLifecycle(f.paths, "codex", { kind: "prompt-submitted", eventName: "UserPromptSubmit", sessionId: "session",
      actionId: action.actionId, actionDigest: "f".repeat(64) }, f.now());
    expect((await f.tick()).holds[0]?.reason).toBe("delivery-uncertain");
    f.working();
    f.advance(1);
    mutateCursorsState(f.paths, (current) => ({ ...current, actionSafety: { codex: { ...current.actionSafety.codex!, lastSendAt: f.now() } } }));
    expect((await f.tick()).holds[0]?.reason).toBe("delivery-uncertain");
  });

  it("acknowledges delivery while retaining manual pause and unrelated holds", async () => {
    const f = safetyFixture(); f.ui.failSubmit = true;
    const held = await f.tick();
    mutateCursorsState(f.paths, (current) => ({ ...current, manualPaused: true,
      holds: [...current.holds, { ...held.holds[0]!, id: randomUUID(), reason: "vendor-wait", evidenceId: "other" }] }));
    f.advance(1); f.working();
    const after = await f.tick();
    expect(after).toMatchObject({ manualPaused: true, paused: true });
    expect(after.holds.map((hold) => hold.reason)).toEqual(["vendor-wait"]);
    expect(after.actionSafety.codex).toMatchObject({ sends: 1, reserved: false });
    expect(f.ui.sends).toBe(1);
  });

  it.each(["codex", "claude", "cursor", "antigravity"])("delivers after %s Stop with background work and stale busy pane text", async (vendor) => {
    const f = safetyFixture(vendor);
    await f.tick(); f.advance(1); f.working();
    observeAgentLifecycle(f.paths, vendor, { kind: "stopped", eventName: "Stop", sessionId: "session", turnId: "turn-1", backgroundActive: true }, f.now());
    f.ui.text = "Working... esc to cancel";
    f.advance(60_000);
    const after = await f.tick();
    expect(after.holds).toEqual([]);
    expect(f.ui.sends).toBe(2);
    expect(readJournal(f.paths)).toContainEqual(expect.objectContaining({ type: "nudged", agent: vendor,
      details: expect.objectContaining({ readiness: "stop-hook" }) }));
    await f.tick();
    expect(f.ui.sends).toBe(2);
  });

  it("restores a crashed reservation as a hold instead of authorizing another send", async () => {
    const f = safetyFixture();
    await f.tick();
    mutateCursorsState(f.paths, (current) => ({ ...current, actionSafety: { codex: {
      ...current.actionSafety.codex!, sends: 2, reserved: true
    } } }));
    const held = await f.tick();
    expect(held.holds[0]?.reason).toBe("delivery-uncertain");
    expect(held.actionSafety.codex?.sends).toBe(2);
    expect(f.ui.sends).toBe(1);
  });

  it.each(["claude", "codex"])("ignores legacy exhausted observation counters for %s after restart", async (vendor) => {
    const f = safetyFixture(vendor);
    await f.tick();
    f.ui.text = readCursorsState(f.paths).agents[vendor]!.actionId!;
    mutateCursorsState(f.paths, (current) => ({ ...current, actionSafety: { [vendor]: {
      ...current.actionSafety[vendor]!, observationChecks: 3, nextObservationAt: f.now()
    } } }));
    f.advance(30 * 60_000);
    const after = await f.tick();
    expect(after.paused).toBe(false);
    expect(after.holds).toEqual([]);
    expect(f.ui.sends).toBe(1);
  });

  it("recovers the original hold ID after append-before-cursor failure", async () => {
    const f = safetyFixture();
    await f.tick();
    const before = readCursorsState(f.paths);
    f.ui.dead = true;
    const held = await f.tick();
    writeCursorsState(f.paths, before);
    const recovered = await f.tick();
    expect(recovered.holds).toEqual(held.holds);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-created")).toHaveLength(1);
    expect(readJournal(f.paths).filter((event) => event.type === "paused")).toHaveLength(1);
  });

  it.each(["claude", "codex"])("requires owner release of a legacy %s unobservable hold", async (vendor) => {
    const f = safetyFixture(vendor);
    await f.tick();
    f.ui.dead = true;
    await f.tick();
    mutateCursorsState(f.paths, (current) => ({ ...current,
      holds: current.holds.map((hold) => ({ ...hold, reason: "unobservable" as const }))
    }));
    const before = readCursorsState(f.paths);
    f.ui.dead = false; f.advance(1); f.working();
    const marker = `${"d".repeat(40)}\n`;
    writeFileSync(agentRuntimePaths(f.paths, vendor).complete, marker);
    const after = await f.tick();
    expect(after.paused).toBe(true);
    expect(after.holds).toEqual(before.holds);
    expect(readFileSync(agentRuntimePaths(f.paths, vendor).complete, "utf8")).toBe(marker);
    expect(releaseHold(after, after.holds[0]!.id, false, f.now()).paused).toBe(false);
    expect(f.ui.sends).toBe(1);
  });

  it("does not let simultaneous coordinators send duplicate initial prompts", async () => {
    const f = safetyFixture();
    await Promise.all([f.tick(), f.tick()]);
    expect(f.ui.sends).toBe(1);
    expect(readCursorsState(f.paths).actionSafety.codex?.sends).toBe(1);
  });

  it("holds a Claude native wait without touching the send budget", async () => {
    const f = safetyFixture("claude");
    f.ui.text = "Usage limit reached\nContinuing automatically\n❯";
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ reason: "vendor-wait", retryOwner: "vendor", resetsAt: null });
    expect(held.actionSafety.claude?.sends).toBe(0);
    f.ui.text = "❯";
    expect((await f.tick()).paused).toBe(true); // banner disappearance is not release
    expect(f.ui.sends).toBe(0);
  });

  it("keeps native ownership without charging when a Claude wait appears before the batch", async () => {
    const f = safetyFixture("claude");
    f.ui.waitAtCapture = 2; // final recapture before reserving the batch
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ reason: "vendor-wait", retryOwner: "vendor" });
    expect(held.actionSafety.claude).toMatchObject({ sends: 0, reserved: false });
    expect(f.ui.sends).toBe(0);
    expect((await f.tick()).holds).toEqual(held.holds);
  });

  it.each(["claude", "codex", "cursor", "antigravity"].flatMap((vendor) =>
    [false, true].flatMap((working) => [false, true].map((changingOutput) => ({ vendor, working, changingOutput })))
  ))("waits for quiet $vendor work with accepted=$working and changing output=$changingOutput", async ({ vendor, working, changingOutput }) => {
    const f = safetyFixture(vendor);
    await f.tick();
    const actionId = readCursorsState(f.paths).agents[vendor]!.actionId!;
    // Keep the action visible so this never supplies positive lost-delivery evidence.
    f.ui.text = actionId;
    if (working) { f.advance(1); f.working(); await f.tick(); }
    await f.tick(); // record the ordinary delivery deferral before advancing time
    const messages = [...f.messages];
    const execution = readAgentLifecycle(f.paths).agents[vendor]!.execution;
    for (const delay of [300_000, 60_000, 60_000, 30 * 60_000]) {
      f.advance(delay);
      if (changingOutput) f.ui.text = `${actionId}\nRunning tests at ${f.now()}`;
      const after = await f.tick();
      expect(after.paused).toBe(false);
      expect(after.holds).toEqual([]);
      expect(readAgentLifecycle(f.paths).agents[vendor]).toMatchObject({ execution, degradedCause: null });
    }
    expect(readAgentLifecycle(f.paths).agents[vendor]?.health).not.toBe("degraded");
    expect(readJournal(f.paths).some((event) => event.type === "agent-observability-degraded")).toBe(false);
    expect(f.messages).toEqual(messages);
    expect(f.messages.join("\n")).not.toMatch(/unobservable|degraded|Restart/);
    expect(f.ui.sends).toBe(1);
  });

  it.each([
    { vendor: "claude", failure: "inspect" },
    { vendor: "claude", failure: "capture" },
    { vendor: "codex", failure: "inspect" }
  ].flatMap((input) => [false, true].map((working) => ({ ...input, working }))))(
    "bounds failed $failure observations for $vendor with accepted=$working", async ({ vendor, failure, working }) => {
      const f = safetyFixture(vendor);
      await f.tick(); f.advance(1);
      f.ui.text = readCursorsState(f.paths).agents[vendor]!.actionId!;
      if (working) f.working();
      f.ui.failInspect = failure === "inspect";
      f.ui.failCapture = failure === "capture";
      const verbose: string[] = [];
      const loop = f.makeLoop({ verbose: (message) => verbose.push(message) });
      const operation = failure === "inspect" ? "inspection" : "capture";
      const failures = () => verbose.filter((message) => message.includes(`pane ${operation} failed`));
      await loop.runTick();
      expect(failures()).toHaveLength(1);
      expect(failures()[0]).toContain(`${operation} unavailable`);
      const before = { inspections: f.ui.inspections, captures: f.ui.captures };
      for (let i = 0; i < 10; i++) { f.advance(1_000); expect((await loop.runTick()).paused).toBe(false); }
      expect(f.ui.inspections).toBe(before.inspections);
      expect(f.ui.captures).toBe(before.captures);
      expect(failures()).toHaveLength(1);
      f.advance(50_000);
      expect((await loop.runTick()).holds).toEqual([]);
      expect(f.ui.inspections).toBe(before.inspections + 1);
      expect(f.ui.captures).toBe(before.captures + (vendor === "claude" && failure === "capture" ? 1 : 0));
      expect(failures()).toHaveLength(2);
      expect(f.messages.join("\n")).not.toContain(`pane ${operation} failed`);
      f.ui.failInspect = false; f.ui.failCapture = false; f.ui.dead = true;
      f.advance(60_000);
      expect((await loop.runTick()).holds[0]?.reason).toBe("harness-gone");
      expect(f.ui.sends).toBe(1);
    }
  );

  it.each(["claude", "codex"].flatMap((vendor) => [420_000, 30 * 60_000].map((delay) => ({ vendor, delay }))))(
    "validates $vendor completion after $delay ms of quiet work", async ({ vendor, delay }) => {
      const f = safetyFixture(vendor);
      await f.tick(); f.advance(1); f.working();
      const actionId = readCursorsState(f.paths).agents[vendor]!.actionId!;
      for (const wait of [300_000, 60_000]) { f.advance(wait); await f.tick(); }
      f.advance(delay - 360_000);
      const sha = "d".repeat(40);
      const start = readStartState(f.paths);
      const mirror = new BareMirror(f.paths.mirror, start.origin, async (args) => {
        if (args[2] === "rev-parse") return { exitCode: 0, stdout: Buffer.from(`${sha}\n`), stderr: "" };
        if (args[2] === "show") return { exitCode: 0, stdout: Buffer.from(JSON.stringify({
          protocolVersion: 1, artifact: "participation-ready", issue: start.issue, issueSessionId: start.issueSessionId,
          agent: vendor, baselineSha: start.baselineSha, automationDigest: start.automationDigest
        })), stderr: "" };
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      });
      writeFileSync(agentRuntimePaths(f.paths, vendor).complete, `${sha}\n`);
      const after = await f.makeLoop({ mirror }).runTick();
      expect(after.paused).toBe(false);
      expect(after.accepted).toContainEqual(expect.objectContaining({ agent: vendor, stepId: "R1.join", submissionSha: sha }));
      expect(readJournal(f.paths)).toContainEqual(expect.objectContaining({ type: "agent-lifecycle", agent: vendor,
        details: expect.objectContaining({ kind: "containment-coverage", hook: "unverified", shim: "unverified" }) }));
      expect(f.messages.join("\n")).toContain(`WARNING: ${vendor} containment hook=unverified shim=unverified`);
      expect(readJournal(f.paths)).toContainEqual(expect.objectContaining({
        type: "verify-result", agent: vendor, actionId, submissionSha: sha, details: { ok: true }
      }));
      expect(readJournal(f.paths).filter((event) => event.type === "nudged" && event.actionId === actionId)).toHaveLength(1);
    }
  );

  it.each(["cursor", "claude"])("re-holds a still-broken %s after release without needing new hooks", async (vendor) => {
    const f = safetyFixture(vendor);
    await f.tick();
    if (vendor === "cursor") f.ui.dead = true;
    else f.ui.text = "Usage limit reached · continuing automatically at 3:45pm · esc to cancel\n❯";
    const held = await f.tick();
    const reason = vendor === "cursor" ? "harness-gone" : "vendor-wait";
    expect(held.holds[0]?.reason).toBe(reason);
    const lifecycle = readFileSync(f.paths.agentLifecycle, "utf8");
    mutateCursorsState(f.paths, (current) => releaseHold(current, held.holds[0]!.id, false, f.now()));
    const released = readCursorsState(f.paths);
    const reheld = await f.tick();
    expect(reheld.holds[0]?.reason).toBe(reason);
    expect(reheld.holds[0]?.id).not.toBe(held.holds[0]?.id);
    expect(reheld.actionSafety[vendor]?.sends).toBe(held.actionSafety[vendor]?.sends);
    expect(readFileSync(f.paths.agentLifecycle, "utf8")).toBe(lifecycle);
    writeCursorsState(f.paths, released); // a crash during the new hold still reuses that hold
    expect((await f.tick()).holds).toEqual(reheld.holds);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-created")).toHaveLength(2);
  });
});

const seedPendingPublication = (paths: ReturnType<typeof fixture>["paths"], finalSha = "f".repeat(40)) => {
  const now = "2026-08-11T17:00:00.000Z";
  writeFileSync(
    paths.issueSnapshot,
    `${JSON.stringify(
      {
        repository: "example/project",
        number: 1,
        title: "Improve coordinator PR text",
        body: "Make the PR useful.",
        url: "https://github.com/example/project/issues/1"
      },
      null,
      2
    )}\n`
  );
  const current = readCursorsState(paths);
  writeCursorsState(
    paths,
    cursorsStateSchema.parse({
      ...current,
      issueCursor: { stepId: "R7.finalize", gateId: "gate-7-finalized", round: null },
      derived: {
        planSelection: null,
        implementationSelection: {
          kind: "implementation-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "b".repeat(64),
          activeRoster: current.activeRoster,
          inputs: [
            {
              kind: "implementation",
              agent: "codex",
              submissionSha: "d".repeat(40),
              path: ".signals/issue-1/implementation-ready-codex.json",
              productPin: "e".repeat(40)
            }
          ],
          decisionId: `implementation-selection:${"b".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          winner: "codex",
          implementationPin: "e".repeat(40),
          reviser: "codex"
        },
        consensus: null
      },
      accepted: [
        {
          stepId: "R7.finalize",
          agent: "codex",
          round: null,
          submissionSha: "e".repeat(40),
          productPin: finalSha,
          checkResults: [{ name: "check", argv: ["pnpm", "check"], exitCode: 0 }],
          path: ".signals/issue-1/finalization-ready-codex.json",
          acceptedAt: now
        }
      ],
      publication: {
        status: "pending",
        finalSha,
        branch: "issue-1/codex-final",
        url: null,
        error: null,
        attempts: 0
      },
      updatedAt: now
    })
  );
  return { finalSha, now };
};

describe("effectful run loop", () => {
  it.each(["idle", "working", "pending", "background"] as const)(
    "revalidates ready against duplicate %s status during delivery", async (status) => {
      const f = safetyFixture("antigravity");
      const observation = { kind: "status" as const, eventName: "status-line", sessionId: "session",
        execution: status === "working" ? status : "idle" as const,
        pendingInputCount: status === "pending" ? 1 : 0, backgroundActive: status === "background" };
      observeAgentLifecycle(f.paths, "antigravity", observation, f.now());
      f.advance(10);
      f.ui.foreground = "bash";
      await f.tick();
      const previous = actionIdFor("antigravity", 42);
      mutateCursorsState(f.paths, (state) => ({ ...state, agents: { ...state.agents,
        antigravity: { ...state.agents.antigravity, lastAcceptedActionId: previous } } }));
      f.advance(10);
      const ready = agentRuntimePaths(f.paths, "antigravity").ready;
      writeFileSync(ready, `ready ${previous}`);
      utimesSync(ready, new Date(f.now()), new Date(f.now()));
      const receipt = readAgentLifecycle(f.paths).agents.antigravity.hookReceipt;
      f.advance(10);
      f.ui.foreground = "harness";
      // Reproduce an idle render between paste and submit, not only before delivery.
      f.ui.onCapture = () => {
        if (f.ui.sends > 0) observeAgentLifecycle(f.paths, "antigravity", observation, f.now());
      };
      // Newer activity reports must revoke the file before the first key.
      if (status !== "idle") observeAgentLifecycle(f.paths, "antigravity", observation, f.now());
      const after = await f.tick();
      expect(f.ui.sends).toBe(status === "idle" ? 1 : 0);
      expect(after.holds).toEqual([]);
      expect(existsSync(ready)).toBe(status !== "idle");
      if (status === "idle") {
        expect(readAgentLifecycle(f.paths).agents.antigravity.hookReceipt).toEqual(receipt);
        expect(after.actionSafety.antigravity.reserved).toBe(false);
        expect(readJournal(f.paths)).toContainEqual(expect.objectContaining({ type: "nudged",
          details: expect.objectContaining({ readiness: "ready-file" }) }));
        await f.tick();
        expect(f.ui.sends).toBe(1);
      } else expect(readAgentLifecycle(f.paths).agents.antigravity.hookReceipt!.sequence).toBeGreaterThan(receipt!.sequence);
    }
  );

  it.each(["hook", "receipt"].flatMap((change) => [false, true].map((afterPaste) => ({ change, afterPaste }))))(
    "revokes $change proof during sending, afterPaste=$afterPaste", async ({ change, afterPaste }) => {
      const f = safetyFixture("antigravity");
      f.ui.foreground = "bash";
      await f.tick();
      const previous = actionIdFor("antigravity", 42);
      mutateCursorsState(f.paths, (state) => ({ ...state, agents: { ...state.agents,
        antigravity: { ...state.agents.antigravity, lastAcceptedActionId: previous } } }));
      f.advance(10);
      const hook = { kind: "working" as const, eventName: "tool", sessionId: "session" };
      observeAgentLifecycle(f.paths, "antigravity", hook, f.now());
      const hookAt = f.now();
      f.advance(10);
      const ready = agentRuntimePaths(f.paths, "antigravity").ready;
      writeFileSync(ready, `ready ${previous}`);
      utimesSync(ready, new Date(f.now()), new Date(f.now()));
      f.advance(10);
      f.ui.foreground = "harness";
      // AGY retains rechecks between text and submit.
      f.ui.text = "Antigravity Gemini >";
      const changeAt = f.ui.captures + 2;
      f.ui.onCapture = () => {
        if (afterPaste ? f.ui.sends === 0 : f.ui.captures !== changeAt) return;
        if (change === "hook") observeAgentLifecycle(f.paths, "antigravity", hook, hookAt); // same timestamp, new receipt sequence
        else writeFileSync(ready, `ready ${actionIdFor("antigravity", 43)}`);
      };
      const after = await f.tick();
      expect(f.ui.sends).toBe(afterPaste ? 1 : 0);
      expect(after.holds.map((hold) => hold.reason)).toEqual(afterPaste ? ["delivery-uncertain"] : []);
      expect(existsSync(ready)).toBe(true);
    }
  );

  it("keeps ready through actual acceptance and startup refusal, then sends once across restart without a sentinel", async () => {
    const f = safetyFixture("claude");
    await f.tick(); f.advance(10); f.working();
    const runtime = agentRuntimePaths(f.paths, "claude");
    const completedId = readCursorsState(f.paths).agents.claude.actionId!;
    const start = readStartState(f.paths);
    const sha = "d".repeat(40);
    const mirror = new BareMirror(f.paths.mirror, start.origin, async (args) => {
      if (args[2] === "rev-parse") return { exitCode: 0, stdout: Buffer.from(`${sha}\n`), stderr: "" };
      if (args[2] === "show") return { exitCode: 0, stdout: Buffer.from(JSON.stringify({
        protocolVersion: 1, artifact: "participation-ready", issue: start.issue, issueSessionId: start.issueSessionId,
        agent: "claude", baselineSha: start.baselineSha, automationDigest: start.automationDigest
      })), stderr: "" };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    writeFileSync(runtime.complete, sha);
    f.advance(10);
    writeFileSync(runtime.ready, `ready ${completedId}\n`);
    utimesSync(runtime.ready, new Date(f.now()), new Date(f.now()));
    f.advance(10);
    // An idle status render is not a new activity hook and must not revoke ready.
    observeAgentLifecycle(f.paths, "claude", { kind: "telemetry", eventName: "status-line", sessionId: "session",
      rateLimits: { fiveHour: null, sevenDay: null } }, f.now());
    f.ui.foreground = "bash";
    const accepted = await f.makeLoop({ mirror }).runTick();
    expect(accepted.agents.claude.lastAcceptedActionId).toBe(completedId);
    expect(existsSync(runtime.complete)).toBe(false);
    expect(existsSync(runtime.ready)).toBe(true);
    await f.tick();
    expect(f.ui.sends).toBe(1);
    expect(existsSync(runtime.ready)).toBe(true);
    f.ui.foreground = "harness";
    f.ui.text = "❯ \nauto mode on";
    await f.tick(); // a new CoordinatorRunLoop each tick
    expect(f.ui.sends).toBe(2);
    expect(existsSync(runtime.ready)).toBe(false);
    expect(readJournal(f.paths)).toContainEqual(expect.objectContaining({ type: "nudged",
      details: expect.objectContaining({ readiness: "ready-file", lifecycleOverride: "working" }) }));
    expect(readAgentLifecycle(f.paths).agents.claude.execution).toBe("working");
    await f.tick();
    expect(f.ui.sends).toBe(2);
  });

  it.each(["valid", "unknown", "wrong-id", "current-id", "unaccepted", "malformed", "missing", "old", "tie", "future", "duplicate-hook", "background", "pending", "charged"])(
    "uses only eligible ready proof: %s", async (scenario) => {
      const f = safetyFixture("claude");
      f.ui.foreground = "bash";
      await f.tick(); // order, but never send
      const cursor = readCursorsState(f.paths).agents.claude;
      const previous = actionIdFor("claude", 42);
      mutateCursorsState(f.paths, (state) => ({ ...state, agents: { ...state.agents,
        claude: { ...state.agents.claude, lastAcceptedActionId: scenario === "unaccepted" ? null : previous } } }));
      f.advance(10);
      const hook = { kind: "working" as const, eventName: "tool", sessionId: "session" };
      if (scenario !== "unknown") observeAgentLifecycle(f.paths, "claude", hook, f.now());
      const hookTime = new Date(f.now());
      f.advance(10);
      const runtime = agentRuntimePaths(f.paths, "claude");
      const id = scenario === "wrong-id" ? actionIdFor("claude", 43) : scenario === "current-id" ? cursor.actionId : previous;
      if (scenario !== "missing") {
        writeFileSync(runtime.ready, scenario === "malformed" ? "ready nope" : `ready ${id}\n`);
        const written = scenario === "old" ? new Date(hookTime.getTime() - 1) : scenario === "tie" ? hookTime
          : scenario === "future" ? new Date(Date.parse(f.now()) + 100_000) : new Date(f.now());
        utimesSync(runtime.ready, written, written);
      }
      f.advance(10);
      if (scenario === "duplicate-hook") observeAgentLifecycle(f.paths, "claude", hook, f.now());
      if (scenario === "background" || scenario === "pending") observeAgentLifecycle(f.paths, "claude", {
        ...hook, backgroundActive: scenario === "background", pendingInputCount: scenario === "pending" ? 1 : 0
      }, hookTime.toISOString());
      if (scenario === "charged") mutateCursorsState(f.paths, (state) => ({ ...state, actionSafety: { ...state.actionSafety,
        claude: { ...state.actionSafety.claude, sends: 1 } } }));
      f.ui.foreground = "harness";
      f.ui.text = "❯ \nauto mode on";
      await f.tick();
      expect(f.ui.sends).toBe(["valid", "unknown"].includes(scenario) ? 1 : 0);
      if (["valid", "unknown"].includes(scenario)) expect(existsSync(runtime.ready)).toBe(false);
    }
  );

  it("derives an explicit GitHub PR target from supported origin forms", () => {
    expect(githubRepositoryFromOrigin("https://github.com/example/project.git")).toBe("example/project");
    expect(githubRepositoryFromOrigin("git@github.com:example/project.git")).toBe("example/project");
    expect(githubRepositoryFromOrigin("/tmp/origin.git")).toBeNull();
  });

  it("uses active roster order as a deterministic ballot tie-break", () => {
    const { paths } = fixture();
    const current = readCursorsState(paths);
    const now = "2026-08-11T17:00:00.000Z";
    const ballots = cursorsStateSchema.parse({
      ...current,
      acceptedResponses: [
        acceptedResponseFixture({
          stepId: "R3.plan-ballot",
          agent: "claude",
          choice: "claude",
          acceptedAt: now
        }),
        acceptedResponseFixture({
          stepId: "R3.plan-ballot",
          agent: "codex",
          choice: "codex",
          acceptedAt: now
        })
      ]
    });
    expect(deterministicWinner(ballots, "R3.plan-ballot", ["claude", "codex"])).toBe("claude");
    const reduced = dropAgent(ballots, "claude");
    expect(deterministicWinner(reduced, "R3.plan-ballot", ["codex"])).toBe("codex");
  });

  it("hashes the decision policy, roster, and exact accepted plan citations", () => {
    const { paths } = fixture();
    const current = readCursorsState(paths);
    const now = "2026-08-11T17:00:00.000Z";
    const accepted = current.activeRoster.map((agent, index) => ({
      stepId: "R2.plan" as const,
      agent,
      round: null,
      submissionSha: String(index + 1).repeat(40),
      path: `.plans/issue-1/plan-${agent}.md`,
      acceptedAt: now
    }));
    const acceptedResponses = current.activeRoster.map((agent) =>
      acceptedResponseFixture({
        stepId: "R3.plan-ballot",
        agent,
        choice: agent,
        acceptedAt: now,
        responseSha256: responseDigestFixture(agent)
      })
    );
    const state = cursorsStateSchema.parse({
      ...current,
      accepted,
      acceptedResponses,
      ballotBatches: [
        publishedBallotBatchFixture({
          kind: "plan-ballot-batch",
          activeRoster: current.activeRoster,
          createdAt: now,
          commitSha: "9".repeat(40)
        })
      ],
      evidence: { branch: "issue-1/coordinator-evidence", tip: "9".repeat(40) }
    });
    const decision = computePlanSelectionDerived(state, now);
    expect(decision?.inputs.map((input) => input.kind)).toEqual([
      "plan",
      "plan",
      "plan-ballot",
      "plan-ballot"
    ]);
    expect(decision?.selectedAgents).toEqual(["claude"]);
    expect(
      computeDerivedInputSetHash("plan-selection", [...state.activeRoster].reverse(), decision?.inputs ?? [])
    ).not.toBe(decision?.inputSetHash);
    expect(
      computeDerivedInputSetHash("implementation-selection", state.activeRoster, decision?.inputs ?? [])
    ).not.toBe(decision?.inputSetHash);
  });

  it("deduplicates a derived journal append left durable before cursor replacement", async () => {
    const { paths } = fixture();
    const now = "2026-08-11T17:00:00.000Z";
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R3.plan-ballot", gateId: "gate-3-selection", round: null },
        accepted: current.activeRoster.map((agent, index) => ({
          stepId: "R2.plan" as const,
          agent,
          round: null,
          submissionSha: String(index + 1).repeat(40),
          path: `.plans/issue-1/plan-${agent}.md`,
          acceptedAt: now
        })),
        acceptedResponses: current.activeRoster.map((agent) =>
          acceptedResponseFixture({
            stepId: "R3.plan-ballot",
            agent,
            choice: "codex",
            acceptedAt: now
          })
        ),
        ballotBatches: [
          publishedBallotBatchFixture({
            kind: "plan-ballot-batch",
            activeRoster: current.activeRoster,
            createdAt: now,
            commitSha: "9".repeat(40)
          })
        ],
        evidence: { branch: "issue-1/coordinator-evidence", tip: "9".repeat(40) }
      })
    );
    const record = computePlanSelectionDerived(readCursorsState(paths), now);
    expect(record).not.toBeNull();
    appendJournal(paths, { type: "decision-derived", details: derivedDecisionJournalDetails(record!) }, now);

    const after = await new CoordinatorRunLoop(paths, { tmux: null, now: () => now }).runTick();
    expect(after.issueCursor.stepId).toBe("R4.implement");
    expect(after.derived.planSelection?.decidedAt).toBe(now);
    expect(readJournal(paths).filter((event) => event.type === "decision-derived")).toHaveLength(1);
  });

  it("re-extracts brace-expanded plan paths when binding implement actions", async () => {
    const { paths } = fixture();
    const plan = `# Plan
## Exact File Map
- \`scripts/setup_{claude,codex}.sh\`
- \`src/product.ts\`
`;
    const now = "2026-08-11T17:00:00.000Z";
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
        derived: {
          ...current.derived,
          planSelection: {
            kind: "plan-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "e".repeat(64),
            activeRoster: current.activeRoster,
            inputs: [
              {
                kind: "plan",
                agent: "codex",
                submissionSha: "b".repeat(40),
                path: ".plans/issue-1/plan.md"
              }
            ],
            decisionId: `plan-selection:${"e".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            selectedAgents: ["codex"]
          }
        },
        accepted: [
          {
            stepId: "R2.plan",
            agent: "codex",
            round: null,
            submissionSha: "c".repeat(40),
            path: ".plans/issue-1/plan.md",
            approvedPaths: ["src/product.ts"],
            acceptedAt: now
          }
        ]
      })
    );
    const cursors = readCursorsState(paths);
    const approved = await resolveApprovedPaths({ readBlob: async () => plan }, cursors, "R4.implement");
    expect(approved).toEqual(["scripts/setup_claude.sh", "scripts/setup_codex.sh", "src/product.ts"]);
    const order = buildOrder(paths, readStartState(paths), cursors, "codex", "R4.implement", null, undefined, [], approved);
    expect(order.approvedPaths).toEqual(approved);
    const amended = cursorsStateSchema.parse({ ...cursors, amendmentSequence: 1, amendments: [{
      sequence: 1, request: { agent: "codex", commitSha: "d".repeat(40), path: ".signals/issue-1/implementation-ready-codex.json" },
      proposal: { protocolVersion: 1, artifact: "plan-amendment-request", issue: 1, issueSessionId: readStartState(paths).issueSessionId,
        agent: "codex", actionId: actionIdFor("codex"), inputSetHash: responseDigestFixture("input"), scopeHash: order.scopeHash,
        explanation: "Necessary regression", additionalPaths: [{ path: "test/product.test.ts", reason: "Regression" }] },
      plans: [{ agent: "codex", commitSha: "c".repeat(40), path: ".plans/issue-1/plan.md" }],
      activeRoster: cursors.activeRoster, resume: { stepId: "R4.implement", round: null }, requestedAt: now,
      outcome: "approved", evidenceSha: "e".repeat(40),
      ballots: [{ agent: "codex", commitSha: "e".repeat(40), path: ".plans/issue-1/amendment-ballot-codex-1.json" }],
      rationale: "", decidedAt: now
    }] });
    const effective = await resolveApprovedPaths({ readBlob: async () => plan }, amended, "R4.implement");
    expect(effective).toEqual([...approved, "test/product.test.ts"]);
    const amendedOrder = buildOrder(paths, readStartState(paths), amended, "codex", "R4.implement", null, undefined, [], effective);
    expect(amendedOrder.scopeHash).not.toBe(order.scopeHash);
    expect(amendedOrder.scopeRequired).toBe(true);
    expect(amendedOrder.exactApprovedPaths).toEqual(["test/product.test.ts"]);
    expect(amendedOrder.scopeInputs).toHaveLength(2);
    // Even a replacement plan with identical text is a different authority.
    const replaced = cursorsStateSchema.parse({ ...amended, accepted: amended.accepted.map((entry) => ({ ...entry, submissionSha: "f".repeat(40) })) });
    expect(await resolveApprovedPaths({ readBlob: async () => plan }, replaced, "R4.implement")).toEqual(approved);
    expect(buildOrder(paths, readStartState(paths), replaced, "codex", "R4.implement", null).scopeInputs).toEqual([]);
  });

  it.each([true, false])("binds only a matching accepted amendment request (matches=%s) and preserves ready", async (matches) => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const base = readCursorsState(paths);
    const id = actionIdFor("codex");
    const sha = "d".repeat(40);
    const planSha = "c".repeat(40);
    const seeded = cursorsStateSchema.parse({ ...base, activeRoster: ["codex"],
      issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
      agents: { ...base.agents, codex: { ...base.agents.codex, actionId: id, status: "ordered", stepId: "R4.implement",
        evidenceId: "implementation-pinned", submissionMode: "git" } },
      accepted: [{ stepId: "R2.plan", agent: "codex", round: null, submissionSha: planSha,
        path: ".plans/issue-1/plan.md", approvedPaths: ["src/product.ts"], acceptedAt: start.createdAt }]
    });
    writeCursorsState(paths, seeded);
    const order = buildOrder(paths, start, seeded, "codex", "R4.implement", null, id);
    const request = { protocolVersion: 1, issue: 1, issueSessionId: start.issueSessionId, agent: "codex",
      artifact: "plan-amendment-request", actionId: matches ? id : actionIdFor("codex", 1), inputSetHash: computeInputSetHash(order.inputs), scopeHash: order.scopeHash,
      explanation: "Regression coverage omitted", additionalPaths: [{ path: "test/product.test.ts", reason: "Regression" }] };
    const runtime = agentRuntimePaths(paths, "codex");
    writeAction(paths.coordRoot, runtime.action, order);
    writeFileSync(runtime.complete, sha);
    writeFileSync(runtime.ready, `ready ${id}`);
    const mirror = new BareMirror(paths.mirror, start.origin, async (args) => {
      if (args[2] === "rev-parse") return { exitCode: 0, stdout: Buffer.from(`${sha}\n`), stderr: "" };
      if (args[2] === "show") return { exitCode: 0, stdout: Buffer.from(args.at(-1)?.includes(".plans/")
        ? "## Exact File Map\n`src/product.ts`\n" : JSON.stringify(request)), stderr: "" };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    const after = await new CoordinatorRunLoop(paths, { tmux: null, mirror, log: () => undefined }).runTick();
    if (!matches) {
      expect(after.pendingAmendment).toBeNull();
      expect(after.agents.codex.lastAcceptedActionId).toBeNull();
      expect(after.agents.codex.outstanding).toContain("amendment request actionId does not match the current action");
      expect(existsSync(runtime.ready)).toBe(true);
      return;
    }
    expect(after.pendingAmendment?.proposal.actionId).toBe(id);
    expect(after.agents.codex.lastAcceptedActionId).toBe(id);
    expect(after.agents.claude.lastAcceptedActionId).toBeNull();
    expect(existsSync(runtime.ready)).toBe(true);
  });

  it("recovers durable amendment retirements before preparing votes and refuses delayed old markers", async () => {
    const { paths } = fixture();
    const base = readCursorsState(paths);
    const start = readStartState(paths);
    const actionId = actionIdFor("codex");
    const now = start.createdAt;
    const pending = {
      sequence: 1, request: { agent: "codex", commitSha: "d".repeat(40), path: ".signals/issue-1/implementation-ready-codex.json" },
      proposal: { protocolVersion: 1, artifact: "plan-amendment-request", issue: 1, issueSessionId: start.issueSessionId,
        agent: "codex", actionId, inputSetHash: "e".repeat(64), scopeHash: "f".repeat(64),
        explanation: "Necessary regression", additionalPaths: [{ path: "test/product.test.ts", reason: "Regression" }] },
      plans: [{ agent: "codex", commitSha: "c".repeat(40), path: ".plans/issue-1/plan.md" }],
      activeRoster: base.activeRoster, resume: { stepId: "R4.implement", round: null }, requestedAt: now
    };
    writeCursorsState(paths, cursorsStateSchema.parse({ ...base, paused: true, manualPaused: true,
      issueCursor: { stepId: "R4.amend-ballot", gateId: "gate-4-implementations", round: 1 },
      amendmentSequence: 1, pendingAmendment: pending, amendmentRetirements: [{ agent: "codex", actionId }]
    }));
    const runtime = agentRuntimePaths(paths, "codex");
    writeFileSync(runtime.action, "old action");
    writeFileSync(runtime.complete, "d".repeat(40));
    const responsePath = agentResponsePath(paths, "codex", actionId);
    writeAgentResponse(responsePath, paths.issueRoot, { actionId, disposition: "approve", rationale: "old vote" });
    const mirror = new BareMirror(paths.mirror, "/origin.git");
    mirror.readBlob = async () => "bound document";
    let loop = new CoordinatorRunLoop(paths, { tmux: null, mirror });
    await loop.runTick();
    expect(existsSync(runtime.complete)).toBe(true); // pause blocks even retirement effects
    mutateCursorsState(paths, (current) => setPaused(current, false));
    loop = new CoordinatorRunLoop(paths, { tmux: null, mirror });
    await loop.runTick();
    const fresh = readAction(runtime.action);
    expect(fresh.actionId).not.toBe(actionId);
    expect(fresh.submissionMode).toBe("response");
    expect(existsSync(runtime.complete)).toBe(false);
    expect(existsSync(responsePath)).toBe(false);
    expect(readCursorsState(paths).amendmentRetirements).toEqual([]);
    writeFileSync(runtime.complete, `response ${actionId}`);
    await loop.runTick();
    expect(readCursorsState(paths).acceptedResponses).toEqual([]);
    expect(readAction(runtime.action).actionId).toBe(fresh.actionId);
    expect(readAction(runtime.action).body).toContain("does not match ordered action");
    expect(readCursorsState(paths).amendments).toEqual([]);
  });

  it("refreshes in-flight approved paths and reinjects only after positive idle evidence", async () => {
    const { paths } = fixture();
    const plan = `# Plan
## Exact File Map
- \`scripts/setup_{claude,codex}.sh\`
- \`src/product.ts\`
`;
    const now = "2026-08-11T17:00:00.000Z";
    const actionId = "10000000-0000-4000-8000-000000000001";
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
        derived: {
          ...current.derived,
          planSelection: {
            kind: "plan-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "e".repeat(64),
            activeRoster: current.activeRoster,
            inputs: [
              {
                kind: "plan",
                agent: "codex",
                submissionSha: "b".repeat(40),
                path: ".plans/issue-1/plan.md"
              }
            ],
            decisionId: `plan-selection:${"e".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            selectedAgents: ["codex"]
          }
        },
        agents: {
          ...current.agents,
          claude: {
            ...current.agents.claude!,
            stepId: "R4.implement",
            evidenceId: "implementation-pinned",
            actionId: null,
            status: "waiting-peer",
            attempt: 1,
            submissionSha: null,
            outstanding: [],
            updatedAt: now
          },
          codex: {
            ...current.agents.codex!,
            stepId: "R4.implement",
            evidenceId: "implementation-pinned",
            actionId,
            status: "ordered",
            attempt: 1,
            submissionSha: null,
            outstanding: ["implementation changes paths outside the approved file map: scripts/setup_codex.sh"],
            updatedAt: now
          }
        },
        accepted: [
          {
            stepId: "R2.plan",
            agent: "codex",
            round: null,
            submissionSha: "c".repeat(40),
            path: ".plans/issue-1/plan.md",
            approvedPaths: ["src/product.ts"],
            acceptedAt: now
          }
        ]
      })
    );
    const stale = buildOrder(
      paths,
      readStartState(paths),
      readCursorsState(paths),
      "codex",
      "R4.implement",
      null,
      actionId,
      ["implementation changes paths outside the approved file map: scripts/setup_codex.sh"],
      ["src/product.ts"]
    );
    writeAction(paths.coordRoot, agentRuntimePaths(paths, "codex").action, stale);
    expect(readAction(agentRuntimePaths(paths, "codex").action).body).toMatch(
      /"approvedPaths": \[\s*"src\/product\.ts"\s*\]/
    );
    observeAgentLifecycle(paths, "codex", {
      kind: "session-start",
      eventName: "SessionStart",
      sessionId: "session-1"
    });

    const mirror = {
      path: paths.mirror,
      async initialize() {},
      async fetchBranch() {
        return { ok: false as const, details: "unused" };
      },
      async readBlob() {
        return plan;
      },
      async changedPaths() {
        return [];
      },
      async materializeWorktree() {},
      async removeWorktree() {},
      async publishBranch() {}
    };
    let literalNudges = 0;
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux, mirror: mirror as never });
    await loop.runTick();
    const body = readAction(agentRuntimePaths(paths, "codex").action).body;
    expect(body).toContain("scripts/setup_claude.sh");
    expect(body).toContain("scripts/setup_codex.sh");
    expect(literalNudges).toBeGreaterThan(0);
  });

  it("prepares opaque actions for simultaneous agents", async () => {
    const { paths } = fixture();
    const loop = new CoordinatorRunLoop(paths, { tmux: null });
    const cursors = await loop.runTick();
    expect(cursors.agents.claude?.status).toBe("ordered");
    expect(cursors.agents.codex?.status).toBe("ordered");
    const action = readAction(agentRuntimePaths(paths, "codex").action);
    expect(action.submissionMode).not.toBe("response");
    if (action.submissionMode !== "response") {
      expect(action.requiredPath).toBe(".signals/issue-1/participation-ready-codex.json");
    }
    expect(action.body).not.toContain("gate-1-join");
    expect(action.body).toContain('"artifact": "participation-ready"');
    expect(action.body).toContain("```json");
    const start = readStartState(paths);
    expect(action.body).toContain(`"baselineSha": "${start.baselineSha}"`);
    expect(action.body).toContain(`"automationDigest": "${start.automationDigest}"`);
  });

  it("logs RN phase changes on the default log sink", async () => {
    const { paths } = fixture();
    const messages: string[] = [];
    const loop = new CoordinatorRunLoop(paths, {
      tmux: null,
      log: (message) => messages.push(message)
    });
    await loop.runTick();
    expect(messages).toEqual(["Issue 1: R1.join"]);

    const now = "2026-08-11T17:00:00.000Z";
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        accepted: current.activeRoster.map((agent) => ({
          stepId: "R1.join" as const,
          agent,
          round: null,
          submissionSha: "c".repeat(40),
          path: `.signals/issue-1/participation-ready-${agent}.json`,
          acceptedAt: now
        })),
        agents: Object.fromEntries(
          current.activeRoster.map((agent) => {
            const cursor = current.agents[agent];
            if (cursor === undefined) throw new Error(`missing cursor ${agent}`);
            return [
              agent,
              { ...cursor, status: "waiting-peer", actionId: null, submissionSha: null, outstanding: [] }
            ];
          })
        )
      })
    );
    await loop.runTick();
    expect(messages).toEqual(["Issue 1: R1.join", "Issue 1: R1.join → R2.plan"]);
  });

  it("reopens missing Terminal windows without disturbing same-branch agent WIP", async () => {
    const { paths } = fixture();
    const clone = join(paths.coordRoot, "..", "clone-claude");
    mkdirSync(clone);
    git(clone, "init", "-q", "--initial-branch=issue-1/claude");
    git(clone, "config", "user.name", "Fixture");
    git(clone, "config", "user.email", "fixture@example.com");
    writeFileSync(join(clone, "AGENTS.md"), "# product\n");
    git(clone, "add", "AGENTS.md");
    git(clone, "commit", "-qm", "initial");
    const tip = git(clone, "rev-parse", "HEAD");
    writeCloneAgentsProtocol({ clone, installRoot: repoRoot, options: { dryRun: false, log: () => undefined, changes: [] } });
    writeFileSync(join(clone, "plan.md"), "unfinished plan\n");
    const start = readStartState(paths);
    writeFileSync(paths.start, JSON.stringify({ ...start,
      agents: start.agents.map((agent) => agent.id === "claude" ? { ...agent, root: clone } : agent) }));
    const launched: string[] = [];
    const messages: string[] = [];
    const tmux = new TmuxController(
      async (args) => {
        if (args[0] === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "list-windows") return { exitCode: 0, stdout: "claude\ncodex\n", stderr: "" };
        if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tclaude\t0\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      null,
      async (launches) => {
        launched.push(...launches.map((launch) => launch.agentId));
      },
      null,
      async () => undefined,
      null,
      () => []
    );
    await new CoordinatorRunLoop(paths, { tmux, log: (message) => messages.push(message) }).initializeEffects();
    expect(launched).toEqual(["claude", "codex"]);
    expect(messages.join("\n")).toContain("Opened 2 Terminal window(s)");
    expect(readFileSync(join(clone, "plan.md"), "utf8")).toBe("unfinished plan\n");
    expect(git(clone, "rev-parse", "HEAD")).toBe(tip);
    expect(git(clone, "ls-files", "-v", "--", "AGENTS.md")).toMatch(/^S /);
  });

  it("clears malformed completion and reissues the same action with a concrete correction", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let literalNudges = 0;
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    let nowMs = Date.now();
    const messages: string[] = [], verbose: string[] = [];
    const loop = new CoordinatorRunLoop(paths, { now: () => new Date(nowMs).toISOString(), tmux,
      log: (message) => messages.push(message), verbose: (message) => verbose.push(message) });
    await loop.runTick();
    const firstNudges = literalNudges;
    expect(firstNudges).toBeGreaterThan(0);
    const runtime = agentRuntimePaths(paths, "codex");
    const actionId = readCursorsState(paths).agents.codex?.actionId;
    nowMs += 60_000;
    writeFileSync(runtime.complete, "not-a-sha\n");
    await loop.runTick();
    expect(readCursorsState(paths).agents.codex).toMatchObject({ actionId, status: "ordered", attempt: 2 });
    expect(readAction(runtime.action).body).toContain("complete must contain a 40-character lowercase Git SHA");
    expect(messages).toContain("[WAIT] codex: submission needs correction; preparing its correction instructions (no owner action needed).");
    expect(verbose.join("\n")).toContain("complete must contain a 40-character lowercase Git SHA");
    expect(readJournal(paths).some((event) => event.type === "verify-result")).toBe(true);
    expect(readJournal(paths).some((event) => event.type === "nudged" && event.details.reissue === true)).toBe(true);
    expect(literalNudges).toBeGreaterThan(firstNudges);
  });


  it("journals each deferred reason once across repeated ticks and restarts", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    const messages: string[] = [];
    const foreground = "bash";
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: `0\t${foreground}\t0\t0\n`, stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: "some output", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux, log: (message) => messages.push(message) });
    await loop.runTick();
    const first = readJournal(paths).filter((event) => event.type === "nudge-deferred" && event.agent === "codex");
    expect(first).toHaveLength(1);
    expect(first[0]?.details).toMatchObject({
      layer: "scrape",
      code: "foreground-mismatch",
      detail: "bash",
      // The action is out and unanswered, so the workflow is blocked on it.
      gateWaiting: true
    });
    expect(first[0]?.details.human).toBe("the foreground process is not this agent's harness");
    const printedOnce = messages.filter((message) => message.includes("the foreground process is not this agent's harness"));
    expect(printedOnce).toHaveLength(1);
    // The durable key suppresses journal and console repeats, including restart.
    await loop.runTick();
    expect(
      readJournal(paths).filter((event) => event.type === "nudge-deferred" && event.agent === "codex").length
    ).toBe(1);
    await new CoordinatorRunLoop(paths, { tmux, log: (message) => messages.push(message) }).runTick();
    expect(readJournal(paths).filter((event) => event.type === "nudge-deferred" && event.agent === "codex")).toHaveLength(1);
    expect(messages.filter((message) => message.includes("the foreground process is not this agent's harness"))).toHaveLength(1);
  });

  it("records hooks and pane on one event when they disagree", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    const messages: string[] = [];
    let paneReady = true;
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") {
        return { exitCode: 0, stdout: `0\t${paneReady ? "codex" : "bash"}\t0\t0\n`, stderr: "" };
      }
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: "❯ ", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    let nowMs = Date.now();
    const loop = new CoordinatorRunLoop(paths, { now: () => new Date(nowMs).toISOString(), tmux, log: (message) => messages.push(message) });
    await loop.runTick();
    const action = readAgentLifecycle(paths).agents.codex?.action;
    expect(action).not.toBeNull();
    // Hooks say the agent finished and is idle; the pane says it cannot be typed into.
    observeAgentLifecycle(paths, "codex", {
      kind: "prompt-submitted",
      eventName: "UserPromptSubmit",
      sessionId: "session-1",
      turnId: "turn-1",
      actionId: action!.actionId,
      actionDigest: action!.actionDigest
    });
    observeAgentLifecycle(paths, "codex", {
      kind: "stopped",
      eventName: "Stop",
      sessionId: "session-1",
      turnId: "turn-1",
      backgroundActive: false
    });
    expect(readAgentLifecycle(paths).agents.codex).toMatchObject({ execution: "idle", health: "healthy" });
    paneReady = false;
    nowMs += 60_000;
    await loop.runTick();
    const split = readJournal(paths).filter(
      (event) => event.type === "nudge-deferred" && event.details.splitBrain === true
    );
    expect(split).toHaveLength(1);
    expect(split[0]?.details).toMatchObject({
      layer: "scrape",
      code: "foreground-mismatch",
      hooks: { execution: "idle", health: "healthy" }
    });
    expect(messages.some((message) => message.includes("activity report says idle but its terminal refuses input"))).toBe(true);
  });

  it("does not turn delayed correlation into a health warning when lifecycle hooks are live", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
    let paneText = "";
    const messages: string[] = [];
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\t0\n", stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: paneText, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, {
      tmux,
      now: () => new Date(nowMs).toISOString(),
      nudgeRetryMs: NUDGE_RETRY_MS,
      log: (message) => messages.push(message)
    });
    // The session announced itself, so the bridge is demonstrably up.
    observeAgentLifecycle(
      paths,
      "codex",
      { kind: "session-start", eventName: "SessionStart", sessionId: "session-1" },
      new Date(nowMs).toISOString()
    );
    nowMs += 1_000;
    await loop.runTick();
    const actionId = readCursorsState(paths).agents.codex?.actionId;
    paneText = actionId as string;
    nowMs += NUDGE_RETRY_MS + 1;
    await loop.runTick();
    expect(readAgentLifecycle(paths).agents.codex).toMatchObject({
      health: "unknown",
      degradedCause: null
    });
    const text = messages.join("\n");
    expect(text).not.toContain("no lifecycle signal correlated with the last delivery");
    expect(text).not.toContain("Restart");
    const degraded = readJournal(paths).find((event) => event.type === "agent-observability-degraded");
    expect(degraded).toBeUndefined();
  });

  it("does not warn at 45 seconds and nudges once after a positive idle transition", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
    let literalNudges = 0;
    let paneText = "";
    const messages: string[] = [];
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: paneText, stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, {
      tmux,
      now: () => new Date(nowMs).toISOString(),
      nudgeRetryMs: NUDGE_RETRY_MS,
      log: (message) => messages.push(message)
    });
    await loop.runTick();
    expect(literalNudges).toBe(1);
    const actionId = readCursorsState(paths).agents.codex?.actionId;
    expect(actionId).toMatch(/^[0-9a-f-]{36}$/);
    paneText = actionId as string;
    await loop.runTick();
    expect(literalNudges).toBe(1);
    nowMs += NUDGE_RETRY_MS - 1;
    await loop.runTick();
    expect(literalNudges).toBe(1);
    nowMs += 1;
    await loop.runTick();
    expect(literalNudges).toBe(1);
    expect(readAgentLifecycle(paths).agents.codex?.health).toBe("unknown");
    expect(messages.join("\n")).not.toContain("Restart codex's CLI");
    const action = readAgentLifecycle(paths).agents.codex?.action;
    expect(action).not.toBeNull();
    observeAgentLifecycle(
      paths,
      "codex",
      {
        kind: "prompt-submitted",
        eventName: "UserPromptSubmit",
        sessionId: "session-1",
        turnId: "turn-1",
        actionId: action!.actionId,
        actionDigest: action!.actionDigest
      },
      new Date(nowMs + 1).toISOString()
    );
    observeAgentLifecycle(
      paths,
      "codex",
      {
        kind: "stopped",
        eventName: "Stop",
        sessionId: "session-1",
        turnId: "turn-1",
        backgroundActive: false
      },
      new Date(nowMs + 2).toISOString()
    );
    nowMs += 15_000;
    await loop.runTick();
    expect(literalNudges).toBe(2);
    await loop.runTick();
    expect(literalNudges).toBe(2);
    expect(readCursorsState(paths).agents.codex).toMatchObject({ actionId, status: "ordered" });
    const nudged = readJournal(paths).filter((event) => event.type === "nudged" && event.agent === "codex");
    expect(nudged).toHaveLength(2);
    expect(nudged[1]?.details).toMatchObject({ idle: true, actionDigest: action!.actionDigest });
  });

  it("automatically overrides stale working only before the first send; owner reminders still check the Codex composer", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(paths.start, `${JSON.stringify({ ...start, agents: start.agents.map((agent) =>
      agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent) }, null, 2)}\n`);
    // The previous turn's Stop never reached this issue, so lifecycle still says working.
    observeAgentLifecycle(paths, "codex", { kind: "prompt-submitted", eventName: "UserPromptSubmit", sessionId: "session-1", turnId: "turn-0" });
    let literalNudges = 0;
    let body = "• done";
    let draft = "";
    let nowMs = Date.now();
    // Captures to let pass before a hook reports a new turn; -1 disables the race.
    let raceAfterCaptures = -1;
    const messages: string[] = [];
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
      if (args[0] === "capture-pane") {
        if (raceAfterCaptures >= 0 && raceAfterCaptures-- === 0) {
          // A hook reports a new turn while the pane still looks idle.
          observeAgentLifecycle(paths, "codex", { kind: "prompt-submitted", eventName: "UserPromptSubmit", sessionId: "session-1", turnId: "turn-1" });
        }
        return { exitCode: 0, stdout: `${body}\n\n› ${draft}\n\n  ? for shortcuts`, stderr: "" };
      }
      if (args[0] === "send-keys" && args.includes("-l")) {
        literalNudges += 1;
        draft = args[args.indexOf("-l") + 3]!;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux, now: () => new Date(nowMs).toISOString(), log: (message) => messages.push(message) });
    await loop.runTick();
    expect(literalNudges).toBe(0);
    expect(readAgentLifecycle(paths).agents.codex?.action?.delivery).toBe("ordered");
    expect(readJournal(paths).some((event) =>
      event.type === "nudge-deferred" && event.agent === "codex" && event.details.code === "no-idle-sentinel")).toBe(true);

    body = "• done\n\n• COORD-IDLE: waiting for the next coordinator action file";
    raceAfterCaptures = 1; // after the unfinished-work probe, during the nudge's readiness capture
    await loop.runTick();
    expect(literalNudges).toBe(0);
    expect(readJournal(paths).some((event) =>
      event.type === "nudge-deferred" && event.agent === "codex" && event.details.code === "lifecycle-changed")).toBe(true);

    await loop.runTick();
    expect(literalNudges).toBe(1);
    expect(readAgentLifecycle(paths).agents.codex).toMatchObject({ execution: "working", action: { delivery: "injected" } });
    const nudged = readJournal(paths).filter((event) => event.type === "nudged" && event.agent === "codex");
    expect(nudged).toHaveLength(1);
    expect(nudged[0]?.details).toMatchObject({ readiness: "idle-sentinel", lifecycleOverride: "working" });
    expect(messages.join("\n")).toContain("No Stop event from codex reached this issue");

    // After the first send, a stale working record again blocks: no duplicate.
    await loop.runTick();
    expect(literalNudges).toBe(1);

    const action = readAgentLifecycle(paths).agents.codex!.action!;
    observeAgentLifecycle(paths, "codex", { kind: "prompt-submitted", eventName: "UserPromptSubmit", sessionId: "session-1",
      turnId: "turn-2", actionId: action.actionId, actionDigest: action.actionDigest }, new Date(++nowMs).toISOString());
    nowMs += 60_000;
    body = `• ${action.actionId} done\n\n• COORD-IDLE: waiting for the next coordinator action file`;
    draft = "owner is editing";
    loop.reminders().find((item) => item.label === "codex")!.request();
    await loop.runTick();
    expect(literalNudges).toBe(1);
    draft = "";
    loop.reminders().find((item) => item.label === "codex")!.request();
    await loop.runTick();
    expect(literalNudges).toBe(2);
    expect(readJournal(paths)).toContainEqual(expect.objectContaining({ type: "nudged", agent: "codex",
      actionId: action.actionId, details: expect.objectContaining({ owner: true }) }));
  });

  it("retries an action that a busy pane never injected", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let busy = true;
    let literalNudges = 0;
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") {
        return { exitCode: 0, stdout: busy ? "0\tcodex\t1\n" : "0\tcodex\t0\n", stderr: "" };
      }
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux });
    await loop.runTick();
    expect(literalNudges).toBe(0);
    expect(readAgentLifecycle(paths).agents.codex?.action?.delivery).toBe("ordered");

    busy = false;
    await loop.runTick();
    expect(literalNudges).toBe(1);
    expect(readAgentLifecycle(paths).agents.codex?.action?.delivery).toBe("injected");
    await loop.runTick();
    expect(literalNudges).toBe(1);
  });

  it("retries an idle-exhausted action only when the pane proves the action is absent", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
    let literalNudges = 0;
    let paneText = "";
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\t0\n", stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: paneText, stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, {
      tmux,
      now: () => new Date(nowMs).toISOString(),
      nudgeRetryMs: NUDGE_RETRY_MS
    });
    await loop.runTick();
    expect(literalNudges).toBe(1);
    const action = readAgentLifecycle(paths).agents.codex?.action;
    const actionId = action!.actionId;
    paneText = `❯ ${actionId}`;

    // A real turn ran and stopped: that positive idle transition authorizes the
    // one ordinary resend, which spends it.
    observeAgentLifecycle(
      paths,
      "codex",
      {
        kind: "prompt-submitted",
        eventName: "UserPromptSubmit",
        sessionId: "session-1",
        turnId: "turn-1",
        actionId,
        actionDigest: action!.actionDigest
      },
      new Date(nowMs + 1).toISOString()
    );
    observeAgentLifecycle(
      paths,
      "codex",
      {
        kind: "stopped",
        eventName: "Stop",
        sessionId: "session-1",
        turnId: "turn-1",
        backgroundActive: false
      },
      new Date(nowMs + 2).toISOString()
    );
    // The resend happens after that acceptance, so it is a fresh delivery
    // awaiting acceptance rather than an already-accepted one.
    nowMs += 60_000;
    await loop.runTick();
    expect(literalNudges).toBe(2);
    expect(readAgentLifecycle(paths).agents.codex?.action).toMatchObject({
      delivery: "injected",
      turnId: null
    });
    const exhausted = readAgentLifecycle(paths).agents.codex!;
    expect(decideLifecycleNudge(exhausted, actionId, action!.actionDigest).code).toBe(
      "idle-transition-already-used"
    );

    // Elapsed time alone is not authority: the action is still on screen, so
    // the send was not lost and nothing may resend.
    nowMs += NUDGE_RETRY_MS + 1;
    await loop.runTick();
    expect(literalNudges).toBe(2);

    // A ready prompt with no trace of the action is the positive proof.
    nowMs += 120_000 - NUDGE_RETRY_MS - 1;
    paneText = "❯ ready";
    await loop.runTick();
    expect(literalNudges).toBe(3);

    // The opportunity is consumed; a further tick sends nothing more.
    await loop.runTick();
    expect(literalNudges).toBe(3);
  });

  it("still clears a legacy degraded state when work reaches completion", async () => {
    const f = safetyFixture();
    await f.tick();
    const actionId = readCursorsState(f.paths).agents.codex!.actionId!;
    f.ui.text = actionId;
    f.advance(NUDGE_RETRY_MS + 1);
    const { markActionWorkflowComplete, markObservabilityDegraded } = await import("../src/agentLifecycle.js");
    markObservabilityDegraded(f.paths, "codex", f.now()); // persisted by an older coordinator
    await f.tick();
    expect(f.messages.join("\n")).not.toMatch(/Restart|no lifecycle signal has ever arrived/);
    const cleared = markActionWorkflowComplete(f.paths, "codex", actionId, f.now());
    expect(cleared.clearedDegraded).toBe(true);
    expect(readAgentLifecycle(f.paths).agents.codex).toMatchObject({ health: "healthy", degradedCause: null });
  });

  it.each(["claude", "codex"])("does not resend to %s after a delayed SessionStart", async (vendor) => {
    const f = safetyFixture(vendor, { nudgeRetryMs: NUDGE_RETRY_MS });
    await f.tick();
    expect(f.ui.sends).toBe(1);
    expect(readAgentLifecycle(f.paths).agents[vendor]).toMatchObject({
      execution: "unknown", action: { delivery: "injected" }
    });
    f.advance(1_000);
    observeAgentLifecycle(f.paths, vendor, {
      kind: "session-start", eventName: "SessionStart", sessionId: "session-1"
    }, f.now());
    expect(readAgentLifecycle(f.paths).agents[vendor]?.execution).toBe("unknown");
    f.ui.text = "❯ ready"; // The action UUID has scrolled out of the captured viewport.
    f.advance(120_000);
    await f.tick();
    await f.tick();
    expect(f.ui.sends).toBe(1);
    expect(readAgentLifecycle(f.paths).agents[vendor]?.action?.delivery).toBe("injected");
    expect(readJournal(f.paths).some((event) => event.details?.event === "prompt-ready-action-absent")).toBe(false);
  });

  it.each(["claude", "codex"])("recovers lost %s delivery without a degraded-health flag", async (vendor) => {
    const f = safetyFixture(vendor, { nudgeRetryMs: NUDGE_RETRY_MS });
    await f.tick();
    // A ready prompt without the UUID is positive evidence; time alone is insufficient.
    f.ui.text = "❯ ready";
    f.advance(NUDGE_RETRY_MS - 1);
    await f.tick();
    expect(readAgentLifecycle(f.paths).agents[vendor]?.action?.delivery).toBe("injected");
    expect(f.ui.sends).toBe(1);
    f.advance(1);
    await f.tick();
    expect(readAgentLifecycle(f.paths).agents[vendor]?.action?.delivery).toBe("ordered");
    expect(f.ui.sends).toBe(1); // the independent minimum send spacing still applies
    f.advance(60_000 - NUDGE_RETRY_MS);
    await f.tick();
    expect(f.ui.sends).toBe(2);
    expect(readAgentLifecycle(f.paths).agents[vendor]?.health).toBe("unknown");
    expect(readJournal(f.paths).some((event) => event.type === "agent-observability-degraded")).toBe(false);
    await f.tick();
    expect(f.ui.sends).toBe(2);
  });

  it("uses Stop readiness after an injection without a submit callback", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let literalNudges = 0;
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: "Codex\nready\n", stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    let nowMs = Date.now();
    const loop = new CoordinatorRunLoop(paths, { now: () => new Date(nowMs).toISOString(), tmux });
    await loop.runTick();
    expect(literalNudges).toBe(1);
    const action = readAgentLifecycle(paths).agents.codex!.action!;
    observeAgentLifecycle(paths, "codex", {
      kind: "stopped",
      eventName: "Stop",
      sessionId: "session-1",
      turnId: "unrelated-turn",
      backgroundActive: false
    });
    expect(readAgentLifecycle(paths).agents.codex?.execution).toBe("idle");
    nowMs += 60_000;

    await loop.runTick();
    expect(literalNudges).toBe(2);
    expect(readAgentLifecycle(paths).agents.codex?.action).toMatchObject({
      actionId: action.actionId,
      actionDigest: action.actionDigest,
      delivery: "injected"
    });
    await loop.runTick();
    expect(literalNudges).toBe(2);
  });

  it("does not degrade pull-only agents that are intentionally never injected", async () => {
    const { paths } = fixture();
    let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
    const tmux = new TmuxController(async (args) =>
      args[0] === "display-message"
        ? { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" }
    );
    const loop = new CoordinatorRunLoop(paths, { tmux, now: () => new Date(nowMs).toISOString() });
    await loop.runTick();
    nowMs += NUDGE_RETRY_MS;
    await loop.runTick();
    expect(readAgentLifecycle(paths).agents.codex?.health).toBe("unknown");
    expect(readJournal(paths).some((event) => event.type === "agent-observability-degraded")).toBe(false);
  });

  it("preserves completion and emits no artifact verdict on transient fetch failure", async () => {
    const { paths } = fixture();
    const mirror = new BareMirror(paths.mirror, "/origin.git", async () => ({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: "fatal: network timeout"
    }));
    const loop = new CoordinatorRunLoop(paths, { tmux: null, mirror });
    await loop.runTick();
    const runtime = agentRuntimePaths(paths, "codex");
    writeFileSync(runtime.complete, `${"d".repeat(40)}\n`);
    await loop.runTick();
    expect(readFileSync(runtime.complete, "utf8")).toBe(`${"d".repeat(40)}\n`);
    expect(readCursorsState(paths).agents.codex).toMatchObject({ status: "intent" });
    expect(readJournal(paths).filter((event) => event.type === "verify-result")).toHaveLength(0);
  });

  it("holds rather than accepting an origin tip when a harness disappears without completion", async () => {
    const { paths } = fixture();
    let branch = "";
    const tip = "d".repeat(40);
    const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
      const command = args[2];
      if (command === "fetch") {
        branch = args.at(-1)?.includes("claude") === true ? "claude" : "codex";
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      }
      if (command === "rev-parse") return { exitCode: 0, stdout: Buffer.from(`${tip}\n`), stderr: "" };
      if (command === "merge-base") return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      if (command === "show") {
        return {
          exitCode: 0,
          stdout: Buffer.from(
            JSON.stringify({
              protocolVersion: 1,
              artifact: "participation-ready",
              issue: 1,
              issueSessionId: `issue-1:${"a".repeat(40)}`,
              agent: branch,
              baselineSha: "a".repeat(40),
              automationDigest: "b".repeat(64)
            })
          ),
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    const tmux = new TmuxController(async (args) => {
      const target = args[args.indexOf("-t") + 1] ?? "";
      return target.includes("claude")
        ? { exitCode: 1, stdout: "", stderr: "gone" }
        : { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { mirror, tmux });
    await loop.runTick();
    const cursors = await loop.runTick();
    expect(cursors.accepted).toEqual([]);
    expect(cursors.paused).toBe(true);
    expect(cursors.holds).toEqual([expect.objectContaining({ agent: "claude", reason: "harness-gone", resetsAt: null })]);
    expect(readJournal(paths).some((event) => event.details.pushedThenDied === true)).toBe(false);
  });

  it.each(["pause", "abandon", "drop"] as const)(
    "does not overwrite a concurrent %s control while a fetch is in flight",
    async (control) => {
      const { paths } = fixture();
      let releaseFetch: (() => void) | undefined;
      let announceFetch: (() => void) | undefined;
      const fetchStarted = new Promise<void>((resolve) => (announceFetch = resolve));
      const fetchRelease = new Promise<void>((resolve) => (releaseFetch = resolve));
      const commands: string[] = [];
      const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
        const command = args[2] ?? "";
        commands.push(command);
        if (command === "fetch") {
          announceFetch?.();
          await fetchRelease;
          return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
        }
        if (command === "rev-parse") {
          return { exitCode: 0, stdout: Buffer.from(`${"d".repeat(40)}\n`), stderr: "" };
        }
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      });
      const progress: string[] = [];
      const loop = new CoordinatorRunLoop(paths, { tmux: null, mirror, log: (message) => progress.push(message) });
      await loop.runTick();
      const completion = agentRuntimePaths(paths, "codex").complete;
      loop.reminders().find((item) => item.label === "codex")!.request();
      // The receipt is the one runtime file an agent writes, and it must not be
      // inside the tree that holds cursors.json and every peer's action.md.
      expect(completion.startsWith(`${paths.completesRoot}/`)).toBe(true);
      expect(completion.startsWith(`${paths.coordRoot}/`)).toBe(false);
      writeFileSync(completion, `${"d".repeat(40)}\n`);
      const pendingTick = loop.runTick();
      await fetchStarted;
      expect(progress.join("\n")).toContain("completion marker received; checking the submission");
      expect(progress.join("\n")).not.toContain("validated and accepted");
      expect(progress.join("\n")).not.toContain("reminder not sent");
      mutateCursorsState(paths, (current) => {
        if (control === "pause") return setPaused(current, true);
        if (control === "drop") return dropAgent(current, "claude");
        return cursorsStateSchema.parse({ ...current, abandoned: true, updatedAt: new Date().toISOString() });
      });
      releaseFetch?.();
      const after = await pendingTick;
      if (control === "pause") expect(after.paused).toBe(true);
      if (control === "abandon") expect(after.abandoned).toBe(true);
      if (control === "drop") expect(after.activeRoster).toEqual(["codex"]);
      expect(after.accepted.some((submission) => submission.agent === "codex" && submission.stepId === "R1.join")).toBe(false);
      expect(readFileSync(completion, "utf8")).toBe(`${"d".repeat(40)}\n`);
      expect(commands).not.toContain("show");
    }
  );

  it("accepts an in-flight completion while an owner question remains open", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const current = readCursorsState(paths);
    const now = "2026-08-11T17:00:00.000Z";
    const actionId = "ce80f31a-6884-42cf-b0ff-b0fb27fc6cc8";
    const revisionPin = "e".repeat(40);
    const seeded = cursorsStateSchema.parse({
      ...current,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
      derived: {
        planSelection: null,
        implementationSelection: {
          kind: "implementation-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "b".repeat(64),
          activeRoster: current.activeRoster,
          inputs: [
            {
              kind: "implementation",
              agent: "codex",
              submissionSha: "d".repeat(40),
              path: ".signals/issue-1/implementation-ready-codex.json",
              productPin: "f".repeat(40)
            }
          ],
          decisionId: `implementation-selection:${"b".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          winner: "codex",
          implementationPin: "f".repeat(40),
          reviser: "codex"
        },
        consensus: null
      },
      ownerQuestion: {
        id: "10000000-0000-4000-8000-000000000001",
        kind: "ballot-escalation",
        round: 1,
        allowedAnswers: ["retry", "revise", "abandon"],
        createdAt: now
      },
      agents: {
        ...current.agents,
        claude: {
          ...current.agents.claude,
          stepId: "R6.ballot",
          evidenceId: "consensus-response-accepted",
          submissionMode: "response",
          actionId,
          status: "ordered",
          updatedAt: now
        }
      },
      accepted: [
        {
          stepId: "R6.revise",
          agent: "codex",
          round: 1,
          submissionSha: "c".repeat(40),
          productPin: revisionPin,
          path: ".signals/issue-1/revision-ready-codex-round-1.json",
          acceptedAt: now
        }
      ],
      updatedAt: now
    });
    writeCursorsState(paths, seeded);
    const order = buildOrder(paths, start, seeded, "claude", "R6.ballot", 1, actionId);
    writeAction(paths.coordRoot, agentRuntimePaths(paths, "claude").action, order);
    const response: ConsensusBallotResponse = {
      actionId,
      disposition: "approve",
      rationale: "The revision is ready."
    };
    const responsePath = agentResponsePath(paths, "claude", actionId);
    writeAgentResponse(responsePath, paths.issueRoot, response);
    writeFileSync(agentRuntimePaths(paths, "claude").complete, `response ${actionId}\n`);
    writeFileSync(agentRuntimePaths(paths, "claude").ready, `ready ${actionId}\n`);

    const progress: string[] = [];
    const loop = new CoordinatorRunLoop(paths, { tmux: null, log: (message) => progress.push(message) });
    loop.reminders().find((item) => item.label === "claude")!.request();
    const after = await loop.runTick();
    expect(progress.findIndex((message) => message.includes("completion marker received")))
      .toBeLessThan(progress.findIndex((message) => message.includes("private response validated and accepted")));
    expect(progress.join("\n")).not.toMatch(/approve|The revision is ready|reminder not sent/);
    expect(after.ownerQuestion?.id).toBe("10000000-0000-4000-8000-000000000001");
    expect(after.acceptedResponses).toContainEqual(
      expect.objectContaining({
        stepId: "R6.ballot",
        agent: "claude",
        round: 1,
        disposition: "approve",
        actionId
      })
    );
    expect(after.agents.claude?.status).toBe("waiting-peer");
    expect(after.agents.claude?.lastAcceptedActionId).toBe(actionId);
    expect(existsSync(agentRuntimePaths(paths, "claude").ready)).toBe(true);
    expect(existsSync(agentRuntimePaths(paths, "claude").complete)).toBe(false);
    expect(existsSync(responsePath)).toBe(false);
  });

  it("publishes exactly from durable accepted R7 outbox state and records retryable failure", async () => {
    const { paths } = fixture({ prPolicy: "coord-open-unmerged", origin: "https://github.com/example/project.git" });
    const now = "2026-08-11T17:00:00.000Z";
    const finalSha = "f".repeat(40);
    writeFileSync(
      paths.issueSnapshot,
      `${JSON.stringify(
        {
          repository: "example/project",
          number: 1,
          title: "Improve coordinator PR text",
          body: "Make the PR useful.",
          url: "https://github.com/example/project/issues/1"
        },
        null,
        2
      )}\n`
    );
    const current = readCursorsState(paths);
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R7.finalize", gateId: "gate-7-finalized", round: null },
        derived: {
          planSelection: null,
          implementationSelection: {
            kind: "implementation-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "b".repeat(64),
            activeRoster: current.activeRoster,
            inputs: [
              {
                kind: "implementation",
                agent: "codex",
                submissionSha: "d".repeat(40),
                path: ".signals/issue-1/implementation-ready-codex.json",
                productPin: "e".repeat(40)
              }
            ],
            decisionId: `implementation-selection:${"b".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            winner: "codex",
            implementationPin: "e".repeat(40),
            reviser: "codex"
          },
          consensus: null
        },
        accepted: [
          {
            stepId: "R7.finalize",
            agent: "codex",
            round: null,
            submissionSha: "e".repeat(40),
            productPin: finalSha,
            checkResults: [{ name: "check", argv: ["pnpm", "check"], exitCode: 0 }],
            path: ".signals/issue-1/finalization-ready-codex.json",
            acceptedAt: now
          }
        ],
        publication: {
          status: "pending",
          finalSha,
          branch: "issue-1/codex-final",
          url: null,
          error: null,
          attempts: 0
        },
        updatedAt: now
      })
    );
    const progress: string[] = [];
    let pushes = 0;
    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git", async (args) => {
      if (args[2] === "push") {
        expect(progress.at(-1)).toContain("[WAIT] Pushing final branch");
        pushes += 1;
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    let opens = 0;
    const failing = new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      log: (message) => progress.push(message),
      pullRequestOpener: async () => {
        expect(progress.at(-1)).toBe("[WAIT] Opening the pull request...");
        opens += 1;
        expect(readCursorsState(paths).accepted.some((submission) => submission.stepId === "R7.finalize")).toBe(true);
        throw new Error("GitHub unavailable");
      }
    });
    const failed = await failing.runTick();
    expect(failed.publication).toMatchObject({ status: "failed", error: "GitHub unavailable", attempts: 1 });
    expect(failed.accepted.some((submission) => submission.stepId === "R7.finalize")).toBe(true);

    const recovered = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      log: (message) => progress.push(message),
      pullRequestOpener: async () => {
        expect(progress.at(-1)).toBe("[WAIT] Opening the pull request...");
        opens += 1;
        return { url: "https://github.com/example/project/pull/1" };
      }
    }).runTick();
    expect(recovered.publication).toMatchObject({
      status: "completed",
      url: "https://github.com/example/project/pull/1",
      attempts: 2
    });
    expect(recovered.completed).toBe(true);
    expect(pushes).toBe(2);
    expect(opens).toBe(2);
    expect(readJournal(paths).filter((event) => event.type === "pr-created")).toHaveLength(1);
  });

  it("opens a draft PR under legacy owner-only", async () => {
    const { paths } = fixture({ prPolicy: "owner-only", origin: "https://github.com/example/project.git" });
    seedPendingPublication(paths);
    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git", async () => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: ""
    }));
    const opened: Array<{ draft: boolean; title: string; body: string }> = [];
    const result = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      pullRequestOpener: async (input) => {
        opened.push({ draft: input.draft, title: input.title, body: input.body });
        return { url: "https://github.com/example/project/pull/2" };
      }
    }).runTick();
    expect(opened).toEqual([
      {
        draft: true,
        title: "Issue 1: Improve coordinator PR text",
        body: "Closes #1\n\nDraft PR for issue 1. Owner merges. Final pin: ffffffffffffffffffffffffffffffffffffffff."
      }
    ]);
    expect(result.publication).toMatchObject({
      status: "completed",
      url: "https://github.com/example/project/pull/2",
      branch: "issue-1/codex-final"
    });
  });

  it("opens a ready PR and merges it under coord-merged", async () => {
    const { paths } = fixture({ prPolicy: "coord-merged", origin: "https://github.com/example/project.git" });
    seedPendingPublication(paths);
    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git", async () => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: ""
    }));
    let merges = 0;
    const result = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      pullRequestOpener: async (input) => {
        expect(input.draft).toBe(false);
        expect(input.title).toBe("Issue 1: Improve coordinator PR text");
        expect(input.body).toContain("Closes #1");
        expect(input.body).toContain("Coordinator merges");
        return { url: "https://github.com/example/project/pull/3" };
      },
      pullRequestMerger: async (input) => {
        expect(input.url).toBe("https://github.com/example/project/pull/3");
        merges += 1;
      }
    }).runTick();
    expect(merges).toBe(1);
    expect(result.publication.status).toBe("completed");
    expect(readJournal(paths).map((event) => event.type)).toEqual(
      expect.arrayContaining(["pr-created", "pr-merged"])
    );
  });

  it("keeps the PR URL when coord-merged merge fails so the owner can finish it", async () => {
    const { paths } = fixture({ prPolicy: "coord-merged", origin: "https://github.com/example/project.git" });
    seedPendingPublication(paths);
    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git", async () => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: ""
    }));
    const result = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      pullRequestOpener: async () => ({ url: "https://github.com/example/project/pull/4" }),
      pullRequestMerger: async () => {
        throw new Error("protected branch");
      }
    }).runTick();
    expect(result.publication).toMatchObject({
      status: "failed",
      url: "https://github.com/example/project/pull/4",
      error: "protected branch"
    });
  });

  it("records an invalid persisted publication origin as a retryable failure", async () => {
    const { paths } = fixture({ prPolicy: "coord-open-unmerged", origin: "/unsupported/origin.git" });
    const finalSha = "f".repeat(40);
    const current = readCursorsState(paths);
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        publication: {
          status: "pending",
          finalSha,
          branch: "issue-1/codex-final",
          url: null,
          error: null,
          attempts: 0
        }
      })
    );
    let pushes = 0;
    const mirror = new BareMirror(paths.mirror, "/unsupported/origin.git");
    mirror.publishBranch = async () => {
      pushes += 1;
    };
    const messages: string[] = [];
    const result = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      log: (message) => messages.push(message)
    }).runTick();
    expect(result.publication).toMatchObject({
      status: "failed",
      finalSha,
      branch: "issue-1/codex-final",
      error: "Cannot derive a GitHub repository from origin /unsupported/origin.git.",
      attempts: 1
    });
    expect(pushes).toBe(0);
    expect(messages.join(" ")).toContain("Owner action required: finalization publication failed");
    expect(readJournal(paths).at(-1)?.type).toBe("publication-failed");
  });

  it.each(["README.md", "source.ts", "missing-history"])("selects the final profile from the entire pinned issue range: %s", async (change) => {
    const { root, paths } = fixture();
    const seed = join(root, "profile-seed");
    mkdirSync(seed);
    git(seed, "init", "-q");
    writeFileSync(join(seed, "README.md"), "initial docs\n");
    writeFileSync(join(seed, "source.ts"), "initial product\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "baseline");
    const baselineSha = git(seed, "rev-parse", "HEAD");
    mkdirSync(join(seed, ".signals/issue-1"), { recursive: true });
    writeFileSync(join(seed, ".signals/issue-1/ready.json"), "{}\n");
    writeFileSync(join(seed, change === "missing-history" ? "README.md" : change), "changed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "implementation and evidence");
    const consensusSha = git(seed, "rev-parse", "HEAD");
    rmSync(join(seed, ".signals"), { recursive: true });
    git(seed, "add", "-u");
    git(seed, "commit", "-qm", "only evidence cleanup");
    const finalSha = git(seed, "rev-parse", "HEAD");
    git(root, "clone", "--bare", "-q", seed, paths.mirror);
    writeFileSync(paths.start, JSON.stringify({ ...readStartState(paths),
      baselineSha: change === "missing-history" ? "f".repeat(40) : baselineSha,
      documentation: { paths: ["README.md"], verify: { precommit: [], prepush: [] },
        checks: [{ name: "docs", argv: ["docs-check"] }] }
    }));
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    const order = { ...buildOrder(paths, start, cursors, "codex", "R7.finalize", null),
      inputs: [{ agent: "codex", commitSha: consensusSha, path: ".signals/issue-1/ready.json", kind: "consensus" }] };
    const observation = { agent: "codex", actionId: order.actionId, submissionSha: finalSha,
      status: "satisfied" as const, outstanding: [], productPin: finalSha };
    const calls: string[][] = [];
    const dependencies = { tmux: null, mirror: new BareMirror(paths.mirror, seed),
      processRunner: async (argv: readonly string[]) => { calls.push([...argv]); return { exitCode: 1, stdout: "", stderr: "failed" }; } };
    const failed = await new CoordinatorRunLoop(paths, dependencies).verifyFinalizationChecks(start, order, observation, cursors);
    expect(failed.status).toBe("rejected");
    expect(readCursorsState(paths).publication.status).toBe("not-required");
    // A restart cannot turn a failure or an advisory record into successful verification.
    const retried = await new CoordinatorRunLoop(paths, dependencies).verifyFinalizationChecks(readStartState(paths), order, observation, cursors);
    expect(retried.status).toBe("rejected");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(change === "README.md" ? ["docs-check"] : start.checks[0]!.argv);
    const passed = await new CoordinatorRunLoop(paths, { ...dependencies,
      processRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }).verifyFinalizationChecks(start, order, observation, cursors);
    expect(passed.status).toBe("satisfied");
    expect(readJournal(paths).filter((event) => event.type === "verification-run").map((event) => event.details.exitCode)).toEqual([1, 1, 0]);
    if (change === "README.md") {
      const launchError = new Error("spawn docs-check ENOENT");
      const before = readCursorsState(paths);
      for (let attempt = 0; attempt < 2; attempt++) {
        const restarted = new CoordinatorRunLoop(paths, { ...dependencies,
          processRunner: async () => { throw launchError; } });
        await expect(restarted.verifyFinalizationChecks(start, order, observation, cursors)).rejects.toBe(launchError);
      }
      expect(readCursorsState(paths)).toEqual(before);
      expect(readJournal(paths).filter((event) => event.type === "final-check")).toHaveLength(3);
      expect(readJournal(paths).filter((event) => event.type === "verification-run").slice(-2))
        .toEqual([expect.objectContaining({ details: expect.objectContaining({ error: String(launchError) }) }),
          expect.objectContaining({ details: expect.objectContaining({ error: String(launchError) }) })]);
      expect(readdirSync(paths.issueRoot).some((name) => name.startsWith(".verification-"))).toBe(false);
    }
  });

  it("keeps failed final checks in verification and performs no publication effect", async () => {
    const { root, paths } = fixture({ prPolicy: "coord-open-unmerged", origin: "https://github.com/example/project.git" });
    const seed = join(root, "final-seed");
    execFileSync("git", ["init", "-q", seed]);
    mkdirSync(join(seed, ".signals/issue-1"), { recursive: true });
    writeFileSync(join(seed, ".signals/issue-1/revision-ready-codex.json"), "{}\n");
    execFileSync("git", ["-C", seed, "add", "."]);
    execFileSync("git", ["-C", seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "revision"]);
    const revisionSha = execFileSync("git", ["-C", seed, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    rmSync(join(seed, ".signals/issue-1"), { recursive: true });
    execFileSync("git", ["-C", seed, "add", "-A"]);
    execFileSync("git", ["-C", seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "cleanup"]);
    const finalSha = execFileSync("git", ["-C", seed, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["clone", "--bare", "-q", seed, paths.mirror]);
    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git");
    let pushes = 0;
    mirror.publishBranch = async () => {
      pushes += 1;
    };
    let opens = 0;
    let checkNowMs = Date.parse("2026-08-21T00:00:00.000Z");
    const loop = new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      now: () => {
        const value = new Date(checkNowMs).toISOString();
        checkNowMs += 2500;
        return value;
      },
      processRunner: async () => ({ exitCode: 1, stdout: "", stderr: "test failed" }),
      pullRequestOpener: async () => {
        opens += 1;
        return { url: "https://github.com/example/project/pull/1" };
      }
    });
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    const baseOrder = buildOrder(paths, start, cursors, "codex", "R7.finalize", null);
    const order = {
      ...baseOrder,
      inputs: [
        {
          agent: "codex",
          commitSha: revisionSha,
          path: ".signals/issue-1/revision-ready-codex.json",
          kind: "consensus"
        }
      ]
    };
    const observation = await loop.verifyFinalizationChecks(
      start,
      order,
      {
        agent: "codex",
        actionId: order.actionId,
        submissionSha: "e".repeat(40),
        status: "satisfied",
        outstanding: [],
        productPin: finalSha
      },
      cursors
    );
    expect(observation.status).toBe("rejected");
    expect(observation.outstanding.join(" ")).toContain("finalization check (tier: checks) check failed");
    // Which tier failed must be legible in the journal: the agent's own clone
    // runs the declared `verify` before a commit exists, and only the hermetic
    // `checks` at the approved commit reach here.
    const finalCheck = readJournal(paths).find((event) => event.type === "final-check");
    expect(finalCheck?.details).toMatchObject({ tier: "checks", name: "check", exitCode: 1, durationMs: 2500 });
    expect(readJournal(paths).find((event) => event.type === "verification-run")?.details.durationMs).toBe(2500);
    expect(pushes).toBe(0);
    expect(opens).toBe(0);
    expect(readCursorsState(paths).publication.status).toBe("not-required");
  });
});

describe("coordinator verification gates", () => {
  const cached = { inputs: "tree-excluding-evidence" as const, env: [], probes: [["probe"]] };
  const gateFixture = (mode: "coordinator" | "local") => {
    const { root, paths } = fixture();
    const seed = join(root, "gate-seed");
    mkdirSync(join(seed, "src"), { recursive: true });
    git(seed, "init", "-q");
    writeFileSync(join(seed, "src/a.ts"), "baseline\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "baseline");
    const baselineSha = git(seed, "rev-parse", "HEAD");
    mkdirSync(join(seed, ".signals/issue-1"), { recursive: true });
    writeFileSync(join(seed, "src/a.ts"), "implementation\n");
    writeFileSync(join(seed, ".signals/issue-1/implementation-ready-codex.json"), "{}\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "implementation");
    const implementationPin = git(seed, "rev-parse", "HEAD");
    writeFileSync(join(seed, ".signals/issue-1/revision-ready-codex.json"), "{}\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "evidence only");
    const consensusSha = git(seed, "rev-parse", "HEAD");
    rmSync(join(seed, ".signals"), { recursive: true });
    git(seed, "add", "-u");
    git(seed, "commit", "-qm", "evidence cleanup");
    const finalSha = git(seed, "rev-parse", "HEAD");
    git(root, "clone", "--bare", "-q", seed, paths.mirror);
    const checks = [
      { name: "install", argv: ["install"] },
      { name: "lint", argv: ["lint"], cache: cached },
      { name: "build", argv: ["build"] },
      { name: "e2e", argv: ["e2e"], cache: cached, expensive: true }
    ];
    writeFileSync(paths.start, JSON.stringify({ ...readStartState(paths), baselineSha, checks,
      ...(mode === "local" ? {} : {
        verificationDigest: "d".repeat(64),
        verification: { mode: "coordinator", maxConcurrentExpensive: 1,
          coordinated: { precommit: [], prepush: [] },
          candidate: { checks: checks.slice(0, 2), covers: { prefixes: ["src/"], files: [] }, rules: [] } }
      }) }));
    const calls: string[] = [];
    let failing: string | null = null;
    const processRunner = async (argv: readonly string[]) => {
      calls.push(argv[0]!);
      if (argv[0] === "probe") return { exitCode: 0, stdout: "probe 1.0\n", stderr: "" };
      return argv[0] === failing ? { exitCode: 1, stdout: "", stderr: `${argv[0]} broke` } : { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const loop = () => new CoordinatorRunLoop(paths, { tmux: null, mirror: new BareMirror(paths.mirror, seed), processRunner });
    const observe = (stepId: "R4.implement" | "R6.revise", productPin: string) => {
      const order = buildOrder(paths, readStartState(paths), readCursorsState(paths), "codex", stepId, stepId === "R6.revise" ? 1 : null);
      return { order, observation: { agent: "codex", actionId: order.actionId, submissionSha: productPin,
        status: "satisfied" as const, outstanding: [], productPin } };
    };
    return { paths, calls, loop, observe, implementationPin, consensusSha, finalSha, fail: (name: string | null) => { failing = name; } };
  };

  it("rejects a failing candidate with its command and log, and fails again after a restart", async () => {
    const gate = gateFixture("coordinator");
    gate.fail("lint");
    const { order, observation } = gate.observe("R4.implement", gate.implementationPin);
    const rejected = await gate.loop().verifyCandidateChecks(readStartState(gate.paths), order, observation, readCursorsState(gate.paths));
    expect(rejected.status).toBe("rejected");
    const logPath = /\(log: (.+?)\)/.exec(rejected.outstanding[0]!)?.[1];
    expect(rejected.outstanding[0]).toContain("candidate check lint failed with exit 1");
    expect(readFileSync(logPath!, "utf8")).toContain("lint broke");
    expect(readJournal(gate.paths).filter((event) => event.type === "candidate-check").at(-1)?.details).toMatchObject({ outcome: "failed" });
    // No receipt exists for a failure: a restarted coordinator runs it again and fails again.
    const restarted = await gate.loop().verifyCandidateChecks(readStartState(gate.paths), order, observation, readCursorsState(gate.paths));
    expect(restarted.status).toBe("rejected");
    expect(gate.calls.filter((call) => call === "lint")).toHaveLength(2);
  });

  it("shares one execution across equivalent pins and finalization runs only what no receipt covers", async () => {
    const gate = gateFixture("coordinator");
    const implemented = gate.observe("R4.implement", gate.implementationPin);
    const passed = await gate.loop().verifyCandidateChecks(readStartState(gate.paths), implemented.order, implemented.observation,
      readCursorsState(gate.paths));
    expect(passed.status).toBe("satisfied");
    expect(passed.checkResults?.map((result) => [result.name, result.receiptId === undefined])).toEqual([["install", true], ["lint", false]]);
    expect(gate.calls.filter((call) => call !== "probe")).toEqual(["install", "lint"]);

    // A revision pin differing only by coordination evidence reuses the lint receipt.
    gate.calls.length = 0;
    const revised = gate.observe("R6.revise", gate.consensusSha);
    const reused = await gate.loop().verifyCandidateChecks(readStartState(gate.paths), revised.order, revised.observation,
      readCursorsState(gate.paths));
    expect(reused.checkResults?.find((result) => result.name === "lint")).toMatchObject({ reused: true });
    expect(gate.calls.filter((call) => call !== "probe")).toEqual(["install"]);
    expect(readJournal(gate.paths).filter((event) => event.type === "verification-reused")).toHaveLength(1);

    const finalOrder = { ...buildOrder(gate.paths, readStartState(gate.paths), readCursorsState(gate.paths), "codex", "R7.finalize", null),
      inputs: [{ agent: "codex", commitSha: gate.consensusSha, path: ".signals/issue-1/revision-ready-codex.json", kind: "consensus" }] };
    const finalObservation = { agent: "codex", actionId: finalOrder.actionId, submissionSha: gate.finalSha,
      status: "satisfied" as const, outstanding: [], productPin: gate.finalSha };
    gate.calls.length = 0;
    const final = await gate.loop().verifyFinalizationChecks(readStartState(gate.paths), finalOrder, finalObservation,
      readCursorsState(gate.paths));
    expect(final.status).toBe("satisfied");
    expect(gate.calls.filter((call) => call !== "probe")).toEqual(["install", "build", "e2e"]);
    expect(readJournal(gate.paths).filter((event) => event.type === "final-check").map((event) => event.details.name))
      .toEqual(["install", "build", "e2e"]);

    // Without receipts the full declared gate runs.
    rmSync(join(gate.paths.coordRoot, "verification"), { recursive: true });
    gate.calls.length = 0;
    await gate.loop().verifyFinalizationChecks(readStartState(gate.paths), finalOrder, finalObservation, readCursorsState(gate.paths));
    expect(gate.calls.filter((call) => call !== "probe")).toEqual(["install", "lint", "build", "e2e"]);
  });

  it("leaves local-mode submissions to the hooks and binds recorded results into later actions", async () => {
    const gate = gateFixture("local");
    const { order, observation } = gate.observe("R4.implement", gate.implementationPin);
    expect(await gate.loop().verifyCandidateChecks(readStartState(gate.paths), order, observation, readCursorsState(gate.paths)))
      .toBe(observation);
    expect(gate.calls).toEqual([]);

    const result = { name: "lint", argv: ["lint"], exitCode: 0, reused: true, receiptId: "f".repeat(64), logPath: "/logs/lint.log" };
    const cursors = { ...readCursorsState(gate.paths), accepted: [{ stepId: "R4.implement" as const, agent: "codex", round: null,
      submissionSha: "e".repeat(40), productPin: gate.implementationPin, path: ".signals/issue-1/implementation-ready-codex.json",
      acceptedAt: new Date().toISOString(), checkResults: [result] }] };
    const compare = buildOrder(gate.paths, readStartState(gate.paths), cursors, "claude", "R5.compare", null);
    expect(compare.candidateResults).toEqual([{ agent: "codex", commitSha: gate.implementationPin, results: [result] }]);
  });
});

describe("advisory verification ingestion", () => {
  const measurementFixture = () => {
    const { root, paths } = fixture();
    const clone = join(root, "measurement-clone");
    mkdirSync(clone);
    git(clone, "init", "-q", "--initial-branch=issue-1/codex");
    git(clone, "config", "consensus.agentId", "codex");
    writeFileSync(paths.start, JSON.stringify({ ...readStartState(paths),
      agents: [{ id: "codex", root: clone, launcher: "start-codex.sh", delivery: "pull" }] }));
    writeFileSync(join(root, "config.json"), JSON.stringify({ project: "fixture", origin: "/origin.git",
      agents: readStartState(paths).agents, branch: "issue-{issue}/{agent}", checks: [{ name: "test", argv: ["true"] }] }));
    const warnings: string[] = [];
    const record = hookVerificationRecorder(clone, join(root, "config.json"), (message) => warnings.push(message));
    const measurement = verificationMeasurement({ trigger: "hook", phase: "precommit", inputIdentity: "index:abc",
      classification: "coordination", reason: "evidence only", command: null, exitCode: 0,
      skipReason: "coordination evidence only", startedAt: readStartState(paths).createdAt, completedAt: readStartState(paths).createdAt });
    const start = readStartState(paths);
    const now = new Date(Date.parse(start.createdAt) + 1000).toISOString();
    return { root, paths, clone, record, warnings, measurement, start, now };
  };

  it("deduplicates across ticks and restart without rescanning per record, and changes no gates", () => {
    const { paths, clone, record, warnings, measurement, start, now } = measurementFixture();
    record(measurement);
    expect(warnings).toEqual([]);
    const mailbox = join(clone, ".coord/verification");
    const recordPath = join(mailbox, readdirSync(mailbox)[0]!);
    const bytes = readFileSync(recordPath, "utf8");
    const before = readCursorsState(paths);
    const ingest = createVerificationIngestor();
    const reads = vi.spyOn(stateModule, "readJournal");
    ingest(paths, clone, "codex", start, now);
    expect(existsSync(recordPath)).toBe(false);
    writeFileSync(recordPath, bytes);
    record(verificationMeasurement({ ...measurement }));
    ingest(paths, clone, "codex", start, now);
    expect(reads).toHaveBeenCalledTimes(1);
    writeFileSync(recordPath, bytes); // Append-before-unlink crash replay after restart.
    createVerificationIngestor()(paths, clone, "codex", start, now);
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockRestore();
    writeFileSync(recordPath, bytes.replace(readStartState(paths).issueSessionId, "stale-session"));
    ingest(paths, clone, "codex", start, now);
    expect(existsSync(recordPath)).toBe(false);
    const events = readJournal(paths).filter((event) => event.type === "verification-run");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ at: now, details: { completedAt: measurement.completedAt } });
    expect(readCursorsState(paths)).toEqual(before);
  });

  it("bounds draining and discards invalid, stale, oversized, symlinked and skewed records", () => {
    const { root, paths, clone, record, measurement, start, now } = measurementFixture();
    record(measurement);
    const mailbox = join(clone, ".coord/verification");
    const recordPath = join(mailbox, `${measurement.measurementId}.json`);
    const row = JSON.parse(readFileSync(recordPath, "utf8"));
    const ingest = createVerificationIngestor();
    for (const changed of [
      { ...row, issueSessionId: null }, { ...row, issueSessionId: "stale" },
      { ...row, measurement: { ...measurement, trigger: "coordinator" } },
      { ...row, measurement: { ...measurement, startedAt: "2000-01-01T00:00:00.000Z", completedAt: "2000-01-01T00:00:00.000Z" } },
      { ...row, measurement: { ...measurement, startedAt: "2099-01-01T00:00:00.000Z", completedAt: "2099-01-01T00:00:00.000Z" } },
      { ...row, measurement: { ...measurement, startedAt: now } },
      { ...row, measurement: { ...measurement, durationMs: 999 } }
    ]) {
      writeFileSync(recordPath, JSON.stringify(changed));
      ingest(paths, clone, "codex", start, now);
      expect(existsSync(recordPath)).toBe(false);
    }
    writeFileSync(recordPath, "x".repeat(65537));
    ingest(paths, clone, "codex", start, now);
    expect(existsSync(recordPath)).toBe(false);
    const target = join(root, "untouched.json");
    writeFileSync(target, "do not follow");
    symlinkSync(target, recordPath);
    ingest(paths, clone, "codex", start, now);
    expect(readFileSync(target, "utf8")).toBe("do not follow");
    expect(readdirSync(mailbox)).toEqual([]);
    for (let index = 0; index < 129; index++) writeFileSync(join(mailbox, `${randomUUID()}.json`), "invalid JSON");
    ingest(paths, clone, "codex", start, now);
    expect(readdirSync(mailbox)).toHaveLength(1);
    ingest(paths, clone, "codex", start, now);
    expect(readdirSync(mailbox)).toEqual([]);
    expect(readJournal(paths).filter((event) => event.type === "verification-run")).toEqual([]);
  });

  it.each(["manual", "unreadable session"])("does not accumulate unattributed %s observations", (kind) => {
    const { root, paths, clone, warnings, measurement } = measurementFixture();
    if (kind === "manual") git(clone, "symbolic-ref", "HEAD", "refs/heads/codex/manual");
    else rmSync(paths.start);
    const record = hookVerificationRecorder(clone, join(root, "config.json"), (message) => warnings.push(message));
    record(measurement);
    expect(warnings.join("")).toContain("no readable matching issue session");
    expect(existsSync(join(clone, ".coord/verification"))).toBe(false);
  });
});

/**
 * The coordinator already holds every bound artifact in its mirror. Exporting
 * them once per issue is what lets an agent read a peer's plan or browse a
 * peer's implementation as ordinary files, instead of each of N agents fetching
 * and `git show`-ing the same blobs.
 */
describe("materialized bound inputs", () => {
  const documents = (pins: readonly [string, string, string][]) =>
    pins.map(([agent, commitSha, kind]) => ({
      agent,
      commitSha,
      path: `.plans/issue-1/${kind === "review" ? "review" : "plan"}.md`,
      kind
    }));

  const readingMirror = (contents: Record<string, string> = {}) => {
    const calls: string[] = [];
    return {
      calls,
      readBlob: async (sha: string, path: string) => {
        calls.push(`${sha}:${path}`);
        return contents[`${sha}:${path}`] ?? `body of ${sha}:${path}\n`;
      },
      materializeWorktree: async () => undefined,
      removeWorktree: async () => undefined
    };
  };

  it("writes one content-addressed packet with a manifest that matches the files", async () => {
    const { paths } = fixture();
    const mirror = readingMirror();
    const inputs = documents([
      ["claude", "1".repeat(40), "plan"],
      ["codex", "2".repeat(40), "plan"],
      ["codex", "3".repeat(40), "review"]
    ]);

    const result = await materializeBoundInputs({ mirror, paths, inputs });

    expect(result.inputSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.packetDir).toBe(join(paths.issueInputsRoot, result.inputSetHash as string));
    expect(result.entries).toHaveLength(3);
    expect(result.omitted).toEqual([]);

    for (const entry of result.entries) {
      // Every path the action will list has to exist, and hold exactly the
      // bytes the cited pin holds.
      const onDisk = readFileSync(entry.localPath, "utf8");
      expect(onDisk).toBe(`body of ${entry.commitSha}:${entry.path}\n`);
      expect(entry.sha256).toBe(createHash("sha256").update(onDisk).digest("hex"));
    }

    const manifest = JSON.parse(readFileSync(result.manifestPath as string, "utf8")) as {
      inputSetHash: string;
      entries: { commitSha: string; localPath: string; sha256: string }[];
    };
    expect(manifest.inputSetHash).toBe(result.inputSetHash);
    expect(manifest.entries.map((entry) => entry.localPath).sort()).toEqual(
      result.entries.map((entry) => entry.localPath).sort()
    );
  });

  /**
   * A packet is immutable and named by what it holds, so re-preparing the same
   * action must cost nothing. Re-reading the blobs would move the very
   * per-read cost this change removes from the agents onto the coordinator,
   * once per action rather than once per issue.
   */
  it("reuses an existing packet without reading the mirror again", async () => {
    const { paths } = fixture();
    const inputs = documents([["claude", "4".repeat(40), "plan"]]);

    const first = readingMirror();
    const before = await materializeBoundInputs({ mirror: first, paths, inputs });
    expect(first.calls).toHaveLength(1);

    const second = readingMirror();
    const after = await materializeBoundInputs({ mirror: second, paths, inputs });
    expect(second.calls).toEqual([]);
    expect(after.packetDir).toBe(before.packetDir);
    expect(after.entries.map((entry) => entry.localPath)).toEqual(
      before.entries.map((entry) => entry.localPath)
    );
  });

  /**
   * Convenience state must never be able to stall an issue: the action still
   * cites the pin, and the pinned `git show` fallback still reaches it.
   */
  it("omits an unreadable document instead of failing preparation", async () => {
    const { paths } = fixture();
    const mirror = {
      readBlob: async () => null,
      materializeWorktree: async () => undefined,
      removeWorktree: async () => undefined
    };
    const result = await materializeBoundInputs({
      mirror,
      paths,
      inputs: documents([["claude", "5".repeat(40), "plan"]])
    });
    expect(result.entries).toEqual([]);
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0]).toContain("unreadable");
  });

  it("materializes one worktree per distinct pin and prunes superseded ones", async () => {
    const { paths } = fixture();
    const created: [string, string][] = [];
    const removed: string[] = [];
    const shared = "6".repeat(40);
    const mirror = {
      readBlob: async () => null,
      materializeWorktree: async (target: string, sha: string) => {
        created.push([target, sha]);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "marker"), sha);
      },
      removeWorktree: async (target: string) => {
        removed.push(target);
      }
    };
    const pins = [
      { agent: "claude", commitSha: shared, path: ".signals/x.json", kind: "implementation" },
      { agent: "codex", commitSha: shared, path: ".signals/y.json", kind: "implementation" },
      { agent: "codex", commitSha: "7".repeat(40), path: ".signals/z.json", kind: "implementation" }
    ];

    const result = await materializeBoundInputs({ mirror, paths, inputs: pins });

    // Two distinct pins, three inputs: the shared pin is checked out once.
    expect(created).toHaveLength(2);
    expect(created.map(([, sha]) => sha)).toEqual([shared, "7".repeat(40)]);
    expect(result.worktrees).toHaveLength(2);
    expect(result.worktrees[0]?.localPath).toBe(join(paths.issueWorktreesRoot, `claude-${shared.slice(0, 8)}`));

    // A later action binding only the second pin retires the first.
    const keep = worktreeLabelsFor(paths, [pins[2] as (typeof pins)[number]]);
    const pruned = await pruneSupersededWorktrees({ mirror, paths, keep });
    expect(pruned).toEqual([join(paths.issueWorktreesRoot, `claude-${shared.slice(0, 8)}`)]);
    // Unregistered through the mirror before the directory goes: pruning a
    // registration whose directory still exists collects nothing.
    expect(removed).toEqual(pruned);
    expect(existsSync(join(paths.issueWorktreesRoot, `claude-${shared.slice(0, 8)}`))).toBe(false);
    expect(existsSync(join(paths.issueWorktreesRoot, `codex-${"7".repeat(8)}`))).toBe(true);
  });

  /**
   * The wiring, not just the module: an action that names a file must not be
   * published before that file exists, or the first agent to read it is worse
   * off than before.
   */
  it("publishes an action whose listed bound-input paths already exist", async () => {
    const { paths } = fixture();
    const now = "2026-08-11T17:00:00.000Z";
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R3.review", gateId: "gate-3-selection", round: null },
        accepted: current.activeRoster.map((agent, index) => ({
          stepId: "R2.plan" as const,
          agent,
          round: null,
          submissionSha: String(index + 1).repeat(40),
          path: `.plans/issue-1/plan.md`,
          acceptedAt: now
        })),
        agents: Object.fromEntries(
          current.activeRoster.map((agent) => [
            agent,
            { ...current.agents[agent], stepId: "R3.review", status: "idle", actionId: null }
          ])
        ),
        updatedAt: now
      })
    );

    const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
      const command = args[2] ?? "";
      if (command === "show") {
        return { exitCode: 0, stdout: Buffer.from(`# plan for ${args[3] ?? ""}\n`), stderr: "" };
      }
      if (command === "rev-parse") return { exitCode: 0, stdout: Buffer.from(`${"d".repeat(40)}\n`), stderr: "" };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    await new CoordinatorRunLoop(paths, { mirror, tmux: null }).runTick();

    const body = readFileSync(agentRuntimePaths(paths, "claude").action, "utf8");
    expect(body).toContain("## Bound input files");
    const listed = [...body.matchAll(/: "([^"]+)"$/gm)].map((match) => match[1] as string);
    expect(listed.length).toBeGreaterThan(0);
    for (const path of listed) {
      expect(existsSync(path), path).toBe(true);
      expect(path.startsWith(paths.issueInputsRoot) || path.startsWith(paths.issueWorktreesRoot)).toBe(true);
    }
  });

  /**
   * A rejected artifact is re-issued as the same action with corrections. That
   * is the worst moment to lose the exported paths: the agent is being asked to
   * fix something, and the shim still refuses the reads the files replaced.
   */
  it.each(["R3.review", "R3.plan-ballot"] as const)("keeps the bound-input paths when %s is re-issued without leaking private corrections", async (stepId) => {
    const { paths } = fixture();
    const now = "2026-08-11T17:00:00.000Z";
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId, gateId: "gate-3-selection", round: null },
        accepted: current.activeRoster.map((agent, index) => ({
          stepId: "R2.plan" as const,
          agent,
          round: null,
          submissionSha: String(index + 1).repeat(40),
          path: ".plans/issue-1/plan.md",
          acceptedAt: now
        })),
        agents: Object.fromEntries(
          current.activeRoster.map((agent) => [
            agent,
            { ...current.agents[agent], stepId, status: "idle", actionId: null }
          ])
        ),
        updatedAt: now
      })
    );
    const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
      const command = args[2] ?? "";
      if (command === "show") return { exitCode: 0, stdout: Buffer.from("# a plan\n"), stderr: "" };
      if (command === "rev-parse") return { exitCode: 0, stdout: Buffer.from(`${"d".repeat(40)}\n`), stderr: "" };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    const messages: string[] = [], verbose: string[] = [];
    const loop = new CoordinatorRunLoop(paths, { mirror, tmux: null,
      log: (message) => messages.push(message), verbose: (message) => verbose.push(message) });
    await loop.runTick();

    const actionPath = agentRuntimePaths(paths, "claude").action;
    const first = readFileSync(actionPath, "utf8");
    expect(first).toContain("## Bound input files");

    // Private parse failures can contain ballot values, unlike public Git corrections.
    if (stepId === "R3.plan-ballot") {
      const actionId = readCursorsState(paths).agents.claude!.actionId!;
      writeAgentResponse(agentResponsePath(paths, "claude", actionId), paths.issueRoot,
        { actionId, choice: "private-choice", rationale: "Private rationale." });
      writeFileSync(agentRuntimePaths(paths, "claude").complete, `response ${actionId}\n`);
    } else {
      writeFileSync(agentRuntimePaths(paths, "claude").complete, "not-a-sha\n");
    }
    await loop.runTick();

    const reissued = readFileSync(actionPath, "utf8");
    expect(reissued).toContain("Correct these outstanding items");
    expect(reissued).toContain("## Bound input files");
    if (stepId === "R3.plan-ballot") {
      expect(reissued).toContain("choice private-choice is not eligible");
      expect(verbose.join("\n")).toContain("1 validation finding(s); see its task file");
      expect([...messages, ...verbose].join("\n")).not.toMatch(/private-choice|Private rationale/);
    }
    const boundPaths = [...reissued.matchAll(/^- .*: "([^"]+)"$/gm)].map((match) => match[1] as string);
    expect(boundPaths.length).toBeGreaterThan(0);
    for (const path of boundPaths) {
      expect(existsSync(path), path).toBe(true);
    }
  });

  /**
   * A packet is content-addressed and handed to every agent on the step as
   * verified peer input. Checking only that a file is present would let one
   * whose bytes were replaced be served under a pin that still looks right.
   */
  it("rebuilds a packet whose recorded digest no longer matches its bytes", async () => {
    const { paths } = fixture();
    const inputs = [
      { agent: "claude", commitSha: "8".repeat(40), path: ".plans/issue-1/plan.md", kind: "plan" }
    ];
    const mirror = {
      readBlob: async () => "the real plan\n",
      materializeWorktree: async () => undefined,
      removeWorktree: async () => undefined
    };

    const first = await materializeBoundInputs({ mirror, paths, inputs });
    const entry = first.entries[0] as { localPath: string; sha256: string };

    // Tamper: same path, different bytes.
    chmodSync(entry.localPath, 0o600);
    writeFileSync(entry.localPath, "substituted\n");

    const second = await materializeBoundInputs({ mirror, paths, inputs });
    expect(second.omitted.join(" ")).toContain("failed validation and was rebuilt");
    expect(readFileSync(entry.localPath, "utf8")).toBe("the real plan\n");
    expect(second.entries[0]?.sha256).toBe(entry.sha256);
  });

  /**
   * `<agent>-<sha8>` is not a unique function of the pin. Reusing on the path
   * alone lets an action cite one commit and point every reader at another
   * tree, with nothing in the action looking wrong.
   */
  it("replaces a worktree whose checkout does not match the bound pin", async () => {
    const { paths } = fixture();
    const pin = "9".repeat(40);
    const created: string[] = [];
    const removed: string[] = [];
    const mirror = {
      readBlob: async () => null,
      materializeWorktree: async (target: string, sha: string) => {
        created.push(sha);
        mkdirSync(target, { recursive: true });
        execFileSync("git", ["init", "-q", target]);
        writeFileSync(join(target, "marker"), sha);
      },
      removeWorktree: async (target: string) => {
        removed.push(target);
      }
    };
    const inputs = [{ agent: "claude", commitSha: pin, path: ".signals/x.json", kind: "implementation" }];

    const first = await materializeBoundInputs({ mirror, paths, inputs });
    const localPath = first.worktrees[0]?.localPath as string;
    expect(existsSync(localPath)).toBe(true);
    // The stub tree's HEAD is not the pin, which is exactly the collision shape:
    // the directory exists and holds the wrong commit.
    const second = await materializeBoundInputs({ mirror, paths, inputs });
    expect(removed).toEqual([localPath]);
    expect(created).toEqual([pin, pin]);
    expect(second.worktrees[0]?.localPath).toBe(localPath);
  });

  it("leaves nothing to materialize for a step that binds no artifacts", async () => {
    const { paths } = fixture();
    const mirror = readingMirror();
    const result = await materializeBoundInputs({ mirror, paths, inputs: [] });
    expect(result).toMatchObject({ inputSetHash: null, packetDir: null, entries: [], worktrees: [] });
    expect(mirror.calls).toEqual([]);
  });
});

describe("coordinator-resolved change scope", () => {
  const pinnedInputs = (pins: readonly [string, string][]) =>
    pins.map(([agent, commitSha]) => ({
      agent,
      commitSha,
      path: `.signals/issue-1/implementation-ready-${agent}.json`,
      kind: "implementation"
    }));

  const countingMirror = (paths: readonly string[]) => {
    const calls: string[] = [];
    return {
      calls,
      changedPaths: async (base: string, tip: string) => {
        calls.push(`${base}..${tip}`);
        return [...paths];
      }
    };
  };

  it("resolves one entry per pinned input", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const mirror = countingMirror(["src/b.ts", "src/a.ts"]);
    const scope = await resolveChangeScope(
      mirror,
      start,
      pinnedInputs([
        ["claude", "1".repeat(40)],
        ["codex", "2".repeat(40)]
      ])
    );
    expect(scope.map((entry) => entry.agent)).toEqual(["claude", "codex"]);
    expect(scope[0]?.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(scope[0]?.truncated).toBe(false);
  });

  /**
   * The whole point of resolving centrally: four agents comparing the same pins
   * must cost one diff per pin, not one per agent per pin.
   */
  it("reads each distinct pin once even when several inputs share it", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const mirror = countingMirror(["src/a.ts"]);
    const shared = "3".repeat(40);
    await resolveChangeScope(
      mirror,
      start,
      pinnedInputs([
        ["claude", shared],
        ["codex", shared],
        ["cursor", "4".repeat(40)]
      ])
    );
    expect(mirror.calls).toEqual([`${start.baselineSha}..${shared}`, `${start.baselineSha}..${"4".repeat(40)}`]);
  });

  it("does no git work for a step with no pinned inputs", async () => {
    const { paths } = fixture();
    const mirror = countingMirror(["src/a.ts"]);
    const scope = await resolveChangeScope(mirror, readStartState(paths), [
      { agent: "claude", commitSha: "5".repeat(40), path: ".plans/issue-1/plan.md", kind: "plan" }
    ]);
    expect(scope).toEqual([]);
    expect(mirror.calls).toEqual([]);
  });

  it("caps a large diff and marks it truncated", async () => {
    const { paths } = fixture();
    const many = Array.from({ length: CHANGE_SCOPE_PATH_LIMIT + 5 }, (_, index) =>
      `src/f${String(index).padStart(4, "0")}.ts`
    );
    const scope = await resolveChangeScope(countingMirror(many), readStartState(paths), pinnedInputs([["claude", "6".repeat(40)]]));
    expect(scope[0]?.paths).toHaveLength(CHANGE_SCOPE_PATH_LIMIT);
    expect(scope[0]?.truncated).toBe(true);
  });

  /**
   * Advisory scope must never be able to stall a step: an unreadable pin is
   * omitted, and the action is still prepared.
   */
  it("omits a pin whose diff cannot be read rather than failing preparation", async () => {
    const { paths } = fixture();
    const failing = {
      changedPaths: async () => {
        throw new Error("unknown revision");
      }
    };
    const scope = await resolveChangeScope(failing, readStartState(paths), pinnedInputs([["claude", "7".repeat(40)]]));
    expect(scope).toEqual([]);
  });

  /**
   * The memoisation guarantee has to hold on the failure path too. Caching only
   * successes meant four agents bound to one unreadable pin produced four
   * failing git invocations per tick — the exact per-agent repetition this
   * feature exists to remove, surviving in the branch no test covered.
   */
  it("attempts an unreadable pin once per tick, not once per input", async () => {
    const { paths } = fixture();
    let attempts = 0;
    const failing = {
      changedPaths: async () => {
        attempts += 1;
        throw new Error("unknown revision");
      }
    };
    const broken = "8".repeat(40);
    const scope = await resolveChangeScope(
      failing,
      readStartState(paths),
      pinnedInputs([
        ["claude", broken],
        ["codex", broken],
        ["cursor", broken]
      ])
    );
    expect(scope).toEqual([]);
    expect(attempts).toBe(1);
  });

  // The branch is prepared before any agent starts, but an agent that compacts
  // or restarts only has the action in front of it. It used to be told once, on
  // the first action of the run.
  it("tells every action that the branch is already checked out", () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    for (const stepId of ["R1.join", "R2.plan", "R4.implement", "R7.finalize"] as const) {
      const order = buildOrder(paths, start, cursors, "claude", stepId, null);
      expect(order.task, stepId).toContain("already checked this clone out");
      expect(order.task, stepId).toContain("Do not create that branch");
      // Said once, not twice, on the step that used to carry it inline.
      expect(order.task.split("already checked this clone out").length - 1, stepId).toBe(1);
      expect(order.task.includes("Containment check"), stepId).toBe(stepId === "R1.join");
    }
    // A restarted agent still has complete probe instructions in the protocol,
    // without making action content depend on asynchronous lifecycle evidence.
    const protocol = readFileSync(join(repoRoot, "templates/product/AGENTS.protocol.md"), "utf8");
    expect(protocol).toContain("after a restart/configuration change");
    expect(protocol).toContain("coord containment-probe --issue");
    expect(protocol).toContain("Do not repeat for every action");
  });

  it("carries configured context paths from start state into every order", () => {
    const { paths } = fixture();
    const start = { ...readStartState(paths), contextPaths: ["docs/repo-map.md"] };
    const order = buildOrder(paths, start, readCursorsState(paths), "claude", "R2.plan", null);
    expect(order.contextPaths).toEqual(["docs/repo-map.md"]);
    expect(order.changeScope).toEqual([]);
  });

  it("derives revision-limit consensus at round 3 with objections and distinct input set hash", () => {
    const { paths } = fixture();
    const now = "2026-08-11T17:00:00.000Z";
    const revSha = "8".repeat(40);
    const revision: AcceptedSubmission = {
      stepId: "R6.revise",
      agent: "codex",
      round: 3,
      submissionSha: "7".repeat(40),
      productPin: revSha,
      path: ".signals/issue-1/revision-ready-codex-round-3.json",
      acceptedAt: now
    };
    const ballots: AcceptedResponse[] = [
      acceptedResponseFixture({ stepId: "R6.ballot", agent: "codex", round: 3, disposition: "approve" }),
      acceptedResponseFixture({ stepId: "R6.ballot", agent: "claude", round: 3, disposition: "revise" })
    ];
    const batch = publishedBallotBatchFixture({
      kind: "consensus-ballot-batch",
      round: 3,
      activeRoster: ["claude", "codex"]
    });
    const state = cursorsStateSchema.parse({
      ...readCursorsState(paths),
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 3 },
      activeRoster: ["claude", "codex"],
      derived: {
        planSelection: null,
        implementationSelection: {
          kind: "implementation-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "b".repeat(64),
          activeRoster: ["claude", "codex"],
          inputs: [
            {
              kind: "implementation",
              agent: "codex",
              submissionSha: "e".repeat(40),
              path: ".signals/issue-1/implementation-ready-codex.json",
              productPin: "e".repeat(40)
            }
          ],
          decisionId: `implementation-selection:${"b".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          winner: "codex",
          implementationPin: "e".repeat(40),
          reviser: "codex"
        },
        consensus: null
      },
      accepted: [revision],
      acceptedResponses: ballots,
      ballotBatches: [batch]
    });

    const derived = computeConsensusDerived(state, 3, now);
    expect(derived).not.toBeNull();
    expect(derived?.algorithm).toBe("revision-limit-active-roster-v1");
    expect(derived?.round).toBe(3);
    expect(derived?.consensusPin).toBe(revSha);
    if (derived?.algorithm === "revision-limit-active-roster-v1") {
      expect(derived.objectors).toEqual(["claude"]);
    }

    const unanimousHash = computeDerivedInputSetHash("consensus", state.activeRoster, derived!.inputs, 3);
    expect(derived?.inputSetHash).not.toBe(unanimousHash);
    expect(derived?.inputSetHash).toBe(
      computeDerivedInputSetHash("consensus:revision-limit", state.activeRoster, derived!.inputs, 3)
    );
  });

  it("recovers obsolete round 3 revision-limit owner question on restart", async () => {
    const { paths } = fixture();
    const now = "2026-08-11T17:00:00.000Z";
    const revSha = "8".repeat(40);
    const revision: AcceptedSubmission = {
      stepId: "R6.revise",
      agent: "codex",
      round: 3,
      submissionSha: "7".repeat(40),
      productPin: revSha,
      path: ".signals/issue-1/revision-ready-codex-round-3.json",
      acceptedAt: now
    };
    const ballots: AcceptedResponse[] = [
      acceptedResponseFixture({ stepId: "R6.ballot", agent: "codex", round: 3, disposition: "approve" }),
      acceptedResponseFixture({ stepId: "R6.ballot", agent: "claude", round: 3, disposition: "revise" })
    ];
    const batch = publishedBallotBatchFixture({
      kind: "consensus-ballot-batch",
      round: 3,
      activeRoster: ["claude", "codex"]
    });
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 3 },
        activeRoster: ["claude", "codex"],
        derived: {
          planSelection: null,
          implementationSelection: {
            kind: "implementation-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "b".repeat(64),
            activeRoster: ["claude", "codex"],
            inputs: [
            {
              kind: "implementation",
              agent: "codex",
              submissionSha: "e".repeat(40),
              path: ".signals/issue-1/implementation-ready-codex.json",
              productPin: "e".repeat(40)
            }
          ],
            decisionId: `implementation-selection:${"b".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            winner: "codex",
            implementationPin: "e".repeat(40),
            reviser: "codex"
          },
          consensus: null
        },
        accepted: [revision],
        acceptedResponses: ballots,
        ballotBatches: [batch],
        ownerQuestion: {
          id: "30000000-0000-4000-8000-000000000001",
          kind: "revision-limit",
          round: 3,
          allowedAnswers: ["retry", "abandon"],
          createdAt: now
        }
      })
    );

    const loop = new CoordinatorRunLoop(paths, { tmux: null, now: () => now });
    const after = await loop.runTick();
    expect(after.ownerQuestion).toBeNull();
    expect(after.derived.consensus?.algorithm).toBe("revision-limit-active-roster-v1");
    expect(after.issueCursor.stepId).toBe("R6.follow-up");
  });

  it("preserves terminal round 3 consensus and final pin across late non-reviser drops", () => {
    const { paths } = fixture();
    const now = "2026-08-11T17:00:00.000Z";
    const revSha = "8".repeat(40);
    const revision: AcceptedSubmission = {
      stepId: "R6.revise",
      agent: "codex",
      round: 3,
      submissionSha: "7".repeat(40),
      productPin: revSha,
      path: ".signals/issue-1/revision-ready-codex-round-3.json",
      acceptedAt: now
    };
    const ballots: AcceptedResponse[] = [
      acceptedResponseFixture({ stepId: "R6.ballot", agent: "codex", round: 3, disposition: "approve" }),
      acceptedResponseFixture({ stepId: "R6.ballot", agent: "claude", round: 3, disposition: "revise" })
    ];
    const batch = publishedBallotBatchFixture({
      kind: "consensus-ballot-batch",
      round: 3,
      activeRoster: ["claude", "codex"]
    });
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R6.follow-up", gateId: "gate-6-consensus", round: 3 },
        activeRoster: ["claude", "codex"],
        derived: {
          planSelection: {
            kind: "plan-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "a".repeat(64),
            activeRoster: ["claude", "codex"],
            inputs: [
              {
                kind: "plan",
                agent: "codex",
                submissionSha: "e".repeat(40),
                path: ".plans/issue-1/plan.md"
              }
            ],
            decisionId: `plan-selection:${"a".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            selectedAgents: ["codex"]
          },
          implementationSelection: {
            kind: "implementation-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "b".repeat(64),
            activeRoster: ["claude", "codex"],
            inputs: [
              {
                kind: "implementation",
                agent: "codex",
                submissionSha: "e".repeat(40),
                path: ".signals/issue-1/implementation-ready-codex.json",
                productPin: "e".repeat(40)
              }
            ],
            decisionId: `implementation-selection:${"b".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            winner: "codex",
            implementationPin: "e".repeat(40),
            reviser: "codex"
          },
          consensus: {
            kind: "consensus",
            algorithm: "revision-limit-active-roster-v1",
            inputSetHash: "c".repeat(64),
            activeRoster: ["claude", "codex"],
            inputs: [
              {
                kind: "revision",
                agent: "codex",
                submissionSha: "e".repeat(40),
                path: ".signals/issue-1/revision-ready-codex-round-3.json"
              }
            ],
            decisionId: `consensus:${"c".repeat(64)}:r3`,
            supersedes: null,
            decidedAt: now,
            round: 3,
            consensusPin: revSha,
            objectors: ["claude"]
          }
        },
        accepted: [revision],
        acceptedResponses: ballots,
        ballotBatches: [batch]
      })
    );

    const droppedState = dropOwnerAgent(paths, "claude", now);
    expect(droppedState.activeRoster).toEqual(["codex"]);
    expect(droppedState.derived.consensus?.consensusPin).toBe(revSha);
    expect(droppedState.derived.implementationSelection?.winner).toBe("codex");
    expect(droppedState.derived.consensus?.algorithm).toBe("unanimous-active-roster-v1");
    expect(droppedState.issueCursor.stepId).toBe("R7.finalize");
  });

  it("verifies follow-up receipts and includes closeout reason and links in PR", async () => {
    const { paths } = fixture({ prPolicy: "coord-open-unmerged", origin: "https://github.com/example/project.git" });
    const now = "2026-08-11T17:00:00.000Z";
    const revSha = "8".repeat(40);
    seedPendingPublication(paths, revSha);

    const current = readCursorsState(paths);
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        derived: {
          ...current.derived,
          consensus: {
            kind: "consensus",
            algorithm: "revision-limit-active-roster-v1",
            inputSetHash: "c".repeat(64),
            activeRoster: ["claude", "codex"],
            inputs: [
              {
                kind: "revision",
                agent: "codex",
                submissionSha: "e".repeat(40),
                path: ".signals/issue-1/revision-ready-codex-round-3.json"
              }
            ],
            decisionId: `consensus:${"c".repeat(64)}:r3`,
            supersedes: null,
            decidedAt: now,
            round: 3,
            consensusPin: revSha,
            objectors: ["claude"]
          }
        },
        accepted: [
          ...current.accepted,
          {
            stepId: "R6.follow-up",
            agent: "claude",
            round: 3,
            submissionSha: "d".repeat(40),
            path: ".signals/issue-1/follow-up-ready-claude-round-3.json",
            acceptedAt: now,
            followUpIssue: 105,
            followUpUrl: "https://github.com/example/project/issues/105"
          }
        ]
      })
    );

    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git", async () => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: ""
    }));

    const opened: Array<{ draft: boolean; title: string; body: string }> = [];
    const result = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      pullRequestOpener: async (input) => {
        opened.push({ draft: input.draft, title: input.title, body: input.body });
        return { url: "https://github.com/example/project/pull/10" };
      }
    }).runTick();

    expect(result.publication.status).toBe("completed");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.body).toContain("Conclusion: Concluded development at the third revision limit with unresolved objections.");
    expect(opened[0]?.body).toContain("Follow-up issues filed by objecting agents:");
    expect(opened[0]?.body).toContain("- claude: #105 (https://github.com/example/project/issues/105)");
  });
});
