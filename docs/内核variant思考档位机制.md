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
- 自定义 provider 不匹配内置目录（目录按 provider 匹配），**必须显式写 variants 才有档位可选**。

## 思考形态（用户在配置里给每个模型选）

早期版本尝试「自动探测」思考形态（打几次极小请求比对思考量），但占位模型/网关实现差异常把
能思考的模型误判成「不支持」（实测 **step-5-preview** 低/高都读到 0 被置灰，实际认 `reasoning_effort`）。
没法可靠地自动判定，所以改成**让用户自己选**，收到 `ModelCfg.thinking`：

- `'off'`：不支持思考，输入框思考选择器禁用；
- `'toggle'`（缺省也按它）：只有「关/开」，思考默认**开**；
- `'low' | 'medium' | 'high'`：固定档位，选择器给「低/中/高」，默认就是这一档。

接线（渲染层判定，不再发任何探测请求）：

- `ModelCfg.thinking` 来源：设置 → 提供商 → 每个模型的「思考」一列（iochip 单选 关/开 / 低 / 中 / 高 / 不支持）。
- `thinkingKindOf(thinking)` → 选择器的档位集合（`ThinkingKind`：toggle / effort / off）。
- `defaultThinkingValue(thinking)` → 默认档位（toggle → `on`；低/中/高 → 该档；off → 空串不传）。
- `ChatView` 按当前模型（`提供商/模型`）从配置取 `thinking`，得出 `thinkKind` 与默认 `thinkVal`；
  用户切过的档位按模型记在 localStorage `qingniao.thinkMap`。
- `oc.prompt(..., variant)`：`variant` 非空才随请求顶层传给内核（off 模型不传）。

## 内核模型能力表（models.dev）与 variants

- 内核内嵌 models.dev 数据、运行时也会 fetch 刷新；`GET /provider` 可读每条模型的
  `capabilities.reasoning`（布尔）等记录。
- 但 **models.dev 全库缺「是否分档」字段（`reasoning_options` 几乎全空）**，且未收录的模型会被填成
  「占位记录」（`release_date:""`、`name===id`、capabilities 除 toolcall 外全 false），它的 `reasoning:false`
  是兜底填的、不代表不支持——所以**不再把能力表/模型名当思考形态的依据**，改由用户配置决定。
- 内核配置 `writeOpencodeConfig` 对所有模型写同一份
  `THINK_VARIANTS = { none, low, medium, high, on }`，**不按模型区分**：
  内核遇到未声明的档位名不合并 options（等于服务端默认），多写无害。档位**显示**由用户选的 `thinking` 决定。
  `none`（关）→ `reasoning_effort:'none'`；`on`（关/开的开）→ `reasoning_effort:'high'`，是 OpenAI 兼容端点通用值。

## 验证方法

用 tokenrhythm/glm-5.3-flash 分别以 low / high 发同一条消息，对比「思考」折叠区长度；
内核日志 `~/.qingniaoai/data/opencode/log/opencode.log` 可核对请求体 `reasoning_effort` 实际取值。

**排障（某模型思考显示不对）**：检查 设置 → 提供商 → 该模型的「思考」列选的是哪一项。
- 选「不支持」→ 输入框思考图标禁用；
- 选「关/开」→ 只有关/开（默认开）；
- 选「低/中/高」→ 给低中高（默认该档）。
若网关其实认识别的思考字段/值，改选成对应档位即可；`variant` 传的是档位名，最终都由
`reasoning_effort` 落到网关上。