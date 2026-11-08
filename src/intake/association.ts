import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import type { Issue } from "../adapters/types.js";
import { loadBrief } from "../config/brief.js";
import type { Paths } from "../config/load.js";
import type { RepoConfig } from "../config/schema.js";
import { sameRepo } from "./repo-discovery.js";

/**
 * Does this issue belong to this repository? An issue key prefix is never enough (BRU-488 being a
 * BRU issue says nothing about which of the BRU repositories it is for). Evidence, strongest first:
 *
 *   - the operator selected the repository explicitly (`--repo`);
 *   - an operator brief exists for this issue and repository;
 *   - the operator confirmed the association before (`orchestrator associate`), stored outside any repository;
 *   - the repository config maps the issue's Linear project (`linear.projects`);
 *   - the issue itself links to the repository (an attachment or a github.com/owner/name URL).
 *
 * The last one comes from the issue, which is untrusted: it can confirm a repository the operator
 * already configured and selected, never pick or authorize one.
 */

export interface AssociationEvidence {
  kind: "explicit_repo" | "brief" | "confirmed" | "project_mapping" | "issue_link";
  detail: string;
}

export interface AssociationResult {
  verified: boolean;
  evidence: AssociationEvidence[];
  /** Other GitHub repositories the issue links to (a hint that the selection may be wrong). */
  conflicts: string[];
  /** Shown when unverified: what would verify it. */
  remedy: string | null;
}

export interface SavedAssociation {
  tracker: "linear";
  issue: string;
  repo: string;
  workspace: string | null;
  confirmedAt: string;
  confirmedBy: string;
}

export function associationsFile(paths: Pick<Paths, "home">): string {
  return join(paths.home, "associations.json");
}

export function loadAssociations(paths: Pick<Paths, "home">): SavedAssociation[] {
  const file = associationsFile(paths);
  if (!existsSync(file)) return [];
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { associations?: SavedAssociation[] }).associations ?? [];
  } catch {
    return [];
  }
}

export function saveAssociation(paths: Pick<Paths, "home">, a: Omit<SavedAssociation, "confirmedAt" | "confirmedBy"> & { confirmedBy?: string }): SavedAssociation {
  const saved: SavedAssociation = { ...a, confirmedAt: new Date().toISOString(), confirmedBy: a.confirmedBy ?? safeUser() };
  const rest = loadAssociations(paths).filter((x) => !(x.issue === a.issue && sameRepo(x.repo, a.repo)));
  const file = associationsFile(paths);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, associations: [...rest, saved] }, null, 2)}\n`);
  return saved;
}

export function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

const GITHUB_REPO_URL = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/#?\s)\]>"'`]|$)/gi;

/** GitHub repositories an issue links to, from attachments and its description. */
export function linkedRepositories(issue: Pick<Issue, "attachments" | "description">): string[] {
  const out = new Map<string, string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(GITHUB_REPO_URL)) {
      const repo = `${m[1]}/${m[2]!.replace(/\.+$/, "")}`;
      if (!out.has(repo.toLowerCase())) out.set(repo.toLowerCase(), repo);
    }
  };
  for (const a of issue.attachments) scan(a.url);
  scan(issue.description);
  return [...out.values()];
}

export function evaluateAssociation(input: {
  issue: Pick<Issue, "key" | "project" | "attachments" | "description">;
  repo: string;
  config: Pick<RepoConfig, "linear">;
  paths: Paths;
  explicitRepo: boolean;
  workspace?: string | null;
}): AssociationResult {
  const { issue, repo, config, paths } = input;
  const evidence: AssociationEvidence[] = [];
  if (input.explicitRepo) evidence.push({ kind: "explicit_repo", detail: `repository selected explicitly with --repo ${repo}` });
  let brief = null;
  try {
    brief = loadBrief(paths, repo, issue.key);
  } catch {
    brief = null;
  }
  if (brief) evidence.push({ kind: "brief", detail: `operator brief ${brief.source}` });
  const saved = loadAssociations(paths).find((a) => a.issue === issue.key && sameRepo(a.repo, repo) && (!a.workspace || !input.workspace || a.workspace === input.workspace));
  if (saved) evidence.push({ kind: "confirmed", detail: `confirmed by ${saved.confirmedBy} on ${saved.confirmedAt.slice(0, 10)} (${associationsFile(paths)})` });
  if (config.linear.projects.length && issue.project && config.linear.projects.includes(issue.project)) {
    evidence.push({ kind: "project_mapping", detail: `Linear project "${issue.project}" is mapped to ${repo} (linear.projects)` });
  }
  const linked = linkedRepositories(issue);
  if (linked.some((r) => sameRepo(r, repo))) evidence.push({ kind: "issue_link", detail: `the issue links to github.com/${repo}` });
  const conflicts = linked.filter((r) => !sameRepo(r, repo));
  const verified = evidence.length > 0;
  return {
    verified,
    evidence,
    conflicts,
    remedy: verified
      ? null
      : `Nothing links ${issue.key} to ${repo}: no operator brief, no saved confirmation, no mapped Linear project${config.linear.projects.length ? ` (${config.linear.projects.join(", ")})` : ""}, and the issue does not link to the repository. ` +
        `If ${issue.key} really is ${repo} work, confirm it once with \`orchestrator associate ${issue.key} --repo ${repo}\` (you confirm a system prompt; stored in ${associationsFile(paths)}), or pass --repo ${repo} explicitly.`,
  };
}
