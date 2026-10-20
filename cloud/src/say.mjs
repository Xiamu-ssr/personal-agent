import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { defineTool } from "./product-tools.mjs";
import { appendJsonl, readJson, tailJsonl } from "./store.mjs";
import { writePrivateJson } from "./private-json.mjs";
import { localFile } from "./local-paths.mjs";
import { replyMedia, nativeReplyMedia, mediaFile } from "./media.mjs";
import { taskId } from "./task-history.mjs";
import { readGoal } from "./content.mjs";
import { VERSION } from "./config.mjs";

const name = z.string().trim().min(1).max(200);
export const cardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connector"), id: name }),
  z.object({ type: z.literal("goal"), name }),
  z.object({ type: z.literal("link"), url: z.url().refine((s) => /^https?:/.test(s)), title: name.optional(), description: z.string().max(2000).optional(), image: z.url().refine((s) => /^https?:/.test(s)).optional() }),
  ...["image", "video", "audio", "file"].map((type) => z.object({ type: z.literal(type), path: z.string().min(1).max(1024), name: name.optional() })),
  z.object({ type: z.literal("device"), capability: name.optional() }),
]);
export const saySchema = {
  text: z.string().max(40_000),
  options: z.array(z.object({ label: name, reply: z.string().trim().min(1).max(8000).optional() })).max(12).optional(),
  cards: z.array(cardSchema).max(20).optional(),
};

export class Speech {
  constructor({ root, bus, redact = (s) => s, onSay = () => {}, activityId }) {
    Object.assign(this, { root, bus, redact, onSay, activityId });
    const dir = activityId ? path.join(root, "system/side-chats", taskId(activityId)) : path.join(root, "system");
    this.log = path.join(dir, "chat.jsonl");
    this.usedFile = path.join(dir, activityId ? "options.json" : "chat-options.json");
    this.used = readJson(this.usedFile, {});
  }
  side(activityId) { return new Speech({ ...this, activityId: taskId(activityId) }); }
  user(text, attachments = [], source = "app") {
    if (!this.activityId) throw new Error("旁聊消息缺少活动 id");
    const entry = { role: "user", id: crypto.randomUUID(), text: this.redact(text), ts: Date.now(), source,
      activityId: this.activityId, chatType: "side", ...(attachments.length && { attachments }) };
    appendJsonl(this.log, entry);
    this.bus.emit({ t: "activity_message", ...entry });
    return entry;
  }
  history(n = 200) {
    return tailJsonl(this.log, n).filter((m) => m.role !== "user" || m.source !== "onboarding")
      .map((m) => m.options?.length ? { ...m, optionsUsed: !!this.used[m.id] } : m);
  }
  waiting() {
    const last = this.history(1)[0];
    return last?.role === "assistant" && !!last.options?.length && !last.optionsUsed;
  }
  emit(args, { id = crypto.randomUUID(), activityId = this.activityId, chatType, error = false, silent = false, nativeMedia = [] } = {}) {
    if (silent) throw new Error("后台运行不能对用户说话");
    if (chatType === "side" && !this.activityId) return this.side(activityId).emit(args, { id, error, nativeMedia });
    const value = z.object(saySchema).parse(args);
    if (!value.text.trim() && !value.options?.length && !value.cards?.length && !nativeMedia.length) throw new Error("说话内容不能为空");
    for (const card of value.cards || []) if (card.path) localFile(this.root, card.path, "data");
    for (const card of value.cards || []) if (card.type === "goal") {
      try { readGoal(this.root, card.name); }
      catch { throw new Error(`data/goals/${card.name}.md 还没写好（或格式不对），先按系统提示词里的目标格式写好再发卡片。`); }
    }
    const entry = { role: "assistant", id, text: this.redact(value.text), ts: Date.now(),
      ...(activityId && { activityId }), ...(this.activityId && { chatType: "side" }), ...(error && { error: true }) };
    if (value.options?.length) entry.options = value.options.map((o, i) => ({ id: String(i), label: this.redact(o.label), reply: this.redact(o.reply ?? o.label) }));
    if (value.cards?.length) entry.cards = value.cards.map(c=>c.path?{...c,...mediaFile(this.root,c.path,c.name)}:c).map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "string" ? this.redact(v) : v])));
    const media = [...nativeReplyMedia(this.root,nativeMedia),...replyMedia(this.root, entry.text)].filter((m,i,a)=>a.findIndex(n=>n.path===m.path)===i);
    if (media.length) entry.media = media;
    appendJsonl(this.log, entry);
    this.bus.emit({ t: this.activityId ? "activity_message" : "say", ...entry });
    this.onSay(entry);
    return entry;
  }
  async choose(messageId, optionId, send) {
    if (typeof messageId !== "string" || typeof optionId !== "string") throw Object.assign(new Error("请提供消息和选项 id"), { status: 400 });
    if (this.used[messageId]) throw Object.assign(new Error("这组选项已经失效"), { status: 409 });
    const message = tailJsonl(this.log, Number.MAX_SAFE_INTEGER).find((m) => m.id === messageId && m.role === "assistant");
    const option = message?.options?.find((o) => o.id === optionId);
    if (!option) throw Object.assign(new Error("没有这个选项"), { status: 404 });
    this.used[messageId] = { optionId, ts: Date.now() };
    writePrivateJson(this.usedFile, this.used);
    this.bus.emit({ t: "options_used", messageId, optionId, ...(this.activityId && { activityId: this.activityId, chatType: "side" }) });
    const id = await send(option.reply, "option");
    return { ok: true, id, messageId, optionId, ...(this.activityId && { activityId: this.activityId, chatType: "side" }) };
  }
  tools(context = () => ({})) {
    return [defineTool("say", "发送气泡、选项和卡片，每次发一条短句气泡，可分多次说。主聊天在主聊天说，旁聊只在当前旁聊说；后台运行不能对用户说话。卡片用途：connector：连接应用；goal：展示一个已经写好的目标（data/goals/<name>.md），卡片本身不会创建目标；link：网页预览；image/video/audio/file：展示 data/ 下已交付的影音或文件；device：打开本机能力授权。options 是一次性回复按钮。", saySchema, async (args, extra) => {
      try { return { content: [{ type: "text", text: JSON.stringify({ id: this.emit(args, context(extra)).id }) }] }; }
      catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
    })];
  }
}
