import { readFileSync } from "node:fs";
import { z } from "zod";
import { sha256 } from "./hash.js";
import type { FollowUpEvidence } from "./protocol.js";

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
export const formatFinalizationPullRequest = (input: {
  issue: number;
  title: string;
  finalSha: string;
  draft: boolean;
  evidenceBranch?: string | null;
  evidenceTip?: string | null;
  closeout?: { round: number; followUps: readonly { agent: string; url: string }[]; droppedAgents: readonly string[] };
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
    lines.push("", `Concluded after revision ${input.closeout.round}; objections were recorded (not unanimous approval). Active objectors filed the follow-up issues listed below.`);
    for (const followUp of input.closeout.followUps) lines.push(`- ${followUp.agent}: ${followUp.url}`);
    if (input.closeout.droppedAgents.length > 0) lines.push(
      `Dropped agents: ${input.closeout.droppedAgents.join(", ")}; their historical ballots remain in the evidence branch, not counted as approvals or filed objections.`);
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

/** Stable across replacement actions and coordinator restarts. */
export const followUpKey = (issueSessionId: string, agent: string, revisionCommitSha: string): string =>
  `coord-follow-up:${sha256(JSON.stringify([issueSessionId, agent, revisionCommitSha]))}`;

export type FollowUpAssessment =
  | { status: "satisfied"; followUp: FollowUpEvidence }
  | { status: "rejected" | "retry"; outstanding: readonly string[] };

/** Read-only verification; the objecting agent owns creation and reconciliation. */
export const assessFollowUpIssue = async (input: {
  origin: string; issue: number; issueSessionId: string; agent: string;
  revisionCommitSha: string; url: string; cwd: string; runner: CommandRunner;
}): Promise<FollowUpAssessment> => {
  const repository = githubRepositoryFromOrigin(input.origin);
  const reject = (message: string): FollowUpAssessment => ({ status: "rejected", outstanding: [message] });
  if (repository === null) return reject("Cannot identify the GitHub repository for follow-up verification.");
  const prefix = `https://github.com/${repository}/issues/`;
  const suffix = input.url.startsWith(prefix) ? input.url.slice(prefix.length) : "";
  const number = Number(suffix);
  if (!/^[1-9][0-9]*$/.test(suffix) || !Number.isSafeInteger(number) || number === input.issue) {
    return reject(`Follow-up URL must identify a different issue in ${repository}.`);
  }
  let issue: GitHubIssueSnapshot;
  try {
    issue = await fetchGitHubIssue({ origin: input.origin, issue: number, cwd: input.cwd, runner: input.runner });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A missing issue needs a corrected receipt. Transport/authentication outages
    // retain the submitted receipt; they never ask an agent to file again.
    if (/could not resolve to an issue|could not find issue|HTTP 404|issue[^\n]*not found/i.test(message)) {
      return reject("The cited follow-up issue does not exist; reconcile your existing filing before correcting the receipt.");
    }
    return { status: "retry", outstanding: [`Follow-up lookup unavailable; retaining the receipt: ${message}`] };
  }
  if (issue.url !== input.url) return reject("GitHub returned a different follow-up issue URL.");
  const parentUrl = `https://github.com/${repository}/issues/${input.issue}`;
  const lines = issue.body.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(`Related to ${parentUrl}`)) return reject(`Follow-up body must include this non-closing backlink on its own line: Related to ${parentUrl}`);
  if (!lines.includes(`Revision: ${input.revisionCommitSha}`)) return reject("Follow-up body must name the exact final revision on its Revision line.");
  if (!lines.includes(`Tracking key: ${followUpKey(input.issueSessionId, input.agent, input.revisionCommitSha)}`)) {
    return reject("Follow-up body must include the supplied stable tracking key; reuse your existing issue when correcting it.");
  }
  return { status: "satisfied", followUp: { number, url: issue.url, revisionCommitSha: input.revisionCommitSha } };
};
