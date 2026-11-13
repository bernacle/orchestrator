import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapters } from "../adapters/types.js";
import type { RepoConfig } from "../config/schema.js";
import type { Paths } from "../config/load.js";
import { PermissionGate, type Permission } from "./policy.js";
import type { Redactor } from "./redact.js";
import { TERMINAL_STATES, type RunState } from "./states.js";
import { hostName, type EffectStatus, type EventLevel, type RunMode, type RunRecord, type Store } from "./store.js";

/** Thrown by handlers to park the run in BLOCKED with an actionable reason. */
export class BlockedError extends Error {
  override name = "BlockedError";
}

/** Thrown by handlers when a safety invariant is violated: the run ends FAILED, never resumes automatically. */
export class FailedError extends Error {
  override name = "FailedError";
}

/** Thrown when the run is cancelled or interrupted mid-step. */
export class StopError extends Error {
  override name = "StopError";
  constructor(readonly kind: "cancel" | "interrupt") {
    super(kind === "cancel" ? "run cancelled" : "run interrupted");
  }
}

export interface Outcome<C> {
  to: RunState;
  reason?: string;
  patch?: Partial<C>;
  attempt?: number;
}

export interface EffectOptions<T> {
  key: string;
  permission: Permission;
  description: string;
  run: () => Promise<T>;
  /** Value returned in dry runs instead of running. */
  simulate: () => T;
  /** If the gate denies it, skip (return null) instead of blocking the run. */
  optional?: boolean;
  /**
   * Run even in dry-run mode. Only for read-only actions explicitly requested
   * by the operator (e.g. --with-agent-plan).
   */
  allowInDryRun?: boolean;
}

export interface StepContext<C> {
  run: RunRecord<C>;
  config: RepoConfig;
  configSource: string;
  adapters: Adapters;
  paths: Paths;
  dryRun: boolean;
  gate: PermissionGate;
  signal: AbortSignal;
  now(): Date;
  log(level: EventLevel, type: string, message: string, data?: unknown): void;
  /** Persist a context patch immediately (e.g. a session id before a long agent run). */
  save(patch: Partial<C>): void;
  effect<T>(opts: EffectOptions<T>): Promise<T | null>;
  writeArtifact(kind: string, label: string, filename: string, content: string): string;
  artifactDir: string;
  redactor: Redactor;
  throwIfStopped(): void;
  /** Read-only: the ledger status of this run's effect `key` (null when it never started). */
  effectStatus(key: string): EffectStatus | null;
  /** Read-only: other runs of this repository that use `branch` (branch-collision checks). */
  runsOnBranch(branch: string): Array<{ id: string; state: RunState; mode: RunMode }>;
}

export type Handler<C> = (ctx: StepContext<C>) => Promise<Outcome<C>>;

/**
 * The run as the operator saw it when they approved a resume (state, and for a BLOCKED run the
 * block itself). It authorizes leaving exactly that block, once, at the start of the drive.
 */
export interface ApprovedResume {
  state: RunState;
  blockedFrom: RunState | null;
  reason: string | null;
}

export interface EngineOptions {
  /**
   * An operator-approved resume. If the run is BLOCKED when the drive starts, on the same block
   * the operator approved, the drive re-enters the state it was blocked from (once). A run that
   * was not BLOCKED when resumed gets no unblock at all, and any block reached later in the drive
   * stops it: a new blocker always goes back to a person.
   */
  resume?: ApprovedResume;
  /** Progress lines for the terminal. */
  onEvent?: (line: { level: EventLevel; state: RunState; type: string; message: string }) => void;
  leaseTtlMs?: number;
  cancelPollMs?: number;
  /** Abort from outside (Ctrl-C): leaves the run resumable. */
  interrupt?: AbortSignal;
  /**
   * The run identity the caller authorized (mode, issue, repository). The drive uses these values,
   * never the stored ones: the store is a file an agent can write, so a dry run rewritten to
   * `supervised` mid-drive must not gain live effects. A stored value that differs stops the run.
   * Defaults to the run as read when the drive starts.
   */
  expect?: { mode: RunMode; issueKey: string; repo: string };
}

/**
 * A resume may leave a block only if the run was BLOCKED when the drive started, on the block the
 * operator approved (same state it was blocked from, same reason). A run approved at PLANNING that
 * another process has since blocked is not the run the operator approved.
 */
function mayLeaveBlock(run: { state: RunState; blockedFrom: RunState | null; reason: string | null }, approved: ApprovedResume | undefined): boolean {
  if (!approved || approved.state !== "BLOCKED" || run.state !== "BLOCKED" || !run.blockedFrom) return false;
  return approved.blockedFrom === run.blockedFrom && (approved.reason ?? null) === (run.reason ?? null);
}

function describeApproved(a: ApprovedResume): string {
  return a.state === "BLOCKED" ? `a block from ${a.blockedFrom ?? "?"}${a.reason ? ` (${a.reason})` : ""}` : `a run at ${a.state} (not blocked)`;
}

const TRANSIENT = /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|\bHTTP 5\d\d\b|rate limit|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Timeout)\b)/i;

export class Engine<C extends object> {
  constructor(
    private readonly deps: {
      store: Store;
      adapters: Adapters;
      config: RepoConfig;
      configSource: string;
      paths: Paths;
      redactor: Redactor;
      handlers: Partial<Record<RunState, Handler<C>>>;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async drive(runId: string, opts: EngineOptions = {}): Promise<RunRecord<C>> {
    const { store } = this.deps;
    const owner = `${hostName()}:${process.pid}:${randomBytes(3).toString("hex")}`;
    const ttl = opts.leaseTtlMs ?? 60_000;
    store.acquireLease(runId, owner, ttl);

    const controller = new AbortController();
    let stopKind: "cancel" | "interrupt" | null = null;
    const stop = (kind: "cancel" | "interrupt") => {
      if (!stopKind) {
        stopKind = kind;
        controller.abort(new StopError(kind));
      }
    };
    const onInterrupt = () => stop("interrupt");
    opts.interrupt?.addEventListener("abort", onInterrupt, { once: true });
    if (opts.interrupt?.aborted) stop("interrupt");

    const heartbeat = setInterval(() => {
      try {
        store.renewLease(runId, owner, ttl);
        if (store.isCancelRequested(runId)) stop("cancel");
      } catch {
        /* db busy: try next tick */
      }
    }, opts.cancelPollMs ?? 1_000);
    heartbeat.unref();

    const emit = (run: RunRecord<C>, level: EventLevel, type: string, message: string, data?: unknown) => {
      store.appendEvent(run.id, run.state, level, type, message, data);
      opts.onEvent?.({ level, state: run.state, type, message: this.deps.redactor.redact(message) });
    };

    const initial = store.getRun<C>(runId)!;
    const pinned = opts.expect ?? { mode: initial.mode, issueKey: initial.issueKey, repo: initial.repo };
    // Decided once, from the run as it is before any step runs; never re-armed during the drive.
    let mayUnblock = mayLeaveBlock(initial, opts.resume);
    if (opts.resume && initial.state === "BLOCKED" && !mayUnblock) {
      emit(
        initial,
        "warn",
        "run.resume_refused",
        `Not unblocked: the approved resume was for ${describeApproved(opts.resume)}, but the run is BLOCKED${initial.blockedFrom ? ` from ${initial.blockedFrom}` : ""}${initial.reason ? `: ${initial.reason}` : ""}. Resume again to approve this block.`,
      );
    }
    try {
      for (;;) {
        let run = store.getRun<C>(runId)!;
        if (TERMINAL_STATES.has(run.state)) return run;
        if (run.mode !== pinned.mode || run.issueKey !== pinned.issueKey || run.repo !== pinned.repo) {
          const message = `run identity changed in the store during the drive (expected ${pinned.mode} ${pinned.issueKey} on ${pinned.repo}, found ${run.mode} ${run.issueKey} on ${run.repo}); stopped without further effects`;
          emit(run, "error", "safety.violation", message);
          return store.transition<C>(run.id, run.version, { to: "FAILED", reason: message });
        }
        if (run.cancelRequested || stopKind === "cancel") {
          run = store.transition<C>(run.id, run.version, { to: "CANCELLED", reason: "cancelled by operator" });
          opts.onEvent?.({ level: "warn", state: run.state, type: "run.cancelled", message: "Run cancelled" });
          return run;
        }
        if (stopKind === "interrupt") {
          emit(run, "warn", "run.interrupted", `Interrupted during ${run.state}; resume with: orchestrator resume ${run.id}`);
          return run;
        }
        if (run.state === "BLOCKED") {
          if (mayUnblock && run.blockedFrom) {
            mayUnblock = false;
            run = store.transition<C>(run.id, run.version, {
              to: run.blockedFrom,
              event: { type: "run.resumed", message: `Resumed: re-entering ${run.blockedFrom}${run.reason ? ` (operator approved leaving: ${run.reason})` : ""}` },
            });
            opts.onEvent?.({ level: "info", state: run.state, type: "run.resumed", message: `Resumed at ${run.state}` });
            continue;
          }
          return run;
        }

        // Any block from here on was never shown to the operator: it ends the drive.
        mayUnblock = false;
        const handler = this.deps.handlers[run.state];
        if (!handler) throw new Error(`no handler for state ${run.state}`);
        const before = run.state;
        opts.onEvent?.({ level: "info", state: run.state, type: "step.started", message: `${run.state}` });

        const outcome = await this.runStep(run, pinned.mode, handler, controller.signal, emit, () => {
          if (stopKind) throw new StopError(stopKind);
        });

        run = store.getRun<C>(runId)!;
        if (stopKind === "cancel" || run.cancelRequested) {
          store.transition<C>(run.id, run.version, { to: "CANCELLED", reason: "cancelled by operator", ...(outcome?.patch ? { contextPatch: outcome.patch } : {}) });
          opts.onEvent?.({ level: "warn", state: "CANCELLED", type: "run.cancelled", message: "Run cancelled" });
          return store.getRun<C>(runId)!;
        }
        if (!outcome) continue; // interrupted: loop reports it
        run = store.transition<C>(run.id, run.version, {
          to: outcome.to,
          reason: outcome.reason ?? null,
          ...(outcome.patch ? { contextPatch: outcome.patch } : {}),
          ...(outcome.attempt !== undefined ? { attempt: outcome.attempt } : {}),
        });
        opts.onEvent?.({
          level: outcome.to === "BLOCKED" || outcome.to === "FAILED" ? "warn" : "info",
          state: run.state,
          type: "state.changed",
          message: `${before} → ${outcome.to}${outcome.reason ? `: ${outcome.reason}` : ""}`,
        });
        // A state that re-enters itself made no progress (e.g. CI still pending): hand back to the operator.
        if (outcome.to === before) return run;
      }
    } finally {
      clearInterval(heartbeat);
      opts.interrupt?.removeEventListener("abort", onInterrupt);
      store.releaseLease(runId, owner);
    }
  }

  private async runStep(
    run: RunRecord<C>,
    mode: RunMode,
    handler: Handler<C>,
    signal: AbortSignal,
    emit: (run: RunRecord<C>, level: EventLevel, type: string, message: string, data?: unknown) => void,
    throwIfStopped: () => void,
  ): Promise<Outcome<C> | null> {
    for (let attempt = 1; ; attempt++) {
      const ctx = this.context(run, mode, signal, emit, throwIfStopped);
      try {
        return await handler(ctx);
      } catch (err) {
        if (err instanceof StopError || signal.aborted) return null;
        if (err instanceof BlockedError) return { to: "BLOCKED", reason: err.message };
        if (err instanceof FailedError) {
          emit(run, "error", "safety.violation", err.message);
          return { to: "FAILED", reason: err.message };
        }
        const message = this.deps.redactor.redact((err as Error).message ?? String(err));
        if (TRANSIENT.test(message) && attempt < 3) {
          emit(run, "warn", "step.retry", `Transient error in ${run.state} (attempt ${attempt}/3): ${message}`);
          await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
          run = this.deps.store.getRun<C>(run.id)!;
          continue;
        }
        emit(run, "error", "step.error", `${run.state} failed: ${message}`, { stack: (err as Error).stack?.split("\n").slice(0, 6) });
        // Unexpected errors park the run; the operator can fix the cause and resume.
        return { to: "BLOCKED", reason: `error in ${run.state}: ${message}` };
      }
    }
  }

  private context(
    run: RunRecord<C>,
    mode: RunMode,
    signal: AbortSignal,
    emit: (run: RunRecord<C>, level: EventLevel, type: string, message: string, data?: unknown) => void,
    throwIfStopped: () => void,
  ): StepContext<C> {
    const { store, redactor } = this.deps;
    // The pinned mode, not run.mode: see EngineOptions.expect.
    const dryRun = mode === "dry_run";
    const gate = new PermissionGate(this.deps.config.permissions, mode);
    const artifactDir = join(this.deps.paths.runs, run.id);
    mkdirSync(artifactDir, { recursive: true });
    let current = run;

    const ctx: StepContext<C> = {
      get run() {
        return current;
      },
      config: this.deps.config,
      configSource: this.deps.configSource,
      adapters: this.deps.adapters,
      paths: this.deps.paths,
      dryRun,
      gate,
      signal,
      artifactDir,
      redactor,
      now: () => this.now(),
      throwIfStopped,
      effectStatus: (key) => store.getEffect(current.id, key)?.status ?? null,
      runsOnBranch: (branch) => store.runsOnBranch(current.repo, branch).filter((r) => r.id !== current.id),
      log: (level, type, message, data) => emit(current, level, type, message, data),
      save: (patch) => {
        current = store.patchContext<C>(current.id, patch);
      },
      writeArtifact: (kind, label, filename, content) => {
        const path = join(artifactDir, filename);
        const safe = redactor.redact(content);
        writeFileSync(path, safe);
        store.recordArtifact({
          runId: current.id,
          kind,
          label,
          path,
          sha256: createHash("sha256").update(safe).digest("hex"),
          bytes: Buffer.byteLength(safe),
        });
        return path;
      },
      effect: async <T>(o: EffectOptions<T>): Promise<T | null> => {
        throwIfStopped();
        const prior = store.getEffect(current.id, o.key);
        if (prior?.status === "completed") {
          emit(current, "debug", "effect.reused", `Already done: ${o.description}`, { key: o.key });
          return prior.result as T;
        }
        if (dryRun && !o.allowInDryRun) {
          const would = PermissionGate.wouldAllow(this.deps.config.permissions, o.permission);
          store.putEffect({ runId: current.id, key: o.key, permission: o.permission, status: "simulated", description: o.description, result: null, error: null });
          emit(current, "info", "effect.simulated", `Would ${o.description}${would.allowed ? "" : ` (a live run would skip/block: ${would.reason})`}`, {
            key: o.key,
            permission: o.permission,
          });
          return o.simulate();
        }
        if (!(dryRun && o.allowInDryRun)) {
          const decision = gate.check(o.permission);
          if (!decision.allowed) {
            if (o.optional) {
              emit(current, "info", "effect.skipped", `Skipped: ${o.description} (${decision.reason})`, { key: o.key });
              return null;
            }
            throw new BlockedError(`not permitted to ${o.description}: ${decision.reason}`);
          }
        }
        store.putEffect({ runId: current.id, key: o.key, permission: o.permission, status: "started", description: o.description, result: null, error: null });
        emit(current, "info", "effect.started", o.description, { key: o.key, permission: o.permission });
        try {
          const result = await o.run();
          if (signal.aborted) {
            // A result produced while stopping (e.g. a killed agent) is not a completed action:
            // leave it re-runnable so `resume` does the work again instead of reusing a partial result.
            store.putEffect({ runId: current.id, key: o.key, permission: o.permission, status: "failed", description: o.description, result: null, error: "interrupted" });
            throwIfStopped();
          }
          store.putEffect({ runId: current.id, key: o.key, permission: o.permission, status: "completed", description: o.description, result: result ?? null, error: null });
          emit(current, "info", "effect.completed", `Done: ${o.description}`, { key: o.key });
          return result;
        } catch (err) {
          store.putEffect({ runId: current.id, key: o.key, permission: o.permission, status: "failed", description: o.description, result: null, error: (err as Error).message });
          throw err;
        }
      },
    };
    return ctx;
  }
}
