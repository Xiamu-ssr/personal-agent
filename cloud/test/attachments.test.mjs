import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { validateMessage, userContent } from "../src/attachments.mjs";
import { Harness } from "../src/agent.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { startServer } from "../src/server.mjs";
import { config } from "../src/config.mjs";

function upload(root, name, data) {
  const file = path.join(root, "data/uploads/fixture", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return { path: path.relative(root, file), name, kind: "file" };
}

test("attachment size is the actual file size, ignoring any client-supplied size", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "sizes-")), att = upload(root, "报价.txt", Buffer.alloc(12 * 1024));
  for (const size of [0, 1, 100 * 1024 * 1024, -1, "forged", null]) {
    const value = validateMessage(root, " 文件 ", [{ ...att, size }]);
    assert.equal(value.text, "文件");
    assert.deepEqual(value.attachments, [{ ...att, size: fs.statSync(path.join(root, att.path)).size }]);
  }
});

test("legacy attachment requests without size still accept attachment-only messages", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "legacy-")), att = upload(root, "空文件.txt", Buffer.alloc(0));
  assert.deepEqual(validateMessage(root, "", [att]), { text: "", attachments: [{ ...att, size: 0 }] });
  assert.deepEqual(validateMessage(root, "  纯文本  "), { text: "纯文本", attachments: [] });
});

test("image, file and voice attachments retain kinds, names and sizes; images remain message blocks", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "kinds-"));
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const atts = [
    { ...upload(root, "图片.png", imageBytes), kind: "image" },
    upload(root, "文件.txt", Buffer.from("文件内容")),
    { ...upload(root, "语音.m4a", Buffer.from("local voice fixture")), kind: "voice" },
  ];
  const value = validateMessage(root, "", atts);
  assert.deepEqual(value.attachments, atts.map((att) => ({ ...att, size: fs.statSync(path.join(root, att.path)).size })));
  assert.deepEqual(validateMessage(root, "", value.attachments), value, "HTTP/WS and harness validation can run twice");
  value.attachments[2].transcript = "本地转写";
  const content = userContent(root, "", value.attachments);
  assert.match(content[0].text, /语音笔记，转写：本地转写/);
  assert.deepEqual(content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: imageBytes.toString("base64") } });
});

test("file lines include readable sizes and legacy records without size remain readable", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "content-"));
  for (const [size, label] of [[0, "0 B"], [12 * 1024, "12 KB"], [1536, "1.5 KB"], [2 * 1024 * 1024, "2 MB"]]) {
    const att = upload(root, "参考.txt", Buffer.alloc(size));
    const { attachments } = validateMessage(root, "看文件", [att]);
    assert.ok(userContent(root, "看文件", attachments)[0].text.includes(`（文件，${label}，需要时自己读）`));
    assert.ok(userContent(root, "看文件", [att])[0].text.includes("（文件，需要时自己读）"));
  }
  assert.equal(userContent(root, "旧纯文本"), "旧纯文本");
});

test("forged small sizes cannot bypass existing file and image limits", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "limits-"));
  const file = upload(root, "超大.txt", Buffer.alloc(0)), image = { ...upload(root, "超大.png", Buffer.alloc(0)), kind: "image" };
  fs.truncateSync(path.join(root, file.path), 20 * 1024 * 1024 + 1);
  fs.truncateSync(path.join(root, image.path), 5 * 1024 * 1024 + 1);
  assert.throws(() => validateMessage(root, "", [{ ...file, size: 1 }]), /附件超过 20MB/);
  assert.throws(() => validateMessage(root, "", [{ ...image, size: 1 }]), /不能超过 5MB/);
});
