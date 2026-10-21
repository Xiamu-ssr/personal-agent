# 模型服务

在 Mac 或 Android 的「设置 → 模型」横滑金色卡片切换供应商，下方选择模型；最后一张「+」卡片新增服务，右上角编辑或删除。同一家可接多个账号，各端同步，下轮生效并继续原主 Session。删除当前服务会切到其他已配置服务；最后一个可用服务不能删除。

12 家预设：硅基流动、DeepSeek、智谱、阿里云百炼、Kimi、MiniMax、火山方舟、ZenMux、OpenAI、Anthropic、Google Gemini、OpenRouter。默认使用各家的标准 API 地址；套餐、地区和自建代理地址可在服务设置中修改。

硅基流动预填 DeepSeek V4.1 Flash、GLM 5.3 Flash、Qwen 3.6 / 3.5 的多个尺寸、Qwen 3 VL、Kimi K2.7 Code、GLM 5.3。标注「图片」的模型支持图片输入；普通 GLM 5.3 是纯文本模型。模型可用性和费用以账号及供应商为准。

供应商地址、模型 ID、输入能力与官方文档链接集中在 [`cloud/src/provider-presets.mjs`](../cloud/src/provider-presets.mjs)，两端使用同一份云端目录。

所有供应商和自定义模型统一配置 272,000 上下文与 128,000 最大输出，不再按供应商猜测窗口大小；主 Session 不重建，压缩由 OpenClaw 处理。

## 接口

- `GET /api/settings` 和 settings WebSocket 事件增加 `providerPresets:[{id,name,protocol,baseUrl,hint,docsUrl,models:[{id,name,note}]}]`。
- `providerPresets` 是无凭据模板；`providers` 才是已接入的账号。模型选择仍是 `{provider:账号ID,id:模型ID}`。
- 新建、编辑的请求包含 `name,protocol,baseUrl,models:[{id,name}],apiKey`。保存前用首个模型测试；编辑时 Key 留空表示保留。
- Key 仅在云端私有配置中保存，权限 600；响应只带尾号。更换供应商预设会清空未提交的 Key。
- OpenClaw 使用同一目录中的输入能力和请求参数；OpenAI 官方接口使用 `max_completion_tokens`，其他兼容服务使用各自的参数约定。

## 额度与余额

DeepSeek 查询账户余额；ZenMux 通过单独的 Management API Key 查询 5 小时和每周额度，按量账户查询余额；OpenRouter 查询当前 Key 的有效预算或支出上限。未接入或上游不提供接口时显示状态，不推算金额、不画假进度。查询缓存一分钟，失败不影响模型选择。

`providers[].usage` 与连接器共用格式：`{status,message,checkedAt,items:[{id,label,unit,remaining,limit,fraction,resetAt}]}`。只有余额而没有上限时不显示比例。管理 Key 只存私有 `system/providers.json`，不进入模型配置、响应或日志。

1.6 首次读取配置时导入原环境中的 ZenMux，保留账号 ID 和模型选择，写入 `version:2`。后续以账号文件为准，删除后不会再次出现；语音转写也使用此文件中的可用 ZenMux 账号。
