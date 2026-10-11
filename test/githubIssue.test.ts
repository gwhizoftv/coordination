import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchGitHubIssue,
  formatFinalizationPullRequest,
  githubRepositoryFromOrigin,
  readGitHubIssueSnapshot,
  renderGitHubIssueSnapshot,
  stableFilingKey,
  verifyFollowUpIssue
} from "../src/githubIssue.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub issue snapshots", () => {
  it("derives supported repositories and binds lookup to origin rather than cwd", async () => {
    expect(githubRepositoryFromOrigin("https://github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("git@github.com:acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("/tmp/app.git")).toBeNull();
    const calls: string[][] = [];
    const snapshot = await fetchGitHubIssue({
      origin: "https://github.com/acme/app.git",
      issue: 42,
      cwd: "/unrelated/repository",
      runner: async (argv) => {
        calls.push([...argv]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 42,
            title: "Work",
            body: "Do it",
            url: "https://github.com/acme/app/issues/42"
          }),
          stderr: ""
        };
      }
    });
    expect(calls[0]).toEqual([
      "gh",
      "issue",
      "view",
      "42",
      "--repo",
      "acme/app",
      "--json",
      "number,title,body,url"
    ]);
    expect(snapshot.repository).toBe("acme/app");
    expect(renderGitHubIssueSnapshot(snapshot)).toBe(`${JSON.stringify(snapshot, null, 2)}\n`);
  });

  it("fails with issue-first remediation on a missing or unreadable issue", async () => {
    await expect(
      fetchGitHubIssue({
        origin: "https://github.com/acme/app.git",
        issue: 999,
        cwd: "/tmp",
        runner: async () => ({ exitCode: 1, stdout: "", stderr: "issue not found" })
      })
    ).rejects.toThrow(/Create GitHub issue 999.*gh auth status/);
  });

  it("rejects malformed and mismatched responses", async () => {
    const input = {
      origin: "https://github.com/acme/app.git",
      issue: 7,
      cwd: "/tmp"
    };
    await expect(
      fetchGitHubIssue({ ...input, runner: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }) })
    ).rejects.toThrow(/invalid snapshot/);
    await expect(
      fetchGitHubIssue({
        ...input,
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            number: 8,
            title: "wrong",
            body: "",
            url: "https://github.com/acme/app/issues/8"
          }),
          stderr: ""
        })
      })
    ).rejects.toThrow(/issue 8 while issue 7/);
  });

  it("normalizes an empty GitHub issue body to an empty string", async () => {
    const snapshot = await fetchGitHubIssue({
      origin: "https://github.com/acme/app.git",
      issue: 3,
      cwd: "/tmp",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          number: 3,
          title: "Body optional",
          body: null,
          url: "https://github.com/acme/app/issues/3"
        }),
        stderr: ""
      })
    });
    expect(snapshot.body).toBe("");
  });

  it("reads a durable runtime snapshot and formats finalization PR text", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-issue-snap-"));
    roots.push(root);
    const path = join(root, "github-issue.json");
    const snapshot = {
      repository: "acme/app",
      number: 112,
      title: "Have PR's include the issue title",
      body: "Close on merge.",
      url: "https://github.com/acme/app/issues/112"
    };
    writeFileSync(path, renderGitHubIssueSnapshot(snapshot));
    expect(readGitHubIssueSnapshot(path)).toEqual(snapshot);
    expect(
      formatFinalizationPullRequest({
        issue: 112,
        title: snapshot.title,
        finalSha: "a".repeat(40),
        draft: true,
        evidenceBranch: "issue-112/coordinator-evidence",
        evidenceTip: "c".repeat(40)
      })
    ).toEqual({
      title: "Issue 112: Have PR's include the issue title",
      body: [
        "Closes #112",
        "",
        `Draft PR for issue 112. Owner merges. Final pin: ${"a".repeat(40)}.`,
        "",
        `Ballot evidence branch: issue-112/coordinator-evidence (tip ${"c".repeat(40)}).`,
        "That branch is coordinator-authored publication of action-bound ballot responses, not a cryptographic agent signature."
      ].join("\n")
    });
    expect(
      formatFinalizationPullRequest({
        issue: 112,
        title: snapshot.title,
        finalSha: "a".repeat(40),
        draft: true,
        evidenceBranch: "issue-112/coordinator-evidence",
        evidenceTip: "c".repeat(40),
        closeoutReason: "Concluded development at the third revision limit with unresolved objections",
        followUpIssues: [{ agent: "codex", issue: 113, url: "https://github.com/acme/app/issues/113" }]
      })
    ).toEqual({
      title: "Issue 112: Have PR's include the issue title",
      body: [
        "Closes #112",
        "",
        `Draft PR for issue 112. Owner merges. Final pin: ${"a".repeat(40)}.`,
        "",
        "Conclusion: Concluded development at the third revision limit with unresolved objections.",
        "",
        "Follow-up issues filed by objecting agents:",
        "- codex: #113 (https://github.com/acme/app/issues/113)",
        "",
        `Ballot evidence branch: issue-112/coordinator-evidence (tip ${"c".repeat(40)}).`,
        "That branch is coordinator-authored publication of action-bound ballot responses, not a cryptographic agent signature."
      ].join("\n")
    });
    expect(
      formatFinalizationPullRequest({
        issue: 112,
        title: "  ",
        finalSha: "b".repeat(40),
        draft: false
      }).title
    ).toBe("Issue 112: coordinated implementation");
  });

  it("derives deterministic stable filing keys", () => {
    const key1 = stableFilingKey("session-1", "codex", "a".repeat(40));
    const key2 = stableFilingKey("session-1", "codex", "a".repeat(40));
    const key3 = stableFilingKey("session-1", "antigravity", "a".repeat(40));
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).toMatch(/^coord:follow-up:[0-9a-f]{64}$/);
  });

  it("verifies follow-up issues with table-driven validation cases", async () => {
    const revSha = "a".repeat(40);
    const key = stableFilingKey("sess-1", "codex", revSha);
    const validBody = `Follow-up issue for #42.\nRevision: ${revSha}\nKey: ${key}`;

    const makeRunner = (result: { exitCode: number; body?: string | null; error?: string }) => async () => {
      if (result.exitCode !== 0) throw new Error(result.error ?? "gh error");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 43,
          title: "Follow-up",
          body: result.body ?? "",
          url: "https://github.com/acme/app/issues/43"
        }),
        stderr: ""
      };
    };

    // Valid
    const valid = await verifyFollowUpIssue({
      origin: "https://github.com/acme/app.git",
      concludingIssue: 42,
      agent: "codex",
      revisionSha: revSha,
      stableKey: key,
      followUpUrl: "https://github.com/acme/app/issues/43",
      cwd: "/tmp",
      runner: makeRunner({ exitCode: 0, body: validBody })
    });
    expect(valid).toEqual({
      ok: true,
      issue: 43,
      url: "https://github.com/acme/app/issues/43",
      title: "Follow-up"
    });

    // Foreign repo URL
    const foreign = await verifyFollowUpIssue({
      origin: "https://github.com/acme/app.git",
      concludingIssue: 42,
      agent: "codex",
      revisionSha: revSha,
      stableKey: key,
      followUpUrl: "https://github.com/other/repo/issues/43",
      cwd: "/tmp",
      runner: makeRunner({ exitCode: 0, body: validBody })
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.retry).toBe(false);

    // Parent/concluding issue number
    const sameIssue = await verifyFollowUpIssue({
      origin: "https://github.com/acme/app.git",
      concludingIssue: 42,
      agent: "codex",
      revisionSha: revSha,
      stableKey: key,
      followUpUrl: "https://github.com/acme/app/issues/42",
      cwd: "/tmp",
      runner: makeRunner({ exitCode: 0, body: validBody })
    });
    expect(sameIssue.ok).toBe(false);
    if (!sameIssue.ok) expect(sameIssue.retry).toBe(false);

    // Lookup failure (retryable)
    const lookupFail = await verifyFollowUpIssue({
      origin: "https://github.com/acme/app.git",
      concludingIssue: 42,
      agent: "codex",
      revisionSha: revSha,
      stableKey: key,
      followUpUrl: "https://github.com/acme/app/issues/43",
      cwd: "/tmp",
      runner: makeRunner({ exitCode: 1, error: "network timeout" })
    });
    expect(lookupFail.ok).toBe(false);
    if (!lookupFail.ok) expect(lookupFail.retry).toBe(true);

    // Missing backlink
    const noBacklink = await verifyFollowUpIssue({
      origin: "https://github.com/acme/app.git",
      concludingIssue: 42,
      agent: "codex",
      revisionSha: revSha,
      stableKey: key,
      followUpUrl: "https://github.com/acme/app/issues/43",
      cwd: "/tmp",
      runner: makeRunner({ exitCode: 0, body: `Revision: ${revSha}\nKey: ${key}` })
    });
    expect(noBacklink.ok).toBe(false);
    if (!noBacklink.ok) expect(noBacklink.error).toContain("missing a backlink to #42");

    // Missing revision
    const noRev = await verifyFollowUpIssue({
      origin: "https://github.com/acme/app.git",
      concludingIssue: 42,
      agent: "codex",
      revisionSha: revSha,
      stableKey: key,
      followUpUrl: "https://github.com/acme/app/issues/43",
      cwd: "/tmp",
      runner: makeRunner({ exitCode: 0, body: `Follow-up #42\nKey: ${key}` })
    });
    expect(noRev.ok).toBe(false);
    if (!noRev.ok) expect(noRev.error).toContain("does not cite revision commit");

    // Missing stable key
    const noKey = await verifyFollowUpIssue({
      origin: "https://github.com/acme/app.git",
      concludingIssue: 42,
      agent: "codex",
      revisionSha: revSha,
      stableKey: key,
      followUpUrl: "https://github.com/acme/app/issues/43",
      cwd: "/tmp",
      runner: makeRunner({ exitCode: 0, body: `Follow-up #42\nRevision: ${revSha}` })
    });
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.error).toContain("does not cite stable filing key");
  });
});
