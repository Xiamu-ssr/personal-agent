# 豆豆说话与富媒体协议

当前 0.8 协议见 [v08-cloud.md](v08-cloud.md#say模型对用户说话)。媒体卡片由 `mcp__doudou__say` 发出，普通 Markdown 链接仍提取为 media。客户端用 say 的消息 id 完成气泡，turn_end 只处理轮次结束。

新交付路径为 `data/library/media/YYYY-MM-DD/`。文件下载、Range 播放、附件和 MIME 字段见完整协议；旧路径只做一次启动迁移，不提供别名。
