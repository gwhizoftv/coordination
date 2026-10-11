import { z } from "zod";

export const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/, "expected a lowercase 40-character Git SHA");
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase SHA-256 digest");
/** Git commit SHA (40) or private-response digest (64). */
export const citationDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/, "expected a 40-character Git SHA or 64-character SHA-256 digest");
export const agentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const issueSchema = z.number().int().positive();
export const issueSessionIdSchema = z.string().min(1).max(256);
export const actionIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "expected an opaque UUID action id"
  );
export const repositoryPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), "expected a safe repository-relative path");

export const artifactCitationSchema = z
  .object({
    agent: agentIdSchema,
    commitSha: gitShaSchema,
    path: repositoryPathSchema
  })
  .strict();

/** Non-whitespace rationale length in UTF-16 code units (JS string length after stripping whitespace). */
export const rationaleNonWhitespaceUtf16Length = (rationale: string): number =>
  rationale.replace(/\s/gu, "").length;

export const RATIONALE_MAX_NON_WHITESPACE_UTF16 = 1000;

const rationaleSchema = z
  .string()
  .min(1)
  .refine(
    (value) => rationaleNonWhitespaceUtf16Length(value) <= RATIONALE_MAX_NON_WHITESPACE_UTF16,
    `rationale non-whitespace content must be at most ${RATIONALE_MAX_NON_WHITESPACE_UTF16} UTF-16 code units`
  );

const commonArtifactFields = {
  protocolVersion: z.literal(1),
  issue: issueSchema,
  issueSessionId: issueSessionIdSchema,
  agent: agentIdSchema
} as const;

const commonPublishedBallotFields = {
  protocolVersion: z.literal(2),
  issue: issueSchema,
  issueSessionId: issueSessionIdSchema,
  agent: agentIdSchema,
  inputSetHash: digestSchema,
  actionId: actionIdSchema,
  responseSha256: digestSchema,
  rationale: rationaleSchema
} as const;

export const participationReadyArtifactSchema = z
  .object({
    ...commonArtifactFields,
    artifact: z.literal("participation-ready"),
    baselineSha: gitShaSchema,
    automationDigest: digestSchema
  })
  .strict();

/** Private agent response for plan and comparison ballots. */
export const planComparisonBallotResponseSchema = z
  .object({
    actionId: actionIdSchema,
    choice: agentIdSchema,
    rationale: rationaleSchema
  })
  .strict();

/** Private agent response for consensus ballots. */
export const consensusBallotResponseSchema = z
  .object({
    actionId: actionIdSchema,
    disposition: z.enum(["approve", "revise", "escalate"]),
    rationale: rationaleSchema
  })
  .strict();

const amendmentReasonSchema = rationaleSchema.refine((value) => value.trim().length > 0, "reason must not be blank");
export const amendmentPathSchema = repositoryPathSchema.refine((path) => {
  const segments = path.split("/");
  return segments.every((segment) => /^[A-Za-z0-9_.@+-]+$/.test(segment) && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git") &&
    ![".plans", ".signals", ".code-reviews"].includes(segments[0] ?? "");
}, "expected an exact product file path, not a directory, pattern, or coordination path");

export const planAmendmentRequestSchema = z.object({
  ...commonArtifactFields,
  artifact: z.literal("plan-amendment-request"),
  actionId: actionIdSchema,
  inputSetHash: digestSchema,
  scopeHash: digestSchema,
  explanation: amendmentReasonSchema,
  additionalPaths: z.array(z.object({ path: amendmentPathSchema, reason: amendmentReasonSchema }).strict()).min(1).max(100)
}).strict().refine((value) => new Set(value.additionalPaths.map((entry) => entry.path)).size === value.additionalPaths.length,
  "additional paths must be unique");

export const amendmentBallotResponseSchema = z.object({
  actionId: actionIdSchema,
  disposition: z.enum(["approve", "revise"]),
  rationale: amendmentReasonSchema
}).strict();

export const amendmentBallotArtifactSchema = z.object({
  ...commonPublishedBallotFields,
  artifact: z.literal("amendment-ballot"),
  sequence: z.number().int().positive(),
  request: artifactCitationSchema,
  plans: z.array(artifactCitationSchema).min(1),
  priorApprovals: z.array(artifactCitationSchema),
  disposition: z.enum(["approve", "revise"])
}).strict();

export type PlanAmendmentRequest = z.infer<typeof planAmendmentRequestSchema>;
export type AmendmentBallotArtifact = z.infer<typeof amendmentBallotArtifactSchema>;

/** Coordinator-published canonical plan ballot (protocol version 2). */
export const planBallotArtifactSchema = z
  .object({
    ...commonPublishedBallotFields,
    artifact: z.literal("plan-ballot"),
    plans: z.array(artifactCitationSchema).min(1),
    reviews: z.array(artifactCitationSchema),
    choice: agentIdSchema
  })
  .strict();

export const implementationReadyArtifactSchema = z
  .object({
    ...commonArtifactFields,
    artifact: z.literal("implementation-ready"),
    inputSetHash: digestSchema,
    implementationCommitSha: gitShaSchema,
    scopeHash: digestSchema.optional(),
    approvedPaths: z.array(repositoryPathSchema).min(1)
  })
  .strict();

/** Coordinator-published canonical comparison ballot (protocol version 2). */
export const comparisonBallotArtifactSchema = z
  .object({
    ...commonPublishedBallotFields,
    artifact: z.literal("comparison-ballot"),
    implementations: z.array(artifactCitationSchema).min(1),
    choice: agentIdSchema
  })
  .strict();

export const revisionReadyArtifactSchema = z
  .object({
    ...commonArtifactFields,
    artifact: z.literal("revision-ready"),
    inputSetHash: digestSchema,
    round: z.number().int().min(1),
    revisedBranchHead: gitShaSchema,
    scopeHash: digestSchema.optional(),
    basedOn: z.array(gitShaSchema).min(1)
  })
  .strict();

/** Coordinator-published canonical consensus ballot (protocol version 2). */
export const consensusBallotArtifactSchema = z
  .object({
    ...commonPublishedBallotFields,
    artifact: z.literal("consensus-ballot"),
    round: z.number().int().min(1),
    revisionCommitSha: gitShaSchema,
    disposition: z.enum(["approve", "revise", "escalate"])
  })
  .strict();

export const followUpReadyArtifactSchema = z
  .object({
    ...commonArtifactFields,
    artifact: z.literal("follow-up-ready"),
    actionId: actionIdSchema,
    inputSetHash: digestSchema,
    round: z.literal(3),
    revisionCommitSha: gitShaSchema,
    followUpIssueUrl: z.string().url()
  })
  .strict();

export const finalizationArtifactSchema = z
  .object({
    ...commonArtifactFields,
    artifact: z.literal("finalization"),
    consensusSha: gitShaSchema,
    finalSha: gitShaSchema,
    checks: z.array(
      z
        .object({
          argv: z.array(z.string().min(1)).min(1),
          exitCode: z.number().int()
        })
        .strict()
    )
  })
  .strict();

export const publishedArtifactSchema = z.discriminatedUnion("artifact", [
  participationReadyArtifactSchema,
  planBallotArtifactSchema,
  implementationReadyArtifactSchema,
  comparisonBallotArtifactSchema,
  revisionReadyArtifactSchema,
  consensusBallotArtifactSchema,
  followUpReadyArtifactSchema,
  finalizationArtifactSchema,
  planAmendmentRequestSchema,
  amendmentBallotArtifactSchema
]);

export type ParticipationReadyArtifact = z.infer<typeof participationReadyArtifactSchema>;
export type PlanComparisonBallotResponse = z.infer<typeof planComparisonBallotResponseSchema>;
export type ConsensusBallotResponse = z.infer<typeof consensusBallotResponseSchema>;
export type PlanBallotArtifact = z.infer<typeof planBallotArtifactSchema>;
export type ImplementationReadyArtifact = z.infer<typeof implementationReadyArtifactSchema>;
export type ComparisonBallotArtifact = z.infer<typeof comparisonBallotArtifactSchema>;
export type RevisionReadyArtifact = z.infer<typeof revisionReadyArtifactSchema>;
export type ConsensusBallotArtifact = z.infer<typeof consensusBallotArtifactSchema>;
export type FinalizationArtifact = z.infer<typeof finalizationArtifactSchema>;
export type PublishedArtifact = z.infer<typeof publishedArtifactSchema>;

export type JsonResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const parseJsonWithSchema = <T>(raw: string, schema: z.ZodType<T>): JsonResult<T> => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }
  return { ok: true, value: parsed.data };
};

export const validateCommonArtifactFields = (
  artifact: { issue: number; issueSessionId: string; agent: string },
  expected: { issue: number; issueSessionId: string; agent: string }
): string[] => {
  const outstanding: string[] = [];
  if (artifact.issue !== expected.issue) outstanding.push(`artifact issue must be ${expected.issue}`);
  if (artifact.issueSessionId !== expected.issueSessionId) outstanding.push("artifact issueSessionId is stale or incorrect");
  if (artifact.agent !== expected.agent) outstanding.push(`artifact agent must be ${expected.agent}`);
  return outstanding;
};
