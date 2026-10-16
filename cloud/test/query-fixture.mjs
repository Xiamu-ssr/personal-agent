export function queryFixture(calls, { onInput = () => {} } = {}) {
  return ({ prompt, options }) => {
    const messages = [], waiters = [];
    let closed = false;
    const q = {
      options, received: [], stopped: [], closed: false, flagSettings: [],
      async applyFlagSettings(settings) { q.flagSettings.push(settings); },
      async setModel(model) { q.model = model; },
      async setPermissionMode(mode) { q.permissionMode = mode; },
      emit(message) { const waiter = waiters.shift(); waiter ? waiter({ value: message, done: false }) : messages.push(message); },
      close() {
        closed = true; q.closed = true;
        for (const waiter of waiters.splice(0)) waiter({ done: true });
        for (const server of Object.values(options.mcpServers)) server.instance.close().catch(() => {});
      },
      async interrupt() { q.emit({ type: "result", subtype: "success" }); },
      async stopTask(id) { q.stopped.push(id); q.emit({ type: "system", subtype: "task_notification", task_id: id, status: "stopped" }); },
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (messages.length) return { value: messages.shift(), done: false };
        if (closed) return { done: true };
        return new Promise((resolve) => waiters.push(resolve));
      },
    };
    calls.push(q);
    q.emit({ type: "system", subtype: "init", session_id: options.resume || "fictional-main-session" });
    q.inputFinished = (async () => {
      for await (const message of prompt) { q.received.push(message); onInput(q, message); }
      if (!options.perTaskStopAffordance) q.close();
    })();
    return q;
  };
}
