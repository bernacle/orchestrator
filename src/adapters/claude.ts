import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probe, runProcess } from "../core/exec.js";
import { claudeIsolationSettings, compareVersions, MIN_CLAUDE_VERSION_FOR_ISOLATION } from "../core/isolation.js";
import type { AgentConfig } from "../config/schema.js";
import type { AgentResult, AgentRunner, AgentTask } from "./types.js";

type ClaudeConfig = Extract<AgentConfig, { adapter: "claude-code" }>;

/** Read-only tool set for planning: no edits, no shell. */
export const PLANNER_TOOLS = ["Read", "Grep", "Glob"];
/** Built-in tools the implementer may use at all. No WebFetch/WebSearch (exfiltration), no sub-agents. */
export const IMPLEMENTER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];

/**
 * Denied whatever the repository config allows. The Bash sandbox already blocks network and
 * writes outside the worktree; these deny rules make intent explicit and catch commands that
 * would only fail noisily inside the sandbox.
 */
export const DEFAULT_DENIED = [
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git remote:*)",
  "Bash(git config:*)",
  "Bash(git credential:*)",
  "Bash(git worktree:*)",
  "Bash(gh:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(ssh:*)",
  "Bash(scp:*)",
  "Bash(rsync:*)",
  "Bash(nc:*)",
  "Bash(sudo:*)",
  "Bash(security:*)",
  "Bash(osascript:*)",
  "Bash(open:*)",
  "Bash(npx:*)",
  "Bash(pnpm dlx:*)",
  "Bash(npm publish:*)",
  "Bash(pnpm publish:*)",
  "WebFetch",
  "WebSearch",
];

export interface AgentIsolation {
  /** Paths the agent's shell must not read (credential stores, orchestrator state). */
  denyRead: string[];
  /** Environment variables hidden from the agent's shell. */
  deniedEnv: string[];
  /** Tool caches the shell may update (e.g. corepack). */
  allowWrite?: string[];
}

const ROLE_RULES: Record<AgentTask["role"], string> = {
  planner: [
    "You are the PLANNER in a supervised engineering workflow run by an orchestrator.",
    "You can only read the repository. Do not attempt to modify files.",
    "Produce a concrete, minimal implementation plan grounded in files you actually read.",
    "List genuine open questions instead of guessing about product decisions.",
  ].join("\n"),
  implementer: [
    "You are the IMPLEMENTER in a supervised engineering workflow run by an orchestrator.",
    "Work only inside the current directory (a dedicated git worktree). Your shell is sandboxed: no network, no writes outside this directory.",
    "Dependencies are already installed. Do not add, remove or upgrade packages.",
    "Do not commit, push, open pull requests, or change git configuration: the orchestrator does that after verifying your work.",
    "Do not edit CI workflows, lockfiles, secrets/env files, or agent/editor configuration (.claude/, .codex/, .github/).",
    "You cannot approve your own work. An independent reviewer and the orchestrator's own checks decide.",
    "When done, summarise what you changed, decisions you made on open questions, and anything left unfinished. Unverified claims are discarded.",
  ].join("\n"),
  reviewer: "You are an independent REVIEWER. You can only read. Report findings; do not modify files.",
};

export class ClaudeCodeAgent implements AgentRunner {
  readonly id = "claude-code";
  readonly provider = "anthropic";

  constructor(
    private readonly config: ClaudeConfig,
    private readonly isolation: AgentIsolation = { denyRead: [], deniedEnv: [] },
    private readonly bin = "claude",
  ) {}

  settings(role: AgentTask["role"]): object {
    return claudeIsolationSettings({
      denyRead: this.isolation.denyRead,
      deniedEnv: this.isolation.deniedEnv,
      allowWrite: this.isolation.allowWrite ?? [],
      allow: [],
      deny: role === "implementer" ? [...new Set([...DEFAULT_DENIED, ...this.config.disallowed_tools])] : ["Bash", "Edit", "Write", "WebFetch", "WebSearch"],
    });
  }

  args(task: Pick<AgentTask, "role" | "resumeSessionId" | "sessionId" | "outputSchema"> & { maxBudgetUsd?: number }): string[] {
    const a = ["-p", "--output-format", "json"];
    if (this.config.model) a.push("--model", this.config.model);
    // Only our settings apply: not the repository's .claude/settings*.json (hooks, allow rules), not the
    // operator's user settings, not project MCP servers.
    a.push("--settings", JSON.stringify(this.settings(task.role)), "--setting-sources", "", "--strict-mcp-config");
    if (task.role === "implementer") {
      a.push("--tools", IMPLEMENTER_TOOLS.join(","));
      // Edits are auto-accepted; anything else not allow-listed is denied (no human to prompt).
      a.push("--permission-mode", this.config.permission_mode, "--permission-prompts", "none");
      if (this.config.allowed_tools.length) a.push("--allowedTools", ...this.config.allowed_tools);
      a.push("--disallowedTools", ...new Set([...DEFAULT_DENIED, ...this.config.disallowed_tools]));
    } else {
      a.push("--tools", PLANNER_TOOLS.join(","), "--permission-mode", "default", "--permission-prompts", "none");
    }
    const budget = task.maxBudgetUsd ?? this.config.max_budget_usd;
    if (budget) a.push("--max-budget-usd", budget.toFixed(2));
    if (task.outputSchema) a.push("--json-schema", JSON.stringify(task.outputSchema));
    a.push("--append-system-prompt", ROLE_RULES[task.role]);
    if (task.resumeSessionId) a.push("--resume", task.resumeSessionId);
    else if (task.sessionId) a.push("--session-id", task.sessionId);
    return a;
  }

  describe(task: Omit<AgentTask, "signal" | "env">): string {
    const shown = this.args({ ...task, sessionId: task.resumeSessionId ? undefined : "<new-session-uuid>" }).map((x) =>
      x === "" ? "''" : x.includes("\n") || x.length > 80 ? `'<${x.length} chars>'` : /[\s()*]/.test(x) ? `'${x}'` : x,
    );
    return `(cd ${task.cwd} && ${this.bin} ${shown.join(" ")} < ${task.artifactPrefix}.prompt.md)`;
  }

  async run(task: AgentTask): Promise<AgentResult> {
    mkdirSync(task.artifactDir, { recursive: true });
    const sessionId = task.resumeSessionId ?? task.sessionId ?? crypto.randomUUID();
    const args = this.args({ ...task, sessionId });
    // Audit: the exact isolation settings this agent ran under.
    writeFileSync(join(task.artifactDir, `${task.artifactPrefix}.claude-settings.json`), JSON.stringify(this.settings(task.role), null, 2));
    const result = await runProcess(this.bin, args, {
      cwd: task.cwd,
      env: task.env,
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

  /** The isolation settings above need Claude Code ≥ MIN_CLAUDE_VERSION_FOR_ISOLATION. */
  async verifyIsolation(): Promise<{ ok: boolean; detail: string }> {
    const v = await probe(this.bin);
    const version = v?.match(/(\d+\.\d+\.\d+)/)?.[1];
    if (!version) return { ok: false, detail: `${this.bin} not found or version unknown` };
    if (compareVersions(version, MIN_CLAUDE_VERSION_FOR_ISOLATION) < 0) {
      return { ok: false, detail: `Claude Code ${version} < ${MIN_CLAUDE_VERSION_FOR_ISOLATION} (needed for blockWritesOutsideWorkingDirectories)` };
    }
    return { ok: true, detail: `Claude Code ${version}: Bash sandbox (fail-closed, no network, credential paths and env denied), file tools fenced to the worktree, no hooks/MCP/connectors` };
  }
}

/** Strip variables that tie a process to a parent Claude Code session. Kept for callers that build env by hand. */
export function stripParentSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
