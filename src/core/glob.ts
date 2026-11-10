/**
 * Minimal path globs for operator config: `*` and `?` stay within one path segment, `**` crosses
 * segments. A pattern without a slash also matches the file's basename (".env" matches "a/.env").
 */
export function matchGlob(path: string, pattern: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split("**")
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
      .join(".*")}$`,
  );
  const base = path.split("/").pop() ?? path;
  return re.test(path) || (!pattern.includes("/") && re.test(base));
}

/** The literal directory a pattern starts in ("docs/design/**\/shots/*.png" → "docs/design"); "" for the root. */
export function globRoot(pattern: string): string {
  const parts = pattern.split("/");
  const literal: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (/[*?[]/.test(part)) break;
    literal.push(part);
  }
  return literal.join("/");
}
