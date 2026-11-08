/**
 * Smoke-test the real agent adapters against a throwaway git repository.
 * Verifies CLI flags, structured output and parsing end to end, at minimal cost.
 *
 *   pnpm smoke:agents            # both
 *   pnpm smoke:agents codex      # reviewer only
 *   pnpm smoke:agents claude     # planner only
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAgent } from "../src/adapters/claude.js";
import { CodexAgent } from "../src/adapters/codex.js";
import { resolvePaths } from "../src/config/load.js";
import { ALWAYS_DENIED_ENV, childEnv, credentialPaths, isolationDirs, toolchainCaches } from "../src/core/isolation.js";
import { AGENT_PLAN_SCHEMA, parseAgentPlan } from "../src/planning/plan.js";
import { decideReview, parseReview, REVIEW_OUTPUT_SCHEMA } from "../src/planning/review.js";

const which = process.argv[2] ?? "all";
const dir = mkdtempSync(join(tmpdir(), "orch-smoke-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

try {
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  git("add", ".");
  git("-c", "user.name=smoke", "-c", "user.email=smoke@local", "commit", "-q", "-m", "init");
  const base = git("rev-parse", "HEAD");
  // A deliberately buggy change for the reviewer to find.
  writeFileSync(join(dir, "math.js"), "export function add(a, b) {\n  return a - b; // add two numbers\n}\n");
  git("-c", "user.name=smoke", "-c", "user.email=smoke@local", "commit", "-qam", "tweak add");
  const head = git("rev-parse", "HEAD");
  const artifacts = mkdtempSync(join(tmpdir(), "orch-smoke-artifacts-"));
  // Same scrubbed environment and isolation the workflow uses.
  const paths = resolvePaths();
  const dirs = isolationDirs(paths.home);
  const common = { cwd: dir, artifactDir: artifacts, signal: new AbortController().signal, timeoutMs: 5 * 60_000 };

  if (which === "all" || which === "codex") {
    const codex = new CodexAgent({ adapter: "codex", sandbox: "read-only", timeout_minutes: 5 });
    const r = await codex.run({
      ...common,
      env: childEnv(process.env, { agent: "codex", dirs }),
      role: "reviewer",
      artifactPrefix: "review",
      outputSchema: REVIEW_OUTPUT_SCHEMA,
      prompt: `Review \`git diff ${base}...${head}\`. The function is meant to add two numbers. Respond only with JSON matching the schema.`,
    });
    console.log(`codex: ok=${r.ok} session=${r.sessionId} ${Math.round(r.durationMs / 1000)}s${r.error ? ` error=${r.error}` : ""}`);
    const outcome = parseReview(r.structured);
    const decision = decideReview(outcome, ["blocker", "major"]);
    console.log(`  verdict=${outcome.verdict} findings=${outcome.findings.map((f) => `${f.severity}:${f.title}`).join(" | ")} approved=${decision.approved}`);
    const unchanged = git("rev-parse", "HEAD") === head && git("status", "--porcelain") === "";
    console.log(`  worktree unchanged by reviewer: ${unchanged}`);
  }

  if (which === "all" || which === "claude") {
    const claude = new ClaudeCodeAgent(
      { adapter: "claude-code", permission_mode: "acceptEdits", allowed_tools: [], disallowed_tools: [], timeout_minutes: 5, max_budget_usd: 0.5 },
      { denyRead: credentialPaths(process.env, paths.home), deniedEnv: ALWAYS_DENIED_ENV, allowWrite: toolchainCaches(process.env) },
    );
    const r = await claude.run({
      ...common,
      env: childEnv(process.env, { agent: "claude-code", dirs }),
      role: "planner",
      artifactPrefix: "plan",
      outputSchema: AGENT_PLAN_SCHEMA,
      sessionId: crypto.randomUUID(),
      prompt: "Plan how to add a `subtract(a, b)` function to math.js with a test. Keep it to 3 steps. Respond only with JSON matching the schema.",
    });
    console.log(`claude: ok=${r.ok} session=${r.sessionId} cost=$${r.costUsd ?? "?"} ${Math.round(r.durationMs / 1000)}s${r.error ? ` error=${r.error}` : ""}`);
    const plan = parseAgentPlan(r.structured);
    console.log(`  plan parsed=${Boolean(plan)} steps=${plan?.steps.length ?? 0} files=${plan?.files.map((f) => f.path).join(",") ?? ""}`);
    console.log(`  repo unchanged by planner: ${git("status", "--porcelain") === ""}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
