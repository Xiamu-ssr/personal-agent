import { serviceRequest } from "./browser/service-client.mjs";

export async function screenshotService({ root, path, timeoutMs = 30_000 }) {
  try {
    const { pid: _pid, data, ...metadata } = await serviceRequest(root, "/screenshot", { timeoutMs,
      body: { path, timeoutMs: Math.max(100, Math.min(25_000, timeoutMs - 3000)) } });
    if (typeof data !== "string") throw new Error();
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > 300 * 1024) throw new Error();
    return { ...metadata, data: bytes };
  } catch { throw new Error("页面截图暂不可用：请检查 personal-agent-browser.service、浏览器安装和内存上限"); }
}
