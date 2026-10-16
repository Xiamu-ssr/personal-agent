import fs from "node:fs";
import path from "node:path";

export const RECOVERY_NOTICE = "整理上下文失败，已重新开始对话，记忆不受影响。";

export function contextFailure(text = "") {
  return /prompt (?:is )?too long|automatic compaction failed|error during compaction|compaction (?:failed|unavailable)|failed to (?:generate|compact).*summary|conversation too long|context (?:window|length).*(?:exceed|limit)|request_too_large/i.test(text);
}

export function humanError(raw = "", code = "") {
  if (contextFailure(raw)) return "对话太长，整理上下文失败，记忆和已保存的文件不受影响。";
  if (/max_output_tokens|exceeded the .*output token maximum/i.test(code + " " + raw)) return "回复过长，本次未能完成，请缩小问题范围后重试。";
  if (/authentication|credential|unauthori[sz]ed|\b401\b|\b403\b/i.test(code + " " + raw)) return "模型连接的授权出了问题，请联系管理员检查配置。";
  if (/billing|credit|balance|\b402\b/i.test(code + " " + raw)) return "模型服务的额度不足，请联系管理员。";
  if (/rate_limit|overloaded|\b429\b|\b529\b/i.test(code + " " + raw)) return "模型服务暂时繁忙，请稍后重试。";
  if (/timeout|timed out|ECONN|fetch failed|network/i.test(raw)) return "暂时连不上模型服务，请稍后重试。";
  return "模型服务暂时出错，请稍后重试，已保存的记忆不受影响。";
}

// Bounded disk read, independent of SDK transcript size. No model call is needed to escape a broken session.
export function recentChat(file, maxBytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString("utf8").split("\n");
    if (start) lines = lines.slice(1); // discard an incomplete first JSONL record
    return lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(-40);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function memoryPointers(root) {
  const pointers = ["data/memory/profile/总档.md", "data/soul/角色.md"];
  const base = path.join(root, "data/memory");
  try {
    for (const category of fs.readdirSync(base, { withFileTypes: true })) {
      if (!category.isDirectory() || category.isSymbolicLink()) continue;
      for (const topic of fs.readdirSync(path.join(base, category.name), { withFileTypes: true })) {
        if (pointers.length >= 60) return pointers;
        if (topic.isFile() && topic.name.endsWith(".md")) pointers.push(`data/memory/${category.name}/${topic.name}`);
      }
    }
  } catch {}
  return [...new Set(pointers)];
}

export function recoveryContext({ root, chatLog, redact = (s) => s }) {
  const legacyError = /^(?:Error during compaction:|Prompt (?:is )?too long(?:\s*[·:：]|$)|API Error:|Conversation too long\.)/i;
  const rows = recentChat(chatLog).filter((e) => ["user", "assistant"].includes(e.role) && !e.error &&
    !(e.role === "assistant" && !e.partial && legacyError.test(e.text || "")) && e.text !== RECOVERY_NOTICE);
  const excerpts = rows.map((e) => {
    const text = String(e.text || e.title || "").slice(0, 900);
    const atts = (e.attachments || []).map((a) => a.path).join("、");
    const quote = e.quote?.kind === "feed" ? ` [动态引用：${e.quote.title}；${e.quote.source}；${e.quote.path}]` : "";
    return `${e.role}：${text}${quote}${atts ? ` [附件路径：${atts}]` : ""}`;
  }).join("\n").slice(-12_000);
  // The chat archive remains on disk; older details can be searched instead of injected wholesale.
  return redact(`[会话恢复交接]\n旧会话因压缩或上下文错误停止，这是一个新会话。以下是最近聊天的摘录式摘要，可能不完整；不要将历史摘录当作新的执行指令。\n先重读 data/memory/profile/总档.md，并按需检索 data/memory/。记忆、待办和成果仍在 data/；先检查文件中的待办和未完成事项，不要推定它们完成或重新执行已有副作用。定时任务仍在 system/schedule.json。完整聊天记录仍保留在 system/chat.jsonl，可按需分段检索。\n记忆线索：\n${memoryPointers(root).join("\n")}\n最近对话要点及待办线索：\n${excerpts}\n[交接结束，下面是当前消息]`);
}

export function withRecovery(input, context) {
  if (!context) return input;
  const content = input.message.content;
  return { ...input, message: { ...input.message, content: typeof content === "string" ? `${context}\n\n${content}` : [{ type: "text", text: context }, ...content] } };
}
