// Billing metadata is read on the server. Credentials and upstream bodies never enter a snapshot.
import crypto from 'node:crypto';
import { readProviders } from './providers.mjs';
import { accountQuota } from '../connectors/_shared/query-accounts.mjs';
import { deepseekBalance } from '../connectors/_shared/deepseek.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const number = v => typeof v === 'string' && v.trim() ? Number(v) : v;
export function allowance(id, label, unit, remaining, limit = null, resetAt = null) {
  if (!finite(remaining) || limit !== null && !finite(limit)) throw new Error('invalid allowance');
  resetAt = typeof resetAt === "string" && Number.isFinite(Date.parse(resetAt)) ? new Date(resetAt).toISOString() : null;
  return { id, label, unit, remaining, limit, resetAt, fraction: limit > 0 ? Math.min(1, remaining / limit) : limit === 0 ? 0 : null };
}
const snapshot = (status, message, items = [], extra = {}) => ({ status, message, items, checkedAt: Date.now(), ...extra });
export function totalUsage(rows) {
  if(rows.length && rows.every(r=>['ok','exhausted'].includes(r.status) && !r.items.length)) {
    const available=rows.some(r=>r.status==='ok');
    return snapshot(available?'ok':'exhausted',available?'额度正常':'额度不足');
  }
  const known = rows.filter(r => r.status === 'ok');
  const groups = new Map();
  for (const row of known) for (const item of row.items) {
    const key = `${item.id}:${item.unit}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const items = [...groups.values()].map(group => allowance(group[0].id, group[0].label, group[0].unit,
    group.reduce((n, i) => n + i.remaining, 0), group.every(i => i.limit !== null) ? group.reduce((n, i) => n + i.limit, 0) : null));
  const status = known.length === rows.length && rows.length ? 'ok' : known.length ? 'partial' : rows.some(r => r.status === 'exhausted') ? 'exhausted' : rows.some(r => r.status === 'error') ? 'error' : 'unsupported';
  return snapshot(status, known.length && known.length < rows.length ? `已查询 ${known.length}/${rows.length} 个账号` : rows[0]?.message ?? '未提供余量查询', items);
}

export function tavilyUsage(body) {
  const a = body?.account, k = body?.key;
  if (!finite(a?.plan_limit) || !finite(a?.plan_usage)) throw new Error('invalid usage');
  const items = [allowance('credits', '套餐积分', 'credits', Math.max(0, a.plan_limit - a.plan_usage), a.plan_limit)];
  if (finite(k?.limit) && finite(k?.usage)) items.push(allowance('key', '此 Key 额度', 'credits', Math.max(0, k.limit - k.usage), k.limit));
  if (finite(a.paygo_limit) && finite(a.paygo_usage) && a.paygo_limit > 0) items.push(allowance('paygo', '按量预算', 'credits', Math.max(0, a.paygo_limit - a.paygo_usage), a.paygo_limit));
  return snapshot('ok', '', items);
}

export function deepseekUsage(body) {
  return snapshot('ok', '', deepseekBalance(body).map(b => allowance(b.currency, '可用余额', b.currency, b.remaining)));
}

export class UsageService {
  constructor({ connectors, root, env = process.env, request = fetch, ttl = 60_000 }) {
    Object.assign(this, { connectors, root, env, request, ttl }); this.cache = new Map();
  }
  async json(url, key) {
    const response = await this.request(url, { redirect: 'error', headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('usage unavailable');
    return response.json();
  }
  cached(identity, credentials, read) {
    const key = identity + ':' + crypto.createHash('sha256').update(credentials).digest('hex');
    const old = this.cache.get(key);
    if (old && old.until > Date.now()) return old.value;
    const value = Promise.resolve().then(read).catch(() => snapshot('error', '余量暂时无法查询')).then(value => {
      if (this.cache.get(key)?.value === pending) this.cache.set(key, { until: Date.now() + this.ttl, value: Promise.resolve(value) });
      return value;
    });
    const pending = value;
    this.cache.set(key, { until: Infinity, value });
    // Bound retired-key entries without ever using credentials as map keys.
    if (this.cache.size > 200) for (const [id, record] of this.cache) if (record.until < Date.now()) this.cache.delete(id);
    return value;
  }
  async connector(name, account) {
    if (name === 'wind') {
      const exhausted = accountQuota(this.connectors.readState(name), account);
      return snapshot(exhausted ? 'exhausted' : 'ok', exhausted ? '额度不足' : '额度正常');
    }
    if (name === 'amap') return snapshot('unsupported', '');
    if (name === 'deepseek-search') return this.cached(`connector:${name}:${account.id}`, account.values.apiKey,
      async () => deepseekUsage(await this.json('https://api.deepseek.com/user/balance', account.values.apiKey)));
    return this.cached(`connector:${name}:${account.id}`, account.values.apiKey, async () => tavilyUsage(await this.json('https://api.tavily.com/usage', account.values.apiKey)));
  }
  async connectorList(list) {
    await Promise.all(list.installed.filter(c => ['tavily', 'deepseek-search', 'wind', 'amap'].includes(c.name)).map(async item => {
      const records = this.connectors.accounts.get(item.name);
      const usage = await Promise.all(records.map(a => this.connector(item.name, a)));
      // A deleted/replaced account cannot leak a stale result into a different account.
      item.accounts.forEach(a => { const index = records.findIndex(r => r.id === a.id); if (index >= 0) a.usage = usage[index]; });
      item.usage = totalUsage(usage);
    }));
    return list;
  }
  async provider(p) {
    const host = new URL(p.baseUrl).hostname;
    const key = p.apiKey;
    const management = p.managementKey;
    if (host === 'zenmux.ai' && !management) return snapshot('credentials', '添加管理 Key 后可查看额度');
    if (!['zenmux.ai', 'api.deepseek.com', 'openrouter.ai'].includes(host)) return snapshot('unsupported', '尚未接入余额查询');
    return this.cached(`provider:${p.id}`, key + ':' + (management || ''), async () => {
      if (host === 'api.deepseek.com') {
        return deepseekUsage(await this.json('https://api.deepseek.com/user/balance', key));
      }
      if (host === 'openrouter.ai') {
        // Standard inference keys may report their own spending cap; never pretend it is account cash.
        const body = await this.json('https://openrouter.ai/api/v1/key', key), d = body.data;
        if (d?.effective_budget) return snapshot('ok', '', [allowance('budget', '可用预算', 'USD', number(d.effective_budget.remaining_usd), number(d.effective_budget.limit_usd), d.effective_budget.resets_at)]);
        if (d?.limit_remaining == null) return snapshot('unsupported', '此 Key 未设置支出上限');
        return snapshot('ok', '', [allowance('key', '此 Key 剩余额度', 'USD', number(d.limit_remaining), number(d.limit))]);
      }
      const body = await this.json('https://zenmux.ai/api/v1/management/subscription/detail', management), d = body.data;
      const items = [];
      for (const [id, label] of [['quota_5_hour', '5 小时额度'], ['quota_7_day', '每周额度']]) {
        const q = d?.[id];
        if (q) items.push(allowance(id, label, 'flows', q.remaining_flows, q.max_flows, q.resets_at));
      }
      if (!items.length) {
        const payg = (await this.json('https://zenmux.ai/api/v1/management/payg/balance', management)).data;
        items.push(allowance('balance', '可用余额', 'USD', payg?.total_credits));
      }
      return snapshot('ok', '', items);
    });
  }
  async providerList(publicRows) {
    const privateRows = readProviders(this.root);
    return Promise.all(publicRows.map(async p => { const record=privateRows.find(r => r.id === p.id); return { ...p, usage: record ? await this.provider(record) : snapshot('error', '服务已变更，请刷新') }; }));
  }
}
