import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRealAdapters } from "./adapters/index.js";
import { detectT3Origin } from "./adapters/t3.js";
import type { Adapters } from "./adapters/types.js";
import { ConfigError, loadRepoConfig, loadRepoConfigFile, resolvePaths, resolveRepoForIssue, type LoadedRepoConfig, type Paths } from "./config/load.js";
import { Engine, type EngineOptions } from "./core/engine.js";
import { Redactor } from "./core/redact.js";
import { TERMINAL_STATES } from "./core/states.js";
import { Store, type RunRecord } from "./core/store.js";
import { HANDLERS, type RunContext } from "./core/workflow.js";

export interface App {
  paths: Paths;
  store: Store;
  redactor: Redactor;
  env: NodeJS.ProcessEnv;
  /** Injected in tests; real adapters otherwise. */
  adaptersFor(loaded: LoadedRepoConfig): Adapters;
  close(): void;
}

export function openApp(opts: { env?: NodeJS.ProcessEnv; adapters?: (loaded: LoadedRepoConfig) => Adapters; now?: () => Date } = {}): App {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(env);
  const redactor = new Redactor(env);
  const store = new Store(paths.db, redactor, opts.now);
  return {
    paths,
    store,
    redactor,
    env,
    adaptersFor: opts.adapters ?? (() => createRealAdapters(redactor, env)),
    close: () => store.close(),
  };
}

export class RunError extends Error {
  override name = "RunError";
}

export function newRunId(issueKey: string): string {
  return `${issueKey.toLowerCase()}-${randomBytes(3).toString("hex")}`;
}

export interface StartOptions extends Pick<EngineOptions, "onEvent" | "interrupt"> {
  issueKey: string;
  repo?: string;
  configFile?: string;
  dryRun: boolean;
  withAgentPlan?: boolean;
  ciWaitMinutes?: number;
  acceptDependencies?: string[];
}

export function resolveConfig(app: App, issueKey: string, repo?: string, configFile?: string): LoadedRepoConfig {
  if (configFile && !repo) return loadRepoConfigFile(configFile);
  if (repo) return loadRepoConfig(repo, app.paths, configFile);
  return resolveRepoForIssue(issueKey, app.paths);
}

function engineFor(app: App, loaded: LoadedRepoConfig): Engine<RunContext> {
  return new Engine<RunContext>({
    store: app.store,
    adapters: app.adaptersFor(loaded),
    config: loaded.config,
    configSource: loaded.source,
    paths: app.paths,
    redactor: app.redactor,
    handlers: HANDLERS,
  });
}

export async function startRun(app: App, opts: StartOptions): Promise<RunRecord<RunContext>> {
  const issueKey = opts.issueKey.toUpperCase();
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(issueKey)) throw new RunError(`"${opts.issueKey}" is not a Linear issue key (expected e.g. BRU-488)`);
  const loaded = resolveConfig(app, issueKey, opts.repo, opts.configFile);

  if (!opts.dryRun) {
    const active = app.store.activeRunsFor(issueKey, loaded.config.repo);
    if (active.length > 0) {
      throw new RunError(`${issueKey} already has an active run (${active.map((r) => `${r.id} ${r.state}`).join(", ")}); use resume or cancel it first`);
    }
  }

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
      },
      configSource: loaded.source,
      rounds: [],
    },
  });
  return engineFor(app, loaded).drive(run.id, { ...(opts.onEvent ? { onEvent: opts.onEvent } : {}), ...(opts.interrupt ? { interrupt: opts.interrupt } : {}) });
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
  if (opts.ciWaitMinutes !== undefined || opts.acceptDependencies?.length) {
    const accepted = [...new Set([...(run.context.options.acceptedDependencies ?? []), ...(opts.acceptDependencies ?? []).map((k) => k.toUpperCase())])];
    run = app.store.patchContext<RunContext>(run.id, {
      options: { ...run.context.options, ...(opts.ciWaitMinutes !== undefined ? { ciWaitMinutes: opts.ciWaitMinutes } : {}), acceptedDependencies: accepted },
    });
  }
  app.store.appendEvent(run.id, run.state, "info", "run.resume", `Resume requested at ${run.state}`);
  return engineFor(app, loaded).drive(run.id, { resume: true, ...(opts.onEvent ? { onEvent: opts.onEvent } : {}), ...(opts.interrupt ? { interrupt: opts.interrupt } : {}) });
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
