import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import {
  actionIdSchema,
  artifactCitationSchema,
  planAmendmentRequestSchema,
  agentIdSchema,
  citationDigestSchema,
  digestSchema,
  gitShaSchema,
  issueSchema,
  issueSessionIdSchema,
  repositoryPathSchema
} from "./protocol.js";
import { assertNoSymlink, containedPath, type IssueRuntimePaths } from "./paths.js";
import { resourceEvidenceSchema } from "./resourceEvidence.js";
import {
  DEFAULT_MAX_REVISION_ROUNDS,
  DEFAULT_PR_POLICY,
  type EvidenceId,
  type GateId,
  type PrPolicy,
  type WorkflowProfile,
  type WorkflowStepId
} from "./steps.js";

export const RUNTIME_FORMAT_VERSION = 4;

const LEGACY_RUNTIME_FORMAT_VERSIONS = new Set([2, 3]);

export const isLegacyRuntimeFormat = (value: unknown): value is 2 | 3 =>
  typeof value === "number" && LEGACY_RUNTIME_FORMAT_VERSIONS.has(value);

const RUNTIME_FORMAT_WIPE_MESSAGE =
  "Runtime format versions 2 and 3 are no longer supported. Wipe this issue with `coord wipe-issue <issue>` and start it again.";

const workflowProfileSchema = z.enum(["solo", "reviewed", "consensus"]);
const prPolicySchema = z.enum(["owner-only", "coord-open-unmerged", "coord-merged"]);
const deliverySchema = z.enum(["pull", "nudge", "both"]);
const stepIdSchema = z.enum([
  "R1.join",
  "R2.plan",
  "R3.review",
  "R3.plan-ballot",
  "R4.implement",
  "R4.amend-ballot",
  "R5.compare",
  "R5.compare-ballot",
  "R6.revise",
  "R6.ballot",
  "R6.follow-up",
  "R7.finalize"
]);
const gateIdSchema = z.enum([
  "gate-1-join",
  "gate-2-plans",
  "gate-3-selection",
  "gate-4-implementations",
  "gate-5-comparison",
  "gate-6-consensus",
  "gate-7-finalized"
]);
const evidenceIdSchema = z.enum([
  "join-published",
  "plan-published",
  "review-published",
  "plan-response-accepted",
  "implementation-pinned",
  "amendment-response-accepted",
  "comparison-published",
  "comparison-response-accepted",
  "revision-pinned",
  "consensus-response-accepted",
  "follow-up-published",
  "finalization-verified"
]);
const ballotStepIdSchema = z.enum(["R3.plan-ballot", "R5.compare-ballot", "R6.ballot", "R4.amend-ballot"]);
const timestampSchema = z.string().datetime({ offset: true });

/**
 * Which inputs a coordinator receipt may treat as equivalent. Absent means the
 * command is never cached; commands that read Git history, commit identity,
 * external services or undeclared environment must stay uncached.
 */
export const checkCacheSchema = z
  .object({
    inputs: z.enum(["tree", "tree-excluding-evidence"]),
    env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
    probes: z.array(z.array(z.string()).min(1)).default([]),
    /**
     * Untracked worktree inputs the command reads, such as installed
     * dependencies, hashed when the command runs and again afterwards.
     */
    dependencies: z.array(repositoryPathSchema).default([]),
    /**
     * Exact paths inside `dependencies` left out of the digest: tool state that
     * changes on every install or run (timestamps, caches) and is not an input.
     */
    dependencyExcludes: z.array(repositoryPathSchema).default([])
  })
  .strict();

export const checkCommandSchema = z
  .object({
    name: z.string().min(1),
    argv: z.array(z.string()).min(1),
    /** Coordinator-run commands only: bounded by `maxConcurrentExpensive`. */
    expensive: z.boolean().optional(),
    cache: checkCacheSchema.optional(),
    /** Diagnostic re-runs after a failure; the original failure stays the outcome. */
    retry: z.number().int().min(0).max(2).optional()
  })
  .strict();

/**
 * Local verification the agent-clone hooks run, declared as argument vectors so
 * the hook bodies never branch on an ecosystem marker or grep the product for a
 * script name. Absent means "undeclared" and fails an agent clone closed; the
 * two empty arrays are the explicit, recorded way to opt out.
 */
export const verifyConfigSchema = z
  .object({
    precommit: z.array(checkCommandSchema),
    prepush: z.array(checkCommandSchema)
  })
  .strict();

export const verifyPhaseSchema = z.enum(["precommit", "prepush"]);

/** Opt-in prose/image allowlist; never infer documentation from an extension. */
export const documentationProfileSchema = z.object({
  paths: z.array(repositoryPathSchema).min(1),
  verify: verifyConfigSchema,
  checks: z.array(checkCommandSchema).min(1)
}).strict();

/**
 * Critical path fragments, also exposed by the legacy hook-scope interface.
 * That compatibility interface is line-oriented, so whitespace is rejected
 * rather than producing an ambiguous token an older hook would mis-split.
 */
const pathTokenSchema = z
  .string()
  .min(1)
  .refine((value) => !/\s/.test(value), "workflow-critical entries must not contain whitespace");

const pathMatchShape = {
  prefixes: z.array(pathTokenSchema).default([]),
  files: z.array(pathTokenSchema).default([])
};

/**
 * Opt-in coordinator-owned verification. `local` (the default) keeps today's
 * hook behavior. `coordinator` binds hooks to `coordinated` only while a clone
 * is in an active coordinator run, and gates every implementation/revision pin
 * on `candidate`. Paths outside `covers` and every rule run the full `checks`.
 */
export const verificationPolicySchema = z
  .object({
    mode: z.enum(["local", "coordinator"]).default("local"),
    coordinated: verifyConfigSchema.optional(),
    candidate: z
      .object({
        checks: z.array(checkCommandSchema).min(1),
        covers: z.object(pathMatchShape).strict(),
        rules: z
          .array(
            z
              .object({
                ...pathMatchShape,
                add: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)])
              })
              .strict()
          )
          .default([])
      })
      .strict()
      .optional(),
    maxConcurrentExpensive: z.number().int().min(1).max(8).default(1)
  })
  .strict();

/** What a workspace was installed against, so `coord doctor` can report drift. */
export const installStampSchema = z
  .object({
    installRoot: z.string().min(1),
    cliEntry: z.string().min(1),
    version: z.string().min(1),
    commit: gitShaSchema,
    /**
     * Digest of the hook bodies, shim template, and launcher template the
     * clones actually execute. The commit alone cannot see an uncommitted edit
     * to a canonical body, which is how a hook rewritten to `exit 0` passed
     * inspection while every clone ran it.
     */
    canonicalDigest: digestSchema,
    installedAt: timestampSchema,
    productRoot: z.string().min(1),
    cloneRoot: z.string().min(1),
    vendored: z.boolean(),
    /** Bootstrap commands were run in the install checkout. */
    bootstrapped: z.boolean(),
    /**
     * Coordination created the install checkout and may therefore delete it.
     * Running `pnpm install` inside somebody's existing clone is not ownership.
     */
    ownsInstallRoot: z.boolean(),
    wroteProductIgnore: z.boolean(),
    wroteAgentsMd: z.boolean(),
    /**
     * Resolved absolute mailbox root this workspace was installed against.
     * Optional so a stamp written before the mailbox existed still parses; a
     * reinstall fills it in.
     */
    completesRoot: z.string().min(1).optional()
  })
  .strict();

export const agentConfigSchema = z
  .object({
    id: agentIdSchema,
    root: z.string().min(1),
    launcher: z.string().min(1),
    delivery: deliverySchema.default("pull"),
    harnessProcess: z.string().min(1).optional(),
    /** tmux send-keys before the nudge text (e.g. vim insert `i`). */
    nudgePrelude: z.array(z.string().min(1)).optional(),
    /** tmux send-keys after the nudge text (e.g. Enter or C-j). */
    nudgeSubmit: z.array(z.string().min(1)).optional(),
    /** macOS Terminal.app settings-set (profile) name for owner attach windows. */
    terminalProfile: z.string().min(1).optional(),
    /**
     * Owner-confirmed Codex quota binding (#140). Explicit configuration is the
     * confirmation: the coordinator never discovers a home or account itself.
     */
    codexQuota: z
      .object({
        codexHome: z
          .string()
          .min(1)
          .refine((value) => isAbsolute(value) && resolve(value) === value, "codexHome must be an absolute canonical path"),
        accountId: z.string().trim().min(1),
        /**
         * The Codex CLI version the owner validated live for automatic
         * recovery. Without it, quota reads only enrich holds and every
         * resource hold waits for the owner.
         */
        validatedVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const coordinatorConfigSchema = z
  .object({
    project: z.string().min(1),
    origin: z.string().min(1),
    agents: z.array(agentConfigSchema).min(1),
    branch: z.string().refine((value) => value.includes("{issue}") && value.includes("{agent}")),
    baseBranch: z.string().min(1).default("main"),
    profile: workflowProfileSchema.default("consensus"),
    maxRevisionRounds: z.literal(DEFAULT_MAX_REVISION_ROUNDS).default(DEFAULT_MAX_REVISION_ROUNDS),
    prPolicy: prPolicySchema.default(DEFAULT_PR_POLICY),
    digestPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "digest path must be confined")
      )
      .default([]),
    contextPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "context path must be confined")
      )
      .default([]),
    checks: z.array(checkCommandSchema).min(1),
    pollIntervalMs: z.number().int().min(100).max(60_000).default(1_000),
    toolchain: z.string().min(1).optional(),
    verify: verifyConfigSchema.optional(),
    documentation: documentationProfileSchema.optional(),
    verification: verificationPolicySchema.optional(),
    workflowCriticalPrefixes: z.array(pathTokenSchema).default([]),
    workflowCriticalFiles: z.array(pathTokenSchema).default([]),
    /**
     * Absolute root of the completion mailbox. Optional: a flat workspace
     * derives the sibling of the runtime directory. Nested or shared runtimes that do
     * not share that parent must state it, because the derived sibling would
     * put two products' receipts in one tree.
     */
    completesRoot: z.string().min(1).optional(),
    coordination: installStampSchema.optional()
  })
  .strict()
  .superRefine((config, context) => {
    const ids = config.agents.map((agent) => agent.id);
    for (const [index, agent] of config.agents.entries()) {
      if (agent.codexQuota !== undefined && agent.id !== "codex") {
        context.addIssue({ code: "custom", message: "codexQuota is only valid on the codex agent", path: ["agents", index, "codexQuota"] });
      }
    }
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "agent ids must be unique", path: ["agents"] });
    }
    if (new Set(config.digestPaths).size !== config.digestPaths.length) {
      context.addIssue({ code: "custom", message: "digest paths must be unique", path: ["digestPaths"] });
    }
    if (new Set(config.contextPaths).size !== config.contextPaths.length) {
      context.addIssue({ code: "custom", message: "context paths must be unique", path: ["contextPaths"] });
    }
    refineVerificationPolicy(config.verification, config.checks, context);
  });

/**
 * A check name identifies one command everywhere it appears, so candidate
 * selection can deduplicate by name without dropping a different command a
 * risk rule required. Rules may only add commands the final gate declares.
 */
function refineVerificationPolicy(
  verification: z.infer<typeof verificationPolicySchema> | undefined,
  checks: readonly z.infer<typeof checkCommandSchema>[],
  context: z.RefinementCtx
): void {
  if (verification === undefined) return;
  const issue = (message: string, path: (string | number)[]) =>
    context.addIssue({ code: "custom", message, path: ["verification", ...path] });
  if (verification.mode === "coordinator" && (verification.coordinated === undefined || verification.candidate === undefined)) {
    issue("coordinator mode requires both coordinated and candidate", ["mode"]);
  }
  const finalNames = checks.map((check) => check.name);
  if (new Set(finalNames).size !== finalNames.length) {
    context.addIssue({ code: "custom", message: "check names must be unique when verification is declared", path: ["checks"] });
  }
  const candidate = verification.candidate;
  if (candidate === undefined) return;
  const candidateNames = candidate.checks.map((check) => check.name);
  if (new Set(candidateNames).size !== candidateNames.length) issue("candidate check names must be unique", ["candidate", "checks"]);
  for (const [index, check] of candidate.checks.entries()) {
    const same = checks.find((entry) => entry.name === check.name);
    if (same !== undefined && JSON.stringify(same.argv) !== JSON.stringify(check.argv)) {
      issue(`candidate check ${check.name} names a different command than the final check of that name`, ["candidate", "checks", index]);
    }
  }
  for (const [index, rule] of candidate.rules.entries()) {
    if (rule.add === "all") continue;
    for (const name of rule.add) {
      if (!finalNames.includes(name)) issue(`rule adds undeclared check ${name}`, ["candidate", "rules", index, "add"]);
    }
  }
}

/**
 * What an operator may hand to `coord install --declare`: the parts of a
 * workspace config that are the product's decision rather than the installer's.
 * Identity, agent roots, and the install stamp are deliberately absent — those
 * are derived from the arguments of the install itself, so a declaration file
 * cannot quietly redirect a clone.
 */
export const workspaceDeclarationSchema = z
  .object({
    toolchain: z.string().min(1).optional(),
    verify: verifyConfigSchema.optional(),
    documentation: documentationProfileSchema.optional(),
    verification: verificationPolicySchema.optional(),
    workflowCriticalPrefixes: z.array(pathTokenSchema).optional(),
    workflowCriticalFiles: z.array(pathTokenSchema).optional(),
    checks: z.array(checkCommandSchema).min(1).optional(),
    branch: z
      .string()
      .refine((value) => value.includes("{issue}") && value.includes("{agent}"))
      .optional(),
    prPolicy: prPolicySchema.optional(),
    digestPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "digest path must be confined")
      )
      .optional(),
    contextPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "context path must be confined")
      )
      .optional(),
    pollIntervalMs: z.number().int().min(100).max(60_000).optional()
  })
  .strict();

export const startStateSchema = z
  .object({
    formatVersion: z.literal(RUNTIME_FORMAT_VERSION),
    issue: issueSchema,
    issueSessionId: issueSessionIdSchema,
    baselineSha: gitShaSchema,
    profile: workflowProfileSchema,
    originalRoster: z.array(agentIdSchema).min(1),
    branchTemplate: z.string().min(1),
    baseBranch: z.string().min(1),
    maxRevisionRounds: z.literal(DEFAULT_MAX_REVISION_ROUNDS),
    prPolicy: prPolicySchema,
    automationDigest: digestSchema,
    automationDigestScheme: z.literal("sha256-length-prefixed-v1"),
    automationDigestSources: z
      .array(
        z
          .object({
            id: z.string().min(1),
            sha256: digestSchema
          })
          .strict()
      )
      .min(1),
    trustedSourceCommit: gitShaSchema,
    origin: z.string().min(1),
    coordRoot: z.string().min(1),
    /**
     * Where this issue's receipts live, frozen for the issue session.
     *
     * Read from here rather than from config on resume: `coord install` may
     * rewrite config mid-issue, and a mailbox that moved under a running action
     * would leave the coordinator polling a tree no agent holds a grant to.
     *
     * Optional for the same reason `contextPaths` is defaulted — a `start.json`
     * written before this field existed must still parse under the strict
     * schema. Every issue started since carries it, and readers fall back to the
     * derived default only for those older documents.
     */
    completesRoot: z.string().min(1).optional(),
    configPath: z.string().min(1),
    agents: z.array(agentConfigSchema).min(1),
    checks: z.array(checkCommandSchema).min(1),
    pollIntervalMs: z.number().int().min(100).max(60_000),
    documentation: documentationProfileSchema.optional(),
    /**
     * Frozen at start so a mid-issue `coord install` cannot switch hooks or
     * gates under a running issue. Absent (older start.json) means local mode.
     */
    verification: verificationPolicySchema.optional(),
    verificationDigest: digestSchema.optional(),
    workflowCriticalPrefixes: z.array(pathTokenSchema).optional(),
    workflowCriticalFiles: z.array(pathTokenSchema).optional(),
    /**
     * Advisory reading named in every action. Defaulted rather than required so
     * a start.json written before this field existed still parses under the
     * strict schema; see `StartStateInput` for the construction boundary.
     */
    contextPaths: z.array(z.string().min(1)).default([]),
    createdAt: timestampSchema
  })
  .strict();

export const startStateHeaderSchema = z.object({
  formatVersion: z.union([z.literal(2), z.literal(3), z.literal(RUNTIME_FORMAT_VERSION)]),
  issue: issueSchema,
  originalRoster: z.array(agentIdSchema).min(1),
  createdAt: timestampSchema,
  configPath: z.string().min(1),
  completesRoot: z.string().min(1).optional()
});

const analyticsCursorsHeaderSchema = z.object({
  formatVersion: z.union([z.literal(2), z.literal(3), z.literal(RUNTIME_FORMAT_VERSION)]),
  activeRoster: z.array(agentIdSchema).min(1),
  completed: z.boolean()
});

export const agentCursorSchema = z
  .object({
    lastAcceptedActionId: z.string().uuid().nullable().default(null),
    stepId: stepIdSchema.nullable(),
    evidenceId: evidenceIdSchema.nullable(),
    actionId: z.string().uuid().nullable(),
    submissionMode: z.enum(["git", "response"]).nullable(),
    actionDigest: digestSchema.nullable(),
    status: z.enum([
      "idle",
      "ordered",
      "intent",
      "verifying",
      "waiting-peer",
      "paused",
      "complete",
      "failed",
      "dropped"
    ]),
    attempt: z.number().int().nonnegative(),
    submissionSha: gitShaSchema.nullable(),
    outstanding: z.array(z.string()),
    updatedAt: timestampSchema
  })
  .strict();

const derivedInputKindSchema = z.enum([
  "plan",
  "plan-ballot",
  "implementation",
  "comparison-ballot",
  "revision",
  "consensus-ballot"
]);

const derivedInputCitationSchema = z
  .object({
    kind: derivedInputKindSchema,
    agent: agentIdSchema,
    submissionSha: citationDigestSchema,
    path: z.string().min(1),
    productPin: gitShaSchema.optional(),
    evidenceCommitSha: gitShaSchema.optional(),
    actionId: actionIdSchema.optional()
  })
  .strict();

const derivedDecisionBaseSchema = z
  .object({
    inputSetHash: digestSchema,
    activeRoster: z.array(agentIdSchema).min(1),
    inputs: z.array(derivedInputCitationSchema).min(1),
    decidedAt: timestampSchema
  })
  .strict();

const planSelectionDecisionIdSchema = z
  .string()
  .regex(/^plan-selection:[a-f0-9]{64}$/, "expected a plan-selection decision identity");

const implementationSelectionDecisionIdSchema = z
  .string()
  .regex(/^implementation-selection:[a-f0-9]{64}$/, "expected an implementation-selection decision identity");

const consensusDecisionIdSchema = z
  .string()
  .regex(/^consensus:[a-f0-9]{64}:r[1-9][0-9]*$/, "expected a round-bound consensus decision identity");

export const planSelectionDerivedSchema = derivedDecisionBaseSchema
  .extend({
    kind: z.literal("plan-selection"),
    algorithm: z.literal("plurality-active-roster-v1"),
    decisionId: planSelectionDecisionIdSchema,
    supersedes: planSelectionDecisionIdSchema.nullable(),
    selectedAgents: z.array(agentIdSchema).min(1)
  })
  .strict()
  .refine((record) => record.decisionId === `plan-selection:${record.inputSetHash}`, {
    path: ["decisionId"],
    message: "decision identity must match the plan-selection input hash"
  });

export const implementationSelectionDerivedSchema = derivedDecisionBaseSchema
  .extend({
    kind: z.literal("implementation-selection"),
    algorithm: z.literal("plurality-active-roster-v1"),
    decisionId: implementationSelectionDecisionIdSchema,
    supersedes: implementationSelectionDecisionIdSchema.nullable(),
    winner: agentIdSchema,
    implementationPin: gitShaSchema,
    reviser: agentIdSchema
  })
  .strict()
  .refine((record) => record.decisionId === `implementation-selection:${record.inputSetHash}`, {
    path: ["decisionId"],
    message: "decision identity must match the implementation-selection input hash"
  });

const consensusIdentity = (record: { decisionId: string; inputSetHash: string; round: number }): boolean =>
  record.decisionId === `consensus:${record.inputSetHash}:r${record.round}`;

const unanimousConsensusDerivedSchema = derivedDecisionBaseSchema
  .extend({
    kind: z.literal("consensus"),
    algorithm: z.literal("unanimous-active-roster-v1"),
    decisionId: consensusDecisionIdSchema,
    supersedes: consensusDecisionIdSchema.nullable(),
    round: z.number().int().min(1),
    consensusPin: gitShaSchema
  })
  .strict()
  .refine(consensusIdentity, {
    path: ["decisionId"],
    message: "decision identity must match the consensus input hash and round"
  });

const revisionLimitConsensusDerivedSchema = derivedDecisionBaseSchema
  .extend({
    kind: z.literal("consensus"),
    algorithm: z.literal("revision-limit-active-roster-v1"),
    decisionId: consensusDecisionIdSchema,
    supersedes: consensusDecisionIdSchema.nullable(),
    round: z.literal(3),
    consensusPin: gitShaSchema,
    objectors: z.array(agentIdSchema).min(1)
  })
  .strict()
  .refine(consensusIdentity, {
    path: ["decisionId"],
    message: "decision identity must match the consensus input hash and round"
  })
  .refine((record) => {
    const positions = record.objectors.map((agent) => record.activeRoster.indexOf(agent));
    return positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!));
  }, {
    path: ["objectors"],
    message: "objectors must be a nonempty ordered subset of the active roster"
  });

export const consensusDerivedSchema = z.union([unanimousConsensusDerivedSchema, revisionLimitConsensusDerivedSchema]);

export const derivedStateSchema = z
  .object({
    planSelection: planSelectionDerivedSchema.nullable(),
    implementationSelection: implementationSelectionDerivedSchema.nullable(),
    consensus: consensusDerivedSchema.nullable()
  })
  .strict();

export const acceptedSubmissionSchema = z
  .object({
    stepId: stepIdSchema,
    agent: agentIdSchema,
    round: z.number().int().min(1).nullable(),
    submissionSha: gitShaSchema,
    productPin: gitShaSchema.optional(),
    disposition: z.enum(["approve", "revise", "escalate"]).optional(),
    approvedPaths: z.array(z.string().min(1)).optional(),
    choice: agentIdSchema.optional(),
    followUpIssueUrl: z.string().url().optional(),
    followUpIssueNumber: z.number().int().positive().optional(),
    checkResults: z
      .array(
        z
          .object({
            name: z.string().min(1),
            argv: z.array(z.string()).min(1),
            exitCode: z.number().int(),
            reused: z.boolean().optional(),
            joined: z.boolean().optional(),
            receiptId: z.string().min(1).optional(),
            logPath: z.string().min(1).optional(),
            attempts: z.number().int().min(1).optional()
          })
          .strict()
      )
      .optional(),
    path: z.string().min(1),
    acceptedAt: timestampSchema
  })
  .strict();

export const acceptedResponseSchema = z
  .object({
    stepId: ballotStepIdSchema,
    agent: agentIdSchema,
    actionId: actionIdSchema,
    round: z.number().int().min(1).nullable(),
    responseSha256: digestSchema,
    choice: agentIdSchema.optional(),
    disposition: z.enum(["approve", "revise", "escalate"]).optional(),
    rationale: z.string().min(1),
    path: z.string().min(1),
    acceptedAt: timestampSchema
  })
  .strict();

export const ballotBatchSchema = z
  .object({
    batchId: z.string().uuid(),
    kind: z.enum(["plan-ballot-batch", "comparison-ballot-batch", "consensus-ballot-batch", "amendment-ballot-batch"]),
    round: z.number().int().min(1).nullable(),
    inputSetHash: digestSchema,
    activeRoster: z.array(agentIdSchema),
    responses: z.array(
      z
        .object({
          agent: agentIdSchema,
          actionId: actionIdSchema,
          responseSha256: digestSchema
        })
        .strict()
    ),
    paths: z.array(z.string().min(1)),
    branch: z.string().min(1),
    parentSha: gitShaSchema,
    commitSha: gitShaSchema,
    status: z.enum(["pending", "published", "failed", "invalidated"]),
    attempts: z.number().int().nonnegative(),
    error: z.string().nullable(),
    supersedes: z.string().uuid().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();

/**
 * Per-action resource observation budget (#140). Owner acknowledgment of a
 * hold keeps it: only genuinely new work starts a new episode.
 */
const resourceObservationSchema = z.object({
  starts: z.number().int().min(0).max(6).default(0),
  failures: z.number().int().min(0).max(3).default(0),
  /** Reservation persisted before any helper spawn; non-null across a crash means unknown outcome. */
  inFlight: z.string().uuid().nullable().default(null),
  nextAt: timestampSchema.nullable().default(null),
  consumedDeadlines: z.array(timestampSchema).max(16).default([]),
  /** Automatic observation is over for this action; only the owner can proceed. */
  terminal: z.string().min(1).nullable().default(null),
  /** Last failure episode turned into hold evidence; an owner release must not re-hold on it. */
  episode: z.string().min(1).max(512).nullable().default(null)
}).strict();

export const emptyResourceObservation = (): z.infer<typeof resourceObservationSchema> => ({
  starts: 0, failures: 0, inFlight: null, nextAt: null, consumedDeadlines: [], terminal: null, episode: null
});

const actionSafetySchema = z.object({
  actionId: z.string().uuid(),
  sends: z.number().int().nonnegative().default(0),
  lastSendAt: timestampSchema.nullable().default(null),
  reserved: z.boolean().default(false),
  deferrals: z.array(z.string()).default([]),
  holdGeneration: z.number().int().nonnegative().default(0),
  observationChecks: z.number().int().nonnegative().default(0),
  nextObservationAt: timestampSchema.nullable().default(null),
  activityAt: timestampSchema,
  resource: resourceObservationSchema.default(emptyResourceObservation)
}).strict();

const holdSchema = z.object({
  id: z.string().uuid(),
  agent: agentIdSchema,
  actionId: z.string().uuid(),
  sessionId: z.string().nullable(),
  reason: z.enum(["nudge-loop", "delivery-uncertain", "harness-gone", "unobservable", "vendor-wait", "vendor-failure"]),
  evidenceId: z.string(),
  observedAt: timestampSchema,
  /** Provider epoch only; `confidence` is deadline confidence, never cause confidence. */
  resetsAt: timestampSchema.nullable(),
  confidence: z.enum(["unknown", "exact"]),
  retryOwner: z.enum(["owner", "vendor"]),
  evidence: resourceEvidenceSchema.nullable().default(null)
}).strict().refine((hold) => (hold.confidence === "exact") === (hold.resetsAt !== null), "exact confidence requires a provider reset epoch");

export const pendingAmendmentSchema = z.object({
  sequence: z.number().int().positive(),
  request: artifactCitationSchema,
  proposal: planAmendmentRequestSchema,
  plans: z.array(artifactCitationSchema).min(1),
  activeRoster: z.array(agentIdSchema).min(1),
  resume: z.object({ stepId: z.enum(["R4.implement", "R6.revise"]), round: z.number().int().positive().nullable() }).strict(),
  requestedAt: timestampSchema
}).strict();

export const amendmentDecisionSchema = pendingAmendmentSchema.extend({
  outcome: z.enum(["approved", "rejected", "cancelled"]),
  evidenceSha: gitShaSchema.nullable(),
  ballots: z.array(artifactCitationSchema),
  rationale: z.string(),
  decidedAt: timestampSchema
}).strict();

export const guidanceEntrySchema = z.object({
  id: z.string().uuid(),
  text: z.string().refine(
    (text) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text), "Guidance must be one line without control characters."
  ).pipe(z.string().trim().min(1).max(2000)),
  enqueuedAt: timestampSchema
}).strict();

const boundGuidanceSchema = z.object({
  stepId: stepIdSchema,
  round: z.number().int().positive().nullable(),
  generation: z.number().int().nonnegative(),
  boundAt: timestampSchema,
  entries: z.array(guidanceEntrySchema)
}).strict();

const ownerGuidanceSchema = z.object({
  pending: z.array(guidanceEntrySchema).max(32),
  generation: z.number().int().nonnegative().default(0),
  bound: boundGuidanceSchema.nullable(),
  // An amendment interrupts work; its ballot must not erase that work's advice.
  suspended: boundGuidanceSchema.nullable().default(null)
}).strict();

const emptyOwnerGuidance = (): z.infer<typeof ownerGuidanceSchema> => ({
  pending: [], generation: 0, bound: null, suspended: null
});

export const cursorsStateSchema = z
  .object({
    formatVersion: z.literal(RUNTIME_FORMAT_VERSION),
    stateRevision: z.number().int().nonnegative(),
    issueCursor: z
      .object({
        stepId: stepIdSchema,
        gateId: gateIdSchema,
        round: z.number().int().min(1).nullable()
      })
      .strict(),
    activeRoster: z.array(agentIdSchema).min(1),
    droppedAgents: z.array(agentIdSchema),
    derived: derivedStateSchema,
    ownerGuidance: ownerGuidanceSchema.default(emptyOwnerGuidance),
    amendmentSequence: z.number().int().nonnegative().default(0),
    pendingAmendment: pendingAmendmentSchema.nullable().default(null),
    amendments: z.array(amendmentDecisionSchema).default([]),
    // Durable cleanup intent: never delete an old request before its transition is saved.
    amendmentRetirements: z.array(z.object({ agent: agentIdSchema, actionId: z.string().uuid() }).strict()).default([]),
    ownerQuestion: z
      .object({
        id: z.string().uuid(),
        kind: z.enum(["ballot-escalation", "revision-limit"]),
        round: z.number().int().min(1),
        allowedAnswers: z.array(z.enum(["retry", "revise", "abandon"])).min(1),
        createdAt: timestampSchema
      })
      .strict()
      .nullable(),
    lastOwnerAnswer: z
      .object({
        questionId: z.string().uuid(),
        answer: z.enum(["retry", "revise", "abandon"]),
        answeredAt: timestampSchema
      })
      .strict()
      .nullable(),
    publication: z
      .object({
        status: z.enum(["not-required", "pending", "completed", "failed"]),
        finalSha: gitShaSchema.nullable(),
        branch: z.string().min(1).nullable(),
        url: z.string().url().nullable(),
        error: z.string().min(1).nullable(),
        attempts: z.number().int().nonnegative()
      })
      .strict(),
    evidence: z
      .object({
        branch: z.string().min(1).nullable(),
        tip: gitShaSchema.nullable()
      })
      .strict(),
    paused: z.boolean(),
    manualPaused: z.boolean().default(false),
    holds: z.array(holdSchema).default([]),
    actionSafety: z.record(agentIdSchema, actionSafetySchema).default({}),
    /** Codex bindings whose one-time initial check was already triggered (#140). */
    resourceBindingChecks: z.record(agentIdSchema, timestampSchema).default({}),
    abandoned: z.boolean(),
    completed: z.boolean(),
    agents: z.record(agentIdSchema, agentCursorSchema),
    accepted: z.array(acceptedSubmissionSchema),
    acceptedResponses: z.array(acceptedResponseSchema),
    ballotBatches: z.array(ballotBatchSchema),
    updatedAt: timestampSchema
  })
  .strict();

const journalEventTypeSchema = z.enum([
  "started",
  "action-prepared",
  "nudged",
  "agent-lifecycle",
  "agent-usage",
  "agent-observability-degraded",
  "agent-observability-recovered",
  "nudge-deferred",
  "hold-created",
  "hold-released",
  "hold-updated",
  "resource-observation",
  "intent-seen",
  "verify-result",
  "gate-advanced",
  "owner-question",
  "owner-answer",
  "terminal-question-retired",
  "owner-guidance-queued",
  "owner-guidance-bound",
  "agent-dropped",
  "paused",
  "resumed",
  "action-restarted",
  "abandoned",
  "final-check",
  "verification-run",
  "candidate-check",
  "verification-reused",
  "verification-joined",
  "publication-pending",
  "publication-failed",
  "pr-created",
  "pr-merged",
  "decision-derived",
  "response-accepted",
  "ballot-batch-pending",
  "ballot-batch-published",
  "ballot-batch-failed",
  "ballot-batch-invalidated",
  "clone-readiness-refused",
  "amendment-requested",
  "amendment-decided"
]);

export const journalEventSchema = z
  .object({
    // Durable journal *files* still reject formats 2/3 via assertRuntimeFormat in
    // readJournal (wipe/restart). The schema allows 3 only so in-memory fixtures
    // outside the approved path map can parse without silently rewriting bytes.
    formatVersion: z.union([z.literal(RUNTIME_FORMAT_VERSION), z.literal(3)]),
    sequence: z.number().int().nonnegative(),
    at: timestampSchema,
    type: journalEventTypeSchema,
    agent: agentIdSchema.optional(),
    actionId: z.string().uuid().optional(),
    submissionSha: gitShaSchema.optional(),
    details: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type CheckCommand = z.infer<typeof checkCommandSchema>;
export type VerifyConfig = z.infer<typeof verifyConfigSchema>;
export type VerifyPhase = z.infer<typeof verifyPhaseSchema>;
export type VerificationPolicy = z.infer<typeof verificationPolicySchema>;
export type InstallStamp = z.infer<typeof installStampSchema>;
export type WorkspaceDeclaration = z.infer<typeof workspaceDeclarationSchema>;
export type StartState = z.infer<typeof startStateSchema>;
export type StartStateHeader = z.infer<typeof startStateHeaderSchema>;
export type AgentCursor = z.infer<typeof agentCursorSchema>;
export type AcceptedSubmission = z.infer<typeof acceptedSubmissionSchema>;
export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;
export type BallotBatch = z.infer<typeof ballotBatchSchema>;
export type DerivedInputKind = z.infer<typeof derivedInputKindSchema>;
export type DerivedInputCitation = z.infer<typeof derivedInputCitationSchema>;
export type PlanSelectionDerived = z.infer<typeof planSelectionDerivedSchema>;
export type ImplementationSelectionDerived = z.infer<typeof implementationSelectionDerivedSchema>;
export type ConsensusDerived = z.infer<typeof consensusDerivedSchema>;
export type DerivedState = z.infer<typeof derivedStateSchema>;
// Preserve source compatibility for clients constructing pre-amendment state;
// durable reads still validate and fill the new defaults with the schema.
type AmendmentStateKeys = "amendmentSequence" | "pendingAmendment" | "amendments" | "amendmentRetirements" | "ownerGuidance";
export type CursorsState = Omit<z.infer<typeof cursorsStateSchema>, AmendmentStateKeys> &
  Partial<Pick<z.infer<typeof cursorsStateSchema>, AmendmentStateKeys>>;
export type JournalEvent = z.infer<typeof journalEventSchema>;

export const enqueueOwnerGuidance = (
  cursors: CursorsState, entry: z.infer<typeof guidanceEntrySchema>
): CursorsState => {
  if (cursors.completed || cursors.abandoned) throw new Error("Cannot steer a completed or abandoned issue.");
  const guidance = cursors.ownerGuidance ?? emptyOwnerGuidance();
  const parsed = guidanceEntrySchema.parse(entry);
  if (guidance.pending.some((value) => value.id === parsed.id)) return cursors;
  if (guidance.pending.length >= 32) throw new Error("Owner guidance queue is full (32 entries).");
  return { ...cursors, ownerGuidance: { ...guidance, pending: [...guidance.pending, parsed] }, updatedAt: parsed.enqueuedAt };
};

/** Retire a cohort identity without consuming advice before an actual order exists. */
export const resetOwnerGuidance = (cursors: CursorsState): CursorsState => {
  const guidance = cursors.ownerGuidance ?? emptyOwnerGuidance();
  return { ...cursors, ownerGuidance: { ...guidance, generation: guidance.generation + 1 } };
};

export const bindOwnerGuidance = (
  cursors: CursorsState, stepId: WorkflowStepId, round: number | null, now: string
): CursorsState => {
  const guidance = cursors.ownerGuidance ?? emptyOwnerGuidance();
  const matches = (bound: z.infer<typeof boundGuidanceSchema> | null): boolean =>
    bound !== null && bound.stepId === stepId && bound.round === round;
  if (matches(guidance.bound) && guidance.bound!.generation === guidance.generation) return cursors;
  // Upgrading an issue with an existing in-flight cohort must not inject queued
  // text into just the remaining recipients. Its first snapshot is empty.
  const inFlight = guidance.bound === null && guidance.generation === 0 && (
    Object.values(cursors.agents).some((cursor) => cursor.stepId === stepId && cursor.actionId !== null) ||
    cursors.accepted.some((value) => value.stepId === stepId && value.round === round) ||
    cursors.acceptedResponses.some((value) => value.stepId === stepId && value.round === round)
  );
  const restored = matches(guidance.suspended) ? guidance.suspended!.entries : [];
  return { ...cursors, ownerGuidance: {
    ...guidance,
    pending: inFlight ? guidance.pending : [],
    bound: { stepId, round, generation: guidance.generation, boundAt: now,
      entries: inFlight ? [] : [...restored, ...guidance.pending] },
    suspended: stepId === "R4.amend-ballot" ? guidance.suspended : null
  }, updatedAt: now };
};

export const ownerGuidanceFor = (cursors: CursorsState, stepId: WorkflowStepId, round: number | null): string[] => {
  const guidance = cursors.ownerGuidance;
  const bound = guidance?.bound;
  return bound != null && bound.stepId === stepId && bound.round === round && bound.generation === guidance?.generation
    ? bound.entries.map((entry) => entry.text) : [];
};

export const suspendOwnerGuidance = (cursors: CursorsState): CursorsState => {
  const next = resetOwnerGuidance(cursors);
  return { ...next, ownerGuidance: { ...next.ownerGuidance!, suspended: cursors.ownerGuidance?.bound ?? null } };
};

/**
 * A Zod `.default()` is only optional on the *input* side; `z.infer` reports the
 * parsed output, where the field is present. Omitting `contextPaths` here and
 * re-adding it as optional keeps every existing typed initializer compiling —
 * a defaulted field must not become a required constructor argument.
 */
export type StartStateInput = Omit<
  StartState,
  "formatVersion" | "createdAt" | "contextPaths" | "completesRoot" | "workflowCriticalPrefixes" | "workflowCriticalFiles"
> & {
  createdAt?: string;
  contextPaths?: readonly string[];
  workflowCriticalPrefixes?: readonly string[];
  workflowCriticalFiles?: readonly string[];
  /**
   * Omitted by callers: it is taken from the `IssueRuntimePaths` the state is
   * written with, so `start.json` cannot record a mailbox other than the one
   * the coordinator is actually using for this issue.
   */
  completesRoot?: string;
};

const assertRuntimeFormat = (path: string, value: unknown): void => {
  if (typeof value !== "object" || value === null || !("formatVersion" in value)) return;
  const formatVersion = (value as { formatVersion: unknown }).formatVersion;
  if (typeof formatVersion === "number" && LEGACY_RUNTIME_FORMAT_VERSIONS.has(formatVersion)) {
    throw new Error(`Invalid ${path}: ${RUNTIME_FORMAT_WIPE_MESSAGE}`);
  }
};

const readJsonFile = (path: string): unknown => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return value;
};

const parseUncheckedFile = <T>(path: string, schema: z.ZodType<T>): T => {
  const result = schema.safeParse(readJsonFile(path));
  if (!result.success) {
    throw new Error(`Invalid ${path}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

const parseFile = <T>(path: string, schema: z.ZodType<T>): T => {
  const value = readJsonFile(path);
  assertRuntimeFormat(path, value);
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ${path}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

export const atomicWriteJson = (root: string, path: string, value: unknown): void => {
  const safePath = containedPath(root, relative(root, path));
  mkdirSync(dirname(safePath), { recursive: true, mode: 0o700 });
  assertNoSymlink(root, dirname(safePath));
  const temporary = containedPath(dirname(safePath), `.${randomUUID()}.tmp`);
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, safePath);
  const directory = openSync(dirname(safePath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
};

export const readConfig = (path: string): CoordinatorConfig => parseFile(path, coordinatorConfigSchema);
export const readStartState = (paths: IssueRuntimePaths): StartState => parseFile(paths.start, startStateSchema);
export const readStartStateHeader = (paths: IssueRuntimePaths): StartStateHeader =>
  parseUncheckedFile(paths.start, startStateHeaderSchema);
export const readCursorsState = (paths: IssueRuntimePaths): CursorsState => parseFile(paths.cursors, cursorsStateSchema);

export const initialCursors = (start: StartState, now = new Date().toISOString()): CursorsState => {
  const agents: Record<string, AgentCursor> = {};
  for (const agent of start.originalRoster) {
    agents[agent] = {
      lastAcceptedActionId: null,
      stepId: null,
      evidenceId: null,
      actionId: null,
      actionDigest: null,
      submissionMode: null,
      status: "idle",
      attempt: 0,
      submissionSha: null,
      outstanding: [],
      updatedAt: now
    };
  }
  return cursorsStateSchema.parse({
    formatVersion: RUNTIME_FORMAT_VERSION,
    stateRevision: 0,
    issueCursor: { stepId: "R1.join", gateId: "gate-1-join", round: null },
    activeRoster: start.originalRoster,
    droppedAgents: [],
    derived: { planSelection: null, implementationSelection: null, consensus: null },
    ownerQuestion: null,
    lastOwnerAnswer: null,
    publication: {
      status: "not-required",
      finalSha: null,
      branch: null,
      url: null,
      error: null,
      attempts: 0
    },
    evidence: { branch: null, tip: null },
    paused: false,
    abandoned: false,
    completed: false,
    agents,
    accepted: [],
    acceptedResponses: [],
    ballotBatches: [],
    updatedAt: now
  });
};

export const initializeOperationalState = (
  paths: IssueRuntimePaths,
  input: StartStateInput,
  now = new Date().toISOString()
): { start: StartState; cursors: CursorsState } => {
  if (existsSync(paths.start) || existsSync(paths.cursors) || existsSync(paths.journal)) {
    throw new Error(`Runtime state already exists for issue ${input.issue}. Use resume or abandon it explicitly.`);
  }
  const start = startStateSchema.parse({
    ...input,
    formatVersion: RUNTIME_FORMAT_VERSION,
    completesRoot: input.completesRoot ?? paths.completesRoot,
    createdAt: input.createdAt ?? now
  });
  const cursors = initialCursors(start, now);
  atomicWriteJson(paths.coordRoot, paths.start, start);
  atomicWriteJson(paths.coordRoot, paths.cursors, cursors);
  appendJournal(paths, { type: "started", details: { issue: start.issue, profile: start.profile } }, now);
  return { start, cursors };
};

export type JournalEventInput = Omit<JournalEvent, "formatVersion" | "sequence" | "at">;

export const readJournal = (paths: IssueRuntimePaths): JournalEvent[] => {
  if (!existsSync(paths.journal)) return [];
  const lines = readFileSync(paths.journal, "utf8").split("\n").filter((line) => line !== "");
  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Invalid journal line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    assertRuntimeFormat(`journal line ${index + 1}`, value);
    return journalEventSchema.parse(value);
  });
};

export type AnalyticsRuntimeState = {
  start: Pick<StartState, "issue" | "originalRoster" | "createdAt">;
  activeRoster: string[];
  journal: JournalEvent[];
  source: {
    formatVersion: number;
    legacy: boolean;
    skippedJournalRecords: number;
  };
};

export const readJournalForAnalytics = (
  paths: IssueRuntimePaths
): { events: JournalEvent[]; formatVersion: number; skipped: number } => {
  if (!existsSync(paths.journal)) {
    throw new Error(`No journal exists for issue ${paths.issue}.`);
  }
  const lines = readFileSync(paths.journal, "utf8").split("\n").filter((line) => line !== "");
  const events: JournalEvent[] = [];
  let formatVersion: number | null = null;
  let skipped = 0;
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Invalid journal line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof value !== "object" || value === null) {
      throw new Error(`Invalid journal line ${index + 1}: expected an object.`);
    }
    const raw = value as Record<string, unknown>;
    const rowFormat = raw.formatVersion;
    if (rowFormat !== RUNTIME_FORMAT_VERSION && !isLegacyRuntimeFormat(rowFormat)) {
      throw new Error(`Invalid journal line ${index + 1}: unsupported runtime format ${String(rowFormat)}.`);
    }
    if (formatVersion === null) formatVersion = rowFormat;
    else if (formatVersion !== rowFormat) {
      throw new Error(`Invalid journal line ${index + 1}: mixed runtime format versions.`);
    }
    if (!journalEventTypeSchema.safeParse(raw.type).success) {
      skipped += 1;
      continue;
    }
    const parsed = journalEventSchema.safeParse({ ...raw, formatVersion: RUNTIME_FORMAT_VERSION });
    if (!parsed.success) {
      throw new Error(`Invalid journal line ${index + 1}: ${z.prettifyError(parsed.error)}`);
    }
    events.push(parsed.data);
  }
  if (formatVersion === null) throw new Error(`No journal exists for issue ${paths.issue}.`);
  return { events, formatVersion, skipped };
};

/** Read legacy state for analytics without weakening any operational parser. */
export const readAnalyticsRuntime = (paths: IssueRuntimePaths): AnalyticsRuntimeState => {
  const header = readStartStateHeader(paths);
  if (!isLegacyRuntimeFormat(header.formatVersion)) {
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    return {
      start,
      activeRoster: cursors.activeRoster,
      journal: readJournal(paths),
      source: { formatVersion: RUNTIME_FORMAT_VERSION, legacy: false, skippedJournalRecords: 0 }
    };
  }

  const cursors = parseUncheckedFile(paths.cursors, analyticsCursorsHeaderSchema);
  if (cursors.formatVersion !== header.formatVersion) {
    throw new Error("Legacy start.json and cursors.json use different runtime formats.");
  }
  if (!cursors.completed) {
    throw new Error(`Legacy runtime for issue ${header.issue} is not completed; analytics will not make it resumable.`);
  }
  const journal = readJournalForAnalytics(paths);
  if (journal.formatVersion !== header.formatVersion) {
    throw new Error("Legacy start.json and journal.jsonl use different runtime formats.");
  }
  return {
    start: header,
    activeRoster: cursors.activeRoster,
    journal: journal.events,
    source: {
      formatVersion: header.formatVersion,
      legacy: true,
      skippedJournalRecords: journal.skipped
    }
  };
};

/** Read only the final journal record; append cost must not grow with issue age. */
const nextJournalSequence = (path: string): number => {
  if (!existsSync(path)) return 0;
  const handle = openSync(path, "r");
  try {
    let position = fstatSync(handle).size;
    if (position === 0) return 0;
    let suffix = Buffer.alloc(0);
    while (position > 0) {
      const start = Math.max(0, position - 4096);
      const chunk = Buffer.alloc(position - start);
      readSync(handle, chunk, 0, chunk.length, start);
      suffix = Buffer.concat([chunk, suffix]);
      position = start;
      const text = suffix.toString("utf8").replace(/\n+$/, "");
      const boundary = text.lastIndexOf("\n");
      if (boundary < 0 && position > 0) continue;
      const line = text.slice(boundary + 1);
      if (line === "") return 0;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`Invalid final journal line: ${error instanceof Error ? error.message : String(error)}`);
      }
      return journalEventSchema.parse(parsed).sequence + 1;
    }
    return 0;
  } finally {
    closeSync(handle);
  }
};

export const appendJournal = (
  paths: IssueRuntimePaths,
  input: JournalEventInput,
  now = new Date().toISOString()
): JournalEvent => {
  mkdirSync(dirname(paths.journal), { recursive: true, mode: 0o700 });
  const lockPath = `${paths.journal}.lock`;
  const lock = acquireExclusiveLock(lockPath);
  try {
    // A derived decision is content-addressed.  The journal is written before
    // cursor replacement, so a process can die after the durable append but
    // before the state file is renamed.  Reusing the event by identity makes
    // that retry exact-once and also preserves its original decidedAt value.
    const identity = input.type === "decision-derived" ? "decisionId" : "eventId";
    if (typeof input.details[identity] === "string") {
      const existing = readJournal(paths).find(
        (event) =>
          event.type === input.type &&
          event.details[identity] === input.details[identity]
      );
      if (existing !== undefined) return existing;
    }
    const event = journalEventSchema.parse({
      ...input,
      formatVersion: RUNTIME_FORMAT_VERSION,
      sequence: nextJournalSequence(paths.journal),
      at: now
    });
    assertNoSymlink(paths.coordRoot, dirname(paths.journal));
    const handle = openSync(paths.journal, "a", 0o600);
    try {
      writeFileSync(handle, `${JSON.stringify(event)}\n`, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    return event;
  } finally {
    closeSync(lock);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
};

export const writeCursorsState = (paths: IssueRuntimePaths, cursors: CursorsState): void => {
  atomicWriteJson(paths.coordRoot, paths.cursors, cursorsStateSchema.parse(cursors));
};

export class StateConflictError extends Error {
  override readonly name = "StateConflictError";
}

const cursorLockPath = (paths: IssueRuntimePaths): string => `${paths.cursors}.lock`;

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

export const acquireExclusiveLock = (lockPath: string): number => {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      const handle = openSync(lockPath, "wx", 0o600);
      writeFileSync(handle, `${process.pid}\n`, "utf8");
      fsyncSync(handle);
      return handle;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      try {
        const owner = Number(readFileSync(lockPath, "utf8").trim());
        if (Number.isInteger(owner) && owner > 0 && !processIsAlive(owner)) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // The owner may be between exclusive creation and writing its pid.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw new Error(`Timed out waiting for coordinator state lock ${lockPath}.`);
};

/**
 * Apply one short local state transition under an exclusive lock. Slow Git,
 * tmux, check, and publication effects must happen outside this callback and
 * use expectedRevision when committing their result.
 */
export const mutateCursorsState = (
  paths: IssueRuntimePaths,
  mutation: (current: CursorsState) => CursorsState,
  expectedRevision?: number
): { applied: boolean; state: CursorsState } => {
  const handle = acquireExclusiveLock(cursorLockPath(paths));
  try {
    const current = readCursorsState(paths);
    if (expectedRevision !== undefined && current.stateRevision !== expectedRevision) {
      return { applied: false, state: current };
    }
    const candidate = mutation(current);
    const state = cursorsStateSchema.parse({
      ...candidate,
      stateRevision: current.stateRevision + 1
    });
    writeCursorsState(paths, state);
    return { applied: true, state };
  } finally {
    closeSync(handle);
    if (existsSync(cursorLockPath(paths))) unlinkSync(cursorLockPath(paths));
  }
};

export const requireStateMutation = (
  paths: IssueRuntimePaths,
  expectedRevision: number,
  mutation: (current: CursorsState) => CursorsState
): CursorsState => {
  // This compare-and-swap is the authority boundary for effects: without it,
  // a delayed Git/tmux/check result could overwrite a concurrent owner control.
  const result = mutateCursorsState(paths, mutation, expectedRevision);
  if (!result.applied) throw new StateConflictError("Coordinator state changed during an effect; re-observation is required.");
  return result.state;
};

export const replaceCursor = (
  cursors: CursorsState,
  agent: string,
  patch: Partial<AgentCursor>,
  now = new Date().toISOString()
): CursorsState => {
  const current = cursors.agents[agent];
  if (current === undefined) throw new Error(`Unknown agent ${agent}.`);
  return cursorsStateSchema.parse({
    ...cursors,
    agents: { ...cursors.agents, [agent]: { ...current, ...patch, updatedAt: now } },
    updatedAt: now
  });
};

export const setPaused = (cursors: CursorsState, paused: boolean, now = new Date().toISOString()): CursorsState =>
  cursorsStateSchema.parse({ ...cursors, manualPaused: paused, paused: paused || cursors.holds.length > 0, updatedAt: now });

/** Scoped owner recovery never releases another hold or a manual pause. */
export const releaseHold = (cursors: CursorsState, id: string, resetBudget: boolean, now: string): CursorsState => {
  const hold = cursors.holds.find((entry) => entry.id === id);
  if (hold === undefined) throw new Error(`Unknown hold ${id}.`);
  if (cursors.abandoned || cursors.completed || cursors.agents[hold.agent]?.actionId !== hold.actionId) {
    throw new Error("Cannot release a hold for retired work.");
  }
  if (hold.reason === "nudge-loop" && !resetBudget) throw new Error("Nudge-loop release requires --reset-nudge-budget.");
  if (resetBudget && hold.reason !== "nudge-loop") throw new Error("Only a nudge-loop hold permits --reset-nudge-budget.");
  const safety = cursors.actionSafety[hold.agent];
  if (safety === undefined || safety.actionId !== hold.actionId) throw new Error("Hold action safety is missing.");
  const holds = cursors.holds.filter((entry) => entry.id !== id);
  return cursorsStateSchema.parse({
    ...cursors, holds, paused: cursors.manualPaused || holds.length > 0, updatedAt: now,
    actionSafety: { ...cursors.actionSafety, [hold.agent]: {
      ...safety,
      ...(resetBudget ? { sends: 0, lastSendAt: null } : {}),
      reserved: false,
      // An acknowledgment is not immunity to a still-active local condition.
      // A fresh observation may create a distinct, crash-idempotent hold.
      holdGeneration: safety.holdGeneration + 1,
      observationChecks: 0, nextObservationAt: null, activityAt: now
    } }
  });
};

/**
 * Automatic release of one cleared resource hold (#140). Unlike the owner's
 * `releaseHold`, it leaves action safety verbatim — sends, last send, any
 * uncertain reservation, hold generation and the observation budget — and it
 * cannot touch manual pause or any other hold.
 */
export const releaseResourceHold = (cursors: CursorsState, id: string, now: string): CursorsState => {
  const hold = cursors.holds.find((entry) => entry.id === id);
  if (hold === undefined) throw new Error(`Unknown hold ${id}.`);
  if (cursors.abandoned || cursors.completed || cursors.agents[hold.agent]?.actionId !== hold.actionId) {
    throw new Error("Cannot release a hold for retired work.");
  }
  if (hold.reason !== "vendor-failure" || hold.evidence?.failureClass !== "usage-window") {
    throw new Error("Only a usage-window resource hold can be released automatically.");
  }
  const holds = cursors.holds.filter((entry) => entry.id !== id);
  return cursorsStateSchema.parse({ ...cursors, holds, paused: cursors.manualPaused || holds.length > 0, updatedAt: now });
};

/**
 * Every decision identity includes the ordered active roster, so any drop
 * invalidates all decisions that have already been derived.  The owner drop
 * path immediately recomputes the slots whose prerequisites are still
 * complete and journals their supersession; this lower-level helper fails
 * closed for callers that cannot do that recomputation themselves.
 */
export const invalidateDerivedForDrop = (derived: DerivedState, agent: string): DerivedState => {
  void derived;
  void agent;
  return { planSelection: null, implementationSelection: null, consensus: null };
};

export const dropAgent = (cursors: CursorsState, agent: string, now = new Date().toISOString()): CursorsState => {
  if (!cursors.activeRoster.includes(agent)) throw new Error(`${agent} is not active.`);
  if (cursors.activeRoster.length === 1) throw new Error("Cannot drop the final active agent.");
  const activeRoster = cursors.activeRoster.filter((candidate) => candidate !== agent);
  const current = cursors.agents[agent];
  if (current === undefined) throw new Error(`Unknown agent ${agent}.`);
  const pending = cursors.pendingAmendment ?? null;
  const agents = { ...cursors.agents };
  if (pending !== null) {
    for (const id of activeRoster) {
      const cursor = agents[id];
      if (cursor !== undefined) agents[id] = { ...cursor,
        stepId: pending.resume.stepId,
        evidenceId: pending.resume.stepId === "R4.implement" ? "implementation-pinned" : "revision-pinned",
        actionId: null, actionDigest: null, submissionMode: null, submissionSha: null,
        status: "idle", outstanding: [], updatedAt: now };
    }
  }
  return cursorsStateSchema.parse({
    ...cursors,
    ...(pending === null ? {} : {
      issueCursor: { stepId: pending.resume.stepId,
        gateId: pending.resume.stepId === "R4.implement" ? "gate-4-implementations" : "gate-6-consensus",
        round: pending.resume.round },
      pendingAmendment: null,
      amendments: [...(cursors.amendments ?? []), { ...pending, outcome: "cancelled", evidenceSha: null, ballots: [],
        rationale: `Roster changed: ${agent} was dropped; resubmit against the current selected plan if still needed.`, decidedAt: now }]
    }),
    activeRoster,
    droppedAgents: [...cursors.droppedAgents, agent],
    derived: invalidateDerivedForDrop(cursors.derived, agent),
    agents: {
      ...agents,
      [agent]: {
        ...current,
        status: "dropped",
        actionId: null,
        submissionMode: null,
        actionDigest: null,
        submissionSha: null,
        outstanding: [],
        updatedAt: now
      }
    },
    accepted: cursors.accepted.filter(
      (submission) => submission.agent !== agent || submission.stepId !== cursors.issueCursor.stepId
    ),
    acceptedResponses: cursors.acceptedResponses.filter(
      (response) => response.agent !== agent || response.stepId !== cursors.issueCursor.stepId
    ),
    ballotBatches: cursors.ballotBatches.map((batch) =>
      batch.status === "published" || batch.status === "invalidated"
        ? batch
        : {
            ...batch,
            status: "invalidated" as const,
            error: batch.error ?? `invalidated by drop of ${agent}`,
            updatedAt: now
          }
    ),
    updatedAt: now
  });
};

export type StateTypeExports = {
  profile: WorkflowProfile;
  prPolicy: PrPolicy;
  stepId: WorkflowStepId;
  gateId: GateId;
  evidenceId: EvidenceId;
};
