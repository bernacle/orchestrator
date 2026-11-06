import { createWriteStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { runProcess } from "../core/exec.js";
import type { Redactor } from "../core/redact.js";
import type { CheckResult, CheckRunner } from "./types.js";

const TAIL_LINES = 60;

/**
 * Runs operator-configured check commands through /bin/sh. Commands come
 * from the operator's repository config, never from agent output.
 */
export class ShellCheckRunner implements CheckRunner {
  constructor(private readonly redactor: Redactor) {}

  async run(input: { name: string; command: string; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; optional: boolean; logPath: string; signal: AbortSignal }): Promise<CheckResult> {
    mkdirSync(dirname(input.logPath), { recursive: true });
    const log = createWriteStream(input.logPath);
    const result = await runProcess("/bin/sh", ["-c", input.command], {
      cwd: input.cwd,
      env: { ...input.env, CI: "1", FORCE_COLOR: "0" },
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const combined = this.redactor.redact(`$ ${input.command}\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`);
    log.end(combined);
    await new Promise<void>((r) => log.on("close", () => r()));
    return {
      name: input.name,
      command: input.command,
      ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
      optional: input.optional,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      outputTail: combined.trimEnd().split("\n").slice(-TAIL_LINES).join("\n"),
      logPath: input.logPath,
    };
  }
}

export interface ResolvedToolchain {
  env: NodeJS.ProcessEnv;
  node: { requested: string | null; binDir: string | null; version: string | null; source: "path" | "nvm" | "unresolved" | "not-required" };
}

/**
 * Build the environment for checks and agents. If the repository pins a
 * Node major version that differs from the one on PATH, look for it in nvm's
 * install directory and prepend its bin dir. Nothing is installed.
 */
export async function resolveToolchain(requestedNode: string | undefined, extraEnv: Record<string, string>, baseEnv: NodeJS.ProcessEnv = process.env): Promise<ResolvedToolchain> {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...extraEnv, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  if (!requestedNode) return { env, node: { requested: null, binDir: null, version: null, source: "not-required" } };

  const major = requestedNode.replace(/^v/, "").split(".")[0]!;
  const onPath = await nodeVersion("node", env);
  if (onPath?.replace(/^v/, "").split(".")[0] === major) {
    return { env, node: { requested: requestedNode, binDir: null, version: onPath, source: "path" } };
  }

  const nvmDir = join(baseEnv.NVM_DIR ?? join(homedir(), ".nvm"), "versions", "node");
  if (existsSync(nvmDir)) {
    const candidates = readdirSync(nvmDir)
      .filter((v) => v.replace(/^v/, "").split(".")[0] === major)
      .sort(compareVersionsDesc);
    for (const candidate of candidates) {
      const binDir = join(nvmDir, candidate, "bin");
      const version = await nodeVersion(join(binDir, "node"), env);
      if (version) {
        env.PATH = [binDir, env.PATH ?? ""].filter(Boolean).join(delimiter);
        return { env, node: { requested: requestedNode, binDir, version, source: "nvm" } };
      }
    }
  }
  return { env, node: { requested: requestedNode, binDir: null, version: onPath, source: "unresolved" } };
}

async function nodeVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const r = await runProcess(bin, ["--version"], { env, timeoutMs: 10_000 });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
