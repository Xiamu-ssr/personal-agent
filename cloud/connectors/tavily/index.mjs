import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { requestJson, privateResult, apiKeyValues } from "../_shared/http.mjs";

// Endpoint/fetch injection is for local fake services only, never an account field.
export function createTavilyConnector({ baseUrl = "https://api.tavily.com", fetchImpl = fetch } = {}) {
  const request = (values, endpoint, body, method) => requestJson(`${baseUrl}/${endpoint}`, values.apiKey, body, { fetchImpl, title: "Tavily", method });
  return {
    name: "tavily", title: "Tavily", description: "深入调研和整篇网页正文提取", icon: "icon.png", multiAccount: false,
    fields: [{ key: "apiKey", label: "API Key", type: "secret", required: true, help: "打开 https://app.tavily.com 注册或登录，在控制台生成 API Key" }],
    label: () => "Tavily", validate: (values) => apiKeyValues(values),
    // /usage checks authentication without consuming a paid search/extraction credit.
    test: (values) => request(apiKeyValues(values), "usage", undefined, "GET"),
    tools(accounts, ctx) {
      const values = accounts[0].values;
      const wrap = (fn) => async (args) => {
        try { return { content: [{ type: "text", text: JSON.stringify(privateResult(await fn(args), [values.apiKey], ctx)) }] }; }
        catch (e) { return { content: [{ type: "text", text: JSON.stringify(privateResult({ error: e.message }, [values.apiKey], ctx)) }], isError: true }; }
      };
      return [
        tool("search", "深入调研时搜索网页。日常搜索请用内置网页搜索。", {
          query: z.string().min(1).max(1000), depth: z.enum(["basic", "advanced"]).default("basic"),
          max_results: z.number().int().min(1).max(20).default(5), time_range: z.enum(["day", "week", "month", "year"]).optional(),
        }, wrap(({ query, depth, max_results, time_range }) => request(values, "search", {
          query, search_depth: depth, max_results, ...(time_range && { time_range }),
        }))),
        tool("extract", "提取完整网页正文，单次最多 20 个 URL。", {
          urls: z.array(z.url().refine((s) => /^https?:\/\//.test(s), "仅支持 HTTP / HTTPS URL")).min(1).max(20),
        }, wrap(({ urls }) => request(values, "extract", { urls }))),
      ];
    },
  };
}
export default createTavilyConnector();
