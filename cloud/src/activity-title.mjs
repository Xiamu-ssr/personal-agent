export function triggerTitle(text = "") {
  const match = text.trimStart().match(/^\[(第一次聊天|动态|目标跟进|点子|夜间整理|补读)\](?=\s|$)[^\S\r\n]*([^\r\n]*)/);
  if (!match) return null;
  const detail = match[2].trim();
  if (match[1] === "目标跟进") return detail ? `跟进目标：${detail}` : "跟进目标";
  if (match[1] === "补读") return detail ? `补读 ${detail}` : "补读";
  return { 第一次聊天: "第一次聊天", 动态: "看看有没有新动态", 点子: "想一批点子", 夜间整理: "夜间整理" }[match[1]];
}
