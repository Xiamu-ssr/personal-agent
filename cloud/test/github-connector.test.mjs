import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import registry from "../connectors/index.mjs";
import github, { createGithubConnector } from "../connectors/github/index.mjs";
import { ConnectorManager, SECRET_MASK } from "../src/connectors.mjs";
import { fakeConnectorApi } from "./fake-connector-api.mjs";
import { callTool, toolResult } from "./tool-call.mjs";

const token = "ghp_FAKE_TEST_ONLY_NEVER_REAL", time = "2026-10-13T01:02:03Z";
const repository = { owner: "fake-user", repo: "demo_repo.js" };
const rawRepo = { name: repository.repo, full_name: "fake-user/demo_repo.js", private: true, description: "本地仓库",
  stargazers_count: 7, open_issues_count: 3, updated_at: time, html_url: "https://github.com/fake-user/demo_repo.js",
  owner: { login: "fake-user", avatar_url: "unused" }, permissions: { admin: true }, clone_url: "unused", extra: "omit me" };
const projectedRepo = { name: rawRepo.name, full_name: rawRepo.full_name, private: true, description: "本地仓库",
  stars: 7, open_issues: 3, updated_at: time, html_url: rawRepo.html_url };
const rawIssue = { number: 12, title: "本地 issue", state: "open", user: { login: "fake-author", avatar_url: "unused" },
  labels: [{ name: "bug", color: "unused" }, "help wanted"], comments: 3, created_at: time, updated_at: time, closed_at: null,
  html_url: "https://github.com/fake-user/demo_repo.js/issues/12", body: "本地正文", milestone: { title: "unused" } };
const projectedIssue = { number: 12, title: "本地 issue", state: "open", is_pull_request: false, author: "fake-author",
  labels: ["bug", "help wanted"], comments: 3, created_at: time, updated_at: time, closed_at: null, html_url: rawIssue.html_url,
  body: "本地正文", body_truncated: false };
const rawComment = { id: 1, user: { login: "fake-commenter", avatar_url: "unused" }, body: "本地评论",
  created_at: time, updated_at: time, html_url: rawIssue.html_url + "#issuecomment-1", reactions: { total_count: 9 } };
const projectedComment = { id: 1, author: "fake-commenter", body: "本地评论", body_truncated: false,
  created_at: time, updated_at: time, html_url: rawComment.html_url };
const rawNotification = { id: "101", repository: rawRepo, subject: { title: "本地通知", type: "Issue", url: "https://api.github.com/repos/fake-user/demo_repo.js/issues/12", latest_comment_url: "unused" },
  reason: "mention", unread: true, updated_at: time, last_read_at: null, subscription_url: "unused" };

async function fixture(t, handler, ctx = {}) {
  const api = await fakeConnectorApi((req) => {
    assert.equal(req.method, "GET"); assert.equal(req.body, undefined);
    assert.equal(req.authorization, `Bearer ${token}`);
    assert.equal(req.headers.accept, "application/vnd.github+json");
    assert.equal(req.headers["x-github-api-version"], "2022-11-28");
    assert.equal(req.headers["user-agent"], "doudou-personal-agent");
    const url = new URL(req.path, "http://127.0.0.1");
    return handler({ ...req, route: url.pathname, query: Object.fromEntries(url.searchParams) });
  });
  t.after(() => api.close());
  const definition = createGithubConnector({ baseUrl: api.url });
  return { api, definition, tools: definition.tools([{ id: "fake-github", values: { token } }], ctx) };
}
function requestIs(api, route, query = {}, index = -1) {
  const url = new URL(api.requests.at(index).path, api.url);
  assert.equal(url.pathname, route); assert.deepEqual(Object.fromEntries(url.searchParams), query);
}

test("GitHub metadata and PAT validation reject empty/masked values and trim whitespace before any request", async (t) => {
  const { api, definition } = await fixture(t, () => ({ data: { login: "fake-user" } }));
  assert.equal(github.name, "github"); assert.equal(github.title, "GitHub"); assert.equal(github.multiAccount, false);
  assert.match(github.description, /只读/); assert.equal(github.icon, "icon.png"); assert.equal(github.label(), "GitHub");
  assert.deepEqual(github.fields.map(({ key, type, required }) => ({ key, type, required })), [{ key: "token", type: "secret", required: true }]);
  assert.match(github.fields[0].help, /https:\/\/github.com\/settings\/tokens/);
  for (const value of ["classic", "notifications", "repo", "fine-grained"]) assert.ok(github.fields[0].help.includes(value));
  for (const value of [undefined, null, "", " \n\t ", SECRET_MASK, ` ${SECRET_MASK} `, 123]) {
    assert.throws(() => definition.validate({ token: value }), /请填写.*个人访问令牌/);
    await assert.rejects(definition.test({ token: value }), /请填写/);
  }
  assert.equal(api.requests.length, 0);
  assert.deepEqual(definition.validate({ token: ` \n${token}\t ` }), { token });
  await definition.test({ token: ` ${token} ` });
  requestIs(api, "/user"); assert.equal(api.requests.length, 1);
});

test("GitHub auth test handles 401/403, primary/secondary limits and invalid JSON without echoing PATs", async (t) => {
  let fault = { data: { login: "fake-user", echo: token } };
  const { api, definition, tools } = await fixture(t, () => fault);
  await definition.test({ token }); requestIs(api, "/user");
  for (const [status, headers, expected] of [
    [401, {}, /令牌无效或权限不足/], [403, {}, /令牌无效或权限不足/],
    [403, { "x-ratelimit-remaining": "0" }, /请求过于频繁，稍后重试/],
    [429, { "x-ratelimit-remaining": "0" }, /请求过于频繁，稍后重试/],
    [403, { "retry-after": "30" }, /请求过于频繁，稍后重试/],
    [429, { "retry-after": "30" }, /请求过于频繁，稍后重试/],
    [503, {}, /服务暂不可用/],
  ]) {
    fault = { status, headers, data: { message: token } };
    await assert.rejects(definition.test({ token }), (e) => { assert.match(e.message, expected); assert.equal(e.message.includes(token), false); return true; });
    const failed = await toolResult(tools, "repos");
    assert.equal(failed.isError, true); assert.match(failed.data.error, expected); assert.equal(JSON.stringify(failed).includes(token), false);
  }
  for (const data of [[], null, "wrong shape"]) {
    fault = { data }; await assert.rejects(definition.test({ token }), /JSON 无法解析/);
  }
  fault = { rawBody: token }; await assert.rejects(definition.test({ token }), /JSON 无法解析/);
  fault = { data: {} };
  assert.match((await toolResult(tools, "repos")).data.error, /JSON 无法解析/);
});

test("GitHub repos sends visibility/affiliation/sort/pagination and projects a bounded list", async (t) => {
  const { api, tools } = await fixture(t, () => ({ data: [rawRepo] }));
  const result = await callTool(tools, "repos", { visibility: "private", affiliation: "owner,organization_member", sort: "pushed", per_page: 100, page: 2 });
  requestIs(api, "/user/repos", { visibility: "private", affiliation: "owner,organization_member", sort: "pushed", per_page: "100", page: "2" });
  assert.deepEqual(result, { items: [projectedRepo], page: 2, per_page: 100 });
  await callTool(tools, "repos"); requestIs(api, "/user/repos", { sort: "updated", per_page: "30", page: "1" });
});

test("GitHub repo reads a single repository and accepts safe GitHub name punctuation", async (t) => {
  const { api, tools } = await fixture(t, () => ({ data: rawRepo }));
  assert.deepEqual(await callTool(tools, "repo", repository), projectedRepo);
  requestIs(api, "/repos/fake-user/demo_repo.js");
  await callTool(tools, "repo", { owner: "Fake-User9", repo: ".github" });
  requestIs(api, "/repos/Fake-User9/.github");
});

test("GitHub issues sends every filter and pagination, identifies PRs and truncates list bodies", async (t) => {
  const { api, tools } = await fixture(t, () => ({ data: [rawIssue, { ...rawIssue, number: 13, pull_request: { url: "unused" }, body: "文".repeat(1001) }] }));
  const result = await callTool(tools, "issues", { ...repository, state: "all", labels: "bug,待处理", assignee: "*", since: time, per_page: 2, page: 3 });
  requestIs(api, "/repos/fake-user/demo_repo.js/issues", { state: "all", labels: "bug,待处理", assignee: "*", since: time, per_page: "2", page: "3" });
  assert.deepEqual(result.items[0], projectedIssue);
  assert.equal(result.items[1].is_pull_request, true); assert.equal("pull_request" in result.items[1], false);
  assert.equal(result.items[1].body, "文".repeat(1000) + "…"); assert.equal(result.items[1].body_truncated, true);
  assert.equal(result.page, 3); assert.equal(result.per_page, 2);
  await callTool(tools, "issues", repository); requestIs(api, "/repos/fake-user/demo_repo.js/issues", { state: "open", per_page: "30", page: "1" });
});

test("GitHub issue reads detail and bounded first-page comments with explicit truncation", async (t) => {
  const { api, tools } = await fixture(t, ({ route }) => ({ data: route.endsWith("/comments") ? [rawComment, { ...rawComment, id: 2, body: "评".repeat(2001) }, rawComment] : { ...rawIssue, body: "文".repeat(6001) } }));
  const result = await callTool(tools, "issue", { ...repository, number: 12, comments_limit: 2 });
  requestIs(api, "/repos/fake-user/demo_repo.js/issues/12", {}, -2);
  requestIs(api, "/repos/fake-user/demo_repo.js/issues/12/comments", { per_page: "2", page: "1" });
  assert.deepEqual(result.issue, { ...projectedIssue, body: "文".repeat(6000) + "…", body_truncated: true });
  assert.deepEqual(result.comments[0], projectedComment); assert.equal(result.comments.length, 2);
  assert.equal(result.comments[1].body, "评".repeat(2000) + "…"); assert.equal(result.comments[1].body_truncated, true);
  assert.equal(result.comments_truncated, true);
  const complete = await callTool(tools, "issue", { ...repository, number: 12 });
  requestIs(api, "/repos/fake-user/demo_repo.js/issues/12/comments", { per_page: "20", page: "1" });
  assert.equal(complete.comments_truncated, false);
  await callTool(tools, "issue", { ...repository, number: 12, comments_limit: 50 });
  requestIs(api, "/repos/fake-user/demo_repo.js/issues/12/comments", { per_page: "50", page: "1" });
});

test("GitHub notifications keeps unread state and sends boolean/time/pagination filters using GET only", async (t) => {
  const { api, tools } = await fixture(t, () => ({ data: [rawNotification] }));
  const result = await callTool(tools, "notifications", { all: true, participating: true, since: time, per_page: 10, page: 2 });
  requestIs(api, "/notifications", { all: "true", participating: "true", since: time, per_page: "10", page: "2" });
  assert.deepEqual(result, { items: [{ id: "101", repository: projectedRepo, subject: { title: "本地通知", type: "Issue", url: rawNotification.subject.url },
    reason: "mention", unread: true, updated_at: time, last_read_at: null }], page: 2, per_page: 10 });
  await callTool(tools, "notifications"); requestIs(api, "/notifications", { all: "false", participating: "false", per_page: "30", page: "1" });
  assert.equal(rawNotification.unread, true); assert.ok(api.requests.every((r) => r.method === "GET"));
});

test("GitHub invalid path segments and issue numbers are rejected without sending a request", async (t) => {
  const { api, tools } = await fixture(t, () => ({ data: {} }));
  for (const name of ["repo", "issues", "issue"]) {
    const valid = { ...repository, ...(name === "issue" && { number: 12 }) };
    for (const owner of ["", "../fake", "fake/user", "fake%2fuser", "fake?x", "fake#x", "fake\\user", "fake_user", "-fake", "fake-", "fake--user", "fake\n", "中文", "a".repeat(40)]) {
      await assert.rejects(callTool(tools, name, { ...valid, owner }));
    }
    for (const repo of ["", ".", "..", "../fake", "fake/user", "fake%2fuser", "fake?x", "fake#x", "fake\\user", " fake", "fake\n", "中文", "a".repeat(101)]) {
      await assert.rejects(callTool(tools, name, { ...valid, repo }));
    }
  }
  for (const number of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(callTool(tools, "issue", { ...repository, number }));
  assert.equal(api.requests.length, 0);
});

test("GitHub invalid filters and pagination/comment limits are rejected before HTTP", async (t) => {
  const { api, tools } = await fixture(t, () => ({ data: [] }));
  for (const name of ["repos", "issues", "notifications"]) for (const args of [{ per_page: 0 }, { per_page: 101 }, { per_page: 1.5 }, { page: 0 }, { page: 1.5 }]) {
    await assert.rejects(callTool(tools, name, { ...(name === "issues" && repository), ...args }));
  }
  for (const args of [{ visibility: "secret" }, { affiliation: "" }, { affiliation: "admin" }, { affiliation: "owner,admin" }, { sort: "invalid" }]) await assert.rejects(callTool(tools, "repos", args));
  for (const args of [{ state: "invalid" }, { since: "yesterday" }, { assignee: "../fake" }]) await assert.rejects(callTool(tools, "issues", { ...repository, ...args }));
  for (const args of [{ all: "true" }, { participating: 1 }, { since: "yesterday" }]) await assert.rejects(callTool(tools, "notifications", args));
  for (const comments_limit of [0, 51, 1.5]) await assert.rejects(callTool(tools, "issue", { ...repository, number: 12, comments_limit }));
  assert.equal(api.requests.length, 0);
});

test("GitHub projections redact PATs before truncating and apply the ConnectorManager context redactor", async (t) => {
  const otherSecret = "OTHER_FAKE_SECRET_ONLY";
  const { tools } = await fixture(t, ({ route }) => {
    const r = { ...rawRepo, description: `${token} ${otherSecret}` };
    const i = { ...rawIssue, title: token, body: "文".repeat(999) + token };
    return { data: route === "/user/repos" ? [r] : route === "/notifications" ? [{ ...rawNotification, repository: r, subject: { ...rawNotification.subject, title: token } }] :
      route.endsWith("/comments") ? [{ ...rawComment, body: token }] : route.endsWith("/issues") ? [i] : route.includes("/issues/") ? i : r };
  }, { redact: (value) => JSON.parse(JSON.stringify(value).replaceAll(otherSecret, SECRET_MASK)) });
  for (const [name, args] of [["repos", {}], ["repo", repository], ["issues", repository], ["issue", { ...repository, number: 12 }], ["notifications", {}]]) {
    const result = JSON.stringify(await callTool(tools, name, args));
    assert.equal(result.includes(token), false); assert.equal(result.includes(otherSecret), false); assert.ok(result.includes(SECRET_MASK));
    assert.equal(result.includes("ghp_"), false);
  }
});

test("GitHub uses a 20-second timeout, refuses redirects and masks transport errors", async (t) => {
  const { api } = await fixture(t, () => ({ status: 302, headers: { Location: "/redirected" }, data: { message: token } }));
  const timeout = AbortSignal.timeout;
  let timeoutCalls = 0;
  AbortSignal.timeout = (ms) => { assert.equal(ms, 20_000); timeoutCalls++; return timeout(ms); };
  t.after(() => { AbortSignal.timeout = timeout; });
  const definition = createGithubConnector({ baseUrl: api.url, fetchImpl: (url, options) => {
    assert.equal(new URL(url).hostname, "127.0.0.1"); assert.equal(options.redirect, "error");
    assert.equal(options.method, "GET"); assert.equal(options.body, undefined); assert.ok(options.signal instanceof AbortSignal);
    return fetch(url, options);
  } });
  await assert.rejects(definition.test({ token }), /连接超时或网络不可用/);
  assert.equal(api.requests.length, 1); requestIs(api, "/user"); assert.equal(timeoutCalls, 1);
  const offline = createGithubConnector({ baseUrl: api.url, fetchImpl: async () => { throw new Error("network echoed " + token); } });
  await assert.rejects(offline.test({ token }), (e) => /连接超时或网络不可用/.test(e.message) && !e.message.includes(token));
  const failed = await toolResult(offline.tools([{ values: { token } }], {}), "repos");
  assert.equal(failed.isError, true); assert.equal(JSON.stringify(failed).includes(token), false);
});

test("GitHub accounts mount a real MCP server, remain single-account and never expose credentials in list/status", async (t) => {
  const { api, definition } = await fixture(t, ({ route }) => ({ data: route === "/user" ? { login: "fake-user" } : rawRepo }));
  const root = fs.mkdtempSync(path.join(testRoot, "github-"));
  const manager = new ConnectorManager({ root, definitions: registry.map((d) => d.name === "github" ? definition : d) });
  assert.ok(manager.list().catalog.some((d) => d.name === "github")); assert.equal("github" in manager.mcpServers(), false);
  for (const value of ["", " ", SECRET_MASK]) await assert.rejects(manager.addAccount("github", { token: value }), /请填写/);
  await assert.rejects(manager.addAccount("github", { token, baseUrl: api.url }), /不支持的配置字段/);
  assert.equal(api.requests.length, 0);
  const account = await manager.addAccount("github", { token: ` ${token} ` });
  assert.equal(account.status, "ok"); assert.equal(account.label, "GitHub"); assert.equal("values" in account, false);
  assert.equal(manager.list().installed[0].accounts[0].values.token, SECRET_MASK); assert.equal(JSON.stringify(manager.list()).includes(token), false);
  assert.equal(manager.accounts.get("github")[0].values.token, token);
  await assert.rejects(manager.addAccount("github", { token }), /只支持一个账号/);
  const listing = await callTool(manager.managementTools(), "list"); assert.equal(JSON.stringify(listing).includes(token), false);
  await manager.updateAccount("github", account.id, { token: SECRET_MASK });
  const server = manager.mcpServers().github; assert.equal(server.type, "sdk");
  const client = new Client({ name: "github-local-test", version: "0.6.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport); await client.connect(clientTransport); t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["repos", "repo", "issues", "issue", "notifications"]);
  const result = await client.callTool({ name: "repo", arguments: repository });
  assert.deepEqual(JSON.parse(result.content[0].text), projectedRepo);
  const before = api.requests.length;
  const invalid = await client.callTool({ name: "repo", arguments: { ...repository, owner: "../fake" } });
  assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /owner/);
  assert.equal(api.requests.length, before);
  await manager.removeAccount("github", account.id); assert.equal("github" in manager.mcpServers(), false);
  assert.ok(api.requests.every((r) => r.method === "GET"));
});
