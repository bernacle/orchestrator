import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { OperatorDecision } from "../planning/dependencies.js";
import { ConfigError, PACKAGE_ROOT, type Paths } from "./load.js";

/**
 * An operator brief: scope decisions and dependency decisions for one issue,
 * written by a human and kept with the operator's configuration (never in the
 * target repository). Briefs are authoritative over the issue text where they
 * conflict, and their hash is recorded in every plan for audit.
 *
 *   ---
 *   issue: BRU-488
 *   repo: bernacle/analyticool
 *   dependencies:
 *     BRU-485: { role: reference, reason: "…" }
 *   ---
 *   Markdown scope notes given to the planner, implementer and reviewer.
 */

const BriefSchema = z.object({
  issue: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
  repo: z.string(),
  dependencies: z
    .record(
      z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
      z.object({
        role: z.enum(["prerequisite", "reference"]).optional(),
        reason: z.string().min(1),
        satisfied_when_files_exist: z.array(z.string().min(1)).optional(),
      }),
    )
    .default({}),
});

export interface Brief {
  source: string;
  sha256: string;
  issue: string;
  repo: string;
  decisions: Record<string, OperatorDecision>;
  body: string;
}

export function parseBrief(text: string, source: string): Brief {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new ConfigError(`${source}: a brief starts with a YAML front-matter block (---)`);
  const parsed = BriefSchema.safeParse(parseYaml(m[1]!));
  if (!parsed.success) {
    throw new ConfigError(`${source}: invalid brief\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const decisions: Record<string, OperatorDecision> = {};
  for (const [key, d] of Object.entries(parsed.data.dependencies)) {
    decisions[key] = {
      ...(d.role ? { role: d.role } : {}),
      reason: d.reason,
      ...(d.satisfied_when_files_exist ? { satisfiedWhenFilesExist: d.satisfied_when_files_exist } : {}),
      source: `brief ${source.split("/").slice(-3).join("/")}`,
    };
  }
  return {
    source,
    sha256: createHash("sha256").update(text).digest("hex"),
    issue: parsed.data.issue,
    repo: parsed.data.repo,
    decisions,
    body: m[2]!.trim(),
  };
}

export function briefSearchPath(paths: Paths): string[] {
  return [join(paths.home, "briefs"), join(PACKAGE_ROOT, "config", "briefs")];
}

/** Brief for an issue, if one exists. ORCHESTRATOR_HOME/briefs overrides the bundled config/briefs. */
export function loadBrief(paths: Paths, repo: string, issueKey: string): Brief | null {
  for (const dir of briefSearchPath(paths)) {
    const file = join(dir, ...repo.split("/"), `${issueKey}.md`);
    if (!existsSync(file)) continue;
    const brief = parseBrief(readFileSync(file, "utf8"), file);
    if (brief.issue !== issueKey || brief.repo !== repo) throw new ConfigError(`${file} is for ${brief.issue} on ${brief.repo}, not ${issueKey} on ${repo}`);
    return brief;
  }
  return null;
}
