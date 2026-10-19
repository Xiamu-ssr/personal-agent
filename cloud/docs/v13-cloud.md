# 1.3 内容引用与活动协议

协议版本：`X-Doudou-Protocol: 2`。APK、DMG 和 cloud 同时升级，旧版本返回 426。

`POST /api/send`：`{clientId,text,attachments,quote?}`，仍以 clientId 去重。

- 动态引用：`quote: {kind:"feed",path}`。
- 点子引用：`quote: {kind:"idea",id,revision}`。换批后旧引用返回 409，草稿保留。
- 引用允许空 text；点选本身不请求发送。服务端读取真实内容，生成模型上下文及完整引用快照，UI 历史只显示引用和用户附言。点子快照在换批后仍可查看。
- `POST /api/feed/feedback` 仅接受 like/dislike。删除 `/api/ideas/click`；讨论不再走 feedback。

活动详情 `items[].kind` 为 prompt、text、tool、tool_result、result；time 为 ISO 时间或毫秒时间戳。工具结果是独立的可展开记录。运行中的列表使用 started，已结束列表使用 ts。

内容路径与会话分工见 [部署说明](../../docs/deployment.md#数据与维护)。
