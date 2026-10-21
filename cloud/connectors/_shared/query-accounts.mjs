import crypto from "node:crypto";

// Opt-in for stateless Tavily/DeepSeek/Wind queries. Account-scoped tools do not use this pool.
export class QuotaExhaustedError extends Error {
  constructor(message, retryAt, { replay = true } = {}) { super(message); this.retryAt = retryAt; this.replay = replay; }
}

const identity = (account) => crypto.createHash("sha256").update(account.values.apiKey).digest("hex");
export function nextMonth(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}
export function nextChinaDay(now = Date.now()) {
  return (Math.floor((now + 8 * 3600_000) / 86400_000) + 1) * 86400_000 - 8 * 3600_000;
}

export function accountQuota(state, account, now = Date.now()) {
  const record = state.queryAccounts?.blocked?.[account.id];
  return record?.identity === identity(account) && record.retryAt > now ? record : null;
}

export function clearAccountQuota(ctx, id) {
  const state = ctx.readState();
  if (!state.queryAccounts) return;
  delete state.queryAccounts.blocked?.[id];
  if (state.queryAccounts.activeId === id) delete state.queryAccounts.activeId;
  ctx.writeState(state);
}

export function queryAccounts(accounts, ctx, { title, now = Date.now } = {}) {
  // Real manager contexts persist the pool across main/side/background queries and restarts.
  // Small standalone connector fixtures can run without a state store.
  let memory = {};
  const read = () => ctx.readState?.() || memory;
  const write = (state) => ctx.writeState ? ctx.writeState(state) : (memory = state);
  return {
    async run(fn, { account: pinned } = {}) {
      if (pinned && !accounts.some((account) => account.id === pinned)) throw new Error("没有这个连接器账号，请先查看连接器账号列表");
      const state = read(), activeId = state.queryAccounts?.activeId;
      const ordered = pinned ? accounts.filter((account) => account.id === pinned) : [
        ...accounts.filter((account) => account.id === activeId), ...accounts.filter((account) => account.id !== activeId),
      ];
      for (const account of ordered) {
        // An in-flight query snapshot must not keep using removed/replaced credentials.
        ctx.assertCurrent?.(account.id);
        if (accountQuota(read(), account, now())) {
          if (pinned) throw new Error(`${title}指定账号额度已耗尽；不会切换带会话或游标的请求，请恢复该账号额度后重试`);
          continue;
        }
        try {
          const value = await fn(account);
          const latest = read();
          latest.queryAccounts ||= {};
          latest.queryAccounts.blocked ||= {};
          // A late success must not reactivate a key another concurrent request just exhausted.
          if (!accountQuota(latest, account, now())) {
            delete latest.queryAccounts.blocked[account.id];
            latest.queryAccounts.activeId = account.id;
            write(latest);
          }
          return { value, account: account.id };
        } catch (error) {
          if (!(error instanceof QuotaExhaustedError)) throw error;
          const latest = read();
          latest.queryAccounts ||= {};
          latest.queryAccounts.blocked ||= {};
          latest.queryAccounts.blocked[account.id] = { identity: identity(account), retryAt: error.retryAt, checkedAt: now() };
          write(latest);
          if (!error.replay) throw error;
          if (pinned) throw new Error(`${title}指定账号额度已耗尽；不会切换带会话或游标的请求，请恢复该账号额度后重试`);
        }
      }
      throw new Error(`${title}所有已配置账号的额度均已耗尽，请充值、等待额度恢复，或添加可用账号；恢复后也可点「重新测试」`);
    },
  };
}

// Inspect only explicit error envelopes, never successful search results or report prose.
export function errorText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return [value.message, value.error, value.detail, value.code].map(errorText).filter(Boolean).join(" ");
}
export const exhaustedCredits = (text) => /积分(?:余额)?不足|余额不足|积分(?:已)?(?:用尽|耗尽)|额度(?:已)?(?:用尽|耗尽)|insufficient\s+(?:credits?|balance)|(?:credits?|balance|quota).{0,35}(?:exhausted|depleted)|(?:exceeded|exceeds|reached).{0,40}(?:plan.{0,12}usage limit|monthly.{0,12}(?:limit|quota))|(?:plan.{0,12}usage limit).{0,20}(?:exceeded|reached)/i.test(text);

export function secretPreview(secret) {
  const chars = Array.from(secret || ""), edge = chars.length >= 4 ? Math.min(4, Math.max(1, Math.floor(chars.length * 0.15))) : 0;
  return edge ? chars.slice(0, edge).join("") + "••••" + chars.slice(-edge).join("") : "••••";
}
