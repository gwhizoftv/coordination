import { readFileSync } from "node:fs";
import { z } from "zod";

export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type CommandRunner = (argv: readonly string[], cwd: string) => Promise<CommandResult>;

const issueResponseSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z
      .string()
      .nullable()
      .transform((body) => body ?? ""),
    url: z.string().url()
  })
  .strict();

const issueSnapshotSchema = z
  .object({
    repository: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    url: z.string().url()
  })
  .strict();

export type GitHubIssueSnapshot = {
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string;
};

/** Load the start-time `github-issue.json` snapshot written under the issue runtime. */
export const readGitHubIssueSnapshot = (path: string): GitHubIssueSnapshot => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot read GitHub issue snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const parsed = issueSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`GitHub issue snapshot ${path} is invalid.`);
  }
  return parsed.data;
};

/**
 * Title and body for the coordinator-opened finalization PR.
 * `Closes #N` must appear in the body so GitHub auto-closes the issue on merge.
 * Optional evidence fields name the coordinator-authored ballot publication
 * branch; they are not a cryptographic agent signature.
 */
/** One objection recorded when the final revision round concluded the issue. */
export type CloseoutObjection = {
  agent: string;
  disposition: "revise" | "escalate";
  /** The verified follow-up issue, or null when the objector was dropped before filing. */
  followUp: { number: number; url: string } | null;
};

export const formatFinalizationPullRequest = (input: {
  issue: number;
  title: string;
  finalSha: string;
  draft: boolean;
  evidenceBranch?: string | null;
  evidenceTip?: string | null;
  /** Present when the revision limit, not unanimous approval, concluded the issue. */
  closeout?: { round: number; objections: readonly CloseoutObjection[] };
}): { title: string; body: string } => {
  const issueTitle = input.title.trim() === "" ? "coordinated implementation" : input.title.trim();
  const lines = [
    `Closes #${input.issue}`,
    "",
    input.draft
      ? `Draft PR for issue ${input.issue}. Owner merges. Final pin: ${input.finalSha}.`
      : `PR for issue ${input.issue}. Coordinator merges. Final pin: ${input.finalSha}.`
  ];
  if (input.evidenceBranch !== undefined && input.evidenceBranch !== null && input.evidenceBranch !== "") {
    lines.push(
      "",
      `Ballot evidence branch: ${input.evidenceBranch}` +
        (input.evidenceTip !== undefined && input.evidenceTip !== null && input.evidenceTip !== ""
          ? ` (tip ${input.evidenceTip}).`
          : "."),
      "That branch is coordinator-authored publication of action-bound ballot responses, not a cryptographic agent signature."
    );
  }
  if (input.closeout !== undefined) {
    lines.push(
      "",
      `Concluded at the revision limit (round ${input.closeout.round}): this revision is finalized with objections ` +
        "on record, not with unanimous approval. Each objecting agent filed its remaining objections as a follow-up issue:",
      ...input.closeout.objections.map((objection) =>
        `- ${objection.agent} (${objection.disposition}): ` +
          (objection.followUp === null ? "dropped before filing a follow-up issue" : objection.followUp.url)
      )
    );
  }
  return {
    title: `Issue ${input.issue}: ${issueTitle}`,
    body: lines.join("\n")
  };
};

export const githubRepositoryFromOrigin = (origin: string): string | null => {
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(origin);
  if (https?.[1] !== undefined) return https[1].replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+\/[^/]+)$/.exec(origin);
  return ssh?.[1]?.replace(/\.git$/, "") ?? null;
};

export const renderGitHubIssueSnapshot = (snapshot: GitHubIssueSnapshot): string =>
  `${JSON.stringify(snapshot, null, 2)}\n`;

const remediation = (repository: string, issue: number): string =>
  `Create GitHub issue ${issue} in ${repository} first, or repair GitHub CLI access with \`gh auth status\`.`;

export const fetchGitHubIssue = async (input: {
  origin: string;
  issue: number;
  cwd: string;
  runner: CommandRunner;
}): Promise<GitHubIssueSnapshot> => {
  const repository = githubRepositoryFromOrigin(input.origin);
  if (repository === null) {
    throw new Error(
      `Cannot read GitHub issue ${input.issue}: origin ${input.origin} is not a supported github.com repository. ` +
        `Point the workspace at the GitHub repository that owns the issue, create issue ${input.issue} there first, ` +
        "and verify GitHub CLI access with `gh auth status`."
    );
  }

  let result: CommandResult;
  try {
    result = await input.runner(
      [
        "gh",
        "issue",
        "view",
        String(input.issue),
        "--repo",
        repository,
        "--json",
        "number,title,body,url"
      ],
      input.cwd
    );
  } catch (error) {
    throw new Error(
      `Cannot read GitHub issue ${input.issue} from ${repository}: ${error instanceof Error ? error.message : String(error)}. ` +
        remediation(repository, input.issue)
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `gh exited ${result.exitCode}`;
    throw new Error(`Cannot read GitHub issue ${input.issue} from ${repository}: ${detail}. ${remediation(repository, input.issue)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(
      `GitHub issue ${input.issue} from ${repository} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}. ` +
        remediation(repository, input.issue)
    );
  }
  const parsed = issueResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `GitHub issue ${input.issue} from ${repository} returned an invalid snapshot. ${remediation(repository, input.issue)}`
    );
  }
  if (parsed.data.number !== input.issue) {
    throw new Error(
      `GitHub returned issue ${parsed.data.number} while issue ${input.issue} was requested from ${repository}. ` +
        remediation(repository, input.issue)
    );
  }
  return { repository, ...parsed.data };
};

export type FollowUpVerification =
  | { status: "verified"; number: number; url: string }
  | { status: "rejected"; reason: string }
  | { status: "unavailable"; reason: string };

const CLOSING_REFERENCE = (issue: number): RegExp =>
  new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s*:?\\s*(?:#|https://github\\.com/\\S+/issues/)${issue}(?![0-9])`, "i");

/**
 * Read the follow-up issue an objector cites and check that it is the issue
 * this objection needs: a different issue in the same repository whose body
 * references the concluding issue without closing it, names the final
 * revision, and carries the stable filing key. A failed lookup is reported as
 * unavailable, never as a rejection, so the objector is not told to file again.
 */
export const verifyFollowUpIssue = async (input: {
  origin: string;
  parentIssue: number;
  claimedUrl: string;
  revisionSha: string;
  filingKey: string;
  cwd: string;
  runner: CommandRunner;
}): Promise<FollowUpVerification> => {
  const repository = githubRepositoryFromOrigin(input.origin);
  if (repository === null) {
    return { status: "rejected", reason: `origin ${input.origin} is not a GitHub repository; no follow-up issue can be verified` };
  }
  const claimed = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/.exec(input.claimedUrl);
  if (claimed === null || claimed[1]!.toLowerCase() !== repository.toLowerCase()) {
    return { status: "rejected", reason: `follow-up issue ${input.claimedUrl} must be an issue URL in ${repository}` };
  }
  const number = Number(claimed[2]);
  if (number === input.parentIssue) {
    return { status: "rejected", reason: `the follow-up must be a new issue, not #${input.parentIssue} itself` };
  }
  let issue: GitHubIssueSnapshot;
  try {
    issue = await fetchGitHubIssue({ origin: input.origin, issue: number, cwd: input.cwd, runner: input.runner });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /could not resolve to an issue|not found|HTTP 404/i.test(message)
      ? { status: "rejected", reason: `follow-up issue ${input.claimedUrl} does not exist in ${repository}` }
      : { status: "unavailable", reason: message };
  }
  const parentUrl = `https://github.com/${repository}/issues/${input.parentIssue}`;
  const references = new RegExp(`(?:^|[^0-9A-Za-z_/])#${input.parentIssue}(?![0-9])`).test(issue.body) ||
    issue.body.includes(parentUrl);
  const missing = [
    ...(references ? [] : [`a reference to #${input.parentIssue}`]),
    ...(issue.body.includes(input.revisionSha) ? [] : [`the final revision ${input.revisionSha}`]),
    ...(issue.body.includes(input.filingKey) ? [] : [`the filing key ${input.filingKey}`])
  ];
  if (missing.length > 0) {
    return { status: "rejected", reason: `follow-up issue ${issue.url} body is missing ${missing.join(", ")}; edit that issue rather than filing another` };
  }
  if (CLOSING_REFERENCE(input.parentIssue).test(issue.body)) {
    return { status: "rejected", reason: `follow-up issue ${issue.url} must reference #${input.parentIssue} without a closing keyword; edit that issue rather than filing another` };
  }
  return { status: "verified", number: issue.number, url: issue.url };
};
