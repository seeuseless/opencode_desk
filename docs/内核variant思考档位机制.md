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
- **agnes-3.0-flash 实测**（直接打 `https://api.agnes-ai.cn/v1/chat/completions`，看有没有 `reasoning_content` 与 `usage.completion_tokens_details.reasoning_tokens`）：

  | 请求体额外字段 | 结果 |
  | --- | --- |
  | 无 | 直接出正文，无 reasoning_content（默认不思考） |
  | `reasoning_effort: low / medium / high` | **均开启思考**（reasoning tokens ~60，高/低差别不明显，更像开关而非真分级） |
  | `chat_template_kwargs: {enable_thinking:true}` | 开启思考（与上面等效） |
  | `reasoning_effort: none` | **关闭思考**（reasoning tokens 消失，回复 4 token 直接给答案） |
  | `chat_template_kwargs: {enable_thinking:false}` | 关闭思考（同上） |

  结论：官方文档的 `chat_template_kwargs.enable_thinking` 与 OpenAI 标准 `reasoning_effort` 在这个网关上是**同义的**，
  项目统一走 `reasoningEffort`（→ `reasoning_effort`）即可，不必引入 `chat_template_kwargs`。

## 思考形态探测（开关型 vs 低/中/高）

能力表答不了「分不分档」，所以项目自己实测：`electron/main/thinking.ts` 的 `probeThinking()`。

- **探法**：对同一模型发 **3×(none / low / high) 共 9 次**极小请求（同一道几步推导的应用题，`max_tokens: 400`），
  取「思考量」——优先 `usage.completion_tokens_details.reasoning_tokens`，该字段缺失时用消息里的 `reasoning_content` 长度兜底。
- ⚠️ **必须同一档多采几次取中位数，单次采样一定误判**：网关的思考量随机性极大，实测 deepseek-flash
  同一档连打三次 low = 134/192/166、high = 177/228/185，两个区间**大幅重叠**——
  单次采样经常抽到「高档比低档还少」（实测发生过 low=214 / high=137），于是被判成开关型，
  用户切走再切回来档位就从「低中高」变成了「开关」。这正是踩过的坑。
- **判定**（`low`/`high` 必须都采到，否则返回 `null` = 这次没探成，调用方保留原判定，不让网络抖动把模型判死）：
  | 实测（中位数） | 结论 |
  | --- | --- |
  | low、high 思考量都 ≤ 0 | `off` 不支持思考 |
  | high < low × 0.8 | `toggle` 只有开/关（高档明显更少＝网关不认分档） |
  | 其余 | `effort` 真有低/中/高 |

  **取舍是「拿不准就判 effort」**：分档多给几个选项无害（默认停在高，用户只是多点两下），
  误判成开关却会让用户真的失去低/中/高。
- **每个模型独立**：key 为 `提供商ID/模型ID`，各探各的、各存各的——档位形态是「模型 + 网关」的属性，
  绝不能几个模型共用一份结论。
- **缓存**：`~/.qingniaoai/thinking-probe.json`，一个模型只探一次（约几十 token）。
  进程内另有一份内存缓存作唯一事实源，**合并后整体落盘**——预填/切模型会同时触发多个模型的探测，
  若各自拿旧快照去写就会相互覆盖（表现为「探好了，切走再切回来又变回去」）。
- **重探入口**：选择器面板里的「重新识别档位」（清该模型缓存后强制重探）；
  也可直接 `rm ~/.qingniaoai/thinking-probe.json` 全清。
- **接线**：主进程 IPC `thinking:probe`（支持 `force`）/ `thinking:cached`（只读缓存、不发请求）/ `thinking:clear`
  → preload → `oc.probeThinking / fetchProbedKinds / clearProbedKinds`；
  ChatView 在**切到某模型时**触发一次（命中缓存立即返回），并在设置就绪后**一次性预填所有已缓存结论**
  （避免切模型时档位先闪「低/中/高」再变「关/开」）；
  结果进 `probeMap`，`resolveThinkingKind(modelKey, caps, probeMap)` 里**实测优先级最高**。
  选择器 `probed` 属性为 true 时，悬浮提示会说明「档位已按实测结果给出」。
- **实测样本**（本机）：`agnes/agnes-3.0-flash` low=231 high=221 → 开关型；
  `tokenrhythm/glm-5.3-flash` low=253 high=150 → 开关型（同为网关侧不分档）。

## 内核模型能力表（models.dev）

- 内核内嵌 models.dev 数据（二进制里 `"https://api.jiekou.ai/openai"` 那一坨就是），运行时还会 fetch 刷新缓存；
  每条模型记录形如 `{id,name,family,capabilities:{temperature,reasoning,attachment,toolcall,input:{...},output:{...},interleaved},cost,limit,release_date,variants}`。
- **运行时可读**：`GET /provider` → `{ all: Provider[], default, connected }`，`all[].models` 是个 `Record<模型ID, 记录>`，
  记录里带 `capabilities.reasoning`（布尔）与 `capabilities.reasoning_options`（`[{type:'effort',values:['none','low','medium','high']}]` 或空数组）。
- **自定义 provider 也覆盖得到**：`source: 'config'` 的提供商同样能拿到 capabilities（实测本机 6 个自建提供商 12 个模型全部命中）。
  注意 capabilities 是**按「提供商 + 模型」粒度**标注的，同一个模型在不同网关可能标得不一样（models.dev 收录差异）。
- **没有 `reasoning_options`**：自定义提供商的记录里该字段缺失，只有 `reasoning` 布尔值。
- ⚠️ **「分不分档」全库没有字段可查**：把内核返回的 **7845 条**模型记录全扫过一遍，`capabilities.reasoning_options`
  **一条都没有**（连 `openai` / `anthropic` 这些内置 provider 也没有）。也就是说能力表只答得了「支不支持思考」，
  「是开关型还是真有低中高」拿不到——只能靠**实测**（见下节「思考形态探测」）或按模型名猜。
  反例警醒：agnes-3.0-flash 名义上有 low/medium/high，实测 three 档思考量 231/221/— 完全不分档，实质是开关型。
- ⚠️ **models.dev 没收的模型会被填成「占位记录」，不能当"不支持"用**（这是踩过的坑）：
  占位记录特征——`name` 等于模型 id、`release_date` 为空、`interleaved` 为 `false`、`capabilities` 除 toolcall 外全 false。
  models.dev 收录过的记录有真名 + `release_date` + `interleaved:{field:"reasoning_content"}` 等字段，一眼可区分。
  实测本机：agnes-3.0-flash、glm-5.3-flash(tokenrhythm)、step-5-preview、qwen3.8-flash(b.ai)、unorouter 的 qwen3.8/glm-5.3 free 都是占位 false，
  而 agnes-2.5-flash（真收录）是 true——按旧逻辑这些全被判成「不支持思考」，按钮直接置灰。

## 青鸟接线（已实现）

- **没有「思考方式」配置项**（`ModelCfg.thinking` 已移除）：思考档位一律按模型自身能力自动判定，
  用户不必、也无法逐个模型去配——网关通常不暴露这类能力，用户本来也无从得知。
- 自动判定（`src/renderer/oc.ts`）：
  - `fetchReasoningCaps()` 拉 `GET /provider`，产出 `{ '提供商ID/模型ID': true | false | 'unknown' }`（内核未就绪时空表，2 秒重试最多 4 次）；
    **'unknown' = 占位记录**（models.dev 未收录该模型，见上节）——它的 `reasoning:false` 是内核兜底填的，不代表不支持；
  - `inferThinking(模型ID)` 按名字兜底：非对话类（embed/tts/whisper/image/video/sora/kling/veo/wan…）→ off；
    开关型（r1 / reasoner / qwq / -thinking / o1-mini / o1-preview）→ toggle；其余 → effort；
  - `resolveThinkingKind()` 优先级：**实测探测（probeMap）> 能力表 true/false（真实收录）> 按名猜**；`unknown` 一律按名猜。
    猜宽优于猜严——判成支持只是多发一个服务端忽略的字段，判成不支持则用户彻底用不上。
  - `defaultThinkingValue()`：支持思考的模型**默认就把思考打开**（effort → `high`，toggle → `on`），
    没有「不传思考参数」的档位——用户只在这几种明确档位之间切。
- `electron/main/config.ts`：`writeOpencodeConfig` 对所有模型写同一份
  `THINK_VARIANTS = { none, low, medium, high, on }`，**不按模型区分**。理由：内核遇到请求里没声明过的档位名时不合并任何 options（等于服务端默认），多写无害；
  反过来若按配置只写一种，模型能力与配置不符时用户就选不到正确档位。档位**显示**哪些由渲染层按能力表决定。
  `none`（关）→ `reasoning_effort:'none'`，是 OpenAI 兼容端点的通用值，实测 agnes 认它。
- `src/renderer/components/ThinkingPicker.tsx`：思考档位选择器，**档位集合按模型自动判定的能力动态显示**，
  **没有「不传思考参数」这种状态**——支持思考的模型一律给明确档位、默认就打开：
  - `toggle`（只有开关）→ 选项「关 / 开」，默认**开**；
  - `effort`（真有分档）→ 选项「低 / 中 / 高」，默认**高**；
  - `off` → 不可用并置灰。

  用户切过就按模型记住（localStorage `qingniao.thinkMap`，key 为 pid/mid）；存档值不属于当前集合
  （如模型从分档变成开关、老存档是 `low`）时自动回落到默认档，不会出现选了不生效的错位。
- 发消息链路：ChatView 把当前模型的有效档位传给 `oc.prompt(..., variant)`，`oc.ts.prompt` 在请求体顶层带 `variant`（off 模型不传）。
- `electron/main/adapter.ts`：`api()` 已按 `{...body, model}` 重写请求体，顶层 `variant` 天然透传，无需改；选档后需内核重启（写配置后才生效，保存设置/启动即生）。

## 验证方法

用 `tokenrhythm/glm-5.3-flash` 分别以 low / max 发同一条消息，对比「思考」折叠区长度；
内核日志 `~/.qingniaoai/data/opencode/log/opencode.log` 可核对请求体 `reasoning_effort` 实际取值。

**排障（怀疑某模型被误判）**：内核跑着时直接查能力表，看它是真收录还是占位记录——
`curl -s http://127.0.0.1:39421/provider`（端口从 39421 起扫），对比同名模型的 `release_date` / `name` / `interleaved`。
占位记录（`release_date:""` 且 `name===id`）一律按按名猜处理，不会出现「支持思考却被判不支持」。
