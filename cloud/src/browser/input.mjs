import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const number = z.number().finite();
const point = { x: number.nonnegative(), y: number.nonnegative() };
const frame = { frameId: z.number().int().positive(), width: number.positive().max(16_384), height: number.positive().max(16_384) };
export const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ...frame, ...point, button: z.enum(["left", "right", "middle"]).default("left"), clickCount: z.number().int().min(1).max(2).default(1) }),
  z.object({ type: z.literal("pointer"), ...frame, ...point, phase: z.enum(["down", "move", "up"]) }),
  z.object({ type: z.literal("drag"), ...frame, points: z.array(z.object(point)).min(2).max(64) }),
  z.object({ type: z.literal("scroll"), ...frame, ...point, deltaX: number.min(-10_000).max(10_000).default(0), deltaY: number.min(-10_000).max(10_000) }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(16_384) }),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(32), modifiers: z.number().int().min(0).max(15).default(0) }),
  z.object({ type: z.literal("dialog"), accept: z.boolean(), promptText: z.string().max(16_384).optional() }),
]);

export function mapCoordinates(event, frame) {
  const { x, y, width, height } = event;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || x < 0 || y < 0 || x > width || y > height) {
    throw Object.assign(new Error("坐标必须位于画面内，width/height 是实际显示的图片尺寸（不含留白）"), { status: 400 });
  }
  const viewport = frame.viewport;
  if (!(viewport?.width > 0 && viewport?.height > 0)) throw new Error("画面尺寸无效，请等待下一帧");
  return { x: Math.min(viewport.width - 1, x / width * viewport.width), y: Math.min(viewport.height - 1, y / height * viewport.height) };
}

const KEY_CODES = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, ArrowLeft: 37,
  ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };

export async function dispatchKey(cdp, key, modifiers = 0) {
  const code = KEY_CODES[key] || (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0);
  if (!code) throw Object.assign(new Error("不支持这个按键；普通文字请用 text，特殊键使用 Enter、Tab、Escape、方向键等标准名称"), { status: 400 });
  const params = { key, windowsVirtualKeyCode: code, modifiers };
  if (key === "Enter") params.text = "\r";
  else if (key.length === 1 && !(modifiers & 7)) params.text = key;
  if (key.toLowerCase() === "a" && (modifiers & 6)) params.commands = ["selectAll"];
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  const { text: _text, commands: _commands, ...up } = params;
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
}

export async function dispatchInput(cdp, raw, frames, state = {}) {
  const event = inputSchema.parse(raw);
  if (event.type === "text") return cdp.send("Input.insertText", { text: event.text });
  if (event.type === "key") return dispatchKey(cdp, event.key, event.modifiers);
  if (event.type === "dialog") return cdp.send("Page.handleJavaScriptDialog", { accept: event.accept, ...(event.promptText !== undefined ? { promptText: event.promptText } : {}) });
  const frame = frames.get(event.frameId);
  if (!frame) throw Object.assign(new Error("这张画面已过期，请等新画面再操作"), { status: 409 });
  const position = (p) => mapCoordinates({ ...event, ...p }, frame);
  const mouse = (type, p, extras = {}) => cdp.send("Input.dispatchMouseEvent", { type, ...position(p), ...extras });
  const down = async (p, button = "left", clickCount = 1) => {
    if (state.pointerDown) throw Object.assign(new Error("上一次拖动尚未结束，请先发送 pointer up"), { status: 409 });
    await mouse("mousePressed", p, { button, buttons: button === "left" ? 1 : button === "right" ? 2 : 4, clickCount });
    state.pointerDown = position(p);
  };
  const up = async (p, button = "left", clickCount = 1) => {
    await mouse("mouseReleased", p, { button, buttons: 0, clickCount }); state.pointerDown = null;
  };
  if (event.type === "click") {
    await mouse("mouseMoved", event);
    await down(event, event.button, event.clickCount);
    return up(event, event.button, event.clickCount);
  }
  if (event.type === "pointer") {
    if (event.phase === "down") return down(event);
    if (event.phase === "up") return up(event);
    await mouse("mouseMoved", event, { button: state.pointerDown ? "left" : "none", buttons: state.pointerDown ? 1 : 0 });
    if (state.pointerDown) state.pointerDown = position(event);
    return;
  }
  if (event.type === "drag") {
    for (const p of event.points) position(p);
    await down(event.points[0]);
    try {
      for (const p of event.points.slice(1)) {
        await mouse("mouseMoved", p, { button: "left", buttons: 1 });
        state.pointerDown = position(p); await delay(16);
      }
    } finally { await up(event.points.at(-1)); }
    return;
  }
  await mouse("mouseWheel", event, { deltaX: event.deltaX / event.width * frame.viewport.width, deltaY: event.deltaY / event.height * frame.viewport.height });
}
