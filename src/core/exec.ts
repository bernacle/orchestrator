import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed. */
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each stdout chunk (e.g. to stream JSONL events). */
  onStdout?: (chunk: string) => void;
  /** Cap on retained output per stream; older output is dropped. */
  maxBufferBytes?: number;
}

export interface ExecResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * Run a process without a shell. Arguments are passed verbatim, so no
 * quoting/injection issues. Never throws for a non-zero exit; callers decide.
 */
export function runProcess(command: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  const max = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ command, args, exitCode: null, signal: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, aborted: true });
      return;
    }

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // New process group so cancellation also stops grandchildren (test runners, dev servers).
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const append = (buf: string, chunk: string) => {
      const next = buf + chunk;
      return next.length > max ? next.slice(next.length - max) : next;
    };

    const terminate = () => {
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          /* already gone */
        }
      };
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, opts.timeoutMs)
      : undefined;

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
      opts.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ command, args, exitCode, signal, stdout, stderr, durationMs: Date.now() - started, timedOut, aborted });
    });

    child.stdin.on("error", () => {
      /* child may exit before reading stdin */
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run and throw ExecError on non-zero exit. Returns trimmed stdout. */
export async function runChecked(command: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const result = await runProcess(command, args, opts);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
    throw new ExecError(`${command} ${args.slice(0, 3).join(" ")} exited with ${result.exitCode ?? result.signal}: ${detail}`, result);
  }
  return result.stdout.trim();
}

/** Does an executable exist and run? Returns its first output line. */
export async function probe(command: string, args = ["--version"], opts: ExecOptions = {}): Promise<string | null> {
  try {
    const result = await runProcess(command, args, { timeoutMs: 15_000, ...opts });
    if (result.exitCode !== 0) return null;
    return (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}
