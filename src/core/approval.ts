import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { RepoConfig } from "../config/schema.js";
import { runProcess } from "./exec.js";

/**
 * Human approval for actions that grant or use remote-write authority: starting (or resuming) a
 * live run, authorizing a repository, confirming an issue ↔ repository association.
 *
 * Trust model. The caller of this CLI is often an LLM agent with a full-access shell. Anything it
 * can type, it can forge: a `--yes` flag, an "approval" file, a row in the SQLite store. So no
 * approval is ever read from disk or from arguments. The engine asks a person, through a channel
 * the agent cannot answer, at the moment the action starts, and uses the answer only in that
 * same process:
 *
 *   - macOS: LocalAuthentication (Touch ID, Apple Watch or the login password), raised with
 *     `/usr/bin/osascript -l JavaScript`. The system draws the sheet and ignores synthetic input,
 *     so an agent cannot complete it. If it cannot be shown (no GUI session, e.g. over SSH), the
 *     action is refused: there is no weaker fallback on macOS.
 *   - Elsewhere: a confirmation typed on the controlling terminal (/dev/tty), with the issue key
 *     as the answer. Weaker: a process that allocates a pseudo-terminal can type it. Documented.
 *
 * What this does not stop: an agent that edits or bypasses Orchestrator's own code, or does the
 * work without Orchestrator at all. A full-access shell can do anything the user can. The goal is
 * that *Orchestrator* never becomes the vehicle for unapproved live work. See docs/skills.md.
 */

export type ApprovalPurpose = "live_run" | "resume_live_run" | "authorize_repository" | "confirm_association";

export interface ApprovalRequest {
  purpose: ApprovalPurpose;
  /** Shown in the system prompt: a verb phrase ("start a live Orchestrator run of BRU-488 on …"). */
  reason: string;
  /** Printed before prompting (the agent relays it; the person reads it). */
  details: string[];
  issue: string | null;
  repo: string;
  scopeHash: string;
}

export interface ApprovalResult {
  approved: boolean;
  channel: string;
  detail: string;
  at: string;
  user: string;
}

export interface Approver {
  readonly channel: string;
  request(req: ApprovalRequest): Promise<ApprovalResult>;
}

export class ApprovalError extends Error {
  override name = "ApprovalError";
}

export const APPROVAL_TIMEOUT_SECONDS = 180;

// ---- run scope ----------------------------------------------------------------------------

export interface RunScope {
  version: 1;
  issue: string;
  repo: string;
  configSource: string;
  permissions: RepoConfig["permissions"];
  merge: { mode: string; method: string; require_ci: boolean; require_independent_review: boolean; max_fix_attempts: number };
  agents: Record<string, string>;
  limits: RepoConfig["limits"];
  isolationRequired: boolean;
  acceptedDependencies: string[];
}

function agentLabel(a: RepoConfig["agents"]["implementer"]): string {
  if (a.adapter === "claude-code") return `claude-code:${a.permission_mode}${a.model ? `:${a.model}` : ""}`;
  if (a.adapter === "codex") return `codex:${a.sandbox}${a.model ? `:${a.model}` : ""}`;
  return `mock:${a.provider}`;
}

/** Everything a live run is allowed to do, in canonical form. Its hash binds an approval. */
export function runScope(input: { issue: string; config: RepoConfig; configSource: string; acceptedDependencies?: string[] }): { scope: RunScope; hash: string } {
  const c = input.config;
  const scope: RunScope = {
    version: 1,
    issue: input.issue.toUpperCase(),
    repo: c.repo.toLowerCase(),
    configSource: input.configSource,
    permissions: c.permissions,
    merge: { mode: c.merge.mode, method: c.merge.method, require_ci: c.merge.require_ci, require_independent_review: c.merge.require_independent_review, max_fix_attempts: c.merge.max_fix_attempts },
    agents: Object.fromEntries(Object.entries(c.agents).filter(([, v]) => v).map(([k, v]) => [k, agentLabel(v!)])),
    limits: c.limits,
    isolationRequired: c.isolation.require,
    acceptedDependencies: [...new Set((input.acceptedDependencies ?? []).map((k) => k.toUpperCase()))].sort(),
  };
  return { scope, hash: sha256(canonical(scope)) };
}

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Human-readable scope for the prompt and the printed details. */
export function describeScope(scope: RunScope, extra: { title?: string | null; lastDryRun?: string | null } = {}): { reason: string; details: string[] } {
  const p = scope.permissions;
  const actions = [`${scope.agents.implementer?.split(":")[0] ?? "the implementer"} implements in an isolated worktree`, `${scope.agents.reviewer?.split(":")[0] ?? "a reviewer"} reviews`];
  if (p.github.push) actions.push("pushes a branch");
  if (p.github.create_pr) actions.push("opens a draft PR");
  if (p.linear.comment || p.linear.update_state) actions.push("updates Linear");
  const reason = `start a live Orchestrator run of ${scope.issue} on ${scope.repo}: ${actions.join(", ")}; merge ${scope.merge.mode}; budget $${scope.limits.max_run_cost_usd}`;
  const details = [
    `Issue:       ${scope.issue}${extra.title ? ` — ${extra.title}` : ""}`,
    `Repository:  ${scope.repo}`,
    `Config:      ${scope.configSource}`,
    `Agents:      ${Object.entries(scope.agents).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `Permissions: push ${p.github.push}, draft PR ${p.github.create_pr}, merge ${p.github.merge}, Linear comment ${p.linear.comment}, Linear state ${p.linear.update_state}`,
    `Merge:       ${scope.merge.mode}${scope.merge.require_ci ? ", CI required" : ""}${scope.merge.require_independent_review ? ", independent review required" : ""}`,
    `Limits:      $${scope.limits.max_run_cost_usd}, ${scope.limits.max_run_minutes} min, ${scope.merge.max_fix_attempts} fix rounds`,
    ...(scope.acceptedDependencies.length ? [`Accepted:    ${scope.acceptedDependencies.join(", ")} (operator-accepted dependencies)`] : []),
    ...(extra.lastDryRun !== undefined ? [`Dry run:     ${extra.lastDryRun ?? "none yet for this issue"}`] : []),
  ];
  return { reason, details };
}

// ---- audit --------------------------------------------------------------------------------

/** Append-only record of every approval asked for, granted or refused. Audit only: never read back as authority. */
export function auditApproval(home: string, req: ApprovalRequest, res: ApprovalResult): void {
  const file = join(home, "audit", "approvals.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: res.at, purpose: req.purpose, issue: req.issue, repo: req.repo, scopeHash: req.scopeHash, approved: res.approved, channel: res.channel, detail: res.detail, user: res.user, pid: process.pid, cwd: process.cwd() })}\n`);
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

// ---- channels -----------------------------------------------------------------------------

/**
 * JXA for LocalAuthentication. Policy 2 = LAPolicyDeviceOwnerAuthentication (biometrics, watch or
 * password). Prints {"ok":bool,"code":n,"msg":s}. `canEvaluate` first, so an unavailable UI is
 * reported as such instead of as a refusal.
 */
const LA_SCRIPT = `
ObjC.import('LocalAuthentication');
ObjC.import('Foundation');
function run(argv) {
  const ctx = $.LAContext.alloc.init;
  const err = Ref();
  if (!ctx.canEvaluatePolicyError(2, err)) return JSON.stringify({ ok: false, unavailable: true, msg: err[0] ? ObjC.unwrap(err[0].localizedDescription) : 'not available' });
  let done = false, ok = false, code = null, msg = null;
  ctx.evaluatePolicyLocalizedReasonReply(2, argv[0], (success, error) => {
    ok = success;
    if (!success && error) { code = error.code; msg = ObjC.unwrap(error.localizedDescription); }
    done = true;
  });
  const deadline = $.NSDate.dateWithTimeIntervalSinceNow(Number(argv[1]));
  while (!done && $.NSDate.date.compare(deadline) < 0) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  if (!done) { ctx.invalidate; while (!done) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1)); msg = 'timed out'; }
  return JSON.stringify({ ok, code, msg });
}`;

export type Exec = (cmd: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

const realExec: Exec = async (cmd, args, timeoutMs) => {
  const r = await runProcess(cmd, args, { timeoutMs });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};

export function macosApprover(opts: { exec?: Exec; timeoutSeconds?: number; log?: (line: string) => void } = {}): Approver {
  const exec = opts.exec ?? realExec;
  const timeout = opts.timeoutSeconds ?? APPROVAL_TIMEOUT_SECONDS;
  const channel = "macos-local-authentication";
  return {
    channel,
    async request(req) {
      const at = new Date().toISOString();
      const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
      log(`Approval needed to ${req.reason}.`);
      for (const d of req.details) log(`  ${d}`);
      log(`Waiting up to ${timeout}s for Touch ID or your password in the macOS prompt on this Mac…`);
      // Absolute path: a PATH entry cannot stand in for the system's osascript.
      const r = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", LA_SCRIPT, req.reason, String(timeout)], (timeout + 30) * 1000).catch((err: Error) => ({ exitCode: 1, stdout: "", stderr: err.message }));
      let parsed: { ok?: boolean; unavailable?: boolean; code?: number | string | null; msg?: string | null } = {};
      try {
        parsed = JSON.parse(r.stdout.trim() || "{}");
      } catch {
        parsed = {};
      }
      const user = currentUser();
      if (parsed.ok === true) return { approved: true, channel, detail: "confirmed with Touch ID / password (LocalAuthentication)", at, user };
      if (parsed.unavailable || r.exitCode !== 0) {
        return { approved: false, channel, detail: `the macOS approval prompt is not available here (${parsed.msg ?? (r.stderr.trim() || `osascript exit ${r.exitCode}`)}); approve from a session on this Mac's desktop`, at, user };
      }
      return { approved: false, channel, detail: parsed.msg === "timed out" ? `no answer within ${timeout}s` : `refused or cancelled (${parsed.msg ?? `code ${parsed.code}`})`, at, user };
    },
  };
}

export interface TtyIo {
  write(text: string): void;
  readLine(): string;
  close(): void;
}

function openControllingTty(): TtyIo {
  const fd = openSync("/dev/tty", "r+");
  return {
    write: (t) => void writeSync(fd, t),
    readLine: () => {
      const buf = Buffer.alloc(256);
      const n = readSync(fd, buf, 0, buf.length, null);
      return buf.subarray(0, n).toString("utf8");
    },
    close: () => closeSync(fd),
  };
}

/** Non-macOS: type the issue key (or repository) on the controlling terminal (/dev/tty, not stdin). */
export function ttyApprover(opts: { openTty?: () => TtyIo } = {}): Approver {
  const channel = "controlling-terminal";
  return {
    channel,
    async request(req) {
      const at = new Date().toISOString();
      const user = currentUser();
      let tty: TtyIo;
      try {
        tty = (opts.openTty ?? openControllingTty)();
      } catch {
        return { approved: false, channel, detail: "no controlling terminal: run the command yourself in a terminal to approve it", at, user };
      }
      const expected = req.issue ?? req.repo;
      try {
        tty.write(`\nApproval needed to ${req.reason}.\n${req.details.map((d) => `  ${d}\n`).join("")}Type ${expected} to approve, anything else to refuse: `);
        return tty.readLine().trim() === expected ? { approved: true, channel, detail: "typed confirmation on the controlling terminal", at, user } : { approved: false, channel, detail: "refused on the terminal", at, user };
      } finally {
        tty.close();
      }
    },
  };
}

/**
 * Can this session show the approval prompt? No UI is shown: LocalAuthentication's canEvaluate
 * on macOS, a controlling terminal elsewhere. Used by `doctor` and `context` to warn early.
 */
export async function approvalChannelStatus(exec: Exec = realExec): Promise<{ channel: string; available: boolean; detail: string }> {
  if (process.platform === "darwin") {
    const script = "ObjC.import('LocalAuthentication'); function run() { const e = Ref(); const ok = $.LAContext.alloc.init.canEvaluatePolicyError(2, e); return JSON.stringify({ ok, msg: ok ? null : (e[0] ? ObjC.unwrap(e[0].localizedDescription) : 'not available') }); }";
    const r = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], 15_000).catch((err: Error) => ({ exitCode: 1, stdout: "", stderr: err.message }));
    let parsed: { ok?: boolean; msg?: string | null } = {};
    try {
      parsed = JSON.parse(r.stdout.trim() || "{}");
    } catch {
      parsed = {};
    }
    return parsed.ok
      ? { channel: "macos-local-authentication", available: true, detail: "live runs are confirmed with Touch ID / Apple Watch / login password in a macOS system prompt" }
      : { channel: "macos-local-authentication", available: false, detail: `the macOS approval prompt is unavailable (${parsed.msg ?? (r.stderr.trim() || "osascript failed")}): live runs cannot be approved from this session` };
  }
  try {
    closeSync(openSync("/dev/tty", "r+"));
    return { channel: "controlling-terminal", available: true, detail: "live runs are confirmed by typing the issue key on the controlling terminal (weaker than a system prompt)" };
  } catch {
    return { channel: "controlling-terminal", available: false, detail: "no controlling terminal: run `orchestrator run … --execute` yourself in a terminal to approve a live run" };
  }
}

export function systemApprover(): Approver {
  return process.platform === "darwin" ? macosApprover() : ttyApprover();
}
