import { ConfigError, listRepoConfigs, loadRepoConfig, loadRepoConfigFile, type LoadedRepoConfig, type Paths } from "../config/load.js";
import { discoverRepository, sameRepo, type DiscoveryDeps, type RepoDiscovery } from "./repo-discovery.js";

/**
 * Which repository does a request target, and is it configured? Precedence:
 *
 *   1. `--repo owner/name` (explicit; still has to be configured, and is checked against GitHub when planning);
 *   2. `--config <file>` (its `repo`);
 *   3. the Git repository containing the working directory (main checkout, linked worktree or a
 *      nested directory), identified by its GitHub remotes. One distinct GitHub repository → that one.
 *      Several (fork + upstream, mirrors) → the single one with operator config, otherwise ambiguous.
 *      Remote order and the name "origin" are never used to break a tie;
 *   4. outside any Git repository: the configured repositories whose `linear.teams` include the
 *      issue's team (the association check then needs real evidence, see association.ts).
 */

export type SelectionSource = "explicit" | "config_file" | "cwd" | "team";

export interface Candidate {
  repo: string;
  remotes: string[];
  configured: boolean;
}

export interface RepoSelection {
  status: "resolved" | "ambiguous" | "no_github_remote" | "not_found";
  repo: string | null;
  source: SelectionSource | null;
  reason: string;
  candidates: Candidate[];
  discovery: RepoDiscovery | null;
  warnings: string[];
}

export type ConfigStatus =
  | { status: "authorized"; loaded: LoadedRepoConfig; scope: "supervised" | "read_only" | "operator_file"; authorizedBy: string | null; authorizedAt: string | null }
  | { status: "missing"; expected: string }
  | { status: "invalid"; error: string };

function isConfigured(repo: string, paths: Paths): boolean {
  try {
    loadRepoConfig(repo, paths);
    return true;
  } catch {
    return false;
  }
}

export async function selectRepository(input: { repo?: string; configFile?: string; cwd: string; issueKey: string; paths: Paths; deps?: DiscoveryDeps }): Promise<RepoSelection> {
  const { paths } = input;
  const discovery = await discoverRepository(input.cwd, input.deps).catch(() => null);
  const cwdCandidates = (discovery?.candidates ?? []).map((c) => ({ repo: c.repo, remotes: c.remotes, configured: isConfigured(c.repo, paths) }));

  if (input.repo || input.configFile) {
    let repo = input.repo;
    if (!repo) repo = loadRepoConfigFile(input.configFile!).config.repo;
    const source: SelectionSource = input.repo ? "explicit" : "config_file";
    const warnings: string[] = [];
    if (discovery?.inGitRepo && cwdCandidates.length > 0 && !cwdCandidates.some((c) => sameRepo(c.repo, repo!))) {
      warnings.push(`the working directory belongs to ${cwdCandidates.map((c) => c.repo).join(" / ")}, not ${repo}; the run uses the orchestrator's own clone of ${repo}`);
    }
    return { status: "resolved", repo, source, reason: source === "explicit" ? `--repo ${repo}` : `repo from ${input.configFile}`, candidates: cwdCandidates, discovery, warnings };
  }

  if (discovery?.inGitRepo) {
    const where = discovery.isLinkedWorktree ? `linked worktree ${discovery.worktreeRoot} (main checkout ${discovery.mainCheckout})` : `${discovery.worktreeRoot}`;
    if (cwdCandidates.length === 0) {
      const remotes = discovery.remotes.length ? discovery.remotes.map((r) => `${r.name}=${r.url || "?"}${r.note ? ` (${r.note})` : ""}`).join(", ") : "no remotes";
      return {
        status: "no_github_remote",
        repo: null,
        source: null,
        reason: `${where} has no GitHub remote (${remotes}), so its GitHub repository cannot be verified. Pass --repo owner/name, or add the GitHub remote.`,
        candidates: [],
        discovery,
        warnings: [],
      };
    }
    if (cwdCandidates.length === 1) {
      const only = cwdCandidates[0]!;
      return { status: "resolved", repo: only.repo, source: "cwd", reason: `${where}: remote ${only.remotes.join(", ")} → github.com/${only.repo}`, candidates: cwdCandidates, discovery, warnings: [] };
    }
    const configured = cwdCandidates.filter((c) => c.configured);
    if (configured.length === 1) {
      const pick = configured[0]!;
      const others = cwdCandidates.filter((c) => c !== pick).map((c) => c.repo);
      return {
        status: "resolved",
        repo: pick.repo,
        source: "cwd",
        reason: `${where} has remotes for ${cwdCandidates.map((c) => c.repo).join(", ")}; only ${pick.repo} has operator configuration`,
        candidates: cwdCandidates,
        discovery,
        warnings: [`also found ${others.join(", ")} (not configured); pass --repo to choose differently`],
      };
    }
    return {
      status: "ambiguous",
      repo: null,
      source: null,
      reason: `${where} has remotes for several GitHub repositories (${cwdCandidates.map((c) => `${c.repo} via ${c.remotes.join("/")}${c.configured ? ", configured" : ""}`).join("; ")}); ${configured.length ? "more than one is configured" : "none is configured"}. Choose one with --repo owner/name.`,
      candidates: cwdCandidates,
      discovery,
      warnings: [],
    };
  }

  const team = input.issueKey.split("-")[0]!.toUpperCase();
  const matches = listRepoConfigs(paths).filter((c) => c.config.linear.teams.map((t) => t.toUpperCase()).includes(team));
  const candidates = matches.map((m) => ({ repo: m.config.repo, remotes: [], configured: true }));
  if (matches.length === 1) {
    return { status: "resolved", repo: matches[0]!.config.repo, source: "team", reason: `not in a Git repository; ${matches[0]!.config.repo} is the only configured repository for ${team} issues`, candidates, discovery, warnings: [] };
  }
  if (matches.length === 0) {
    return { status: "not_found", repo: null, source: null, reason: `not in a Git repository and no configured repository handles ${team} issues. Run from the project's checkout, or pass --repo owner/name.`, candidates, discovery, warnings: [] };
  }
  return { status: "ambiguous", repo: null, source: null, reason: `${team} issues map to several configured repositories (${candidates.map((c) => c.repo).join(", ")}). Run from the project's checkout, or pass --repo.`, candidates, discovery, warnings: [] };
}

export function configStatus(repo: string, paths: Paths, configFile?: string): ConfigStatus {
  try {
    const loaded = configFile ? (loadRepoConfig(repo, paths, configFile)) : loadRepoConfig(repo, paths);
    const auth = loaded.config.authorization;
    return {
      status: "authorized",
      loaded,
      scope: auth?.scope ?? "operator_file",
      authorizedBy: auth?.authorized_by ?? null,
      authorizedAt: auth?.authorized_at ?? null,
    };
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof ConfigError && msg.startsWith("no configuration for")) {
      const [owner, name] = repo.split("/");
      return { status: "missing", expected: `${paths.repoConfigs}/${owner}/${name}.yaml` };
    }
    return { status: "invalid", error: msg };
  }
}
