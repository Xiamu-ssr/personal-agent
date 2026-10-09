# 豆豆 App v2 · 安卓与 Mac 共用的产品规格

安卓和 Mac 是**同一个产品的两种布局**：页面、功能、文案都一样，Mac 只是把底部导航换成左侧栏、把单列换成更宽的排版。谁都不比谁多页面。两端唯一不同的是**本机能力**（短信只有安卓有，快捷指令只有 Mac 有），这是由设备决定的，在「连接应用 → 本机」里体现。

视觉参考：`today-ai-metal-ui-20261008/v4-html`（银蓝金属 + 香槟金，GPT 根据 Today AI 和王者万象棋画的）。参考里的示例数据（会议、PDF、企业微信……）不要照抄，一律换成真实数据或空状态。

---

## 一、云端接口（已上线）

所有请求 `Authorization: Bearer <token>`，基址是用户填的云端地址（默认 `https://127.0.0.1/agent`）。

| 接口 | 说明 |
|---|---|
| `POST /api/pair` `{code}` → `{token}` | 6 位配对码换口令，不需要 token |
| `POST /api/pair/new` → `{code}` | 已登录设备生成新配对码（顶掉旧码） |
| `GET /api/state` → `{busy, devices, model, schedule, firstChat}` | 登录校验也用它；`firstChat` = 第一条聊天记录的毫秒时间戳（没有为 null），豆豆页算「N 天前」用 |
| `GET /api/history?n=200` → `{items}` | 聊天记录，见下 |
| `GET /api/connectors` | 连接应用和设备页的数据，见下 |
| `GET /api/jobs` → `{running:[{label,started}], recent:[card…]}` | 任务页 |
| `GET /api/skills` → `{skills:[{name,description}]}` | 技能页 |
| `GET /api/tree?dir=data/xxx` → `{entries:[{name,dir,size,mtime}]}` | 列 data/ 下的目录，按修改时间倒序 |
| `GET /files/<data 下路径>` | 读文件；目录返回 index.html。路径每段要 URL 编码 |
| `POST /api/upload?name=<文件名>`（原始字节，≤20MB）→ `{path,name,size}` | 存到 `data/uploads/<日期>/` |
| `POST /api/transcribe?format=aac\|wav\|m4a\|mp3`（原始音频，≤10MB）→ `{text}` | 按住说话用，不存档 |
| `POST /api/run {id}` | 立即跑一个定时任务 |

**WebSocket** `wss://<地址>/ws?role=app` 或 `role=device`，同样带 Bearer 头。

`role=app` 收到的事件：
- `hello {busy, devices, history}`
- `user {text, attachments?}`：任何端发的用户消息（自己发的也会回显，按文本去重）
- `status {busy}`、`delta {text}`（流式）、`tool {name, hint}`、`turn_end {text, error?}`
- `memory_updated {path}`、`files_changed {path}`、`devices {devices}`
- `job {phase:"started"|"done", label, title?, outputs?}`、`task {phase,id,description,summary}`

`role=app` 发：`{t:"send", text, attachments?:[{path,name,kind}]}`（kind = image | file | voice），`{t:"interrupt"}`。

**聊天记录条目**：`{role:"user", text, attachments?:[{path,name,kind,transcript?}]}`、`{role:"assistant", text}`、`{role:"card", label, title, outputs:[path]}`。

`role=device`：
- 连上后发 `{t:"register", device:{id, name, kind:"android"|"mac", capabilities:[…]}}`。**capabilities 要列出本机全部能力**，每项 `{name, title, description, args, sync, source, enabled, hint?}`，`enabled` 是用户有没有打开。agent 只看得到 enabled 的。开关变化后重连重新注册。
- 收 `{t:"call", id, capability, args}` → 回 `{t:"result", id, ok, data | error}`；`capability:"__read_since"` 是补读（args `{source, cursor, limit}` → `{items, next_cursor, more}`）。
- 收 `{t:"event", kind:"reply"|"job", text}`：App 不在前台时弹系统通知（设置里「接收消息通知」可关）。

**`GET /api/connectors`**：
```json
{
  "cloud": {
    "id": "cloud", "name": "云电脑", "kind": "cloud", "online": true,
    "builtin":   [{"name":"web_search","title":"网页搜索","description":"…","status":"on"}, …],
    "installed": [{"name":"…","title":"…","description":"…","status":"on"}],
    "catalog":   [{"name":"email","title":"邮箱","description":"…","status":"off"}, …]
  },
  "devices": [
    {"id":"android-xxxx","name":"HONOR PPG-AN00","kind":"android","online":true,"lastSeen":1791…,
     "capabilities":[{"name":"sms","title":"短信","description":"…","enabled":true}, …]}
  ]
}
```

---

## 二、概念：设备 = 连接器的宿主

- 一台设备（本机、云电脑、其他手机/电脑）提供一组能力，就像一个连接器带一组工具。
- **本机**的能力在本机开关（要系统权限的先申请）。
- **云端**是云电脑：内置能力（搜索、命令行……）常开；`catalog` 里是还没接的云端连接器。连接器代码随版本发布，点「连接」打开连接器详情页填表单（多账号），详见 `connectors.md`（v0.3 起取代原来的「发一句聊天让豆豆自己装」）。
- **其他设备**只读展示：每台设备一组，列出能力和状态（已开启 / 未开启），说明「去那台设备上开关」。离线的设备灰显并写「离线 · 上次在线 N 分钟前」。
- **设备页**列出全部设备（本机置顶、云电脑、其他设备，带在线状态）；点一台设备 → 打开连接应用页并选中对应标签（本机 / 云端 / 其他设备并滚到那台）。底部「连接更多设备」：连接 Mac / 连接安卓手机，点开说明「在那台设备上装豆豆，用设置里的配对码登录」，并给出「生成配对码」按钮和 Releases 下载地址 `https://github.com/Xiamu-ssr/personal-agent/releases`。

---

## 三、页面

一级导航 5 个：**聊天 · 今日 · 任务 · 记忆 · 豆豆**。聊天、今日、任务、记忆四页底部都有同一个输入框（在非聊天页发消息会切到聊天页）。右上角：聊天页是搜索 + 设置，其他页是设置。

1. **登录**（未登录时唯一页面，替代原来的「连接」）
   - 标题「登录豆豆」，副标题「你的个人 agent，住在你自己的云主机上」。
   - 「账号」= 云端地址（预填默认值）。「密码」= 配对码或口令：输入恰好 6 位数字就当配对码走 `/api/pair`，否则当口令直接校验 `/api/state`。密码框是密码样式。
   - 按钮「登录」。错误提示用服务端返回的 error 文案。下方小字「没有密码？在已登录的设备上：设置 → 生成配对码」。
   - 登录成功后（仅首次）进入「开通本机能力」引导：列出本机能力开关，按钮「开始使用」。
2. **聊天**：顶部左侧豆豆头像胶囊（显示在线状态小点 + 「在线 · 本机已接入」这类状态，忙的时候显示工具提示「在翻资料」），右侧搜索、设置。
   - 气泡：用户右侧浅蓝灰，豆豆左侧白卡片（Markdown：标题、列表、粗体、行内代码、表格至少能读）。附件在气泡里显示：图片缩略图（点开大图）、文件行（图标 + 文件名，点开用 WebView/系统打开）、语音笔记（播放条 + 转写文字）。
   - 卡片消息（简报等）：白卡 + 文件图标 + 标题，点开 WebView。
   - 子任务/后台任务进度：聊天顶部下方一条可收起的细条。
   - 搜索：在本地已加载的聊天记录里搜关键词，结果点击滚动定位。
3. **输入框**（所有带输入框的页一致）：
   - 左「＋」：弹出菜单 **上传文件 / 拍照 / 图片 / 录制语音笔记**。选完后附件以小卡片排在输入框上方（可删），和文字一起发送。图片发送前压到长边 ≤1600px 的 JPEG。
   - 中间：文本输入（多行，最多 5 行）。
   - 右：麦克风图标 ↔ 发送按钮（有文字或附件时变发送；豆豆在忙时变停止）。点麦克风 → 输入框中间变成「按住 说话」大按钮；按住录音，显示录音浮层（波形/计时，「松开发送 · 上滑取消」）；松开 → `/api/transcribe` → 把文字作为一条消息直接发出。再点键盘图标切回打字。
   - 录制语音笔记：浮层「正在录音 00:12」+ 完成/取消；完成后上传为 voice 附件直接发送（不用打字，云端会转写并交给豆豆）。
4. **今日**：大标题「今日」+ 日期星期。
   - 「最新简报」卡：今天最新一份简报（`data/briefs/<今天>/`）的标题和时间，点开 WebView；没有就写「今天还没有简报 · 晨报 7:30」。
   - 「今天的简报」列表（如果有多份）和「最近」（前几天的，按天分组，最多 7 天）。
   - 「站点」：`data/sites/` 下每个站点一行（名字 + 更新时间），点开 WebView。
5. **任务**：大标题「任务」，分段 **进行中 · 已完成 · 定时**。
   - 进行中：`/api/jobs.running` + WS 里的 job started / task 事件（用标签 + 已运行时长）。空状态「现在没有在跑的任务」。
   - 已完成：`/api/jobs.recent`，标题、时间、成功/出错；有产出的点开 WebView。
   - 定时：schedule 里每个任务（名称、cron 翻成人话如「每天 7:30」「每周日 20:00」），右侧「立即运行」。kind=compact/cleanup 的显示为系统任务、不给运行按钮。
   - 「为你推荐」段：几个可以加的定时任务（每日新闻速览、每周开销小结、生日提醒），点一下 = 在聊天里发「帮我加一个定时任务：…」。
   - **注意**：任务列表要以服务端为准，App 重进后不能残留已结束的任务（Today AI 有这个 bug）。
6. **记忆**：大标题「记忆」，「我对你的了解」。
   - 顶部总档卡（`data/memory/profile/总档.md` 的内容，Markdown 渲染；把行尾的 `→ xxx/yyy.md` 指针渲染成可点的小标签，而不是原样显示路径）。
   - 分类网格（两列卡片，图标 + 中文名 + N 项），只显示有文件的分类，顺序：工作、项目、生活、健康、人际、偏好、兴趣、财务、反馈、历史、自动化偏好、语音笔记、角色。分类目录名 → 中文名：work 工作、project 项目、life 生活、health 健康、people 人际、preferences 偏好、interests 兴趣、finance 财务、feedback 反馈、history 历史、automation-prefs 自动化偏好、voice-notes 语音笔记、role 角色。
   - 点分类 → 文件列表 → 文件详情（Markdown）。
7. **豆豆**（主页）：大的银色头像（球体/豆子）、名字「豆豆」、一句话「从 N 天前第一次对话开始，慢慢了解你」（N 从 `/api/state.firstChat` 算，为 null 就不显示 N；不要为此拉全量历史）。
   - 「最近的日记」横向卡片（`data/diary/*.md`，日期 + 第一行标题 + 摘要），「查看所有日记」进列表。点开日记详情（Markdown）。没有日记就「豆豆每晚 22:30 写一篇日记」。
   - 「豆豆的设定」一行：打开 `data/memory/role/角色.md`。
8. **设置**：豆豆头像 + 「豆豆 · Personal Agent」。
   - 模型：只读显示当前模型（`/api/state.model`，去掉 `anthropic/` 前缀）。
   - 能力与连接：连接应用、设备、技能。
   - 通知：接收消息通知（开关，存本地）。
   - 账号：云端地址（只读）、生成配对码（显示 6 位码 + 「24 小时内有效，只能用一次，会顶掉之前没用的码」）、退出登录（清 token 回登录页）。
   - 版本号。
9. **连接应用**：标题「连接应用」，副标题「连接设备和服务，豆豆就能替你做更多事」。标签胶囊 **本机 · N / 云端 · N / 其他设备 · N**（N = 能力/连接器数）。
   - 本机：本机能力列表，每行图标 + 名称 + 一行说明 + 开关（申请系统权限，拒绝了就提示）。
   - 云端：「已接入」= builtin + installed（金色「已连接」胶囊）；「可以接入」= catalog（「连接」按钮）；已接入的预置连接器和「连接」都进入连接器详情页，自建连接器标「豆豆自建」只读，见 `connectors.md` 第五节。顶部搜索框过滤。
   - 其他设备：按设备分组，见第二节。
10. **设备**：见第二节。
11. **技能**：`/api/skills` 列表；空状态「豆豆把常做的事整理成技能后会出现在这里」。

---

## 四、视觉

- 背景：银蓝渐变，顶部 `#C9D3DF` → 中部 `#E5E9EE` → 底部 `#EEF1F4`（参考的 `--canvas:#e5e9ee`）。
- 卡片：`rgba(251,252,254,0.84)` 白，圆角 22–24，极淡阴影（`0 12 35 rgba(37,55,81,0.055)`）和 1px 白色描边。行内分隔线 `rgba(117,137,160,0.12)`。
- 文字：主色 `#252E38`，次要 `#728093` / `#8F99A6`。大标题 30sp 粗体（「今日」「任务」「记忆」），页内小节标题 15sp 中粗。
- 强调色：香槟金金属渐变（145°：`#FFFBED` → `#F3DFB0` → `#E2C88E` → `#EAD299` → `#9C7440`），金字 `#6C4A25`。用在：底部导航选中项的图标底座（圆角胶囊）、分段/标签胶囊的选中态、「已连接」胶囊、主按钮。
- 底部导航：白色半透明圆角浮条（圆角 26，左右留边），图标 + 两字标签；未选中图标各自有冷色调（聊天 `#487FA6`、今日 `#527AAA`、任务 `#3F7F87`、记忆 `#776AA3`、豆豆 `#637DA0`），选中变金色底座 + 金字 + 下方 20px 金色短线。
- 输入框：白色圆角胶囊（高 48，圆角 24），左「＋」右麦克风，占位文字 `#8F99A6`，在导航条上方，两者在同一个白色浮层卡片里（参考图就是这样）。
- 记忆分类色：工作 `#417DAC`、项目 `#428B94`、偏好 `#7E6BA5`、人际 `#597AC0`、生活 `#9F7E51`、兴趣 `#A06C8E`、健康 `#C36577`，其余用 `#4E79A3`。图标放在浅色圆角方块里。
- 头像：银色金属球（径向渐变 `#FFFFFF` → `#DCE6F2` → `#AFC0D3`，加高光）。App 图标可以继续用豆子，但底色改成银蓝渐变 + 金色豆子轮廓更贴风格（可选）。
- 不用 emoji；图标用系统图标集（安卓 Material Icons Outlined/Rounded，Mac SF Symbols）。
- 只做浅色主题。

---

## 五、本机能力

两端能力名尽量一致，参数说明写给模型看（中文）。

| 能力 | 安卓 | Mac |
|---|---|---|
| battery 电量 | ✓ | ✓ |
| notify 发通知 | ✓ | ✓ |
| location 位置 | ✓ | ✓ CoreLocation（可选，做不了就不列） |
| calendar_events 日历 | ✓ | ✓ EventKit，参数同安卓 `{from, days}` |
| sms 短信 | ✓ 支持分页（见下）和补读 | — |
| clipboard_read / clipboard_write 剪贴板 | 只做 write（安卓后台读不到剪贴板） | ✓ |
| open_url 打开网页 | ✓ 发一条可点击的通知，点开浏览器（后台不能直接拉起页面） | ✓ |
| frontmost_app 当前应用 | — | ✓ |
| shortcuts 快捷指令 | — | ✓ |
| folder 授权文件夹 | — | ✓ |

**短信分页**（修复「只能读 200 条」）：`sms` 参数 `{"limit":"条数，默认50，最多500","before":"可选，取这个短信 id 之前的（翻更早的）","query":"可选，按内容或号码过滤","from_date":"可选 YYYY-MM-DD","to_date":"可选 YYYY-MM-DD"}`，返回 `{"items":[…], "next_before": id 或 null, "total_in_range": N}`。描述里写清「一次最多 500 条，要更早的就用 next_before 继续翻」。

---

## 六、交付

- 安卓：`android/`，版本 0.2.0（versionCode 3），`./gradlew assembleRelease`，签名配置不变。
- Mac：`mac/`，版本 0.2.0，`VERSION=0.2.0 bash mac/build.sh`。Mac 改成普通窗口应用（有 Dock 图标、主窗口），同时保留菜单栏小气泡（快速聊天）。
