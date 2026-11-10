import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describeNode, resolveRunToolchain, toolchainReadPaths, type NodeVersionFile, type ResolvedToolchain } from "../adapters/checks.js";
import type { AgentResult, AgentRunner, ChangedFile, CheckResult, Issue, IssueRef, PrEvidence, PullRequestStatus } from "../adapters/types.js";
import { loadBrief, type Brief } from "../config/brief.js";
import type { AgentConfig, CheckConfig, RepoConfig } from "../config/schema.js";
import { classifyDependencies, extractIssueMentions, keysNeedingEvidence } from "../planning/dependencies.js";
import { analyzeReadiness, branchNameFor, extractAcceptanceCriteria } from "../planning/issue.js";
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
  fixPromptForReview,
  fixPromptForScreenshots,
  implementerPrompt,
  plannerPrompt,
  pullRequestBody,
  reviewerPrompt,
  type ScreenshotBrief,
} from "../planning/prompts.js";
import { REVIEW_OUTPUT_SCHEMA, decideReview, parseReview, type Finding, type ReviewOutcome } from "../planning/review.js";
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
import { collectScreenshots, matchesOutputs, outputStamps, pngPixels, pngProblem, screenshotCheck, screenshotsRequired, SCREENSHOT_CHECK_NAME, type Screenshot } from "./screenshots.js";
import type { RunState } from "./states.js";

// ---- persisted run context ---------------------------------------------------------

export interface Round {
  attempt: number;
  trigger: "initial" | "checks" | "review" | "ci";
  implementer?: { sessionId: string | null; ok: boolean; error: string | null; costUsd: number | null; durationMs: number; summary: string };
  commitSha?: string | null;
  changedFiles?: ChangedFile[];
  checks?: Array<Omit<CheckResult, "outputTail">>;
  review?: { verdict: ReviewOutcome["verdict"]; summary: string; findings: Finding[]; approved: boolean; blocking: number; reviewedSha: string; sessionId: string | null };
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
  /** Feedback FIXING must address. */
  feedback?: { trigger: Round["trigger"]; prompt: string } | null;
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
    throw new BlockedError(`run time limit reached before ${what}: ${Math.round(minutes)} of ${limits.max_run_minutes} minutes (limits.max_run_minutes); resume to grant a new window`);
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

  const plan = buildExecutionPlan({
    runId: run.id,
    mode: ctx.dryRun ? "dry_run" : "supervised",
    now: ctx.now(),
    config,
    configSource: ctx.configSource,
    issue,
    criteria,
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

async function implementerRound(ctx: Ctx, attempt: number, trigger: Round["trigger"], prompt: string): Promise<{ round: Round; sessionId: string | null; costUsd: number | null }> {
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
        }),
      ),
  });
  ctx.throwIfStopped();
  const r = require(result, "implementer result");
  ctx.save({ costUsd: totalCost(ctx, r.costUsd) });
  ctx.writeArtifact("agent-output", `implementer summary (round ${attempt})`, `${prefix}.summary.md`, r.text || "(empty)");
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
          if (bad.length) throw new BlockedError(`implementer touched forbidden paths (${bad.join(", ")}); commit ${sha.slice(0, 8)} left local for inspection`);
        }
        return sha;
      },
    });
  }
  const changedFiles = await adapters.workspace.changedFiles(worktree, baseSha);
  const headSha = await adapters.workspace.headSha(worktree);
  if (changedFiles.length === 0) throw new BlockedError(`implementer reported "${r.text.slice(0, 120).replace(/\n/g, " ")}" but the worktree has no changes against ${baseSha.slice(0, 8)}`);
  const bad = forbiddenFiles(changedFiles, config.forbidden_paths);
  if (bad.length) throw new BlockedError(`branch contains forbidden paths: ${bad.join(", ")}`);
  assertNoSecrets(ctx, await adapters.workspace.diff(worktree, baseSha), `the diff after round ${attempt}`);
  const previousHead = c.rounds.at(-1)?.screenshots?.commitSha ?? c.rounds.at(-1)?.commitSha;
  if (trigger !== "initial" && !commitSha && headSha === previousHead) {
    throw new BlockedError(`implementer made no changes in response to ${trigger} feedback (round ${attempt})`);
  }
  ctx.log("info", "verify.changes", `${changedFiles.length} file(s) changed vs base; HEAD ${headSha.slice(0, 8)}`, { files: changedFiles });

  return {
    round: {
      attempt,
      trigger,
      implementer: { sessionId: r.sessionId, ok: r.ok, error: r.error, costUsd: r.costUsd, durationMs: r.durationMs, summary: r.text.slice(0, SUMMARY_LIMIT) },
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
    criteria: c.plan?.acceptanceCriteria.criteria ?? [],
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
    key: `screenshots.${run.attempt}.${commit}.${createHash("sha256").update(JSON.stringify([cfg.run, cfg.outputs])).digest("hex").slice(0, 12)}`,
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
    key: `git.commit.screenshots.${run.attempt}.${commit}`,
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
    keyPrefix: `check.${run.attempt}.${commit}`,
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
  if (failed.length === 0) {
    const shots = await takeScreenshots(ctx, worktree, commit);
    if (shots.kind === "ok" && last) last.screenshots = shots.record;
    if (shots.kind !== "problem") return { to: "REVIEWING", patch: { rounds, lastChecks: results } };
    // A screenshot commit made before the problem still moved HEAD: the next round compares against it.
    if (shots.commitSha && last) last.screenshots = { command: config.screenshots!.run, files: [], commitSha: shots.commitSha };
    ctx.log("warn", "screenshots.result", `✗ screenshots: ${shots.reason}`);
    if (run.attempt >= max) return { to: "FAILED", reason: `screenshots still missing after ${max} correction round(s): ${shots.reason}`, patch: { rounds, lastChecks: results } };
    return {
      to: "FIXING",
      reason: `screenshots: ${shots.reason}`,
      patch: { rounds, lastChecks: results, feedback: { trigger: "checks", prompt: fixPromptForScreenshots({ reason: shots.reason, result: shots.result ?? null, brief: screenshotBrief(config)! }, run.attempt + 1, max) } },
    };
  }

  if (run.attempt >= max) {
    return { to: "FAILED", reason: `checks still failing after ${max} correction round(s): ${failed.map((f) => f.name).join(", ")}`, patch: { rounds, lastChecks: results } };
  }
  return {
    to: "FIXING",
    reason: `${failed.length} check(s) failed: ${failed.map((f) => f.name).join(", ")}`,
    patch: { rounds, lastChecks: results, feedback: { trigger: "checks", prompt: fixPromptForChecks(failed, run.attempt + 1, max) } },
  };
};

// ---- REVIEWING ---------------------------------------------------------------------

const reviewing: Handler<RunContext> = async (ctx) => {
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
  const reviewer = provider(ctx, config.agents.reviewer);
  const env = await runEnv(ctx, config.agents.reviewer);
  enforceLimits(ctx, `review round ${run.attempt}`, config.agents.reviewer.adapter === "claude-code");
  const prefix = `review-${run.attempt}`;

  const previous = c.lastReview ? decideReview(c.lastReview, config.review.blocking_severities).blocking : [];
  const shots = c.rounds.at(-1)?.screenshots ?? null;
  const prompt = reviewerPrompt({
    issue: require(c.issue, "issue"),
    criteria: c.plan?.acceptanceCriteria.criteria ?? [],
    baseSha,
    headSha,
    checks: c.lastChecks ?? [],
    previous,
    brief: c.brief?.body ?? null,
    screenshots: shots ? { command: shots.command, files: shots.files.map((f) => f.path), commitSha: shots.commitSha } : null,
  });
  ctx.writeArtifact("prompt", `review prompt (round ${run.attempt})`, `${prefix}.prompt.md`, prompt);

  const result = await ctx.effect({
    key: `agent.review.${headSha}`,
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
  const decision = decideReview(outcome, config.review.blocking_severities);
  ctx.writeArtifact("review", `review (round ${run.attempt})`, `${prefix}.json`, JSON.stringify({ outcome, decision, reviewedSha: headSha }, null, 2));
  ctx.log(decision.approved ? "info" : "warn", "review.result", `${reviewer.id}: ${outcome.verdict}, ${outcome.findings.length} finding(s), ${decision.blocking.length} blocking`);

  const rounds = [...c.rounds];
  const last = rounds.at(-1);
  if (last) {
    last.review = { verdict: outcome.verdict, summary: outcome.summary, findings: outcome.findings, approved: decision.approved, blocking: decision.blocking.length, reviewedSha: headSha, sessionId: r.sessionId };
  }
  const patch: Partial<RunContext> = { rounds, lastReview: outcome, reviewedSha: headSha, reviewApproved: decision.approved, unresolvedBlocking: decision.blocking.length };
  if (decision.approved) return { to: "PR_OPEN", patch };

  const max = config.merge.max_fix_attempts;
  if (run.attempt >= max) return { to: "FAILED", reason: `review not approved after ${max} correction round(s): ${decision.reasons.join("; ")}`, patch };
  return {
    to: "FIXING",
    reason: decision.reasons.join("; "),
    patch: { ...patch, feedback: { trigger: "review", prompt: fixPromptForReview(outcome, decision.blocking, run.attempt + 1, max) } },
  };
};

// ---- FIXING ------------------------------------------------------------------------

const fixing: Handler<RunContext> = async (ctx) => {
  const c = ctx.run.context;
  const feedback = require(c.feedback, "feedback");
  const attempt = ctx.run.attempt + 1;
  const { round, sessionId } = await implementerRound(ctx, attempt, feedback.trigger, feedback.prompt);
  return {
    to: "TESTING",
    attempt,
    patch: { rounds: [...ctx.run.context.rounds, round], implementerSessionId: sessionId ?? c.implementerSessionId ?? null, feedback: null, reviewApproved: false },
  };
};

// ---- PR_OPEN -----------------------------------------------------------------------

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

  const last = c.rounds.at(-1);
  const body = ctx.redactor.redact(
    pullRequestBody({
      issue,
      criteria: c.plan?.acceptanceCriteria.criteria ?? [],
      runId: run.id,
      changedFiles: last?.changedFiles ?? [],
      checks: c.lastChecks ?? [],
      review: c.lastReview ?? null,
      attempts: run.attempt,
      implementer: config.agents.implementer.adapter,
      reviewer: config.agents.reviewer.adapter,
      reviewedSha,
      openQuestions: openQuestions(c),
      briefSource: c.brief?.source.split("/").slice(-4).join("/") ?? null,
      screenshots: (last?.screenshots?.files ?? []).map((f) => ({ path: f.path, url: `https://github.com/${config.repo}/blob/${reviewedSha}/${f.path.split("/").map(encodeURIComponent).join("/")}?raw=true` })),
    }),
  );
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
      return adapters.codeHost.createPullRequest({
        repo: config.repo,
        base: require(c.baseBranch, "baseBranch"),
        head: branch,
        title: ctx.redactor.redact(`${issue.key}: ${issue.title}`),
        body,
        draft: config.pull_request.draft,
        labels: config.pull_request.labels,
      });
    },
  });
  const p = require(pr, "pull request");
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

const waitingForCi: Handler<RunContext> = async (ctx) => {
  if (ctx.dryRun) return dryRunStage(ctx, "WAITING_FOR_CI", "READY_TO_MERGE");
  const { config, adapters, run } = ctx;
  const c = run.context;
  const pr = require(c.pr, "pr");
  const deadline = Date.now() + c.options.ciWaitMinutes * 60_000;
  const protection = await adapters.codeHost.getBranchProtection(config.repo, require(c.baseBranch, "baseBranch"));

  for (;;) {
    ctx.throwIfStopped();
    const status = await adapters.codeHost.getPullRequest(config.repo, pr.number);
    if (status.state === "MERGED") return { to: "READY_TO_MERGE", reason: "PR was merged outside the orchestrator" };
    if (status.state === "CLOSED") return { to: "CANCELLED", reason: `PR #${pr.number} was closed` };
    if (status.headSha !== c.reviewedSha) {
      return { to: "BLOCKED", reason: `PR head ${status.headSha.slice(0, 8)} differs from reviewed ${c.reviewedSha?.slice(0, 8)}: unexpected changes after review` };
    }
    const state = ciState(status, protection.requiredChecks);
    if (state === "pass" || (state === "none" && !config.merge.require_ci)) {
      ctx.log("info", "ci.result", `CI ${state} on ${status.headSha.slice(0, 8)}`);
      return { to: "READY_TO_MERGE", patch: { pr: { ...pr, headSha: status.headSha } } };
    }
    if (state === "fail") {
      const failing = status.checks.filter((k) => k.bucket === "fail");
      ctx.log("warn", "ci.result", `CI failed: ${failing.map((f) => f.name).join(", ")}`);
      const max = config.merge.max_fix_attempts;
      if (run.attempt >= max) return { to: "FAILED", reason: `CI failing after ${max} correction round(s)` };
      return { to: "FIXING", reason: "CI failed", patch: { feedback: { trigger: "ci", prompt: fixPromptForCi(failing, run.attempt + 1, max) } } };
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
  if (status.state === "MERGED") return { to: "MERGED", reason: `PR #${pr.number} merged` };
  if (status.state === "CLOSED") return { to: "CANCELLED", reason: `PR #${pr.number} was closed without merging` };

  const protection = await adapters.codeHost.getBranchProtection(config.repo, require(c.baseBranch, "baseBranch"));
  const actor = (await adapters.codeHost.viewer()).login;
  const eligibility = evaluateMerge({
    config,
    pr: status,
    protection,
    reviewedSha: c.reviewedSha ?? null,
    reviewApproved: Boolean(c.reviewApproved),
    unresolvedBlockingFindings: c.unresolvedBlocking ?? 0,
    actor,
  });
  const merge = { ...eligibility, checkedAt: ctx.now().toISOString(), headSha: status.headSha };
  ctx.writeArtifact("merge", "merge eligibility", `merge-${status.headSha.slice(0, 8)}.json`, JSON.stringify(merge, null, 2));

  if (status.headSha !== c.reviewedSha) return { to: "WAITING_FOR_CI", reason: "PR head changed since review", patch: { merge } };

  const summary = eligibility.eligible
    ? `merge-eligible${status.isDraft ? " (PR is a draft: mark it ready, then merge)" : ""}`
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
    return { to: "MERGED", reason: `merged PR #${pr.number} automatically under merge.auto_authorization`, patch: { merge } };
  }
  return { to: "READY_TO_MERGE", reason: summary, patch: { merge } };
};

// ---- MERGED ------------------------------------------------------------------------

const merged: Handler<RunContext> = async () => ({ to: "COMPLETED", reason: "merged" });

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
