import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { appendJsonl, readJson, tailJsonl } from "./store.mjs";
import { writePrivateJson } from "./private-json.mjs";
import { localFile } from "./local-paths.mjs";
import { replyMedia } from "./media.mjs";

const name = z.string().trim().min(1).max(200);
export const cardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connector"), id: name }),
  z.object({ type: z.literal("goal"), name }),
  z.object({ type: z.literal("link"), url: z.url().refine((s) => /^https?:/.test(s)), title: name.optional(), description: z.string().max(2000).optional(), image: z.url().refine((s) => /^https?:/.test(s)).optional() }),
  ...["image", "video", "audio", "file"].map((type) => z.object({ type: z.literal(type), path: z.string().min(1).max(1024), name: name.optional() })),
  z.object({ type: z.literal("browser") }),
  z.object({ type: z.literal("device"), capability: name.optional() }),
]);
export const saySchema = {
  text: z.string().max(40_000),
  options: z.array(z.object({ label: name, reply: z.string().trim().min(1).max(8000).optional() })).max(12).optional(),
  cards: z.array(cardSchema).max(20).optional(),
};

export class Speech {
  constructor({ root, bus, redact = (s) => s, onSay = () => {} }) {
    Object.assign(this, { root, bus, redact, onSay });
    this.log = path.join(root, "system/chat.jsonl");
    this.usedFile = path.join(root, "system/chat-options.json");
    this.used = readJson(this.usedFile, {});
  }
  history(n = 200) {
    return tailJsonl(this.log, n).map((m) => m.options?.length ? { ...m, optionsUsed: !!this.used[m.id] } : m);
  }
  waiting() {
    const last = this.history(1)[0];
    return last?.role === "assistant" && !!last.options?.length && !last.optionsUsed;
  }
  emit(args, { id = crypto.randomUUID(), activityId, fallback = false, error = false } = {}) {
    const value = z.object(saySchema).parse(args);
    if (!value.text.trim() && !value.options?.length && !value.cards?.length) throw new Error("说话内容不能为空");
    for (const card of value.cards || []) if (card.path) localFile(this.root, card.path, "data");
    const entry = { role: "assistant", id, text: this.redact(value.text), ts: Date.now(),
      ...(activityId && { activityId }), ...(fallback && { fallback: true }), ...(error && { error: true }) };
    if (value.options?.length) entry.options = value.options.map((o, i) => ({ id: String(i), label: this.redact(o.label), reply: this.redact(o.reply ?? o.label) }));
    if (value.cards?.length) entry.cards = value.cards.map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "string" ? this.redact(v) : v])));
    const media = replyMedia(this.root, entry.text);
    if (media.length) entry.media = media;
    appendJsonl(this.log, entry);
    this.bus.emit({ t: "say", ...entry });
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
    this.bus.emit({ t: "options_used", messageId, optionId });
    const id = await send(option.reply, "option");
    return { ok: true, id, messageId, optionId };
  }
  tools(context = () => ({})) {
    return [tool("say", "对用户说话。每次调用发一条聊天气泡，可带一次性选项和卡片。后台运行的说话也发到主聊天。", saySchema, async (args, extra) => {
      try { return { content: [{ type: "text", text: JSON.stringify({ id: this.emit(args, context(extra)).id }) }] }; }
      catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
    })];
  }
  mcpServer(context) { return createSdkMcpServer({ name: "doudou", version: "0.8.0", tools: this.tools(context) }); }
}
