const normalized = (text) => text.replace(/\s+/g, " ").trim();
export const SPEECH_REMINDER = "你最后写的这段正文用户看不到。要告诉用户的话用 say 发出（短句，可以分几条）；如果只是旁白或总结，直接结束。";

export class TurnSpeech {
  texts = [];
  last = "";
  prose = "";
  blocked = false;
  say(text) { this.texts.push(normalized(text)); }
  assistant(content = []) {
    const text = content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
    if (text.trim()) this.prose = text;
    this.last = content.some((b) => b.type === "tool_use") ? "" : text;
  }
  stop(input = {}) {
    const text = normalized(input.last_assistant_message ?? this.last) || (!this.texts.length ? normalized(this.prose) : "");
    if (this.blocked || input.stop_hook_active || !text || this.texts.some((said) => said.includes(text))) return {};
    this.blocked = true;
    return { decision: "block", reason: SPEECH_REMINDER };
  }
}
