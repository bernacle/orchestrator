import { readFileSync, statSync } from "node:fs";
import type { Issue, IssueRef, IssueTracker } from "./types.js";

/**
 * Read-only Linear stand-in for replaying a dry run from a recorded issue snapshot (the
 * `issue.json` artifact of an earlier run). Related issues are known only by the state recorded
 * in the snapshot. Never used for live runs: writes throw, and the CLI refuses --execute with it.
 */
export class SnapshotTracker implements IssueTracker {
  readonly name = "linear-snapshot";
  readonly issue: Issue;
  readonly takenAt: string;

  constructor(readonly file: string) {
    this.issue = JSON.parse(readFileSync(file, "utf8")) as Issue;
    this.takenAt = statSync(file).mtime.toISOString();
  }

  async getIssue(key: string): Promise<Issue> {
    if (key === this.issue.key) return structuredClone(this.issue);
    const refs: IssueRef[] = [...this.issue.related, ...this.issue.blockedBy, ...this.issue.blocks, ...this.issue.children, ...(this.issue.parent ? [this.issue.parent] : [])];
    const ref = refs.find((r) => r.key === key);
    if (!ref) throw new Error(`${key} is not in the snapshot ${this.file}`);
    return {
      id: `snapshot-${key}`,
      ...ref,
      description: "",
      team: this.issue.team,
      project: null,
      labels: [],
      priority: { value: 0, label: "Unknown" },
      assignee: null,
      branchName: null,
      parent: null,
      children: [],
      blockedBy: [],
      blocks: [],
      related: [],
      comments: [],
      attachments: [],
      updatedAt: this.takenAt,
    };
  }

  async comment(): Promise<{ id: string }> {
    throw new Error("snapshot tracker is read-only");
  }

  async setState(): Promise<void> {
    throw new Error("snapshot tracker is read-only");
  }

  async whoami(): Promise<{ user: string; workspace: string; urlKey: string }> {
    return { user: "snapshot", workspace: `snapshot ${this.file}`, urlKey: "snapshot" };
  }
}
