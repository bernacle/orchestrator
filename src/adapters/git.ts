import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { runChecked, runProcess } from "../core/exec.js";
import { NODE_VERSION_FILES, parseNodePin } from "./checks.js";
import type { ChangedFile, PushOptions, RepoInspection, Workspace } from "./types.js";

/**
 * Applied to every git command the orchestrator runs. Repository hooks and fsmonitor commands are
 * code the repository (or an agent, by editing the worktree) controls; the orchestrator runs git
 * with the operator's credentials and outside any sandbox, so it never executes them. Checks run
 * explicitly, sandboxed, instead of through hooks.
 */
export const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "protocol.ext.allow=never"];

const GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md", ".github/pull_request_template.md", "docs/ARCHITECTURE.md"];

export class GitWorkspace implements Workspace {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private git(cwd: string, args: string[], timeoutMs = 120_000, env: NodeJS.ProcessEnv = {}): Promise<string> {
    return runChecked("git", [...SAFE_GIT, ...args], { cwd, env: { ...this.env, GIT_TERMINAL_PROMPT: "0", ...env }, timeoutMs });
  }

  /**
   * Per-command push identity, never written to a config file. A configured URL is the push
   * destination itself (not another `remote.origin.pushurl`, which git would push to in addition to
   * any the clone already has); a key goes in GIT_SSH_COMMAND.
   */
  private pushIdentity(opts: PushOptions | undefined): { target: string; env: NodeJS.ProcessEnv } {
    const key = opts?.sshIdentityFile?.replace(/^~\//, `${this.env.HOME ?? homedir()}/`);
    const env: NodeJS.ProcessEnv = key ? { GIT_SSH_COMMAND: `ssh -i '${key}' -o IdentitiesOnly=yes -o BatchMode=yes` } : {};
    return { target: opts?.url ?? "origin", env };
  }

  async probePush(repoPath: string, sha: string, branch: string, opts?: PushOptions): Promise<{ ok: boolean; detail: string }> {
    const id = this.pushIdentity(opts);
    const res = await runProcess("git", [...SAFE_GIT, "push", "--dry-run", "--porcelain", id.target, `${sha}:refs/heads/${branch}`], {
      cwd: repoPath,
      env: { ...this.env, GIT_TERMINAL_PROMPT: "0", ...id.env },
      timeoutMs: 90_000,
    });
    const detail = `${res.stderr}\n${res.stdout}`.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("To ") && l !== "Done").slice(0, 4).join(" ");
    return { ok: res.exitCode === 0, detail: detail || (res.exitCode === 0 ? "push access confirmed" : `git push --dry-run exited ${res.exitCode}`) };
  }

  async ensureClone(repo: string, clonePath: string, opts: { fetch: boolean }): Promise<void> {
    if (!existsSync(join(clonePath, ".git"))) {
      mkdirSync(dirname(clonePath), { recursive: true });
      await runChecked("gh", ["repo", "clone", repo, clonePath, "--", "--quiet"], { env: this.env, timeoutMs: 600_000 });
      return;
    }
    if (opts.fetch) await this.git(clonePath, ["fetch", "--quiet", "--prune", "origin"], 300_000);
  }

  /**
   * Read-only inspection. With `ref`, files are read from that commit via
   * `git show`, so the working copy (possibly someone's checkout) is irrelevant.
   */
  async inspect(repoPath: string, ref?: string): Promise<RepoInspection> {
    const root = await this.git(repoPath, ["rev-parse", "--show-toplevel"]);
    const headSha = await this.git(root, ["rev-parse", ref ?? "HEAD"]);
    const read = async (file: string): Promise<string | null> => {
      if (!ref) return existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : null;
      const r = await runProcess("git", [...SAFE_GIT, "show", `${ref}:${file}`], { cwd: root });
      return r.exitCode === 0 ? r.stdout : null;
    };
    const list = async (dir: string): Promise<string[]> => {
      if (!ref) return existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : [];
      const r = await runProcess("git", [...SAFE_GIT, "ls-tree", "--name-only", `${ref}:${dir}`], { cwd: root });
      return r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean) : [];
    };

    const pkgText = await read("package.json");
    const pkg = pkgText ? (JSON.parse(pkgText) as { packageManager?: string; scripts?: Record<string, string>; workspaces?: string[]; engines?: { node?: string } }) : null;
    const wsText = await read("pnpm-workspace.yaml");
    const workspaces = wsText ? (((parseYaml(wsText) as { packages?: string[] }) ?? {}).packages ?? []) : (pkg?.workspaces ?? []);

    const ciWorkflows: RepoInspection["ciWorkflows"] = [];
    for (const file of (await list(".github/workflows")).filter((f) => /\.ya?ml$/.test(f))) {
      const text = await read(`.github/workflows/${file}`);
      if (!text) continue;
      try {
        const wf = parseYaml(text) as { jobs?: Record<string, { steps?: Array<{ run?: string }> }> };
        const runSteps = Object.values(wf.jobs ?? {}).flatMap((j) => (j.steps ?? []).map((s) => s.run).filter((r): r is string => Boolean(r)));
        ciWorkflows.push({ file, runSteps });
      } catch {
        ciWorkflows.push({ file, runSteps: [] });
      }
    }

    const guidanceFiles: string[] = [];
    for (const f of GUIDANCE_FILES) if ((await read(f)) !== null) guidanceFiles.push(f);
    // Nested agent guidance (e.g. apps/demo/AGENTS.md) applies to the code below it.
    const tracked = ref
      ? (await runProcess("git", [...SAFE_GIT, "ls-tree", "-r", "--name-only", ref], { cwd: root })).stdout
      : (await runProcess("git", [...SAFE_GIT, "ls-files"], { cwd: root })).stdout;
    for (const f of tracked.split("\n")) {
      if (/(^|\/)(AGENTS|CLAUDE)\.md$/.test(f) && f.includes("/") && !f.startsWith("node_modules/") && !guidanceFiles.includes(f)) guidanceFiles.push(f);
    }

    return {
      root,
      headSha,
      packageManager: pkg?.packageManager ?? null,
      scripts: pkg?.scripts ?? {},
      workspaces,
      ciWorkflows,
      guidanceFiles,
      topLevel: (await list(".")).filter((f) => f !== ".git").sort(),
      nodeEngine: pkg?.engines?.node ?? null,
      nodeVersionFile: await firstNodeVersionFile(read),
    };
  }

  async branchExists(repoPath: string, branch: string, opts: { fresh?: boolean } = {}): Promise<{ local: boolean; remote: boolean }> {
    const local = (await runProcess("git", [...SAFE_GIT, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath })).exitCode === 0;
    const tracking = async () => (await runProcess("git", [...SAFE_GIT, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: repoPath })).exitCode === 0;
    if (!opts.fresh) return { local, remote: await tracking() };
    // Ask origin itself (read-only): a clone that was not fetched can miss a branch pushed since.
    const ls = await runProcess("git", [...SAFE_GIT, "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], { cwd: repoPath, env: { ...this.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 60_000 });
    const remote = ls.exitCode === 0 ? true : ls.exitCode === 2 ? false : await tracking();
    return { local, remote };
  }

  async createWorktree(input: { repoPath: string; worktreePath: string; branch: string; baseRef: string; newBranch?: boolean }): Promise<{ created: boolean; headSha: string }> {
    if (existsSync(join(input.worktreePath, ".git"))) {
      const current = await this.git(input.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (current !== input.branch) {
        throw new Error(`worktree ${input.worktreePath} exists on branch ${current}, expected ${input.branch}`);
      }
      return { created: false, headSha: await this.headSha(input.worktreePath) };
    }
    mkdirSync(dirname(input.worktreePath), { recursive: true });
    // A new run creates its branch (`-b` fails if it exists, atomically): it never attaches to one
    // that appeared since planning. Only a re-entered run reattaches to the branch it created.
    const local = !input.newBranch && (await this.branchExists(input.repoPath, input.branch)).local;
    const args = local
      ? ["worktree", "add", input.worktreePath, input.branch]
      : ["worktree", "add", "--no-track", "-b", input.branch, input.worktreePath, input.baseRef];
    await this.git(input.repoPath, args);
    return { created: true, headSha: await this.headSha(input.worktreePath) };
  }

  headSha(worktreePath: string): Promise<string> {
    return this.git(worktreePath, ["rev-parse", "HEAD"]);
  }

  async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    return (await this.git(worktreePath, ["status", "--porcelain"])).length > 0;
  }

  async changedFiles(worktreePath: string, baseSha: string): Promise<ChangedFile[]> {
    const out = await this.git(worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "--no-renames", `${baseSha}...HEAD`]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status: status ?? "?", path: rest.join("\t") };
      });
  }

  diff(worktreePath: string, baseSha: string): Promise<string> {
    return this.git(worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "--stat", "--patch", `${baseSha}...HEAD`]);
  }

  async commitAll(worktreePath: string, message: string): Promise<string | null> {
    await this.git(worktreePath, ["add", "--all"]);
    const staged = await runProcess("git", [...SAFE_GIT, "diff", "--cached", "--quiet"], { cwd: worktreePath });
    if (staged.exitCode === 0) return null;
    await this.git(worktreePath, ["commit", "--quiet", "-m", message]);
    return this.headSha(worktreePath);
  }

  async uncommittedDiff(worktreePath: string): Promise<string> {
    const tracked = await this.git(worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
    const untracked = (await this.git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const root = realpathSync(resolve(worktreePath));
    const parts = [tracked];
    for (const path of untracked) {
      try {
        const full = resolve(root, path);
        const st = lstatSync(full);
        if (!full.startsWith(root + sep) || !st.isFile() || st.size > 2 * 1024 * 1024) continue;
        parts.push(`+++ ${path} (untracked)\n${readFileSync(full, "utf8")}`);
      } catch {
        /* vanished meanwhile */
      }
    }
    return parts.join("\n");
  }

  async uncommittedPaths(worktreePath: string): Promise<string[]> {
    const r = await runProcess("git", [...SAFE_GIT, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { cwd: worktreePath, env: { ...this.env, GIT_TERMINAL_PROMPT: "0" } });
    if (r.exitCode !== 0) throw new Error(`git status failed: ${r.stderr.trim()}`);
    return r.stdout
      .split("\0")
      .filter((e) => e.length > 3)
      .map((e) => e.slice(3));
  }

  async discardPaths(worktreePath: string, paths: string[]): Promise<void> {
    const root = resolve(worktreePath);
    const realRoot = realpathSync(root);
    for (const path of paths) {
      const abs = resolve(root, path.replace(/\/$/, ""));
      if (!abs.startsWith(root + sep)) continue; // never outside the worktree
      // A parent directory swapped for a symlink would make the path resolve elsewhere.
      let parent: string;
      try {
        parent = realpathSync(dirname(abs));
      } catch {
        continue;
      }
      if (parent !== realRoot && !parent.startsWith(realRoot + sep)) continue;
      const tracked = (await runProcess("git", [...SAFE_GIT, "cat-file", "-e", `HEAD:${path}`], { cwd: worktreePath })).exitCode === 0;
      // Literal pathspecs: a file name is never read as pathspec magic (":(glob)…", ":!…").
      if (tracked) await this.git(worktreePath, ["--literal-pathspecs", "checkout", "HEAD", "--", path]);
      // Untracked output, including a nested repository (which `add --all` would commit as a gitlink).
      // rmSync never follows symlinks, so a link is removed, not its target.
      else if (isLink(abs) || existsSync(abs)) rmSync(abs, { force: true, recursive: true });
    }
  }

  async commitBlobs(worktreePath: string, files: Array<{ path: string; data: Buffer }>, message: string): Promise<string | null> {
    if (files.length === 0) return null;
    // The index must match HEAD (nothing else staged), so the commit holds only these files.
    const staged = await runProcess("git", [...SAFE_GIT, "diff", "--cached", "--quiet"], { cwd: worktreePath });
    if (staged.exitCode !== 0) throw new Error("the index has staged changes; refusing to commit screenshots on top of them");
    // Raw bytes bypass clean filters: a path the repository routes through one (e.g. Git LFS) would
    // be committed in the wrong form. Refuse it instead.
    const attrs = await runProcess("git", [...SAFE_GIT, "--literal-pathspecs", "check-attr", "filter", "--", ...files.map((f) => f.path)], { cwd: worktreePath });
    const filtered = attrs.stdout
      .split("\n")
      .filter((l) => l && !/: filter: (unspecified|unset)$/.test(l))
      .map((l) => l.split(": filter: ")[0]);
    if (attrs.exitCode !== 0 || filtered.length) throw new Error(`these outputs use a git filter (e.g. Git LFS), which screenshots do not support: ${filtered.join(", ") || attrs.stderr.trim()}`);
    for (const f of files) {
      const blob = await runProcess("git", [...SAFE_GIT, "hash-object", "-w", "--stdin"], { cwd: worktreePath, input: f.data });
      const sha = blob.stdout.trim();
      if (blob.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`git hash-object failed for ${f.path}: ${blob.stderr.trim()}`);
      await this.git(worktreePath, ["--literal-pathspecs", "update-index", "--add", "--cacheinfo", `100644,${sha},${f.path}`]);
    }
    const changed = await runProcess("git", [...SAFE_GIT, "diff", "--cached", "--quiet"], { cwd: worktreePath });
    if (changed.exitCode === 0) return null;
    await this.git(worktreePath, ["commit", "--quiet", "-m", message]);
    return this.headSha(worktreePath);
  }

  async filesExist(repoPath: string, ref: string, paths: string[]): Promise<Array<{ path: string; exists: boolean }>> {
    const out: Array<{ path: string; exists: boolean }> = [];
    for (const path of paths) {
      const r = await runProcess("git", [...SAFE_GIT, "cat-file", "-e", `${ref}:${path.replace(/^\.?\//, "")}`], { cwd: repoPath });
      out.push({ path, exists: r.exitCode === 0 });
    }
    return out;
  }

  async createDetachedWorktree(repoPath: string, worktreePath: string, ref: string): Promise<void> {
    mkdirSync(dirname(worktreePath), { recursive: true });
    await this.git(repoPath, ["worktree", "add", "--detach", worktreePath, ref]);
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    await this.git(repoPath, ["worktree", "remove", "--force", worktreePath]);
    await this.git(repoPath, ["worktree", "prune"]);
  }

  async resetTo(worktreePath: string, sha: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`refusing to reset to ${sha}: not a full commit id`);
    // Only back along the branch's own history: never onto a commit the branch does not contain.
    const ancestor = await runProcess("git", [...SAFE_GIT, "merge-base", "--is-ancestor", sha, "HEAD"], { cwd: worktreePath });
    if (ancestor.exitCode !== 0) throw new Error(`refusing to reset: ${sha.slice(0, 12)} is not an ancestor of HEAD`);
    await this.git(worktreePath, ["reset", "--quiet", "--hard", sha]);
    await this.git(worktreePath, ["clean", "--quiet", "-fd"]);
  }

  async push(worktreePath: string, branch: string, opts?: PushOptions): Promise<void> {
    // Plain push: never --force. A rejected push surfaces as an error for a human.
    const id = this.pushIdentity(opts);
    // With a configured URL there is no remote name to track: no --set-upstream (it would write the URL into the clone's config).
    const upstream = id.target === "origin" ? ["--set-upstream"] : [];
    await this.git(worktreePath, ["push", "--quiet", ...upstream, id.target, `HEAD:refs/heads/${branch}`], 300_000, id.env);
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The first Node version file holding a version pin (an alias like `lts/*` is skipped). */
async function firstNodeVersionFile(read: (file: string) => Promise<string | null>): Promise<{ file: string; content: string } | null> {
  for (const file of NODE_VERSION_FILES) {
    const text = await read(file);
    if (text !== null && parseNodePin(text)) return { file, content: text.trim().slice(0, 200) };
  }
  return null;
}
