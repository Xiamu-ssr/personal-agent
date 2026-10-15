import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { sharedBrowser, USER_BUSY } from "./browser.mjs";

const ref = z.string().regex(/^(?:f\d+)?e\d+$/).max(64).describe("最新页面快照里的元素 ref，例如 e3 或 f1e3");
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

export function browserTools(browser) {
  const action = (fn) => async (args, extra) => {
    try {
      const result = await browser.runAgent((page, signal) => fn(args, page, signal), { onStart: extra?.onStart });
      return result?.content ? result : text(result ?? { ok: true });
    } catch (error) {
      return { isError: true, ...text(error.name === "TimeoutError" ? "浏览器操作超时，请重新读取页面后再试" : "浏览器操作未完成，请检查安装或重新读取页面；登录、验证码、付款确认请请求用户接管") };
    }
  };
  return [
    tool("open", "在唯一标签页打开网址。仅 HTTP/HTTPS；遇到登录、验证码或付款确认时，调用 request_takeover 请用户操作。", {
      url: z.string().url().max(8192).refine((url) => ["http:", "https:"].includes(new URL(url).protocol), "只支持 HTTP/HTTPS"),
    }, action(async ({ url }, page, signal) => { await page.goto(url, { waitUntil: "domcontentloaded", signal }); return { url: page.url() }; })),
    tool("snapshot", "读取当前页面的可访问性快照，交互元素带 ref。页面变化后重新读取，再按 ref 操作。登录、验证码、付款确认交给用户接管。", {},
      action(async (_args, page, signal) => text((await page.ariaSnapshot({ mode: "ai", signal })).slice(0, 80_000)))),
    tool("click", "点击最新快照中的元素 ref。不要替用户点登录、验证码或付款确认；这些操作请 request_takeover。", { ref },
      action(({ ref }, page, signal) => page.getByRef(ref).click({ signal }))),
    tool("fill", "填写元素 ref 对应的输入框，会替换原内容。登录凭据、验证码等请请求用户接管输入。", { ref, text: z.string().max(16_384) },
      action(({ ref, text }, page, signal) => page.getByRef(ref).fill(text, { signal }))),
    tool("select", "选择元素 ref 对应的下拉选项，values 为选项 value 数组。", { ref, values: z.array(z.string().max(1024)).min(1).max(50) },
      action(({ ref, values }, page, signal) => page.getByRef(ref).selectOption(values, { signal }))),
    tool("press", "按键，例如 Enter、Tab、Escape、ControlOrMeta+A。可指定元素 ref；省略时在当前焦点按键。付款确认交给用户接管。", { key: z.string().min(1).max(80), ref: ref.optional() },
      action(({ key, ref }, page, signal) => (ref ? page.getByRef(ref) : page.locator(":root")).press(key, { signal }))),
    tool("scroll", "滚动页面，deltaX/deltaY 是 CSS 像素，正数向右/向下。", { deltaX: z.number().min(-5000).max(5000).default(0), deltaY: z.number().min(-5000).max(5000) },
      action(async ({ deltaX, deltaY }) => { await browser.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX, deltaY }); return { ok: true }; })),
    tool("screenshot", "查看当前浏览器画面（JPEG）。遇到登录、验证码、付款确认请请求用户接管。", {},
      action(async (_args, page, signal) => ({ content: [{ type: "image", mimeType: "image/jpeg", data: (await page.screenshot({ type: "jpeg", quality: 65, timeout: 8000, signal })).toString("base64") }] }))),
    tool("wait", "等待页面变化，最多 10 秒；用户接管期间直接返回等待交还提示，不操作页面。", { seconds: z.number().min(0).max(10).default(1) },
      action(async ({ seconds }, _page, signal) => { await delay(seconds * 1000, undefined, { signal }); return { ok: true }; })),
    tool("request_takeover", "请求用户在 App 接管，必须用一句中文说明原因，例如「这里要登录，你来一下」。登录、验证码、付款确认必须交给用户；接管后停止操作，等用户交还再继续。", { reason: z.string().trim().min(1).max(300) },
      async ({ reason }, extra) => {
        if (browser.owner === "user") return text({ blocked: true, message: USER_BUSY });
        try { await extra?.onStart?.(); return text(await browser.takeover(reason)); }
        catch { return { isError: true, ...text("浏览器接管准备失败，请检查浏览器安装后再试") }; }
      }),
  ];
}

export function createBrowserMcpServer({ browser, onCall = () => {}, feed = false, ...options } = {}) {
  const feedNote = "[动态] 仅在确实需要读取用户已登录的网站时使用浏览器，其余来源用轻量读取。遇到未登录、验证码或确认操作就跳过，不发起登录或接管。";
  return createSdkMcpServer({ name: "browser", version: "0.8.0",
    instructions: "云端唯一的有界面浏览器，登录状态会保留。先读取 snapshot，再按 ref 操作。登录、验证码、付款确认必须请求用户接管；用户操作时不要抢，等他交还。" + (feed ? feedNote : ""),
    tools: browserTools(browser || sharedBrowser(options)).map((tool) => ({ ...tool, description: (feed ? feedNote : "") + tool.description, handler: async (args, extra) => {
      if (feed && tool.name === "request_takeover") return text({ blocked: true, message: "动态运行不请求接管，请跳过需要登录或确认的来源" });
      return tool.handler(args, { ...extra, onStart: () => onCall(tool.name, args, extra) });
    } })) });
}
