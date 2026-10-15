export function workingText(name, input = {}) {
  const value = `${name} ${input.file_path || input.path || ""}`;
  if (/mail|email/i.test(value)) return "在看你的邮件";
  if (/browser|WebFetch|WebSearch|tavily|page__/i.test(value)) return "在浏览网页";
  if (/data\/feed\//.test(value)) return "在写动态";
  if (/data\/ideas\//.test(value)) return "在想点子";
  if (/data\/goals\//.test(value)) return "在跟进目标";
  if (/memory|soul/.test(value)) return "在整理记忆";
  return "努力工作中";
}

export class Avatar {
  constructor({ bus, busy, waiting, waitingForUser = () => false, happyMs = 3000 }) {
    Object.assign(this, { bus, busy, waiting, waitingForUser, happyMs });
    this.value = { state: "idle" };
  }
  set(state, text) {
    const next = { state, ...(state === "working" && { text: text || "努力工作中" }) };
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.value = next;
    this.bus.emit({ t: "avatar", ...next });
  }
  working(name = "", input) {
    clearTimeout(this.timer);
    if (this.waitingForUser()) return this.set("waiting");
    this.set("working", workingText(name, input));
  }
  settle(ok = true) {
    clearTimeout(this.timer);
    if (this.waitingForUser()) return this.set("waiting");
    if (this.busy()) return this.set("working", this.value.text);
    if (!ok) return this.set("error");
    if (this.waiting()) return this.set("waiting");
    this.set("happy");
    this.timer = setTimeout(() => {
      if (!this.busy()) this.set(this.waiting() ? "waiting" : "idle");
    }, this.happyMs);
    this.timer.unref?.();
  }
  close() { clearTimeout(this.timer); }
}
