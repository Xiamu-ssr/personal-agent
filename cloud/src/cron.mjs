const formatters = new Map();
const nextRuns = new Map();
export function timeParts(tz, date) {
  if (!formatters.has(tz)) formatters.set(tz, new Intl.DateTimeFormat("en-US", {
    timeZone: tz, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hour12: false,
  }));
  const p = Object.fromEntries(formatters.get(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return [Number(p.minute), Number(p.hour) % 24, Number(p.day), Number(p.month), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday)];
}
const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
export function cronFields(expr) {
  if (typeof expr !== "string") throw new Error("cron 必须是五段表达式");
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron 必须是五段表达式");
  return fields.map((field, i) => {
    const [min, max] = bounds[i], values = new Set();
    for (const part of field.split(",")) {
      const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!match) throw new Error("cron 格式不正确");
      const step = match[2] === undefined ? 1 : Number(match[2]);
      const [lo, hi] = match[1] === "*" ? [min, max] : match[1].includes("-") ? match[1].split("-").map(Number) : [Number(match[1]), match[2] ? max : Number(match[1])];
      if (lo < min || hi > max || lo > hi || !step || step > max - min + 1) throw new Error("cron 数值超出范围");
      for (let n = lo; n <= hi; n += step) values.add(i === 4 && n === 7 ? 0 : n);
    }
    return values;
  });
}
function matches(fields, expr, tz, date) {
  const t = timeParts(tz, date), original = expr.trim().split(/\s+/);
  const day = original[2] !== "*" && original[4] !== "*" ? fields[2].has(t[2]) || fields[4].has(t[4]) : fields[2].has(t[2]) && fields[4].has(t[4]);
  return fields[0].has(t[0]) && fields[1].has(t[1]) && fields[3].has(t[3]) && day;
}
export function cronMatches(expr, tz, date = new Date()) { return matches(cronFields(expr), expr, tz, date); }
export function nextCron(expr, tz, after = new Date()) {
  const key = `${tz}\n${expr}`, cached = nextRuns.get(key);
  if (cached && after.getTime() >= cached.after && cached.next && after.getTime() < Date.parse(cached.next)) return cached.next;
  const fields = cronFields(expr), start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let ts = start; ts <= start + 366 * 86400_000; ts += 60_000) if (matches(fields, expr, tz, new Date(ts))) {
    const next = new Date(ts).toISOString();
    if (nextRuns.size > 512) nextRuns.delete(nextRuns.keys().next().value);
    nextRuns.set(key, { after: after.getTime(), next }); return next;
  }
  return null;
}
