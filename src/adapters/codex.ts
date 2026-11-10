import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probe, runProcess } from "../core/exec.js";
import type { AgentConfig } from "../config/schema.js";
import { tryJson } from "./claude.js";
import type { AgentResult, AgentRunner, AgentTask } from "./types.js";

type CodexConfig = Extract<AgentConfig, { adapter: "codex" }>;

/**
 * Codex via `codex exec` (non-interactive). Reviews run in the read-only
 * sandbox with approvals disabled, so the reviewer cannot change the code
 * it is judging. Final output is constrained with --output-schema.
 */
export class CodexAgent implements AgentRunner {
  readonly id = "codex";
  readonly provider = "openai";

  constructor(
    private readonly config: CodexConfig,
    private readonly bin = "codex",
  ) {}

  private paths(task: Pick<AgentTask, "artifactDir" | "artifactPrefix">) {
    return {
      schema: join(task.artifactDir, `${task.artifactPrefix}.schema.json`),
      last: join(task.artifactDir, `${task.artifactPrefix}.codex-last.txt`),
      events: join(task.artifactDir, `${task.artifactPrefix}.codex.jsonl`),
    };
  }

  args(task: Pick<AgentTask, "role" | "cwd" | "resumeSessionId" | "outputSchema" | "artifactDir" | "artifactPrefix" | "images">): string[] {
    const p = this.paths(task);
    const sandbox = task.role === "implementer" ? this.config.sandbox : "read-only";
    const a = ["exec"];
    if (task.resumeSessionId) a.push("resume", task.resumeSessionId);
    a.push("--json", "-o", p.last, "-c", 'approval_policy="never"');
    if (!task.resumeSessionId) a.push("--sandbox", sandbox, "-C", task.cwd);
    if (this.config.model) a.push("-m", this.config.model);
    if (task.outputSchema) a.push("--output-schema", p.schema);
    // Codex skips a missing image silently; the orchestrator only passes files it has verified.
    for (const image of task.images ?? []) a.push("--image", image);
    a.push("-"); // prompt from stdin
    return a;
  }

  describe(task: Omit<AgentTask, "signal" | "env">): string {
    return `${this.bin} ${this.args(task).join(" ")} < ${task.artifactPrefix}.prompt.md`;
  }

  async run(task: AgentTask): Promise<AgentResult> {
    mkdirSync(task.artifactDir, { recursive: true });
    const p = this.paths(task);
    if (task.outputSchema) writeFileSync(p.schema, JSON.stringify(task.outputSchema, null, 2));
    const result = await runProcess(this.bin, this.args(task), {
      cwd: task.cwd,
      env: task.env,
      input: task.prompt,
      timeoutMs: task.timeoutMs,
      signal: task.signal,
    });
    writeFileSync(p.events, result.stdout);

    let sessionId: string | null = task.resumeSessionId ?? null;
    let lastError: string | null = null;
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { type?: string; thread_id?: string; message?: string; error?: { message?: string } };
        if (ev.type === "thread.started" && ev.thread_id) sessionId = ev.thread_id;
        if (ev.type === "error" || ev.type === "turn.failed") lastError = ev.message ?? ev.error?.message ?? lastError;
      } catch {
        /* ignore non-JSON lines */
      }
    }
    const text = existsSync(p.last) ? readFileSync(p.last, "utf8") : "";
    const ok = result.exitCode === 0 && !result.timedOut && !result.aborted && text.trim().length > 0;
    return {
      sessionId,
      text,
      structured: tryJson(text),
      ok,
      error: ok
        ? null
        : result.timedOut
          ? `codex timed out after ${Math.round(task.timeoutMs / 60_000)} min`
          : result.aborted
            ? "codex was cancelled"
            : `codex exited ${result.exitCode}: ${lastError ?? result.stderr.trim().split("\n").slice(-3).join(" ")}`,
      costUsd: null,
      durationMs: result.durationMs,
      transcripts: [p.events, p.last],
    };
  }

  async verifyIsolation(): Promise<{ ok: boolean; detail: string }> {
    const v = await probe(this.bin);
    if (!v) return { ok: false, detail: `${this.bin} not found on PATH` };
    return {
      ok: true,
      detail: `${v}: --sandbox read-only (Seatbelt on macOS) blocks writes and network for its commands; it can still read files, so its output is redacted before use`,
    };
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const v = await probe(this.bin);
    if (!v) return { ok: false, detail: `${this.bin} not found on PATH` };
    const login = await runProcess(this.bin, ["login", "status"], { timeoutMs: 15_000 }).catch(() => null);
    const status = (login?.stdout || login?.stderr || "").trim().split("\n")[0] ?? "";
    return { ok: login?.exitCode === 0, detail: `${v}; ${status || "login status unknown"}` };
  }
}
