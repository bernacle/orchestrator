/**
 * Issue references as users type them: a key (`BRU-488`, `bru-488`) or a Linear URL
 * (`https://linear.app/<workspace>/issue/BRU-488/optional-slug`). The tracker adapter still fetches
 * the issue; this only normalizes the reference and keeps the workspace a URL names, so a URL from
 * one Linear workspace is never resolved with another workspace's credentials.
 *
 * The `tracker` field leaves room for other trackers (GitHub Issues, Jira) without implementing them.
 */

export interface IssueRef {
  tracker: "linear";
  key: string;
  /** Linear workspace urlKey, when the reference was a URL. */
  workspace: string | null;
  input: string;
}

export class IssueRefError extends Error {
  override name = "IssueRefError";
}

const KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const LINEAR_URL = /^(?:https?:\/\/)?(?:www\.)?linear\.app\/([\w-]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/i;

export function parseIssueRef(input: string): IssueRef {
  const text = input.trim().replace(/^<|>$/g, "");
  const key = text.match(KEY);
  if (key) return { tracker: "linear", key: `${key[1]!.toUpperCase()}-${key[2]}`, workspace: null, input };
  const url = text.match(LINEAR_URL);
  if (url) return { tracker: "linear", key: url[2]!.toUpperCase(), workspace: url[1]!.toLowerCase(), input };
  if (/^https?:\/\//i.test(text)) throw new IssueRefError(`"${input}" is not a Linear issue URL (expected https://linear.app/<workspace>/issue/KEY-123)`);
  throw new IssueRefError(`"${input}" is not a Linear issue key or URL (expected e.g. BRU-488 or https://linear.app/<workspace>/issue/BRU-488)`);
}

/** True when the text looks like an issue reference rather than a run id (`bru-488-1a2b3c`). */
export function looksLikeIssueRef(input: string): boolean {
  try {
    parseIssueRef(input);
    return true;
  } catch {
    return false;
  }
}
