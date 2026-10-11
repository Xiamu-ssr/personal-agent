// Credentials stay in released connector code, never in a tool result or an error.
export async function requestJson(url, apiKey, body, { fetchImpl = fetch, title = "连接器", method = "POST" } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000), redirect: "error" });
  } catch { throw new Error(`${title}连接超时或网络不可用，请稍后重试`); }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new Error(`${title} API Key 无效或权限不足，请重新生成`);
    if ([402, 429, 432, 433].includes(response.status)) throw new Error(`${title}额度不足或请求过于频繁，请稍后重试`);
    throw new Error(`${title}服务暂不可用（HTTP ${response.status}）`);
  }
  try {
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("unexpected JSON");
    return data;
  }
  catch { throw new Error(`${title}返回的 JSON 无法解析，请稍后重试`); }
}

export function privateResult(value, keys, ctx) {
  function mask(item) {
    if (typeof item === "string") {
      for (const key of keys) item = item.replaceAll(key, "••••");
      return item;
    }
    if (Array.isArray(item)) return item.map(mask);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, mask(v)]));
    return item;
  }
  const safe = mask(value);
  return ctx?.redact ? ctx.redact(safe) : safe;
}

export function apiKeyValues(values, prefix) {
  const apiKey = values.apiKey?.trim();
  if (!apiKey || apiKey === "••••" || (prefix && !apiKey.startsWith(prefix))) {
    throw new Error(prefix ? `请填写 ${prefix} 开头的个人 API Key` : "请填写 API Key");
  }
  return { ...values, apiKey };
}
