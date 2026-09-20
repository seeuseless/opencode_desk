# OpenCode 内核「思考档位 / variant」机制

> 内核版本 opencode-ai 1.18.31（node_modules/opencode-ai，打包进 resources/bin）。
> 结论来自内核二进制字符串分析与官方文档核对，以代码为准，改动后同步。

## 机制结论

- 内核原生支持 **variant**（模型变体）：同一模型按「推理档位」换不同请求选项，本质就是思考档位。
- **配置声明**：`provider.models.<model>.variants = { 档位名: { 请求选项覆盖 } }`，如
  `{"low": {"reasoningEffort": "low"}, "high": {"reasoningEffort": "high"}}`。
  `reasoningEffort` 经 `@ai-sdk/openai-compatible` 变成请求体 `reasoning_effort`。
- **请求指定**：`POST /session/{id}/message` body **顶层**可带 `variant`（与 `model` 平级，不是 model 的子字段）。
- **会话内 sticky**：不传时沿用本会话该模型上一次的 variant（换模型自动清）；显式传则传值优先。
- **容错安全**：模型没配 variants、或档位名不存在 → 不合并任何 options，请求照发（等于服务端默认）。
- **模型级固定档**：不走 variant 也可直接 `"options": {"reasoningEffort": "high"}` 全局固定。
- 内置目录档位值：GLM-5.3 / 5.3-flash = `low/high/max`（与 ZCode 一致）；OpenAI 系 = none/minimal/low/medium/high/xhigh；Gemini = low/high。
- 自定义 provider 不匹配内置目录（目录按 provider 匹配），**必须显式写 variants 才有档位可选**。

## 内核模型能力表（models.dev）

- 内核内嵌 models.dev 数据（二进制里 `"https://api.jiekou.ai/openai"` 那一坨就是），运行时还会 fetch 刷新缓存；
  每条模型记录形如 `{id,name,family,capabilities:{temperature,reasoning,attachment,toolcall,input:{...},output:{...},interleaved},cost,limit,release_date,variants}`。
- **运行时可读**：`GET /provider` → `{ all: Provider[], default, connected }`，`all[].models` 是个 `Record<模型ID, 记录>`，
  记录里带 `capabilities.reasoning`（布尔）与 `capabilities.reasoning_options`（`[{type:'effort',values:['none','low','medium','high']}]` 或空数组）。
- **自定义 provider 也覆盖得到**：`source: 'config'` 的提供商同样能拿到 capabilities（实测本机 6 个自建提供商 12 个模型全部命中）。
  注意 capabilities 是**按「提供商 + 模型」粒度**标注的，同一个模型在不同网关可能标得不一样（models.dev 收录差异）。
- **没有 `reasoning_options`**：自定义提供商的记录里该字段缺失，只有 `reasoning` 布尔值——
  所以「是否支持思考」能自动判定，但「分档还是开关」仍需按模型名推断。

## 青鸟接线（已实现）

- **没有「思考方式」配置项**（`ModelCfg.thinking` 已移除）：思考档位一律按模型自身能力自动判定，
  用户不必、也无法逐个模型去配——网关通常不暴露这类能力，用户本来也无从得知。
- 自动判定（`src/renderer/oc.ts`）：
  - `fetchReasoningCaps()` 拉 `GET /provider`，产出 `{ '提供商ID/模型ID': 是否支持思考 }`（内核未就绪时空表，2 秒重试最多 4 次）；
  - `inferThinking(模型ID)` 按名字兜底：非对话类（embed/tts/whisper/image/video/sora/kling/veo/wan…）→ off；
    开关型（r1 / reasoner / qwq / -thinking / o1-mini / o1-preview）→ toggle；其余 → effort；
  - `resolveThinkingKind()` 优先级：**内核能力表 > 按名猜**。
    猜宽优于猜严——档位默认停在「默认」（不传思考参数），判成支持也不会出错，判成不支持则用户彻底用不上。
- `electron/main/config.ts`：`writeOpencodeConfig` 对所有模型写同一份 `THINK_VARIANTS = { low, medium, high, on }`，
  **不按模型区分**。理由：内核遇到请求里没声明过的档位名时不合并任何 options（等于服务端默认），多写无害；
  反过来若按配置只写一种，模型能力与配置不符时用户就选不到正确档位。档位**显示**哪些由渲染层按能力表决定。
- `src/renderer/components/ThinkingPicker.tsx`：思考档位选择器，**档位集合按模型自动判定的能力动态显示**（effort=默认/低/中/高，toggle=默认/开，off=不可用并置灰），**按模型记忆**（localStorage `qingniao.thinkMap`，key 为 pid/mid）。
- 发消息链路：ChatView 把当前模型的有效档位传给 `oc.prompt(..., variant)`，`oc.ts.prompt` 在请求体顶层带 `variant`（off 模型不传）。
- `electron/main/adapter.ts`：`api()` 已按 `{...body, model}` 重写请求体，顶层 `variant` 天然透传，无需改；选档后需内核重启（写配置后才生效，保存设置/启动即生）。

## 验证方法

用 `tokenrhythm/glm-5.3-flash` 分别以 low / max 发同一条消息，对比「思考」折叠区长度；
内核日志 `~/.qingniaoai/data/opencode/log/opencode.log` 可核对请求体 `reasoning_effort` 实际取值。
