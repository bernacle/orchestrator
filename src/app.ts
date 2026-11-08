import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRealAdapters } from "./adapters/index.js";
import { SnapshotTracker } from "./adapters/snapshot.js";
import { detectT3Origin } from "./adapters/t3.js";
import { LinearTracker } from "./adapters/linear.js";
import type { Adapters, IssueTracker } from "./adapters/types.js";
import { ConfigError, loadRepoConfig, loadRepoConfigFile, resolvePaths, type LoadedRepoConfig, type Paths } from "./config/load.js";
import { resolveLinearKey, type ResolvedLinearKey } from "./credentials/linear.js";
import { inspectRequest, type Problem } from "./intake/context.js";
import { defaultDiscoveryDeps, type DiscoveryDeps } from "./intake/repo-discovery.js";
import { Engine, type EngineOptions } from "./core/engine.js";
import { ALWAYS_DENIED_ENV, credentialPaths, toolchainCaches } from "./core/isolation.js";
import { Redactor } from "./core/redact.js";
import { TERMINAL_STATES } from "./core/states.js";
import { Store, type RunRecord } from "./core/store.js";
import { HANDLERS, type RunContext } from "./core/workflow.js";
import { parseIssueRef } from "./intake/issue-ref.js";

export interface App {
  paths: Paths;
  store: Store;
  redactor: Redactor;
  env: NodeJS.ProcessEnv;
  /** Injected in tests; real adapters otherwise. `linearWorkspace` picks the stored Linear key. */
  adaptersFor(loaded: LoadedRepoConfig, hints?: { linearWorkspace?: string | null }): Adapters;
  /** Issue tracker for reading an issue before a run exists (context, association checks). */
  trackerFor(workspace: string | null): { tracker: IssueTracker; credential: ResolvedLinearKey };
  /** Git/SSH access for repository discovery (injected in tests). */
  discovery: DiscoveryDeps;
  close(): void;
}

export function openApp(
  opts: {
    env?: NodeJS.ProcessEnv;
    adapters?: (loaded: LoadedRepoConfig) => Adapters;
    tracker?: (workspace: string | null) => IssueTracker;
    discovery?: DiscoveryDeps;
    now?: () => Date;
  } = {},
): App {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(env);
  const redactor = new Redactor(env);
  const store = new Store(paths.db, redactor, opts.now);
  const linearKey = (workspace: string | null | undefined) => {
    const credential = resolveLinearKey({ env, paths, workspace: workspace ?? null });
    redactor.add(credential.key);
    return credential;
  };
  return {
    paths,
    store,
    redactor,
    env,
    adaptersFor:
      opts.adapters ??
      ((loaded, hints) => {
        // The keyring token is not in the environment: register its value so redaction and the
        // pre-push secret scan recognise it.
        redactor.add(ghTokenFromKeyring(env));
        const credential = linearKey(hints?.linearWorkspace ?? loaded.config.linear.workspace);
        return createRealAdapters(redactor, env, { denyRead: credentialPaths(env, paths.home), deniedEnv: ALWAYS_DENIED_ENV, allowWrite: toolchainCaches(env) }, credential);
      }),
    trackerFor: (workspace) => {
      if (opts.tracker) return { tracker: opts.tracker(workspace), credential: { key: undefined, source: "test tracker", workspace, problem: null } };
      if (opts.adapters) throw new Error("openApp: tests that inspect requests must inject `tracker`");
      const credential = linearKey(workspace);
      return { tracker: new LinearTracker(credential.key, undefined, credential.problem ?? undefined), credential };
    },
    discovery: opts.discovery ?? defaultDiscoveryDeps(env),
    close: () => store.close(),
  };
}

function ghTokenFromKeyring(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync("gh", ["auth", "token"], { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export class RunError extends Error {
  override name = "RunError";
}

/** A request the engine refuses to start, with a machine-readable code (see intake/context.ts). */
export class IntakeError extends RunError {
  override name = "IntakeError";
  constructor(
    readonly code: Problem["code"] | "execution_disabled" | "no_run",
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export function newRunId(issueKey: string): string {
  return `${issueKey.toLowerCase()}-${randomBytes(3).toString("hex")}`;
}

export interface StartOptions extends Pick<EngineOptions, "onEvent" | "interrupt"> {
  /** Issue key or Linear issue URL. */
  issueKey: string;
  repo?: string;
  /** Working directory used to discover the repository when neither repo nor configFile is given. */
  cwd?: string;
  linearWorkspace?: string;
  configFile?: string;
  dryRun: boolean;
  withAgentPlan?: boolean;
  ciWaitMinutes?: number;
  acceptDependencies?: string[];
  /** Replay Linear data from a recorded issue.json (dry runs only). */
  issueSnapshot?: string;
}

function engineFor(app: App, loaded: LoadedRepoConfig, snapshot?: SnapshotTracker, linearWorkspace?: string | null): Engine<RunContext> {
  const adapters = app.adaptersFor(loaded, { linearWorkspace: linearWorkspace ?? null });
  return new Engine<RunContext>({
    store: app.store,
    adapters: snapshot ? { ...adapters, tracker: snapshot } : adapters,
    config: loaded.config,
    configSource: loaded.source,
    paths: app.paths,
    redactor: app.redactor,
    handlers: HANDLERS,
  });
}

export async function startRun(app: App, opts: StartOptions): Promise<RunRecord<RunContext>> {
  let ref;
  try {
    ref = parseIssueRef(opts.issueKey);
  } catch (err) {
    throw new RunError((err as Error).message);
  }
  const issueKey = ref.key;
  if (opts.issueSnapshot && !opts.dryRun) throw new RunError("--issue-snapshot is for dry runs only; a live run always reads Linear");
  const snapshot = opts.issueSnapshot ? new SnapshotTracker(opts.issueSnapshot) : undefined;
  if (snapshot && snapshot.issue.key !== issueKey) throw new RunError(`snapshot ${opts.issueSnapshot} is for ${snapshot.issue.key}, not ${issueKey}`);
  if (!opts.dryRun && app.env.ORCHESTRATOR_NO_EXECUTE) throw new IntakeError("execution_disabled", "live runs are disabled in this environment (ORCHESTRATOR_NO_EXECUTE is set); run without --execute for a dry run");

  // Same gate as `orchestrator context`: repository, authorization, workspace, association, duplicates.
  const explicit = Boolean(opts.repo || opts.configFile);
  const inspected = await inspectRequest(app, {
    issueRef: opts.issueKey,
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.configFile ? { configFile: opts.configFile } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(snapshot ? { snapshotIssue: snapshot.issue } : {}),
    ...(opts.linearWorkspace ? { linearWorkspace: opts.linearWorkspace } : {}),
    // An explicit selection needs no association evidence; planning reads Linear itself.
    fetchIssue: !explicit,
  });
  const fatal = inspected.problems.filter((p) => {
    if (p.code === "linear_auth" || p.code === "linear_issue") return !explicit; // planning reports these for explicit runs
    // A dry run has no side effects, so it may run beside an active live run (reported as a warning).
    if (p.code === "active_run_exists") return !opts.dryRun;
    return true;
  });
  if (fatal.length > 0) {
    const first = fatal[0]!;
    const message =
      first.code === "active_run_exists"
        ? `${issueKey} already has an active run (${inspected.runs.active.map((r) => `${r.id} ${r.state}`).join(", ")}); use resume or cancel it first`
        : first.message;
    throw new IntakeError(first.code, fatal.length > 1 ? `${message}\n${fatal.slice(1).map((p) => `also: ${p.message}`).join("\n")}` : message, { problems: fatal, nextActions: inspected.nextActions });
  }
  const loaded = inspected.loaded!;
  if (opts.dryRun && inspected.runs.active.length) inspected.warnings.push(`active live run(s) for ${issueKey}: ${inspected.runs.active.map((r) => `${r.id} ${r.state}`).join(", ")}; this dry run does not affect them`);
  for (const w of inspected.warnings) opts.onEvent?.({ level: "warn", state: "QUEUED", type: "intake.warning", message: w });
  const linearWorkspace = opts.linearWorkspace?.toLowerCase() ?? ref.workspace;

  const run = app.store.createRun<RunContext>({
    id: newRunId(issueKey),
    issueKey,
    repo: loaded.config.repo,
    mode: opts.dryRun ? "dry_run" : "supervised",
    context: {
      options: {
        withAgentPlan: Boolean(opts.withAgentPlan),
        ciWaitMinutes: opts.ciWaitMinutes ?? 30,
        origin: detectT3Origin(app.env),
        acceptedDependencies: (opts.acceptDependencies ?? []).map((k) => k.toUpperCase()),
        ...(snapshot ? { issueSnapshot: { file: snapshot.file, takenAt: snapshot.takenAt } } : {}),
        intake: {
          source: inspected.selection.source!,
          reason: inspected.selection.reason,
          association: inspected.association ? { verified: inspected.association.verified, evidence: inspected.association.evidence } : null,
          cwd: inspected.request.cwd,
          linkedWorktree: inspected.repository.worktree?.linked ?? false,
          linearWorkspace,
        },
      },
      configSource: loaded.source,
      rounds: [],
    },
  });
  return engineFor(app, loaded, snapshot, linearWorkspace).drive(run.id, { ...(opts.onEvent ? { onEvent: opts.onEvent } : {}), ...(opts.interrupt ? { interrupt: opts.interrupt } : {}) });
}

export function findRunOrThrow(app: App, id: string): RunRecord<RunContext> {
  const run = app.store.findRun<RunContext>(id);
  if (!run) throw new RunError(`no run matches "${id}" (see: orchestrator status)`);
  return run;
}

/** Reloads the repository config, so permission changes take effect on resume. */
export async function resumeRun(
  app: App,
  id: string,
  opts: Pick<EngineOptions, "onEvent" | "interrupt"> & { ciWaitMinutes?: number; acceptDependencies?: string[] } = {},
): Promise<RunRecord<RunContext>> {
  let run = findRunOrThrow(app, id);
  if (TERMINAL_STATES.has(run.state)) throw new RunError(`run ${run.id} is ${run.state}; start a new run instead`);
  const source = run.context.configSource;
  const loaded = source && existsSync(source) ? loadRepoConfigFile(source) : loadRepoConfig(run.repo, app.paths);
  if (loaded.config.repo !== run.repo) throw new ConfigError(`${loaded.source} now configures ${loaded.config.repo}, but the run is for ${run.repo}`);
  const accepted = [...new Set([...(run.context.options.acceptedDependencies ?? []), ...(opts.acceptDependencies ?? []).map((k) => k.toUpperCase())])];
  // An operator resume grants a fresh time window (the cost cap is never reset).
  run = app.store.patchContext<RunContext>(run.id, {
    limitWindowStartedAt: new Date().toISOString(),
    options: { ...run.context.options, ...(opts.ciWaitMinutes !== undefined ? { ciWaitMinutes: opts.ciWaitMinutes } : {}), acceptedDependencies: accepted },
  });
  app.store.appendEvent(run.id, run.state, "info", "run.resume", `Resume requested at ${run.state}`);
  const snap = run.context.options.issueSnapshot;
  if (run.mode === "supervised" && app.env.ORCHESTRATOR_NO_EXECUTE) throw new IntakeError("execution_disabled", "live runs are disabled in this environment (ORCHESTRATOR_NO_EXECUTE is set)");
  return engineFor(app, loaded, snap ? new SnapshotTracker(snap.file) : undefined, run.context.options.intake?.linearWorkspace).drive(run.id, { resume: true, ...(opts.onEvent ? { onEvent: opts.onEvent } : {}), ...(opts.interrupt ? { interrupt: opts.interrupt } : {}) });
}

/**
 * Cancel. If a process is driving the run, flag it and let that process stop
 * its agent/check cleanly; otherwise transition directly. Worktrees are kept.
 */
export function cancelRun(app: App, id: string): { run: RunRecord<RunContext>; deferred: boolean } {
  const run = findRunOrThrow(app, id);
  if (TERMINAL_STATES.has(run.state)) throw new RunError(`run ${run.id} is already ${run.state}`);
  app.store.requestCancel(run.id);
  if (app.store.leaseHolder(run.id)) {
    app.store.appendEvent(run.id, run.state, "warn", "run.cancel_requested", "Cancellation requested; the driving process will stop");
    return { run: app.store.getRun<RunContext>(run.id)!, deferred: true };
  }
  const cancelled = app.store.transition<RunContext>(run.id, run.version, { to: "CANCELLED", reason: "cancelled by operator" });
  return { run: cancelled, deferred: false };
}
