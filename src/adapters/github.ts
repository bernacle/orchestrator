import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecError, runChecked, runProcess } from "../core/exec.js";
import type { BranchProtection, CheckBucket, CodeHost, PrEvidence, PullRequestStatus, RepoInfo } from "./types.js";

/**
 * GitHub through the official `gh` CLI, using whatever identity `gh auth`
 * is configured with. Never passes --admin; merges always pin --match-head-commit.
 */

const PR_FIELDS = "number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,body";

type Gh = (args: string[]) => Promise<string>;

export class GitHubHost implements CodeHost {
  readonly name = "github";
  private readonly gh: Gh;

  constructor(gh?: Gh, env: NodeJS.ProcessEnv = process.env) {
    this.gh = gh ?? ((args) => runChecked("gh", args, { env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, timeoutMs: 60_000 }));
  }

  private async json<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.gh(args)) as T;
  }

  async viewer(): Promise<{ login: string }> {
    return { login: (await this.gh(["api", "user", "--jq", ".login"])).trim() };
  }

  async getRepo(repo: string, branch?: string): Promise<RepoInfo> {
    const r = await this.json<{
      full_name: string;
      default_branch: string;
      visibility: string;
      allow_auto_merge?: boolean;
      allow_squash_merge?: boolean;
      allow_merge_commit?: boolean;
      allow_rebase_merge?: boolean;
      permissions?: Record<string, boolean>;
    }>(["api", `repos/${repo}`]);
    const base = branch ?? r.default_branch;
    const sha = (await this.gh(["api", `repos/${repo}/commits/${encodeURIComponent(base)}`, "--jq", ".sha"])).trim();
    const perms = r.permissions ?? {};
    const viewerPermission = perms.admin ? "admin" : perms.maintain ? "maintain" : perms.push ? "write" : perms.pull ? "read" : "none";
    return {
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      visibility: r.visibility,
      baseSha: sha,
      allowAutoMerge: Boolean(r.allow_auto_merge),
      mergeMethods: [
        ...(r.allow_squash_merge ? (["squash"] as const) : []),
        ...(r.allow_merge_commit ? (["merge"] as const) : []),
        ...(r.allow_rebase_merge ? (["rebase"] as const) : []),
      ],
      viewerPermission,
    };
  }

  /**
   * Combines classic branch protection (visible via the branch endpoint) and
   * rulesets (the rules/branches endpoint, readable without admin).
   */
  async getBranchProtection(repo: string, branch: string): Promise<BranchProtection> {
    const notes: string[] = [];
    const b = await this.json<{
      protected: boolean;
      protection?: { required_status_checks?: { contexts?: string[]; checks?: Array<{ context: string }> } };
    }>(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}`]);

    const required = new Set<string>([
      ...(b.protection?.required_status_checks?.contexts ?? []),
      ...(b.protection?.required_status_checks?.checks ?? []).map((c) => c.context),
    ]);
    let requiredApprovals = 0;
    let rulesetTypes: string[] = [];
    try {
      const rules = await this.json<Array<{ type: string; parameters?: Record<string, unknown> }>>([
        "api",
        `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`,
      ]);
      rulesetTypes = [...new Set(rules.map((r) => r.type))];
      for (const rule of rules) {
        if (rule.type === "required_status_checks") {
          const checks = (rule.parameters?.required_status_checks as Array<{ context: string }> | undefined) ?? [];
          for (const c of checks) required.add(c.context);
        }
        if (rule.type === "pull_request") {
          requiredApprovals = Math.max(requiredApprovals, Number(rule.parameters?.required_approving_review_count ?? 0));
        }
      }
    } catch (err) {
      notes.push(`rulesets unavailable: ${(err as Error).message.split("\n")[0]}`);
    }
    if (b.protected && requiredApprovals === 0) {
      notes.push("classic protection review requirements need admin access to read; treated as unknown");
    }
    return {
      branch,
      protected: b.protected || rulesetTypes.length > 0,
      requiredChecks: [...required].sort(),
      requiredApprovals,
      rulesetTypes,
      notes,
    };
  }

  async findPullRequest(repo: string, headBranch: string): Promise<PullRequestStatus | null> {
    const list = await this.json<Array<{ number: number }>>([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      headBranch,
      "--state",
      "all",
      "--json",
      "number",
      "--limit",
      "5",
    ]);
    const first = list[0];
    return first ? this.getPullRequest(repo, first.number) : null;
  }

  async createPullRequest(input: { repo: string; base: string; head: string; title: string; body: string; draft: boolean; labels: string[] }): Promise<PullRequestStatus> {
    const dir = mkdtempSync(join(tmpdir(), "orch-pr-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, input.body);
    try {
      const args = ["pr", "create", "--repo", input.repo, "--base", input.base, "--head", input.head, "--title", input.title, "--body-file", bodyFile];
      if (input.draft) args.push("--draft");
      for (const label of input.labels) args.push("--label", label);
      const url = (await this.gh(args)).trim().split("\n").pop() ?? "";
      const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
      if (!Number.isInteger(number)) throw new Error(`could not parse PR number from gh output: ${url}`);
      return this.getPullRequest(input.repo, number);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestStatus> {
    const pr = await this.json<RawPr>(["pr", "view", String(number), "--repo", repo, "--json", PR_FIELDS]);
    return mapPr(pr);
  }

  async linkedPullRequests(input: { repo: string; issueKey: string; prNumbers: number[]; attachmentUrls: string[] }): Promise<PrEvidence[]> {
    type Lite = { number: number; url: string; title: string; state: "OPEN" | "CLOSED" | "MERGED"; mergedAt: string | null; headRefName: string; body: string };
    const fields = "number,url,title,state,mergedAt,headRefName,body";
    const keyRe = new RegExp(`(^|[^A-Za-z0-9])${input.issueKey}([^0-9]|$)`, "i");
    const link = (p: Lite): PrEvidence["link"] => (keyRe.test(p.title) ? "title" : keyRe.test(p.headRefName) ? "branch" : keyRe.test(p.body ?? "") ? "body" : "none");
    const out = new Map<number, PrEvidence>();
    const add = (p: Lite, via: PrEvidence["via"]) => {
      if (!out.has(p.number)) out.set(p.number, { number: p.number, url: p.url, title: p.title, state: p.state, mergedAt: p.mergedAt, via, link: link(p) });
    };
    for (const n of input.prNumbers) {
      try {
        add(await this.json<Lite>(["pr", "view", String(n), "--repo", input.repo, "--json", fields]), "description");
      } catch {
        /* PR number from prose may not exist in this repo */
      }
    }
    for (const n of prNumbersFromUrls(input.repo, input.attachmentUrls)) {
      try {
        add(await this.json<Lite>(["pr", "view", String(n), "--repo", input.repo, "--json", fields]), "linear-attachment");
      } catch {
        /* ignore */
      }
    }
    const found = await this.json<Lite[]>(["pr", "list", "--repo", input.repo, "--state", "all", "--search", `${input.issueKey} in:title,body`, "--json", fields, "--limit", "20"]);
    for (const p of found) add(p, "search");
    return [...out.values()].filter((p) => p.via !== "search" || p.link !== "none");
  }

  async updatePullRequestBody(input: { repo: string; number: number; body: string }): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "orch-pr-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, input.body);
    try {
      await this.gh(["pr", "edit", String(input.number), "--repo", input.repo, "--body-file", bodyFile]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async markPullRequestReady(input: { repo: string; number: number }): Promise<void> {
    await this.gh(["pr", "ready", String(input.number), "--repo", input.repo]);
  }

  async mergePullRequest(input: { repo: string; number: number; headSha: string; method: "squash" | "merge" | "rebase" }): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(input.headSha)) throw new Error("refusing to merge without a full head SHA");
    await this.gh(["pr", "merge", String(input.number), "--repo", input.repo, `--${input.method}`, "--match-head-commit", input.headSha]);
  }
}

export function prNumbersFromUrls(repo: string, urls: string[]): number[] {
  const re = new RegExp(`github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/(\\d+)`, "i");
  return urls.map((u) => u.match(re)?.[1]).filter((n): n is string => Boolean(n)).map(Number);
}

interface RawPr {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  reviewDecision: string | null;
  body?: string;
  statusCheckRollup: Array<
    | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null; detailsUrl?: string }
    | { __typename: "StatusContext"; context: string; state: string; targetUrl?: string }
  > | null;
}

export function bucketFor(item: NonNullable<RawPr["statusCheckRollup"]>[number]): CheckBucket {
  if (item.__typename === "CheckRun") {
    if (item.status !== "COMPLETED") return "pending";
    switch (item.conclusion) {
      case "SUCCESS":
      case "NEUTRAL":
        return "pass";
      case "SKIPPED":
        return "skipped";
      default:
        return "fail";
    }
  }
  switch (item.state) {
    case "SUCCESS":
      return "pass";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "fail";
  }
}

export function mapPr(pr: RawPr): PullRequestStatus {
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    headSha: pr.headRefOid,
    baseRefName: pr.baseRefName,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: (pr.reviewDecision || null) as PullRequestStatus["reviewDecision"],
    checks: (pr.statusCheckRollup ?? []).map((c) => ({
      name: c.__typename === "CheckRun" ? c.name : c.context,
      bucket: bucketFor(c),
      detailsUrl: c.__typename === "CheckRun" ? c.detailsUrl : c.targetUrl,
    })),
    ...(typeof pr.body === "string" ? { body: pr.body } : {}),
  };
}

export async function ghAuthStatus(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await runProcess("gh", ["auth", "status", "--active"], { timeoutMs: 20_000 });
    const line = (r.stdout + r.stderr).split("\n").find((l) => /Logged in to/.test(l))?.trim();
    return { ok: r.exitCode === 0, detail: line ?? (r.stderr.trim().split("\n")[0] || "not authenticated") };
  } catch (err) {
    return { ok: false, detail: err instanceof ExecError ? err.message : `gh not found (${(err as Error).message})` };
  }
}
