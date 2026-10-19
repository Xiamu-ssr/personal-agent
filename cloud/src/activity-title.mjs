export function triggerTitle(text = "") {
  const match = text.trimStart().match(/^\[(第一次聊天|动态|Goal 推进|点子|心跳|补读)\](?=\s|$)[^\S\r\n]*([^\r\n]*)/);
  if (!match) return null;
  const detail = match[2].trim();
  if (match[1] === "Goal 推进") return detail ? `跟进目标：${detail}` : "跟进目标";
  if (match[1] === "补读") return detail ? `补读 ${detail}` : "补读";
  return { 第一次聊天: "第一次聊天", 动态: "看看有没有新动态", 点子: "想一批点子", 心跳: "继续未完成的事" }[match[1]];
}
