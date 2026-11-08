import type { App } from "../app.js";
import { IntakeError, RunError } from "../app.js";
import { TERMINAL_STATES } from "../core/states.js";
import type { RunRecord } from "../core/store.js";
import type { RunContext } from "../core/workflow.js";
import { looksLikeIssueRef, parseIssueRef } from "./issue-ref.js";
import { selectRepository } from "./resolve.js";

/**
 * `status`, `resume` and `review` accept a run id (or unique prefix) or an issue reference. An issue
 * reference is narrowed to the repository of the working directory when it can be identified, so
 * "resume BRU-488" from Analyticool never picks up a BRU-488 run on another repository.
 */

export type Run = RunRecord<RunContext>;

export async function runsForTarget(app: App, target: string, opts: { cwd?: string; repo?: string } = {}): Promise<{ byId: Run | null; issueKey: string | null; repo: string | null; runs: Run[] }> {
  // Issue references never go through run-id prefix matching: SQLite LIKE is case-insensitive, so
  // "BRU-488" would otherwise match the run id "bru-488-1a2b3c" and skip the repository narrowing.
  if (!looksLikeIssueRef(target)) {
    const byId = app.store.findRun<RunContext>(target);
    if (byId) return { byId, issueKey: byId.issueKey, repo: byId.repo, runs: [byId] };
    throw new RunError(`no run matches "${target}" and it is not an issue key or Linear URL (see: orchestrator status)`);
  }
  const key = parseIssueRef(target).key;
  let repo = opts.repo ?? null;
  if (!repo) {
    const sel = await selectRepository({ cwd: opts.cwd ?? process.cwd(), issueKey: key, paths: app.paths, deps: app.discovery }).catch(() => null);
    // Only a repository identified from the working directory narrows the search; a team mapping is a guess.
    if (sel?.status === "resolved" && sel.source === "cwd") repo = sel.repo;
  }
  return { byId: null, issueKey: key, repo, runs: app.store.runsFor(key, repo ?? undefined, 20) as Run[] };
}

/** The run `resume` should continue: the only non-terminal one, preferring a live run over dry runs. */
export async function resumableRun(app: App, target: string, opts: { cwd?: string; repo?: string } = {}): Promise<Run> {
  const found = await runsForTarget(app, target, opts);
  if (found.byId) return found.byId;
  const open = found.runs.filter((r) => !TERMINAL_STATES.has(r.state));
  const where = found.repo ? ` on ${found.repo}` : "";
  if (open.length === 0) throw new IntakeError("no_run", `no resumable run for ${found.issueKey}${where} (finished runs: ${found.runs.map((r) => `${r.id} ${r.state}`).join(", ") || "none"}); start one with: orchestrator run ${found.issueKey}`);
  const live = open.filter((r) => r.mode === "supervised");
  if (live.length === 1) return live[0]!;
  if (live.length === 0 && open.length === 1) return open[0]!;
  throw new IntakeError("active_run_exists", `several runs for ${found.issueKey}${where} could be resumed: ${open.map((r) => `${r.id} (${r.mode} ${r.state}, ${r.repo})`).join(", ")}; name one by id`);
}

/** The newest run with review results (live runs first). */
export async function reviewedRun(app: App, target: string, opts: { cwd?: string; repo?: string } = {}): Promise<Run> {
  const found = await runsForTarget(app, target, opts);
  if (found.byId) return found.byId;
  const reviewed = found.runs.filter((r) => (r.context.rounds ?? []).some((x) => x.review));
  const pick = reviewed.find((r) => r.mode === "supervised") ?? reviewed[0];
  if (!pick) throw new RunError(`no run for ${found.issueKey}${found.repo ? ` on ${found.repo}` : ""} has review results yet${found.runs.length ? ` (runs: ${found.runs.map((r) => `${r.id} ${r.mode} ${r.state}`).join(", ")})` : ""}`);
  return pick;
}
