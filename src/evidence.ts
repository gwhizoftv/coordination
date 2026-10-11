import { agentFacingSubject } from "./agentLanguage.js";
import { sha256 } from "./hash.js";
import type { FetchResult } from "./mirror.js";
import {
  finalizationArtifactSchema,
  followUpReadyArtifactSchema,
  implementationReadyArtifactSchema,
  participationReadyArtifactSchema,
  planAmendmentRequestSchema,
  parseJsonWithSchema,
  revisionReadyArtifactSchema,
  validateCommonArtifactFields
} from "./protocol.js";
import type { BoundInput, EvidenceObservation, InternalOrder } from "./steps.js";
import type { PinValidationResult } from "./pinValidation.js";

export type EvidenceMirror = {
  fetchBranch(branch: string): Promise<FetchResult>;
  isReachable(sha: string, ref: string): Promise<boolean>;
  isAncestor(base: string, tip: string): Promise<boolean>;
  readBlob(sha: string, path: string): Promise<string | null>;
  changedPaths(base: string, tip: string): Promise<string[]>;
  validatePhasePin(params: {
    pin: string;
    tip: string;
    issue: number;
    subject: string;
    ref: string;
  }): Promise<PinValidationResult>;
};

const canonicalInputs = (inputs: readonly BoundInput[]): string =>
  [...inputs]
    .sort((left, right) =>
      `${left.kind}\0${left.agent}\0${left.commitSha}\0${left.path}`.localeCompare(
        `${right.kind}\0${right.agent}\0${right.commitSha}\0${right.path}`
      )
    )
    .map((input) => `${input.kind}\0${input.agent}\0${input.commitSha}\0${input.path}`)
    .join("\n");

export const computeInputSetHash = (inputs: readonly BoundInput[]): string => sha256(canonicalInputs(inputs));

const markdownSection = (raw: string, alternatives: readonly string[]): boolean =>
  alternatives.some((heading) => new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "im").test(raw));

const REUSE_SECTION_HEADINGS = ["Reuse and Scope", "Reuse", "Scope and Reuse"] as const;

const checkPlan = (raw: string): string[] => {
  // Legacy "Exact File Map" (and aliases) still satisfy both of the split list headings.
  const fileListAliases = [
    "(?:Exact )?File (?:Map|Creation Order)",
    "Proposed Architecture"
  ] as const;
  const required: readonly (readonly string[])[] = [
    ["Exact File List to be changed or deleted", ...fileListAliases],
    ["Exact file list to be created", ...fileListAliases],
    [...REUSE_SECTION_HEADINGS],
    ["Tests?", "Validation"],
    ["Alternatives?(?: Rejected)?"],
    ["Risks?(?: and Mitigations)?"],
    ["Conclusion"]
  ];
  return required
    .filter((headings) => !markdownSection(raw, headings))
    .map((headings) => `plan is missing a non-empty ${headings[0]} section`);
};

/** One path segment: letters, digits, and the punctuation git trees actually use. */
const FILE_MAP_SEGMENT = /^[A-Za-z0-9_.@+-]+$/;

/**
 * True when a backticked plan token is a repository-relative file-map path.
 *
 * Nested paths (`packages/…`, `apps/…`, `src/…`) and directory globs (`dir/`,
 * `dir/**`) are accepted regardless of the first directory name. A single
 * segment is kept only when it looks like a root file (`package.json`), so
 * identifiers (`VIDEO_DOMAINS`, `toDomain`) are not treated as paths.
 */
export const isFileMapPath = (candidate: string): boolean => {
  if (
    candidate.includes(" ") ||
    candidate.startsWith("/") ||
    candidate.split("/").includes("..") ||
    candidate.startsWith(".plans/") ||
    candidate.startsWith(".signals/") ||
    candidate.startsWith(".code-reviews/")
  ) {
    return false;
  }
  const glob = candidate.endsWith("/**");
  const directory = !glob && candidate.endsWith("/");
  const body = glob ? candidate.slice(0, -3) : directory ? candidate.slice(0, -1) : candidate;
  if (body === "" || body.startsWith("/") || body.endsWith("/") || body.includes("//")) return false;
  const segments = body.split("/");
  if (!segments.every((segment) => FILE_MAP_SEGMENT.test(segment))) return false;
  if (segments.length >= 2 || glob || directory) return true;
  return body.includes(".");
};

/**
 * Expand one bash-style brace group (`dir/{a,b}.sh` → `dir/a.sh`, `dir/b.sh`).
 * Nested or malformed braces are left unchanged so `isFileMapPath` can reject them.
 */
export const expandFileMapBraces = (candidate: string): string[] => {
  const matched = /^([^{}\n]*)\{([^{}\n]+)\}([^{}\n]*)$/.exec(candidate);
  if (matched === null) return [candidate];
  const prefix = matched[1] ?? "";
  const body = matched[2] ?? "";
  const suffix = matched[3] ?? "";
  const alternatives = body.split(",");
  if (alternatives.length < 2 || alternatives.some((part) => part === "")) return [candidate];
  return alternatives.map((part) => `${prefix}${part}${suffix}`);
};

/**
 * Remove named Markdown sections while retaining every other line. A section
 * ends at the next sibling-or-parent ATX heading. A depth-1 section also ends
 * at the next heading because accepted plan sections may use depth 2 beneath it.
 */
const stripSections = (raw: string, headings: readonly string[]): string => {
  const targets = new Set(headings.map((heading) => heading.toLowerCase()));
  const kept: string[] = [];
  let skippedDepth: number | null = null;
  for (const line of raw.split("\n")) {
    const matched = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    const depth = matched?.[1]?.length;
    if (skippedDepth !== null) {
      if (depth === undefined || (skippedDepth > 1 && depth > skippedDepth)) continue;
      skippedDepth = null;
    }
    const title = matched?.[2]?.trim().toLowerCase();
    if (depth !== undefined && title !== undefined && targets.has(title)) {
      skippedDepth = depth;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
};

export const extractApprovedPaths = (raw: string): string[] => {
  const paths = new Set<string>();
  for (const match of stripSections(raw, REUSE_SECTION_HEADINGS).matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    for (const expanded of expandFileMapBraces(candidate)) {
      if (isFileMapPath(expanded)) paths.add(expanded);
    }
  }
  return [...paths].sort();
};

const checkReview = (raw: string): string[] => {
  const missing: string[] = [];
  if (!markdownSection(raw, ["Findings", "Review Findings"])) missing.push("review is missing a Findings section");
  if (!markdownSection(raw, ["Verdict", "Conclusion"])) missing.push("review is missing a Verdict section");
  return missing;
};

const approvedTreeRoot = (pattern: string): string => {
  if (pattern.endsWith("/**")) return pattern.slice(0, -3).replace(/\/+$/, "");
  if (pattern.endsWith("/")) return pattern.slice(0, -1);
  return pattern;
};

/** Git records a directory delete as a change to every file under it. A map entry names that tree. */
const matchesApprovedPath = (path: string, approved: readonly string[], exact: readonly string[] = []): boolean =>
  approved.some((pattern) => {
    if (exact.includes(pattern)) return path === pattern;
    const root = approvedTreeRoot(pattern);
    return root.length > 0 && (path === root || path.startsWith(`${root}/`));
  });

const isCurrentIssueCoordinationPath = (path: string, issue: number): boolean =>
  [`.plans/issue-${issue}/`, `.signals/issue-${issue}/`, `.code-reviews/issue-${issue}/`].some((prefix) =>
    path.startsWith(prefix)
  );

const rejected = (order: InternalOrder, sha: string, outstanding: readonly string[]): EvidenceObservation => ({
  agent: order.agent,
  actionId: order.actionId,
  submissionSha: sha,
  status: "rejected",
  outstanding
});

const satisfied = (
  order: InternalOrder,
  sha: string,
  extra: Pick<
    EvidenceObservation,
    "productPin" | "disposition" | "approvedPaths" | "choice" | "checkResults" | "followUpUrl" | "followUpIssue"
  > = {}
): EvidenceObservation => ({
  agent: order.agent,
  actionId: order.actionId,
  submissionSha: sha,
  status: "satisfied",
  outstanding: [],
  ...extra
});

const commonErrors = (
  artifact: { issue: number; issueSessionId: string; agent: string },
  order: InternalOrder
): string[] => validateCommonArtifactFields(artifact, order);

const inputHashErrors = (actual: string, order: InternalOrder): string[] =>
  actual === computeInputSetHash(order.inputs) ? [] : ["artifact inputSetHash does not match the bound action inputs"];

const scopeErrors = (actual: string | undefined, order: InternalOrder): string[] =>
  (order.scopeRequired === true && actual === undefined) || (actual !== undefined && actual !== order.scopeHash)
    ? ["artifact scopeHash does not match the current approved file map; use the current action"] : [];

const pinErrors = async (
  pin: string,
  submissionSha: string,
  ref: string,
  order: InternalOrder,
  mirror: EvidenceMirror
): Promise<string[]> => {
  const outstanding: string[] = [];
  if (pin === submissionSha) outstanding.push("product pin must differ from the coordination signal commit");
  if (!(await mirror.isReachable(pin, ref))) outstanding.push(`pinned commit ${pin} is not reachable from ${order.branch}`);
  if (!(await mirror.isAncestor(order.baselineSha, pin))) outstanding.push("pinned commit does not descend from the issue baseline");
  if (!(await mirror.isAncestor(pin, submissionSha))) outstanding.push("coordination signal commit does not descend from its product pin");
  const phase = await mirror.validatePhasePin({
    pin,
    tip: submissionSha,
    issue: order.issue,
    subject: agentFacingSubject(order.evidenceId),
    ref: order.branch
  });
  if (!phase.ok) outstanding.push(phase.details);
  return outstanding;
};

export const evaluateEvidence = async (
  order: InternalOrder,
  submissionSha: string,
  mirror: EvidenceMirror,
  assertAuthority: () => void = () => undefined
): Promise<EvidenceObservation> => {
  if (order.submissionMode === "response") {
    return rejected(order, submissionSha, ["ballot steps cannot be satisfied through a repository artifact"]);
  }
  const requiredPath = order.requiredPath;
  const fetched = await mirror.fetchBranch(order.branch);
  assertAuthority();
  if (!fetched.ok) {
    if (!fetched.transient) {
      return rejected(order, submissionSha, [`expected origin branch ${order.branch} could not be fetched: ${fetched.error}`]);
    }
    return {
      agent: order.agent,
      actionId: order.actionId,
      submissionSha,
      status: "retry",
      outstanding: [`origin fetch failed${fetched.error === "" ? "" : `: ${fetched.error}`}`]
    };
  }
  const reachable = await mirror.isReachable(submissionSha, fetched.ref);
  assertAuthority();
  if (!reachable) {
    return rejected(order, submissionSha, [`submission ${submissionSha} is not reachable from origin/${order.branch}`]);
  }
  const blob = await mirror.readBlob(submissionSha, requiredPath);
  assertAuthority();
  if (blob === null) return rejected(order, submissionSha, [`required artifact ${requiredPath} is missing`]);

  if (order.stepId === "R4.implement" || order.stepId === "R6.revise") {
    let isRequest = false;
    try { isRequest = (JSON.parse(blob) as { artifact?: unknown })?.artifact === "plan-amendment-request"; } catch { /* ready-signal parsing reports malformed JSON */ }
    if (isRequest) {
      const parsed = parseJsonWithSchema(blob, planAmendmentRequestSchema);
      if (!parsed.ok) return rejected(order, submissionSha, [`invalid amendment request: ${parsed.error}`]);
      const request = parsed.value;
      const errors = [...commonErrors(request, order), ...inputHashErrors(request.inputSetHash, order), ...scopeErrors(request.scopeHash, order)];
      if (request.actionId !== order.actionId) errors.push("amendment request actionId does not match the current action");
      if (order.approvedPaths.length === 0) errors.push("no selected plan file map is available");
      for (const entry of request.additionalPaths) {
        if (matchesApprovedPath(entry.path, order.approvedPaths, order.exactApprovedPaths)) errors.push(`path is already approved: ${entry.path}`);
      }
      return errors.length === 0 ? { ...satisfied(order, submissionSha), amendmentRequest: request } : rejected(order, submissionSha, errors);
    }
  }

  if (order.evidenceId === "plan-published") {
    const errors = checkPlan(blob);
    const approvedPaths = extractApprovedPaths(blob);
    if (approvedPaths.length === 0) errors.push("plan file map does not name any repository paths in backticks");
    return errors.length === 0
      ? { ...satisfied(order, submissionSha), approvedPaths }
      : rejected(order, submissionSha, errors);
  }
  if (order.evidenceId === "review-published") {
    const errors = checkReview(blob);
    for (const input of order.inputs) {
      if (!blob.includes(input.commitSha)) errors.push(`review does not cite bound ${input.kind} commit ${input.commitSha}`);
    }
    return errors.length === 0 ? satisfied(order, submissionSha) : rejected(order, submissionSha, errors);
  }
  if (order.evidenceId === "comparison-published") {
    const errors: string[] = [];
    if (!markdownSection(blob, ["Comparison", "Findings"])) {
      errors.push(
        "comparison is missing a Comparison or Findings section (use a heading line that is exactly `## Comparison` or `## Findings`, with no subtitle on that line)"
      );
    }
    for (const input of order.inputs) {
      if (!blob.includes(input.commitSha)) errors.push(`comparison does not cite implementation pin ${input.commitSha}`);
    }
    return errors.length === 0 ? satisfied(order, submissionSha) : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "join-published") {
    const parsed = parseJsonWithSchema(blob, participationReadyArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid participation-readiness artifact: ${parsed.error}`]);
    const errors = commonErrors(parsed.value, order);
    if (parsed.value.baselineSha !== order.baselineSha) errors.push("participation-readiness baselineSha does not match the issue baseline");
    if (parsed.value.automationDigest !== order.automationDigest) errors.push("participation-readiness automationDigest does not match");
    return errors.length === 0 ? satisfied(order, submissionSha) : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "implementation-pinned") {
    const parsed = parseJsonWithSchema(blob, implementationReadyArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid implementation-ready artifact: ${parsed.error}`]);
    const errors = [
      ...commonErrors(parsed.value, order),
      ...inputHashErrors(parsed.value.inputSetHash, order),
      ...scopeErrors(parsed.value.scopeHash, order),
      ...(await pinErrors(parsed.value.implementationCommitSha, submissionSha, fetched.ref, order, mirror))
    ];
    const approved = order.approvedPaths;
    if (approved.length === 0) errors.push("no selected plan file map is available");
    if (JSON.stringify([...parsed.value.approvedPaths].sort()) !== JSON.stringify([...approved].sort())) {
      errors.push("implementation approvedPaths do not match the selected plan file map");
    }
    if (errors.length === 0) {
      const changed = await mirror.changedPaths(order.baselineSha, parsed.value.implementationCommitSha);
      const disallowed = changed.filter(
        (path) => !isCurrentIssueCoordinationPath(path, order.issue) && !matchesApprovedPath(path, approved, order.exactApprovedPaths)
      );
      if (disallowed.length > 0) errors.push(`implementation changes paths outside the approved file map: ${disallowed.join(", ")}`);
    }
    return errors.length === 0
      ? satisfied(order, submissionSha, { productPin: parsed.value.implementationCommitSha })
      : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "revision-pinned") {
    const parsed = parseJsonWithSchema(blob, revisionReadyArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid revision-ready artifact: ${parsed.error}`]);
    const errors = [
      ...commonErrors(parsed.value, order),
      ...inputHashErrors(parsed.value.inputSetHash, order),
      ...scopeErrors(parsed.value.scopeHash, order),
      ...(await pinErrors(parsed.value.revisedBranchHead, submissionSha, fetched.ref, order, mirror))
    ];
    if (parsed.value.round !== order.round) errors.push(`revision round must be ${order.round ?? 1}`);
    if (order.approvedPaths.length === 0) errors.push("no selected plan file map is available");
    const expectedPins = order.inputs.map((input) => input.commitSha).sort();
    if (JSON.stringify([...parsed.value.basedOn].sort()) !== JSON.stringify(expectedPins)) errors.push("revision basedOn pins do not equal bound inputs");
    if (expectedPins.length !== 1) errors.push("revision must be based on exactly one authorized product pin");
    const inputPin = expectedPins[0];
    if (inputPin !== undefined && !(await mirror.isAncestor(inputPin, parsed.value.revisedBranchHead))) {
      errors.push("revised product pin does not descend from its exact authorized input pin");
    }
    if (inputPin !== undefined) {
      const changed = await mirror.changedPaths(inputPin, parsed.value.revisedBranchHead);
      const disallowed = changed.filter(
        (path) => !isCurrentIssueCoordinationPath(path, order.issue) && !matchesApprovedPath(path, order.approvedPaths, order.exactApprovedPaths)
      );
      if (disallowed.length > 0) errors.push(`revision changes paths outside the approved file map: ${disallowed.join(", ")}`);
    }
    return errors.length === 0
      ? satisfied(order, submissionSha, { productPin: parsed.value.revisedBranchHead })
      : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "follow-up-published") {
    const parsed = parseJsonWithSchema(blob, followUpReadyArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid follow-up-ready artifact: ${parsed.error}`]);
    const errors = [
      ...commonErrors(parsed.value, order),
      ...inputHashErrors(parsed.value.inputSetHash, order)
    ];
    if (parsed.value.actionId !== order.actionId) errors.push("follow-up artifact actionId does not match the current action");
    if (parsed.value.round !== 3 || order.round !== 3) errors.push("follow-up round must be 3");
    const revisionInput = order.inputs.find((input) => input.kind === "revision");
    if (revisionInput !== undefined && parsed.value.revisionCommitSha !== revisionInput.commitSha) {
      errors.push("follow-up revisionCommitSha does not match the bound revision pin");
    }
    return errors.length === 0
      ? satisfied(order, submissionSha, { followUpUrl: parsed.value.followUpIssueUrl })
      : rejected(order, submissionSha, errors);
  }

  const parsed = parseJsonWithSchema(blob, finalizationArtifactSchema);
  if (!parsed.ok) return rejected(order, submissionSha, [`invalid finalization artifact: ${parsed.error}`]);
  const errors = commonErrors(parsed.value, order);
  if (parsed.value.finalSha === submissionSha) errors.push("final cleanup pin must differ from the coordination signal commit");
  if (!(await mirror.isReachable(parsed.value.finalSha, fetched.ref))) errors.push("final cleanup pin is not reachable from the expected origin branch");
  if (!(await mirror.isAncestor(parsed.value.finalSha, submissionSha))) errors.push("finalization signal does not descend from its final cleanup pin");
  const phase = await mirror.validatePhasePin({
    pin: parsed.value.finalSha,
    tip: submissionSha,
    issue: order.issue,
    subject: "finalization artifact",
    ref: order.branch
  });
  if (!phase.ok) errors.push(phase.details);
  if (!order.inputs.some((input) => input.commitSha === parsed.value.consensusSha)) errors.push("finalization consensusSha is not the bound consensus pin");
  if (parsed.value.checks.some((check) => check.exitCode !== 0)) errors.push("finalization artifact contains a failed check");
  return errors.length === 0 ? satisfied(order, submissionSha, { productPin: parsed.value.finalSha }) : rejected(order, submissionSha, errors);
};

export const isSatisfied = evaluateEvidence;
