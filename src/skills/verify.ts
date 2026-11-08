import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runProcess } from "../core/exec.js";
import { CLAUDE_LISTING_CAP, loadSkillSource, type Provider } from "./render.js";
import type { TargetStatus } from "./install.js";

/**
 * Non-destructive discovery checks. They prove the skill is where the provider looks and that the
 * provider parses it; they cannot prove a model will *choose* it for a given sentence. That is
 * measured separately with real model calls (scripts/eval-skill-activation.ts).
 *
 *   - Codex: `codex debug prompt-input` renders the exact model-visible prompt, including the skill
 *     catalog, without calling a model. We check the skill is listed once, with its full description.
 *   - Claude Code: there is no offline equivalent (`claude plugin validate` does not parse personal
 *     skill frontmatter), so we parse the installed SKILL.md as Claude Code would: frontmatter on the
 *     first line, valid YAML, `name` matching the directory, the listing text within its 1,536-character cap.
 */

export interface VerifyResult {
  provider: Provider;
  path: string;
  ok: boolean;
  method: string;
  detail: string;
}

export function parseFrontmatter(text: string): Record<string, unknown> | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  try {
    const v = parseYaml(text.slice(4, end)) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function verifyClaude(status: TargetStatus): VerifyResult {
  const file = join(status.path, "SKILL.md");
  const base = { provider: "claude" as const, path: status.path, method: "SKILL.md frontmatter parsed as Claude Code does" };
  if (!existsSync(file)) return { ...base, ok: false, detail: "SKILL.md not found (not installed here)" };
  const fm = parseFrontmatter(readFileSync(file, "utf8"));
  if (!fm) return { ...base, ok: false, detail: "frontmatter missing or invalid YAML: Claude Code would load the body with empty metadata and could not match the description" };
  const name = String(fm.name ?? "");
  const listing = `${String(fm.description ?? "")} ${String(fm.when_to_use ?? "")}`.trim();
  if (name !== loadSkillSource().meta.name) return { ...base, ok: false, detail: `name "${name}" does not match the directory` };
  if (listing.length > CLAUDE_LISTING_CAP) return { ...base, ok: false, detail: `description + when_to_use is ${listing.length} chars; Claude Code truncates at ${CLAUDE_LISTING_CAP}` };
  if (fm["disable-model-invocation"] === true) return { ...base, ok: false, detail: "disable-model-invocation is set: Claude would never choose it automatically" };
  return { ...base, ok: true, detail: `valid; ${listing.length}/${CLAUDE_LISTING_CAP} listing chars; model invocation enabled; /${name} available. Claude Code reads ${status.dir} when CLAUDE_CONFIG_DIR is ${status.dir.replace(/\/skills$/, "")}${status.why.startsWith("~/.claude") ? " (or unset)" : ""}` };
}

/** Parse Codex's skill catalog (`### Skill roots` + `### Available skills`) out of the prompt dump. */
export function codexCatalog(promptDump: string): { roots: Record<string, string>; skills: Array<{ name: string; description: string; file: string }> } {
  const text = promptText(promptDump);
  const roots: Record<string, string> = {};
  for (const m of text.matchAll(/^- `(r\d+)` = `([^`]+)`$/gm)) roots[m[1]!] = m[2]!;
  const skills: Array<{ name: string; description: string; file: string }> = [];
  for (const m of text.matchAll(/^- ([\w:.-]+): (.*) \(file: ([^)]+)\)$/gm)) {
    const file = m[3]!.replace(/^(r\d+)\//, (_x, r: string) => `${roots[r] ?? r}/`);
    skills.push({ name: m[1]!, description: m[2]!, file });
  }
  return { roots, skills };
}

/** The dump is JSON (a list of input items); join every string in it. Plain text is used as is. */
function promptText(dump: string): string {
  try {
    const out: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(JSON.parse(dump));
    return out.join("\n");
  } catch {
    return dump;
  }
}

export async function verifyCodex(status: TargetStatus, env: NodeJS.ProcessEnv = process.env): Promise<VerifyResult> {
  const base = { provider: "codex" as const, path: status.path, method: "`codex debug prompt-input` (renders the model-visible skill catalog; no model call)" };
  const cwd = mkdtempSync(join(tmpdir(), "orch-codex-probe-"));
  try {
    const r = await runProcess("codex", ["debug", "prompt-input", "Use Orchestrator for BRU-488"], { cwd, env, timeoutMs: 90_000 }).catch((err: Error) => ({ exitCode: 1, stdout: "", stderr: err.message }));
    if (r.exitCode !== 0) return { ...base, ok: false, detail: `codex debug prompt-input failed: ${(r.stderr || r.stdout).trim().split("\n").pop() ?? ""}` };
    const { meta } = loadSkillSource();
    const listed = codexCatalog(r.stdout).skills.filter((s) => s.name === meta.name);
    if (listed.length === 0) return { ...base, ok: false, detail: `Codex does not list "${meta.name}" (it scans ~/.agents/skills and $CODEX_HOME/skills; restart Codex if it was just installed)` };
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const ours = listed.filter((s) => real(s.file) === real(join(status.path, "SKILL.md")));
    if (ours.length === 0) return { ...base, ok: false, detail: `Codex lists "${meta.name}" from ${listed.map((s) => s.file).join(", ")}, not from ${status.path}` };
    if (listed.length > 1) return { ...base, ok: false, detail: `Codex lists "${meta.name}" ${listed.length} times (${listed.map((s) => s.file).join(", ")}); remove the extra copy` };
    const full = ours[0]!.description.startsWith(meta.description.slice(0, 120));
    return { ...base, ok: full, detail: full ? `listed once from ${ours[0]!.file} with its full description; implicit invocation allowed (agents/openai.yaml)` : "listed, but the description is truncated or altered" };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
