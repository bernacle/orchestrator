import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { z } from "zod";
import { PACKAGE_ROOT } from "../config/load.js";

/**
 * One canonical skill (integrations/skills/orchestrate: skill.yaml + SKILL.body.md), rendered per
 * provider. Only packaging differs: frontmatter fields, the explicit-invocation sigil (`/` for
 * Claude Code, `$` for Codex), and Codex's agents/openai.yaml. The behaviour text is identical.
 */

export type Provider = "claude" | "codex";
export const PROVIDERS: Provider[] = ["claude", "codex"];

export const SKILL_SOURCE_DIR = join(PACKAGE_ROOT, "integrations", "skills", "orchestrate");

const MetaSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(40),
  when_to_use: z.string().default(""),
  argument_hint: z.string().default(""),
  codex: z.object({ display_name: z.string(), short_description: z.string().min(25).max(64), default_prompt: z.string() }),
});
export type SkillMeta = z.infer<typeof MetaSchema>;

/** Claude Code truncates description + when_to_use beyond this in the skill listing. */
export const CLAUDE_LISTING_CAP = 1536;

export function loadSkillSource(dir = SKILL_SOURCE_DIR): { meta: SkillMeta; body: string; sourceSha256: string } {
  const metaText = readFileSync(join(dir, "skill.yaml"), "utf8");
  const body = readFileSync(join(dir, "SKILL.body.md"), "utf8");
  const meta = MetaSchema.parse(parseYaml(metaText));
  const sourceSha256 = createHash("sha256").update(metaText).update("\0").update(body).digest("hex");
  return { meta, body, sourceSha256 };
}

export interface RenderedSkill {
  provider: Provider;
  name: string;
  /** Relative path → content. */
  files: Record<string, string>;
}

/** Subcommands that never change anything (no run, no config, no credential). */
export const READ_ONLY_SUBCOMMANDS = ["context", "status", "review"];

export function frontmatter(fields: Record<string, unknown>): string {
  return `---\n${stringify(fields, { lineWidth: 0 }).trimEnd()}\n---\n\n`;
}

export function renderSkill(provider: Provider, opts: { cli: string; version: string; source?: ReturnType<typeof loadSkillSource> }): RenderedSkill {
  const { meta, body } = opts.source ?? loadSkillSource();
  const sigil = provider === "claude" ? "/" : "$";
  const text = body.replaceAll("{{ORCHESTRATOR}}", opts.cli).replaceAll("{{INVOKE}}", `${sigil}${meta.name}`);
  const owned = { "orchestrator-owned": "true", "orchestrator-version": opts.version };
  if (provider === "claude") {
    const fm = {
      name: meta.name,
      description: meta.description,
      ...(meta.when_to_use ? { when_to_use: meta.when_to_use } : {}),
      ...(meta.argument_hint ? { "argument-hint": meta.argument_hint } : {}),
      // Pre-approve only the strictly read-only subcommands, so a session with permission prompts
      // does not stall on preparation. Runs, resumes and authorization steps still ask.
      "allowed-tools": READ_ONLY_SUBCOMMANDS.map((c) => `Bash(${opts.cli} ${c}:*)`),
      metadata: owned,
    };
    return { provider, name: meta.name, files: { "SKILL.md": frontmatter(fm) + text } };
  }
  const fm = {
    name: meta.name,
    // Codex reads name + description only: the examples go into the description.
    description: meta.when_to_use ? `${meta.description} ${meta.when_to_use}` : meta.description,
    metadata: { "short-description": meta.codex.short_description, ...owned },
  };
  const openai = stringify({
    interface: { display_name: meta.codex.display_name, short_description: meta.codex.short_description, default_prompt: meta.codex.default_prompt },
    // Keep automatic selection on: discovery is not authorization. The skill itself requires explicit
    // approval before any live run or authorization step.
    policy: { allow_implicit_invocation: true },
  }, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" });
  return { provider, name: meta.name, files: { "SKILL.md": frontmatter(fm) + text, "agents/openai.yaml": openai } };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
