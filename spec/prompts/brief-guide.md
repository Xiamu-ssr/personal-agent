# 简报写法

- 写到 `data/briefs/<YYYY-MM-DD>/<任务名>.html`。1–6 张卡片，每张是顶层 `<section class="card">`；可以在文件开头放公共 `<style>`。
- 画板宽 360px，在 320–480px 自适应；每张卡片内容控制在 560px 内。不写固定页面宽度，不用隐藏溢出截掉文字。
- 云端注入字体、圆角、阴影、间距和组件样式，不用复制基础 CSS，也不用写 JavaScript。

配色在 section 上选 `data-palette`：默认 `silver` 银蓝 + 香槟金、`mist` 晨雾、`mint` 薄荷、`dusk` 暮光。不写就是默认。四套共用变量：`--ink` 主文字、`--muted` 次文字、`--surface` 底色、`--tile` 小卡底色、`--accent` 强调、`--accent-soft` 浅强调、`--gold` 香槟金、`--button-ink` 按钮文字。自己的样式也用这些变量。

组件直接用 class：
- `chip` 日期或主题；`title` 一句话结论；`summary` 两行内摘要。
- `timeline` 横排时间线，每项用 `when` 标时间，加短标题，最多 3 项。
- `tiles` 横排 2–3 张 `tile`；每张短标题、短描述、`tag` 标签，标签可选 `data-tone="ok|warn|info"`。
- `metrics` 横排 2–3 个 `metric`；里面 `value` 大数字、`unit` 单位、`label` 指标名、`delta` 变化。
- `list` 列表，`li` 一件事，`meta` 次要说明；`note` 灰底提示，写暂不可读的原因。
- `button` 按钮：`<button class="button" data-prompt="用户要发的话">按钮文案</button>`。只写 data-prompt，不写跳转或点击脚本。

信息层次学 Today AI：第一张总览；顶上小日期 chip，接一句话判断；下面横排时间线或小卡；末尾一个有用的按钮。后续每张一个主题。数字大、标签小，最重要的结论放上面。少写长段落，四周留足 16–20px 内边距。相邻卡片可换配色，分类清楚，不用 emoji。CSS 动画轻一点，不影响阅读。

不加载外部资源；图片只用内联 SVG 或 data URI。不开外链，不写 script、事件属性、iframe、表单。可写简单 CSS 装饰。

最小示例（替换日期和内容）：
```html
<meta name="brief-name" content="晨报">
<meta name="brief-time" content="2026-10-11T07:30:00+08:00">
<section class="card" data-palette="mint">
  <span class="chip">10月11日 周日</span>
  <h1 class="title">今天先把周报交了</h1>
  <p class="summary">下午三点前提交，上午适合收尾。</p>
  <div class="timeline"><div><span class="when">15:00</span>交周报</div></div>
  <p class="note">手机离线，日历暂不可读。</p>
  <button class="button" data-prompt="帮我把今天的事排个顺序">排一下今天的顺序</button>
</section>
```
