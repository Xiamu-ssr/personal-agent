import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { privateResult } from "../_shared/http.mjs";

function tokenValues(values) {
  const token = typeof values.token === "string" ? values.token.trim() : "";
  if (!token || token === "••••") throw new Error("请填写 GitHub 个人访问令牌（PAT）");
  return { ...values, token };
}

const owner = z.string().max(39).regex(/^[a-z\d]+(?:-[a-z\d]+)*(?![\s\S])/i, "GitHub owner 格式不正确");
const repo = z.string().max(100).regex(/^[a-z\d_.-]+(?![\s\S])/i, "GitHub repo 格式不正确")
  .refine((s) => s !== "." && s !== "..", "GitHub repo 格式不正确");
const repository = { owner, repo };
const pagination = { per_page: z.number().int().min(1).max(100).default(30), page: z.number().int().min(1).default(1) };
const since = z.iso.datetime({ offset: true }).optional();
const cut = (s, limit) => s == null ? null : s.length > limit ? s.slice(0, limit) + "…" : s;
const repoResult = (r) => ({ name: r.name, full_name: r.full_name, private: r.private, description: cut(r.description, 500),
  stars: r.stargazers_count, open_issues: r.open_issues_count, updated_at: r.updated_at, html_url: r.html_url });
const issueResult = (i, limit = 1000) => ({ number: i.number, title: i.title, state: i.state, is_pull_request: !!i.pull_request,
  author: i.user?.login ?? null, labels: (i.labels || []).map((l) => typeof l === "string" ? l : l.name), comments: i.comments,
  created_at: i.created_at, updated_at: i.updated_at, closed_at: i.closed_at, html_url: i.html_url,
  body: cut(i.body, limit), body_truncated: (i.body?.length || 0) > limit });
const commentResult = (c) => ({ id: c.id, author: c.user?.login ?? null, body: cut(c.body, 2000), body_truncated: (c.body?.length || 0) > 2000,
  created_at: c.created_at, updated_at: c.updated_at, html_url: c.html_url });
const notificationResult = (n) => ({ id: n.id, repository: repoResult(n.repository),
  subject: { title: n.subject.title, type: n.subject.type, url: n.subject.url }, reason: n.reason, unread: n.unread,
  updated_at: n.updated_at, last_read_at: n.last_read_at });
const repoPath = ({ owner, repo }) => `/repos/${owner}/${repo}`;

// Endpoint/fetch injection is for local fake services only, never an account field.
export function createGithubConnector({ baseUrl = "https://api.github.com", fetchImpl = fetch } = {}) {
  async function request(values, endpoint, query = {}, list = false) {
    const url = new URL(baseUrl.replace(/\/$/, "") + endpoint);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${values.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "doudou-personal-agent" }, signal: AbortSignal.timeout(20_000), redirect: "error" });
    } catch { throw new Error("GitHub 连接超时或网络不可用，请稍后重试"); }
    if (!response.ok) {
      if ([403, 429].includes(response.status) && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))) {
        throw new Error("GitHub 请求过于频繁，稍后重试");
      }
      if ([401, 403].includes(response.status)) throw new Error("GitHub 令牌无效或权限不足，请重新生成");
      throw new Error(`GitHub 服务暂不可用（HTTP ${response.status}）`);
    }
    try {
      const data = await response.json();
      if (list ? !Array.isArray(data) : !data || typeof data !== "object" || Array.isArray(data)) throw new Error("unexpected JSON");
      return privateResult(data, [values.token]);
    } catch { throw new Error("GitHub 返回的 JSON 无法解析，请稍后重试"); }
  }
  return {
    name: "github", title: "GitHub", description: "查看仓库、issue 和通知（只读）", icon: "icon.png", multiAccount: false,
    fields: [{ key: "token", label: "个人访问令牌（PAT）", type: "secret", required: true,
      help: "打开 https://github.com/settings/tokens → Generate new token (classic)。公开仓库和通知勾选 notifications；私有仓库及其 issue 还需 repo（已包含通知权限）。通知 API 不支持 fine-grained token；classic scope 本身含写权限，连接器仅只读。" }],
    label: () => "GitHub", validate: tokenValues,
    test: async (values) => { await request(tokenValues(values), "/user"); },
    tools(accounts, ctx) {
      const values = tokenValues(accounts[0].values);
      const wrap = (fn) => async (args) => {
        try { return { content: [{ type: "text", text: JSON.stringify(privateResult(await fn(args), [values.token], ctx)) }] }; }
        catch (e) { return { content: [{ type: "text", text: JSON.stringify(privateResult({ error: e.message }, [values.token], ctx)) }], isError: true }; }
      };
      const list = async (endpoint, query, project) => ({ items: (await request(values, endpoint, query, true)).slice(0, query.per_page).map(project),
        page: query.page, per_page: query.per_page });
      return [
        tool("repos", "列出可访问的仓库；visibility 为 all/public/private，affiliation 用逗号分隔 owner/collaborator/organization_member。per_page 默认 30、最多 100，page 从 1 开始。", {
          visibility: z.enum(["all", "public", "private"]).optional(),
          affiliation: z.string().max(100).refine((s) => s.split(",").every((v) => ["owner", "collaborator", "organization_member"].includes(v)), "affiliation 格式不正确").optional(),
          sort: z.enum(["created", "updated", "pushed", "full_name"]).default("updated"), ...pagination,
        }, wrap((args) => list("/user/repos", args, repoResult))),
        tool("repo", "查看一个仓库的名称、简介、stars 和 issue 数。", repository,
          wrap(async (args) => repoResult(await request(values, repoPath(args))))),
        tool("issues", "列出仓库 issue，is_pull_request 标明 PR；正文最多 1000 字。labels 用逗号分隔，assignee 可用用户名、* 或 none，since 为 ISO 8601 时间。per_page 默认 30、最多 100，page 从 1 开始。", {
          ...repository, state: z.enum(["open", "closed", "all"]).default("open"), labels: z.string().max(1000).optional(),
          assignee: z.union([owner, z.enum(["*", "none"])]).optional(), since, ...pagination,
        }, wrap(({ owner, repo, ...query }) => list(repoPath({ owner, repo }) + "/issues", query, (i) => issueResult(i)))),
        tool("issue", "查看单个 issue 和第一页评论；正文最多 6000 字、每条评论最多 2000 字。comments_limit 默认 20、最多 50，comments_truncated 表示还有评论未展示。", {
          ...repository, number: z.number().int().min(1), comments_limit: z.number().int().min(1).max(50).default(20),
        }, wrap(async ({ owner, repo, number, comments_limit }) => {
          const endpoint = repoPath({ owner, repo }) + `/issues/${number}`;
          const issue = await request(values, endpoint);
          const comments = (await request(values, endpoint + "/comments", { per_page: comments_limit, page: 1 }, true)).slice(0, comments_limit);
          return { issue: issueResult(issue, 6000), comments: comments.map(commentResult), comments_truncated: issue.comments > comments.length };
        })),
        tool("notifications", "查看通知，只读、不标记已读；all 包含已读，participating 仅看参与或被提及，since 为 ISO 8601 时间。per_page 默认 30、最多 100，page 从 1 开始。", {
          all: z.boolean().default(false), participating: z.boolean().default(false), since, ...pagination,
        }, wrap((args) => list("/notifications", args, notificationResult))),
      ];
    },
  };
}
export default createGithubConnector();
