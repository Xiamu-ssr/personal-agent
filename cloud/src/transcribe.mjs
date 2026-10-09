// Speech to text for hold-to-talk and voice notes, through the same ZenMux key.
// ZenMux's /audio/transcriptions endpoint 500s; an audio-capable chat model transcribes well and costs ~nothing.
// Node's fetch ignores HTTPS_PROXY (the ECS can only reach ZenMux through mihomo), so this shells out to curl.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const MODEL = process.env.AGENT_ASR_MODEL || "google/gemini-3.5-flash-lite";
const FORMATS = new Set(["wav", "mp3", "aac", "ogg", "flac", "m4a"]);

function endpoint() {
  const base = (process.env.ANTHROPIC_BASE_URL || "https://zenmux.ai/api/anthropic").replace(/\/anthropic\/?$/, "");
  return `${base}/v1/chat/completions`;
}

// The model sometimes spaces out every CJK character.
function tidy(s) {
  return s.trim().replace(/(?<=[㐀-鿿＀-￯，。！？、；：])\s+(?=[㐀-鿿＀-￯，。！？、；：])/g, "");
}

export function audioFormat(name) {
  const ext = path.extname(name || "").slice(1).toLowerCase();
  return FORMATS.has(ext) ? ext : null;
}

export async function transcribe(buf, format) {
  if (!FORMATS.has(format)) throw new Error(`不支持的音频格式：${format}`);
  const body = {
    model: MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "input_audio", input_audio: { data: buf.toString("base64"), format } },
        { type: "text", text: "把这段语音逐字转写成文字。只输出转写内容，加上正常的标点，汉字之间不要加空格。听不清或没有人声就输出空。说话人在和名叫「豆豆」的助手说话。" },
      ],
    }],
  };
  const tmp = path.join(os.tmpdir(), `asr-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(body));
  try {
    const out = await new Promise((resolve, reject) => {
      execFile("curl", [
        "-sS", "-m", "90", endpoint(),
        "-H", `Authorization: Bearer ${process.env.ANTHROPIC_AUTH_TOKEN || ""}`,
        "-H", "content-type: application/json",
        "--data-binary", `@${tmp}`,
      ], { maxBuffer: 4 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const d = JSON.parse(out);
    if (d.error) throw new Error(d.error.message || "转写失败");
    return tidy(d.choices?.[0]?.message?.content || "");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
