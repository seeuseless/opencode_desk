# OpenCode 内核「附件 / file part」与媒体上传机制

> 内核版本 opencode-ai 1.18.31。结论来自内核二进制字符串分析 + 内核自带 @opencode-ai/sdk 类型核对，以代码为准，改动后同步。

## 内核侧（已具备，无需改内核）

- `POST /session/{id}/message` 的 `parts` 接受 `TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput`
  （内核自带 SDK `types.gen.d.ts` 确认）。
- `FilePartInput = { id?, type: "file", mime, filename?, url, source? }`，与 text part 并列放入 parts 即可。
- **图片**：内核 `Image.normalize` 只认 `data:...;base64,` 形式的 url（非 data URL 直接走异常分支），
  并自带缩图与体积上限（`attachment.image.max_base64_bytes` 等配置）——**用户上传图片必须转 data URL 再发**。
- **本地文件 file:// URL 是正式形式**：CLI 附件就是 `url: pathToFileURL(路径).href`（大文件）或 data URL（小文件），
  内核消费 mime 映射含 `video/*`（ProviderTransform 的 Gy 函数：image/audio/video/pdf）。
- 会话历史里 file part 是一等公民：内核把用户 file part 摘要成 `[Attached image/png: 文件名]` 文本，模型天然可见。

## media MCP 侧（resources/media-mcp.mjs）

- `generate_image` 同时支持**文生图**（只传 `prompt`）与**图生图**（追加 `image` 数组 → `body.extra_body.image`）。
  `image` 每项经 `normalizeImageRef` 归一化，接受 http(s) URL、data URL、本地绝对路径、`file://`、
  以及裸文件名（`QN_MEDIA_DIR` 兜底）——本地文件由 MCP 读流转 `data:image/...;base64`，
  **模型只需回传路径**，不必把几百 KB 的 data URL 抄进工具参数。
- 工具 description 的触发条件**必须覆盖「丢图 + 一句话」的隐式改图**（「背景换成海边」「去掉水印」这类没出现"生图/画"字眼的），
  否则模型只描述图片不调工具；纯提问（「这是什么」）才按图片理解回答，不必出图。
- `create_video` 的素材参数按 mode 互斥（参考官方 Generation Mode Rules）：
  - `first_frame` / `last_frame` → `mode=keyframe`（至少给一个，不能混 images/audios/videos）；
  - `images`（≤5）/ `audios`（≤3）/ `videos`（≤5）→ `mode=reference`；
  - 都不传 → `mode=text`（纯文字生视频）。
  - **`videos`（视频生视频）不是所有模型都吃**：`agnes-video-2.5-flash` 传 videos 直接 400 `videos is not supported`，
    只有 `agnes-video-2.5`（非 flash）支持。工具描述里已写明，模型收到该报错应改用 images 或纯文字。
  - flash 专属限制：`size` 只能是字符串 `"720P"`；`seconds` 为 `"4"`–`"12"`；`n` 固定 1。
- 素材归一化踩过的坑：扩展名正则**必须写成 `/\.[a-z0-9]+$/`**——`[a-z]+` 匹配不上 `.mp3`/`.mp4`/`.m4a`
  这类带数字的扩展名，素材会被静默判成"格式不支持"（原来只处理图片没暴露，加了音视频才炸）。
  另一个坑：`data URL` 会膨胀三分之一，本地视频动辄几十上百 MB，故设 50MB 上限并**明确报告丢弃原因**，
  绝不能静默丢（`normalizeWithReport`）——静默丢会让请求退化成纯文字生视频，出片与用户预期完全不同。
- **缺口：这些参数目前只适合传 URL**。用户上传的图是本地文件，模型无法把几百 KB 的 data URL 复制进工具参数——
  必须**让 MCP 支持本地路径**：参数里出现本地绝对路径（或 media 目录下的文件名）时，MCP 进程读文件转
  `data:image/...;base64` 塞进请求（MCP 与用户同机，读文件零成本）。
- 服务端未知数：agnes `/images/generations` 的 `extra_body.image` 是否接受 data URL 需实测；
  `/videos` 的参考图同理。不支持时报错文案要能引导。

## 触发：光靠工具描述不够，必须注入附件路由（实测结论）

- 实测（`agnes-3.0-flash` 只勾 text，发 png +「这是什么」）：
  - **不注入** → 模型直接回「我没法直接读取这张图（当前模型不支持图像输入）」，**一个工具都不调**；
  - **注入附件路由提示后** → 立刻调用 `vision_describe_image`，入参 `images=["D:\...\icon.png"]` 正确，
    工具 completed，助手给出准确画面描述（蓝色渐变圆角方形 + 白色小鸟图标）。
- 结论：模型看不到画面时不会自己想到「有工具能代看」，必须在发消息前点名工具。
- 实现：`oc.ATTACH_CTX_PREFIX` + `oc.injectContext(..., noReply)`（与项目记忆/浏览器上下文同一机制，
  AI 可见、界面不渲染；`ChatView.isCtxOnly` 需同步加前缀，否则会渲染成一条用户消息）。
  内容 = 本轮附件绝对路径清单 + 「看懂内容→describe_image / 改图→generate_image / 出片→create_video」。
- 排障入口：`curl http://127.0.0.1:<port>/mcp` 看 MCP 是否 connected；端口从 39421 起（adapter.ts PORT_START）。
  **内核只在启动时连 MCP**，改了配置必须重启内核才生效。

## 通用性：挂载通用，协议分三种

| 能力 | 端点 | 是否通用 |
|---|---|---|
| 文生图 | `POST /images/generations` + `prompt` | ✅ OpenAI 标准，换 provider 也能用 |
| 图生图 | 同上 + `extra_body.image` | ❌ agens 私有扩展（OpenAI 走 `/images/edits` multipart） |
| 生视频 | `POST /videos`（mode 三态）+ `GET /agnesapi` 轮询 | ❌ agens 私有 |
| 识图 | `POST /chat/completions` 多模态 content 数组 | ✅ OpenAI 标准 |

targets 的挑选本身是通用的（按模型 ID 命名特征扫所有 provider），但挑中非 agens 的生图/视频模型大概率调不通。

## 识图（vision MCP，resources/vision-mcp.mjs）

- **识图不是工具能力的正解，是兜底**：图片进上下文后模型天然看得见，只有「对话模型不支持 image 输入、
  内核把附件降级成 `[Attached image/png: 路径]` 一行」时才需要外包给视觉模型代看。
  生图必须走工具是因为对话模型画不出图（要调 `/images` 端点），两者性质不同。
- 独立 MCP（不并入 media）的原因：**挂载条件不同**——media 只在有生图/生视频模型时挂，
  而识图在任何带视觉模型的提供商下都该挂。
- `describe_image({ question, images[], model? })`：本地路径 / URL / data URL 归一成
  `data:image/...;base64` → OpenAI 兼容 `/chat/completions` 的多模态 content 数组 → 返回视觉模型的文字答案。
  单图上限 5MB（再大上游基本拒收，先提示而不是干等超时）。
- **多目标依次重试**（最多 4 个）：挑错模型的概率不低，第一个报 4xx「不支持图片」时自动换下一个。
- 目标挑选（`writeOpencodeConfig`）：自建提供商信用户在设置里勾的 `input` 含 image；
  **平台内置模型那份 input 是硬编码全勾（platform.ts），不可信，改为按名字认**（VISION_MODEL_RE 匹配 id + 展示名，
  平台内置模型 ID 常是 `qn-xxx`，靠展示名才认得出）。显式勾的排前面，猜出的兜底。
- 超时 120s（默认 5s 必被掐）。

## 已知缺口：能力判定是假的，resolveChatModel 实际不生效

- `electron/main/platform.ts` 同步内置模型时 `input: [...MODALITIES]`（text+image+video 全勾），
  平台 `/api/ide/v1/models` 也不下发模态字段；`MODEL_DEFAULTS.input` 兜底同样全勾。
- 后果：`ChatView.resolveChatModel` 算出的「缺哪些模态」恒为空 → 从不切视觉模型 →
  内核按自己的 `capabilities.input.image=false` 丢掉真图、只留一行摘要 → 模型回「我看不了图片」。
- 真相在内核：`GET /provider` 每个模型都带 `capabilities.input.{text,audio,image,video,pdf}`
  （二进制确认：默认 text=true、其余 false），与已用的 `capabilities.reasoning` 同一端点同一份数据。
  待办：把它并入 `oc.fetchReasoningCaps`，`resolveChatModel` 改为内核能力表优先；
  platform.ts 有下发字段就用下发的，没有按名字猜，猜不出标 unknown（按支持处理，不拦）。

## 上传链路设计（渲染层 → 内核）

1. 主进程 `media:pick`（dialog.showOpenDialog，filters image/video）返回 `{path,name,mime,url}[]`：
   **图片**复制进 `~/.qingniaoai/media` 并转 data URL（落盘是为了 MCP 图生图时拿到稳定路径，不受原文件移动/删除影响）；**视频**不读不复制，回原路径的 `file://`。
2. 发送时 `oc.prompt` 组装 parts：`[text part, ...file part]`，file part 的 `filename` 图片传**媒体目录绝对路径**（模型据此把路径传给 media MCP）、视频传文件名。
3. 能力处理：`ChatView.resolveChatModel(files)` 在发送前按本轮附件挑模型，**只在同提供商内换**（跨提供商静默跳会让用户莫名换到别家）：
   - 当前模型没有 text 输入（纯生图/生视频模型，端点只收 `/images`｜`/videos`）→ 换到同提供商能聊天的模型；
   - 带了图片/视频附件、当前模型不支持该输入模态 → 换到同提供商同时支持 text 与该模态的模型。
     不换的代价：模型只看到 `[Attached image/png: 路径]` 一行文本、看不到画面，识图答不上、
     「背景换成海边」这类改图意图也容易判成普通问答；
   - 换成功会在对话流末尾留一条中性提示（`.msgnotice`，与 `.msgerr` 同结构、弱化色），不静默；
     同提供商找不到能胜任的就原样发送——图片路径照样能交给 `generate_image` 改图，不硬拦。
4. 历史渲染：`type==='file'`，图片直接用 data URL 缩略图，视频显示名称条（file:// 渲染层放不了）。
5. 深色主题下用户气泡底色改白色（`--user:#fff` / `--on-user:#1c2129`，内建 dark 与自定义深色主题均处理）。

## 已有可复用基建

- `media:read` IPC（electron/main/index.ts）：本地图片路径 → data URL；`locateMediaFile` 支持裸文件名解析到 `~/.qingniaoai/media`。
- `outName()` 命名、`~/.qingniaoai/media` 目录：media MCP 生成结果已落在这里，上传文件共用。
- Markdown.tsx：AI 回复图片内嵌/点击放大、本地视频内嵌播放均已实现。
