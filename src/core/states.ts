/**
 * Run lifecycle. The transition table is the single source of truth: the
 * store refuses any transition that is not listed here.
 */

export const RUN_STATES = [
  "QUEUED",
  "PLANNING",
  "IMPLEMENTING",
  "TESTING",
  "REVIEWING",
  "FIXING",
  "PR_OPEN",
  "WAITING_FOR_CI",
  "READY_TO_MERGE",
  "MERGED",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

/** No further work will ever happen. */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * The engine stops driving and returns control to the operator. `resume`
 * re-enters the state's handler (BLOCKED re-enters the state it blocked from).
 */
export const RESTING_STATES: ReadonlySet<RunState> = new Set(["BLOCKED", "READY_TO_MERGE", "WAITING_FOR_CI"]);

const ALWAYS_ALLOWED: RunState[] = ["BLOCKED", "FAILED", "CANCELLED"];

const TRANSITIONS: Record<RunState, RunState[]> = {
  QUEUED: ["PLANNING"],
  PLANNING: ["IMPLEMENTING"],
  IMPLEMENTING: ["TESTING"],
  TESTING: ["REVIEWING", "FIXING"],
  REVIEWING: ["PR_OPEN", "FIXING"],
  FIXING: ["TESTING"],
  PR_OPEN: ["WAITING_FOR_CI"],
  WAITING_FOR_CI: ["READY_TO_MERGE", "FIXING", "WAITING_FOR_CI"],
  // COMPLETED directly from READY_TO_MERGE only ends a dry run (nothing was merged).
  READY_TO_MERGE: ["MERGED", "WAITING_FOR_CI", "READY_TO_MERGE", "COMPLETED"],
  MERGED: ["COMPLETED"],
  COMPLETED: [],
  // BLOCKED may return to any working state (the one it was blocked from).
  BLOCKED: ["QUEUED", "PLANNING", "IMPLEMENTING", "TESTING", "REVIEWING", "FIXING", "PR_OPEN", "WAITING_FOR_CI", "READY_TO_MERGE"],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  if (TERMINAL_STATES.has(from)) return false;
  if (from !== "BLOCKED" && ALWAYS_ALLOWED.includes(to)) return true;
  if (from === "BLOCKED" && (to === "FAILED" || to === "CANCELLED")) return true;
  return TRANSITIONS[from].includes(to);
}

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}
