import { z } from "zod";
import { defineTool } from "../../src/product-tools.mjs";
import { requestJson, privateResult, apiKeyValues } from "../_shared/http.mjs";
import { queryAccounts, QuotaExhaustedError } from "../_shared/query-accounts.mjs";
import { deepseekBalance } from "../_shared/deepseek.mjs";

const queryText = () => z.string().refine(value => value.trim().length > 0 && Array.from(value).length <= 128,
  "请输入 1～128 个 Unicode 字符，不能全为空白");
const pageUrl = z.url().max(8192).refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
}, "仅支持不含用户名或密码的 HTTP / HTTPS URL");

// Endpoint/fetch injection is for local fake services only, never an account field.
export function createDeepSeekSearchConnector({ baseUrl = "https://api.deepseek.com", fetchImpl = fetch, now = Date.now } = {}) {
  const request = async (values, endpoint, body, method) => {
    try { return await requestJson(`${baseUrl}${endpoint}`, values.apiKey, body, { fetchImpl, title: "DeepSeek Search", method }); }
    catch (error) {
      // Prepaid balance has no monthly reset. Recheck soon after a possible top-up;
      // the account's explicit Test action also clears this cooldown immediately.
      if (error.status === 402) throw new QuotaExhaustedError("DeepSeek 账号余额不足，请充值或添加可用账号", now() + 60_000);
      if (error.status === 403) error.message = "DeepSeek 拒绝访问这个网页，请更换来源";
      if (error.status === 404) error.message = "DeepSeek 未能提取这个网页的正文，请更换来源";
      if ([408, 429, 504].includes(error.status)) error.message = error.status === 429 ? "DeepSeek 请求过于频繁，请稍后重试" : "DeepSeek 请求超时，请稍后重试";
      throw error;
    }
  };
  return {
    name: "deepseek-search", title: "DeepSeek Search", description: "搜索网页、提取正文；支持多账号与余额查看", icon: "icon.png", multiAccount: true, quotaPooling: true,
    fields: [
      { key: "label", label: "账号备注", type: "text", placeholder: "例如：常用账号、备用账号" },
      { key: "apiKey", label: "DeepSeek API Key", type: "secret", required: true, help: "在 https://platform.deepseek.com/api_keys 创建官方 API Key；搜索按次从 DeepSeek 余额扣费" },
    ],
    label: values => values.label?.trim() || "DeepSeek Search", validate: values => apiKeyValues(values),
    // Authentication uses the free balance endpoint, never a paid search.
    test: async values => deepseekBalance(await request(apiKeyValues(values), "/user/balance", undefined, "GET")),
    tools(accounts, ctx) {
      const pool = queryAccounts(accounts, ctx, { title: "DeepSeek Search", now }), keys = accounts.map(account => account.values.apiKey);
      const wrap = fn => async args => {
        try {
          const result = await pool.run(account => fn(account.values, args));
          return { content: [{ type: "text", text: JSON.stringify(privateResult({ ...result.value, connector_account: result.account }, keys, ctx)) }] };
        } catch (error) {
          return { content: [{ type: "text", text: JSON.stringify(privateResult({ error: error.message }, keys, ctx)) }], isError: true };
        }
      };
      return [
        defineTool("search", "搜索网页；query 为 1～128 个 Unicode 字符，支持 site:、-site:、引号、lang:、after:、before:。默认只取摘要，需要正文时用 need_content。搜索独立于当前基模，按次消耗 DeepSeek 余额。", {
          query: queryText(), count: z.number().int().min(1).max(50).default(5),
          ori_question: queryText().optional().describe("触发搜索的原始问题，可选，最多 128 个 Unicode 字符"),
          need_content: z.boolean().default(false),
        }, wrap(async (values, args) => {
          const data = await request(values, "/v1/tools/search", args);
          if (!Array.isArray(data.results) || data.results.some(row => !row || ["title", "url", "summary", "content"].some(key => typeof row[key] !== "string"))) {
            throw new Error("DeepSeek Search 返回的搜索结果格式不正确");
          }
          return data;
        })),
        defineTool("fetch", "抓取一个网页，返回标题和完整 Markdown 正文；URL 必须为 HTTP / HTTPS，不能含用户名或密码。按次消耗 DeepSeek 余额。", {
          url: pageUrl,
        }, wrap(async (values, args) => {
          const data = await request(values, "/v1/tools/fetch", args);
          if (typeof data.title !== "string" || typeof data.content !== "string") throw new Error("DeepSeek Search 返回的网页正文格式不正确");
          return data;
        })),
      ];
    },
  };
}
export default createDeepSeekSearchConnector();
