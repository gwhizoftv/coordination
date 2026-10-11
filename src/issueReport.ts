import type { BallotBatch, CursorsState, StartState } from "./state.js";
import { coordMergesPullRequest, describeWorkflowStep, type WorkflowStepId } from "./steps.js";
import { containmentCoverage, stopObservationWarning } from "./agentLifecycle.js";
import { containmentPolicy } from "./shellGuard.js";
import { shellQuote } from "./agentHookSync.js";

export const issueCommand = (command: string, issue: number, coordRoot: string): string =>
  `coord ${command} --issue ${issue} --coord-runtime ${shellQuote(coordRoot)}`;

const stageNames: Record<WorkflowStepId, string> = {
  "R1.join": "checking agent readiness", "R2.plan": "writing plans", "R3.review": "reviewing plans",
  "R3.plan-ballot": "choosing a plan", "R4.implement": "implementing", "R4.amend-ballot": "reviewing scope changes",
  "R5.compare": "reviewing implementations", "R5.compare-ballot": "choosing an implementation",
  "R6.revise": "revising", "R6.ballot": "reviewing the revision",
  "R6.follow-up": "filing follow-up issues", "R7.finalize": "finalizing"
};

export const holdDescription = (reason: CursorsState["holds"][number]["reason"]): string => ({
  "nudge-loop": "automatic reminder limit reached; inspect the agent, then use r to confirm four more sends",
  "delivery-uncertain": "a reminder may have been partly typed; inspect the agent before allowing another send",
  "harness-gone": "the agent terminal is unavailable; restore it before releasing this hold",
  "vendor-wait": "the agent application is waiting for its own retry",
  "vendor-failure": "the agent application reported a failure; inspect its terminal",
  unobservable: "the terminal cannot be inspected; restore terminal access before releasing this hold"
})[reason];

const finalization = (cursors: CursorsState) =>
  [...cursors.accepted].reverse().find((submission) => submission.stepId === "R7.finalize");

const latestBatchByUpdatedAt = (batches: readonly BallotBatch[]): BallotBatch | null => {
  if (batches.length === 0) return null;
  return [...batches].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).at(-1) ?? null;
};

/** One scoped recovery command, shared by immediate hold logs and status. */
export const holdRecoveryCommand = (issue: number, cursors: CursorsState, hold: CursorsState["holds"][number], coordRoot: string): string => {
  const uniqueAgent = cursors.activeRoster.includes(hold.agent) &&
    cursors.holds.filter((entry) => entry.agent === hold.agent).length === 1;
  return `coord resume --issue ${issue} ` +
    (uniqueAgent ? `--agent ${hold.agent}` : `--hold ${hold.id}`) +
    (hold.reason === "nudge-loop" ? " --reset-nudge-budget" : "") + ` --coord-runtime ${shellQuote(coordRoot)}`;
};

/**
 * What the owner needs after a run: who won, which commit is the PR head,
 * which branch coord pushed, evidence publication state, and whether they
 * still have to merge. Never exposes ballot choices, dispositions, rationales,
 * or pending response bytes.
 */
export const renderIssueReport = (
  start: StartState,
  cursors: CursorsState,
  lifecycle?: import("./agentLifecycle.js").AgentLifecycleState
): string => {
  const r7 = finalization(cursors);
  const acceptedImplementation = cursors.accepted
    .filter(
      (submission) =>
        submission.stepId === "R4.implement" && cursors.activeRoster.includes(submission.agent)
    )
    .at(-1);
  const pin = cursors.publication.finalSha ?? r7?.productPin ?? null;
  const chosen =
    cursors.derived.implementationSelection?.winner ?? acceptedImplementation?.agent ?? r7?.agent;
  const implementationPin =
    cursors.derived.implementationSelection?.implementationPin ??
    acceptedImplementation?.productPin ??
    r7?.productPin ??
    null;
  const branch = cursors.publication.branch;
  const url = cursors.publication.url;
  const phase = cursors.abandoned
    ? "abandoned"
    : cursors.paused
      ? "paused"
      : cursors.completed
        ? "complete"
        : (stageNames[cursors.issueCursor.stepId] ?? "running");
  const needsAction = cursors.paused || cursors.holds.length > 0 || cursors.ownerQuestion != null || cursors.publication.status === "failed";
  const uncertain = lifecycle !== undefined && cursors.activeRoster.some((id) => {
    const entry = lifecycle.agents[id];
    const root = start.agents.find((agent) => agent.id === id)?.root;
    return entry === undefined || entry.health !== "healthy" || stopObservationWarning(id, entry) !== null ||
      containmentCoverage(entry, root === undefined ? null : containmentPolicy(root, id)?.binding ?? null).hook !== "active";
  });
  const cue = needsAction ? "[ACTION]" : uncertain ? "[WARN]" : cursors.completed ? "[OK]" : "[WAIT]";
  // Labeled, not bare dashes: the report lands between log lines and the
  // interactive prompt, so the owner must see exactly where it begins and ends.
  const lines = [
    `==== coord status: issue ${start.issue} ====`,
    `${cue} Issue ${start.issue}: ${phase}`,
    `Pull request handling: ${cursors.completed && cursors.publication.status === "not-required" ? "you open and merge it (legacy owner-only)" : coordMergesPullRequest(start.prPolicy) ? "coordinator opens and merges it" : "coordinator opens a draft; you review and merge"}.`,
    `Chosen agent: ${chosen ?? "(not selected yet)"}`,
    `Implementation commit: ${implementationPin ?? "(none)"}`,
    `Final commit (PR head): ${pin ?? "(none)"}`,
    `Published branch: ${branch ?? "(not pushed yet)"}`
  ];
  if (cursors.manualPaused) lines.push(`Manual pause: active (${issueCommand("resume", start.issue, start.coordRoot)} clears only this pause).`);
  for (const hold of cursors.holds) {
    const sends = cursors.actionSafety[hold.agent]?.sends ?? 0;
    const evidence = hold.evidence ?? null;
    const cause = evidence === null ? "No provider failure confirmed" : `cause ${evidence.failureClass} (${evidence.vendor}, ${evidence.classConfidence})`;
    // An exact provider epoch is when to recheck, never a promise of availability.
    const reset = hold.resetsAt === null ? "provider recovery time unknown" : `provider reset ${hold.resetsAt} (recheck time, not guaranteed availability)`;
    lines.push(`[ACTION] Hold ${hold.id}: ${hold.agent}: ${holdDescription(hold.reason)}; sends ${sends}/4.`);
    lines.push(`${cause}; ${reset}. Who acts next: ${hold.retryOwner === "vendor" ? "the agent application's own retry" : "you"}.`);
    if (evidence !== null && evidence.windows.length > 0) {
      lines.push(`Blocked windows: ${evidence.windows.map((window) =>
        `${window.limitId}/${window.window} ${window.usedPercent ?? "?"}% (resets ${window.resetsAt ?? "unknown"})`).join("; ")}.`);
    }
    if (evidence?.detail !== null && evidence?.detail !== undefined) lines.push(`Vendor detail (redacted): ${evidence.detail}`);
    lines.push(`Recovery: inspect the agent, then ${holdRecoveryCommand(start.issue, cursors, hold, start.coordRoot)}`);
  }
  if (cursors.paused) {
    lines.push("The running coordinator waits and continues after all pauses are released; add --run to resume only if the coordinator was stopped.");
  }
  for (const agent of new Set(cursors.holds.map((hold) => hold.agent))) {
    const safety = cursors.actionSafety[agent];
    const resource = safety?.resource;
    if (resource === undefined || (resource.starts === 0 && resource.nextAt === null && resource.terminal === null)) continue;
    if (resource.terminal !== null) {
      lines.push(`Resource observation (${agent}): stopped (${resource.terminal}); owner release required.`);
      if (resource.terminal.includes("reaped")) {
        lines.push(`Before any further quota read, confirm no codex app-server is running for the bound home, then remove its record under ${start.coordRoot}/resource-bindings/.`);
      }
    } else if (resource.nextAt !== null) {
      lines.push(`Resource observation (${agent}): next automatic check at ${resource.nextAt}; quota reads ${resource.starts}/6.`);
    } else {
      lines.push(`Resource observation (${agent}): none scheduled; owner release required. Quota reads ${resource.starts}/6.`);
    }
  }
  if (url !== null) lines.push(`Pull request: ${url}`);
  else if (pin !== null && cursors.publication.status === "not-required") {
    lines.push(
      `Pull request: none (legacy owner-only). Open a PR from the final commit, not from issue-${start.issue}/<agent>.`
    );
  } else if (cursors.publication.status === "failed") {
    lines.push(`Pull request: not opened (${cursors.publication.error ?? "publication failed"})`);
  } else if (cursors.completed) {
    lines.push("Pull request: pending publication");
  }
  if (cursors.publication.status === "completed" && url !== null) {
    lines.push(
      coordMergesPullRequest(start.prPolicy)
        ? "Merge: coordinator merged this PR."
        : "Merge: owner merges this PR (draft until you mark it ready)."
    );
  } else if (cursors.publication.status === "failed" && url !== null && coordMergesPullRequest(start.prPolicy)) {
    lines.push(`Merge: coordinator merge failed (${cursors.publication.error}). Merge at the URL above.`);
  }
  if (cursors.publication.error !== null && cursors.publication.status === "failed") {
    lines.push(`Error: ${cursors.publication.error}`);
  }

  const evidenceBranch = cursors.evidence.branch;
  const evidenceTip = cursors.evidence.tip;
  if (evidenceBranch !== null) {
    lines.push(
      `Evidence branch: ${evidenceBranch}` +
        (evidenceTip !== null ? ` (latest published tip ${evidenceTip})` : " (no published tip yet)")
    );
  } else {
    lines.push("Evidence branch: (none yet)");
  }

  const pending = cursors.ballotBatches.filter((batch) => batch.status === "pending");
  const failed = cursors.ballotBatches.filter((batch) => batch.status === "failed");
  const pendingLatest = latestBatchByUpdatedAt(pending);
  const failedLatest = latestBatchByUpdatedAt(failed);
  if (pendingLatest !== null) {
    lines.push(
      `Evidence publication: pending (${pendingLatest.kind}` +
        (pendingLatest.round === null ? "" : ` round ${pendingLatest.round}`) +
        `, commit ${pendingLatest.commitSha})`
    );
  } else if (failedLatest !== null) {
    lines.push(
      `Evidence publication: failed (${failedLatest.kind}` +
        (failedLatest.round === null ? "" : ` round ${failedLatest.round}`) +
        `${failedLatest.error === null ? "" : `: ${failedLatest.error}`})`
    );
  } else if (cursors.ballotBatches.some((batch) => batch.status === "published")) {
    lines.push("Evidence publication: published");
  }

  const consensus = cursors.derived.consensus;
  if (consensus?.algorithm === "revision-limit-active-roster-v1") {
    lines.push(
      `Conclusion: revision limit reached at round ${consensus.round}. Final revision ${consensus.consensusPin}. Objections remain objections.`
    );
    const filed = cursors.accepted.filter(
      (submission) =>
        submission.stepId === "R6.follow-up" &&
        submission.round === consensus.round &&
        cursors.activeRoster.includes(submission.agent)
    );
    const objectors = consensus.objectors.filter((agent) => cursors.activeRoster.includes(agent));
    lines.push(`Follow-up issues filed: ${filed.length}/${objectors.length}.`);
    for (const submission of filed) {
      if (submission.followUpIssueUrl !== undefined) lines.push(`Follow-up issue: ${submission.followUpIssueUrl}`);
    }
    const outstanding = objectors.filter((agent) => !filed.some((submission) => submission.agent === agent));
    if (outstanding.length > 0) lines.push(`Follow-up issues still to file: ${outstanding.join(", ")}.`);
    for (const response of cursors.acceptedResponses) {
      if (
        response.stepId === "R6.ballot" &&
        response.round === consensus.round &&
        cursors.droppedAgents.includes(response.agent) &&
        (response.disposition === "revise" || response.disposition === "escalate")
      ) {
        lines.push(`Dropped objection: ${response.agent} is dropped, not approved and not filed.`);
      }
    }
  }

  if (lifecycle !== undefined) {
    for (const agent of start.agents) {
      const entry = lifecycle.agents[agent.id];
      if (!cursors.activeRoster.includes(agent.id)) continue;
      if (entry === undefined) { lines.push(`[WARN] Agent ${agent.id}: no activity report yet; inspect the terminal and hook setup.`); continue; }
      const queue = entry.pendingInputCount === null ? "" : `, pending=${entry.pendingInputCount}`;
      const background = entry.backgroundActive === true ? ", background-active" : "";
      const alert = entry.degradedCause === null ? "" : `, alert=${entry.degradedCause}`;
      const coverage = containmentCoverage(entry, containmentPolicy(agent.root, agent.id)?.binding ?? null);
      const probe = entry.containment?.probe;
      const delivery = { ordered: "task file published; not yet sent", injected: "task message sent; waiting for acknowledgment",
        accepted: "agent acknowledged the task" };
      const execution = { unknown: "activity not yet known", queued: "input queued", working: "working; no intervention needed",
        idle: "idle", failed: "agent reported a failure" };
      lines.push(
        `Agent ${agent.id}: ${entry.action === null ? "no current task" : delivery[entry.action.delivery]}; ${execution[entry.execution]}; activity reports ${entry.health}${queue}${background}${alert}` +
        `, containment hook=${coverage.hook} shim=${coverage.shim}` +
        (entry.sessionId === null ? " (session identity unavailable)" : "") +
        (probe ? ` (agent-observed ${probe.at}, session=${probe.sessionId}, vendor=${probe.vendorVersion}, policy=${probe.policyRevision})` : "")
      );
      if (entry.action?.workflowCompleteAt != null) lines.push(`  [OK] ${agent.id}: submission validated and accepted.`);
      if (coverage.hook !== "active") lines.push(`  [WARN] ${agent.id}: runtime hook trust/activity not yet verified; inspect the terminal's trust prompt and hook setup.`);
      const warning = stopObservationWarning(agent.id, entry);
      if (warning !== null) lines.push(`  [WARN] ${warning}`);
    }
  }
  lines.push(`Active step: ${stageNames[cursors.issueCursor.stepId]} (${describeWorkflowStep(cursors.issueCursor.stepId, cursors.issueCursor.round)})`,
    `Active roster: ${cursors.activeRoster.join(", ")}`, `Queued guidance: ${cursors.ownerGuidance?.pending.length ?? 0}`,
    `==== end coord status: issue ${start.issue} ====`);
  return `${lines.join("\n")}\n`;
};
