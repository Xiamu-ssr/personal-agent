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

// ts of the first line; reads only the head of the file.
export function firstTs(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const l of buf.subarray(0, n).toString("utf8").split("\n")) {
      try {
        const ts = JSON.parse(l).ts;
        if (ts) return ts;
      } catch {}
    }
  } catch {}
  return null;
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
