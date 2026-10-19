# 模型服务

在 Mac 或 Android 的「模型 → 添加模型服务」选择供应商、填写 Key，再点「测试并保存」。服务设置和模型清单可展开修改；同一家可以接多个账号。保存后，在模型列表选择要使用的模型，各端同步，下轮生效并继续原主 Session。

12 家预设：硅基流动、DeepSeek、智谱、阿里云百炼、Kimi、MiniMax、火山方舟、ZenMux、OpenAI、Anthropic、Google Gemini、OpenRouter。默认使用各家的标准 API 地址；套餐、地区和自建代理地址可在服务设置中修改。

硅基流动预填 DeepSeek V4.1 Flash、GLM 5.3 Flash、Qwen 3.6 / 3.5 的多个尺寸、Qwen 3 VL、Kimi K2.7 Code、GLM 5.3。标注「图片」的模型支持图片输入；普通 GLM 5.3 是纯文本模型。模型可用性和费用以账号及供应商为准。

供应商地址、模型 ID、输入能力与官方文档链接集中在 [`cloud/src/provider-presets.mjs`](../cloud/src/provider-presets.mjs)，两端使用同一份云端目录。

## 接口

- `GET /api/settings` 和 settings WebSocket 事件增加 `providerPresets:[{id,name,protocol,baseUrl,hint,docsUrl,models:[{id,name,note}]}]`。
- `providerPresets` 是无凭据模板；`providers` 才是已接入的账号。模型选择仍是 `{provider:账号ID,id:模型ID}`。
- 新建、编辑的请求包含 `name,protocol,baseUrl,models:[{id,name}],apiKey`。保存前用首个模型测试；编辑时 Key 留空表示保留。
- Key 仅在云端私有配置中保存，权限 600；响应只带尾号。更换供应商预设会清空未提交的 Key。
- OpenClaw 使用同一目录中的输入能力和请求参数；OpenAI 官方接口使用 `max_completion_tokens`，其他兼容服务使用各自的参数约定。
