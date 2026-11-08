import type { Issue, IssueRef, IssueTracker } from "./types.js";

/**
 * Linear via its official GraphQL API (https://linear.app/developers).
 * Auth: a personal API key in LINEAR_API_KEY (sent as the raw Authorization
 * header, which is how Linear expects personal keys).
 */

const ENDPOINT = "https://api.linear.app/graphql";

const REF_FIELDS = "identifier title url state { name type }";

const ISSUE_QUERY = /* GraphQL */ `
  query OrchestratorIssue($id: String!) {
    issue(id: $id) {
      id identifier title description url updatedAt branchName priority priorityLabel
      state { name type }
      team { key name }
      project { name }
      assignee { name }
      labels { nodes { name } }
      parent { ${REF_FIELDS} }
      children(first: 50) { nodes { ${REF_FIELDS} } }
      relations(first: 50) { nodes { type relatedIssue { ${REF_FIELDS} } } }
      inverseRelations(first: 50) { nodes { type issue { ${REF_FIELDS} } } }
      comments(first: 100) { nodes { body createdAt user { name } } }
      attachments(first: 50) { nodes { title url } }
    }
  }
`;

type GqlRef = { identifier: string; title: string; url?: string; state: { name: string; type: string } };

interface GqlIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  branchName: string | null;
  priority: number;
  priorityLabel: string;
  state: { name: string; type: string };
  team: { key: string; name: string };
  project: { name: string } | null;
  assignee: { name: string } | null;
  labels: { nodes: Array<{ name: string }> };
  parent: GqlRef | null;
  children: { nodes: GqlRef[] };
  relations: { nodes: Array<{ type: string; relatedIssue: GqlRef }> };
  inverseRelations: { nodes: Array<{ type: string; issue: GqlRef }> };
  comments: { nodes: Array<{ body: string; createdAt: string; user: { name: string } | null }> };
  attachments: { nodes: Array<{ title: string; url: string }> };
}

export class LinearError extends Error {
  override name = "LinearError";
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class LinearTracker implements IssueTracker {
  readonly name = "linear";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    /** Shown instead of the generic message when no key was resolved (e.g. several stored workspaces). */
    private readonly missingKeyMessage?: string,
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) throw new LinearError(this.missingKeyMessage ?? "LINEAR_API_KEY is not set (create one at Linear → Settings → Security & access → API keys)");
    const res = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string }> };
    if (!res.ok || body.errors?.length) {
      const msg = body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new LinearError(`Linear API error: ${msg}`);
    }
    if (!body.data) throw new LinearError("Linear API returned no data");
    return body.data;
  }

  async whoami(): Promise<{ user: string; workspace: string; urlKey: string }> {
    const data = await this.gql<{ viewer: { name: string }; organization: { name: string; urlKey: string } }>(
      "query { viewer { name } organization { name urlKey } }",
      {},
    );
    return { user: data.viewer.name, workspace: `${data.organization.name} (${data.organization.urlKey})`, urlKey: data.organization.urlKey };
  }

  async getIssue(key: string): Promise<Issue> {
    let data: { issue: GqlIssue | null };
    try {
      data = await this.gql<{ issue: GqlIssue | null }>(ISSUE_QUERY, { id: key });
    } catch (err) {
      if (/not found|Entity not found/i.test((err as Error).message)) throw new LinearError(`issue ${key} not found in this Linear workspace`);
      throw err;
    }
    if (!data.issue) throw new LinearError(`issue ${key} not found in this Linear workspace`);
    return mapIssue(data.issue);
  }

  async comment(key: string, body: string): Promise<{ id: string }> {
    const issue = await this.getIssue(key);
    const data = await this.gql<{ commentCreate: { success: boolean; comment: { id: string } } }>(
      "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      { input: { issueId: issue.id, body } },
    );
    if (!data.commentCreate.success) throw new LinearError(`failed to comment on ${key}`);
    return { id: data.commentCreate.comment.id };
  }

  async setState(key: string, stateName: string): Promise<void> {
    const issue = await this.getIssue(key);
    const states = await this.gql<{ workflowStates: { nodes: Array<{ id: string; name: string }> } }>(
      "query($team: String!) { workflowStates(filter: { team: { key: { eq: $team } } }) { nodes { id name } } }",
      { team: issue.team.key },
    );
    const target = states.workflowStates.nodes.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
    if (!target) throw new LinearError(`team ${issue.team.key} has no workflow state named "${stateName}"`);
    await this.gql("mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }", {
      id: issue.id,
      stateId: target.id,
    });
  }
}

function ref(r: GqlRef): IssueRef {
  return { key: r.identifier, title: r.title, url: r.url, state: { name: r.state.name, type: r.state.type } };
}

export function mapIssue(i: GqlIssue): Issue {
  // Linear stores a relation once. `relations` are edges from this issue,
  // `inverseRelations` are edges pointing at it. Type "blocks" on an inverse
  // edge means the other issue blocks this one.
  const blocks = i.relations.nodes.filter((r) => r.type === "blocks").map((r) => ref(r.relatedIssue));
  const blockedBy = i.inverseRelations.nodes.filter((r) => r.type === "blocks").map((r) => ref(r.issue));
  const related = [
    ...i.relations.nodes.filter((r) => r.type !== "blocks").map((r) => ref(r.relatedIssue)),
    ...i.inverseRelations.nodes.filter((r) => r.type !== "blocks").map((r) => ref(r.issue)),
  ];
  return {
    id: i.id,
    key: i.identifier,
    title: i.title,
    url: i.url,
    description: i.description ?? "",
    state: { name: i.state.name, type: i.state.type },
    team: i.team,
    project: i.project?.name ?? null,
    labels: i.labels.nodes.map((l) => l.name),
    priority: { value: i.priority, label: i.priorityLabel },
    assignee: i.assignee?.name ?? null,
    branchName: i.branchName,
    parent: i.parent ? ref(i.parent) : null,
    children: i.children.nodes.map(ref),
    blockedBy,
    blocks,
    related,
    comments: i.comments.nodes
      .map((c) => ({ author: c.user?.name ?? "unknown", body: c.body, createdAt: c.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    attachments: i.attachments.nodes,
    updatedAt: i.updatedAt,
  };
}
