import { join } from "node:path";
import { GitWorkspace } from "../adapters/git.js";
import type { App } from "../app.js";
import { IntakeError } from "../app.js";
import { probe, runProcess } from "../core/exec.js";
import { SAFE_GIT } from "../adapters/git.js";
import { buildProposal, type Proposal } from "./proposal.js";
import { configStatus, selectRepository } from "./resolve.js";
import { sameRepo } from "./repo-discovery.js";

/**
 * `orchestrator repo init`: identify the repository, inspect it read-only, and write a pending
 * proposal. Uses the working directory's checkout when it is that repository, read with `git show`
 * at the remote's default branch as last fetched (or HEAD), so uncommitted edits and hooks play no
 * part; otherwise the orchestrator's own clone.
 */
export async function proposeConfiguration(app: App, opts: { repo?: string; cwd?: string; team?: string; workspace?: GitWorkspace }): Promise<{ proposal: Proposal; inspected: string; existing: string | null }> {
  const cwd = opts.cwd ?? process.cwd();
  const sel = await selectRepository({ ...(opts.repo ? { repo: opts.repo } : {}), cwd, issueKey: `${opts.team ?? "X"}-0`, paths: app.paths, deps: app.discovery });
  if (sel.status !== "resolved" || !sel.repo) throw new IntakeError("repository_unresolved", sel.reason, { candidates: sel.candidates });
  if (sel.source === "team") throw new IntakeError("repository_unresolved", "run `orchestrator repo init` from the repository's checkout, or pass --repo owner/name");
  const repo = sel.repo;
  const current = configStatus(repo, app.paths);
  const ws = opts.workspace ?? new GitWorkspace(app.env);

  const local = sel.discovery?.inGitRepo && sel.discovery.candidates.some((c) => sameRepo(c.repo, repo)) ? sel.discovery.worktreeRoot! : null;
  let inspectPath: string;
  let ref: string;
  if (local) {
    inspectPath = local;
    // Prefer the remote's default branch as last fetched (no fetch here): a checkout's HEAD may be
    // a feature branch or behind. Fall back to HEAD.
    ref = "HEAD";
    const remote = sel.discovery!.candidates.find((c) => sameRepo(c.repo, repo))!.remotes[0]!;
    const head = await runProcess("git", [...SAFE_GIT, "symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { cwd: local });
    if (head.exitCode === 0 && head.stdout.trim()) ref = head.stdout.trim();
    else if ((await runProcess("git", [...SAFE_GIT, "rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/main`], { cwd: local })).exitCode === 0) ref = `${remote}/main`;
  } else {
    const [owner, name] = repo.split("/");
    inspectPath = join(app.paths.clones, owner!, name!);
    await ws.ensureClone(repo, inspectPath, { fetch: true });
    const head = await runProcess("git", [...SAFE_GIT, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: inspectPath });
    ref = head.exitCode === 0 ? head.stdout.trim() : "origin/main";
  }
  const inspection = await ws.inspect(inspectPath, ref);
  const [claude, codex] = await Promise.all([probe("claude"), probe("codex")]);
  const proposal = buildProposal({
    repo,
    inspection,
    teams: opts.team ? [opts.team.toUpperCase()] : [],
    agentsAvailable: { claude: claude !== null, codex: codex !== null },
    paths: app.paths,
  });
  return { proposal, inspected: `${inspectPath} @ ${ref} (${inspection.headSha.slice(0, 8)})`, existing: current.status === "authorized" ? current.loaded.source : null };
}
