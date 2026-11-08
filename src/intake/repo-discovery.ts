import { basename, dirname, isAbsolute, resolve } from "node:path";
import { runProcess } from "../core/exec.js";
import { SAFE_GIT } from "../adapters/git.js";

/**
 * Which GitHub repository does a working directory belong to?
 *
 * Read-only: runs `git rev-parse`, `git remote` and `git ls-remote --get-url` (which applies
 * `url.*.insteadOf` rewrites) with the same hardened flags as every other orchestrator git call,
 * and `ssh -G` to resolve SSH host aliases (`git@github-personal:owner/repo.git`). Nothing is
 * fetched, and nothing in the directory is changed.
 *
 * The directory is only used to *identify* the repository. Runs never execute in it: the engine
 * works in its own clone and worktrees (see docs/isolation.md), so a T3 session's worktree and its
 * uncommitted changes are left alone.
 */

export interface GitHubIdentity {
  owner: string;
  name: string;
  /** owner/name as written in the remote URL. */
  repo: string;
}

export interface RemoteInfo {
  name: string;
  url: string;
  github: GitHubIdentity | null;
  /** Why a remote is not a usable GitHub identity, e.g. an unsupported host. */
  note?: string;
}

export interface RepoDiscovery {
  cwd: string;
  inGitRepo: boolean;
  /** Top level of the working tree that contains cwd (a linked worktree's own directory). */
  worktreeRoot: string | null;
  /** The main checkout's directory (for a linked worktree, where its common .git lives). */
  mainCheckout: string | null;
  isLinkedWorktree: boolean;
  /** cwd is inside a T3-managed worktree (~/.t3/worktrees/...). Informational. */
  t3Worktree: boolean;
  remotes: RemoteInfo[];
  /** Distinct GitHub repositories named by the remotes (case-insensitive), in remote order. */
  candidates: Array<GitHubIdentity & { remotes: string[] }>;
}

export interface DiscoveryDeps {
  git(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string }>;
  /** Resolve an SSH host alias to its real hostname (`ssh -G`). */
  sshHostname(alias: string): Promise<string | null>;
  t3WorktreesDir?: string;
}

export function defaultDiscoveryDeps(env: NodeJS.ProcessEnv = process.env): DiscoveryDeps {
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  return {
    git: async (cwd, args) => {
      const r = await runProcess("git", [...SAFE_GIT, ...args], { cwd, env: gitEnv, timeoutMs: 60_000 });
      return { exitCode: r.exitCode ?? 1, stdout: r.stdout.trim() };
    },
    sshHostname: async (alias) => {
      if (!/^[\w.-]+$/.test(alias)) return null;
      const r = await runProcess("ssh", ["-G", alias], { env, timeoutMs: 10_000 }).catch(() => null);
      if (!r || r.exitCode !== 0) return null;
      const line = r.stdout.split("\n").find((l) => l.toLowerCase().startsWith("hostname "));
      return line ? line.slice("hostname ".length).trim().toLowerCase() : null;
    },
    ...(env.HOME ? { t3WorktreesDir: resolve(env.HOME, ".t3", "worktrees") } : {}),
  };
}

const GITHUB_HOST = "github.com";

/** Host and path of a git remote URL, or null for local paths and unknown schemes. */
export function splitRemoteUrl(url: string): { host: string; path: string; scp: boolean } | null {
  const u = url.trim();
  // scp-like: [user@]host:path (no scheme, and the part before ':' has no '/')
  const scp = u.match(/^(?:[\w.+-]+@)?([\w.-]+):(?!\/\/)(.+)$/);
  if (scp && !u.includes("://")) return { host: scp[1]!.toLowerCase(), path: scp[2]!, scp: true };
  const m = u.match(/^(?:ssh|git|https?|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/i);
  if (m) return { host: m[1]!.toLowerCase(), path: m[2]!, scp: false };
  return null;
}

export function ownerAndName(path: string): { owner: string; name: string } | null {
  const m = path.replace(/\/+$/, "").replace(/\.git$/i, "").match(/^\/?([\w.-]+)\/([\w.-]+)$/);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1]!, name: m[2]! };
}

/** Parse one remote URL into a GitHub identity, resolving SSH host aliases. */
export async function parseGitHubRemote(url: string, deps: Pick<DiscoveryDeps, "sshHostname">): Promise<{ github: GitHubIdentity | null; note?: string }> {
  const parts = splitRemoteUrl(url);
  if (!parts) return { github: null, note: "not a network remote" };
  let host = parts.host;
  const isSsh = parts.scp || /^(ssh|git\+ssh|ssh\+git):/i.test(url);
  if (host !== GITHUB_HOST && isSsh) {
    const real = await deps.sshHostname(host);
    if (real) host = real;
  }
  if (host !== GITHUB_HOST && host !== `www.${GITHUB_HOST}` && host !== `ssh.${GITHUB_HOST}`) {
    return { github: null, note: `host ${parts.host}${host !== parts.host ? ` (→ ${host})` : ""} is not github.com` };
  }
  const id = ownerAndName(parts.path);
  if (!id) return { github: null, note: `cannot read owner/name from ${parts.path}` };
  return { github: { ...id, repo: `${id.owner}/${id.name}` } };
}

export async function discoverRepository(cwd: string, deps: DiscoveryDeps = defaultDiscoveryDeps()): Promise<RepoDiscovery> {
  const abs = resolve(cwd);
  const empty: RepoDiscovery = { cwd: abs, inGitRepo: false, worktreeRoot: null, mainCheckout: null, isLinkedWorktree: false, t3Worktree: false, remotes: [], candidates: [] };
  const top = await deps.git(abs, ["rev-parse", "--show-toplevel"]).catch(() => ({ exitCode: 1, stdout: "" }));
  if (top.exitCode !== 0 || !top.stdout) return empty;
  const worktreeRoot = top.stdout;
  const dirs = await deps.git(worktreeRoot, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
  const [gitDirRaw, commonRaw] = dirs.stdout.split("\n");
  const gitDir = gitDirRaw ? absolute(worktreeRoot, gitDirRaw) : null;
  const commonDir = commonRaw ? absolute(worktreeRoot, commonRaw) : gitDir;
  const isLinkedWorktree = Boolean(gitDir && commonDir && gitDir !== commonDir);
  const mainCheckout = commonDir && basename(commonDir) === ".git" ? dirname(commonDir) : worktreeRoot;

  const names = (await deps.git(worktreeRoot, ["remote"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const remotes: RemoteInfo[] = [];
  for (const name of names) {
    const r = await deps.git(worktreeRoot, ["ls-remote", "--get-url", name]);
    const url = r.exitCode === 0 ? r.stdout : "";
    const parsed = url ? await parseGitHubRemote(url, deps) : { github: null, note: "no URL" };
    remotes.push({ name, url, github: parsed.github, ...(parsed.note ? { note: parsed.note } : {}) });
  }

  const byKey = new Map<string, GitHubIdentity & { remotes: string[] }>();
  for (const r of remotes) {
    if (!r.github) continue;
    const key = r.github.repo.toLowerCase();
    const existing = byKey.get(key);
    if (existing) existing.remotes.push(r.name);
    else byKey.set(key, { ...r.github, remotes: [r.name] });
  }

  const t3 = deps.t3WorktreesDir ? worktreeRoot.startsWith(`${deps.t3WorktreesDir}/`) : false;
  return { cwd: abs, inGitRepo: true, worktreeRoot, mainCheckout, isLinkedWorktree, t3Worktree: t3, remotes, candidates: [...byKey.values()] };
}

function absolute(base: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
