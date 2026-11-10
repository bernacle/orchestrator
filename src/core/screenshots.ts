import { createHash } from "node:crypto";
import { existsSync, lstatSync, openSync, readFileSync, readSync, closeSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { ChangedFile } from "../adapters/types.js";
import type { CheckConfig, ScreenshotsConfig } from "../config/schema.js";
import { globRoot, matchGlob } from "./glob.js";

/**
 * Orchestrator-generated screenshots (see ScreenshotsSchema). The command is repository code and
 * runs like a check: sandboxed, network off except localhost, scrubbed environment, tripwired. This
 * module only decides whether screenshots are required and which files the command produced.
 */

export const SCREENSHOT_CHECK_NAME = "screenshots";

/** The screenshot command as a check: always sandboxed with no outbound network. */
export function screenshotCheck(cfg: ScreenshotsConfig): CheckConfig {
  return { name: SCREENSHOT_CHECK_NAME, run: cfg.run, timeout_minutes: cfg.timeout_minutes, optional: false, network: "none" };
}

/** Required when the change touches `when_changed` (or always, when it is empty). */
export function screenshotsRequired(cfg: ScreenshotsConfig | undefined, changed: ChangedFile[]): boolean {
  if (!cfg) return false;
  if (cfg.when_changed.length === 0) return true;
  return changed.some((f) => f.status !== "D" && cfg.when_changed.some((g) => matchGlob(f.path, g)));
}

export interface Screenshot {
  /** Worktree-relative path. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface ScreenshotCollection {
  files: Screenshot[];
  /** Why a matching file was refused (each one makes the whole set unusable). */
  problems: string[];
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

function imageKind(path: string): "png" | "jpeg" | "webp" | null {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(12);
    const n = readSync(fd, head, 0, 12, 0);
    if (n >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (n >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
    if (n >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Files matching `outputs` that the command wrote (modified at or after `sinceMs`). Walks only the
 * literal root of each glob, never follows symlinks, and refuses anything that is not a regular
 * image file inside the worktree within the size and count limits.
 */
export function collectScreenshots(worktree: string, cfg: ScreenshotsConfig, sinceMs: number): ScreenshotCollection {
  const realWorktree = realpathSync(worktree);
  const found = new Map<string, Screenshot>();
  const problems: string[] = [];
  const maxBytes = Math.round(cfg.max_file_mb * 1024 * 1024);

  const visit = (rel: string) => {
    const abs = join(worktree, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      if (cfg.outputs.some((g) => matchGlob(rel, g))) problems.push(`${rel} is a symbolic link`);
      return;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(rel.split("/").pop() ?? "")) return;
      for (const name of readdirSync(abs).sort()) visit(rel ? `${rel}/${name}` : name);
      return;
    }
    if (!st.isFile() || found.has(rel) || !cfg.outputs.some((g) => matchGlob(rel, g))) return;
    if (st.mtimeMs < sinceMs) return; // left over from before this run of the command
    if (st.size > maxBytes) return void problems.push(`${rel} is ${(st.size / 1024 / 1024).toFixed(1)} MB (limit ${cfg.max_file_mb} MB)`);
    if (!imageKind(abs)) return void problems.push(`${rel} is not a PNG, JPEG or WebP image`);
    found.set(rel, { path: rel, bytes: st.size, sha256: createHash("sha256").update(readFileSync(abs)).digest("hex") });
  };

  for (const root of [...new Set(cfg.outputs.map(globRoot))]) {
    const abs = root ? join(worktree, root) : worktree;
    if (!existsSync(abs)) continue;
    // A root reached through a symlinked directory could point outside the worktree.
    const real = realpathSync(abs);
    if (real !== realWorktree && !real.startsWith(realWorktree + sep)) {
      problems.push(`${root} resolves outside the worktree`);
      continue;
    }
    visit(root);
  }
  const files = [...found.values()];
  if (files.length > cfg.max_files) problems.push(`${files.length} screenshots (limit ${cfg.max_files})`);
  return { files, problems };
}
