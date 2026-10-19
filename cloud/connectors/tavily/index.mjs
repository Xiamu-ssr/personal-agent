import { z } from "zod";
import { defineTool } from "../../src/product-tools.mjs";
import { requestJson, privateResult, apiKeyValues } from "../_shared/http.mjs";
import { queryAccounts, QuotaExhaustedError, nextMonth, errorText, exhaustedCredits } from "../_shared/query-accounts.mjs";

// Endpoint/fetch injection is for local fake services only, never an account field.
export function createTavilyConnector({ baseUrl = "https://api.tavily.com", fetchImpl = fetch } = {}) {
  const request = async (values, endpoint, body, method) => {
    try { return await requestJson(`${baseUrl}/${endpoint}`, values.apiKey, body, { fetchImpl, title: "Tavily", method }); }
    catch (error) {
      if ([432, 433].includes(error.status) || [402, 403, 429].includes(error.status) && exhaustedCredits(errorText(error.data))) {
        throw new QuotaExhaustedError("Tavily 账号额度已耗尽", nextMonth());
      }
      throw error;
    }
  };
  return {
    name: "tavily", title: "Tavily", description: "深入调研和整篇网页正文提取；额度耗尽时自动使用备用账号", icon: "icon.png", multiAccount: true, quotaPooling: true,
    fields: [{ key: "label", label: "账号备注", type: "text", placeholder: "例如：常用账号、备用账号" },
      { key: "apiKey", label: "API Key", type: "secret", required: true, help: "打开 https://app.tavily.com 注册或登录，在控制台生成 API Key" }],
    label: (values) => values.label?.trim() || "Tavily", validate: (values) => apiKeyValues(values),
    // /usage checks authentication without consuming a paid search/extraction credit.
    test: (values) => request(apiKeyValues(values), "usage", undefined, "GET"),
    tools(accounts, ctx) {
      const pool = queryAccounts(accounts, ctx, { title: "Tavily" }), keys = accounts.map((account) => account.values.apiKey);
      const wrap = (fn) => async (args) => {
        try {
          const result = await pool.run((account) => fn(account.values, args));
          return { content: [{ type: "text", text: JSON.stringify(privateResult({ ...result.value, connector_account: result.account }, keys, ctx)) }] };
        }
        catch (e) { return { content: [{ type: "text", text: JSON.stringify(privateResult({ error: e.message }, keys, ctx)) }], isError: true }; }
      };
      return [
        defineTool("search", "搜索网页。日常查询用 basic，深入调研可用 advanced；额度由连接的 Tavily 账号承担。", {
          query: z.string().min(1).max(1000), depth: z.enum(["basic", "advanced"]).default("basic"),
          max_results: z.number().int().min(1).max(20).default(5), time_range: z.enum(["day", "week", "month", "year"]).optional(),
        }, wrap((values, { query, depth, max_results, time_range }) => request(values, "search", {
          query, search_depth: depth, max_results, ...(time_range && { time_range }),
        }))),
        defineTool("extract", "提取完整网页正文，单次最多 20 个 URL。", {
          urls: z.array(z.url().refine((s) => /^https?:\/\//.test(s), "仅支持 HTTP / HTTPS URL")).min(1).max(20),
        }, wrap((values, { urls }) => request(values, "extract", { urls }))),
      ];
    },
  };
}
export default createTavilyConnector();
