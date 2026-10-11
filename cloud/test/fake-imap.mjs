// A TLS, wire-protocol IMAP fixture. Credentials are fictional; AUTH/LOGIN payloads are never logged.
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { ImapFlow } from "imapflow";
import { createImapConnector } from "../connectors/_shared/imap.mjs";

export const FAKE_PASSWORD = "fake-imap-only-password";
const q = (value) => '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const NIL = "NIL";

export function message(uid, { date = "2026-10-09T10:00:00Z", subject = "Mail " + uid, seen = false, html, text = "Fixture text " + uid, attachments = [] } = {}) {
  const parts = [{ type: html ? "text/html" : "text/plain", data: Buffer.from(html || text), name: null },
    ...attachments.map((a) => ({ type: a.type || "application/octet-stream", name: a.name, data: Buffer.from(a.data) }))];
  for (const part of parts) part.encoded = Buffer.from(part.data.toString("base64"));
  return { uid, date: new Date(date), subject, seen, from: "sender@example.test", parts };
}

function partStructure(part) {
  const [type, subtype] = part.type.toUpperCase().split("/");
  const params = part.name ? '("NAME" ' + q(part.name) + ')' : '("CHARSET" "UTF-8")';
  const disposition = part.name ? '("ATTACHMENT" ("FILENAME" ' + q(part.name) + "))" : NIL;
  return "(" + [q(type), q(subtype), params, NIL, NIL, '"BASE64"', part.encoded.length,
    ...(type === "TEXT" ? [1] : []), NIL, disposition, NIL, NIL].join(" ") + ")";
}

function bodyStructure(m) {
  if (m.parts.length === 1) return partStructure(m.parts[0]);
  return "(" + m.parts.map(partStructure).join(" ") + ' "MIXED" ("BOUNDARY" "fixture") NIL NIL NIL)';
}

function mime(part) {
  return Buffer.from("Content-Type: " + part.type + (part.name ? '; name="' + part.name + '"' : "; charset=utf-8") +
    "\r\nContent-Transfer-Encoding: base64\r\n" +
    (part.name ? 'Content-Disposition: attachment; filename="' + part.name + '"\r\n' : "") + "\r\n");
}

function envelope(m) {
  const sender = '((NIL NIL "sender" "example.test"))';
  return "(" + [q(m.date.toUTCString()), q(m.subject), sender, sender, sender, NIL, NIL, NIL, NIL, q("<" + m.uid + "@example.test>")].join(" ") + ")";
}

function imapDate(date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return String(date.getUTCDate()).padStart(2, "0") + "-" + months[date.getUTCMonth()] + "-" + date.getUTCFullYear() +
    " " + date.toISOString().slice(11, 19) + " +0000";
}

function includesUid(range, uid, maxUid) {
  return range.split(",").some((piece) => {
    const [a, b = a] = piece.split(":").map((v) => v === "*" ? maxUid : Number(v));
    return uid >= Math.min(a, b) && uid <= Math.max(a, b);
  });
}

export async function startFakeImap(dir) {
  const certFile = path.join(dir, "imap-ca.pem"), keyFile = path.join(dir, "imap-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyFile, "-out", certFile, "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  const ca = fs.readFileSync(certFile), sockets = new Set(), commands = [];
  const fixture = {
    validity: 1001, failLogin: false, commands, sockets,
    mailboxes: new Map([["INBOX", [
      message(1, { subject: "Project one" }),
      message(2, { date: "2026-10-10T10:00:00Z", subject: "Project HTML", html: "<html><body><h1>Hello 邮件</h1><p>Readable body</p><script>hidden()</script></body></html>",
        attachments: [{ name: "report.txt", data: "fixture attachment" }] }),
      message(3, { subject: "Project three", seen: true }),
      message(4, { date: "2026-10-08T10:00:00Z", subject: "Earlier Project" }),
    ]], ["Archive", [message(1, { subject: "Archived" })]]]),
  };
  const server = tls.createServer({ cert: ca, key: fs.readFileSync(keyFile) }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "", authenticated = false, selected = "INBOX", postLoginId = false;
    socket.setEncoding("utf8");
    socket.write("* OK Local fixture ready\r\n");
    const ok = (tag, suffix = "fixture completed") => socket.write(tag + " OK " + suffix + "\r\n");
    const no = (tag, suffix) => socket.write(tag + " NO " + suffix + "\r\n");
    socket.on("data", (data) => {
      buffer += data;
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n"), line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const match = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
        if (!match) continue;
        const [, tag, command, rest = ""] = match, cmd = command.toUpperCase();
        commands.push({ command: cmd, authenticated, ...(cmd === "UID" ? { detail: rest } : {}) });
        if (cmd === "CAPABILITY") { socket.write("* CAPABILITY IMAP4rev1 ID NAMESPACE\r\n"); ok(tag); }
        else if (cmd === "ID") {
          if (authenticated) postLoginId = true;
          socket.write('* ID ("name" "local fixture" "version" "1")\r\n'); ok(tag);
        } else if (cmd === "LOGIN") {
          const values = [...rest.matchAll(/"((?:\\.|[^"])*)"|([^\s]+)/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, "$1"));
          if (fixture.failLogin || values[1] !== FAKE_PASSWORD) no(tag, "[AUTHENTICATIONFAILED] Invalid credentials");
          else { authenticated = true; ok(tag); }
        } else if (cmd === "NAMESPACE") { socket.write('* NAMESPACE (("" "/")) NIL NIL\r\n'); ok(tag); }
        else if (cmd === "LIST" || cmd === "LSUB") {
          const onlyRoot = rest === '"" ""';
          if (onlyRoot) socket.write('* LIST (\\Noselect) "/" ""\r\n');
          else for (const name of fixture.mailboxes.keys()) socket.write("* LIST () " + q("/") + " " + q(name) + "\r\n");
          ok(tag);
        } else if (cmd === "EXAMINE") {
          selected = rest.replace(/^"|"$/g, "");
          if (!fixture.mailboxes.has(selected)) { no(tag, "No such mailbox"); continue; }
          const mails = fixture.mailboxes.get(selected);
          socket.write("* FLAGS (\\Seen)\r\n* " + mails.length + " EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY " + fixture.validity + "] valid\r\n" +
            "* OK [UIDNEXT " + (Math.max(0, ...mails.map((m) => m.uid)) + 1) + "] next\r\n");
          ok(tag, "[READ-ONLY] EXAMINE completed");
        } else if (cmd === "UID") {
          const mails = fixture.mailboxes.get(selected) || [], maxUid = Math.max(0, ...mails.map((m) => m.uid));
          if (/^SEARCH\b/i.test(rest)) {
            let found = mails;
            const range = rest.match(/\bUID\s+([\d:*,]+)/i)?.[1];
            if (range) found = found.filter((m) => includesUid(range, m.uid, maxUid));
            if (/\bUNSEEN\b/i.test(rest)) found = found.filter((m) => !m.seen);
            else if (/\bSEEN\b/i.test(rest)) found = found.filter((m) => m.seen);
            const query = rest.match(/\bTEXT\s+"([^"]*)"/i)?.[1];
            if (query) found = found.filter((m) => (m.subject + m.parts.map((p) => p.data.toString()).join("")).toLowerCase().includes(query.toLowerCase()));
            const from = rest.match(/\bFROM\s+"([^"]*)"/i)?.[1];
            if (from) found = found.filter((m) => m.from.includes(from));
            for (const [word, accept] of [["SINCE", (m, d) => m.date >= d], ["BEFORE", (m, d) => m.date < d]]) {
              const value = rest.match(new RegExp("\\b" + word + '\\s+"?([\\d]+-[A-Za-z]+-[\\d]+)"?', "i"))?.[1];
              if (value) found = found.filter((m) => accept(m, new Date(value + " 00:00:00 UTC")));
            }
            socket.write("* SEARCH" + (found.length ? " " + found.map((m) => m.uid).join(" ") : "") + "\r\n"); ok(tag);
          } else if (/^FETCH\b/i.test(rest)) {
            const range = rest.match(/^FETCH\s+([^\s]+)/i)[1];
            const requests = [...rest.matchAll(/BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi)];
            for (const m of mails.filter((mail) => includesUid(range, mail.uid, maxUid))) {
              socket.write("* " + (mails.indexOf(m) + 1) + " FETCH (UID " + m.uid +
                " FLAGS (" + (m.seen ? "\\Seen" : "") + ") INTERNALDATE " + q(imapDate(m.date)) +
                " ENVELOPE " + envelope(m) + " BODYSTRUCTURE " + bodyStructure(m) +
                " RFC822.SIZE " + m.parts.reduce((n, p) => n + p.encoded.length, 0));
              for (const request of requests) {
                const section = request[1], index = /^(TEXT|HEADER)$/i.test(section) ? 0 : Number(section.split(".")[0]) - 1, part = m.parts[index];
                let data = /\.MIME$|^HEADER$/i.test(section) ? mime(part) : part?.encoded || Buffer.alloc(0);
                if (request[2] !== undefined) data = data.subarray(Number(request[2]), Number(request[2]) + Number(request[3]));
                socket.write(" BODY[" + section + "]" + (request[2] !== undefined ? "<" + request[2] + ">" : "") + " {" + data.length + "}\r\n");
                socket.write(data);
              }
              socket.write(")\r\n");
            }
            ok(tag);
          } else no(tag, "Unsupported UID fixture command");
        } else if (cmd === "LOGOUT") { socket.write("* BYE fixture bye\r\n"); ok(tag); socket.end(); }
        else if (cmd === "NOOP") ok(tag);
        else no(tag, "Unsupported fixture command");
      }
    });
    // Retain a signal for the explicit post-login ID assertions without recording the login payload.
    socket.fixturePostLoginId = () => postLoginId;
  });
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  fixture.port = port;
  fixture.values = (address = "alpha@example.test") => ({ address, password: FAKE_PASSWORD, host: "127.0.0.1", port });
  fixture.clientFactory = (options) => new ImapFlow({ ...options, host: "127.0.0.1", port, tls: { ca } });
  fixture.connector = createImapConnector({
    clientFactory: fixture.clientFactory, icon: "icon.svg",
  });
  fixture.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return fixture;
}
