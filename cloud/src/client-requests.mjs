export class ClientRequests {
  constructor({ clock = Date.now, ttl = 10 * 60_000 } = {}) { Object.assign(this, { clock, ttl }); this.entries = new Map(); }
  run(clientId, execute) {
    if (clientId === undefined) return Promise.resolve().then(execute);
    if (typeof clientId !== "string" || !clientId.length || [...clientId].length > 64) throw Object.assign(new Error("clientId 要 1–64 个字符"), { status: 400 });
    const now = this.clock();
    for (const [id, entry] of this.entries) if (entry.done && entry.expires <= now) this.entries.delete(id);
    if (this.entries.has(clientId)) return this.entries.get(clientId).promise;
    const entry = { expires: now + this.ttl };
    entry.promise = Promise.resolve().then(execute).finally(() => { entry.done = true; });
    this.entries.set(clientId, entry);
    return entry.promise;
  }
}
