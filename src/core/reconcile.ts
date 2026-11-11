import { randomBytes } from "node:crypto";
import type { CodeHost, PullRequestStatus } from "../adapters/types.js";
import type { RunState } from "./states.js";
import { hostName, LeaseError, type RunRecord, type Store } from "./store.js";
import type { RunContext } from "./workflow.js";

/** What the run records about the merge a person made: who, when, and whether it was the reviewed commit. */
export type MergeRecord = NonNullable<RunContext["merged"]>;

/** States from which a PR's fate can be recorded without driving the run. */
const RECONCILABLE: ReadonlySet<RunState> = new Set(["WAITING_FOR_CI", "READY_TO_MERGE", "BLOCKED", "MERGED"]);

export function reconcilable(run: RunRecord<RunContext>): boolean {
  return run.mode === "supervised" && Boolean(run.context.pr) && RECONCILABLE.has(run.state);
}

/**
 * The merge as GitHub reports it. When the merged head is not the commit the engine reviewed, the
 * commits added outside the engine are listed (read-only compare), so the history says exactly what
 * the independent review did and did not cover.
 */
export async function mergeRecord(codeHost: CodeHost, repo: string, pr: PullRequestStatus, reviewedSha: string | null | undefined, recordedBy: MergeRecord["recordedBy"]): Promise<MergeRecord> {
  const headIsReviewed = Boolean(reviewedSha) && pr.headSha === reviewedSha;
  let outsideCommits: MergeRecord["outsideCommits"] = headIsReviewed ? [] : null;
  if (!headIsReviewed && reviewedSha) {
    outsideCommits = await codeHost.compareCommits(repo, reviewedSha, pr.headSha).catch(() => null);
  }
  return {
    at: pr.mergedAt ?? null,
    by: pr.mergedBy ?? null,
    mergeCommitSha: pr.mergeCommitSha ?? null,
    headSha: pr.headSha,
    reviewedSha: reviewedSha ?? null,
    headIsReviewed,
    outsideCommits,
    recordedBy,
  };
}

export function describeMerge(pr: { number: number }, m: MergeRecord): string {
  const who = m.by ? ` by ${m.by}` : "";
  const when = m.at ? ` at ${m.at}` : "";
  if (m.headIsReviewed) return `PR #${pr.number} merged${who}${when} at the reviewed commit ${m.headSha.slice(0, 8)}`;
  const n = m.outsideCommits?.length;
  return `PR #${pr.number} merged${who}${when} at ${m.headSha.slice(0, 8)}, not the reviewed commit ${m.reviewedSha?.slice(0, 8) ?? "(none)"}: ${n === undefined || n === null ? "commits" : `${n} commit(s)`} added outside Orchestrator, not reviewed by it`;
}

export interface ReconcileResult {
  run: RunRecord<RunContext>;
  changed: boolean;
  /** Why nothing changed, when nothing did. */
  note: string | null;
}

/**
 * Record a person's decision on the run's PR: merged → MERGED → COMPLETED, closed → CANCELLED.
 * Read-only towards the outside: it reads the PR (and a commit comparison) and writes only the
 * run's own record. It never pushes, merges, edits the PR or runs a step handler, so it needs no
 * approval in any mode. A run a process is driving is left alone (that process records it).
 */
export async function reconcileRun(store: Store, codeHost: CodeHost, runId: string): Promise<ReconcileResult> {
  let run = store.getRun<RunContext>(runId)!;
  if (!reconcilable(run)) return { run, changed: false, note: `nothing to reconcile at ${run.state}` };
  const owner = `${hostName()}:${process.pid}:reconcile-${randomBytes(3).toString("hex")}`;
  try {
    store.acquireLease(runId, owner, 60_000);
  } catch (err) {
    if (err instanceof LeaseError) return { run, changed: false, note: "a process is driving this run; it records the outcome itself" };
    throw err;
  }
  try {
    run = store.getRun<RunContext>(runId)!;
    if (!reconcilable(run)) return { run, changed: false, note: `nothing to reconcile at ${run.state}` };
    const ref = run.context.pr!;
    // A crash between MERGED and COMPLETED: finish the record.
    if (run.state === "MERGED") {
      run = store.transition<RunContext>(run.id, run.version, { to: "COMPLETED", reason: run.context.merged ? completionReason(run.context.merged) : "merged" });
      return { run, changed: true, note: null };
    }
    const pr = await codeHost.getPullRequest(run.repo, ref.number);
    if (pr.state === "OPEN") return { run, changed: false, note: `PR #${ref.number} is still open` };
    if (pr.state === "CLOSED") {
      run = store.transition<RunContext>(run.id, run.version, {
        to: "CANCELLED",
        reason: `PR #${ref.number} was closed without merging`,
        event: { type: "pr.closed", message: `PR #${ref.number} was closed without merging; recorded without driving the run` },
      });
      return { run, changed: true, note: null };
    }
    const merged = await mergeRecord(codeHost, run.repo, pr, run.context.reviewedSha, "reconcile");
    const message = describeMerge(ref, merged);
    if (run.state !== "READY_TO_MERGE") {
      run = store.transition<RunContext>(run.id, run.version, { to: "READY_TO_MERGE", reason: `PR #${ref.number} was merged`, event: { type: "reconcile.merged", message: `${message}; recorded without driving the run` } });
    }
    run = store.transition<RunContext>(run.id, run.version, { to: "MERGED", reason: message, contextPatch: { merged }, event: { type: "pr.merged", message, data: merged } });
    run = store.transition<RunContext>(run.id, run.version, { to: "COMPLETED", reason: completionReason(merged) });
    return { run, changed: true, note: null };
  } finally {
    store.releaseLease(runId, owner);
  }
}

export function completionReason(m: MergeRecord): string {
  return m.headIsReviewed ? "merged" : `merged with ${m.outsideCommits ? `${m.outsideCommits.length} commit(s)` : "commits"} added outside Orchestrator`;
}
