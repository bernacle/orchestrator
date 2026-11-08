import type { AgentConfig } from "../config/schema.js";
import type { SandboxSpec } from "../core/isolation.js";
import type { PrEvidence } from "../planning/dependencies.js";

export type { PrEvidence };

/**
 * Adapter contracts. The engine only talks to the outside world through
 * these interfaces; every implementation has a mock in ./mock for tests.
 */

// ---- issue tracker (Linear) ------------------------------------------------------

export type IssueStateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | string;

export interface IssueRef {
  key: string;
  title: string;
  url?: string;
  state: { name: string; type: IssueStateType };
}

export interface Issue extends IssueRef {
  id: string;
  description: string;
  team: { key: string; name: string };
  project: string | null;
  labels: string[];
  priority: { value: number; label: string };
  assignee: string | null;
  branchName: string | null;
  parent: IssueRef | null;
  children: IssueRef[];
  /** Issues that must be done before this one. */
  blockedBy: IssueRef[];
  /** Issues waiting on this one. */
  blocks: IssueRef[];
  related: IssueRef[];
  comments: Array<{ author: string; body: string; createdAt: string }>;
  attachments: Array<{ title: string; url: string }>;
  updatedAt: string;
}

export interface IssueTracker {
  readonly name: string;
  getIssue(key: string): Promise<Issue>;
  comment(key: string, body: string): Promise<{ id: string }>;
  setState(key: string, stateName: string): Promise<void>;
  /** For doctor: confirm credentials and report the workspace. */
  whoami(): Promise<{ user: string; workspace: string; urlKey: string }>;
}

// ---- code host (GitHub) ----------------------------------------------------------

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  visibility: string;
  /** SHA of the base branch on the remote. */
  baseSha: string;
  allowAutoMerge: boolean;
  mergeMethods: Array<"squash" | "merge" | "rebase">;
  viewerPermission: string;
}

export interface BranchProtection {
  branch: string;
  /** Classic protection or an active ruleset applies. */
  protected: boolean;
  requiredChecks: string[];
  requiredApprovals: number;
  rulesetTypes: string[];
  /** Human-readable summary of what could not be determined. */
  notes: string[];
}

export type CheckBucket = "pass" | "fail" | "pending" | "skipped";

export interface PullRequestStatus {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: Array<{ name: string; bucket: CheckBucket; detailsUrl?: string }>;
}

export interface CodeHost {
  readonly name: string;
  viewer(): Promise<{ login: string }>;
  getRepo(repo: string, branch?: string): Promise<RepoInfo>;
  getBranchProtection(repo: string, branch: string): Promise<BranchProtection>;
  findPullRequest(repo: string, headBranch: string): Promise<PullRequestStatus | null>;
  createPullRequest(input: { repo: string; base: string; head: string; title: string; body: string; draft: boolean; labels: string[] }): Promise<PullRequestStatus>;
  getPullRequest(repo: string, number: number): Promise<PullRequestStatus>;
  /** Must pin the head SHA; implementations must never use admin overrides. */
  mergePullRequest(input: { repo: string; number: number; headSha: string; method: "squash" | "merge" | "rebase" }): Promise<void>;
  /**
   * Evidence that an issue was implemented in `repo`: the PR numbers given (e.g. written next to the key
   * in the description), PR URLs attached to the issue, and PRs whose title or body mention the key.
   */
  linkedPullRequests(input: { repo: string; issueKey: string; prNumbers: number[]; attachmentUrls: string[] }): Promise<PrEvidence[]>;
}

// ---- workspace (git) -------------------------------------------------------------

export interface ChangedFile {
  status: string;
  path: string;
}

export interface RepoInspection {
  root: string;
  headSha: string;
  packageManager: string | null;
  scripts: Record<string, string>;
  workspaces: string[];
  ciWorkflows: Array<{ file: string; runSteps: string[] }>;
  guidanceFiles: string[];
  topLevel: string[];
  nodeEngine: string | null;
}

export interface Workspace {
  /** Ensure a clone exists and is fetched (orchestrator-owned clones only). */
  ensureClone(repo: string, clonePath: string, opts: { fetch: boolean }): Promise<void>;
  inspect(repoPath: string, ref?: string): Promise<RepoInspection>;
  branchExists(repoPath: string, branch: string): Promise<{ local: boolean; remote: boolean }>;
  /** Idempotent: reuses an existing worktree for the same branch. */
  createWorktree(input: { repoPath: string; worktreePath: string; branch: string; baseRef: string }): Promise<{ created: boolean; headSha: string }>;
  headSha(worktreePath: string): Promise<string>;
  changedFiles(worktreePath: string, baseSha: string): Promise<ChangedFile[]>;
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  diff(worktreePath: string, baseSha: string): Promise<string>;
  /** Stage everything and commit. Returns null when there is nothing to commit. */
  commitAll(worktreePath: string, message: string): Promise<string | null>;
  push(worktreePath: string, branch: string): Promise<void>;
  /** Which of `paths` exist at `ref` (read-only, from git objects). */
  filesExist(repoPath: string, ref: string, paths: string[]): Promise<Array<{ path: string; exists: boolean }>>;
  /** Remove a worktree the orchestrator created (preflight only). */
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>;
  /** Create a detached worktree at `ref` (preflight only). */
  createDetachedWorktree(repoPath: string, worktreePath: string, ref: string): Promise<void>;
}

// ---- coding agents ---------------------------------------------------------------

export type AgentRole = "planner" | "implementer" | "reviewer";

export interface AgentTask {
  role: AgentRole;
  cwd: string;
  prompt: string;
  /** Continue a previous session (implementer fix rounds). */
  resumeSessionId?: string;
  /** Pre-assigned id for a new session, persisted before launch so a crash can resume it. */
  sessionId?: string;
  /** Spend cap for this call (adapters that support one); the orchestrator passes what is left of the run budget. */
  maxBudgetUsd?: number;
  /** JSON Schema for structured final output. */
  outputSchema?: object;
  /** Where the adapter writes raw transcripts. */
  artifactDir: string;
  artifactPrefix: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface AgentResult {
  sessionId: string | null;
  /** Final message from the agent. Self-reported: never trusted as verification. */
  text: string;
  structured: unknown;
  ok: boolean;
  error: string | null;
  costUsd: number | null;
  durationMs: number;
  /** Raw transcript files written by the adapter. */
  transcripts: string[];
}

export interface AgentRunner {
  /** Adapter id, e.g. "claude-code". */
  readonly id: string;
  /** Who is behind it, for the independent-review invariant, e.g. "anthropic". */
  readonly provider: string;
  /** Exact command line that would run, for dry runs and audit logs. */
  describe(task: Omit<AgentTask, "signal" | "env">): string;
  run(task: AgentTask): Promise<AgentResult>;
  /** For doctor. */
  probe(): Promise<{ ok: boolean; detail: string }>;
  /** Can this agent run with the isolation the orchestrator requires? Live runs block if not. */
  verifyIsolation(): Promise<{ ok: boolean; detail: string }>;
}

// ---- checks ----------------------------------------------------------------------

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  optional: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** Last lines of combined output, redacted. */
  outputTail: string;
  logPath: string | null;
}

export interface CheckRunner {
  /** `sandbox: null` runs unsandboxed; callers must only do that when the operator allowed it explicitly. */
  run(input: { name: string; command: string; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; optional: boolean; logPath: string; signal: AbortSignal; sandbox: SandboxSpec | null }): Promise<CheckResult>;
}

// ---- bundle ----------------------------------------------------------------------

export interface Adapters {
  tracker: IssueTracker;
  codeHost: CodeHost;
  workspace: Workspace;
  checks: CheckRunner;
  /** Build the runner for a configured role (model, permissions, timeouts come from config). */
  agent(config: AgentConfig): AgentRunner;
}
