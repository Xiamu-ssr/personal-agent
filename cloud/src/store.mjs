// Small JSON/JSONL helpers for system/ state.
import fs from "node:fs";
import path from "node:path";

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}

export function tailJsonl(file, n) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.trimEnd().split("\n").filter(Boolean).slice(-n);
  return lines.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

export function nowIn(tz) {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return fmt.format(d);
}

export function dateIn(tz, d = new Date()) {
  // YYYY-MM-DD in the given timezone
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(d);
}
