import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeNode, resolveRunToolchain } from "../adapters/checks.js";
import { ClaudeCodeAgent } from "../adapters/claude.js";
import type { Adapters, CheckResult } from "../adapters/types.js";
import type { LoadedRepoConfig, Paths } from "../config/load.js";
import type { CheckConfig } from "../config/schema.js";
import {
  ALWAYS_DENIED_ENV,
  childEnv,
  compareTripwire,
  credentialPaths,
  defaultWritable,
  isolationDirs,
  sandboxSupport,
  takeTripwire,
  toolchainCaches,
  tripwirePaths,
  type NetworkPolicy,
} from "../core/isolation.js";

/**
 * Preflight: prove that the live-run environment works before any agent touches code.
 *
 * In a throwaway detached worktree of the orchestrator-owned clone (at origin/<base>), run the
 * repository's setup and every check exactly as a live run would: sandboxed, scrubbed env,
 * tripwired. Optionally probe the implementer's sandbox. Then remove the worktree.
 * Nothing is pushed, no branch is created, Linear and GitHub are not written to.
 */

export interface PreflightStep {
  kind: "setup" | "check" | "agent-probe" | "tripwire" | "isolation" | "toolchain";
  name: string;
  ok: boolean;
  detail: string;
  durationMs?: number;
  logPath?: string | null;
}

export interface PreflightReport {
  repo: string;
  baseRef: string;
  baseSha: string;
  worktree: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  steps: PreflightStep[];
  reportPath: string;
}

export async function runPreflight(input: {
  loaded: LoadedRepoConfig;
  adapters: Adapters;
  paths: Paths;
  agentProbe: boolean;
  keep: boolean;
  onStep?: (s: PreflightStep) => void;
}): Promise<PreflightReport> {
  const { config } = input.loaded;
  const { workspace, checks } = input.adapters;
  const [owner, name] = config.repo.split("/") as [string, string];
  const steps: PreflightStep[] = [];
  const record = (s: PreflightStep) => {
    steps.push(s);
    input.onStep?.(s);
  };
  const startedAt = new Date().toISOString();
  let baseSha = "";
  const stamp = startedAt.replace(/[:.]/g, "-");
  const dir = join(input.paths.home, "preflight", owner, name, stamp);
  const worktree = join(dir, "worktree");
  const logs = join(dir, "logs");
  mkdirSync(logs, { recursive: true });

  const support = sandboxSupport();
  record({ kind: "isolation", name: "check sandbox", ok: support.available, detail: support.detail });
  if (!support.available && config.isolation.require) {
    return finish(false);
  }

  const clone = config.local_path ?? join(input.paths.clones, owner, name);
  if (!config.local_path) await workspace.ensureClone(config.repo, clone, { fetch: true });
  const baseRef = `origin/${config.base_branch ?? "main"}`;
  const inspection = await workspace.inspect(clone, baseRef);
  baseSha = inspection.headSha;
  await workspace.createDetachedWorktree(clone, worktree, baseSha);

  // Same resolution as a live run: config plus the base commit's version file, probed in the worktree.
  const tc = await resolveRunToolchain({ toolchain: config.toolchain, versionFile: inspection.nodeVersionFile, cwd: worktree, dirs: isolationDirs(input.paths.home) });
  const env = tc.env;
  record({ kind: "toolchain", name: "node", ok: tc.node.source !== "unresolved", detail: describeNode(tc.node) });
  if (tc.node.source === "unresolved") {
    if (!input.keep && existsSync(worktree)) await workspace.removeWorktree(clone, worktree).catch(() => undefined);
    return finish(false);
  }
  const tripPaths = [...tripwirePaths(process.env, [join(clone, ".git")]), join(clone, ".git", "HEAD"), join(clone, ".git", "refs")];
  let allOk = true;

  try {
    const run = async (kind: "setup" | "check", c: CheckConfig, network: NetworkPolicy): Promise<CheckResult> => {
      const before = takeTripwire(tripPaths);
      const res = await checks.run({
        name: c.name,
        command: c.run,
        cwd: worktree,
        env,
        timeoutMs: c.timeout_minutes * 60_000,
        optional: c.optional,
        logPath: join(logs, `${kind}-${c.name}.log`),
        signal: new AbortController().signal,
        sandbox: support.available ? { writable: defaultWritable(worktree, process.env), denyRead: credentialPaths(process.env, input.paths.home), network } : null,
      });
      const changed = compareTripwire(before, takeTripwire(tripPaths));
      if (changed.length) {
        allOk = false;
        record({ kind: "tripwire", name: `${kind} ${c.name}`, ok: false, detail: `changed outside the worktree: ${changed.join(", ")}` });
      }
      const tail = res.outputTail.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 220);
      record({ kind, name: c.name, ok: res.ok, detail: res.ok ? `exit 0, network=${network}` : `exit ${res.exitCode}${res.timedOut ? " (timeout)" : ""}: ${tail}`, durationMs: res.durationMs, logPath: res.logPath });
      if (!res.ok && !c.optional) allOk = false;
      return res;
    };

    for (const s of config.setup) {
      const res = await run("setup", s, s.network ?? config.isolation.setup_network);
      if (!res.ok && !s.optional) return finish(false);
    }
    for (const c of config.checks) await run("check", c, c.network ?? config.isolation.checks_network);

    if (input.agentProbe && config.agents.implementer.adapter === "claude-code") {
      record(await probeImplementerSandbox(config.agents.implementer, worktree, input.paths, tc.toolchainEnv, logs));
      if (!steps.at(-1)!.ok) allOk = false;
    }
    if (await workspace.hasUncommittedChanges(worktree)) {
      record({ kind: "check", name: "worktree clean after checks", ok: false, detail: "setup/checks modified tracked files; a live run would block" });
      allOk = false;
    }
    return finish(allOk);
  } finally {
    if (!input.keep && existsSync(worktree)) await workspace.removeWorktree(clone, worktree).catch(() => undefined);
  }

  function finish(ok: boolean): PreflightReport {
    const report: PreflightReport = {
      repo: config.repo,
      baseRef: `origin/${config.base_branch ?? "main"}`,
      baseSha,
      worktree,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok,
      steps,
      reportPath: join(dir, "preflight.json"),
    };
    writeFileSync(report.reportPath, JSON.stringify(report, null, 2));
    return report;
  }
}

/**
 * Run a cheap model under the implementer's exact isolation settings. It runs one allowed check (does
 * the toolchain work inside the sandbox?) and a probe script the orchestrator placed in the worktree,
 * which attempts escapes from inside the sandbox. Ground truth comes from the script's own output
 * file and from the disk, never from the model's report.
 */
async function probeImplementerSandbox(cfg: Extract<import("../config/schema.js").AgentConfig, { adapter: "claude-code" }>, worktree: string, paths: Paths, baseEnv: NodeJS.ProcessEnv, logs: string): Promise<PreflightStep> {
  const marker = join(homedir(), `.orchestrator-preflight-escape-${process.pid}`);
  const allowedCheck = cfg.allowed_tools.some((t) => /^Bash\(pnpm lint/.test(t)) ? "pnpm lint" : "ls";
  const script = join(worktree, ".orchestrator-probe.sh");
  const out = join(worktree, ".orchestrator-probe-out");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `exec > "${out}" 2>&1`,
      "echo probe-ran",
      `${allowedCheck} >/dev/null 2>&1; echo "check-exit=$?"`,
      `touch "${marker}" 2>/dev/null && echo "ESCAPE write-outside" || echo "blocked write-outside"`,
      'ls "$HOME/.ssh" >/dev/null 2>&1 && echo "ESCAPE read-ssh" || echo "blocked read-ssh"',
      `node -e "require('https').get('https://example.com',()=>{console.log('ESCAPE network');process.exit(0)}).on('error',()=>console.log('blocked network'))"`,
      '[ -n "$GH_TOKEN$GITHUB_TOKEN$LINEAR_API_KEY$SSH_AUTH_SOCK" ] && echo "ESCAPE env-credentials" || echo "blocked env-credentials"',
      "",
    ].join("\n"),
  );
  const agent = new ClaudeCodeAgent(
    { ...cfg, model: "claude-haiku-5-5", max_budget_usd: 0.25, allowed_tools: [...cfg.allowed_tools, "Bash(sh .orchestrator-probe.sh)"] },
    { denyRead: credentialPaths(process.env, paths.home), deniedEnv: ALWAYS_DENIED_ENV, allowWrite: toolchainCaches(process.env) },
  );
  const env = childEnv(baseEnv, { agent: "claude-code", dirs: isolationDirs(paths.home) });
  const prompt = [
    "Orchestrator preflight. Run this command with the Bash tool, exactly as written, and report its exit status:",
    "sh .orchestrator-probe.sh",
    `It is the orchestrator's own sandbox self-test script in this worktree: it runs \`${allowedCheck}\` and checks that the sandbox blocks escapes.`,
  ].join("\n");
  const r = await agent.run({ role: "implementer", cwd: worktree, prompt, artifactDir: logs, artifactPrefix: "agent-probe", timeoutMs: 6 * 60_000, env, signal: new AbortController().signal, sessionId: crypto.randomUUID(), maxBudgetUsd: 0.25 });
  const escapedOnDisk = existsSync(marker);
  const results = existsSync(out) ? readFileSync(out, "utf8") : "";
  for (const f of [script, out]) if (existsSync(f)) unlinkSync(f);
  const ran = results.includes("probe-ran");
  const escapes = results.split("\n").filter((l) => l.startsWith("ESCAPE"));
  const checkWorked = /check-exit=0\b/.test(results);
  const ok = r.ok && ran && escapes.length === 0 && !escapedOnDisk && checkWorked;
  const verdict = !ran ? "probe script did not run (inconclusive)" : escapes.length || escapedOnDisk ? `ESCAPES: ${[...escapes, ...(escapedOnDisk ? ["file outside worktree exists"] : [])].join(", ")}` : results.split("\n").filter((l) => l.startsWith("blocked")).join(", ");
  return {
    kind: "agent-probe",
    name: "implementer sandbox",
    ok,
    detail: `${r.ok ? "" : `agent error: ${r.error}; `}\`${allowedCheck}\` ${checkWorked ? "ran inside the sandbox" : "did NOT work inside the sandbox"}; escape probe: ${verdict}; cost $${r.costUsd?.toFixed(3) ?? "?"}`,
    durationMs: r.durationMs,
    logPath: r.transcripts[0] ?? null,
  };
}
