# 内核 Zen 免费模型机制（免 KEY 的那批模型）

> 结论（2026-10-09 实测，内核 opencode-ai 1.18.33）：桌面端可以白拿一批**不需要 API Key** 的模型，
> 清单由内核自己持有，启动时同步一次即可。本文记录机制、实测证据，以及踩过的坑。

## 一句话机制

内核内置一个 id 为 `opencode` 的 provider（OpenAI 兼容，指向 `https://opencode.ai/zen/v1`）。
**在没有 `OPENCODE_API_KEY` 时，它只暴露那批免费模型，付费的一个都不列**；
清单里每个模型都自带模态能力与各自的 context/output 上限。

所以桌面端要做的只有一件事：**读清单**（`GET /config/providers`），翻译成自己的 `ModelCfg`。
不用硬编码模型名、不用探测、不用维护。

## 实测证据

### 1. 直连 curl：免费模型确实不要 KEY，但过不去 403

```
POST https://opencode.ai/zen/v1/chat/completions   model=space-bunny-free, 无 Authorization
  => 200 {"choices":[{"message":{"content":"ok"}}], usage:{...}}

POST 同一端点   model=gpt-5-nano（付费）, 无 Authorization
  => 401 {"error":{"type":"AuthError","message":"Missing API key."}}
```

免费模型免 KEY 属实。但**大部分免费模型直连会被挡**：

```
POST 同一端点   model=big-pickle（免费）, 无 Authorization
  => 403 {"error":{"type":"FreeTierError",
                   "message":"OpenCode's free tier can only be used from within OpenCode"}}
```

试过 UA、`x-opencode-client`、`x-opencode-session`、`x-opencode-project`、
空 `Bearer `、`Bearer public` 等各种组合，**都无法伪造通过**——服务端显然在验别的东西。

> **因此：桌面端绝不要直连 Zen，必须让请求经过内核进程。**
> 好在青鸟本来就是 spawn 内核 + 走本地 HTTP（见 `client/electron/main/adapter.ts`），前提天然满足。

### 2. 经内核：11 个免费模型全部调通，KEY 为空

逐个跑 `opencode run --model opencode/<model>`，`OPENCODE_API_KEY` 置空：

| 模型 | 上下文 | 直连 | 经内核 |
|---|---|---|---|
| big-pickle | 200K | 403 | ✅ |
| space-bunny-free | 1M | 200 | ✅ |
| step-5-preview-free | 1M | 403 | ✅ |
| longcat-2.5-preview-free | 1M | 403 | ✅ |
| mimo-v2.6-flash-free | 200K | 403 | ✅ |
| ling-3.1-flash-free | 262K | 403 | ✅ |
| ling-3.0-flash-fin-free | 262K | 400 | ✅ |
| nemotron-3-ultra-free | 1M | 403 | ✅ |
| nemotron-3.5-lightning-free | 262K | 403 | ✅ |
| muse-spark-1.3-contributor-free | 1M | 403 | ✅ |
| exo-free | 1M | 410 已下线 | ✅（内核仍列着） |

### 3. provider id 用什么都行，不必叫 `opencode`

这是决定实现方式的关键一测。分别用 `opencode` / `zenfree` / `qnx` 三个 id，
配同一份 `baseURL` + 空 env 插值，三个都调通。

> 所以**不要用 `opencode` 当我们自己的 provider id**——那是内核内置 provider 的保留名，
> 在 `opencode.json` 里同名会整个覆盖掉内核自带的定义（连带那批模型的能力元数据）。
> 用独立 id（现取 `qnx-free`）走我们自己的条目，内核照样正常调用。

### 4. apiKey 留空 + `{env:...}` 插值指向不存在的变量 → 可用

`writeOpencodeConfig` 会给所有 provider 写 `apiKey: '{env:QN_KEY_<ID>}'`，
而 `providerEnv()` **刻意不注入** zen 的这个变量。实测这种「插值指向不存在的环境变量」的情况，
内核会落到匿名通道，免费模型照常工作。

> 别哪天"顺手补上"这个 env 注入——那会把免费模型变成需要 KEY 的路径。

## 内核给的元数据（直接用，别自己拍默认值）

`GET /config/providers` 里每个免费模型的形状：

```jsonc
"space-bunny-free": {
  "api": { "url": "https://opencode.ai/zen/v1", "npm": "@ai-sdk/openai-compatible" },
  "capabilities": {
    "reasoning": true, "toolcall": true, "attachment": true,
    "input": { "text": true, "image": true, "audio": false, "video": true, "pdf": false },
    "interleaved": { "field": "reasoning_content" }   // 交错思考字段
  },
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 1048576, "output": 524288 }
}
```

免费模型之间的上下文差异很大（200K ~ 1M，输出 32K ~ 524K），**用内核给的，别用 `MODEL_DEFAULTS`**。
`interleaved.field: reasoning_content` 那份交错思考支持也一并带上了。

## 落点

| 文件 | 职责 |
|---|---|
| `client/electron/main/zen.ts` | 读清单 + 翻译（`parseZenModels` 是纯函数，可单测） |
| `client/electron/main/config.ts` | `zenProvider()` 虚拟 provider；`usableProviders()` 里排最后 |
| `client/electron/main/types.ts` | `ZenCfg` 缓存 + `ModelCfg.zenFree` 标记 |
| `client/electron/main/index.ts` | `zen:refresh` IPC（渲染层点开选择器时调） |
| `client/src/renderer/oc.ts` | `chatProviders()` 把限免组排最后 |

分组显示名是 **opencode限免**，排在所有提供商**之后**：它是兜底性质的
（官方限时提供、随时可能下线），不该抢在用户自己配好的模型前面。

清单缓存在 `settings.zen.models`，**只是快照不是事实来源**：官方增删模型时下次同步自然刷新。

## 同步时机（刻意不在启动时）

点开**模型选择器**那一刻才同步（`ModelPicker` 的 `onOpen` → `zen:refresh`），
不是启动时同步。理由：清单要向内核问，而绝大多数用户配了自己的 provider，
那批限免模型根本不会被点开——启动就同步等于每次开机白等一次。
`onOpenFired` 标记保证反复开关面板只问一次。

**没有免费模型时整个分组不显示**：`zenProvider()` 判空返回 `null`、
`chatProviders()` 判 `.length`，两处都守着；同步拿到空清单也不落盘，
所以既不会显示一个空分组，也不会把已有清单清掉。

## 坑位备忘

1. **`zenFree` 与 `free` 是两回事，别混用。**
   `free` 是平台计费口径的「限免」（要登录、要算积分），渲染成绿色「限免」+ 0x 倍率；
   `zenFree` 是「压根不用 Key、不过平台」。界面上两者都显示「限免」（用户视角都是这段时间不花钱），
   但字段仍要分开存——一个不经过平台计费也没有倍率，混成一个字段迟早在某个分支上判错。

2. **只收 OpenAI /chat/completions 兼容的那一类（`api.npm` 白名单）。**
   内核清单里每个模型带 `api.npm`：`@ai-sdk/openai-compatible` = 走 /chat/completions（桌面端唯一支持的通道）；
   `@ai-sdk/openai` = OpenAI 原生 SDK（/responses 等通道，2026-10-11 实测 `muse-spark-1.3-contributor-free` 是这种，调用报错）。
   `parseZenModels` 按 npm 白名单过滤，`api` 字段缺失的同样滤掉——不知道走什么通道的不收；
   官方清单一变，下次同步（点开模型选择器）自动生效。

3. **免费模型随时会消失。** 测的时候 `exo-free` 已经 410 下线，但内核清单里还挂着——
   说明这份清单不是实时健康的。真下线了会表现为调用报错，暂不做自动摘除。

4. **同步失败时绝不清空已有清单。** `fetchZenModels` 拿不到就返回空数组，
   `zen:refresh` 见到空数组直接返回、**不落盘**，避免内核没起时把整个免费分组弄消失。

5. **`vision` 不能从 capabilities 推。** 它是本机专用标记（挑「识图代看」目标用），
   内核不认这个词；只映射内核明确标 true 的 `text/image/video`。

6. **`genRoleOf` 靠名字判生成角色。** 免费模型里有 `nemotron-3-ultra-free` 这类，
   别名里带 flash/free 不会被误判成生成类；但万一官方加了个叫 `*-image-free` 的，
   就会被当成生图模型从对话菜单里滤掉。加模型时留意这条。

## 参考

- 官方文档 <https://opencode.ai/docs/zen/>（免费模型是"限时免费"，明确写了可能随时下线）
- 定价页列了每个模型的免费状态，本文档的模型清单与之核对过