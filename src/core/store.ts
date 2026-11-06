import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canTransition, type RunState } from "./states.js";
import type { Redactor } from "./redact.js";

export type RunMode = "dry_run" | "supervised";

export interface RunRecord<C = unknown> {
  id: string;
  issueKey: string;
  repo: string;
  mode: RunMode;
  state: RunState;
  /** For BLOCKED runs, the state to re-enter on resume. */
  blockedFrom: RunState | null;
  reason: string | null;
  attempt: number;
  context: C;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type EventLevel = "debug" | "info" | "warn" | "error";

export interface RunEvent {
  id: number;
  runId: string;
  ts: string;
  level: EventLevel;
  state: RunState;
  type: string;
  message: string;
  data: unknown;
}

export interface ArtifactRecord {
  id: number;
  runId: string;
  kind: string;
  label: string;
  path: string;
  sha256: string;
  bytes: number;
  createdAt: string;
}

export type EffectStatus = "started" | "completed" | "failed" | "simulated";

export interface EffectRecord {
  runId: string;
  key: string;
  permission: string;
  status: EffectStatus;
  description: string;
  result: unknown;
  error: string | null;
  updatedAt: string;
}

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      issue_key TEXT NOT NULL,
      repo TEXT NOT NULL,
      mode TEXT NOT NULL,
      state TEXT NOT NULL,
      blocked_from TEXT,
      reason TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      context TEXT NOT NULL DEFAULT '{}',
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX runs_by_issue ON runs(issue_key, repo);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      state TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX events_by_run ON events(run_id, id);
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE effects (
      run_id TEXT NOT NULL REFERENCES runs(id),
      key TEXT NOT NULL,
      permission TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT NOT NULL,
      result TEXT,
      error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, key)
    );
  `,
};

interface RunRow {
  id: string;
  issue_key: string;
  repo: string;
  mode: string;
  state: string;
  blocked_from: string | null;
  reason: string | null;
  attempt: number;
  context: string;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  version: number;
}

export class TransitionError extends Error {
  override name = "TransitionError";
}

export class LeaseError extends Error {
  override name = "LeaseError";
}

export interface TransitionInput<C> {
  to: RunState;
  reason?: string | null;
  contextPatch?: Partial<C>;
  attempt?: number;
  blockedFrom?: RunState | null;
  event?: { type: string; message: string; level?: EventLevel; data?: unknown };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(
    file: string,
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version + 1; v <= SCHEMA_VERSION; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v}`);
      });
    }
  }

  close(): void {
    this.db.close();
  }

  /** BEGIN IMMEDIATE takes the write lock up front, so read-modify-write is safe across processes. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private iso(): string {
    return this.now().toISOString();
  }

  createRun<C>(input: { id: string; issueKey: string; repo: string; mode: RunMode; context: C }): RunRecord<C> {
    const ts = this.iso();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO runs (id, issue_key, repo, mode, state, context, created_at, updated_at) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?)`,
        )
        .run(input.id, input.issueKey, input.repo, input.mode, JSON.stringify(input.context), ts, ts);
      this.insertEvent(input.id, "QUEUED", "info", "run.created", `Run created for ${input.issueKey} on ${input.repo} (${input.mode})`, null);
    });
    return this.getRun<C>(input.id)!;
  }

  getRun<C = unknown>(id: string): RunRecord<C> | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRecord<C>(row) : null;
  }

  /** Accepts a unique id prefix for convenience. */
  findRun<C = unknown>(idOrPrefix: string): RunRecord<C> | null {
    const exact = this.getRun<C>(idOrPrefix);
    if (exact) return exact;
    const rows = this.db.prepare("SELECT * FROM runs WHERE id LIKE ? LIMIT 2").all(`${idOrPrefix}%`) as unknown as RunRow[];
    return rows.length === 1 ? toRecord<C>(rows[0]!) : null;
  }

  listRuns(limit = 20): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as unknown as RunRow[];
    return rows.map((r) => toRecord(r));
  }

  /** Active (non-terminal) runs for the same issue and repo, to prevent duplicate work. */
  activeRunsFor(issueKey: string, repo: string): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE issue_key = ? AND repo = ? AND mode = 'supervised' AND state NOT IN ('COMPLETED','FAILED','CANCELLED')`,
      )
      .all(issueKey, repo) as unknown as RunRow[];
    return rows.map((r) => toRecord(r));
  }

  /**
   * Atomically move a run to a new state. Validates the transition, merges the
   * context patch, bumps the version and appends a timeline event.
   */
  transition<C>(id: string, expectedVersion: number, input: TransitionInput<C>): RunRecord<C> {
    this.tx(() => {
      const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
      if (!row) throw new TransitionError(`run ${id} not found`);
      if (row.version !== expectedVersion) {
        throw new TransitionError(`run ${id} changed concurrently (expected v${expectedVersion}, found v${row.version})`);
      }
      const from = row.state as RunState;
      if (!canTransition(from, input.to)) throw new TransitionError(`illegal transition ${from} -> ${input.to}`);
      const context = { ...(JSON.parse(row.context) as object), ...(input.contextPatch ?? {}) };
      const blockedFrom = input.to === "BLOCKED" ? (input.blockedFrom ?? from) : null;
      this.db
        .prepare(
          `UPDATE runs SET state = ?, reason = ?, blocked_from = ?, attempt = ?, context = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(input.to, input.reason ?? null, blockedFrom, input.attempt ?? row.attempt, JSON.stringify(context), this.iso(), id);
      const ev = input.event ?? { type: "state.changed", message: `${from} → ${input.to}${input.reason ? `: ${input.reason}` : ""}` };
      this.insertEvent(id, input.to, ev.level ?? "info", ev.type, ev.message, { from, to: input.to, ...(ev.data ? { detail: ev.data } : {}) });
    });
    return this.getRun<C>(id)!;
  }

  /** Persist context without changing state (e.g. a session id learned mid-step). */
  patchContext<C>(id: string, patch: Partial<C>): RunRecord<C> {
    this.tx(() => {
      const row = this.db.prepare("SELECT context FROM runs WHERE id = ?").get(id) as { context: string } | undefined;
      if (!row) throw new TransitionError(`run ${id} not found`);
      const context = { ...(JSON.parse(row.context) as object), ...patch };
      this.db.prepare("UPDATE runs SET context = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(context), this.iso(), id);
    });
    return this.getRun<C>(id)!;
  }

  requestCancel(id: string): void {
    this.db.prepare("UPDATE runs SET cancel_requested = 1, updated_at = ? WHERE id = ?").run(this.iso(), id);
  }

  isCancelRequested(id: string): boolean {
    const row = this.db.prepare("SELECT cancel_requested FROM runs WHERE id = ?").get(id) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  // ---- leases: one driver per run -------------------------------------------------

  acquireLease(id: string, owner: string, ttlMs: number): void {
    this.tx(() => {
      const row = this.db.prepare("SELECT lease_owner, lease_expires_at FROM runs WHERE id = ?").get(id) as
        | { lease_owner: string | null; lease_expires_at: number | null }
        | undefined;
      if (!row) throw new LeaseError(`run ${id} not found`);
      const nowMs = this.now().getTime();
      const held = row.lease_owner && row.lease_owner !== owner && (row.lease_expires_at ?? 0) > nowMs && leaseOwnerAlive(row.lease_owner);
      if (held) throw new LeaseError(`run ${id} is being driven by ${row.lease_owner}; use 'orchestrator status' or wait for it to stop`);
      this.db.prepare("UPDATE runs SET lease_owner = ?, lease_expires_at = ? WHERE id = ?").run(owner, nowMs + ttlMs, id);
    });
  }

  renewLease(id: string, owner: string, ttlMs: number): void {
    this.db
      .prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?")
      .run(this.now().getTime() + ttlMs, id, owner);
  }

  releaseLease(id: string, owner: string): void {
    this.db.prepare("UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?").run(id, owner);
  }

  leaseHolder(id: string): string | null {
    const row = this.db.prepare("SELECT lease_owner, lease_expires_at FROM runs WHERE id = ?").get(id) as
      | { lease_owner: string | null; lease_expires_at: number | null }
      | undefined;
    if (!row?.lease_owner || (row.lease_expires_at ?? 0) <= this.now().getTime() || !leaseOwnerAlive(row.lease_owner)) return null;
    return row.lease_owner;
  }

  // ---- timeline ------------------------------------------------------------------

  appendEvent(runId: string, state: RunState, level: EventLevel, type: string, message: string, data?: unknown): void {
    this.insertEvent(runId, state, level, type, message, data ?? null);
  }

  private insertEvent(runId: string, state: RunState, level: EventLevel, type: string, message: string, data: unknown): void {
    this.db
      .prepare("INSERT INTO events (run_id, ts, level, state, type, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        runId,
        this.iso(),
        level,
        state,
        type,
        this.redactor.redact(message),
        data === null || data === undefined ? null : JSON.stringify(this.redactor.redactValue(data)),
      );
  }

  events(runId: string, opts: { afterId?: number; limit?: number } = {}): RunEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(runId, opts.afterId ?? 0, opts.limit ?? 10_000) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      ts: r.ts as string,
      level: r.level as EventLevel,
      state: r.state as RunState,
      type: r.type as string,
      message: r.message as string,
      data: r.data ? JSON.parse(r.data as string) : null,
    }));
  }

  // ---- artifacts -----------------------------------------------------------------

  recordArtifact(a: Omit<ArtifactRecord, "id" | "createdAt">): void {
    this.db
      .prepare("INSERT INTO artifacts (run_id, kind, label, path, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(a.runId, a.kind, a.label, a.path, a.sha256, a.bytes, this.iso());
  }

  artifacts(runId: string): ArtifactRecord[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY id").all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      kind: r.kind as string,
      label: r.label as string,
      path: r.path as string,
      sha256: r.sha256 as string,
      bytes: r.bytes as number,
      createdAt: r.created_at as string,
    }));
  }

  // ---- effect ledger: idempotent external actions --------------------------------

  getEffect(runId: string, key: string): EffectRecord | null {
    const r = this.db.prepare("SELECT * FROM effects WHERE run_id = ? AND key = ?").get(runId, key) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      runId: r.run_id as string,
      key: r.key as string,
      permission: r.permission as string,
      status: r.status as EffectStatus,
      description: r.description as string,
      result: r.result ? JSON.parse(r.result as string) : null,
      error: (r.error as string | null) ?? null,
      updatedAt: r.updated_at as string,
    };
  }

  putEffect(e: Omit<EffectRecord, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO effects (run_id, key, permission, status, description, result, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, key) DO UPDATE SET status = excluded.status, result = excluded.result, error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(
        e.runId,
        e.key,
        e.permission,
        e.status,
        this.redactor.redact(e.description),
        e.result === null || e.result === undefined ? null : JSON.stringify(this.redactor.redactValue(e.result)),
        e.error ? this.redactor.redact(e.error) : null,
        this.iso(),
      );
  }

  effects(runId: string): EffectRecord[] {
    const rows = this.db.prepare("SELECT key FROM effects WHERE run_id = ? ORDER BY rowid").all(runId) as Array<{ key: string }>;
    return rows.map((r) => this.getEffect(runId, r.key)!);
  }
}

function toRecord<C>(row: RunRow): RunRecord<C> {
  return {
    id: row.id,
    issueKey: row.issue_key,
    repo: row.repo,
    mode: row.mode as RunMode,
    state: row.state as RunState,
    blockedFrom: (row.blocked_from as RunState | null) ?? null,
    reason: row.reason,
    attempt: row.attempt,
    context: JSON.parse(row.context) as C,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/** Lease owners are "<host>:<pid>:<nonce>". A dead local pid frees the lease early. */
function leaseOwnerAlive(owner: string): boolean {
  const [host, pidText] = owner.split(":");
  const pid = Number(pidText);
  if (host !== hostName() || !Number.isInteger(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function hostName(): string {
  return hostname().replace(/:/g, "-");
}
