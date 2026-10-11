// Read-only IMAP. One connection per account/operation; no sockets or credentials are returned to the caller.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ImapFlow } from "imapflow";
import { convert } from "html-to-text";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";

const CLIENT_INFO = { name: "Doudou Personal Agent", version: "0.4.0", vendor: "Personal Agent" };
const BODY_LIMIT = 20_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_PENDING = 1000;
const BATCH_TTL = 3600_000;
const folderSchema = z.string().min(1).max(500).default("INBOX");
const accountSchema = z.string().min(1);
const uidSchema = z.number().int().positive().max(0xffffffff);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式为 YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, "日期不存在");
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

class EmailError extends Error {}
const emailError = (message) => new EmailError(message);
export function humanImapError(error) {
  if (error instanceof EmailError) return error.message;
  const raw = String(error?.message || "") + " " + String(error?.responseText || error?.response || "");
  if (/unsafe login/i.test(raw)) return "邮箱拒绝了登录；请开启 IMAP，163/126 邮箱还需要允许第三方客户端登录";
  if (error?.authenticationFailed || /AUTH|LOGIN|credentials|password/i.test(String(error?.code || "") + " " + raw)) {
    return "授权码不对或没开 IMAP，请到邮箱设置里开启 IMAP 并重新生成授权码";
  }
  if (/certificate|self.signed|TLS|SSL/i.test(raw + " " + String(error?.code || ""))) {
    return "邮箱服务器的安全连接验证失败，请检查服务器地址和 SSL 端口";
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ETIMEOUT|ConnectionNotAvailable|NoConnection|EConnection/i.test(String(error?.code || "")) ||
      /timeout|timed out|socket|connection|connect|greeting/i.test(raw)) {
    return "连不上服务器，请检查 IMAP 地址、端口和网络，稍后重试";
  }
  return "邮箱操作失败，请确认 IMAP 已开启、文件夹存在，稍后重试";
}

function validate(values, host) {
  const out = { ...values };
  if (typeof out.address !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.address.trim())) throw emailError("请填写有效的邮箱地址");
  out.address = out.address.trim();
  if (typeof out.password !== "string" || !out.password.trim() || out.password === "••••") throw emailError("请填写邮箱授权码");
  if (!host) {
    if (typeof out.host !== "string" || !out.host.trim() || /[\s/\\:@?#]/.test(out.host)) throw emailError("请填写 IMAP 服务器域名或 IP，不要带协议和路径");
    out.host = out.host.trim();
    out.port ??= 993;
    if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw emailError("端口必须是 1 到 65535 的整数");
  } else {
    // Presets always use the published host, port and TLS settings.
    delete out.host;
    delete out.port;
  }
  return out;
}

async function bounded(promise, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout?.(); reject(emailError("连不上服务器，请检查 IMAP 地址、端口和网络，稍后重试")); }, ms);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}

function structureParts(structure) {
  const bodies = [], attachments = [];
  function walk(node) {
    if (!node) return;
    const name = node.dispositionParameters?.filename || node.parameters?.name;
    const isAttachment = node.disposition === "attachment" || !!name;
    if (isAttachment) {
      attachments.push({ name: name || ("attachment-" + (node.part || "1")), size: node.size || 0, part: node.part || "1" });
      return; // An attached RFC822 message's nested text is not the parent message's body.
    }
    if (node.childNodes?.length) node.childNodes.forEach(walk);
    else if (node.type === "text/plain" || node.type === "text/html") bodies.push({ part: node.part || "1", type: node.type });
  }
  walk(structure);
  const plain = bodies.filter((p) => p.type === "text/plain");
  return { bodies: plain.length ? plain : bodies, attachments };
}

async function downloadBuffer(client, uid, part, maxBytes) {
  const { content } = await client.download(uid, part, { uid: true, maxBytes: maxBytes + 1 });
  if (!content) throw emailError("这封邮件或附件已不存在，请重新搜索");
  const chunks = [];
  let size = 0;
  for await (const chunk of content) {
    size += chunk.length;
    if (size > maxBytes) {
      content.destroy();
      throw emailError("附件太大，最多保存 25MB");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function bodyText(client, message, maxChars = BODY_LIMIT) {
  const { bodies } = structureParts(message.bodyStructure);
  const texts = [];
  let remaining = maxChars;
  for (const part of bodies) {
    if (remaining <= 0) break;
    const { content } = await client.download(message.uid, part.part, { uid: true, maxBytes: Math.min(MAX_TEXT_BYTES, maxChars * 6) });
    if (!content) continue;
    const chunks = [];
    for await (const chunk of content) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const plain = part.type === "text/html" ? convert(raw, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }] }) : raw;
    const clipped = Array.from(plain).slice(0, remaining).join("");
    texts.push(clipped);
    remaining -= Array.from(clipped).length + 1;
  }
  return Array.from(texts.join("\n")).slice(0, maxChars).join("");
}

function summary(account, folder, message) {
  const envelope = message.envelope || {};
  return { account: account.id, uid: message.uid, folder,
    from: (envelope.from || []).map((f) => f.name ? f.name + " <" + f.address + ">" : f.address).join(", "),
    subject: envelope.subject || "", date: (envelope.date || message.internalDate)?.toISOString() || null,
    unread: !message.flags?.has("\\Seen") };
}

const tuple = (item) => [Date.parse(item.date) || 0, item.account, item.uid];
function compareTuple(a, b) { return b[0] - a[0] || a[1].localeCompare(b[1]) || b[2] - a[2]; }
const compareItems = (a, b) => compareTuple(tuple(a), tuple(b));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value) {
  try {
    if (value.length > 20_000) throw new Error();
    const out = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (out.v !== 1 || typeof out.fingerprint !== "string" || !out.mailboxes || !Array.isArray(out.last) ||
        out.last.length !== 3 || !Number.isFinite(out.last[0]) || typeof out.last[1] !== "string" || !Number.isInteger(out.last[2])) throw new Error();
    return out;
  } catch { throw emailError("分页游标无效，请重新搜索"); }
}

// clientFactory is a local dependency-injection seam for TLS mock tests, never a user configuration field.
export function createImapConnector({ name = "imap", title = "其他邮箱", host, needsID = false,
  help = "在邮箱服务商设置中开启 IMAP，使用授权码或客户端专用密码", icon = "icon.png",
  clientFactory = (options) => new ImapFlow(options) } = {}) {
  async function withClient(values, operation) {
    const clean = validate(values, host);
    const client = clientFactory({
      host: host || clean.host, port: host ? 993 : clean.port, secure: true,
      auth: { user: clean.address, pass: clean.password },
      clientInfo: CLIENT_INFO, logger: false, emitLogs: false, logRaw: false,
      disableAutoIdle: true, disableCompression: true, disableBinary: true,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000,
    });
    // The EventEmitter's error channel must have a listener even after connect() rejects.
    client.on("error", () => {});
    try {
      await client.connect();
      if (needsID) {
        if (!client.capabilities.has("ID")) throw emailError("163/126 服务器不支持安全登录所需的 ID 命令，请检查服务器地址");
        // ImapFlow sends ID during connect; explicitly repeat it AFTER authentication for NetEase.
        // run('ID') is the library's command dispatcher (covered by the local wire-protocol tests).
        if (!await client.run("ID", CLIENT_INFO)) throw emailError("邮箱拒绝了客户端标识，请允许第三方客户端登录");
      }
      return await bounded(operation(client), 120_000, () => client.close());
    } catch (e) { throw emailError(humanImapError(e)); }
    finally {
      try { await bounded(client.logout(), 3000, () => client.close()); } catch {}
      client.close();
    }
  }

  async function inFolder(client, folder, operation) {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try { return await operation(client.mailbox); } finally { lock.release(); }
  }

  return {
    name, title, description: `读取${title}里的邮件（IMAP，只读）`, icon, multiAccount: true,
    fields: [
      { key: "address", label: "邮箱地址", type: "text", required: true, placeholder: "name@example.com" },
      { key: "password", label: "授权码", type: "secret", required: true, help },
      ...(!host ? [
        { key: "host", label: "IMAP 服务器", type: "text", required: true },
        { key: "port", label: "端口", type: "number", default: 993 },
      ] : []),
      { key: "label", label: "备注（可选）", type: "text", placeholder: "例如：工作邮箱" },
    ],
    label: (values) => values.label?.trim() || values.address,
    validate: (values) => validate(values, host),
    test: (values) => withClient(values, (client) => inFolder(client, "INBOX", async () => ({ ok: true }))),

    tools(accounts, ctx) {
      const chosen = (id) => {
        const found = id ? accounts.filter((a) => a.id === id) : accounts;
        if (!found.length) throw emailError(id ? "没有这个邮箱账号，请先用 connectors.list 查看账号" : "还没有配置邮箱账号");
        return found;
      };
      const wrap = (fn) => async (args) => {
        const safe = (value) => ctx.redact ? ctx.redact(value) : value;
        try { return text(safe(await fn(args))); }
        catch (e) { return { ...text(safe({ error: humanImapError(e) })), isError: true }; }
      };
      const fetchMessage = async (client, account, folder, uid) => {
        const message = await client.fetchOne(uid, { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true });
        if (!message) throw emailError("这封邮件已不存在，请重新搜索");
        return { ...summary(account, folder, message), text: await bodyText(client, message),
          attachments: structureParts(message.bodyStructure).attachments.map(({ name, size }) => ({ name, size })) };
      };
      const pending = ctx.pending;
      function prune() {
        for (const [id, batch] of pending) if (Date.now() - batch.createdAt > BATCH_TTL) pending.delete(id);
        while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
      }

      return [
        tool("list_folders", "列出邮箱文件夹。account 不填时查询全部账号。", { account: accountSchema.optional() }, wrap(async ({ account }) => {
          const items = [], errors = [];
          for (const a of chosen(account)) {
            try { items.push(...await withClient(a.values, async (client) => (await client.list()).map((f) => ({ account: a.id, name: f.path, delimiter: f.delimiter, specialUse: f.specialUse || null })))); }
            catch (e) { errors.push({ account: a.id, error: humanImapError(e) }); }
          }
          return { items, ...(errors.length ? { errors } : {}) };
        })),
        tool("search", "只读搜索邮件，按日期倒序。before 为上次返回的 next_before，不填 account 则搜索所有账号。", {
          account: accountSchema.optional(), folder: folderSchema, query: z.string().max(1000).optional(),
          from: z.string().max(500).optional(), since: dateSchema.optional(), until: dateSchema.optional(),
          unread: z.boolean().optional(), limit: z.number().int().min(1).max(50).default(20), before: z.string().optional(),
        }, wrap(async (args) => {
          const selected = chosen(args.account);
          const query = {};
          if (args.query) query.text = args.query;
          if (args.from) query.from = args.from;
          if (args.since) query.since = new Date(args.since + "T00:00:00Z");
          if (args.until) query.before = new Date(args.until + "T00:00:00Z");
          if (args.unread !== undefined) query.seen = !args.unread;
          if (!Object.keys(query).length) query.all = true;
          const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ accounts: selected.map((a) => a.id).sort(), folder: args.folder, query })).digest("hex");
          const before = args.before ? decode(args.before) : null;
          if (before && before.fingerprint !== fingerprint) throw emailError("分页条件已改变，请重新搜索");
          const mailboxes = {}, candidates = [], errors = [];
          for (const a of selected) {
            try {
              const rows = await withClient(a.values, (client) => inFolder(client, args.folder, async (mailbox) => {
                const validity = String(mailbox.uidValidity);
                const snapshot = before?.mailboxes[a.id];
                if (before && (!snapshot || snapshot.validity !== validity || !Number.isInteger(snapshot.maxUid))) throw emailError("邮箱内容已重建，请重新搜索");
                const uids = (await client.search(query, { uid: true }) || []).filter((uid) => !snapshot || uid <= snapshot.maxUid);
                mailboxes[a.id] = { validity, maxUid: snapshot?.maxUid ?? uids.reduce((max, uid) => Math.max(max, uid), 0) };
                const messages = [];
                // Fetch metadata in bounded chunks, not full messages for the entire mailbox.
                for (let start = 0; start < uids.length; start += 500) messages.push(...await client.fetchAll(uids.slice(start, start + 500), { uid: true, flags: true, envelope: true, internalDate: true }, { uid: true }));
                return messages.map((m) => summary(a, args.folder, m)).filter((m) => !before || compareTuple(tuple(m), before.last) > 0);
              }));
              candidates.push(...rows);
            } catch (e) {
              // A stale cursor must fail rather than silently skip a mailbox.
              if (e instanceof EmailError && /重新搜索|分页/.test(e.message)) throw e;
              errors.push({ account: a.id, error: humanImapError(e) });
            }
          }
          candidates.sort(compareItems);
          const items = candidates.slice(0, args.limit).map((m) => ({ ...m, snippet: "" }));
          for (const a of selected) {
            const page = items.filter((m) => m.account === a.id);
            if (!page.length) continue;
            try {
              await withClient(a.values, (client) => inFolder(client, args.folder, async (mailbox) => {
                if (String(mailbox.uidValidity) !== mailboxes[a.id].validity) throw emailError("邮箱内容已重建，请重新搜索");
                for (const item of page) {
                  const message = await client.fetchOne(item.uid, { bodyStructure: true, uid: true }, { uid: true });
                  if (message) item.snippet = (await bodyText(client, message, 200)).replace(/\s+/g, " ").trim();
                }
              }));
            } catch (e) {
              if (e instanceof EmailError && /重新搜索/.test(e.message)) throw e;
              errors.push({ account: a.id, error: humanImapError(e) });
            }
          }
          // No pagination token for a partial account failure: retrying must not silently lose that account's results.
          return { items, next_before: !errors.length && candidates.length > args.limit ? encode({ v: 1, fingerprint, mailboxes, last: tuple(items.at(-1)) }) : null,
            ...(errors.length ? { errors } : {}) };
        })),
        tool("read", "读取一封邮件的纯文本正文（最多 20k 字）和附件清单，不改变已读状态。", {
          account: accountSchema, folder: folderSchema, uid: uidSchema,
        }, wrap(async ({ account, folder, uid }) => {
          const a = chosen(account)[0];
          return withClient(a.values, (client) => inFolder(client, folder, () => fetchMessage(client, a, folder, uid)));
        })),
        tool("save_attachment", "按附件清单的 name 下载附件到 workspace/mail/<日期>/，返回相对路径。只读邮箱，单附件最多 25MB。", {
          account: accountSchema, folder: folderSchema, uid: uidSchema, name: z.string().min(1).max(1000),
        }, wrap(async ({ account, folder, uid, name }) => {
          const a = chosen(account)[0];
          return withClient(a.values, (client) => inFolder(client, folder, async () => {
            const message = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
            if (!message) throw emailError("这封邮件已不存在，请重新搜索");
            const attachment = structureParts(message.bodyStructure).attachments.find((f) => f.name === name);
            if (!attachment) throw emailError("没有这个附件，请先 read 查看附件清单");
            if (attachment.size > MAX_ATTACHMENT_BYTES * 1.4) throw emailError("附件太大，最多保存 25MB");
            const data = await downloadBuffer(client, uid, attachment.part, MAX_ATTACHMENT_BYTES);
            const day = new Intl.DateTimeFormat("sv-SE", { timeZone: ctx.timezone || "Asia/Shanghai" }).format(new Date());
            const dir = path.join(ctx.workspace, "mail", day);
            fs.mkdirSync(ctx.workspace, { recursive: true });
            const workspace = fs.realpathSync(ctx.workspace);
            for (const parent of [path.join(ctx.workspace, "mail"), dir]) {
              if (fs.existsSync(parent) && !fs.realpathSync(parent).startsWith(workspace + path.sep)) throw emailError("附件目录越出了 workspace，请联系管理员检查");
            }
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const realDir = fs.realpathSync(dir);
            if (!realDir.startsWith(workspace + path.sep)) throw emailError("附件目录越出了 workspace，请联系管理员检查");
            const filename = name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(-100) || "attachment";
            const file = path.join(dir, a.id + "-" + uid + "-" + crypto.randomUUID().slice(0, 8) + "-" + filename);
            fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
            return { account: a.id, path: path.relative(ctx.root, file), name, size: data.length };
          }));
        })),
        tool("read_since", "从各账号 INBOX 的已提交 UID 游标补读邮件。处理完后必须 sync_commit(cursor)；不提交就会重复返回。", {
          account: accountSchema.optional(), limit: z.number().int().min(1).max(100).default(50),
        }, wrap(async ({ account, limit }) => {
          prune();
          const state = ctx.readState(), items = [], targets = [], errors = [];
          let more = false;
          for (const a of chosen(account)) {
            try {
              ctx.assertCurrent(a.id);
              const result = await withClient(a.values, (client) => inFolder(client, "INBOX", async (mailbox) => {
                const validity = String(mailbox.uidValidity), base = state.accounts?.[a.id] || null;
                const last = base?.validity === validity ? base.uid || 0 : 0;
                // IMAP n:* can include the highest UID when n is past the end. Filter strictly >last.
                const uids = (await client.search({ uid: (last + 1) + ":*" }, { uid: true }) || []).filter((uid) => uid > last).sort((x, y) => x - y);
                const page = uids.slice(0, limit - items.length), rows = [];
                for (const uid of page) rows.push(await fetchMessage(client, a, "INBOX", uid));
                return { rows, more: uids.length > page.length, target: page.length ? { account: a.id, validity, uid: page.at(-1), base } : null };
              }));
              ctx.assertCurrent(a.id);
              items.push(...result.rows);
              more ||= result.more;
              if (result.target) targets.push(result.target);
            } catch (e) { errors.push({ account: a.id, error: humanImapError(e) }); }
          }
          const cursor = targets.length ? crypto.randomUUID() : null;
          if (cursor) pending.set(cursor, { targets, createdAt: Date.now() });
          return { items, cursor, more, ...(errors.length ? { errors } : {}) };
        })),
        tool("sync_commit", "提交 read_since 返回的 cursor，只有处理完成后才能调用；重复提交或过期批次会报错。", {
          cursor: z.string().min(1),
        }, wrap(async ({ cursor }) => {
          prune();
          const batch = pending.get(cursor);
          if (!batch) throw emailError("没有这个补读批次（可能已提交、过期、账号变更或服务重启过），请重新补读");
          const state = ctx.readState();
          state.accounts ||= {};
          for (const target of batch.targets) {
            ctx.assertCurrent(target.account);
            const current = state.accounts[target.account];
            if (current && current.validity !== target.validity && current.validity !== target.base?.validity) throw emailError("邮箱游标已重建，请重新补读");
            if (current?.validity === target.validity && current.uid >= target.uid) continue;
            state.accounts[target.account] = { validity: target.validity, uid: target.uid, committedAt: new Date().toISOString() };
          }
          ctx.writeState(state);
          pending.delete(cursor);
          // Outstanding batches from a previous UIDVALIDITY must never overwrite a newer epoch.
          for (const [id, other] of pending) if (other.targets.some((t) => state.accounts[t.account]?.validity !== t.validity)) pending.delete(id);
          return { ok: true };
        })),
      ];
    },
  };
}

