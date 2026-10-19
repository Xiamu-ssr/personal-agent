import { z } from "zod";
import { defineTool } from "../../src/product-tools.mjs";
import { requestJson, privateResult, apiKeyValues } from "../_shared/http.mjs";

// Audited against Tencent/WeChatReading skills 1.0.5, 2026-10-11.
export const WEREAD_SKILL_VERSION = "1.0.5";
export const WEREAD_GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
export function createWereadConnector({ gateway = WEREAD_GATEWAY, fetchImpl = fetch } = {}) {
  async function request(values, api_name, args = {}) {
    const data = await requestJson(gateway, values.apiKey, { api_name, ...args, skill_version: WEREAD_SKILL_VERSION }, { fetchImpl, title: "微信读书" });
    if (data.upgrade_info) throw new Error("微信读书接口要求更新连接器版本，请联系管理员升级后重试");
    if (data.errcode && Number(data.errcode) !== 0) throw new Error(`微信读书请求失败（错误码 ${Number(data.errcode) || "未知"}），请检查 API Key 或稍后重试`);
    return data;
  }
  const bookId = z.string().min(1).max(200);
  const count = z.number().int().min(1).max(100).optional();
  return {
    name: "weread", title: "微信读书", description: "查看书架、阅读统计、划线和想法，搜索书籍", icon: "icon.png", multiAccount: false,
    fields: [{ key: "apiKey", label: "个人 API Key", type: "secret", required: true,
      help: "打开 https://weread.qq.com/r/weread-skills，扫码登录微信读书，生成 wrk- 开头的个人 API Key" }],
    label: () => "微信读书", validate: (values) => apiKeyValues(values, "wrk-"),
    // One notebook entry verifies personal authentication with the smallest bounded personal response.
    test: (values) => request(apiKeyValues(values, "wrk-"), "/user/notebooks", { count: 1 }),
    tools(accounts, ctx) {
      const values = accounts[0].values;
      const wrap = (fn) => async (args) => {
        try { return { content: [{ type: "text", text: JSON.stringify(privateResult(await fn(args), [values.apiKey], ctx)) }] }; }
        catch (e) { return { content: [{ type: "text", text: JSON.stringify(privateResult({ error: e.message }, [values.apiKey], ctx)) }], isError: true }; }
      };
      return [
        defineTool("shelf", "查看书架。条目总数为 books.length + albums.length +（mp 非空时 1）；albums 是有声书。", {}, wrap(() => request(values, "/shelf/sync"))),
        defineTool("reading_stats", "阅读统计，时长单位为秒，总时长取 totalReadTime；dayAverageReadTime 按自然日平均。baseTime 为 Unix 秒，查询固定自然周期。", {
          mode: z.enum(["weekly", "monthly", "annually", "overall"]).optional(), baseTime: z.number().int().nonnegative().optional(),
        }, wrap((args) => request(values, "/readdata/detail", args))),
        defineTool("highlights", "读取一本书的个人划线原文（不含书签）。书名先用 search_books 找 bookId。", { bookId }, wrap((args) => request(values, "/book/bookmarklist", args))),
        defineTool("thoughts", "读取一本书的个人想法和点评；hasMore 时把回包 synckey 传给下一页。bookid 的 i 小写。", {
          bookid: bookId, synckey: z.number().int().nonnegative().optional(), count,
        }, wrap((args) => request(values, "/review/list/mine", args))),
        defineTool("search_books", "搜索书籍，电子书 scope=10、网文=16、有声书=14、作者=6、全文=12、综合=0。显式选 scope；maxIdx 为翻页偏移。结果分组 scope 不一定等于请求 scope，不能据此过滤。", {
          keyword: z.string().min(1).max(1000), scope: z.union([0, 10, 16, 14, 6, 12, 13, 2, 4].map((n) => z.literal(n))),
          maxIdx: z.number().int().nonnegative().optional(), count,
        }, wrap((args) => request(values, "/store/search", args))),
      ];
    },
  };
}
export default createWereadConnector();
