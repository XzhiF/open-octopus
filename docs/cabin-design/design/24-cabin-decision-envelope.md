# 24 · 舱主对话的决策信封（Decision Envelope）

> 2026-11-16 · 状态：**P0 已实现并验证**（实现记录见 design 25 §17）
>
> 关联：design 23（舱 chat 闭环）、ADR-0021（任务触发）、design 12（座舱实现）
>
> **2026-11-16 后续**：design 25（指挥台）把本文降为它的 P0 子集 —— 信封负责
> 「看得懂」，25 的 relay 负责「不用切线程」。实现顺序见 `25-cabin-command-deck.md` §10。
>
> 前置结论：主对话**不镜像任务对话的完整正文**。主对话只承载
> 「需要人拍板的事 + 里程碑 + 只读模块」，完整过程仍在任务线程。本文件解决的是
> 这两者之间的**信息断层**。

## 0. 已落地（本次会话，供实现时对照）

> 视觉脉络图（全景 / 时序 / 双会话 / 交接物）：`docs/cabin-design/cabin-chat-flow.html`
> —— 先看那张图理解链路，再回到本文 §6 的改动清单动手。

| 能力 | 落点 |
|---|---|
| 舱派发 ≠ 免澄清（`clarify=ask/auto`） | `cabin-comm-service.ts`、`cabin-tools.ts`、`shared/types/cabin.ts` |
| 作者提问镜像到舱主会话 + 就地作答 | `chat-event-bridge.requestAuthorAskCard`、`author-ask-card.tsx` |
| 并发提问逐条 attention + 待答收件箱 | `cabin-service.gatherAsks`、`author-ask-inbox.tsx`、`fleet-model.mergeAttention` |
| 双会话里程碑卡 | `mirrorCardToCabinMain` / `mirrorCardToTaskThread` |
| 状态卡内嵌规格 / 运行 / 验收（只读） | `task-status-card.tsx`、`task-module-inline.tsx` |
| 任务线程顶部常驻「← 回主对话」 | `ChatPane` 的 `cabinMainSessionId` / `onBackToCabinMain` |

相关 commit：`f59f2db7`（闭环主体）、`944f5162`（去主对话开窗）、`d95021bd`（回主对话条）。

## 1. 问题定义

### 1.1 导航（已修）

作业面「去主对话」只切会话不开窗 / 浮窗盖住作业面后找不到回头路 →
已在 `d95021bd` 解决：任务线程顶部常驻「← 回主对话」，直连 `select-session`。

### 1.2 盲答：决策上下文不对称

现状：主对话里的 `authorAsk` 卡只带 `questions`。人能看见「走哪个通道？」，但看不见：

- 这条任务当初是怎么被要求的（**原始意图**）；
- 选每个选项分别会发生什么（**影响**）；
- 作者建议选哪个、为什么（**推荐**）；
- 这个问题处在哪条线、哪个 phase、是否阻塞（**出处与状态**）；
- 答完之后会怎样（**回执**）。

结果就是用户说的：「需要决定的东西在主对话，没有上下文的话也会出问题」。
这不是转发不够快，而是**决策信封不完整**。

### 1.3 Hermes 类比

如果主控是 Hermes，执行体是 Claude Code / opencode / workbody 等多个软件，
主控不可能、也不应该收每个执行体的完整日志。它需要的是一张归一化的
**工作信封**：身份、当前状态、当前提问、选项影响、推荐、产物摘要、最后活动时间。

舱主对话与任务线程的关系就是同一个问题的最小版本。先把这一层做对，
后面接多个外部执行体时，信封直接复用。

## 2. 设计原则

1. **主控收信封，不收日志**：不把任务线程正文搬进主会话。
2. **信封由执行线生产，主控只消费 + 回执**：作者（或 doer）负责给出决策点、影响与推荐。
3. **零 LLM 桥接**：bridge 只做结构化搬运；不调用模型生成摘要。
4. **降级不阻塞**：信封字段缺失时退回现状（只显示问题），不阻断提问。
5. **出处必须可追溯**：每条决策都能指回 `task / phase / round / 来源会话`。
6. **只在有中转时才存在**（§10.2）：同会话自问自答不产生信封，自由任务不被格式绑定。

## 3. 决策信封 v1（P0）

### 3.1 Wire 形态（`activity.payload`）

```jsonc
{
  "authorAsk": true,
  "askMessageId": "<作者线程 assistant 消息 id>",
  "authorSessionId": "<作者线程 session id>",
  "taskId": "t-123",
  "taskName": "支付回调重试",

  // ↓ 必填最小集（只有这三块是人拍板真正需要的）
  "decision": "一句话说明要定的事",                 // 作者正文「决策：」行
  "options": [                                     // 与 questions 的第一个问题对齐
    { "label": "短信", "impact": "只做通道验证，不落库" },
    { "label": "邮件", "impact": "多一张投递记录表，phase1 变厚" }
  ],
  "blocking": true,                                // 是否阻塞执行（由托管档位决定）

  // ↓ 可选富化：有则渲染，无则整块隐藏（zod .optional()，不用默认值填充）
  "intent": "用户派发原文（截断 ~500 字）",          // cabin_jobs.prompt
  "recommendation": {                              // 作者正文「建议：」行
    "label": "短信",
    "reason": "最薄，先验证通道可用性"
  },
  "origin": "task-author",                         // task-author | doer | cabin-assistant
  "phase": { "index": 1, "round": 2 },             // 最新执行行，可为 null

  "questions": { "questions": [ /* 原样透传 */ ] }
}
```

> **必填 / 可选的分界是硬约束**：`title / decision / options[] / blocking` 构成最小信封 ——
> 一个没有执行线的简单委派（「帮我看这三个方案哪个好」）也能只靠这四项成立。
> 其余字段全是富化，实现时用 `.optional()`，**不要用默认值填**（`""`、`null` 会被 UI
> 当成「有值但空」而渲染空块，破坏降级）。

字段来源：

| 字段 | 必填 | 来源 | 缺失时 |
|---|---|---|---|
| `decision` | ✅ | 作者正文「决策：」行 | 退回标题/问题原文 |
| `options[].impact` | ✅（impact 可空） | 优先取 `options[].description`（AskUserQuestion 现有字段） | 不显示影响 |
| `blocking` | ✅ | 托管档位（见 §10）；P0 默认 true | true |
| `intent` | — | `cabin_jobs.prompt`（dispatch 时已存，按 `ref_id=task_id` 取最近一条） | 整块隐藏 |
| `recommendation` | — | 作者正文「建议：」行 | 整块隐藏 |
| `phase` | — | `executions` 表按 task 取最新 `phase_index / round_index` | 整块隐藏（无执行线时正常） |
| `origin` | — | 提问者身份：`tasks.source_chat_session_id` 命中 → `task-author`；否则 `doer` / `cabin-assistant` | 缺省按 task-author 处理 |

> **为什么不在 AskUserQuestion 上加字段**：它是 SDK 内置工具，input schema 固定；
> 硬塞字段会被拒或被丢弃。所以信封走「服务端元数据 + 作者正文约定」两条通道，
> 不改工具协议。

### 3.2 作者纪律（prompt 层）

**前置条件（重要）：只在「跨会话中转」时要求。** 即：提问的人（doer / 作者）和拍板的人
（principal）不在同一个会话里，答案必须经 bridge 送达时，才需要写信封行。1:1 对话、
自由任务、随口问一句 —— 不强制格式，否则会变成「连聊天都要按模板写」。

在 `packages/core-pack/clones/task-author/persona.md` 与
`builtin-clones.ts` 的同文副本（两份必须逐字一致，有测试钉住）追加：

```md
## 舱内提问的信封纪律（决定主对话能不能盲答）

适用：你在**任务线程**里替用户干活，提问会被投到舱主对话、用户可能在那边就地作答。
（与用户 1:1 直接对话时不必套此格式。）

调用 AskUserQuestion 前，最后两行正文固定写成：

决策：<一句话，说明要定什么>
建议：<推荐选项> · <一句话理由>

并且：
- 每个 option.description 写**选它会发生什么**（影响），不写同义词；
- 问题只放能拍板的信息；完整论证仍留在任务线程；
- 不要为了凑格式编造理由；没有推荐就写「建议：无（信息不足）」；
- 如果这个问题实际上不需要人拍板（你有明确依据可以自己定），**不要问** ——
  派发时是全权档（§10 hands-off）就自己按建议推进，只在里程碑留一条回报。
```

舱 wake（`cabin-comm-service.ts` 的 clarify=ask 段落）同步加一句同样的要求。

## 4. 主对话卡片（UI）

`AuthorAskCard` 在现有 `AskUserQuestionCard` 之上增加一块**可折叠的任务上下文**
（默认展开，长文可收）：

```
┌ 支付回调重试 的作者在问你 ─────────────── P1 · R2 ┐
│ 要定的事：回调失败后用什么通道重试？               │
│ 你的原始要求：…（intent，最多 3 行，可展开）        │
│ 选项影响：                                        │
│   ○ 短信 — 只做通道验证，不落库                    │
│   ○ 邮件 — 多一张投递记录表，phase1 变厚           │
│ 作者建议：短信 · 最薄，先验证通道可用性             │
│ [去任务对话看完整上下文 →]                         │
└───────────────────────────────────────────────────┘
```

- 「去任务对话」沿用现有 `openTaskInChat(taskId)`。
- 缺字段时逐块隐藏，不占位。
- 不改 `AskUserQuestionCard` 的答题协议（仍然产出「用户回答了以下问题：…」）。

## 5. 回执（答完让主控上下文自洽）

答完不只把卡变灰，要在主会话留一条轻量事件卡：

```
✓ 已答 · 支付回调重试：选了「短信」；作者继续推进
```

实现两条路，**建议服务端做**（换设备 / 刷新也在）：

- 在 `markAuthorAskAnswered(authorSessionId)` 里，除了给镜像卡写 `decision`，
  再 append 一张 `payload.authorAskReceipt = { taskId, taskName, label, at }` 的
  event 卡到舱主会话（零 LLM，去重键 = `askMessageId`）。
- 前端 `TuiTranscript` 增加一个极简分支渲染 receipt（单行 + 勾）。
- 就地作答成功后，前端无需再写本地 receipt（服务端调用同一条路径）。

> 注意：`markAuthorAskAnswered` 目前只在「用户消息包含『用户回答了以下问题』」时
> 被 `chat-routes.ts` 调用；就地作答转发的正文也是这个格式，所以两条路都会命中。

## 6. 改动清单（P0）

### Server

1. `packages/server/src/services/activity/chat-event-bridge.ts`
   - `requestAuthorAskCard(input)` 增加：`intent? / decision? / recommendation? /
     options? / phase? / origin? / blocking?`（全部 optional，除 P0 必填最小集由
     前端兜底推导）。
   - **入口不变**：仍只在「提问方 ≠ 拍板方」时投卡（当前判据 = 该线程有
     `cabin_id` 的任务主线程）。这条是自由度的护栏，不要改成「所有
     AskUserQuestion 都投卡」。
   - 查询 `cabin_jobs.prompt`（按 `cabin_id + ref_id=taskId` 取最近一条）填 `intent`。
   - 查询最新 `executions` 填 `phase`。
   - 落库 payload 增加上述字段；旧字段保持不变。
   - `markAuthorAskAnswered` 增加 receipt 卡（幂等键 `askMessageId`）。
2. `packages/server/src/routes/agent/chat-routes.ts`
   - 在收到 `ask_user_question` chunk 时，同时记录当前累计正文
     （`fullContent`）的快照。
   - 结束时用简单的行解析器抽取「决策：」「建议：」两行；
     `options[].description` 直接映射为 `impact`。
   - 传给 `requestAuthorAskCard`。
   - 解析器写成纯函数（如 `parseDecisionEnvelope(text, questions)`），单测覆盖。
3. 无 schema / DB 迁移（全部在 message payload 内）。

### Web

4. `packages/web-app/components/agent/chat/author-ask-card.tsx`
   - 上下文折叠区（意图 / 决策 / 影响 / 建议 / 出处）。
5. `packages/web-app/components/agent/chat/TuiTranscript.tsx`
   - `payload.authorAskReceipt` → 单行 receipt 卡。
6. （可选）`author-ask-inbox.tsx` 行上带 `P1·R2` 与阻塞标记。

### Prompt

7. `packages/core-pack/clones/task-author/persona.md` +
   `packages/server/src/services/agent/builtin-clones.ts` 的同文副本。
8. `packages/server/src/services/cabin/cabin-comm-service.ts` wake 模板一句话。

### 测试

- server：`parseDecisionEnvelope` 纯函数；`requestAuthorAskCard` 落 `intent/phase/options`；
  缺字段降级；receipt 幂等。
- web：`author-ask-card` 渲染上下文并可折叠；缺字段不渲染空块；receipt 渲染。
- 现有 `cabin-g2-bridge.test.ts` / `author-ask-card.test.tsx` 扩展，不新起体系。

## 7. P1 / P2

### P1 — 证据快照

信封里再加一处 `evidence`：

```jsonc
"evidence": {
  "specExcerpt": "该决策相关的 spec 片段（≤800 字）",
  "affectedPhases": [2, 3],
  "priorDecisions": [{ "key": "D-3", "value": "短信优先" }]
}
```

作者在正文里给「依据：」段落，服务端截取；没有就留空。用于「选 A 会不会影响 phase3」这类判断。

### P2 — 多执行体的归一化工作信封

把舱里的信封抽象成通用 schema（供 Hermes 式主控接 Claude Code / opencode / workbody）：

```ts
interface WorkEnvelope {
  executor: 'cabin-task' | 'claude-code' | 'opencode' | 'workbody' | string
  workId: string
  title: string
  state: 'running' | 'waiting_input' | 'blocked' | 'review' | 'done' | 'failed'
  intent: string
  pendingDecision?: DecisionEnvelope
  artifacts?: Array<{ kind: 'diff' | 'report' | 'pr'; ref: string; summary: string }>
  lastActivityAt: string
}
```

原则不变：主控只收信封与产物引用，不收原始日志。

## 8. 验收标准（P0）

1. 舱里派发任务，作者第一次提问时，主会话卡片能看到：意图、决策点、每个选项的影响、
   作者推荐与理由、`P{n}·R{m}`。
2. 作者漏写「决策 / 建议」时，卡片正常显示问题，不出现空块、不报错（降级）。
3. 就地作答后：卡片只读、待答收件箱消项、attention 消失，并多一条「✓ 已答 …」回执。
4. 在任务线程里作答：主会话镜像卡同样变只读 + 有回执。
5. 全量 server / web 测试与 `pnpm build` 绿；`pnpm lint` 0 error。
6. **护栏**：非舱任务 / 1:1 对话里的 `AskUserQuestion` 不投卡、不进 attention、
   不出信封（现有 `cabin-g2-bridge.test.ts` 的「非舱任务不投卡」必须继续绿）。
7. **档位**：`clarify=auto` + `hands-off` 形态派发，简单任务不产生决策卡，
   只在完成时留一条里程碑回执。

## 9. 明确不做

- 不把任务线程的对话正文镜像到主会话。
- 不在 bridge 里调用 LLM 生成摘要。
- 不改 `AskUserQuestion` 的工具 schema（SDK 内置）。
- 不要求作者为每个问题写长篇论证；信封只收「能拍板所需的最小上下文」。

（自由度相关的正面约定见 §10 —— 上面这些是 P0 的实现边界，不是任务形态的限制。）

## 10. 自由度与托管档位（2026-11-16 补充）

### 10.1 担心与澄清

「有了决策信封，是不是很多东西被固定死了？自由任务、简单委派是不是就不好做了？」

不会 —— 前提是不把三件本不相关的事粘在一起：

| 维度 | 回答什么 | 依赖信封？ |
|---|---|---|
| **传输面：信封** | 要不要人拍板、拍什么、每个选项的影响、谁建议选哪个 | 就是它本身 |
| **工作形状** | 一句话委派 / 一次性执行 / v4 多 phase 任务 | ❌ 不依赖 |
| **托管档位** | 每步都问 / 只在关键点停 / 全权代理只报告 | ❌ 不依赖，但决定要不要发信封 |

信封只跟第一维绑定。`intent / phase / recommendation / spec` 全是**可选富化**，
不是入场券。现状代码已经如此：`packages/server/src/__tests__/cabin-g2-bridge.test.ts`
有一条「非舱任务不投卡」——普通会话里的 `AskUserQuestion` 就地渲染，不投卡、不产生信封。

### 10.2 护栏（invariant）

> **信封只在存在「中转」时存在。**

提问的人（doer / 作者）和拍板的人（principal）不在同一个会话里、答案必须经 bridge
送达时，才需要信封。同一个对话里自己问自己答，不需要。

这条在现状成立（只对舱任务投卡），在 P2 的多执行体场景也成立（opencode 跑在别的
进程里，必须中转）。按这条做，自由对话、随手改个文件、闲聊，根本碰不到信封。

### 10.3 托管档位

`blocking` 恒 true 是个保守默认，但它同时堵死了另外两种合理形态。让档位决定形态：

| 档位 | 作者行为 | 主对话看到什么 | 适用 |
|---|---|---|---|
| `approve`（每步问） | 遇决策点就停 | 决策信封卡（`blocking: true`） | 高风险、不可逆、钱/权限 |
| `checkpoint`（关键点停） | 只在关键决策处停 | 信封卡 + 推荐项高亮 | 中等复杂度开发（默认） |
| `hands-off`（全权） | 自己按建议推进 | **不产生卡**，里程碑留一条「已按 X 推进」回执 | 简单委派、自由任务 |

`hands-off` 是自由度的关键：简单委派默认应落这一档 —— 「你去做，做完告诉我」，
而不是「停下来问我三个问题」。现有派发参数 `clarify=ask|auto`
（`cabin_dispatch_task`，见 `packages/server/src/services/chat/cabin-tools.ts`）
就是这个档位的雏形：`auto` 语义已包含「无实质歧义就别问」，扩成三档即可，
不需要新概念。

### 10.4 落到实现上的四条修正

1. **字段分两层**：必填最小集 `{ title, decision, options[], blocking }`，
   其余全部 `zod.optional()` 且**不用默认值填充** —— 否则 UI 渲染空块。
2. **`source` 泛化成 `origin`**：`'task-author' | 'doer' | 'cabin-assistant'`。
   汐音自己直接委派外部执行体时也能发信封，不必先建 v4 任务。
3. **作者纪律加前置条件**（§3.2）：只在跨会话中转时要求写信封行；
   1:1 对话强制格式会反噬自由任务。
4. **轻档不进任务状态卡体系**：`TaskPlanWindow / RunWindow / AcceptanceWindow`
   是 v4 任务的 UI；一句话委派、一次性执行不该被塞进 status card 的形状，
   否则「什么都要立项」。

### 10.5 共存示例

委派「帮我看这三个方案哪个好」—— 有决策、没有执行线、没有 phase：

```jsonc
{
  "decision": "三个方案选哪个",
  "options": [
    { "label": "A · 自建", "impact": "里程碑最长，可控性最高" },
    { "label": "B · 采购", "impact": "两周可上线，锁定供应商" },
    { "label": "C · 混合", "impact": "前期快，后期要还集成债" }
  ],
  "blocking": true,
  "origin": "cabin-assistant",
  "phase": null            // 没有执行线，正常
}
```

信封依然成立。P2 的 `WorkEnvelope.pendingDecision?` 本来就是可选的，
说明「没有决策的执行体」在模型内可共存 —— 方向是对的，实现时别把它写死成必填。
