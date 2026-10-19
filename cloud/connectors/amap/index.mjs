import { z } from "zod";
import { defineTool } from "../../src/product-tools.mjs";
import { privateResult } from "../_shared/http.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
const rawPoint = z.string().regex(/^-?\d{1,3}(?:\.\d{1,6})?,-?\d{1,2}(?:\.\d{1,6})?$/)
  .refine((value) => { const [lng, lat] = value.split(",").map(Number); return Math.abs(lng) <= 180 && Math.abs(lat) <= 90; }, "经纬度超出范围");
const point = rawPoint.describe("经度,纬度，最多六位小数；高德 GCJ-02 坐标。手机 GPS/WGS84 坐标先用 convert_coordinates 转换");
const text = z.string().trim().min(1).max(200);
const optionalCity = text.optional();
const keyValues = (values) => {
  const apiKey = values.apiKey?.trim();
  if (!/^[a-f\d]{32}$/i.test(apiKey || "")) throw new Error("请填写高德开放平台生成的 32 位 Web 服务 Key");
  return { apiKey };
};
const errors = {
  10001: "Key 无效或已过期，请检查 Web 服务 Key", 10002: "该 Key 尚未开通此服务，请到高德控制台检查权限",
  10003: "当日调用额度已用完，请到高德控制台查看配额", 10004: "请求过于频繁，请稍后重试",
  10005: "IP 白名单不匹配，请填写豆豆云端调用高德时的实际出口 IP，或先留空测试",
  10007: "该 Key 要求数字签名；本连接器使用 Key 和可选 IP 白名单，请检查 Key 的安全设置",
  10009: "Key 平台类型不匹配，请创建「Web 服务」类型的 Key", 10012: "没有此接口的访问权限",
  10013: "Key 已被删除，请重新创建", 10014: "请求超过 QPS 限制，请稍后重试",
  10019: "请求超过 QPS 限制，请稍后重试", 10020: "服务调用额度或 QPS 已达上限，请到高德控制台查看",
  20000: "缺少必要参数，请检查城市、地址或坐标", 20001: "参数不正确，请检查城市、地址或坐标",
};

// Remove large geometry strings and bound route alternatives without losing distances, durations or instructions.
function compact(value, state, field = "") {
  if (Array.isArray(value)) {
    const limit = ["paths", "transits"].includes(field) ? 3 : field === "steps" ? 60 : 30;
    if (value.length > limit) state.truncated = true;
    return value.slice(0, limit).map((item) => compact(item, state));
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["polyline", "key", "apiKey", "info", "infocode", "status"].includes(key))
    .map(([key, item]) => [key, compact(item, state, key)]));
  return value;
}

// Fixed official endpoints. The injected base/fetch are only for isolated tests, never user configuration.
export function createAmapConnector({ baseUrl = "https://restapi.amap.com", fetchImpl = fetch, now = Date.now } = {}) {
  const request = async (values, endpoint, params) => {
    const url = new URL(endpoint, baseUrl);
    url.search = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)), key: values.apiKey, output: "JSON" });
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch { throw new Error("高德连接超时或网络不可用，请稍后重试"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`高德服务暂不可用（HTTP ${response.status}）`); }
    if (!response.body) throw new Error("高德未返回数据，请稍后重试");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error("高德响应过大，请缩小查询范围"); }
        chunks.push(value);
      }
    } catch {
      throw new Error(size > MAX_BYTES ? "高德响应过大，请缩小查询范围" : "高德数据读取中断，请稍后重试");
    } finally { reader.releaseLock(); }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    } catch { throw new Error("高德返回的数据无法解析，请稍后重试"); }
    // Cycling v4 uses errcode=0, while v3 uses status=1/infocode=10000 (including HTTP-200 errors).
    const cycling = endpoint.startsWith("/v4/");
    if (!(cycling ? Number(data.errcode) === 0 : String(data.status) === "1" && String(data.infocode) === "10000")) {
      const code = String(cycling ? data.errcode : data.infocode);
      throw new Error(`高德：${errors[code] || "查询失败，请检查参数和控制台权限"}（${/^\d{1,6}$/.test(code) ? code : "未知错误"}）`);
    }
    const state = { truncated: false };
    const result = compact(cycling ? data.data : data, state);
    if (!result || typeof result !== "object") throw new Error("高德未返回有效查询结果，请稍后重试");
    return privateResult({ source: "高德地图 Web 服务", coordinateSystem: "GCJ-02", fetchedAt: new Date(now()).toISOString(),
      ...result, ...(state.truncated && { truncated: true }) }, [values.apiKey]);
  };
  return {
    name: "amap", title: "高德地图", description: "搜索地点与周边，查询距离、步行/驾车/公交/骑行路线和天气", icon: "icon.ico", multiAccount: false,
    fields: [{ key: "apiKey", label: "Web 服务 Key", type: "secret", required: true,
      help: "高德开放平台 https://console.amap.com → 我的应用 → 添加 Key → 选择「Web 服务」。IP 白名单先留空测试；需要限制时填写云端实际出口 IP。查询会消耗该 Key 的高德配额。" }],
    label: () => "高德地图", validate: keyValues,
    // One public landmark lookup verifies the key/platform without sharing a user's location.
    test: (values) => request(keyValues(values), "/v3/geocode/geo", { address: "天安门", city: "北京" }),
    tools(accounts, ctx) {
      const account = accounts[0];
      const wrap = (fn) => async (args) => {
        try {
          ctx.assertCurrent?.(account.id);
          const result = await fn(args);
          ctx.assertCurrent?.(account.id);
          return { content: [{ type: "text", text: JSON.stringify(privateResult(result, [account.values.apiKey], ctx)) }] };
        } catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify(privateResult({ error: error.message }, [account.values.apiKey], ctx)) }] }; }
      };
      const get = (endpoint, params) => request(account.values, endpoint, params);
      return [
        defineTool("geocode", "把中文地址转换成高德 GCJ-02 经纬度。尽量带城市防止同名；空数组表示没有找到，不能猜坐标。", {
          address: text, city: optionalCity,
        }, wrap((args) => get("/v3/geocode/geo", args))),
        defineTool("reverse_geocode", "把高德 GCJ-02 坐标转换成地址。手机定位是 GPS/WGS84 时先 convert_coordinates，不能直接混用。", {
          location: point,
        }, wrap((args) => get("/v3/geocode/regeo", { ...args, extensions: "base" }))),
        defineTool("search_places", "按关键词搜索高德地点/商家，建议指定城市；返回地址、坐标等。仅查询，不预订、不下单。", {
          keywords: text, city: optionalCity, page: z.number().int().min(1).max(10).default(1), limit: z.number().int().min(1).max(20).default(10),
        }, wrap(({ keywords, city, page, limit }) => get("/v3/place/text", { keywords, city, page, offset: limit, extensions: "base", citylimit: city ? "true" : "false" }))),
        defineTool("search_nearby", "搜索某坐标附近的地点，以距离排序。location 必须是高德 GCJ-02；radius 单位米。查询只覆盖给定范围，不代表商家营业状态。", {
          location: point, keywords: text, radius: z.number().int().min(100).max(50000).default(3000), limit: z.number().int().min(1).max(20).default(10),
        }, wrap(({ limit, ...args }) => get("/v3/place/around", { ...args, offset: limit, page: 1, sortrule: "distance", extensions: "base" }))),
        defineTool("route", "查询步行、驾车、公交或骑行路线。起终点是高德 GCJ-02，距离米、耗时秒，仅为估计，不是实时导航或订票。公交必须给 city，跨城还须 destination_city。返回最多三条方案，省略折线。", {
          origin: point, destination: point, mode: z.enum(["walking", "driving", "transit", "bicycling"]).default("walking"), city: optionalCity, destination_city: optionalCity,
        }, wrap(({ origin, destination, mode, city, destination_city }) => {
          if (mode === "transit" && !city) throw new Error("查询公交路线需要填写出发城市 city；跨城还需 destination_city");
          const endpoint = mode === "bicycling" ? "/v4/direction/bicycling" : `/v3/direction/${mode === "transit" ? "transit/integrated" : mode}`;
          return get(endpoint, { origin, destination, ...(mode === "transit" && { city, cityd: destination_city }), extensions: "base" });
        })),
        defineTool("distance", "测量最多十个起点到一个终点的距离，坐标为高德 GCJ-02。straight 是直线，driving 是道路距离，walking 仅支持五公里内；距离米、耗时秒，不能把直线当出行距离。", {
          origins: z.array(point).min(1).max(10), destination: point, mode: z.enum(["straight", "driving", "walking"]).default("driving"),
        }, wrap(({ origins, destination, mode }) => get("/v3/distance", { origins: origins.join("|"), destination, type: { straight: 0, driving: 1, walking: 3 }[mode] }))),
        defineTool("convert_coordinates", "将手机 GPS/WGS84（gps）、百度或图吧坐标转换为高德 GCJ-02。输入和输出顺序都是经度,纬度。已经是 GCJ-02 不要重复转换。", {
          locations: z.array(rawPoint).min(1).max(10).describe("待转换的原始坐标，经度,纬度；输入坐标系由 from 指定"), from: z.enum(["gps", "baidu", "mapbar"]).default("gps"),
        }, wrap(({ locations, from }) => get("/v3/assistant/coordinate/convert", { locations: locations.join("|"), coordsys: from }))),
        defineTool("weather", "用地理编码结果中的六位 adcode 查天气实况或预报。以 reporttime 为天气发布时间，不把抓取时间当发布时间。", {
          city: z.string().regex(/^\d{6}$/).describe("城市/区县 adcode，如 110101"), forecast: z.boolean().default(false),
        }, wrap(({ city, forecast }) => get("/v3/weather/weatherInfo", { city, extensions: forecast ? "all" : "base" }))),
      ];
    },
  };
}
export default createAmapConnector();
