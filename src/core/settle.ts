import { existsSync } from "node:fs";
import type { App } from "../app.js";
import { loadRepoConfig, loadRepoConfigFile, type LoadedRepoConfig } from "../config/load.js";
import { notificationFor, writeDeliveryReport, type DeliveryReport } from "../report/delivery.js";
import { reconcilable, reconcileRun } from "./reconcile.js";
import { TERMINAL_STATES } from "./states.js";
import type { RunRecord } from "./store.js";
import type { RunContext } from "./workflow.js";

/**
 * After a drive or a reconciliation: write the run's delivery report and send the one notification
 * its state deserves, if it was not sent before (deduplicated through `notify.sent` timeline
 * events, so a crash, a restart or a second process never repeats one, and a missed one is sent
 * the next time anything settles the run). Never throws: reporting must not break a run.
 */
const NOTIFY_WITHIN_MS = 24 * 60 * 60_000;
const RECONCILE_BUDGET_MS = 30_000;

export async function settleRun(app: App, run: RunRecord<RunContext>): Promise<{ report: DeliveryReport; path: string } | null> {
  if (run.mode !== "supervised") return null;
  let written: { report: DeliveryReport; path: string };
  try {
    written = writeDeliveryReport(app.store, app.paths.runs, app.redactor, run);
  } catch (err) {
    app.store.appendEvent(run.id, run.state, "warn", "report.failed", `Could not write the delivery report: ${(err as Error).message}`);
    return null;
  }
  // A notification is news only about a recent change: an old run looked at again, or a PR merged
  // long ago and only now recorded (first status after an upgrade), stays quiet.
  const changedAt = Date.parse(run.context.merged?.at ?? run.updatedAt);
  const n = Date.now() - changedAt < NOTIFY_WITHIN_MS && app.notifier.name !== "none" ? notificationFor(app.store, run, written.report) : null;
  if (n && !app.store.events(run.id).some((e) => e.type === "notify.sent" && (e.data as { key?: string } | null)?.key === n.key)) {
    // Claimed before sending: two concurrent settles can't both send it. A failed send is logged, not retried.
    const message = app.redactor.redact(n.message);
    app.store.appendEvent(run.id, run.state, "info", "notify.sent", `Notifying (${app.notifier.name}): ${message}`, { key: n.key });
    const res = await app.notifier.send({ ...n, message }).catch((err: Error) => ({ ok: false, detail: err.message }));
    if (!res.ok) app.store.appendEvent(run.id, run.state, "warn", "notify.failed", `Notification failed (${app.notifier.name}): ${res.detail}`, { key: n.key });
  }
  return written;
}

function configFor(app: App, run: RunRecord<RunContext>): LoadedRepoConfig {
  const source = run.context.configSource;
  return source && existsSync(source) ? loadRepoConfigFile(source) : loadRepoConfig(run.repo, app.paths);
}

/**
 * Record what happened to the PRs of these runs (merged → COMPLETED, closed → CANCELLED), read-only
 * towards GitHub and without approval, then settle each. Best effort: a run that cannot be checked
 * now (no network, gh logged out) is left as it is and reported in the timeline.
 */
export async function reconcileRuns(app: App, runs: Array<RunRecord<RunContext>>, loaded?: LoadedRepoConfig): Promise<Array<RunRecord<RunContext>>> {
  const out: Array<RunRecord<RunContext>> = [];
  // GitHub unreachable must not make status, context or a new run slow: stop at the first failure
  // and stay within a total budget; the remaining runs are checked next time.
  const deadline = Date.now() + RECONCILE_BUDGET_MS;
  let unreachable = false;
  for (const candidate of runs) {
    if (!reconcilable(candidate) || unreachable || Date.now() > deadline) {
      out.push(candidate);
      continue;
    }
    try {
      const cfg = loaded && loaded.config.repo === candidate.repo ? loaded : configFor(app, candidate);
      const { run, changed } = await reconcileRun(app.store, app.adaptersFor(cfg).codeHost, candidate.id);
      if (changed) await settleRun(app, run);
      out.push(run);
    } catch (err) {
      unreachable = true;
      // Once an hour at most per run: an offline laptop must not fill the timeline.
      const last = [...app.store.events(candidate.id)].reverse().find((e) => e.type === "reconcile.failed");
      if (!last || Date.now() - Date.parse(last.ts) > 60 * 60_000) {
        app.store.appendEvent(candidate.id, candidate.state, "warn", "reconcile.failed", `Could not check PR #${candidate.context.pr?.number} now (non-fatal; checked again later): ${(err as Error).message}`);
      }
      out.push(app.store.getRun<RunContext>(candidate.id) ?? candidate);
    }
  }
  return out;
}

export interface WatchOptions {
  intervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onCheck?: (run: RunRecord<RunContext>) => void;
}

/**
 * Follow one run until a person merges or closes its PR (or the run otherwise ends), then return.
 * A bounded foreground loop over read-only reconciliation: no daemon, no live effects, no approval.
 * A run in WAITING_FOR_CI is not driven here (that is a live step): only its PR's fate is recorded.
 */
export async function watchRun(app: App, id: string, opts: WatchOptions): Promise<{ run: RunRecord<RunContext>; settled: boolean }> {
  const deadline = Date.now() + opts.timeoutMs;
  let run = app.store.getRun<RunContext>(id)!;
  for (;;) {
    [run] = (await reconcileRuns(app, [run])) as [RunRecord<RunContext>];
    opts.onCheck?.(run);
    if (TERMINAL_STATES.has(run.state)) return { run, settled: true };
    if (!reconcilable(run) || Date.now() + opts.intervalMs > deadline || opts.signal?.aborted) return { run, settled: false };
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, opts.intervalMs);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    run = app.store.getRun<RunContext>(id)!;
  }
}
