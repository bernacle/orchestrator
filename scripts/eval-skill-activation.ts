/**
 * Does a real model choose the installed Orchestrator skill for ordinary requests, and leave it
 * alone for ordinary issue discussion? This makes real Claude Code / Codex calls (it costs tokens,
 * roughly $0.05–0.30 per case), so it is not part of `pnpm test`. Results vary between runs and
 * models: treat them as measurements, not guarantees.
 *
 *   pnpm eval:skills                         # both providers, cwd = a temp dir
 *   pnpm eval:skills -- --provider codex
 *   pnpm eval:skills -- --cwd ~/src/project  # evaluate from a real project directory
 *   pnpm eval:skills -- --claude-home ~/.claude-work2   # the Claude config dir T3 uses
 *   pnpm eval:skills -- --skills-root /tmp/x  # evaluate a copy installed under /tmp/x instead of the
 *        user-level one: Claude Code loads /tmp/x/.claude/skills via --add-dir; Codex gets HOME=/tmp/x
 *        (so ~/.agents/skills is /tmp/x/.agents/skills) with the real CODEX_HOME for its login
 *
 * Safety: the agents cannot change anything. Claude Code runs with only the Skill and Read tools
 * (everything else is denied in -p mode) and no MCP servers; Codex runs `exec --sandbox read-only`.
 * Each case stops as soon as the skill is activated. ORCHESTRATOR_NO_EXECUTE=1 is set as well.
 *
 * Activation signal: Claude Code calls its Skill tool with skill "orchestrate" (or reads that
 * SKILL.md); Codex reads `.../orchestrate/SKILL.md` (its documented way of applying a skill).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Case {
  prompt: string;
  expect: boolean;
}

export const CASES: Case[] = [
  { prompt: "Use Orchestrator for BRU-488.", expect: true },
  { prompt: "I want to implement Linear issue BRU-488 using Orchestrator.", expect: true },
  { prompt: "Can you work on https://linear.app/brunosimplicio/issue/BRU-488 using Orchestrator?", expect: true },
  { prompt: "Let's use Orchestrator to handle BRU-488.", expect: true },
  { prompt: "Quero implementar a task BRU-488 do Linear usando o Orchestrator.", expect: true },
  { prompt: "What's the status of the Orchestrator run for BRU-488?", expect: true },
  { prompt: "Resume my Orchestrator run for BRU-488.", expect: true },
  { prompt: "Show me the review findings from the BRU-488 Orchestrator run.", expect: true },
  { prompt: "What does BRU-488 mean?", expect: false },
  { prompt: "Summarize the acceptance criteria for BRU-488.", expect: false },
  { prompt: "Show me my open Linear issues.", expect: false },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Outcome {
  activated: boolean;
  signal: string;
  ms: number;
}

function runUntil(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }, detect: (line: string) => string | null): Promise<Outcome> {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let finished = false;
    const finish = (o: Omit<Outcome, "ms">) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      done({ ...o, ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish({ activated: false, signal: "timeout" }), opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const hit = detect(line);
        if (hit) finish({ activated: true, signal: hit });
      }
    });
    child.on("exit", (code) => finish({ activated: false, signal: `exited ${code ?? "?"} without activating` }));
  });
}

function claudeDetect(line: string): string | null {
  try {
    const e = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } };
    for (const block of e.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      if (block.name === "Skill" && /orchestrate/.test(JSON.stringify(block.input))) return `Skill ${JSON.stringify(block.input)}`;
      if (block.name === "Read" && /orchestrate\/SKILL\.md/.test(JSON.stringify(block.input))) return "Read orchestrate/SKILL.md";
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function codexDetect(line: string): string | null {
  if (!/orchestrate\/SKILL\.md/.test(line)) return null;
  try {
    const e = JSON.parse(line) as { item?: { type?: string; command?: string } };
    if (e.item?.type === "command_execution") return `read ${e.item.command?.slice(0, 80)}`;
  } catch {
    /* not JSON */
  }
  return "referenced orchestrate/SKILL.md";
}

async function main() {
  const provider = arg("provider");
  const cwdArg = arg("cwd");
  const temp = mkdtempSync(join(tmpdir(), "orch-eval-"));
  const cwd = cwdArg ? resolve(cwdArg.replace(/^~/, homedir())) : temp;
  const claudeHome = arg("claude-home");
  const skillsRoot = arg("skills-root") ? resolve(arg("skills-root")!) : null;
  const env = { ...process.env, ORCHESTRATOR_NO_EXECUTE: "1", ...(claudeHome ? { CLAUDE_CONFIG_DIR: resolve(claudeHome.replace(/^~/, homedir())) } : {}) };
  const codexEnv = skillsRoot ? { ...env, HOME: skillsRoot, CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), ".codex") } : env;
  const only = arg("case");
  const cases = only ? CASES.filter((_, i) => String(i) === only) : CASES;
  const results: Array<Case & { provider: string } & Outcome> = [];

  for (const p of provider ? [provider] : ["claude", "codex"]) {
    for (const c of cases) {
      const o =
        p === "claude"
          ? await runUntil(
              "claude",
              ["-p", c.prompt, "--output-format", "stream-json", "--verbose", "--max-turns", "3", "--allowedTools", "Skill", "Read", "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", ...(skillsRoot ? ["--add-dir", skillsRoot] : [])],
              { cwd, env, timeoutMs: 180_000 },
              claudeDetect,
            )
          : await runUntil("codex", ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", cwd, c.prompt], { cwd, env: codexEnv, timeoutMs: 240_000 }, codexDetect);
      const pass = o.activated === c.expect;
      results.push({ ...c, provider: p, ...o });
      console.log(`${pass ? "PASS" : "FAIL"} ${p.padEnd(6)} ${c.expect ? "activate " : "stay off "} ${o.activated ? "activated" : "not used "} ${String(Math.round(o.ms / 1000)).padStart(4)}s  ${c.prompt}${o.activated ? `  [${o.signal}]` : ""}`);
    }
  }
  const out = join(tmpdir(), `orchestrator-skill-eval-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ cwd, claudeHome: claudeHome ?? null, skillsRoot, at: new Date().toISOString(), results }, null, 2));
  const passed = results.filter((r) => r.activated === r.expect).length;
  console.log(`\n${passed}/${results.length} as expected. Details: ${out}`);
  rmSync(temp, { recursive: true, force: true });
  process.exitCode = passed === results.length ? 0 : 1;
}

void main();
