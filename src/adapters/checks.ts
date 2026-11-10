import { createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { runProcess } from "../core/exec.js";
import { childEnv, sandboxedShell, type IsolationDirs, type SandboxSpec } from "../core/isolation.js";
import type { Redactor } from "../core/redact.js";
import type { CheckResult, CheckRunner } from "./types.js";

const TAIL_LINES = 60;

/**
 * Runs operator-configured check commands through /bin/sh. The command text
 * comes from operator config, but what it executes (package scripts, tests,
 * build plugins) is repository code that an agent may have edited, so it runs
 * inside the OS sandbox with a scrubbed environment.
 */
export class ShellCheckRunner implements CheckRunner {
  constructor(private readonly redactor: Redactor) {}

  async run(input: { name: string; command: string; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; optional: boolean; logPath: string; signal: AbortSignal; sandbox: SandboxSpec | null }): Promise<CheckResult> {
    mkdirSync(dirname(input.logPath), { recursive: true });
    const log = createWriteStream(input.logPath);
    const exec = input.sandbox ? sandboxedShell(input.command, input.sandbox) : { command: "/bin/sh", args: ["-c", input.command] };
    const result = await runProcess(exec.command, exec.args, {
      cwd: input.cwd,
      env: { ...input.env, CI: "1", FORCE_COLOR: "0" },
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const header = `$ ${input.command}${input.sandbox ? `  [sandbox: seatbelt, network=${input.sandbox.network}]` : "  [UNSANDBOXED]"}`;
    const combined = this.redactor.redact(`${header}\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`);
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

/** A Node version file read from the repository at the base commit. */
export interface NodeVersionFile {
  file: string;
  content: string;
}

export const NODE_VERSION_FILES = [".nvmrc", ".node-version"] as const;

/** Where a Node requirement came from: `toolchain.node`, `.nvmrc`, `.node-version`. */
export interface NodePin {
  spec: string;
  source: string;
}

export interface ResolvedToolchain {
  env: NodeJS.ProcessEnv;
  node: {
    /** The version prefix required: "24" (any 24.x.y), "24.21" or exactly "24.21.0". */
    requested: string | null;
    /** Where `requested` came from (e.g. ".nvmrc (refines toolchain.node 24)"). */
    from?: string | null;
    /**
     * The real directory of the `node` executable, first on PATH for checks and agents, so neither
     * goes through a version-manager shim (asdf, mise, nodenv) that picks a version per directory
     * and must read its own install to do so. Null only if the executable could not be located.
     */
    binDir: string | null;
    /** The Node installation (binDir's parent): agent sandboxes must be able to read it to run node. */
    home?: string | null;
    /** What `node --version` reports with the exact environment and directory checks use. */
    version: string | null;
    source: "path" | "nvm" | "unresolved" | "not-required";
    /** Why the requirement could not be met or was inconsistent. */
    detail?: string | null;
  };
}

/**
 * A plain version pin: "24", "v24.21", "24.21.0", "24.x". Aliases (`lts/*`, `node`) and ranges
 * (`>=24`) are not pins and return null. Comments and blank lines are ignored.
 */
export function parseNodePin(raw: string | null | undefined): string | null {
  const line = raw
    ?.split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .find(Boolean);
  const m = line?.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.[x*])?$/i);
  return m ? [m[1], m[2], m[3]].filter((x) => x !== undefined).join(".") : null;
}

/** True when `version` (e.g. "v24.21.0") has every component `spec` names ("24", "24.21", "24.21.0"). */
export function nodeMatches(version: string | null | undefined, spec: string): boolean {
  if (!version) return false;
  const v = version.trim().replace(/^v/, "").split(".");
  return spec.split(".").every((part, i) => v[i] === part);
}

/**
 * The Node requirement for a run. The operator's `toolchain.node` and the repository's own version
 * file (read at the base commit) are combined: the more precise one wins when they agree, so a
 * config saying "24" with `.nvmrc` saying "24.21.0" requires exactly 24.21.0. A repository that
 * pins only a major version ("24") keeps major matching. Disagreement is reported, never guessed.
 * `useVersionFile: false` (toolchain.node_version_file) ignores the repository file.
 */
export function nodeRequirement(configured: string | undefined, file: NodeVersionFile | null | undefined, useVersionFile = true): { pin: NodePin | null; conflict: string | null } {
  const cfg = configured ? parseNodePin(configured) : null;
  if (configured && !cfg) return { pin: null, conflict: `toolchain.node "${configured}" is not a version (use e.g. "24" or "24.21.0")` };
  const repo = useVersionFile && file ? parseNodePin(file.content) : null;
  if (cfg && repo) {
    if (nodeMatches(repo, cfg)) return { pin: { spec: repo, source: repo === cfg ? `toolchain.node and ${file!.file}` : `${file!.file} (refines toolchain.node ${cfg})` }, conflict: null };
    if (nodeMatches(cfg, repo)) return { pin: { spec: cfg, source: `toolchain.node (refines ${file!.file} ${repo})` }, conflict: null };
    return { pin: { spec: cfg, source: "toolchain.node" }, conflict: `toolchain.node ${cfg} conflicts with the repository's ${file!.file} (${repo}); make them agree, or set toolchain.node_version_file: false` };
  }
  if (cfg) return { pin: { spec: cfg, source: "toolchain.node" }, conflict: null };
  if (repo) return { pin: { spec: repo, source: file!.file }, conflict: null };
  return { pin: null, conflict: null };
}

export interface ToolchainProbe {
  /** Directory the probe runs in: version managers (asdf, mise) choose by directory. Nearest existing ancestor is used. */
  cwd?: string;
  /** Turn the toolchain environment into the one children actually get (e.g. childEnv). */
  prepare?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

/**
 * Build the environment for checks and agents. If the `node` that children would run does not
 * match the requirement (every component it names), look for a matching install in nvm's
 * directory and prepend its bin dir. Every probe runs `node` through PATH with the prepared
 * environment, in the directory checks run in, so the reported version is the one checks use.
 * Nothing is installed.
 */
export async function resolveToolchain(
  requested: NodePin | string | null | undefined,
  extraEnv: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv = process.env,
  probe: ToolchainProbe = {},
): Promise<ResolvedToolchain> {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...extraEnv, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  const pin: NodePin | null = typeof requested === "string" ? { spec: parseNodePin(requested) ?? requested, source: "toolchain.node" } : (requested ?? null);
  if (!pin) return { env, node: { requested: null, from: null, binDir: null, version: null, source: "not-required" } };
  const prepare = probe.prepare ?? ((e: NodeJS.ProcessEnv) => e);
  const cwd = probe.cwd ? existingDir(probe.cwd) : undefined;
  const base = { requested: pin.spec, from: pin.source };

  const onPath = await nodeVersion("node", prepare(env), cwd);
  if (nodeMatches(onPath, pin.spec)) {
    const pinned = await pinRealNode(env, pin.spec, prepare, cwd);
    return { env: pinned?.env ?? env, node: { ...base, binDir: pinned?.binDir ?? null, home: pinned ? dirname(pinned.binDir) : null, version: onPath, source: "path" } };
  }

  const nvmDir = join(baseEnv.NVM_DIR ?? join(homedir(), ".nvm"), "versions", "node");
  if (existsSync(nvmDir)) {
    const candidates = readdirSync(nvmDir)
      .filter((v) => nodeMatches(v, pin.spec))
      .sort(compareVersionsDesc);
    for (const candidate of candidates) {
      const binDir = join(nvmDir, candidate, "bin");
      const withBin = { ...env, PATH: [binDir, env.PATH ?? ""].filter(Boolean).join(delimiter) };
      const version = await nodeVersion("node", prepare(withBin), cwd);
      if (nodeMatches(version, pin.spec)) {
        const pinned = await pinRealNode(withBin, pin.spec, prepare, cwd);
        return { env: pinned?.env ?? withBin, node: { ...base, binDir: pinned?.binDir ?? binDir, home: dirname(pinned?.binDir ?? binDir), version, source: "nvm" } };
      }
    }
  }
  return {
    env,
    node: { ...base, binDir: null, version: onPath, source: "unresolved", detail: `children would run ${onPath ?? "no node"}, and nvm has no Node matching ${pin.spec}` },
  };
}

/**
 * The toolchain for repository commands and agents, exactly as the run uses it: requirement from
 * config plus the repository's version file, probed with the scrubbed child environment in the
 * directory the commands run in. Used by planning, live steps, preflight and doctor alike.
 */
export async function resolveRunToolchain(input: {
  toolchain: { node?: string | undefined; node_version_file?: boolean | undefined; env: Record<string, string> };
  versionFile: NodeVersionFile | null | undefined;
  cwd: string;
  dirs: IsolationDirs;
  agent?: string;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<{ env: NodeJS.ProcessEnv; node: ResolvedToolchain["node"]; toolchainEnv: NodeJS.ProcessEnv }> {
  const { pin, conflict } = nodeRequirement(input.toolchain.node, input.versionFile, input.toolchain.node_version_file ?? true);
  const prepare = (e: NodeJS.ProcessEnv) => childEnv(e, { ...(input.agent ? { agent: input.agent } : {}), extra: input.toolchain.env, dirs: input.dirs });
  const tc = await resolveToolchain(pin, {}, input.baseEnv ?? process.env, { cwd: input.cwd, prepare });
  const node = conflict ? { ...tc.node, source: "unresolved" as const, detail: conflict } : tc.node;
  // `env` is what children get; `toolchainEnv` is the unscrubbed base (PATH adjusted) for callers that scrub differently.
  return { env: prepare(tc.env), node, toolchainEnv: tc.env };
}

/**
 * Put the real directory of the matching `node` first on PATH. `node` may be a shim that execs the
 * real binary; asking the running Node for its own path gets past any number of shims. The pin is
 * kept only if `node` still reports a matching version afterwards.
 */
async function pinRealNode(env: NodeJS.ProcessEnv, spec: string, prepare: (e: NodeJS.ProcessEnv) => NodeJS.ProcessEnv, cwd?: string): Promise<{ env: NodeJS.ProcessEnv; binDir: string } | null> {
  let binDir: string;
  try {
    const r = await runProcess("node", ["-p", "process.execPath"], { env: prepare(env), timeoutMs: 10_000, ...(cwd ? { cwd } : {}) });
    const execPath = r.exitCode === 0 ? r.stdout.trim().split("\n").at(-1) : undefined;
    if (!execPath || !isAbsolute(execPath)) return null;
    binDir = dirname(realpathSync(execPath));
  } catch {
    return null;
  }
  const rest = (env.PATH ?? "").split(delimiter).filter((p) => p && p !== binDir);
  const pinned = { ...env, PATH: [binDir, ...rest].join(delimiter) };
  return nodeMatches(await nodeVersion("node", prepare(pinned), cwd), spec) ? { env: pinned, binDir } : null;
}

/** Paths outside the worktree an agent's sandboxed shell must read to run the resolved toolchain. */
export function toolchainReadPaths(node: ResolvedToolchain["node"]): string[] {
  return node.home ? [node.home] : node.binDir ? [node.binDir] : [];
}

/** Human-readable toolchain line for plans, doctor and blockers. */
export function describeNode(node: ResolvedToolchain["node"]): string {
  if (node.source === "not-required") return "no Node version required";
  const want = `wants ${node.requested}${node.from ? ` (${node.from})` : ""}`;
  if (node.source === "unresolved") return `${want}: ${node.detail ?? `found ${node.version ?? "none"}`}`;
  return `${want}: ${node.version} via ${node.source}${node.binDir ? ` (${node.binDir})` : ""}`;
}

function existingDir(path: string): string | undefined {
  let dir = path;
  for (;;) {
    if (existsSync(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function nodeVersion(bin: string, env: NodeJS.ProcessEnv, cwd?: string): Promise<string | null> {
  try {
    const r = await runProcess(bin, ["--version"], { env, timeoutMs: 10_000, ...(cwd ? { cwd } : {}) });
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
