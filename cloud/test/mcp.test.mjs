import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConnectorManager, SECRET_MASK } from "../src/connectors.mjs";
import { startFakeImap, message, FAKE_PASSWORD } from "./fake-imap.mjs";

test("real SDK MCP initialize/list/call exchange: management is safe and rebuilt email tools run against local IMAP", async (t) => {
  const root = fs.mkdtempSync(path.join(testRoot, "mcp-")), imap = await startFakeImap(root);
  t.after(() => imap.close());
  const manager = new ConnectorManager({ root, definitions: [imap.connector] });
  async function clientFor(server) {
    const client = new Client({ name: "local-test", version: "0.3.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(() => client.close());
    return client;
  }
  async function call(client, name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes(FAKE_PASSWORD), false);
    return JSON.parse(result.content[0].text);
  }
  const initial = manager.mcpServers();
  assert.equal("imap" in initial, false);
  const management = await clientFor(initial.connectors);
  const listing = await management.listTools();
  assert.deepEqual(listing.tools.map((tool) => tool.name), ["list", "add_account", "update_account", "remove_account"]);
  const added = await call(management, "add_account", { name: "imap", values: imap.values() });
  const servers = manager.mcpServers(), mail = await clientFor(servers.imap);
  const emailTools = await mail.listTools();
  assert.deepEqual(emailTools.tools.map((tool) => tool.name), ["list_folders", "search", "read", "save_attachment", "read_since", "sync_commit"]);
  const page = await call(mail, "search", { account: added.id, limit: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(typeof page.next_before, "string");
  const invalidLimit = await mail.callTool({ name: "search", arguments: { limit: 51 } });
  assert.equal(invalidLimit.isError, true);
  const batch = await call(mail, "read_since", { account: added.id, limit: 1 });
  assert.equal(batch.items[0].uid, 1);
  await call(mail, "sync_commit", { cursor: batch.cursor });
  assert.equal(manager.readState("imap").accounts[added.id].uid, 1);
  imap.mailboxes.get("INBOX").push(message(5, { text: "A fake credential in a message: " + FAKE_PASSWORD }));
  const safeMail = await call(mail, "read", { account: added.id, uid: 5 });
  assert.equal(safeMail.text.includes(SECRET_MASK), true);
  await call(management, "update_account", { name: "imap", id: added.id, values: { password: SECRET_MASK, label: "Protocol test" } });
  const safeList = await call(management, "list");
  assert.equal(safeList.installed[0].accounts[0].values.password, SECRET_MASK);
  await call(management, "remove_account", { name: "imap", id: added.id });
  assert.equal("imap" in manager.mcpServers(), false);
});
