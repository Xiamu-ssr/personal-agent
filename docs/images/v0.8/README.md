# 豆豆 0.8 展示素材

界面截图来自 2026-10-15 的 0.8 第二轮验收：Android 使用模拟器，Mac 使用本地隔离验收实例。页面中的名字、消息、目标、链接和动态均为演示内容，不是用户的真实账号或生产数据。

| 文件 | 内容 |
| --- | --- |
| `phone-chat.png` | 首次聊天、选择卡片与连接应用 |
| `phone-feed.png`、`phone-feed-dark.png` | 浅色与深色动态 |
| `phone-ideas.png`、`phone-goals.png`、`phone-library.png` | 点子、目标、资源库 |
| `mac-feed.png` | Mac 动态与侧栏 |
| `mac-side-chat.png` | Mac 独立旁聊与选择卡片 |
| `mascot.png` | 项目现有的芽豆形象，来自 `design/mascot/states/idle/still.png` |
| `hero-background.png` | 以项目芽豆为参考，由内置 imagegen 生成的无文字插画底图 |
| `hero.jpg` | 插画底图与真实字体合成的 2400 × 1350 首图 |
| `render-hero.py` | 使用 Pillow 排版标题、正文、版本与平台名称 |
| `hero-prompt.txt` | 底图的完整生成提示词 |

单张界面截图保留原始像素。首图只呈现品牌插画，不绘制产品 UI；所有文字都由代码使用字体绘制，避免生成文字失真。

## 重新排版首图

安装 Pillow 后，在仓库根目录运行：

```bash
python3 docs/images/v0.8/render-hero.py
```

脚本默认使用 macOS 的宋体、黑体与 Arial，不复制或分发字体文件。其他系统通过 `--title-font`、`--body-font`、`--latin-font` 指定相应字体；中文字体必须覆盖文案中的汉字。只改文字时无需重新生成插画。
