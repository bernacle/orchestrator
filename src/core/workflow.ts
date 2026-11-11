import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describeNode, resolveRunToolchain, toolchainReadPaths, type NodeVersionFile, type ResolvedToolchain } from "../adapters/checks.js";
import type { AgentResult, AgentRunner, ChangedFile, CheckResult, Issue, IssueRef, PrEvidence, PullRequestStatus } from "../adapters/types.js";
import { loadBrief, type Brief } from "../config/brief.js";
import type { AgentConfig, CheckConfig, RepoConfig } from "../config/schema.js";
import { classifyDependencies, extractIssueMentions, keysNeedingEvidence } from "../planning/dependencies.js";
import { analyzeReadiness, branchNameFor, deriveAdditionalCriteria, extractAcceptanceCriteria, numberCriteria } from "../planning/issue.js";
import {
  AGENT_PLAN_SCHEMA,
  agentAssignment,
  buildExecutionPlan,
  parseAgentPlan,
  type AgentPlan,
  type ExecutionPlan,
  type IsolationReport,
} from "../planning/plan.js";
import {
  fixPromptForChecks,
  fixPromptForCi,
  fixPromptForMinorFindings,
  fixPromptForReview,
  fixPromptForScreenshots,
  implementerPrompt,
  plannerPrompt,
  prOwnedByRun,
  pullRequestBody,
  reviewerPrompt,
  type PrCiStatus,
  type PrReviewRound,
  type ScreenshotBrief,
} from "../planning/prompts.js";
import {
  IMPLEMENTER_REPORT_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  criteriaReport,
  decideReview,
  declinedAll,
  parseImplementerReport,
  parseReview,
  type Criterion,
  type CriterionReport,
  type Finding,
  type ImplementerReport,
  type ReviewDecision,
  type ReviewOutcome,
} from "../planning/review.js";
import { renderPlanMarkdown } from "../report/render.js";
import { BlockedError, FailedError, StopError, type Handler, type Outcome, type StepContext } from "./engine.js";
import {
  ALWAYS_DENIED_ENV,
  compareTripwire,
  credentialPaths,
  describeTripwireChanges,
  defaultWritable,
  isolationDirs,
  isolationReadPaths,
  repositoryReadPaths,
  sandboxSupport,
  takeTripwire,
  tripwirePaths,
  type NetworkPolicy,
  type SandboxSpec,
} from "./isolation.js";
import { matchGlob } from "./glob.js";
import { ciState, evaluateMerge, type MergeEligibility } from "./policy.js";
import { completionReason, describeMerge, mergeRecord } from "./reconcile.js";
import { collectScreenshots, matchesOutputs, outputStamps, pngPixels, pngProblem, screenshotCheck, screenshotsRequired, SCREENSHOT_CHECK_NAME, type Screenshot } from "./screenshots.js";
import type { RunState } from "./states.js";

// ---- persisted run context ---------------------------------------------------------

export interface Round {
  attempt: number;
  /**
   * What started the round. "minor": the one bounded round for actionable minor findings after an
   * approval. "revert": the engine (no agent) restored the approved commit after that round failed.
   */
  trigger: "initial" | "checks" | "review" | "ci" | "minor" | "revert";
  implementer?: {
    sessionId: string | null;
    ok: boolean;
    error: string | null;
    costUsd: number | null;
    durationMs: number;
    summary: string;
    /** Self-reported per-finding response (review-driven rounds); shown to the reviewer to verify. */
    report?: ImplementerReport | null;
  };
  commitSha?: string | null;
  changedFiles?: ChangedFile[];
  checks?: Array<Omit<CheckResult, "outputTail">>;
  review?: {
    verdict: ReviewOutcome["verdict"];
    summary: string;
    findings: Finding[];
    approved: boolean;
    blocking: number;
    reviewedSha: string;
    sessionId: string | null;
    /** Every acceptance criterion with the reviewer's verdict. */
    criteria?: CriterionReport[];
    /** True when no reviewer ran: the commit is the one an earlier round approved (same tree). */
    reused?: boolean;
  };
  /** Screenshots the orchestrator generated from this round's code, the commit holding them, and the reviewer's copies. */
  screenshots?: { command: string; files: Screenshot[]; commitSha: string | null; copyDir?: string } | null;
}

export interface RunContext {
  options: {
    withAgentPlan: boolean;
    ciWaitMinutes: number;
    origin: { kind: "t3"; cliPath: string } | null;
    /** Prerequisites the operator explicitly accepted as non-blocking (--accept-dependency). */
    acceptedDependencies?: string[];
    /** Dry-run replay of recorded Linear data. */
    issueSnapshot?: { file: string; takenAt: string };
    /** How the request was resolved (src/intake): repository selection, issue association, origin. */
    intake?: {
      source: "explicit" | "config_file" | "cwd" | "team";
      reason: string;
      association: { verified: boolean; evidence: Array<{ kind: string; detail: string }> } | null;
      cwd: string | null;
      linkedWorktree: boolean;
      /** Linear workspace the request named (issue URL), used to pick the stored credential. */
      linearWorkspace: string | null;
    };
  };
  configSource: string;
  /**
   * A person's approval of this live run's scope (core/approval.ts): asked for in the starting (or
   * resuming) process, never read from arguments or files. Null for dry runs.
   */
  authorization?: {
    purpose: string;
    scopeHash: string;
    approvedAt: string;
    channel: string;
    user: string;
    detail: string;
    /**
     * "trust": no prompt; the repository was trusted for this exact scope (core/trust.ts). Absent
     * on runs created before trusted mode existed, which were all approved by a person.
     */
    basis?: "approval" | "trust";
    trust?: { id: string; scopeHash: string; trustedBy: string; trustedAt: string } | null;
  } | null;
  /** Start of the current limit window (run creation, reset on operator resume). */
  limitWindowStartedAt?: string;
  issue?: Issue;
  plan?: ExecutionPlan;
  agentPlan?: AgentPlan | null;
  brief?: { source: string; sha256: string; body: string } | null;
  baseBranch?: string;
  baseSha?: string;
  clonePath?: string;
  /** The repository's Node version file at the base commit (null: none). Undefined on older runs. */
  nodeVersionFile?: NodeVersionFile | null;
  branch?: string;
  worktreePath?: string;
  implementerSessionId?: string | null;
  rounds: Round[];
  /**
   * The accepted baseline: every required check green on the untouched base and the worktree left
   * clean. Only an accepted baseline is ever reused; a red one is kept in `baselineFailure`.
   */
  baseline?: Array<Omit<CheckResult, "outputTail">> | null;
  /** Baseline attempts so far. Each attempt uses fresh effect keys, so a re-entry re-runs every check. */
  baselineAttempts?: number;
  /** The last baseline attempt that did not pass (audit and status only, never treated as done). */
  baselineFailure?: { attempt: number; baseSha: string | null; reason: string; results: Array<Omit<CheckResult, "outputTail">> } | null;
  /** Feedback FIXING must address. `requested`: the finding / criterion ids the round must answer. */
  feedback?: { trigger: Round["trigger"]; prompt: string; requested?: string[] } | null;
  /**
   * The one bounded correction round for actionable minor findings after an approval
   * (review.minor_fix_rounds). It can only improve delivery: if its result is not approved, the
   * approved commit is restored, re-checked and delivered with its approval.
   *  - running: the round is in progress.  applied: its result was approved and is delivered.
   *  - declined: the implementer changed nothing; the approved commit is delivered.
   *  - rejected: its result failed checks or review; the approved commit is being restored.
   *  - reverted: the approved commit is restored (and re-checked before delivery).
   */
  minorRound?: {
    status: "running" | "applied" | "declined" | "rejected" | "reverted";
    approvedSha: string;
    approvedReview: ReviewOutcome;
    approvedAttempt: number;
    findings: Finding[];
    reason?: string | null;
    /**
     * Blocking findings the review raised on the discarded attempt. They may also apply to the
     * approved commit, so a restored commit is reviewed again against them instead of reusing its approval.
     */
    rejectedFindings?: Finding[];
  } | null;
  /** The run opened its PR itself (not one it found on the branch). */
  prCreatedByRun?: boolean;
  /** Every commit this run pushed, oldest first (GitHub may briefly still show an earlier one). */
  pushed?: string[];
  /** sha256 prefix of the PR description last published, so an unchanged one is not sent again. */
  prBodySha?: string | null;
  /** Re-checks of a restored approved commit that ended BLOCKED: a resume runs them again under new keys. */
  recheck?: number;
  /** GitHub CI on the PR head as last observed (WAITING_FOR_CI / READY_TO_MERGE). */
  lastCi?: PrCiStatus | null;
  /**
   * The merge a person made, as GitHub reports it. `headIsReviewed` false: commits were added outside
   * the engine after its review (`outsideCommits`, null when they could not be listed).
   */
  merged?: {
    at: string | null;
    by: string | null;
    mergeCommitSha: string | null;
    headSha: string;
    reviewedSha: string | null;
    headIsReviewed: boolean;
    outsideCommits: Array<{ sha: string; message: string }> | null;
    recordedBy: "engine" | "reconcile";
  } | null;
  lastChecks?: CheckResult[];
  lastReview?: ReviewOutcome | null;
  reviewedSha?: string | null;
  reviewApproved?: boolean;
  unresolvedBlocking?: number;
  pr?: { number: number; url: string; headSha: string } | null;
  merge?: (MergeEligibility & { checkedAt: string; headSha: string }) | null;
  costUsd?: number;
}

type Ctx = StepContext<RunContext>;

const SUMMARY_LIMIT = 4_000;
/** Below this, another Claude call cannot do meaningful work: stop instead. */
const MIN_USEFUL_BUDGET_USD = 0.5;

// ---- helpers -----------------------------------------------------------------------

function provider(ctx: Ctx, cfg: AgentConfig): AgentRunner {
  return ctx.adapters.agent(cfg);
}

function require<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`run context is missing ${what}`);
  return value;
}

/** The run's acceptance criteria, numbered AC1… (the issue's own first, then the planner's derived ones). */
export function runCriteria(c: RunContext): Criterion[] {
  return numberCriteria(c.plan?.acceptanceCriteria);
}

/** Effect-key suffix that makes a resumed re-check of a restored commit run again. */
function recheckSuffix(c: RunContext): string {
  return c.recheck ? `.recheck-${c.recheck}` : "";
}

/**
 * Correction rounds spent against merge.max_fix_attempts. The minor-finding round and the engine's
 * restore of the approved commit have their own bound, so they never use up this budget.
 */
export function correctionsUsed(run: { attempt: number; context: RunContext }): number {
  return run.attempt - run.context.rounds.filter((r) => r.trigger === "minor" || r.trigger === "revert").length;
}

/** The base commit's Node version file, read once (older runs did not record it during planning). */
async function baseNodeVersionFile(ctx: Ctx): Promise<NodeVersionFile | null> {
  const c = ctx.run.context;
  if (c.nodeVersionFile !== undefined) return c.nodeVersionFile;
  if (!c.clonePath || !c.baseSha) return null;
  const file = (await ctx.adapters.workspace.inspect(c.clonePath, c.baseSha)).nodeVersionFile ?? null;
  ctx.save({ nodeVersionFile: file });
  return file;
}

/** The toolchain as repository commands and agents of this run get it, probed where they run. */
async function runToolchain(ctx: Ctx, agent?: AgentConfig): Promise<{ env: NodeJS.ProcessEnv; node: ResolvedToolchain["node"]; toolchainEnv: NodeJS.ProcessEnv }> {
  const c = ctx.run.context;
  return resolveRunToolchain({
    toolchain: ctx.config.toolchain,
    versionFile: await baseNodeVersionFile(ctx),
    cwd: c.worktreePath ?? c.clonePath ?? process.cwd(),
    dirs: isolationDirs(ctx.paths.home),
    ...(agent ? { agent: agent.adapter } : {}),
  });
}

/**
 * Scrubbed environment for repository commands and agents (see isolation.ts). A live run never
 * runs them on a Node that does not satisfy the requirement: it blocks instead (the agent would
 * otherwise chase failures the wrong Node causes).
 */
async function runEnv(ctx: Ctx, agent?: AgentConfig): Promise<NodeJS.ProcessEnv> {
  return (await agentRunEnv(ctx, agent)).env;
}

/** runEnv plus what an agent's sandboxed shell must read to run that toolchain (the Node install). */
async function agentRunEnv(ctx: Ctx, agent?: AgentConfig): Promise<{ env: NodeJS.ProcessEnv; readablePaths: string[] }> {
  const tc = await runToolchain(ctx, agent);
  if (!ctx.dryRun && tc.node.source === "unresolved") throw new BlockedError(`toolchain: ${describeNode(tc.node)}`);
  return { env: tc.env, readablePaths: toolchainReadPaths(tc.node) };
}

/**
 * Sandbox for setup/check/screenshot commands in a worktree. Fails closed when required and
 * unavailable. Writes only to the worktree, temp and caches, never to the worktree's `.git` gitfile
 * (it steers the orchestrator's own git). Home-directory contents are unreadable except
 * repositoryReadPaths: the worktree, the clone's git dir, the pinned toolchain, specific caches and
 * `isolation.read_paths`. Credential paths are unreadable in any case.
 */
function checkSandbox(ctx: Ctx, worktree: string, network: NetworkPolicy, toolchainReadable: string[]): SandboxSpec | null {
  const support = sandboxSupport();
  if (!support.available) {
    if (ctx.config.isolation.require) throw new BlockedError(`refusing to run repository commands without a sandbox: ${support.detail} (isolation.require=true)`);
    ctx.log("warn", "isolation.unsandboxed", `running repository commands WITHOUT a sandbox: ${support.detail}`);
    return null;
  }
  const clone = ctx.run.context.clonePath;
  return {
    writable: defaultWritable(worktree, process.env),
    readOnly: [join(worktree, ".git")],
    denyRead: credentialPaths(process.env, ctx.paths.home),
    privateHome: {
      home: process.env.HOME ?? homedir(),
      readable: repositoryReadPaths({ worktree, gitDir: clone ? join(clone, ".git") : null, toolchain: toolchainReadable, extra: [...isolationReadPaths(isolationDirs(ctx.paths.home)), ...ctx.config.isolation.read_paths], env: process.env }),
    },
    network,
  };
}

function gitDirsFor(clonePath: string): string[] {
  return [join(clonePath, ".git")];
}

/** Tripwire paths: shell rc files, agent settings, the clone's git config/hooks/refs, and the worktree's gitfile. */
function tripwireSet(ctx: Ctx): string[] {
  const { clonePath: clone, worktreePath } = ctx.run.context;
  const dirs = clone ? gitDirsFor(clone) : [];
  return [
    ...tripwirePaths(process.env, dirs),
    ...dirs.flatMap((g) => [join(g, "HEAD"), join(g, "packed-refs"), join(g, "refs")]),
    // Repointed, it would run the orchestrator's unsandboxed git against another git directory's config.
    ...(worktreePath ? [join(worktreePath, ".git")] : []),
  ];
}

/** Run a step that executes untrusted code (agent or repository commands) between two tripwire snapshots. */
/** The worktree root itself: a real directory with a stable inode (swapped for a symlink, it would redirect git). */
function worktreeIdentity(ctx: Ctx): string {
  const wt = ctx.run.context.worktreePath;
  if (!wt) return "none";
  try {
    const st = lstatSync(wt);
    return st.isSymbolicLink() ? "symlink" : `${st.isDirectory() ? "dir" : "other"}:${st.ino}`;
  } catch {
    return "absent";
  }
}

async function guarded<T>(ctx: Ctx, label: string, fn: () => Promise<T>): Promise<T> {
  const paths = tripwireSet(ctx);
  const before = takeTripwire(paths);
  const rootBefore = worktreeIdentity(ctx);
  const result = await fn();
  const after = takeTripwire(paths);
  const changed = compareTripwire(before, after);
  if (rootBefore !== worktreeIdentity(ctx) && ctx.run.context.worktreePath) changed.push(ctx.run.context.worktreePath);
  if (changed.length > 0) {
    // Fail closed: a change is never attributed or excused. The artifact records evidence (hashes and
    // metadata, never contents) so the operator can tell an escape from a concurrent writer.
    const details = describeTripwireChanges(before, after);
    const file = `tripwire-${Date.now()}.json`;
    ctx.writeArtifact("tripwire", `tripwire hit during ${label}`, file, JSON.stringify({ label, window: { from: before.takenAt, to: after.takenAt }, changed, details }, null, 2));
    throw new FailedError(
      `unexpected change outside the worktree during ${label}: ${changed.join(", ")}. ` +
        `Inspect these files before doing anything else. Any process running as you can change them, including sessions outside the orchestrator; ` +
        `see ${file} for the evidence (window ${before.takenAt} – ${after.takenAt}).`,
    );
  }
  return result;
}

/**
 * Stop before an agent call when the run's cost or time window is spent. Returns the budget left.
 * `metered: false` for agents that report no cost (the Codex reviewer): only the time limit applies,
 * so running out of implementation budget never skips the independent review.
 */
function enforceLimits(ctx: Ctx, what: string, metered = true): number {
  const { limits } = ctx.config;
  const spent = ctx.run.context.costUsd ?? 0;
  const remaining = limits.max_run_cost_usd - spent;
  if (metered && remaining < MIN_USEFUL_BUDGET_USD) {
    throw new BlockedError(`run cost limit reached before ${what}: $${spent.toFixed(2)} of $${limits.max_run_cost_usd.toFixed(2)} (limits.max_run_cost_usd)`);
  }
  const started = Date.parse(ctx.run.context.limitWindowStartedAt ?? ctx.run.createdAt);
  const minutes = (ctx.now().getTime() - started) / 60_000;
  if (minutes > limits.max_run_minutes) {
    throw new BlockedError(`run time limit reached before ${what}: ${Math.round(minutes)} of ${limits.max_run_minutes} minutes (limits.max_run_minutes); a resume approved by a person grants a new window (in a trusted repository: resume --require-approval)`);
  }
  return remaining;
}

function claudeBudget(cfg: AgentConfig, remaining: number): number | undefined {
  if (cfg.adapter !== "claude-code") return undefined;
  return Math.min(cfg.max_budget_usd ?? remaining, remaining);
}

/** Refuse to commit or publish anything that looks like a credential. */
function assertNoSecrets(ctx: Ctx, text: string, where: string): void {
  const hits = ctx.redactor.findSecrets(text);
  if (hits.length > 0) {
    throw new FailedError(`possible secret in ${where} (${hits.join(", ")}); nothing was pushed. Inspect the worktree before continuing.`);
  }
}

/** Forbidden paths are a safety stop: never undone silently, even inside the minor-finding round. */
class ForbiddenPathError extends BlockedError {}

export function forbiddenFiles(files: ChangedFile[], patterns: string[]): string[] {
  return files.filter((f) => f.status !== "D" && patterns.some((p) => matchGlob(f.path, p))).map((f) => f.path);
}

function totalCost(ctx: Ctx, add: number | null): number {
  return (ctx.run.context.costUsd ?? 0) + (add ?? 0);
}

/** Simulated agent result for dry runs: obviously not real. */
const SIMULATED_AGENT: AgentResult = { sessionId: null, text: "(dry run: agent not started)", structured: null, ok: true, error: null, costUsd: null, durationMs: 0, transcripts: [] };

/**
 * Milestone comment on the Linear issue. Only when permitted and only after confirming the API key
 * belongs to the configured workspace. A failed comment never blocks the run.
 */
async function linearMilestone(ctx: Ctx, key: string, description: string, body: string): Promise<void> {
  const { config, adapters, run } = ctx;
  await ctx.effect({
    key: `linear.milestone.${key}`,
    permission: "linear.comment",
    optional: true,
    description,
    simulate: () => null,
    run: async () => {
      try {
        const who = await adapters.tracker.whoami();
        if (!config.linear.workspace || who.urlKey !== config.linear.workspace) {
          ctx.log("warn", "linear.workspace_mismatch", `not commenting: Linear key belongs to "${who.urlKey}", config expects "${config.linear.workspace ?? "(unset)"}"`);
          return { skipped: "workspace mismatch" };
        }
        return await adapters.tracker.comment(run.issueKey, ctx.redactor.redact(body));
      } catch (err) {
        ctx.log("warn", "linear.comment_failed", `Linear comment failed (non-fatal): ${(err as Error).message}`);
        return { skipped: (err as Error).message };
      }
    },
  });
}

// ---- QUEUED ------------------------------------------------------------------------

const queued: Handler<RunContext> = async (ctx) => ({ to: "PLANNING", patch: { limitWindowStartedAt: ctx.run.context.limitWindowStartedAt ?? ctx.run.createdAt } });

// ---- PLANNING ----------------------------------------------------------------------

async function isolationReport(ctx: Ctx, agents: Array<{ role: string; cfg: AgentConfig }>): Promise<IsolationReport> {
  const support = sandboxSupport();
  const verified = await Promise.all(agents.map(async (a) => ({ role: a.role, adapter: a.cfg.adapter, ...(await provider(ctx, a.cfg).verifyIsolation()) })));
  return {
    required: ctx.config.isolation.require,
    ok: support.available && verified.every((v) => v.ok),
    checks: { mechanism: support.mechanism, available: support.available, detail: support.detail, setupNetwork: ctx.config.isolation.setup_network, checksNetwork: ctx.config.isolation.checks_network },
    agents: verified,
    environment: `allow-list only (PATH, HOME, locale, toolchain, agent auth); removed: ${ALWAYS_DENIED_ENV.slice(0, 6).join(", ")}…; empty gh and git config`,
    tripwires: tripwireSet(ctx).length,
    limitations: [
      "Not a VM or container: Seatbelt confines writes, credential reads and network for shell commands; the agent processes themselves run as you.",
      "Claude Code's Read/Edit/Write tools are fenced to the worktree by permission settings, not by the OS sandbox.",
      "The Codex reviewer's sandbox blocks writes and network but not reads; its output is redacted before it is published.",
      `Setup commands have network=${ctx.config.isolation.setup_network} (package install); lifecycle scripts can reach the internet but cannot read credentials.`,
      "Package caches (pnpm store, ~/Library/Caches) are writable by sandboxed commands.",
      "The orchestrator's own git push and gh calls use your credentials outside the sandbox; they never run repository code (hooks disabled).",
    ],
  };
}

const planning: Handler<RunContext> = async (ctx) => {
  const { config, adapters, run } = ctx;
  const [owner, name] = config.repo.split("/") as [string, string];

  const issue = await adapters.tracker.getIssue(run.issueKey);
  ctx.writeArtifact("issue", `${issue.key} snapshot`, "issue.json", JSON.stringify(issue, null, 2));
  ctx.log("info", "issue.fetched", `${issue.key} "${issue.title}" [${issue.state.name}], ${issue.comments.length} comments, ${issue.blockedBy.length} blocked-by relation(s)`);

  const extraBlockers: string[] = [];
  const extraWarnings: string[] = [];
  const snap = run.context.options.issueSnapshot;
  if (snap) extraWarnings.push(`Linear data replayed from snapshot ${snap.file} (recorded ${snap.takenAt}); issue and dependency states may be stale. A live run re-reads Linear.`);
  if (!config.linear.teams.map((t) => t.toUpperCase()).includes(issue.team.key.toUpperCase())) {
    extraBlockers.push(`issue belongs to team ${issue.team.key}, which ${config.repo} is not configured for (linear.teams: ${config.linear.teams.join(", ")})`);
  }
  if (config.linear.projects.length && !config.linear.projects.includes(issue.project ?? "")) {
    extraBlockers.push(`issue project "${issue.project ?? "none"}" is not one of ${config.linear.projects.join(", ")}`);
  }

  const repoInfo = await adapters.codeHost.getRepo(config.repo, config.base_branch);
  const baseBranch = config.base_branch ?? repoInfo.defaultBranch;
  const protection = await adapters.codeHost.getBranchProtection(config.repo, baseBranch);

  // Orchestrator-owned clone unless the operator points at an existing one.
  const managed = !config.local_path;
  const clonePath = config.local_path ?? join(ctx.paths.clones, owner, name);
  if (managed) await adapters.workspace.ensureClone(config.repo, clonePath, { fetch: true });
  else extraWarnings.push(`using operator clone ${clonePath}; worktrees will be registered in its .git`);
  const inspectedRef = managed ? `origin/${baseBranch}` : "HEAD";
  const inspection = await adapters.workspace.inspect(clonePath, managed ? inspectedRef : undefined);
  ctx.save({ clonePath, nodeVersionFile: inspection.nodeVersionFile ?? null });

  // ---- dependencies: relations, text, operator brief, and evidence
  const brief: Brief | null = loadBrief(ctx.paths, config.repo, issue.key);
  if (brief) ctx.log("info", "brief.loaded", `Operator brief ${brief.source} (sha256 ${brief.sha256.slice(0, 12)}), ${Object.keys(brief.decisions).length} dependency decision(s)`);
  const decisions = brief?.decisions ?? {};
  const mentions = extractIssueMentions(issue.description, issue.key);
  const refs = new Map<string, IssueRef>([...issue.related, ...issue.blockedBy].map((r) => [r.key, r]));
  const prs = new Map<string, PrEvidence[]>();
  const files = new Map<string, Array<{ path: string; exists: boolean }>>();
  for (const key of keysNeedingEvidence(issue, mentions, decisions)) {
    const dep = await adapters.tracker.getIssue(key).catch((err: Error) => {
      extraWarnings.push(`could not read ${key} from Linear: ${err.message}`);
      return null;
    });
    if (dep) refs.set(key, { key: dep.key, title: dep.title, ...(dep.url ? { url: dep.url } : {}), state: dep.state });
    const prNumbers = [...new Set(mentions.filter((m) => m.key === key).flatMap((m) => m.prNumbers))];
    prs.set(
      key,
      await adapters.codeHost.linkedPullRequests({ repo: config.repo, issueKey: key, prNumbers, attachmentUrls: dep?.attachments.map((a) => a.url) ?? [] }).catch((err: Error) => {
        extraWarnings.push(`could not look up PRs for ${key}: ${err.message}`);
        return [];
      }),
    );
    const required = decisions[key]?.satisfiedWhenFilesExist;
    if (required?.length) files.set(key, await adapters.workspace.filesExist(clonePath, inspection.headSha, required));
  }
  const accepted = run.context.options.acceptedDependencies ?? [];
  for (const key of accepted) ctx.log("warn", "dependency.accepted", `Operator accepted ${key} as non-blocking (--accept-dependency)`);
  const dependencies = classifyDependencies({ issue, mentions, refs, prs, files, decisions, accepted, baseSha: inspection.headSha });
  for (const d of dependencies.items) ctx.log(d.blocking ? "warn" : "info", "dependency.classified", `${d.key} [${d.state.name}] → ${d.classification}: ${d.reason}`);
  const readiness = analyzeReadiness(issue);
  const criteria = extractAcceptanceCriteria(issue.description);

  const branch = branchNameFor(config.branch.template, issue);
  const worktreePath = join(ctx.paths.worktrees, owner, name, run.id);
  const branchExists = await adapters.workspace.branchExists(clonePath, branch);
  const existingPr = await adapters.codeHost.findPullRequest(config.repo, branch);
  const tc = await resolveRunToolchain({ toolchain: config.toolchain, versionFile: inspection.nodeVersionFile, cwd: worktreePath, dirs: isolationDirs(ctx.paths.home) });

  // ---- independence invariants
  const implementer = provider(ctx, config.agents.implementer);
  const reviewer = provider(ctx, config.agents.reviewer);
  const invariants = [
    {
      rule: "reviewer is not the implementer",
      ok: implementer.id !== reviewer.id || implementer.provider !== reviewer.provider,
      detail: `implementer=${implementer.id}/${implementer.provider}, reviewer=${reviewer.id}/${reviewer.provider}`,
    },
    {
      rule: "reviewer comes from a different provider",
      ok: !config.review.require_distinct_provider || implementer.provider !== reviewer.provider,
      detail: config.review.require_distinct_provider ? `${implementer.provider} vs ${reviewer.provider}` : "not required by config",
    },
    {
      rule: "independent review required before merge",
      ok: config.merge.require_independent_review,
      detail: config.merge.require_independent_review ? "merge.require_independent_review=true" : "disabled in config: refusing to run",
    },
  ];

  // ---- isolation (fail closed for live runs, reported for dry runs)
  const isolation = await isolationReport(ctx, [
    ...(config.agents.planner ? [{ role: "planner", cfg: config.agents.planner }] : []),
    { role: "implementer", cfg: config.agents.implementer },
    { role: "reviewer", cfg: config.agents.reviewer },
  ]);

  const sampleTask = { cwd: worktreePath, prompt: "", artifactDir: ctx.artifactDir, timeoutMs: 0 };
  const agents = [
    agentAssignment("implementer", config.agents.implementer, implementer.provider, implementer.describe({ ...sampleTask, role: "implementer", artifactPrefix: "implement-0" })),
    agentAssignment("reviewer", config.agents.reviewer, reviewer.provider, reviewer.describe({ ...sampleTask, role: "reviewer", artifactPrefix: "review-0", outputSchema: REVIEW_OUTPUT_SCHEMA })),
  ];

  // ---- optional read-only planning
  let agentPlan: AgentPlan | null = null;
  const plannerCfg = config.agents.planner;
  if (plannerCfg && (!ctx.dryRun || run.context.options.withAgentPlan)) {
    const planner = provider(ctx, plannerCfg);
    agents.unshift(agentAssignment("planner", plannerCfg, planner.provider, planner.describe({ ...sampleTask, cwd: clonePath, role: "planner", artifactPrefix: "plan" })));
    const prompt = plannerPrompt(issue, criteria.criteria, inspection.guidanceFiles, brief?.body);
    ctx.writeArtifact("prompt", "planner prompt", "plan.prompt.md", prompt);
    const remaining = enforceLimits(ctx, "planning");
    const { env, readablePaths } = await agentRunEnv(ctx, plannerCfg);
    const result = await ctx.effect({
      key: "agent.plan",
      permission: "agents.run",
      description: `run read-only planner (${plannerCfg.adapter}) in ${clonePath}`,
      allowInDryRun: run.context.options.withAgentPlan,
      simulate: () => SIMULATED_AGENT,
      run: () =>
        guarded(ctx, "planning", () =>
          planner.run({
            role: "planner",
            cwd: clonePath,
            prompt,
            outputSchema: AGENT_PLAN_SCHEMA,
            artifactDir: ctx.artifactDir,
            artifactPrefix: "plan",
            timeoutMs: plannerCfg.timeout_minutes * 60_000,
            env,
            readablePaths,
            signal: ctx.signal,
            ...(claudeBudget(plannerCfg, remaining) !== undefined ? { maxBudgetUsd: claudeBudget(plannerCfg, remaining)! } : {}),
          }),
        ),
    });
    if (result && !result.ok) extraWarnings.push(`planner failed: ${result.error}`);
    agentPlan = result?.ok ? parseAgentPlan(result.structured) : null;
    if (result?.ok && !agentPlan) extraWarnings.push("planner returned output that did not match the plan schema; continuing without it");
    if (result?.costUsd) ctx.save({ costUsd: totalCost(ctx, result.costUsd) });
  } else if (plannerCfg) {
    extraWarnings.push("agent planning skipped in dry run (pass --with-agent-plan to run the read-only planner)");
  }

  // The planner reads the whole issue: requirements it states outside an explicit criteria list (its
  // scope) are judged one by one too, after the issue's own criteria.
  const derived = deriveAdditionalCriteria(criteria.criteria, agentPlan?.acceptance_criteria ?? []);
  const plan = buildExecutionPlan({
    runId: run.id,
    mode: ctx.dryRun ? "dry_run" : "supervised",
    now: ctx.now(),
    config,
    configSource: ctx.configSource,
    issue,
    criteria: derived.length ? { ...criteria, derived } : criteria,
    readiness,
    dependencies,
    brief: brief ? { source: brief.source, sha256: brief.sha256, decisions: Object.entries(brief.decisions).map(([k, d]) => `${k}: ${d.role ?? "note"} — ${d.reason}`) } : null,
    isolation,
    repoInfo,
    baseBranch,
    protection,
    inspection,
    inspectedRef,
    clonePath,
    toolchain: tc.node,
    branch,
    worktreePath,
    branchExists,
    existingPr,
    agents,
    invariants,
    agentPlan,
    extraBlockers,
    extraWarnings,
  });
  ctx.writeArtifact("plan", "execution plan (json)", "plan.json", JSON.stringify(plan, null, 2));
  ctx.writeArtifact("plan", "execution plan", "plan.md", renderPlanMarkdown(plan));
  for (const w of plan.warnings) ctx.log("warn", "plan.warning", w);

  const patch: Partial<RunContext> = {
    issue,
    plan,
    agentPlan,
    brief: brief ? { source: brief.source, sha256: brief.sha256, body: brief.body } : null,
    baseBranch,
    baseSha: repoInfo.baseSha,
    clonePath,
    branch,
    worktreePath,
  };
  if (plan.blockers.length > 0) {
    for (const b of plan.blockers) ctx.log("warn", "plan.blocker", b);
    const reason = plan.blockers.length === 1 ? plan.blockers[0]! : `${plan.blockers.length} blockers, first: ${plan.blockers[0]} (all: orchestrator plan ${run.id})`;
    return { to: "BLOCKED", reason, patch };
  }
  return { to: "IMPLEMENTING", patch };
};

// ---- shared: checks ----------------------------------------------------------------

async function runChecks(ctx: Ctx, input: { worktree: string; checks: CheckConfig[]; keyPrefix: string; logPrefix: string; defaultNetwork: NetworkPolicy; label: string }): Promise<CheckResult[]> {
  const { env, readablePaths } = await agentRunEnv(ctx);
  const results: CheckResult[] = [];
  for (const check of input.checks) {
    const network = check.network ?? input.defaultNetwork;
    const sandbox = checkSandbox(ctx, input.worktree, network, readablePaths);
    const res = await ctx.effect({
      key: `${input.keyPrefix}.${check.name}`,
      permission: "local.checks",
      description: `${input.label} "${check.name}": ${check.run}`,
      simulate: () => null,
      run: () =>
        guarded(ctx, `${input.label} "${check.name}"`, () =>
          ctx.adapters.checks.run({
            name: check.name,
            command: check.run,
            cwd: input.worktree,
            env,
            timeoutMs: check.timeout_minutes * 60_000,
            optional: check.optional,
            logPath: join(ctx.artifactDir, `${input.logPrefix}-${check.name}.log`),
            signal: ctx.signal,
            sandbox,
          }),
        ),
    });
    ctx.throwIfStopped();
    if (res) {
      results.push(res);
      ctx.log(res.ok ? "info" : "warn", "check.result", `${res.ok ? "✓" : "✗"} ${input.label} ${res.name} (${Math.round(res.durationMs / 1000)}s)${res.ok ? "" : ` exit ${res.exitCode}${res.timedOut ? " (timeout)" : ""}`}`);
    }
  }
  return results;
}

// ---- shared: implementer round -----------------------------------------------------

async function implementerRound(
  ctx: Ctx,
  attempt: number,
  trigger: Round["trigger"],
  prompt: string,
  requested: string[] = [],
): Promise<{ round: Round; sessionId: string | null; costUsd: number | null }> {
  const { config, adapters } = ctx;
  const c = ctx.run.context;
  const worktree = require(c.worktreePath, "worktreePath");
  const baseSha = require(c.baseSha, "baseSha");
  const agent = provider(ctx, config.agents.implementer);
  const { env, readablePaths } = await agentRunEnv(ctx, config.agents.implementer);
  const remaining = enforceLimits(ctx, `implementer round ${attempt}`);
  const prefix = `implement-${attempt}`;
  ctx.writeArtifact("prompt", `implementer prompt (round ${attempt})`, `${prefix}.prompt.md`, prompt);

  // Pin the session id before starting so a crash mid-run resumes the same session.
  const resumeSessionId = c.implementerSessionId ?? undefined;
  const sessionId = resumeSessionId ?? crypto.randomUUID();
  if (!resumeSessionId && agent.id === "claude-code") ctx.save({ implementerSessionId: sessionId });
  const budget = claudeBudget(config.agents.implementer, remaining);
  // Review-driven rounds answer each finding (fixed / declined, with a note) for the reviewer to verify.
  const wantsReport = trigger === "review" || trigger === "minor";

  const result = await ctx.effect({
    key: `agent.implement.${attempt}`,
    permission: "agents.run",
    description: `run implementer ${agent.id} (round ${attempt}, ${trigger}) in ${worktree}`,
    simulate: () => SIMULATED_AGENT,
    run: () =>
      guarded(ctx, `implementer round ${attempt}`, () =>
        agent.run({
          role: "implementer",
          cwd: worktree,
          prompt,
          ...(resumeSessionId ? { resumeSessionId } : { sessionId }),
          artifactDir: ctx.artifactDir,
          artifactPrefix: prefix,
          timeoutMs: config.agents.implementer.timeout_minutes * 60_000,
          env,
          readablePaths,
          signal: ctx.signal,
          ...(budget !== undefined ? { maxBudgetUsd: budget } : {}),
          ...(wantsReport ? { outputSchema: IMPLEMENTER_REPORT_SCHEMA } : {}),
        }),
      ),
  });
  ctx.throwIfStopped();
  const r = require(result, "implementer result");
  ctx.save({ costUsd: totalCost(ctx, r.costUsd) });
  const report = wantsReport ? parseImplementerReport(ctx.redactor.redactValue(r.structured)) : null;
  const summary = r.text || report?.summary || "";
  ctx.writeArtifact("agent-output", `implementer summary (round ${attempt})`, `${prefix}.summary.md`, `${summary || "(empty)"}${report ? `\n\n## Per finding\n${report.findings.map((f) => `- ${f.id}: ${f.status} — ${f.note}`).join("\n")}` : ""}`);
  if (!r.ok) throw new BlockedError(`implementer failed in round ${attempt}: ${r.error}`);

  // Verify, don't trust: what actually changed on disk?
  const message = ctx.redactor.redact(`${ctx.run.issueKey}: ${c.issue?.title ?? "changes"}\n\nRound ${attempt} (${trigger}) by ${agent.id}, committed by orchestrator run ${ctx.run.id}.`);
  let commitSha: string | null = null;
  if (await adapters.workspace.hasUncommittedChanges(worktree)) {
    const head = await adapters.workspace.headSha(worktree);
    commitSha = await ctx.effect({
      key: `git.commit.${attempt}`,
      permission: "local.worktree",
      description: `commit round ${attempt} changes in ${worktree}`,
      simulate: () => null,
      run: async () => {
        const sha = await adapters.workspace.commitAll(worktree, message);
        if (sha) {
          const files = await adapters.workspace.changedFiles(worktree, head);
          const bad = forbiddenFiles(files, config.forbidden_paths);
          if (bad.length) throw new ForbiddenPathError(`implementer touched forbidden paths (${bad.join(", ")}); commit ${sha.slice(0, 8)} left local for inspection`);
        }
        return sha;
      },
    });
  }
  const changedFiles = await adapters.workspace.changedFiles(worktree, baseSha);
  const headSha = await adapters.workspace.headSha(worktree);
  if (changedFiles.length === 0) throw new BlockedError(`implementer reported "${summary.slice(0, 120).replace(/\n/g, " ")}" but the worktree has no changes against ${baseSha.slice(0, 8)}`);
  const bad = forbiddenFiles(changedFiles, config.forbidden_paths);
  if (bad.length) throw new ForbiddenPathError(`branch contains forbidden paths: ${bad.join(", ")}`);
  assertNoSecrets(ctx, await adapters.workspace.diff(worktree, baseSha), `the diff after round ${attempt}`);
  const previousHead = c.rounds.at(-1)?.screenshots?.commitSha ?? c.rounds.at(-1)?.commitSha;
  if (trigger !== "initial" && !commitSha && headSha === previousHead) {
    if (trigger === "minor") {
      // Nothing to deliver but the approved commit, which stays approved.
      ctx.log("info", "minor.unchanged", `The implementer changed nothing for the minor findings (round ${attempt}); the approved commit is delivered`);
    } else if (trigger === "review" && declinedAll(report, requested)) {
      // Declining a finding with a reason is an answer, not a stall: the reviewer judges the reasons.
      ctx.log("warn", "review.declined", `The implementer declined every finding without code changes (round ${attempt}); the reviewer judges its reasons`);
    } else {
      throw new BlockedError(`implementer made no changes in response to ${trigger} feedback (round ${attempt})`);
    }
  }
  ctx.log("info", "verify.changes", `${changedFiles.length} file(s) changed vs base; HEAD ${headSha.slice(0, 8)}`, { files: changedFiles });

  return {
    round: {
      attempt,
      trigger,
      implementer: { sessionId: r.sessionId, ok: r.ok, error: r.error, costUsd: r.costUsd, durationMs: r.durationMs, summary: summary.slice(0, SUMMARY_LIMIT), ...(wantsReport ? { report } : {}) },
      commitSha: commitSha ?? headSha,
      changedFiles,
    },
    sessionId: r.sessionId,
    costUsd: r.costUsd,
  };
}

function dryRunStage(ctx: Ctx, state: RunState, next: RunState): Outcome<RunContext> {
  const stage = ctx.run.context.plan?.stages.find((s) => s.state === state);
  for (const a of stage?.actions ?? []) {
    ctx.log("info", "effect.simulated", `Would ${a.description.charAt(0).toLowerCase()}${a.description.slice(1)}${a.command ? ` — \`${a.command}\`` : ""}${a.allowedLive ? "" : ` [live: ${a.gate}]`}`, { action: a.id, permission: a.permission });
  }
  return { to: next, reason: "simulated (dry run)" };
}

function openQuestions(c: RunContext): string[] {
  return c.agentPlan?.open_questions ?? [];
}

// ---- baseline ----------------------------------------------------------------------

type BaselineResult = Omit<CheckResult, "outputTail">;

/** What the baseline runs: every check, plus the screenshot command (it must work before the agent starts). */
export function baselineChecks(config: Pick<RepoConfig, "checks" | "screenshots">): CheckConfig[] {
  return [...config.checks, ...(config.screenshots ? [screenshotCheck(config.screenshots)] : [])];
}

/**
 * A baseline counts as done only if every required check passed. Optional checks may be red.
 * Runs stored before this rule may hold a red baseline: that is never accepted either.
 */
export function baselineAccepted(baseline: BaselineResult[] | null | undefined, checks: CheckConfig[]): boolean {
  if (!baseline) return false;
  const byName = new Map(baseline.map((r) => [r.name, r]));
  return checks.every((k) => k.optional || byName.get(k.name)?.ok === true) && baseline.every((r) => r.ok || r.optional);
}

/**
 * Run the checks on the untouched base, or reuse an accepted (green) result. A red or dirty base
 * throws BlockedError and is never saved as the accepted baseline, so re-entering IMPLEMENTING
 * (after an approved resume) re-runs every check under fresh effect keys instead of trusting it.
 */
async function ensureGreenBaseline(ctx: Ctx, worktree: string): Promise<void> {
  const { config, adapters } = ctx;
  const c = ctx.run.context;
  const checks = baselineChecks(config);
  if (baselineAccepted(c.baseline, checks)) {
    ctx.log("info", "baseline.reused", `Baseline already green on ${c.baseSha?.slice(0, 8)}; not re-running`);
    return;
  }
  // An attempt that was interrupted (no outcome recorded) continues with its own completed checks;
  // an attempt that ended red is finished, so the next one starts from scratch under new keys.
  const last = c.baselineAttempts ?? 0;
  const attempt = last === 0 || c.baselineFailure?.attempt === last ? last + 1 : last;
  ctx.save({ baselineAttempts: attempt, baseline: null });
  let results: CheckResult[];
  try {
    results = await runChecks(ctx, {
      worktree,
      checks,
      keyPrefix: `baseline.${attempt}`,
      logPrefix: attempt === 1 ? "baseline" : `baseline-${attempt}`,
      defaultNetwork: config.isolation.checks_network,
      label: "baseline",
    });
  } catch (err) {
    // Only an interruption continues this attempt; any other end (error, block) closes it, so the
    // next entry re-runs every check instead of replaying a result from before the operator's fix.
    if (!(err instanceof StopError) && !ctx.signal.aborted) {
      ctx.save({ baselineFailure: { attempt, baseSha: c.baseSha ?? null, reason: `baseline did not finish: ${(err as Error).message}`, results: [] } });
    }
    throw err;
  }
  const recorded = results.map(({ outputTail: _t, ...rest }) => rest);
  const red = results.filter((r) => !r.ok && !r.optional);
  const fail = (reason: string): never => {
    ctx.save({ baseline: null, baselineFailure: { attempt, baseSha: c.baseSha ?? null, reason, results: recorded } });
    throw new BlockedError(reason);
  };
  if (red.length) {
    const shots = red.find((r) => r.name === SCREENSHOT_CHECK_NAME);
    fail(
      `base ${c.baseSha?.slice(0, 8)} is red before any change: ${red.map((r) => r.name).join(", ")} (see ${red[0]!.logPath}). ` +
        (shots ? `Screenshots cannot be generated in this environment (\`${shots.command}\` failed on the untouched base; see ${shots.logPath}). ` : "") +
        "Fix the environment or the check configuration and resume (the baseline runs again), or fix the base branch and start a new run.",
    );
  }
  if (results.length !== checks.length) fail(`baseline incomplete: ${results.length} of ${checks.length} checks ran`);
  // Screenshots the base itself renders (e.g. once earlier screenshot PRs are merged) are expected
  // output of the baseline screenshot run, not a dirty worktree: put them back as they were.
  const cfg = config.screenshots;
  if (cfg) await adapters.workspace.discardPaths(worktree, (await adapters.workspace.uncommittedPaths(worktree)).filter((p) => matchesOutputs(p, cfg)));
  if (await adapters.workspace.hasUncommittedChanges(worktree)) fail("baseline checks modified the worktree; the check configuration must not write tracked files");
  ctx.save({ baseline: recorded, baselineFailure: null });
}

// ---- IMPLEMENTING ------------------------------------------------------------------

const implementing: Handler<RunContext> = async (ctx) => {
  if (ctx.dryRun) return dryRunStage(ctx, "IMPLEMENTING", "TESTING");
  const { config, adapters } = ctx;
  const c = ctx.run.context;
  const clonePath = require(c.clonePath, "clonePath");
  const worktree = require(c.worktreePath, "worktreePath");
  const branch = require(c.branch, "branch");

  if (!config.local_path) await adapters.workspace.ensureClone(config.repo, clonePath, { fetch: true });
  const wt = await ctx.effect({
    key: "git.worktree",
    permission: "local.worktree",
    description: `create worktree ${worktree} on ${branch} from origin/${c.baseBranch}`,
    simulate: () => ({ created: false, headSha: c.baseSha ?? "" }),
    run: () => adapters.workspace.createWorktree({ repoPath: clonePath, worktreePath: worktree, branch, baseRef: c.baseSha ?? `origin/${c.baseBranch}` }),
  });
  ctx.log("info", "worktree.ready", `${wt?.created ? "Created" : "Reusing"} worktree at ${worktree} (${wt?.headSha.slice(0, 8)})`);

  // Setup is repository code (install scripts): sandboxed, scrubbed env, tripwired.
  const setup = await runChecks(ctx, { worktree, checks: config.setup, keyPrefix: "setup", logPrefix: "setup", defaultNetwork: config.isolation.setup_network, label: "setup" });
  const failedSetup = setup.find((r) => !r.ok && !r.optional);
  if (failedSetup) throw new BlockedError(`setup "${failedSetup.name}" failed (exit ${failedSetup.exitCode}); see ${failedSetup.logPath}`);

  // Baseline: the agent should not chase failures that already exist on the base branch.
  if (config.baseline_checks) await ensureGreenBaseline(ctx, worktree);

  const prompt = implementerPrompt({
    issue: require(c.issue, "issue"),
    criteria: runCriteria(c),
    plan: c.agentPlan ?? null,
    checks: config.checks.map((k) => k.run),
    guidanceFiles: c.plan?.repository.guidanceFiles ?? [],
    brief: c.brief?.body ?? null,
    openQuestions: openQuestions(c),
    screenshots: screenshotBrief(config),
  });
  const { round, sessionId } = await implementerRound(ctx, 0, "initial", prompt);
  return { to: "TESTING", patch: { rounds: [...c.rounds, round], implementerSessionId: sessionId } };
};

// ---- screenshots -------------------------------------------------------------------

function screenshotBrief(config: RepoConfig): ScreenshotBrief | null {
  const s = config.screenshots;
  return s ? { run: s.run, outputs: s.outputs, whenChanged: s.when_changed } : null;
}

type ScreenshotOutcome =
  | { kind: "skipped" }
  | { kind: "ok"; record: NonNullable<Round["screenshots"]> }
  | { kind: "problem"; reason: string; result?: CheckResult; commitSha?: string | null };

/**
 * Generate screenshots from the checked commit and commit exactly the validated bytes.
 *
 * - The command runs in the check sandbox with no network except localhost, and home-directory
 *   contents unreadable apart from the toolchain and caches: its output is published.
 * - Each matching file is read once into memory; that buffer is validated (plain PNG), scanned for
 *   secrets (raw and decompressed) and committed as-is, so nothing can swap it on disk in between.
 * - Anything else the command left behind, and any image under `outputs` it did not produce in this
 *   run (hand-made, or stale from an earlier round), is a problem the implementer must fix; the
 *   step's leftovers are discarded so no unreviewed file reaches a later commit.
 * The baseline has already shown that the environment can run the command (when baseline checks are on).
 */
async function takeScreenshots(ctx: Ctx, worktree: string, commit: string): Promise<ScreenshotOutcome> {
  const { config, adapters, run } = ctx;
  const cfg = config.screenshots;
  if (!cfg) return { kind: "skipped" };
  const baseSha = require(run.context.baseSha, "baseSha");
  const branchFiles = await adapters.workspace.changedFiles(worktree, baseSha);
  if (!screenshotsRequired(cfg, branchFiles)) {
    ctx.log("info", "screenshots.skipped", `No screenshots: the change touches none of ${[...cfg.when_changed, ...cfg.outputs].join(", ")}`);
    return { kind: "skipped" };
  }
  const check = screenshotCheck(cfg);
  const { env, readablePaths } = await agentRunEnv(ctx);
  const sandbox = checkSandbox(ctx, worktree, "none", readablePaths);
  const out = await ctx.effect({
    // The config is part of the key: a resume after the operator changed it runs the command again.
    key: `screenshots.${run.attempt}.${commit}.${createHash("sha256").update(JSON.stringify([cfg.run, cfg.outputs])).digest("hex").slice(0, 12)}${recheckSuffix(run.context)}`,
    permission: "local.checks",
    description: `generate screenshots: ${cfg.run}`,
    simulate: () => null,
    run: () =>
      guarded(ctx, "screenshots", async () => {
        // Recorded with the result, so a resumed run judges leftovers against the same starting point.
        const dirtyBefore = await adapters.workspace.uncommittedPaths(worktree);
        const stamps = outputStamps(worktree, cfg);
        const result = await adapters.checks.run({
          name: check.name,
          command: check.run,
          cwd: worktree,
          env,
          timeoutMs: check.timeout_minutes * 60_000,
          optional: false,
          logPath: join(ctx.artifactDir, `screenshots-${run.attempt}.log`),
          signal: ctx.signal,
          sandbox,
        });
        return { result, dirtyBefore, ...(result.ok ? collectScreenshots(worktree, cfg, stamps) : { files: [], problems: [] }) };
      }),
  });
  ctx.throwIfStopped();
  const { result, files, problems, dirtyBefore } = require(out, "screenshot result");
  const before = new Set(dirtyBefore ?? []);
  const leftovers = async () => (await adapters.workspace.uncommittedPaths(worktree)).filter((p) => !before.has(p));
  const problem = async (reason: string, commitSha?: string | null): Promise<ScreenshotOutcome> => {
    await adapters.workspace.discardPaths(worktree, await leftovers());
    return { kind: "problem", reason, result, ...(commitSha !== undefined ? { commitSha } : {}) };
  };
  ctx.log(result.ok ? "info" : "warn", "check.result", `${result.ok ? "✓" : "✗"} screenshots (${Math.round(result.durationMs / 1000)}s)${result.ok ? `: ${files.length} file(s)` : ` exit ${result.exitCode}${result.timedOut ? " (timeout)" : ""}`}`);
  if (!result.ok) return problem(`the command failed (exit ${result.exitCode ?? "timeout"})`);
  if (problems.length) return problem(`unusable screenshot files: ${problems.join("; ")}`);
  if (files.length === 0) return problem(`the command succeeded but wrote no image matching ${cfg.outputs.join(", ")}`);
  const forbidden = forbiddenFiles(files.map((f) => ({ status: "A", path: f.path })), config.forbidden_paths);
  if (forbidden.length) throw new BlockedError(`screenshot outputs match forbidden_paths (${forbidden.join(", ")}); fix screenshots.outputs`);

  const produced = new Set(files.map((f) => f.path));
  const notProduced = branchFiles.filter((f) => f.status !== "D" && matchesOutputs(f.path, cfg) && !produced.has(f.path)).map((f) => f.path);
  if (notProduced.length) return problem(`images under screenshots.outputs that this run of the command did not produce (hand-made or stale; delete them or make the command regenerate them): ${notProduced.join(", ")}`);
  const stray = (await leftovers()).filter((p) => !produced.has(p));
  if (stray.length) return problem(`the command also changed files outside screenshots.outputs (${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ", …" : ""}); it may only write screenshots and ignored build output`);

  // Read once; validate, scan and commit this exact buffer.
  const blobs: Array<{ path: string; data: Buffer }> = [];
  for (const f of files) {
    const data = readFileSync(join(worktree, f.path));
    if (createHash("sha256").update(data).digest("hex") !== f.sha256) return problem(`${f.path} changed after it was validated`);
    const bad = pngProblem(data);
    if (bad) return problem(`unusable screenshot files: ${f.path} ${bad}`);
    // Images are binary, so the diff scan before push only sees "Binary files differ": scan the raw
    // bytes and the decompressed pixel data for known secret values and token shapes here.
    assertNoSecrets(ctx, data.toString("latin1"), `screenshot ${f.path}`);
    assertNoSecrets(ctx, pngPixels(data).toString("latin1"), `screenshot ${f.path} (image data)`);
    blobs.push({ path: f.path, data });
  }

  const message = ctx.redactor.redact(`${run.issueKey}: screenshots\n\nGenerated by orchestrator run ${run.id} from ${commit.slice(0, 12)} with: ${cfg.run}`);
  const commitSha = await ctx.effect({
    key: `git.commit.screenshots.${run.attempt}.${commit}${recheckSuffix(run.context)}`,
    permission: "local.worktree",
    description: `commit ${files.length} screenshot(s) in ${worktree}`,
    simulate: () => null,
    run: async () => {
      try {
        return await adapters.workspace.commitBlobs(worktree, blobs, message);
      } catch (err) {
        await adapters.workspace.discardPaths(worktree, await leftovers());
        throw new BlockedError(`could not commit the screenshots (${(err as Error).message.split("\n")[0]})`);
      }
    },
  });
  // The worktree must now match what was committed: restore it if anything differs.
  const after = await leftovers();
  if (after.length) return problem(`files changed after the screenshots were validated: ${after.slice(0, 5).join(", ")}`, commitSha ?? null);

  // The reviewer gets copies of the committed bytes, outside anything repository code can write.
  const copyDir = join(ctx.artifactDir, `screenshots-${run.attempt}`);
  for (const b of blobs) {
    mkdirSync(dirname(join(copyDir, b.path)), { recursive: true });
    writeFileSync(join(copyDir, b.path), b.data);
  }
  ctx.log("info", "screenshots.result", `${files.length} screenshot(s) ${commitSha ? `committed as ${commitSha.slice(0, 8)}` : "unchanged since the last commit"}: ${files.map((f) => f.path).join(", ")}`);
  return { kind: "ok", record: { command: cfg.run, files, commitSha: commitSha ?? null, copyDir } };
}

// ---- TESTING -----------------------------------------------------------------------

const testing: Handler<RunContext> = async (ctx) => {
  if (ctx.dryRun) return dryRunStage(ctx, "TESTING", "REVIEWING");
  const { config, adapters, run } = ctx;
  const c = run.context;
  const worktree = require(c.worktreePath, "worktreePath");
  const commit = c.rounds.at(-1)?.commitSha ?? "head";
  const results = await runChecks(ctx, {
    worktree,
    checks: config.checks,
    keyPrefix: `check.${run.attempt}.${commit}${recheckSuffix(c)}`,
    logPrefix: `check-${run.attempt}`,
    defaultNetwork: config.isolation.checks_network,
    label: "check",
  });
  // The checks must not have changed tracked files (e.g. a formatter rewriting code).
  if (await adapters.workspace.hasUncommittedChanges(worktree)) {
    ctx.log("warn", "check.dirty", "checks modified the worktree; those changes are not part of the reviewed commit");
  }

  const rounds = [...c.rounds];
  const last = rounds.at(-1);
  if (last) last.checks = results.map(({ outputTail: _t, ...rest }) => rest);
  const failed = results.filter((r) => !r.ok && !r.optional);
  const max = config.merge.max_fix_attempts;
  const used = correctionsUsed(run);
  let problem: string | null = failed.length ? `${failed.length} check(s) failed: ${failed.map((f) => f.name).join(", ")}` : null;
  let shots: ScreenshotOutcome | null = null;
  if (!problem) {
    shots = await takeScreenshots(ctx, worktree, commit);
    if (shots.kind === "ok" && last) last.screenshots = shots.record;
    if (shots.kind !== "problem") return { to: "REVIEWING", patch: { rounds, lastChecks: results } };
    // A screenshot commit made before the problem still moved HEAD: the next round compares against it.
    if (shots.commitSha && last) last.screenshots = { command: config.screenshots!.run, files: [], commitSha: shots.commitSha };
    ctx.log("warn", "screenshots.result", `✗ screenshots: ${shots.reason}`);
    problem = `screenshots: ${shots.reason}`;
  }

  // The minor-finding round may only improve delivery: when its result fails, restore the approved commit.
  const minor = c.minorRound;
  if (minor?.status === "running") {
    ctx.log("warn", "minor.rejected", `The minor-finding round failed (${problem}); restoring the approved commit ${minor.approvedSha.slice(0, 8)}`);
    return {
      to: "FIXING",
      reason: `minor-finding round failed (${problem}); restoring the approved commit ${minor.approvedSha.slice(0, 8)}`,
      patch: { rounds, lastChecks: results, minorRound: { ...minor, status: "rejected", reason: problem }, feedback: { trigger: "revert", prompt: problem } },
    };
  }
  if (minor?.status === "reverted" && last?.trigger === "revert") {
    // That exact commit passed these checks before the minor-finding round: something outside it changed.
    return {
      to: "BLOCKED",
      reason: `the approved commit ${minor.approvedSha.slice(0, 8)}, restored after the minor-finding round, no longer passes (${problem}); it passed the same checks before, so a check is flaky or the environment changed. Inspect the logs, then resume (the checks run again)`,
      patch: { rounds, lastChecks: results, recheck: (c.recheck ?? 0) + 1 },
    };
  }

  if (shots?.kind === "problem") {
    if (used >= max) return { to: "FAILED", reason: `screenshots still missing after ${max} correction round(s): ${shots.reason}`, patch: { rounds, lastChecks: results } };
    return {
      to: "FIXING",
      reason: problem,
      patch: { rounds, lastChecks: results, feedback: { trigger: "checks", prompt: fixPromptForScreenshots({ reason: shots.reason, result: shots.result ?? null, brief: screenshotBrief(config)! }, used + 1, max) } },
    };
  }
  if (used >= max) {
    return { to: "FAILED", reason: `checks still failing after ${max} correction round(s): ${failed.map((f) => f.name).join(", ")}`, patch: { rounds, lastChecks: results } };
  }
  return {
    to: "FIXING",
    reason: problem,
    patch: { rounds, lastChecks: results, feedback: { trigger: "checks", prompt: fixPromptForChecks(failed, used + 1, max) } },
  };
};

// ---- REVIEWING ---------------------------------------------------------------------

/**
 * A minor-finding round may only improve delivery. A block while reviewing its result (a limit, a
 * reviewer failure, unusable output) restores the approved commit instead of stopping the run.
 * Safety stops (secrets, tripwires: FailedError) still end the run.
 */
const reviewing: Handler<RunContext> = async (ctx) => {
  try {
    return await reviewStep(ctx);
  } catch (err) {
    const minor = ctx.run.context.minorRound;
    if (minor?.status !== "running" || !(err instanceof BlockedError) || err instanceof ForbiddenPathError) throw err;
    const why = `review could not complete: ${err.message}`;
    ctx.log("warn", "minor.rejected", `The minor-finding round's review did not complete (${err.message}); restoring the approved commit ${minor.approvedSha.slice(0, 8)}`);
    return { to: "FIXING", reason: `minor-finding round not reviewed; restoring the approved commit ${minor.approvedSha.slice(0, 8)}`, patch: { minorRound: { ...minor, status: "rejected", reason: why }, feedback: { trigger: "revert", prompt: why } } };
  }
};

const reviewStep: Handler<RunContext> = async (ctx) => {
  if (ctx.dryRun) return dryRunStage(ctx, "REVIEWING", "PR_OPEN");
  const { config, adapters, run } = ctx;
  const c = run.context;
  const worktree = require(c.worktreePath, "worktreePath");
  const baseSha = require(c.baseSha, "baseSha");
  const headSha = await adapters.workspace.headSha(worktree);
  // The reviewer reads the worktree: it must be exactly the commit being approved. (Otherwise the
  // check after the review would fail anyway, blaming the reviewer for what a check or a background
  // process wrote.)
  const dirty = await adapters.workspace.uncommittedPaths(worktree);
  if (dirty.length) {
    return { to: "FAILED", reason: `the worktree has uncommitted changes before review (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}), written by a check or a background process; the reviewer would not see the committed code` };
  }
  const criteria = runCriteria(c);
  const blockingSeverities = config.review.blocking_severities;
  const minor = c.minorRound ?? null;
  const rounds = [...c.rounds];
  const last = rounds.at(-1);

  // The approved commit is the head again (the minor findings were declined without changes, or the
  // failed attempt was undone and the commit re-checked): the same tree keeps its independent approval,
  // unless the review of the discarded attempt raised blocking findings, which may apply to it too.
  const mustRereview = minor?.status === "reverted" && Boolean(minor.rejectedFindings?.length);
  if (minor && (minor.status === "running" || minor.status === "reverted") && headSha === minor.approvedSha && !mustRereview) {
    const decision = decideReview(minor.approvedReview, blockingSeverities, criteria);
    if (!decision.approved) throw new FailedError(`internal: the stored approval of ${headSha.slice(0, 8)} does not decide as approved`);
    const status = minor.status === "running" ? "declined" : "reverted";
    ctx.log(
      "info",
      "review.reused",
      `${headSha.slice(0, 8)} is the commit the reviewer approved in round ${minor.approvedAttempt}${status === "declined" ? " (the minor findings were declined without code changes)" : ", restored and re-checked after the minor-finding round failed"}; its approval stands`,
    );
    if (last) last.review = reviewRecord(minor.approvedReview, decision, headSha, null, true);
    return {
      to: "PR_OPEN",
      patch: { rounds, lastReview: minor.approvedReview, reviewedSha: headSha, reviewApproved: true, unresolvedBlocking: 0, minorRound: { ...minor, status } },
    };
  }

  const reviewer = provider(ctx, config.agents.reviewer);
  const env = await runEnv(ctx, config.agents.reviewer);
  enforceLimits(ctx, `review round ${run.attempt}`, config.agents.reviewer.adapter === "claude-code");
  const prefix = `review-${run.attempt}`;

  // What the previous round asked for, and the implementer's answer, for the reviewer to verify.
  const rereview = mustRereview && headSha === minor?.approvedSha;
  const previous = minor?.status === "running" ? minor.findings : rereview ? minor!.rejectedFindings! : c.lastReview ? decideReview(c.lastReview, blockingSeverities).blocking : [];
  const shots = last?.screenshots ?? null;
  const prompt = reviewerPrompt({
    issue: require(c.issue, "issue"),
    criteria,
    baseSha,
    headSha,
    checks: c.lastChecks ?? [],
    previous,
    dispositions: rereview ? null : (last?.implementer?.report ?? null),
    ...(rereview
      ? {
          previousNote:
            "Blocking findings raised on a later attempt that was discarded (this commit is the earlier, approved one). Check whether each also applies to this commit; report it again if it does",
        }
      : {}),
    brief: c.brief?.body ?? null,
    screenshots: shots ? { command: shots.command, files: shots.files.map((f) => f.path), commitSha: shots.commitSha } : null,
  });
  ctx.writeArtifact("prompt", `review prompt (round ${run.attempt})`, `${prefix}.prompt.md`, prompt);

  const result = await ctx.effect({
    // Per round: a round that answered findings without changing code is reviewed again, with its answers.
    key: `agent.review.${run.attempt}.${headSha}`,
    permission: "agents.run",
    description: `run independent reviewer ${reviewer.id} on ${headSha.slice(0, 8)}`,
    simulate: () => SIMULATED_AGENT,
    run: () =>
      guarded(ctx, `review round ${run.attempt}`, () =>
        reviewer.run({
          role: "reviewer",
          cwd: worktree,
          prompt,
          outputSchema: REVIEW_OUTPUT_SCHEMA,
          artifactDir: ctx.artifactDir,
          artifactPrefix: prefix,
          timeoutMs: config.agents.reviewer.timeout_minutes * 60_000,
          env,
          signal: ctx.signal,
          ...(shots?.files.length && shots.copyDir ? { images: shots.files.map((f) => join(shots.copyDir!, f.path)) } : {}),
        }),
      ),
  });
  ctx.throwIfStopped();
  const r = require(result, "review result");
  if (r.costUsd) ctx.save({ costUsd: totalCost(ctx, r.costUsd) });
  if (!r.ok) throw new BlockedError(`reviewer failed: ${r.error}`);

  // The reviewer must not have changed what it reviewed.
  const after = await adapters.workspace.headSha(worktree);
  if (after !== headSha || (await adapters.workspace.hasUncommittedChanges(worktree))) {
    return { to: "FAILED", reason: "the worktree changed during review; the reviewer is not allowed to modify code" };
  }

  let outcome: ReviewOutcome;
  try {
    // Reviewer output can end up in a public PR: redact it first.
    outcome = parseReview(ctx.redactor.redactValue(r.structured));
  } catch (err) {
    throw new BlockedError(`reviewer output was not a valid review (${(err as Error).message}); see ${r.transcripts.join(", ")}`);
  }
  const decision = decideReview(outcome, blockingSeverities, criteria);
  ctx.writeArtifact("review", `review (round ${run.attempt})`, `${prefix}.json`, JSON.stringify({ outcome, decision, reviewedSha: headSha }, null, 2));
  ctx.log(
    decision.approved ? "info" : "warn",
    "review.result",
    `${reviewer.id}: ${outcome.verdict}, ${outcome.findings.length} finding(s), ${decision.blocking.length} blocking` +
      (criteria.length ? `; criteria ${criteria.length - decision.unmetCriteria.length - decision.needsHuman.length} met, ${decision.unmetCriteria.length} not met, ${decision.needsHuman.length} need a person` : ""),
  );
  if (decision.needsHuman.length) {
    ctx.log("warn", "criteria.needs_human", `Acceptance criteria needing your judgement: ${decision.needsHuman.map((x) => `${x.id} (${x.text.slice(0, 80)})`).join("; ")}`);
  }

  if (last) last.review = reviewRecord(outcome, decision, headSha, r.sessionId, false);
  const patch: Partial<RunContext> = {
    rounds,
    lastReview: outcome,
    reviewedSha: headSha,
    reviewApproved: decision.approved,
    unresolvedBlocking: decision.blocking.length + decision.unmetCriteria.length,
  };

  // The minor-finding round's result: delivered if approved, otherwise the approved commit comes back.
  if (minor?.status === "running") {
    if (decision.approved) {
      ctx.log("info", "minor.applied", `The minor-finding round was approved on ${headSha.slice(0, 8)}; it is delivered`);
      return { to: "PR_OPEN", patch: { ...patch, minorRound: { ...minor, status: "applied" } } };
    }
    const why = `review: ${decision.reasons.join("; ")}`;
    ctx.log("warn", "minor.rejected", `The minor-finding round was not approved (${why}); restoring the approved commit ${minor.approvedSha.slice(0, 8)}`);
    return {
      to: "FIXING",
      reason: `minor-finding round not approved (${decision.reasons.join("; ")}); restoring the approved commit ${minor.approvedSha.slice(0, 8)}`,
      patch: { ...patch, minorRound: { ...minor, status: "rejected", reason: why, rejectedFindings: decision.blocking }, feedback: { trigger: "revert", prompt: why } },
    };
  }

  if (decision.approved) {
    const minorFindings = minorRoundFindings(ctx, decision);
    if (minorFindings.length) {
      return {
        to: "FIXING",
        reason: `approved; ${minorFindings.length} actionable minor finding(s) get one bounded correction round: ${minorFindings.map((f) => f.id).join(", ")}`,
        patch: {
          ...patch,
          minorRound: { status: "running", approvedSha: headSha, approvedReview: outcome, approvedAttempt: run.attempt, findings: minorFindings },
          feedback: { trigger: "minor", prompt: fixPromptForMinorFindings(outcome, minorFindings, headSha), requested: minorFindings.map((f) => f.id) },
        },
      };
    }
    return { to: "PR_OPEN", patch };
  }

  const max = config.merge.max_fix_attempts;
  const used = correctionsUsed(run);
  if (used >= max) return { to: "FAILED", reason: `review not approved after ${max} correction round(s): ${decision.reasons.join("; ")}`, patch };
  return {
    to: "FIXING",
    reason: decision.reasons.join("; "),
    patch: {
      ...patch,
      feedback: {
        trigger: "review",
        prompt: fixPromptForReview(outcome, decision.blocking, used + 1, max, decision.unmetCriteria),
        requested: [...decision.blocking.map((f) => f.id), ...decision.unmetCriteria.map((x) => x.id)],
      },
    },
  };
};

function reviewRecord(outcome: ReviewOutcome, decision: ReviewDecision, sha: string, sessionId: string | null, reused: boolean): NonNullable<Round["review"]> {
  return {
    verdict: outcome.verdict,
    summary: outcome.summary,
    findings: outcome.findings,
    approved: decision.approved,
    blocking: decision.blocking.length,
    reviewedSha: sha,
    sessionId,
    criteria: decision.criteria,
    ...(reused ? { reused: true } : {}),
  };
}

/**
 * Minor findings worth one more round: actionable, non-blocking `minor` (never nits), at most once
 * per run, and only when the budget can pay for it. Skipping never blocks delivery.
 */
function minorRoundFindings(ctx: Ctx, decision: ReviewDecision): Finding[] {
  const c = ctx.run.context;
  if (ctx.config.review.minor_fix_rounds < 1 || c.minorRound || decision.actionableMinor.length === 0) return [];
  try {
    enforceLimits(ctx, "the minor-finding round");
  } catch (err) {
    if (!(err instanceof BlockedError)) throw err;
    ctx.log("info", "minor.skipped", `Minor findings left open: ${err.message}`);
    return [];
  }
  return decision.actionableMinor;
}

// ---- FIXING ------------------------------------------------------------------------

const fixing: Handler<RunContext> = async (ctx) => {
  const c = ctx.run.context;
  const feedback = require(c.feedback, "feedback");
  const attempt = ctx.run.attempt + 1;
  if (feedback.trigger === "revert") return restoreApprovedCommit(ctx, attempt, feedback.prompt);
  let done: Awaited<ReturnType<typeof implementerRound>>;
  try {
    done = await implementerRound(ctx, attempt, feedback.trigger, feedback.prompt, feedback.requested ?? []);
  } catch (err) {
    // The minor-finding round may only improve delivery: an implementer failure or a spent limit
    // restores the approved commit. Forbidden paths, secrets and tripwires still stop the run.
    const minor = c.minorRound;
    if (feedback.trigger !== "minor" || minor?.status !== "running" || !(err instanceof BlockedError) || err instanceof ForbiddenPathError) throw err;
    const why = `implementer round did not complete: ${err.message}`;
    ctx.log("warn", "minor.rejected", `The minor-finding round did not complete (${err.message}); restoring the approved commit ${minor.approvedSha.slice(0, 8)}`);
    ctx.save({ minorRound: { ...minor, status: "rejected", reason: why } });
    return restoreApprovedCommit(ctx, attempt, why);
  }
  const { round, sessionId } = done;
  return {
    to: "TESTING",
    attempt,
    patch: { rounds: [...ctx.run.context.rounds, round], implementerSessionId: sessionId ?? c.implementerSessionId ?? null, feedback: null, reviewApproved: false },
  };
};

/**
 * The minor-finding round failed: put the worktree back at the approved commit (an ancestor of HEAD,
 * never pushed past), then TESTING re-checks it before its approval is reused.
 */
async function restoreApprovedCommit(ctx: Ctx, attempt: number, why: string): Promise<Outcome<RunContext>> {
  const { adapters } = ctx;
  const c = ctx.run.context;
  const minor = require(c.minorRound, "minorRound");
  const worktree = require(c.worktreePath, "worktreePath");
  const sha = minor.approvedSha;
  await ctx.effect({
    key: `git.restore.${attempt}.${sha}`,
    permission: "local.worktree",
    description: `restore the approved commit ${sha.slice(0, 8)} in ${worktree}`,
    simulate: () => null,
    run: async () => {
      await adapters.workspace.resetTo(worktree, sha);
      return { sha };
    },
  });
  const head = await adapters.workspace.headSha(worktree);
  if (head !== sha || (await adapters.workspace.hasUncommittedChanges(worktree))) {
    throw new BlockedError(`could not restore the approved commit ${sha.slice(0, 8)} (HEAD is ${head.slice(0, 8)}); inspect ${worktree}`);
  }
  const changedFiles = await adapters.workspace.changedFiles(worktree, require(c.baseSha, "baseSha"));
  ctx.log("info", "minor.restored", `Restored the approved commit ${sha.slice(0, 8)} (${why}); re-checking it before delivery`);
  return {
    to: "TESTING",
    attempt,
    patch: {
      rounds: [...c.rounds, { attempt, trigger: "revert", commitSha: sha, changedFiles }],
      feedback: null,
      reviewApproved: false,
      minorRound: { ...minor, status: "reverted" },
    },
  };
}

// ---- PR_OPEN -----------------------------------------------------------------------

/** The PR description for the run's current state: reviewed commit, verdicts, screenshots and CI. */
function buildPrBody(ctx: Ctx, ci: PrCiStatus | null): string {
  const { config, run } = ctx;
  const c = run.context;
  const reviewedSha = require(c.reviewedSha, "reviewedSha");
  const last = c.rounds.at(-1);
  // Each reviewed round, with the implementer's answer from the round that followed it.
  const reviewHistory: PrReviewRound[] = c.rounds.flatMap((r, i) =>
    r.review && !r.review.reused
      ? [{ attempt: r.attempt, trigger: r.trigger, verdict: r.review.verdict, approved: r.review.approved, reviewedSha: r.review.reviewedSha, findings: r.review.findings, response: c.rounds[i + 1]?.implementer?.report ?? null }]
      : [],
  );
  const minor = c.minorRound;
  const render = (history: PrReviewRound[]) =>
    ctx.redactor.redact(
      pullRequestBody({
      issue: require(c.issue, "issue"),
      criteria: criteriaReport(c.lastReview ?? null, runCriteria(c)),
      runId: run.id,
      changedFiles: last?.changedFiles ?? [],
      checks: c.lastChecks ?? [],
      review: c.lastReview ?? null,
      reviewHistory: history,
      minorRound: minor
        ? {
            status: minor.status,
            approvedSha: minor.approvedSha,
            findings: minor.findings,
            response: c.rounds.find((r) => r.trigger === "minor")?.implementer?.report ?? null,
            reason: minor.reason ?? null,
            ...(minor.rejectedFindings?.length ? { rejectedFindings: minor.rejectedFindings } : {}),
          }
        : null,
      ci,
      attempts: correctionsUsed(run),
      implementer: config.agents.implementer.adapter,
      reviewer: config.agents.reviewer.adapter,
      reviewedSha,
      openQuestions: openQuestions(c),
      briefSource: c.brief?.source.split("/").slice(-4).join("/") ?? null,
      screenshots: (last?.screenshots?.files ?? []).map((f) => ({ path: f.path, url: `https://github.com/${config.repo}/blob/${reviewedSha}/${f.path.split("/").map(encodeURIComponent).join("/")}?raw=true` })),
      markReadyWhenDelivered: config.pull_request.mark_ready_when_delivered,
      }),
    );
  // GitHub refuses descriptions over 65,536 characters: drop the review history first, then cut.
  const full = render(reviewHistory);
  if (full.length <= PR_BODY_LIMIT) return full;
  const short = render([]);
  return short.length <= PR_BODY_LIMIT ? short : `${short.slice(0, PR_BODY_LIMIT - 200)}\n\n_(Truncated: the full record is in \`orchestrator review ${run.id}\`.)_`;
}

const PR_BODY_LIMIT = 60_000;

/** GitHub may change line endings or trailing whitespace: compare descriptions in this form. */
function bodyHash(body: string): string {
  return createHash("sha256").update(body.replace(/\r\n/g, "\n").trimEnd()).digest("hex").slice(0, 16);
}

/** The PR is this run's own: it opened it, or (after a crash before that was recorded) its body has the run's marker. */
function prIsRuns(c: RunContext, pr: PullRequestStatus, runId: string): boolean {
  return Boolean(c.prCreatedByRun) || prOwnedByRun(pr.body, runId);
}

/**
 * The description is still exactly what the engine last wrote. A person's edit, even one that
 * keeps the marker, makes it theirs: the engine stops rewriting it.
 */
function bodyIsEngines(c: RunContext, pr: PullRequestStatus, runId: string): boolean {
  if (!prIsRuns(c, pr, runId) || pr.body === undefined) return false;
  return c.prBodySha ? bodyHash(pr.body) === c.prBodySha : prOwnedByRun(pr.body, runId);
}

/**
 * Keep the description of the run's own PR in step with the reviewed commit and CI. Only a PR whose
 * body carries this run's marker is edited (never one a person opened on the branch); an unchanged
 * description is not sent again. Under the existing github.create_pr permission.
 */
async function syncPrBody(ctx: Ctx, pr: PullRequestStatus, ci: PrCiStatus | null, why: string): Promise<void> {
  const { config, adapters, run } = ctx;
  const body = buildPrBody(ctx, ci);
  const hash = bodyHash(body);
  if (run.context.prBodySha === hash) return;
  if (!bodyIsEngines(run.context, pr, run.id)) {
    ctx.log("warn", "pr.body_not_owned", `Not updating the description of PR #${pr.number}: it is not the description run ${run.id} last wrote (a person edited it, or the run did not open this PR)`);
    return;
  }
  assertNoSecrets(ctx, body, "the PR description");
  try {
    await ctx.effect({
      key: `github.pr.body.${pr.number}.${hash}`,
      permission: "github.create_pr",
      description: `update the description of PR #${pr.number} (${why})`,
      simulate: () => null,
      run: async () => {
        await adapters.codeHost.updatePullRequestBody({ repo: config.repo, number: pr.number, body });
        return { hash };
      },
    });
  } catch (err) {
    // A stale description is not worth stopping delivery for; it is retried at the next sync.
    if (err instanceof FailedError || err instanceof StopError || ctx.signal.aborted) throw err;
    ctx.log("warn", "pr.body_update_failed", `Could not update the description of PR #${pr.number} (non-fatal, retried at the next step): ${(err as Error).message}`);
    return;
  }
  ctx.save({ prBodySha: hash });
}

const prOpen: Handler<RunContext> = async (ctx) => {
  if (ctx.dryRun) return dryRunStage(ctx, "PR_OPEN", "WAITING_FOR_CI");
  const { config, adapters, run } = ctx;
  const c = run.context;
  const worktree = require(c.worktreePath, "worktreePath");
  const branch = require(c.branch, "branch");
  const reviewedSha = require(c.reviewedSha, "reviewedSha");
  const issue = require(c.issue, "issue");
  const baseSha = require(c.baseSha, "baseSha");

  if (!c.reviewApproved) throw new BlockedError("refusing to publish: no independent approval recorded");
  const head = await adapters.workspace.headSha(worktree);
  if (head !== reviewedSha) return { to: "FAILED", reason: `worktree HEAD ${head.slice(0, 8)} is not the reviewed commit ${reviewedSha.slice(0, 8)}` };

  const body = buildPrBody(ctx, null);
  // Last line of defence before anything leaves the machine.
  assertNoSecrets(ctx, `${await adapters.workspace.diff(worktree, baseSha)}\n${body}`, "the change or PR description");

  await ctx.effect({
    key: `git.push.${reviewedSha}`,
    permission: "github.push",
    description: `push ${branch} (${reviewedSha.slice(0, 8)}) to origin`,
    simulate: () => null,
    run: async () => {
      await adapters.workspace.push(worktree, branch);
      return { sha: reviewedSha };
    },
  });
  const pushed = (c.pushed ?? []).includes(reviewedSha) ? (c.pushed ?? []) : [...(c.pushed ?? []), reviewedSha];
  ctx.save({ pushed });

  let created = false;
  const pr = await ctx.effect<PullRequestStatus>({
    key: "github.pr",
    permission: "github.create_pr",
    description: `open ${config.pull_request.draft ? "draft " : ""}PR ${branch} → ${c.baseBranch}`,
    simulate: () => null as unknown as PullRequestStatus, // unreachable: dry runs return before this stage
    run: async () => {
      // Idempotent: a PR from an earlier attempt (or crash) is reused.
      const existing = await adapters.codeHost.findPullRequest(config.repo, branch);
      if (existing && existing.state === "OPEN") return existing;
      if (existing) throw new BlockedError(`PR #${existing.number} for ${branch} is ${existing.state.toLowerCase()}; refusing to open another`);
      const opened = await adapters.codeHost.createPullRequest({
        repo: config.repo,
        base: require(c.baseBranch, "baseBranch"),
        head: branch,
        title: ctx.redactor.redact(`${issue.key}: ${issue.title}`),
        body,
        draft: config.pull_request.draft,
        labels: config.pull_request.labels,
      });
      created = true;
      return opened;
    },
  });
  const p = require(pr, "pull request");
  if (created) ctx.save({ prBodySha: bodyHash(body), prCreatedByRun: true });
  // A PR opened earlier (an earlier round, or before a crash) describes an older commit: bring it up to date.
  else await syncPrBody(ctx, await adapters.codeHost.getPullRequest(config.repo, p.number), null, `reviewed commit ${reviewedSha.slice(0, 8)}`);
  ctx.log("info", "pr.ready", `PR #${p.number}: ${p.url}`);

  await linearMilestone(ctx, `pr.${p.number}`, `comment the PR link on ${issue.key}`, `Orchestrator run \`${run.id}\` opened a draft PR: ${p.url}\n\nChecks passed locally and an independent review (${config.agents.reviewer.adapter}) approved commit \`${reviewedSha.slice(0, 12)}\`. Waiting for CI; a human merges.`);
  if (config.linear.states.in_review) {
    await ctx.effect({
      key: "linear.state.in_review",
      permission: "linear.update_state",
      optional: true,
      description: `move ${issue.key} to "${config.linear.states.in_review}"`,
      simulate: () => null,
      run: () => adapters.tracker.setState(issue.key, config.linear.states.in_review!),
    });
  }
  return { to: "WAITING_FOR_CI", patch: { pr: { number: p.number, url: p.url, headSha: p.headSha } } };
};

// ---- WAITING_FOR_CI ----------------------------------------------------------------

const POLL_MS = 30_000;
/** Right after a push GitHub can still report the previous head for a few seconds. */
const HEAD_SETTLE_MS = 60_000;
const HEAD_SETTLE_POLL_MS = 3_000;

const waitingForCi: Handler<RunContext> = async (ctx) => {
  if (ctx.dryRun) return dryRunStage(ctx, "WAITING_FOR_CI", "READY_TO_MERGE");
  const { config, adapters, run } = ctx;
  const c = run.context;
  const pr = require(c.pr, "pr");
  const deadline = Date.now() + c.options.ciWaitMinutes * 60_000;
  const protection = await adapters.codeHost.getBranchProtection(config.repo, require(c.baseBranch, "baseBranch"));
  const settleUntil = Date.now() + HEAD_SETTLE_MS;

  for (;;) {
    ctx.throwIfStopped();
    const status = await adapters.codeHost.getPullRequest(config.repo, pr.number);
    if (status.state === "MERGED") return { to: "READY_TO_MERGE", reason: "PR was merged outside the orchestrator" };
    if (status.state === "CLOSED") return { to: "CANCELLED", reason: `PR #${pr.number} was closed` };
    if (status.headSha !== c.reviewedSha) {
      // Still the commit this run pushed before: GitHub has not caught up with the push yet.
      if ((c.pushed ?? []).includes(status.headSha) && Date.now() < settleUntil) {
        await sleep(HEAD_SETTLE_POLL_MS, ctx.signal);
        continue;
      }
      return { to: "BLOCKED", reason: `PR head ${status.headSha.slice(0, 8)} differs from reviewed ${c.reviewedSha?.slice(0, 8)}: unexpected changes after review` };
    }
    const state = ciState(status, protection.requiredChecks);
    if (state === "pass" || (state === "none" && !config.merge.require_ci)) {
      ctx.log("info", "ci.result", `CI ${state} on ${status.headSha.slice(0, 8)}`);
      return { to: "READY_TO_MERGE", patch: { pr: { ...pr, headSha: status.headSha }, lastCi: { state, sha: status.headSha, checks: status.checks } } };
    }
    if (state === "fail") {
      const failing = status.checks.filter((k) => k.bucket === "fail");
      ctx.log("warn", "ci.result", `CI failed: ${failing.map((f) => f.name).join(", ")}`);
      const max = config.merge.max_fix_attempts;
      const used = correctionsUsed(run);
      await syncPrBody(ctx, status, { state: "fail", sha: status.headSha, checks: status.checks, stopping: used >= max }, `CI failed on ${status.headSha.slice(0, 8)}`);
      const lastCi: PrCiStatus = { state: "fail", sha: status.headSha, checks: status.checks };
      if (used >= max) return { to: "FAILED", reason: `CI failing after ${max} correction round(s)`, patch: { lastCi } };
      return { to: "FIXING", reason: "CI failed", patch: { lastCi, feedback: { trigger: "ci", prompt: fixPromptForCi(failing, used + 1, max) } } };
    }
    if (Date.now() >= deadline) {
      ctx.log("info", "ci.waiting", `CI still ${state}; check again with: orchestrator resume ${run.id}`);
      return { to: "WAITING_FOR_CI", reason: `CI ${state}` };
    }
    await sleep(POLL_MS, ctx.signal);
  }
};

// ---- READY_TO_MERGE ----------------------------------------------------------------

const readyToMerge: Handler<RunContext> = async (ctx) => {
  if (ctx.dryRun) {
    dryRunStage(ctx, "READY_TO_MERGE", "COMPLETED");
    return { to: "COMPLETED", reason: "dry run complete: nothing was changed" };
  }
  const { config, adapters, run } = ctx;
  const c = run.context;
  const pr = require(c.pr, "pr");
  const status = await adapters.codeHost.getPullRequest(config.repo, pr.number);
  if (status.state === "MERGED") {
    const merged = await mergeRecord(adapters.codeHost, config.repo, status, c.reviewedSha, "engine");
    const message = describeMerge(pr, merged);
    ctx.log("info", "pr.merged", message, merged);
    return { to: "MERGED", reason: message, patch: { merged } };
  }
  if (status.state === "CLOSED") return { to: "CANCELLED", reason: `PR #${pr.number} was closed without merging` };

  const protection = await adapters.codeHost.getBranchProtection(config.repo, require(c.baseBranch, "baseBranch"));
  const actor = (await adapters.codeHost.viewer()).login;
  const verdicts = criteriaReport(c.lastReview ?? null, runCriteria(c));
  const eligibility = evaluateMerge({
    config,
    pr: status,
    protection,
    reviewedSha: c.reviewedSha ?? null,
    reviewApproved: Boolean(c.reviewApproved),
    unresolvedBlockingFindings: c.unresolvedBlocking ?? 0,
    unmetCriteria: verdicts.filter((v) => v.status === "not_met").length,
    actor,
  });
  const merge = { ...eligibility, checkedAt: ctx.now().toISOString(), headSha: status.headSha };
  const lastCi: PrCiStatus = { state: eligibility.ciState, sha: status.headSha, checks: status.checks };
  ctx.writeArtifact("merge", "merge eligibility", `merge-${status.headSha.slice(0, 8)}.json`, JSON.stringify(merge, null, 2));

  if (status.headSha !== c.reviewedSha) return { to: "WAITING_FOR_CI", reason: "PR head changed since review", patch: { merge, lastCi } };

  // The description reports CI on the delivered commit.
  await syncPrBody(ctx, status, { state: eligibility.ciState, sha: status.headSha, checks: status.checks }, `CI ${eligibility.ciState} on ${status.headSha.slice(0, 8)}`);

  // Delivered: the reviewed commit is the head, CI and the independent review passed, no criterion is
  // unmet. Only then, and only if the operator opted in, the draft becomes ready for review. Never a merge.
  let markedReady = false;
  const delivered =
    eligibility.eligible && eligibility.ciState === "pass" && Boolean(c.reviewApproved) && status.headSha === c.reviewedSha && prIsRuns(c, status, run.id);
  if (delivered && status.isDraft && config.pull_request.mark_ready_when_delivered) {
    await ctx.effect({
      key: `github.pr.ready.${status.headSha}`,
      permission: "github.create_pr",
      description: `mark PR #${pr.number} ready for review (delivered at ${status.headSha.slice(0, 8)})`,
      simulate: () => null,
      run: async () => {
        await adapters.codeHost.markPullRequestReady({ repo: config.repo, number: pr.number });
        return { headSha: status.headSha };
      },
    });
    markedReady = true;
    ctx.log("info", "pr.marked_ready", `PR #${pr.number} marked ready for review: every delivery gate passed on ${status.headSha.slice(0, 8)}`);
  }

  const needsHuman = verdicts.filter((v) => v.status === "needs_human");
  const summary = eligibility.eligible
    ? `merge-eligible${markedReady ? " (marked ready for review; a human merges)" : status.isDraft ? " (PR is a draft: mark it ready, then merge)" : ""}${needsHuman.length ? `; ${needsHuman.length} acceptance criteria need your judgement: ${needsHuman.map((v) => v.id).join(", ")}` : ""}`
    : `not merge-eligible: ${eligibility.reasons.join("; ")}`;
  ctx.log(eligibility.eligible ? "info" : "warn", "merge.eligibility", summary);

  // One milestone comment when the PR first becomes merge-ready; no comment per poll.
  if (eligibility.eligible) {
    await linearMilestone(ctx, "merge-ready", `report merge readiness on ${run.issueKey}`, `Orchestrator: ${pr.url} passed CI and independent review at \`${status.headSha.slice(0, 12)}\`. It is ready for a human to review and merge (merge mode: ${config.merge.mode}).`);
  }

  if (eligibility.autoMerge) {
    await ctx.effect({
      key: `github.merge.${status.headSha}`,
      permission: "github.merge",
      description: `merge PR #${pr.number} at ${status.headSha.slice(0, 8)} (${config.merge.method})`,
      simulate: () => null,
      run: () => adapters.codeHost.mergePullRequest({ repo: config.repo, number: pr.number, headSha: status.headSha, method: config.merge.method }),
    });
    return { to: "MERGED", reason: `merged PR #${pr.number} automatically under merge.auto_authorization`, patch: { merge, lastCi } };
  }
  return { to: "READY_TO_MERGE", reason: summary, patch: { merge, lastCi } };
};

// ---- MERGED ------------------------------------------------------------------------

const merged: Handler<RunContext> = async (ctx) => ({ to: "COMPLETED", reason: ctx.run.context.merged ? completionReason(ctx.run.context.merged) : "merged" });

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export const HANDLERS: Partial<Record<RunState, Handler<RunContext>>> = {
  QUEUED: queued,
  PLANNING: planning,
  IMPLEMENTING: implementing,
  TESTING: testing,
  REVIEWING: reviewing,
  FIXING: fixing,
  PR_OPEN: prOpen,
  WAITING_FOR_CI: waitingForCi,
  READY_TO_MERGE: readyToMerge,
  MERGED: merged,
};
