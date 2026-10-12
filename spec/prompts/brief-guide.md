# 简报写法

- 写到 `data/briefs/<YYYY-MM-DD>/<任务名>.html`。1–6 张卡片，每张是顶层 `<section class="card">`；可以在文件开头放公共 `<style>`。
- **一个主题一张卡片。** 综合简报（晨报、晚报）第一张总览，之后每个主题一张；单一主题（比价、调研、进度）通常只写 1 张，比较放进同一张的对比表。
- 画板宽 360px，在 320–480px 自适应。卡片高度跟内容走，App 不滚动卡片内部；每张至少一句结论，最多约 960px。不写固定宽度，不用隐藏溢出截掉文字。
- 云端注入字体、圆角、阴影、间距、组件样式和皮肤配色，不用复制基础 CSS，也不用写 JavaScript。

配色在 section 上选 `data-palette`：默认 `silver`、`mist`、`mint`、`dusk`。App 换皮肤时这些配色自动跟着变，深色皮肤下也好看，所以颜色只用变量：`--ink` 主文字、`--muted` 次文字、`--surface` 底色、`--tile` 小卡底色、`--line` 分隔线、`--accent` 强调、`--accent-soft` 浅强调、`--gold` 点缀、`--ok` `--warn` `--info` 状态色、`--button-ink` 按钮文字。不写死颜色值。

组件直接用 class：
- `chip` 顶部小字，写「分类 · 主题」，如「出行 · 国庆返程」；`title` 一句话判断；`summary` 两行内摘要。
- `dates` 日期条，横排 5–7 个 `day`：里面 `dow` 星期、`d` 日期、可选 `mark` 小标记（休、班、节气名）；今天加 `data-today`，节假日加 `data-off`，调休上班加 `data-work`。
- `tiles` 横排 2–3 个 `tile` 状态格：`label` 小标题、`value` 大数字或短词、`desc` 一行说明；状态用 `data-tone="ok|warn|info"`。
- `steps` 编号步骤，`li` 一步：一行字 + `state` chip，`data-state="done|doing|todo"`；需要时最后放 `progress`，`style="--p:60%"`。
- `compare` 对比表：`table`，第一行写选项名，每行比一项；推荐的那列在 `th` 上加 `data-pick`。最多 3 列、6 行。
- `timeline` 横排时间线，每项 `when` 标时间，最多 3 项。
- `metrics` 横排 2–3 个 `metric`：`value` 大数字、`unit`、`label`、`delta`。
- `list` 列表，`li` 一件事，`meta` 次要说明；`note` 灰底提示，写读不到的原因。
- `buttons` 按钮行，最多 2 个：`<button class="button" data-prompt="用户要发的话">文案</button>`，次要的加 `data-kind="ghost"`。只写 data-prompt，不写跳转或点击脚本。

信息层次学 Today AI：顶上分类 chip，接一句话判断，然后用一个密的组件（日期条、状态格、步骤、对比）把事实摆出来，末尾一个有用的按钮。数字大、标签小，少写长段落。能用组件就不用段落，能一张就不两张。不用 emoji。CSS 动画轻一点，不影响阅读。

写完用页面截图按手机宽度看一眼：挤了、溢出了、空了、颜色看不清就改。

不加载外部资源；图片只用内联 SVG 或 data URI。不开外链，不写 script、事件属性、iframe、表单。

最小示例（替换日期和内容）：
```html
<meta name="brief-name" content="晨报">
<meta name="brief-time" content="2026-10-12T07:30:00+08:00">
<section class="card">
  <span class="chip">10月12日 周一 · 农历九月初三</span>
  <h1 class="title">今天先把周报交了</h1>
  <div class="dates">
    <div class="day" data-today><span class="dow">一</span><span class="d">12</span></div>
    <div class="day"><span class="dow">二</span><span class="d">13</span></div>
    <div class="day" data-off><span class="dow">六</span><span class="d">17</span><span class="mark">休</span></div>
  </div>
  <div class="tiles">
    <div class="tile"><span class="label">天气</span><span class="value">18°</span><span class="desc">午后有雨，带伞</span></div>
    <div class="tile" data-tone="warn"><span class="label">截止</span><span class="value">15:00</span><span class="desc">周报</span></div>
    <div class="tile"><span class="label">跟进</span><span class="value">2 件</span><span class="desc">见下一张</span></div>
  </div>
  <div class="buttons"><button class="button" data-prompt="帮我把今天的事排个顺序">排一下今天的顺序</button></div>
</section>
```
