import { join } from "node:path";
import { resolveToolchain, type ResolvedToolchain } from "../adapters/checks.js";
import type { AgentResult, AgentRunner, ChangedFile, CheckResult, Issue, IssueRef, PullRequestStatus } from "../adapters/types.js";
import type { AgentConfig } from "../config/schema.js";
import { analyzeDependencies, branchNameFor, extractAcceptanceCriteria, extractDeclaredDependencies } from "../planning/issue.js";
import { AGENT_PLAN_SCHEMA, agentAssignment, buildExecutionPlan, parseAgentPlan, type AgentPlan, type ExecutionPlan } from "../planning/plan.js";
import {
  fixPromptForChecks,
  fixPromptForCi,
  fixPromptForReview,
  implementerPrompt,
  plannerPrompt,
  pullRequestBody,
  reviewerPrompt,
} from "../planning/prompts.js";
import { REVIEW_OUTPUT_SCHEMA, decideReview, parseReview, type Finding, type ReviewOutcome } from "../planning/review.js";
import { renderPlanMarkdown } from "../report/render.js";
import { BlockedError, type Handler, type Outcome, type StepContext } from "./engine.js";
import { ciState, evaluateMerge, type MergeEligibility } from "./policy.js";
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
}

export interface RunContext {
  options: {
    withAgentPlan: boolean;
    ciWaitMinutes: number;
    origin: { kind: "t3"; cliPath: string } | null;
    /** Declared dependencies the operator explicitly accepted as non-blocking (--accept-dependency). */
    acceptedDependencies?: string[];
  };
  configSource: string;
  issue?: Issue;
  plan?: ExecutionPlan;
  agentPlan?: AgentPlan | null;
  baseBranch?: string;
  baseSha?: string;
  clonePath?: string;
  branch?: string;
  worktreePath?: string;
  implementerSessionId?: string | null;
  rounds: Round[];
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

// ---- helpers -----------------------------------------------------------------------

function provider(ctx: Ctx, cfg: AgentConfig): AgentRunner {
  return ctx.adapters.agent(cfg);
}

async function toolchain(ctx: Ctx): Promise<ResolvedToolchain> {
  return resolveToolchain(ctx.config.toolchain.node, ctx.config.toolchain.env);
}

function require<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`run context is missing ${what}`);
  return value;
}

function matchGlob(path: string, pattern: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split("**")
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
      .join(".*")}$`,
  );
  const base = path.split("/").pop() ?? path;
  return re.test(path) || (!pattern.includes("/") && re.test(base));
}

export function forbiddenFiles(files: ChangedFile[], patterns: string[]): string[] {
  return files.filter((f) => f.status !== "D" && patterns.some((p) => matchGlob(f.path, p))).map((f) => f.path);
}

function totalCost(ctx: Ctx, add: number | null): number {
  return (ctx.run.context.costUsd ?? 0) + (add ?? 0);
}

/** Simulated agent result for dry runs: obviously not real. */
const SIMULATED_AGENT: AgentResult = { sessionId: null, text: "(dry run: agent not started)", structured: null, ok: true, error: null, costUsd: null, durationMs: 0, transcripts: [] };

// ---- QUEUED ------------------------------------------------------------------------

const queued: Handler<RunContext> = async () => ({ to: "PLANNING" });

// ---- PLANNING ----------------------------------------------------------------------

const planning: Handler<RunContext> = async (ctx) => {
  const { config, adapters, run } = ctx;
  const [owner, name] = config.repo.split("/") as [string, string];

  const issue = await adapters.tracker.getIssue(run.issueKey);
  ctx.writeArtifact("issue", `${issue.key} snapshot`, "issue.json", JSON.stringify(issue, null, 2));
  ctx.log("info", "issue.fetched", `${issue.key} "${issue.title}" [${issue.state.name}], ${issue.comments.length} comments, ${issue.blockedBy.length} blocker relation(s)`);

  const extraBlockers: string[] = [];
  const extraWarnings: string[] = [];
  if (!config.linear.teams.map((t) => t.toUpperCase()).includes(issue.team.key.toUpperCase())) {
    extraBlockers.push(`issue belongs to team ${issue.team.key}, which ${config.repo} is not configured for (linear.teams: ${config.linear.teams.join(", ")})`);
  }
  if (config.linear.projects.length && !config.linear.projects.includes(issue.project ?? "")) {
    extraBlockers.push(`issue project "${issue.project ?? "none"}" is not one of ${config.linear.projects.join(", ")}`);
  }

  // Dependencies written in the description count too: look up each one's real state.
  const known = new Map<string, IssueRef>([...issue.related, ...issue.blocks, ...issue.children, ...(issue.parent ? [issue.parent] : [])].map((r) => [r.key, r]));
  const declared: IssueRef[] = [];
  for (const key of extractDeclaredDependencies(issue.description)) {
    if (key === issue.key || issue.blockedBy.some((b) => b.key === key)) continue;
    const ref: IssueRef = known.get(key) ?? (await adapters.tracker.getIssue(key).catch((err: Error): IssueRef => ({ key, title: `(unreadable: ${err.message})`, state: { name: "unknown", type: "unknown" } })));
    declared.push({ key: ref.key, title: ref.title, ...(ref.url ? { url: ref.url } : {}), state: ref.state });
  }
  const accepted = run.context.options.acceptedDependencies ?? [];
  for (const key of accepted) ctx.log("warn", "dependency.accepted", `Operator accepted ${key} as non-blocking (--accept-dependency)`);
  const deps = analyzeDependencies(issue, declared, accepted);
  const criteria = extractAcceptanceCriteria(issue.description);

  const repoInfo = await adapters.codeHost.getRepo(config.repo, config.base_branch);
  const baseBranch = config.base_branch ?? repoInfo.defaultBranch;
  const protection = await adapters.codeHost.getBranchProtection(config.repo, baseBranch);

  // Orchestrator-owned clone unless the operator points at an existing one.
  const managed = !config.local_path;
  const clonePath = config.local_path ?? join(ctx.paths.clones, owner, name);
  if (managed) {
    await adapters.workspace.ensureClone(config.repo, clonePath, { fetch: true });
  } else {
    extraWarnings.push(`using operator clone ${clonePath}; worktrees will be registered in its .git`);
  }
  const inspectedRef = managed ? `origin/${baseBranch}` : "HEAD";
  const inspection = await adapters.workspace.inspect(clonePath, managed ? inspectedRef : undefined);

  const tc = await toolchain(ctx);
  const branch = branchNameFor(config.branch.template, issue);
  const worktreePath = join(ctx.paths.worktrees, owner, name, run.id);
  const branchExists = await adapters.workspace.branchExists(clonePath, branch);
  const existingPr = await adapters.codeHost.findPullRequest(config.repo, branch);

  // Independence invariants.
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

  const sampleTask = { cwd: worktreePath, prompt: "", artifactDir: ctx.artifactDir, timeoutMs: 0 };
  const agents = [
    agentAssignment("implementer", config.agents.implementer, implementer.provider, implementer.describe({ ...sampleTask, role: "implementer", artifactPrefix: "implement-0" })),
    agentAssignment("reviewer", config.agents.reviewer, reviewer.provider, reviewer.describe({ ...sampleTask, role: "reviewer", artifactPrefix: "review-0", outputSchema: REVIEW_OUTPUT_SCHEMA })),
  ];

  let agentPlan: AgentPlan | null = null;
  const plannerCfg = config.agents.planner;
  if (plannerCfg && (run.mode === "supervised" || run.context.options.withAgentPlan)) {
    const planner = provider(ctx, plannerCfg);
    agents.unshift(agentAssignment("planner", plannerCfg, planner.provider, planner.describe({ ...sampleTask, cwd: clonePath, role: "planner", artifactPrefix: "plan" })));
    const prompt = plannerPrompt(issue, criteria.criteria, inspection.guidanceFiles);
    ctx.writeArtifact("prompt", "planner prompt", "plan.prompt.md", prompt);
    const result = await ctx.effect({
      key: "agent.plan",
      permission: "agents.run",
      description: `run read-only planner (${plannerCfg.adapter}) in ${clonePath}`,
      allowInDryRun: run.context.options.withAgentPlan,
      simulate: () => SIMULATED_AGENT,
      run: () =>
        planner.run({
          role: "planner",
          cwd: clonePath,
          prompt,
          outputSchema: AGENT_PLAN_SCHEMA,
          artifactDir: ctx.artifactDir,
          artifactPrefix: "plan",
          timeoutMs: plannerCfg.timeout_minutes * 60_000,
          env: tc.env,
          signal: ctx.signal,
        }),
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
    mode: run.mode,
    now: ctx.now(),
    config,
    configSource: ctx.configSource,
    issue,
    criteria,
    dependencies: deps,
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

  const patch: Partial<RunContext> = { issue, plan, agentPlan, baseBranch, baseSha: repoInfo.baseSha, clonePath, branch, worktreePath };
  if (plan.blockers.length > 0) {
    for (const b of plan.blockers) ctx.log("warn", "plan.blocker", b);
    const reason = plan.blockers.length === 1 ? plan.blockers[0]! : `${plan.blockers.length} blockers, first: ${plan.blockers[0]} (all: orchestrator plan ${run.id})`;
    return { to: "BLOCKED", reason, patch };
  }
  return { to: "IMPLEMENTING", patch };
};

// ---- shared: implementer round -----------------------------------------------------

async function implementerRound(ctx: Ctx, attempt: number, trigger: Round["trigger"], prompt: string): Promise<{ round: Round; sessionId: string | null; costUsd: number | null }> {
  const { config, adapters } = ctx;
  const c = ctx.run.context;
  const worktree = require(c.worktreePath, "worktreePath");
  const baseSha = require(c.baseSha, "baseSha");
  const agent = provider(ctx, config.agents.implementer);
  const tc = await toolchain(ctx);
  const prefix = `implement-${attempt}`;
  ctx.writeArtifact("prompt", `implementer prompt (round ${attempt})`, `${prefix}.prompt.md`, prompt);

  // Pin the session id before starting so a crash mid-run resumes the same session.
  const resumeSessionId = c.implementerSessionId ?? undefined;
  const sessionId = resumeSessionId ?? crypto.randomUUID();
  if (!resumeSessionId && agent.id === "claude-code") ctx.save({ implementerSessionId: sessionId });

  const result = await ctx.effect({
    key: `agent.implement.${attempt}`,
    permission: "agents.run",
    description: `run implementer ${agent.id} (round ${attempt}, ${trigger}) in ${worktree}`,
    simulate: () => SIMULATED_AGENT,
    run: () =>
      agent.run({
        role: "implementer",
        cwd: worktree,
        prompt,
        ...(resumeSessionId ? { resumeSessionId } : { sessionId }),
        artifactDir: ctx.artifactDir,
        artifactPrefix: prefix,
        timeoutMs: config.agents.implementer.timeout_minutes * 60_000,
        env: tc.env,
        signal: ctx.signal,
      }),
  });
  ctx.throwIfStopped();
  const r = require(result, "implementer result");
  ctx.writeArtifact("agent-output", `implementer summary (round ${attempt})`, `${prefix}.summary.md`, r.text || "(empty)");
  if (!r.ok) throw new BlockedError(`implementer failed in round ${attempt}: ${r.error}`);

  // Verify, don't trust: what actually changed on disk?
  const message = `${ctx.run.issueKey}: ${c.issue?.title ?? "changes"}\n\nRound ${attempt} (${trigger}) by ${agent.id}, committed by orchestrator run ${ctx.run.id}.`;
  const pending = await adapters.workspace.hasUncommittedChanges(worktree);
  let commitSha: string | null = null;
  if (pending) {
    // Inspect the uncommitted file list before staging anything.
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
  if (trigger !== "initial" && !commitSha && headSha === c.rounds.at(-1)?.commitSha) {
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

  const tc = await toolchain(ctx);
  for (const [i, s] of config.setup.entries()) {
    const res = await ctx.effect({
      key: `setup.${i}.${s.name}`,
      permission: "local.checks",
      description: `setup "${s.name}": ${s.run}`,
      simulate: () => null,
      run: () =>
        adapters.checks.run({ name: s.name, command: s.run, cwd: worktree, env: tc.env, timeoutMs: s.timeout_minutes * 60_000, optional: s.optional, logPath: join(ctx.artifactDir, `setup-${s.name}.log`), signal: ctx.signal }),
    });
    ctx.throwIfStopped();
    if (res && !res.ok && !res.optional) throw new BlockedError(`setup "${s.name}" failed (exit ${res.exitCode}); see ${res.logPath}`);
  }

  const prompt = implementerPrompt({
    issue: require(c.issue, "issue"),
    criteria: c.plan?.acceptanceCriteria.criteria ?? [],
    plan: c.agentPlan ?? null,
    checks: config.checks.map((k) => k.run),
    guidanceFiles: c.plan?.repository.guidanceFiles ?? [],
  });
  const { round, sessionId, costUsd } = await implementerRound(ctx, 0, "initial", prompt);
  return { to: "TESTING", patch: { rounds: [...c.rounds, round], implementerSessionId: sessionId, costUsd: totalCost(ctx, costUsd) } };
};

// ---- TESTING -----------------------------------------------------------------------

const testing: Handler<RunContext> = async (ctx) => {
  if (ctx.dryRun) return dryRunStage(ctx, "TESTING", "REVIEWING");
  const { config, adapters, run } = ctx;
  const c = run.context;
  const worktree = require(c.worktreePath, "worktreePath");
  const tc = await toolchain(ctx);
  const results: CheckResult[] = [];

  for (const check of config.checks) {
    const res = await ctx.effect({
      key: `check.${run.attempt}.${check.name}.${c.rounds.at(-1)?.commitSha ?? "head"}`,
      permission: "local.checks",
      description: `check "${check.name}": ${check.run}`,
      simulate: () => null,
      run: () =>
        adapters.checks.run({
          name: check.name,
          command: check.run,
          cwd: worktree,
          env: tc.env,
          timeoutMs: check.timeout_minutes * 60_000,
          optional: check.optional,
          logPath: join(ctx.artifactDir, `check-${run.attempt}-${check.name}.log`),
          signal: ctx.signal,
        }),
    });
    ctx.throwIfStopped();
    if (res) {
      results.push(res);
      ctx.log(res.ok ? "info" : "warn", "check.result", `${res.ok ? "✓" : "✗"} ${res.name} (${Math.round(res.durationMs / 1000)}s)${res.ok ? "" : ` exit ${res.exitCode}${res.timedOut ? " (timeout)" : ""}`}`);
    }
  }
  // The checks must not have changed tracked files (e.g. a formatter rewriting code).
  if (await adapters.workspace.hasUncommittedChanges(worktree)) {
    ctx.log("warn", "check.dirty", "checks modified the worktree; those changes are not part of the reviewed commit");
  }

  const rounds = [...c.rounds];
  const last = rounds.at(-1);
  if (last) last.checks = results.map(({ outputTail: _t, ...rest }) => rest);
  const failed = results.filter((r) => !r.ok && !r.optional);
  if (failed.length === 0) return { to: "REVIEWING", patch: { rounds, lastChecks: results } };

  const max = config.merge.max_fix_attempts;
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
  const reviewer = provider(ctx, config.agents.reviewer);
  const tc = await toolchain(ctx);
  const prefix = `review-${run.attempt}`;

  const previous = c.lastReview ? decideReview(c.lastReview, config.review.blocking_severities).blocking : [];
  const prompt = reviewerPrompt({ issue: require(c.issue, "issue"), criteria: c.plan?.acceptanceCriteria.criteria ?? [], baseSha, headSha, checks: c.lastChecks ?? [], previous });
  ctx.writeArtifact("prompt", `review prompt (round ${run.attempt})`, `${prefix}.prompt.md`, prompt);

  const result = await ctx.effect({
    key: `agent.review.${headSha}`,
    permission: "agents.run",
    description: `run independent reviewer ${reviewer.id} on ${headSha.slice(0, 8)}`,
    simulate: () => SIMULATED_AGENT,
    run: () =>
      reviewer.run({
        role: "reviewer",
        cwd: worktree,
        prompt,
        outputSchema: REVIEW_OUTPUT_SCHEMA,
        artifactDir: ctx.artifactDir,
        artifactPrefix: prefix,
        timeoutMs: config.agents.reviewer.timeout_minutes * 60_000,
        env: tc.env,
        signal: ctx.signal,
      }),
  });
  ctx.throwIfStopped();
  const r = require(result, "review result");
  if (!r.ok) throw new BlockedError(`reviewer failed: ${r.error}`);

  // The reviewer must not have changed what it reviewed.
  const after = await adapters.workspace.headSha(worktree);
  if (after !== headSha || (await adapters.workspace.hasUncommittedChanges(worktree))) {
    return { to: "FAILED", reason: "the worktree changed during review; the reviewer is not allowed to modify code" };
  }

  let outcome: ReviewOutcome;
  try {
    outcome = parseReview(r.structured);
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
  const { round, sessionId, costUsd } = await implementerRound(ctx, attempt, feedback.trigger, feedback.prompt);
  return {
    to: "TESTING",
    attempt,
    patch: { rounds: [...c.rounds, round], implementerSessionId: sessionId ?? c.implementerSessionId ?? null, feedback: null, reviewApproved: false, costUsd: totalCost(ctx, costUsd) },
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

  if (!c.reviewApproved) throw new BlockedError("refusing to publish: no independent approval recorded");
  const head = await adapters.workspace.headSha(worktree);
  if (head !== reviewedSha) return { to: "FAILED", reason: `worktree HEAD ${head.slice(0, 8)} is not the reviewed commit ${reviewedSha.slice(0, 8)}` };

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
      const last = c.rounds.at(-1);
      return adapters.codeHost.createPullRequest({
        repo: config.repo,
        base: require(c.baseBranch, "baseBranch"),
        head: branch,
        title: `${issue.key}: ${issue.title}`,
        body: pullRequestBody({
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
        }),
        draft: config.pull_request.draft,
        labels: config.pull_request.labels,
      });
    },
  });
  const p = require(pr, "pull request");
  ctx.log("info", "pr.ready", `PR #${p.number}: ${p.url}`);

  await ctx.effect({
    key: `linear.comment.pr.${p.number}`,
    permission: "linear.comment",
    optional: true,
    description: `comment PR link on ${issue.key}`,
    simulate: () => null,
    run: () => adapters.tracker.comment(issue.key, `Orchestrator run \`${run.id}\` opened ${p.url} (reviewed commit \`${reviewedSha.slice(0, 12)}\`). Waiting for CI.`),
  });
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

  await ctx.effect({
    key: `linear.comment.merge.${status.headSha}.${eligibility.eligible}`,
    permission: "linear.comment",
    optional: true,
    description: `report merge eligibility on ${run.issueKey}`,
    simulate: () => null,
    run: () => adapters.tracker.comment(run.issueKey, `Orchestrator: ${pr.url} is ${summary}. Merge mode: ${config.merge.mode}.`),
  });

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
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
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
