import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probe, runProcess } from "../core/exec.js";
import type { AgentConfig } from "../config/schema.js";
import type { AgentResult, AgentRunner, AgentTask } from "./types.js";

type ClaudeConfig = Extract<AgentConfig, { adapter: "claude-code" }>;

/** Read-only tool set for planning: no edits, no shell. */
export const PLANNER_TOOLS = ["Read", "Grep", "Glob"];

const ROLE_RULES: Record<AgentTask["role"], string> = {
  planner: [
    "You are the PLANNER in a supervised engineering workflow run by an orchestrator.",
    "You can only read the repository. Do not attempt to modify files.",
    "Produce a concrete, minimal implementation plan grounded in files you actually read.",
    "List genuine open questions instead of guessing about product decisions.",
  ].join("\n"),
  implementer: [
    "You are the IMPLEMENTER in a supervised engineering workflow run by an orchestrator.",
    "Work only inside the current directory (a dedicated git worktree).",
    "Do not commit, push, open pull requests, or change git configuration: the orchestrator does that after verifying your work.",
    "Do not edit CI workflows, lockfiles you did not need to change, or secrets/env files.",
    "You cannot approve your own work. An independent reviewer and the orchestrator's own checks decide.",
    "When done, summarise what you changed and anything left unfinished. Be precise: unverified claims are discarded.",
  ].join("\n"),
  reviewer: "You are an independent REVIEWER. You can only read. Report findings; do not modify files.",
};

export class ClaudeCodeAgent implements AgentRunner {
  readonly id = "claude-code";
  readonly provider = "anthropic";

  constructor(
    private readonly config: ClaudeConfig,
    private readonly bin = "claude",
  ) {}

  args(task: Pick<AgentTask, "role" | "resumeSessionId" | "sessionId" | "outputSchema">): string[] {
    const a = ["-p", "--output-format", "json"];
    if (this.config.model) a.push("--model", this.config.model);
    if (task.role === "implementer") {
      // Edits are auto-accepted; anything else not allow-listed is denied (no human to prompt).
      a.push("--permission-mode", this.config.permission_mode, "--permission-prompts", "none");
      if (this.config.allowed_tools.length) a.push("--allowedTools", ...this.config.allowed_tools);
      a.push("--disallowedTools", ...new Set([...this.config.disallowed_tools, "Bash(git push:*)", "Bash(git commit:*)", "Bash(gh:*)"]));
    } else {
      a.push("--tools", PLANNER_TOOLS.join(","), "--permission-mode", "default", "--permission-prompts", "none");
    }
    if (this.config.max_budget_usd) a.push("--max-budget-usd", String(this.config.max_budget_usd));
    if (task.outputSchema) a.push("--json-schema", JSON.stringify(task.outputSchema));
    a.push("--append-system-prompt", ROLE_RULES[task.role]);
    if (task.resumeSessionId) a.push("--resume", task.resumeSessionId);
    else if (task.sessionId) a.push("--session-id", task.sessionId);
    return a;
  }

  describe(task: Omit<AgentTask, "signal" | "env">): string {
    const shown = this.args({ ...task, sessionId: task.resumeSessionId ? undefined : "<new-session-uuid>" }).map((x) =>
      x.includes("\n") || x.length > 80 ? `'<${x.length} chars>'` : /[\s()*]/.test(x) ? `'${x}'` : x,
    );
    return `(cd ${task.cwd} && ${this.bin} ${shown.join(" ")} < ${task.artifactPrefix}.prompt.md)`;
  }

  async run(task: AgentTask): Promise<AgentResult> {
    mkdirSync(task.artifactDir, { recursive: true });
    const sessionId = task.resumeSessionId ?? task.sessionId ?? crypto.randomUUID();
    const args = this.args({ ...task, sessionId });
    const result = await runProcess(this.bin, args, {
      cwd: task.cwd,
      env: childEnv(task.env),
      input: task.prompt,
      timeoutMs: task.timeoutMs,
      signal: task.signal,
    });
    const rawPath = join(task.artifactDir, `${task.artifactPrefix}.claude.json`);
    writeFileSync(rawPath, result.stdout || result.stderr);

    let parsed: { result?: string; session_id?: string; is_error?: boolean; total_cost_usd?: number; structured_output?: unknown; subtype?: string } = {};
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      /* non-JSON output: treated as failure below */
    }
    const ok = result.exitCode === 0 && parsed.is_error !== true && !result.timedOut && !result.aborted;
    const text = parsed.result ?? "";
    return {
      sessionId: parsed.session_id ?? sessionId,
      text,
      structured: parsed.structured_output ?? tryJson(text),
      ok,
      error: ok
        ? null
        : result.timedOut
          ? `claude timed out after ${Math.round(task.timeoutMs / 60_000)} min`
          : result.aborted
            ? "claude was cancelled"
            : `claude exited ${result.exitCode}${parsed.subtype ? ` (${parsed.subtype})` : ""}: ${(result.stderr || text).trim().split("\n").slice(-3).join(" ")}`,
      costUsd: parsed.total_cost_usd ?? null,
      durationMs: result.durationMs,
      transcripts: [rawPath],
    };
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const v = await probe(this.bin);
    return v ? { ok: true, detail: v } : { ok: false, detail: `${this.bin} not found on PATH` };
  }
}

/**
 * Child agents get a clean session: strip variables that tie a process to
 * the parent Claude Code session (when the orchestrator itself runs inside one).
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID" || k.startsWith("CLAUDE_AGENT_SDK")) continue;
    out[k] = v;
  }
  return out;
}

export function tryJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const candidate of [trimmed, fenced?.[1]]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  return null;
}
