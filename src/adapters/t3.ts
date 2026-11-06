import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runChecked, runProcess } from "../core/exec.js";

/**
 * T3 Code through its supported `t3` CLI (`t3 thread list|start|send|show`),
 * which talks to the running T3 server. No internal database access, no
 * private HTTP endpoints.
 *
 * Known limitations (t3 v0.1.x):
 *  - `t3 thread start` has no runtime-mode flag; threads inherit the
 *    project's default, which may be full access. The orchestrator therefore
 *    does not use T3 threads as an executor (see docs/research.md).
 *  - There is no plugin / slash-command API. `/orchestrate` is delivered as an
 *    agent skill that T3-hosted Claude Code sessions load.
 */

export interface T3Thread {
  threadId: string;
  projectId?: string;
  title: string;
  link?: string;
  status: string;
  providerInstanceId?: string;
  model?: string;
  runtimeMode?: string;
  branch?: string | null;
  worktreePath?: string | null;
}

export class T3Cli {
  constructor(readonly bin: string | null = locateT3()) {}

  async version(): Promise<string | null> {
    if (!this.bin) return null;
    const r = await runProcess(this.bin, ["--version"], { timeoutMs: 15_000 }).catch(() => null);
    return r?.exitCode === 0 ? r.stdout.trim() : null;
  }

  /** Lists threads for a project path; also proves the T3 server is reachable. */
  async listThreads(projectPath: string): Promise<T3Thread[]> {
    if (!this.bin) throw new Error("t3 CLI not found");
    const out = await runChecked(this.bin, ["thread", "list", "--project", projectPath, "--json"], { timeoutMs: 20_000 });
    return JSON.parse(out) as T3Thread[];
  }

  async showThread(threadId: string): Promise<T3Thread> {
    if (!this.bin) throw new Error("t3 CLI not found");
    const out = await runChecked(this.bin, ["thread", "show", threadId, "--json", "--messages", "0"], { timeoutMs: 20_000 });
    return (JSON.parse(out) as { thread: T3Thread }).thread;
  }
}

/** Inside T3 sessions T3CODE_CLI_PATH points at the launcher. */
export function locateT3(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.T3CODE_CLI_PATH, join(homedir(), ".t3", "bin", "t3")].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Recorded on the run so status output can link back to the originating T3 session. */
export function detectT3Origin(env: NodeJS.ProcessEnv = process.env): { kind: "t3"; cliPath: string } | null {
  return env.T3CODE_CLI_PATH ? { kind: "t3", cliPath: env.T3CODE_CLI_PATH } : null;
}

export function t3ThreadLink(threadId: string, title = "T3 thread"): string {
  return `[${title}](t3-thread://v1/${threadId})`;
}
