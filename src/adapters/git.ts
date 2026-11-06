import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runChecked, runProcess } from "../core/exec.js";
import type { ChangedFile, RepoInspection, Workspace } from "./types.js";

const GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md", ".github/pull_request_template.md", "docs/ARCHITECTURE.md"];

export class GitWorkspace implements Workspace {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
    return runChecked("git", args, { cwd, env: { ...this.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs });
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
      const r = await runProcess("git", ["show", `${ref}:${file}`], { cwd: root });
      return r.exitCode === 0 ? r.stdout : null;
    };
    const list = async (dir: string): Promise<string[]> => {
      if (!ref) return existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : [];
      const r = await runProcess("git", ["ls-tree", "--name-only", `${ref}:${dir}`], { cwd: root });
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
      ? (await runProcess("git", ["ls-tree", "-r", "--name-only", ref], { cwd: root })).stdout
      : (await runProcess("git", ["ls-files"], { cwd: root })).stdout;
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
    };
  }

  async branchExists(repoPath: string, branch: string): Promise<{ local: boolean; remote: boolean }> {
    const local = (await runProcess("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath })).exitCode === 0;
    const remote = (await runProcess("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: repoPath })).exitCode === 0;
    return { local, remote };
  }

  async createWorktree(input: { repoPath: string; worktreePath: string; branch: string; baseRef: string }): Promise<{ created: boolean; headSha: string }> {
    if (existsSync(join(input.worktreePath, ".git"))) {
      const current = await this.git(input.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (current !== input.branch) {
        throw new Error(`worktree ${input.worktreePath} exists on branch ${current}, expected ${input.branch}`);
      }
      return { created: false, headSha: await this.headSha(input.worktreePath) };
    }
    mkdirSync(dirname(input.worktreePath), { recursive: true });
    const { local } = await this.branchExists(input.repoPath, input.branch);
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
    const out = await this.git(worktreePath, ["diff", "--name-status", "--no-renames", `${baseSha}...HEAD`]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status: status ?? "?", path: rest.join("\t") };
      });
  }

  diff(worktreePath: string, baseSha: string): Promise<string> {
    return this.git(worktreePath, ["diff", "--stat", "--patch", `${baseSha}...HEAD`]);
  }

  async commitAll(worktreePath: string, message: string): Promise<string | null> {
    await this.git(worktreePath, ["add", "--all"]);
    const staged = await runProcess("git", ["diff", "--cached", "--quiet"], { cwd: worktreePath });
    if (staged.exitCode === 0) return null;
    await this.git(worktreePath, ["commit", "--quiet", "-m", message]);
    return this.headSha(worktreePath);
  }

  async push(worktreePath: string, branch: string): Promise<void> {
    // Plain push: never --force. A rejected push surfaces as an error for a human.
    await this.git(worktreePath, ["push", "--quiet", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], 300_000);
  }
}
