import {
  displayGitPaths,
  inspectCommitRange,
  isCurrentIssueCoordinationPath,
  type GitNameStatusChange
} from "./pinValidation.js";

export type FinalizationFailureReason =
  | "invalid-commit"
  | "missing-consensus"
  | "missing-final"
  | "history-rewrite"
  | "inspection-failed"
  | "non-cleanup-change";

export type FinalizationVerification =
  | {
      ok: true;
      issue: number;
      consensusSha: string;
      finalSha: string;
      deletedPaths: string[];
    }
  | {
      ok: false;
      issue: number;
      consensusSha: string;
      finalSha: string;
      reason: FinalizationFailureReason;
      details: string;
    };

export type VerifyFinalizationParams = {
  /** Any path inside the Git worktree/object database containing both commits. */
  root: string;
  issue: number;
  /** Authorized finalization base: a unanimous pin, or the capped third-revision pin. */
  consensusSha: string;
  /** Proposed merge-ready PR head. */
  finalSha: string;
};

const gitShaPattern = /^[a-f0-9]{40}$/;

const rejected = (
  params: VerifyFinalizationParams,
  reason: FinalizationFailureReason,
  details: string
): FinalizationVerification => ({
  ok: false,
  issue: params.issue,
  consensusSha: params.consensusSha,
  finalSha: params.finalSha,
  reason,
  details
});

const displayChange = (change: GitNameStatusChange): string =>
  `${change.status} ${displayGitPaths(change.paths)}`;

/**
 * Verify the only permitted post-consensus transition: deletion of the
 * current issue's coordination files. All additions, modifications,
 * copies, renames, cross-issue cleanup, and product/repository changes fail.
 */
export const verifyFinalization = (params: VerifyFinalizationParams): FinalizationVerification => {
  if (!Number.isInteger(params.issue) || params.issue < 1) {
    return rejected(params, "invalid-commit", "Issue must be a positive integer.");
  }

  if (!gitShaPattern.test(params.consensusSha) || !gitShaPattern.test(params.finalSha)) {
    return rejected(params, "invalid-commit", "Consensus and final commits must be 40-character lowercase Git SHAs.");
  }

  const inspected = inspectCommitRange(params.root, params.consensusSha, params.finalSha);

  if (!inspected.ok) {
    if (inspected.reason === "missing-base") {
      return rejected(
        params,
        "missing-consensus",
        `Consensus-approved commit ${params.consensusSha} is not available. Fetch the reviewed branch without rewriting it, then rerun finalization verification.${inspected.details === "" ? "" : ` Git: ${inspected.details}`}`
      );
    }

    if (inspected.reason === "missing-tip") {
      return rejected(
        params,
        "missing-final",
        `Proposed final commit ${params.finalSha} is not available. Fetch the proposed PR head, then rerun finalization verification.${inspected.details === "" ? "" : ` Git: ${inspected.details}`}`
      );
    }

    if (inspected.reason === "not-ancestor") {
      return rejected(
        params,
        "history-rewrite",
        `Final commit ${params.finalSha} is not a descendant of consensus-approved commit ${params.consensusSha}. Invariant: finalization may only append cleanup after the reviewed implementation; it may not replace or rewrite that history.`
      );
    }

    return rejected(
      params,
      "inspection-failed",
      `The consensus-to-final diff could not be inspected safely. Remediation: restore complete readable Git history and rerun verification.${inspected.details === "" ? "" : ` Git: ${inspected.details}`}`
    );
  }

  const disallowed = inspected.changes.filter(
    (change) =>
      change.status !== "D" ||
      change.paths.length !== 1 ||
      !isCurrentIssueCoordinationPath(change.paths[0] as Buffer, params.issue)
  );

  if (disallowed.length > 0) {
    return rejected(
      params,
      "non-cleanup-change",
      `Finalization contains changes outside deletion-only cleanup for issue ${params.issue}: ${disallowed
        .map(displayChange)
        .join("; ")}. Invariant: only deletions under .plans/issue-${params.issue}/**, .signals/issue-${params.issue}/**, and .code-reviews/issue-${params.issue}/** may follow consensus. Remove every addition, modification, rename/copy, implementation, dependency, test, automation, script, hook, documentation, root, or other-issue change before opening the merge-ready PR.`
    );
  }

  return {
    ok: true,
    issue: params.issue,
    consensusSha: params.consensusSha,
    finalSha: params.finalSha,
    deletedPaths: inspected.changes.map((change) => (change.paths[0] as Buffer).toString("utf8")).sort()
  };
};
