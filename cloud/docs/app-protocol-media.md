# 豆豆云端协议：回复里的富媒体

豆豆的回复正文仍是 Markdown。回复里引用 `data/` 下的文件时，云端在回复结束时附上结构化的 `media` 列表，客户端按类型渲染成图片预览、视频播放器、音频播放器或文件卡片。旧客户端忽略 `media`，照旧显示 Markdown 链接；新客户端连旧云端时没有 `media`，同样退回 Markdown。

## 豆豆怎么引用

交付给用户看的文件放在 `data/` 下（新文件默认放 `data/files/<YYYY-MM-DD>/`），回复里用相对路径的 Markdown 链接引用：

```markdown
![本周睡眠曲线](data/files/2026-10-13/sleep.png)
[会议录音](data/files/2026-10-13/meeting.m4a)
[演示视频](<data/files/2026-10-13/demo 1.mp4>)
```

- 图片用 `![说明](路径)`，其他文件用 `[名字](路径)`；路径里有空格时用尖括号包起来。
- 只认 `data/` 开头的相对路径；网址、`workspace/`、绝对路径都不会变成富媒体，仍按普通链接显示。

## 云端提取规则

回复结束时，云端从最终正文里按出现顺序提取链接。同一路径只出现一次，最多 20 个。满足下面全部条件的才进入 `media`：

- 路径在 `data/` 里，解析符号链接后仍在 `data/` 里，并且是普通文件；
- 文件存在；
- 不是简报 JSON（`data/briefs/**.json`）。

每一项：

```json
{"path":"data/files/2026-10-13/demo 1.mp4","name":"演示视频","kind":"video","mime":"video/mp4","size":1834201}
```

- `name`：链接文字；为空时取文件名。
- `kind`：按扩展名判断（大小写不敏感）：
  - `image`：png、jpg、jpeg、gif、webp
  - `video`：mp4、m4v、mov、webm
  - `audio`：mp3、m4a、aac、wav、ogg、opus、flac
  - `file`：其他
- `mime`：与 `/files/` 返回的 `Content-Type` 一致。
- `size`：字节数，提取时实测。

## 事件与记录

```json
{"t":"turn_end","text":"……Markdown……","media":[{"path":"…","name":"…","kind":"image","mime":"image/png","size":20311}]}
{"role":"assistant","text":"……","ts":1791580800000,"media":[ … ]}
```

- `media` 只在非空时出现；出错回合（`error`）和部分回复（`partial`）不带。
- `hello` 的 `history` 里的 assistant 记录原样带上 `media`。
- 流式 `delta` 不变。客户端在流式阶段只渲染 Markdown，`turn_end` 后再按 `media` 渲染。
- 任务记录（`GET /api/tasks/<id>/history`）里已完成任务的 `result` 条目同样带 `media`；运行中、失败或已停止的任务不带。

## 文件下载与播放：`GET /files/<路径>`

- 沿用 Bearer 或 cookie 鉴权；路径的每一段做 URL 编码。
- `Content-Type` 覆盖上面所有扩展名；未知类型返回 `application/octet-stream`。
- 支持 `Range: bytes=…`：
  - 返回 `206`，带 `Content-Range`、`Accept-Ranges: bytes` 和 `Content-Length`；
  - 范围越界返回 `416`；
  - 不带 Range 返回 `200`，带 `Accept-Ranges: bytes`。
  - 播放器拖动进度依赖这一项。
- 以流的方式发送，不把整个文件读进内存。支持 `HEAD`。
- 原有行为不变：目录取 `index.html`，简报 JSON 返回 404。

## 客户端渲染

`media` 渲染在这条回复的正文下面，按顺序排列，正文里的链接保持可点。

| kind | 呈现 | 操作 |
|---|---|---|
| image | 等比缩略预览（长边约 240pt/dp），加载中显示占位 | 点开全屏预览 |
| video | 内嵌播放器（首帧或占位、播放/暂停、进度、时长），宽度跟气泡一致 | 全屏播放；也能保存或用系统应用打开 |
| audio | 一行播放条：播放/暂停、进度、当前/总时长、文件名 | 保存或用系统应用打开 |
| file | 卡片：类型图标、文件名、大小 | HTML、Markdown、文本、PDF 在 App 内打开；其他文件下载后用系统应用打开或分享，也可另存 |

- 请求都带 Bearer 头。播放器不能带头时，先下载到缓存目录再播放本地文件。
- 平台播放不了的格式（例如 Mac 上的 webm 或 ogg）退回文件卡片。
- 文件加载失败时显示「文件不可用」，不影响正文。
