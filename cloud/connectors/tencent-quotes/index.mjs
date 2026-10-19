import { z } from "zod";
import { defineTool } from "../../src/product-tools.mjs";

const ENDPOINT = "https://qt.gtimg.cn/q=", CACHE_MS = 5000, MAX_BYTES = 1024 * 1024;
// Same public GBK quote format used by price-bell; this connector does not access the bell's service or state.
export function normalizeSymbol(value) {
  const input = value.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(input)) return input;
  const match = input.match(/^(\d{6})\.(sh|sz|bj)$/);
  if (match) return match[2] + match[1];
  throw new Error("证券代码请带市场，例如 600519.SH、000001.SZ、920002.BJ 或 sh000001（上证指数）");
}
const numeric = (value) => value?.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
export function parseTencentQuotes(text, codes) {
  const found = new Map(), wanted = new Set(codes);
  for (const match of text.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"\r\n]*)"\s*;/g)) {
    const [, code, payload] = match, fields = payload.split("~"), price = numeric(fields[3]);
    if (!wanted.has(code) || fields.length < 39 || !fields[1] || price === null || price <= 0) continue;
    const previousClose = numeric(fields[4]), stamp = fields[30];
    const asOf = /^\d{14}$/.test(stamp) ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}+08:00` : null;
    found.set(code, { symbol: code.slice(2) + "." + code.slice(0, 2).toUpperCase(), code, name: fields[1], currency: "CNY", price, previousClose,
      change: numeric(fields[31]) ?? (previousClose > 0 ? Number((price - previousClose).toFixed(4)) : null),
      changePercent: numeric(fields[32]) ?? (previousClose > 0 ? Number(((price / previousClose - 1) * 100).toFixed(2)) : null),
      high: numeric(fields[33]), low: numeric(fields[34]), turnoverPercent: numeric(fields[38]),
      asOf: asOf && Number.isFinite(Date.parse(asOf)) ? asOf : null });
  }
  return { quotes: codes.flatMap((code) => found.has(code) ? [found.get(code)] : []), missing: codes.filter((code) => !found.has(code)) };
}

export function createTencentQuotesConnector({ endpoint = ENDPOINT, fetchImpl = fetch, now = Date.now } = {}) {
  const request = async (codes) => {
    let response;
    try {
      response = await fetchImpl(endpoint + codes.join(","), { method: "GET", headers: { "User-Agent": "Doudou/0.8 TencentQuotes", Accept: "text/plain" }, redirect: "error", signal: AbortSignal.timeout(8000) });
    } catch { throw new Error("腾讯行情连接超时或网络不可用，请稍后重试"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`腾讯行情暂不可用（HTTP ${response.status}）`); }
    if (!response.body) throw new Error("腾讯行情没有返回报价正文，请稍后重试");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error("腾讯行情响应过大，请减少证券数量"); }
        chunks.push(value);
      }
    } catch (error) {
      if (size > MAX_BYTES) throw error;
      throw new Error("腾讯行情读取中断，请稍后重试");
    } finally { reader.releaseLock(); }
    const data = parseTencentQuotes(new TextDecoder("gb18030").decode(Buffer.concat(chunks)), codes);
    if (!data.quotes.length) throw new Error("没有读取到有效行情，请核对证券代码和市场；上游可能暂不可用");
    return { source: "腾讯证券公开行情", sourceUrl: "https://gu.qq.com/", timezone: "Asia/Shanghai", fetchedAt: new Date(now()).toISOString(), ...data };
  };
  return {
    name: "tencent-quotes", title: "腾讯行情", description: "免费、免 API Key；沪深京股票、ETF 与指数的最新公开报价", icon: "icon.ico", multiAccount: false,
    fields: [], label: () => "公开行情", validate: () => ({}), test: () => request(["sh000001"]),
    tools(accounts, ctx) {
      const cache = ctx.pending || new Map();
      return [defineTool("quotes", "免费查询沪深京股票、ETF、指数的最新公开行情，不消耗 Wind 积分。代码必须带市场，000001.SH 为上证指数、000001.SZ 为平安银行。asOf 是上游报价时间，fetchedAt 仅为抓取时间；休市时可能是收盘价，不要把旧报价称为正在跳动的实时价格。只读，不交易。", {
        symbols: z.array(z.string().min(1).max(20)).min(1).max(50),
      }, async ({ symbols }) => {
        try {
          ctx.assertCurrent?.(accounts[0].id);
          const codes = [...new Set(symbols.map(normalizeSymbol))], key = [...codes].sort().join(","), saved = cache.get(key);
          let result, cached = false;
          if (saved?.promise || saved?.expires > now()) { result = saved.promise ? await saved.promise : saved.data; cached = true; }
          else {
            while (cache.size >= 32) cache.delete(cache.keys().next().value);
            const entry = { promise: request([...codes].sort()) };
            cache.set(key, entry);
            try { result = await entry.promise; cache.set(key, { data: result, expires: now() + CACHE_MS }); }
            catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
          }
          const ordered = new Map(result.quotes.map((quote) => [quote.code, quote]));
          return { content: [{ type: "text", text: JSON.stringify({ ...result, quotes: codes.flatMap((code) => ordered.has(code) ? [ordered.get(code)] : []), missing: codes.filter((code) => !ordered.has(code)), cached }) }] };
        } catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] }; }
      })];
    },
  };
}
export default createTencentQuotesConnector();
