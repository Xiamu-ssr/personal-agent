import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { replyMedia, fileType } from "../src/media.mjs";
import { Harness } from "../src/agent.mjs";
import { TaskHistory } from "../src/task-history.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { startServer } from "../src/server.mjs";
import { config } from "../src/config.mjs";
import { tailJsonl } from "../src/store.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { nativeHarness, hasInput, resultFor, textReply } from "./native-fixture.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(testRoot, "media-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, rel, body = "fixture") {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
async function serve(t, { harness = { busy: false, connectors: new ConnectorManager() }, hub = new DeviceHub(), bus = { on() {} } } = {}) {
  const server = startServer({ harness, hub, bus, log() {}, listen: { host: "127.0.0.1", port: 0 } });
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return "http://127.0.0.1:" + server.address().port;
}
const auth = { Authorization: "Bearer " + config.token };
const fileUrl = (rel) => "/files/" + rel.split("/").map(encodeURIComponent).join("/");

test("reply media uses case-insensitive extensions, matching MIME, measured size, link names and filename fallback", (t) => {
  const root = fixture(t);
  const types = [
    ["PNG", "image", "image/png"], ["jpg", "image", "image/jpeg"], ["jpeg", "image", "image/jpeg"],
    ["gif", "image", "image/gif"], ["webp", "image", "image/webp"],
    ["mp4", "video", "video/mp4"], ["m4v", "video", "video/x-m4v"], ["mov", "video", "video/quicktime"], ["webm", "video", "video/webm"],
    ["mp3", "audio", "audio/mpeg"], ["m4a", "audio", "audio/mp4"], ["aac", "audio", "audio/aac"], ["wav", "audio", "audio/wav"],
    ["ogg", "audio", "audio/ogg"], ["opus", "audio", "audio/ogg"], ["flac", "audio", "audio/flac"],
    ["pdf", "file", "application/pdf"], ["txt", "file", "text/plain; charset=utf-8"],
    ["svg", "file", "image/svg+xml"], ["unknown", "file", "application/octet-stream"],
  ];
  const expected = types.map(([ext, kind, mime], i) => {
    const rel = `data/library/media/2026-10-13/文件${i}.${ext}`, name = i ? `说明${i}` : path.basename(rel);
    put(root, rel, "测量字节" + i);
    assert.deepEqual(fileType(rel), { kind, mime });
    return { path: rel, name, kind, mime, size: Buffer.byteLength("测量字节" + i) };
  });
  const text = expected.map((m, i) => `${i % 2 ? "" : "!"}[${i ? m.name : ""}](${m.path})`).join("\n");
  assert.deepEqual(replyMedia(root, text), expected);
  assert.deepEqual(replyMedia(root, null), []);
});

test("reply media decodes spaces and Chinese, accepts angle paths, balanced parentheses and titles, and deduplicates normalized paths", (t) => {
  const root = fixture(t), first = "data/library/media/中文 演示.mp4", second = "data/library/media/demo(1).pdf", third = "data/library/media/图片.png";
  for (const rel of [first, second, third]) put(root, rel);
  const text = `[演示](<${first}>)\n[重复](${first.split("/").map(encodeURIComponent).join("/")})\n` +
    `[又一次](<data/library/media/./中文 演示.mp4>)\n[参数\\] [一]](${second} "可选标题")\n` +
    `[重复参数](data/library/media/demo\\(1\\).pdf)\n![ ](${encodeURIComponent(third)})`;
  const media = replyMedia(root, text);
  assert.deepEqual(media.map((m) => [m.path, m.name]), [[first, "演示"], [second, "参数] [一]"], [third, "图片.png"]]);
  assert.equal(replyMedia(root, `\\[不是链接](${third})`).length, 0);
});

test("reply media ignores fenced and indented blocks and inline code with matching backtick runs", (t) => {
  const root = fixture(t), rel = "data/library/media/code.png", visible = "data/library/media/visible.png";
  put(root, rel); put(root, visible);
  const link = `![代码里的链接](${rel})`;
  const text = ["```markdown", link, "```", "~~~", link, "~~~", "````", "```", link, "````", "> ```", "> " + link, "> ```",
    "    " + link, "\t" + link, "`" + link + "`", "``里面有 ` " + link + "``",
    "前 `" + link + "` 后 [可见](" + visible + ")", "```未闭合", link].join("\n");
  assert.deepEqual(replyMedia(root, text).map((m) => m.path), [visible]);
  assert.deepEqual(replyMedia(root, "未配对的 ` 后 [可见](" + visible + ")").map((m) => m.path), [visible]);
});

test("reply media keeps links in nested list paragraphs while ignoring code blocks inside lists", (t) => {
  const root = fixture(t), visible = "data/library/media/list.mp4", hidden = "data/library/media/list-code.mp4";
  put(root, visible); put(root, hidden);
  const text = ["- 视频", "    [演示](" + visible + ")", "    - 子列表", "        [重复](" + visible + ")",
    "    ```markdown", "    [代码](" + hidden + ")", "    ```", "", "      [缩进代码](" + hidden + ")",
    "普通段落结束列表。", "    - [代码里的列表](" + hidden + ")"].join("\n");
  assert.deepEqual(replyMedia(root, text).map((m) => m.path), [visible]);
});

test("reply media excludes missing files, traversal, absolute and workspace links, directories and symlink escapes", (t) => {
  const root = fixture(t), safe = "data/library/media/safe.png", json = "data/library/media/ordinary.json";
  put(root, safe); put(root, json, "{}");
  const outside = put(root, "workspace/outside.png"), directory = path.join(root, "data/library/media/folder");
  fs.mkdirSync(directory);
  fs.symlinkSync(outside, path.join(root, "data/library/media/escape.png"));
  fs.symlinkSync(path.dirname(outside), path.join(root, "data/library/media/escape-dir"));
  fs.symlinkSync(path.join(root, safe), path.join(root, "data/library/media/inside.png"));
  const invalid = ["data/library/media/missing.png", "data/library/media/../files/safe.png", "data/library/media/%2e%2e/files/safe.png",
    "data/../workspace/outside.png", "data/%2e%2e%2fworkspace/outside.png", "data/library/media/..\\..\\workspace/outside.png",
    path.join(root, safe), "workspace/outside.png", "https://example.test/data/library/media/safe.png", "file://" + path.join(root, safe),
    "/data/library/media/safe.png", "data/library/media/folder", "data/library/media/escape.png", "data/library/media/escape-dir/outside.png",
    "data/library/media/%E0.png", "data/library/media/safe.png%00"];
  assert.deepEqual(replyMedia(root, invalid.map((p) => `[无效](<${p}>)`).join("\n")), []);
  assert.deepEqual(replyMedia(root, `[JSON](${json}) ![安全别名](data/library/media/inside.png)`).map((m) => m.path), [json, "data/library/media/inside.png"]);
});

test("reply media preserves appearance order and caps valid unique files at twenty", (t) => {
  const root = fixture(t), paths = Array.from({ length: 23 }, (_, i) => `data/library/media/${i}.png`);
  for (const rel of paths) put(root, rel);
  const text = paths.map((p) => `[不存在](data/missing.png) ![首次](${p}) [重复](${p})`).join("\n");
  const media = replyMedia(root, text);
  assert.deepEqual(media.map((m) => m.path), paths.slice(0, 20));
  assert.ok(media.every((m) => m.name === "首次"));
});

test("files stream audio/video with MIME, full/open/suffix ranges, 416, HEAD and bearer/cookie auth", async (t) => {
  const base = await serve(t), dir = "data/library/media/http-media", video = `${dir}/演示 1.mp4`, audio = `${dir}/录音.mp3`;
  const bytes = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  put(config.root, video, bytes); put(config.root, audio, bytes); put(config.root, `${dir}/empty.mp4`, "");
  const readFile = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    assert.ok(!String(file).includes("http-media"), "file downloads must not buffer the whole file with readFileSync");
    return readFile(file, ...args);
  });
  const request = (rel, options = {}) => fetch(base + fileUrl(rel), { ...options, headers: { ...auth, ...options.headers } });
  for (const [rel, mime] of [[video, "video/mp4"], [audio, "audio/mpeg"]]) {
    const res = await request(rel);
    assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), mime);
    assert.equal(res.headers.get("accept-ranges"), "bytes"); assert.equal(res.headers.get("content-length"), "512");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  }
  for (const [range, start, end] of [["bytes=10-29", 10, 29], ["bytes=500-", 500, 511], ["bytes=-100", 412, 511],
    ["bytes=500-999", 500, 511], ["bytes=-999", 0, 511]]) {
    const res = await request(video, { headers: { Range: range } });
    assert.equal(res.status, 206); assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-range"), `bytes ${start}-${end}/512`);
    assert.equal(res.headers.get("content-length"), String(end - start + 1)); assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  for (const range of ["bytes=512-", "bytes=30-10", "bytes=-0", "bytes=", "bytes=0-1,3-4", "items=0-10", "bytes=9007199254740993-"]) {
    const res = await request(audio, { headers: { Range: range } });
    assert.equal(res.status, 416, range); assert.equal(res.headers.get("content-range"), "bytes */512");
    assert.equal(res.headers.get("accept-ranges"), "bytes"); assert.equal((await res.arrayBuffer()).byteLength, 0);
  }
  const empty = await request(`${dir}/empty.mp4`);
  assert.equal(empty.status, 200); assert.equal(empty.headers.get("content-length"), "0"); await empty.arrayBuffer();
  const emptyRange = await request(`${dir}/empty.mp4`, { headers: { Range: "bytes=-100" } });
  assert.equal(emptyRange.status, 416); assert.equal(emptyRange.headers.get("content-range"), "bytes */0"); await emptyRange.arrayBuffer();
  for (const headers of [{}, { Range: "bytes=10-29" }]) {
    const res = await request(video, { method: "HEAD", headers });
    assert.equal(res.status, headers.Range ? 206 : 200); assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-length"), headers.Range ? "20" : "512");
    assert.equal(res.headers.get("accept-ranges"), "bytes"); assert.equal((await res.arrayBuffer()).byteLength, 0);
  }
  const unauthorized = await fetch(base + fileUrl(video));
  assert.equal(unauthorized.status, 401); await unauthorized.arrayBuffer();
  const cookie = await fetch(base + fileUrl(audio), { headers: { Cookie: "pa_token=" + encodeURIComponent(config.token) } });
  assert.equal(cookie.status, 200); assert.deepEqual(Buffer.from(await cookie.arrayBuffer()), bytes);
});

test("files serve directory indexes and reject outside-data paths and symlink escapes", async (t) => {
  const base = await serve(t), index = "data/library/artifacts/media-fixture/index.html";
  put(config.root, index, "<title>站点</title>");
  const outside = put(config.root, "workspace/media-http.txt", "private fixture");
  fs.symlinkSync(outside, path.join(config.data, "media-http-escape.txt"));
  const request = (p, options = {}) => fetch(base + p, { ...options, headers: auth });
  const site = await request(fileUrl("data/library/artifacts/media-fixture"));
  assert.equal(site.status, 200); assert.equal(site.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await site.text(), "<title>站点</title>");
  const head = await request(fileUrl("data/library/artifacts/media-fixture"), { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(Buffer.byteLength("<title>站点</title>")));
  assert.equal(await head.text(), "");
  for (const [route, status] of [[fileUrl("workspace/media-http.txt"), 400], ["/files/data%2F..%2Fworkspace%2Fmedia-http.txt", 400],
    [fileUrl("data/media-http-escape.txt"), 400], [fileUrl("data/missing.mp4"), 404], ["/files/data/%E0.mp4", 400]]) {
    const res = await request(route); assert.equal(res.status, status, route); await res.arrayBuffer();
  }
});

test("real SDK reply sends media in turn_end and chat/hello, leaves deltas unchanged and preserves early prose bubbles when a later tool round fails", { timeout: 45_000 }, async (t) => {
  const rel = "data/library/media/native-media.png", text = `MEDIA_REPLY：![图片](${rel})`;
  put(config.root, rel, "image fixture");
  let contextFailed = false;
  const api = await fakeAnthropic((body) => {
    if (contextFailed) return { error: "Prompt is too long" };
    if (hasInput(body, "MEDIA_PARTIAL")) {
      if (!resultFor(body, "media-read")) return { stop_reason: "tool_use", content: [{ type: "text", text },
        { type: "tool_use", id: "media-read", name: "Read", input: { file_path: rel } }] };
      contextFailed = true;
      return { error: "Prompt is too long" };
    }
    if (hasInput(body, "MEDIA_ERROR")) return { error: "fictional media fixture failure" };
    if (hasInput(body, "MEDIA_EMPTY")) return textReply("没有附件的回复");
    return textReply(text);
  });
  const runtime = nativeHarness(t, api), { harness, events, until } = runtime;
  const base = await serve(t, runtime);
  await harness.send("MEDIA_SUCCESS");
  await until(() => events.some((e) => e.t === "turn_end" && e.text === text) && !harness.busy);
  const expected = replyMedia(config.root, text), event = events.find((e) => e.t === "turn_end" && e.text === text);
  assert.deepEqual(event.media, expected); assert.equal(event.error, undefined);
  assert.deepEqual(tailJsonl(config.chatLog, 100).find((r) => r.role === "assistant" && r.text === text).media, expected);
  assert.ok(events.some((e) => e.t === "delta")); assert.ok(events.filter((e) => e.t === "delta").every((e) => !("media" in e)));
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: auth });
  t.after(() => ws.terminate());
  const received = [], helloPromise = new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw))));
  ws.on("message", (raw) => received.push(JSON.parse(raw)));
  const hello = await helloPromise;
  assert.equal(hello.t, "hello"); assert.deepEqual(hello.history.find((r) => r.text === text).media, expected);
  for (const [prompt, error] of [["MEDIA_EMPTY", false], ["MEDIA_ERROR", true], ["MEDIA_PARTIAL", true]]) {
    const before = events.filter((e) => e.t === "turn_end").length;
    await harness.send(prompt);
    await until(() => events.filter((e) => e.t === "turn_end").length > before && !harness.busy);
    const end = events.findLast((e) => e.t === "turn_end");
    assert.equal(Boolean(end.error), error, prompt + ": " + JSON.stringify(end)); assert.equal("media" in end, false);
    assert.equal("media" in tailJsonl(config.chatLog, 100).findLast((r) => r.role === "assistant"), false);
  }
  assert.equal(tailJsonl(config.chatLog, 100).filter((r) => r.role === "assistant" && r.text === text && r.media?.length).length, 2);
  assert.equal(tailJsonl(config.chatLog, 100).some((r) => r.partial), false);
  await until(() => received.filter((e) => e.t === "turn_end").length === 3);
  assert.ok(received.filter((e) => e.t === "turn_end").every((e) => !("media" in e)));
  await harness.inputChain;
});

test("completed task transcript results and latest-result fallback get media; running, failed and stopped tasks omit it", (t) => {
  const root = fixture(t), rel = "data/library/media/task.mp3", text = `[录音](${rel})`, sessions = path.join(root, "system/sessions");
  put(root, rel, "audio fixture");
  const history = new TaskHistory({ root, sessions, redact: (s) => s });
  history.put("media-task", { kind: "subagent", sessionId: "media-session", status: "done", title: "媒体任务", startedAt: 1 });
  const file = path.join(sessions, "projects/fixture/media-session/subagents/agent-media-task.jsonl");
  put(root, path.relative(root, file), [
    { type: "user", uuid: "1", timestamp: "2026-10-13T00:00:00Z", message: { content: text } },
    { type: "assistant", uuid: "2", timestamp: "2026-10-13T00:01:00Z", message: { content: [{ type: "text", text }] } },
  ].map((r) => JSON.stringify(r)).join("\n"));
  assert.deepEqual(history.history("media-task").items.findLast((i) => i.kind === "result").media, replyMedia(root, text));
  assert.ok(history.history("media-task").items.filter((i) => i.kind === "prompt").every((i) => !("media" in i)));
  for (const status of ["running", "error", "stopped"]) {
    history.put("media-task", { status }); assert.ok(history.history("media-task").items.every((i) => !("media" in i)));
  }
  history.put("fallback-task", { kind: "isolated", title: "回退结果", status: "done", latestResult: text, startedAt: 1 });
  assert.deepEqual(history.history("fallback-task").items.findLast((i) => i.kind === "result").media, replyMedia(root, text));
});

test("real isolated task and continuation expose their final media under the same task id", { timeout: 30_000 }, async (t) => {
  const original = "data/library/media/isolated-original.pdf", continued = "data/library/media/isolated-continued.mp4";
  put(config.root, original); put(config.root, continued);
  const api = await fakeAnthropic((body) => textReply(hasInput(body, "MEDIA_CONTINUE") ? `[续聊视频](${continued})` : `[原文档](${original})`));
  t.after(() => api.close());
  const harness = new Harness({ hub: new DeviceHub(), bus: { emit() {} }, log() {},
    queryFactory: ({ prompt, options }) => query({ prompt, options: { ...options, systemPrompt: "Local media fixture.",
      settingSources: [], agentProgressSummaries: false, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-local-media-only", ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CONFIG_DIR: config.sessions, CLAUDE_CODE_TMPDIR: path.join(config.root, "native-tmp"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" } } }) });
  await harness.runIsolated("媒体任务", "MEDIA_ORIGINAL", { id: "media-isolated" });
  assert.deepEqual(harness.taskHistory("media-isolated").items.findLast((i) => i.kind === "result").media.map((m) => m.path), [original]);
  await harness.sendTask("media-isolated", "MEDIA_CONTINUE"); await harness.jobChain;
  const history = harness.taskHistory("media-isolated");
  assert.equal(history.id, "media-isolated"); assert.equal(history.status, "done");
  assert.deepEqual(history.items.findLast((i) => i.kind === "result").media.map((m) => m.path), [continued]);
});
