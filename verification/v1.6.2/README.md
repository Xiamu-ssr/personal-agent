# 1.6.2 内容交付与资源库验收

## 修改与原因

- `cloud/src/page-screenshot.mjs`、`content.mjs`、`server.mjs`：删除“另一个页面正在截图”的并发拒绝；所有消费者使用同一渲染队列，相同预览合并，页面及依赖修订后更新缓存。索引独立 HTML/文档及目录构件，样式和脚本不作为文档展示。
- `gateway-chat.mjs`、`media.mjs`、`say.mjs`、`agent.mjs`：保留原生 `agent.assistant.mediaUrls` 与结构化媒体，写入同一附件记录；实时事件、历史和下载使用同一文件。连接错误仍为失败，保留诊断日志，界面使用可理解的提示。
- Android：卡片预览固定在 132dp 区域内，按顶部截取，标题单独排版；HTML 查看页有另存和分享操作，文件 Intent 使用不带 charset 的 MIME。
- Mac：HTML 查看页复用同一文件操作；资源库和图片保持原有共享数据格式。业务提示词区分“生成”“检查”和“交付”，新增 `page.export_image`。

## 实际检查

| 范围 | 结果 |
| --- | --- |
| 云端单元/HTTP/本地浏览器检查 | 135 项通过，含六个页面并发预览、合并和依赖变更失效 |
| Android 单元检查 | 170 项通过 |
| Android 虚拟机布局 | 6 个页面 × 正常/1.4 字号，12 组；预览、标题和卡片边界实测 |
| Android MainActivity / WebView / 系统文件选择器 | 6 项流程通过；HTML 打开、交互、另存、资源库和大字号均实际操作 |
| Mac 核心断言 | 223 项通过；原生附件布局与登录检查通过 |
| Mac 原生界面 | 资源库预览、HTML WebKit 查看、下载字节一致性通过 |
| 真实 OpenClaw 2026.10.4 | 本地模型 5 次请求完成页面导出、图片/HTML 卡片和原生 MEDIA 交付；认证下载通过 |
| 安装包 | Android 正式签名，与前版证书一致；Mac arm64+x86_64、严格签名与 DMG 校验通过 |

云端接口使用产品的真实实现；所有本地文件、模型和账号均为合成数据。验收主机位于 HTTP loopback `/`，Cookie 的 Secure 与 `/agent` 属性只在本地代理边界调整；生产 HTTPS Cookie 行为未改动。模拟器结果不宣称为 OPPO 真机验收。Mac DMG 未经 Apple 公证。

`android-content.json`、`mac-content.json`、`native-delivery.json`、`checks.json` 和 `assets.json` 记录对应结果；截图全部为合成页面。生产部署结果另记，不将本地 UI 检查当作线上验收。
