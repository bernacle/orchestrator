import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { crc32, inflateSync } from "node:zlib";
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

/** Required when the change touches `when_changed` or `outputs` (or always, when `when_changed` is empty). */
export function screenshotsRequired(cfg: ScreenshotsConfig | undefined, changed: ChangedFile[]): boolean {
  if (!cfg) return false;
  if (cfg.when_changed.length === 0) return true;
  // A branch that adds or changes files under `outputs` always needs them regenerated and validated,
  // so an image the implementer placed there by hand is never published unchecked.
  return changed.some((f) => f.status !== "D" && (cfg.when_changed.some((g) => matchGlob(f.path, g)) || matchesOutputs(f.path, cfg)));
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/**
 * Chunks a rendered screenshot needs (Chromium writes only IHDR, IDAT, IEND). Text, EXIF, ICC
 * profiles and private chunks can carry arbitrary bytes into a public PR, so they are refused.
 */
const PNG_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "sRGB", "gAMA", "cHRM", "pHYs", "sBIT", "bKGD"]);
/** Path segments that are safe in git pathspecs and Markdown links: no spaces, brackets, quotes or leading dots. */
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** Why `data` is not a plain PNG screenshot, or null. Chunk layout and CRCs are checked; pixels are not. */
export function pngProblem(data: Buffer): string | null {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return "is not a PNG image";
  let offset = 8;
  let first = true;
  for (;;) {
    if (offset + 12 > data.length) return "is a truncated PNG";
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString("latin1");
    const end = offset + 12 + length;
    if (end > data.length) return "is a truncated PNG";
    if (first && type !== "IHDR") return "is a malformed PNG (no IHDR)";
    if (!PNG_CHUNKS.has(type)) return `contains a PNG "${type.replace(/[^\x20-\x7e]/g, "?")}" chunk (only image data is allowed)`;
    const crc = data.readUInt32BE(end - 4);
    if (crc32(data.subarray(offset + 4, end - 4)) !== crc) return "is a corrupt PNG (bad chunk checksum)";
    first = false;
    offset = end;
    if (type === "IEND") {
      if (offset !== data.length) return "has data after the end of the PNG";
      try {
        pngPixels(data);
      } catch (err) {
        return `has image data that does not decompress (${(err as Error).message.split("\n")[0]})`;
      }
      return null;
    }
  }
}

/** Largest decompressed image accepted (a 1280×12000 RGBA full-page capture is ~61 MB). */
export const MAX_PIXEL_BYTES = 128 * 1024 * 1024;

/** The decompressed image data of a PNG that passed pngProblem (for scanning what the pixels encode). */
export function pngPixels(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 8; offset + 12 <= data.length; ) {
    const length = data.readUInt32BE(offset);
    if (data.subarray(offset + 4, offset + 8).toString("latin1") === "IDAT") parts.push(data.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return inflateSync(Buffer.concat(parts), { maxOutputLength: MAX_PIXEL_BYTES });
}

/** Does a worktree-relative path match one of the configured outputs? */
export function matchesOutputs(path: string, cfg: ScreenshotsConfig): boolean {
  return cfg.outputs.some((g) => matchGlob(path, g));
}

interface OutputWalk {
  files: Array<{ rel: string; abs: string; stamp: string; size: number }>;
  problems: string[];
}

/**
 * Regular files matching `outputs`. Walks only the literal root of each glob, never follows
 * symlinks (a matching symlink is a problem), and refuses roots that resolve outside the worktree.
 */
function walkOutputs(worktree: string, cfg: ScreenshotsConfig): OutputWalk {
  const realWorktree = realpathSync(worktree);
  const files: OutputWalk["files"] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  const visit = (rel: string) => {
    const abs = join(worktree, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      if (matchesOutputs(rel, cfg)) problems.push(`${rel} is a symbolic link`);
      return;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(rel.split("/").pop() ?? "")) return;
      for (const name of readdirSync(abs).sort()) visit(rel ? `${rel}/${name}` : name);
      return;
    }
    if (!st.isFile() || seen.has(rel) || !matchesOutputs(rel, cfg)) return;
    seen.add(rel);
    files.push({ rel, abs, stamp: `${st.ino}:${st.mtimeMs}:${st.size}`, size: st.size });
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
  return { files, problems };
}

/** Identity of every file matching `outputs` before the command runs (inode, mtime, size). */
export function outputStamps(worktree: string, cfg: ScreenshotsConfig): Record<string, string> {
  return Object.fromEntries(walkOutputs(worktree, cfg).files.map((f) => [f.rel, f.stamp]));
}

/**
 * The files matching `outputs` that the command wrote: new, or rewritten since `before` (an identical
 * re-render still gets a new mtime). Anything else is not counted as produced by this run. Each one
 * must be a plain PNG with a safe name, within the size and count limits.
 */
export function collectScreenshots(worktree: string, cfg: ScreenshotsConfig, before: Record<string, string>): ScreenshotCollection {
  const walk = walkOutputs(worktree, cfg);
  const problems = [...walk.problems];
  const files: Screenshot[] = [];
  const maxBytes = Math.round(cfg.max_file_mb * 1024 * 1024);
  for (const f of walk.files) {
    if (before[f.rel] === f.stamp) continue; // not written by this run of the command
    if (!f.rel.split("/").every((seg) => SAFE_SEGMENT.test(seg))) {
      problems.push(`${JSON.stringify(f.rel)} has characters outside [A-Za-z0-9._-]`);
      continue;
    }
    if (f.size > maxBytes) {
      problems.push(`${f.rel} is ${(f.size / 1024 / 1024).toFixed(1)} MB (limit ${cfg.max_file_mb} MB)`);
      continue;
    }
    const data = readFileSync(f.abs);
    const bad = pngProblem(data);
    if (bad) {
      problems.push(`${f.rel} ${bad}`);
      continue;
    }
    files.push({ path: f.rel, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  }
  if (files.length > cfg.max_files) problems.push(`${files.length} screenshots (limit ${cfg.max_files})`);
  return { files, problems };
}
