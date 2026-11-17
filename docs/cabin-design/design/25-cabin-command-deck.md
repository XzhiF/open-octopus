# 25 · 指挥台（Command Deck）—— 人只对助理说话

> 2026-11-16 · 状态：**P0–P4 已实现并验证**（P5 多执行体保留为类型与设计；见 §17 实现记录）
>
> 关联：design 23（舱 chat 闭环）、design 24（决策信封）、ADR-0021（任务触发）
>
> 一句话：**把主对话从「消息列表」升级成「指挥台」，把任务线程从「第二现场」降级成「证据」。**
>
> 视觉表达：`docs/cabin-design/cabin-chat-flow.html`（**v2 · 指挥台版**，
> 与本文同源；同步纪律见 §16）。

## 0. 这次改的是什么

| 维度 | 现在 | 改后 |
|---|---|---|
| 人对谁说话 | 汐音，但经常被送去任务线程 | **只对汐音**；任务线程是兜底 |
| 决策发生在哪 | 主对话卡片 / 任务线程 / 编队，三处都能答 | **主对话是唯一入口**，另外两处只是入口的快捷方式 |
| 派发内容 | 用户原话机械转发（`需求原文（转发，不改写）`） | **汐音先编译成 brief**，原文保真附后 |
| 助理在任务线程里 | 系统模板 wake，人看不出是谁在说 | **代述（proxy）**：明确标 `汐音 · 代你` |
| 主对话收到的状态 | 每个里程碑一张卡（双会话镜像） | **需要人动作的才成卡**，其余按任务合并成滚动摘要 |
| 助理的自我认知 | 每回合注入一段舱摘要（已有） | 摘要升级为**编队视图**：谁在跑、卡在哪、我管着几条线 |
| 任务线程的输入框 | 与主对话等权 | **默认只读**，显式切换「在此处回答（兜底）」 |
| 简单委派 / 自由任务 | 只能建 v4 任务 | **独立委派实体**：无 phase / worktree / 验收 / 归档 |

这不是加功能，是换主次。三件事必须同时成立，否则体验会撕裂：
**决策收口** + **意图编译** + **代述**。少任何一件，"人只对助理说话"就退化成"人还是得两头跑"。

## 1. 用户口径（拆成可执行命题）

1. 人只对接助理；**所有决策在主对话里做**，不再切到任务对话。
2. 任务线程是**兜底与追溯**：能看到里面发生了什么、谁说了什么。
3. 助理要**组织并优化我的意图**再去对接执行体 —— 人的自然语言不如助理改写后的明确。
4. 助理在任务线程里的发言**等同于我的发言**（授权代理），但要能看出是它代我说的。
5. 主对话会**同时面对多条 attention**（编队）；必须有任务的区分，助理自己也要知道在管哪几条线。
6. 助理是**统筹帷幄**的角色，不是消息路由器。

## 2. 角色模型

```
                    ┌────────────────────────────────────┐
                    │  人 · principal                    │
                    │  只在一个地方说话：主对话          │
                    └───────────────┬────────────────────┘
                        自然语言    │  ▲ 决策卡 / 回执 / 摘要
                                    ▼  │
                    ┌────────────────────────────────────┐
                    │  汐音 · orchestrator               │
                    │  主对话 = 指挥台                   │
                    │  · 意图编译 brief                  │
                    │  · 决策转达 relay                  │
                    │  · 编队感知 snapshot               │
                    └───────────────┬────────────────────┘
                        brief/relay │  ▲ envelope / receipt
                                    ▼  │
                    ┌────────────────────────────────────┐
                    │  doer · 任务作者 / 外部执行体      │
                    │  任务线程 = 证据面（默认只读）     │
                    └───────────────┬────────────────────┘
                                    ▼
                        workflow · worktree · 产物
```

**代理发言（proxy turn）** 是这套模型的基石：doer 侧看到的每一条 `user` 消息，
都必须能回答两个问题 —— *谁说的*（`by: principal | orchestrator`）、
*根据什么说的*（`basis: decisionId | briefId | null`）。

现状其实已经是"助理在冒充用户"：`CabinCommService.dispatch()` 通过
`wakeSession()` 往作者线程写 `role=user` 的模板消息。问题不是它冒充，而是
**冒充得既不像人、也没标记**。这次把它做成显式契约。

## 3. 四条不变式

| # | 不变式 | 含义 |
|---|---|---|
| I1 | **决策只发生在主对话** | 任务线程默认只读；兜底作答保留，但降级为"例外路径" |
| I2 | **执行只在任务线** | 助理只调度不执行；主对话里不跑工具副作用 |
| I3 | **跨线只搬三样** | `brief`（意图契约）、`envelope`（决策请求）、`receipt`（回执 + 摘要） |
| I4 | **原文与转述分离** | 人的原话永远逐字保留；助理的改写单独成块，不可覆盖原文 |

I4 是本设计里最容易被破坏、又最贵的一条。理由：一旦助理的转述替换了原文，
事后追责和纠偏就没有锚点了 —— 你没法判断"是它理解错了，还是我本来就这么说的"。

## 4. 数据模型增量（不加表）

| 落点 | 增量 | 兼容性 |
|---|---|---|
| `messages.metadata` | 新增 `proxy: { by, sessionId, basis, verbatim }`、`decisionReceipt`、`brief`、`taskHandle` | 纯 JSON，旧行无此键，读侧 `.optional()` |
| `cabin_job_events.kind` | 增 `brief`、`decision` 两种 | 需改 `shared/types/cabin.ts:13`、`db/types.ts:736` 两处枚举；无需迁移 |
| `cabins.focused_job_id` | **直接复用**为"当前焦点任务" | 已存在（`cabin-service.setFocus`），只需在主对话 UI 上暴露 |
| 任务 handle / 颜色 | **派生，不落库** | 由 `listJobsView` 的顺序 + 名称 hash 生成，前后端同一个纯函数 |
| 决策状态机 | **不落表**，由消息上的 `decision` + job event 派生 | 与 attention 同哲学：状态可重放 |

### 4.1 handle 与颜色

每条任务在主对话里有个短句柄：`#1 支付回调`。规则：

- 序号 = 本舱 `cabin_jobs` 创建顺序（稳定，不随状态变）；
- 颜色 = `hash(taskId) % 6`，取一套低饱和色（与 pop 色板同族）；
- 助理在正文里就用这个 handle 指代任务（`#1 那边问你…`），人在输入框里也可以 `#1 …` 指代。

handle 的作用不是好看，是**让"多条 attention 并发"这件事在语言层面可指代**。
没有它，人只能说"那个任务"，助理也只能猜。

### 4.2 独立委派实体（`cabin_delegations`）

**定位：不是任务。** 没有 phase、没有 worktree、没有验收、没有归档。
它回答的是"替我跑一件事，回来告诉我"。

```
cabin_delegations
  id
  cabin_id
  title
  intent_text      -- 用户原话（逐字，永不覆盖）
  brief            -- JSON：goal / done_when / constraints / non_goals / refs
  autonomy         -- approve | checkpoint | hands-off
  state            -- queued | running | waiting_input | done | failed | cancelled
  doer_session_id  -- 执行它的会话（点开看过程 = 证据面）
  result_summary   -- 结束时的一句话结论
  created_at / updated_at / ended_at
```

生命周期：

```
queued ──dispatch──▶ running ──ask──▶ waiting_input ──relay──▶ running
                        │                                        │
                        ├──ok──────────────────────────────────▶ done ──receipt──▶ ack
                        └──err─────────────────────────────────▶ failed
任意态 ──cancel──▶ cancelled
```

**与 `cabin_jobs` 的关系：账本不合并，视图统一。**

- **不给 `cabin_jobs.kind` 加 `'delegate'`**。该列带 CHECK 约束
  （`schema.sql:1399`），老库不会因为 schema 文件更新就放宽 —— 加值需要重建表，
  与仓库"无迁移路径"的约定冲突。
- 委派自己的表就是它的实体；编队 / attention 在**读侧**把 tasks 与 delegations
  归一成同一种 `WorkRow`（`kind: 'task' | 'delegate'`）。
- 写侧保持独立，读侧只有一个入口。

**读侧适配点（"独立实体"的真实成本，共 5 处）：**

| 落点 | 现在只认 tasks | 需要增加 |
|---|---|---|
| `CabinService.listJobsView` | tasks + cabin_jobs | ∪ delegations，映射成同形 `WorkRow` |
| `deriveCabinView` | tasks / executions / asks | ∪ delegations：`waiting_input → answer`、`failed → blocked`；`done` 不产 attention（只留回执） |
| `gatherAsks` | 舱会话 ∪ 任务线程 | ∪ `doer_session_id` |
| `requestAuthorAskCard` / `markAuthorAskAnswered` | `JOIN tasks` | 先查 tasks，落空再查 delegations；卡片 payload 增 `subject: { kind, id }` |
| `fleet-model` / 深链 | `task:` | 增 `delegation:`；`mergeAttention` 按 `subject` 聚合 |

**明确边界：**

- 不做多 phase、不做 spec 票、不做 worktree 隔离；
- 不接 acceptance plan / archive 流程；
- 不占用任务的 handle（`#1`）；委派用自己的段位（`D1`），扫一眼就能区分"这是立项的"还是"这是跑一趟的"。

结论：自由任务不但没被限制，反而更轻 —— 一份 brief + 一个 doer 会话。
但系统里从此有**两种工作实体**，所有"读所有工作"的地方都必须走归一化，
否则编队会漏、attention 会哑、决策卡会找不到主。这就是选独立实体要付的账。

## 5. 主对话（指挥台）的形态

### 5.1 四类内容，四种密度

| 类型 | 形态 | 默认 | 说明 |
|---|---|---|---|
| **决策** | 卡片 + 队列 | 展开 | 唯一必须人处理的东西（design 24 信封） |
| **回执** | 单行 | 展开 | `✓ #1 支付回调 · 按「短信」交代下去` |
| **任务摘要** | 每任务一条，持续改写 | 折叠 | `#1 执行中 P2 · 上次更新 3 分钟前` |
| **助理发言** | 正常对话 | 展开 | 编译 brief、解释、报告 |

**状态卡不再逐条铺。** 这是本次改动带来的必然结果：人如果全天待在主对话里，
每个里程碑一张卡会把决策彻底淹掉。里程碑的完整序列留在任务线程；
主对话里同一任务的状态**合并进它那条摘要**（可展开看最近 5 条）。

> 这条直接修订 design 23 §2.1 的"双会话镜像"：镜像仍然存在，但**主对话侧改成聚合形态**，
> 任务线程侧保持逐条。不是取消，是改变密度。

### 5.2 编队分区

```
┌ 指挥台 ────────────────────────────────────────────────────────┐
│ 编队  #1 支付回调 ●待拍板   #2 登录重构 ●执行中   #3 周报 ●待验收 │  ← 常驻条
├────────────────────────────────────────────────────────────────┤
│ ▎ 汐音  收到，我按这个交代：先验证通道可用性，不落库…           │
│                                                                │
│ ▎ ⚠ #1 支付回调 的作者在问你          P1 · R2 · 阻塞           │  ← 左侧脊线=任务色
│ ▎   决策：失败回调用什么通道重试？                              │
│ ▎   你的要求：…（原文，可展开）                                  │
│ ▎   ○ 短信 — 只做通道验证，不落库      ← 作者建议               │
│ ▎   ○ 邮件 — 多一张投递记录表，phase1 变厚                      │
│ ▎   [去任务对话看过程 →]                                        │
│                                                                │
│ ▎ ✓ #1 按「短信」交代下去（汐音已转达，作者继续）                │  ← 回执
│                                                                │
│ ▎ ▸ #2 登录重构 · 执行中 P2 · 3 分钟前更新                      │  ← 摘要（折叠）
└────────────────────────────────────────────────────────────────┘
```

- 左侧彩色脊线 = 任务色，同一任务的消息共享颜色；
- 卡片与回执都带 handle 前缀，扫一眼就知道在跟哪条线说话；
- 摘要行不占决策位，折叠后只留一行。

### 5.3 决策队列

多条 attention 同时来是常态，不是异常。规格：

- 顶部 dock 按**任务分组**列出待决项（复用 `author-ask-inbox`，加 handle 与阶段）；
- 同屏最多展开 3 张卡，其余折叠成 `+2 条待处理`；
- 键盘 `1/2/3` 选择当前卡的选项，`↵` 提交，提交后自动滚到下一条；
- **一次提交只对应一条 ask**（不做批量，避免误答）；
- 卡答完立刻变只读并插回执 —— 不等助理回合完成，避免"点了没反应"。

### 5.4 输入框

- **焦点作用域**：点开某张卡 / 摘要，composer 绑定该任务（`cabins.focused_job_id`）。
  此时自由文本默认理解为"关于这条线的指示"，助理不必猜。
- `#N` 前缀可临时改作用域；无焦点时是全局指令。
- 决策卡展开时，composer 上方给一排快捷回填（选项文案），可直接编辑再发。

### 5.5 任务线程视图（兜底）

```
┌ 任务线程 · #1 支付回调 ────────────────────────────────────────┐
│ 汐音代你在与作者对话 · 你的决定都在主对话     [← 回主对话]      │
│                                              [在此处回答（兜底）]│
├────────────────────────────────────────────────────────────────┤
│ 汐音 · 代你  │ 需求：支付回调失败后按通道重试…                  │  ← 琥珀左边条
│ 作者         │ 走哪个通道？ ○短信 ○邮件                          │
│ 汐音 · 代你  │ 决策：短信（逐字）；理由与边界：只做通道验证      │
└────────────────────────────────────────────────────────────────┘
```

- 默认 composer 隐藏，顶部条常驻；
- 「在此处回答」是显式开关，打开后才出现输入框（**例外路径**，反向同步逻辑保留）；
- 代理消息与 doer 消息在样式上必须可区分（左边条 + 标签 + 头像位），否则追溯时看不出谁是谁。

### 5.6 「从 attention 到答完」的交互转移

这段是本次改动的体验核心：从左边编队点一条，到答完回到主对话，中间每一步
都必须让人清楚**自己在回答哪一条**。

| # | 状态 | 触发 | 屏幕上发生什么 | 文案 / 控件 |
|---|---|---|---|---|
| 1 | `idle` | — | 编队条常驻；composer 是全局指令 | 占位符「对汐音说…」 |
| 2 | `pending` | 点 attention「在对话里回答」 | 浮窗展开 → 目标卡滚动到视口中央 + 高亮脉冲 1 次 | 卡片自动展开 |
| 3 | `focused` | 卡片获得焦点 | 顶部出现焦点条：`正在回答 #1 支付回调 · 通道选择` + `× 取消焦点` | composer 占位符变为「回答 #1…」；快捷回填一排选项 |
| 4 | `composing` | 人开始输入 / 点选项 | 卡片保持高亮；其余待决卡降到 60% 透明 | 键盘 `1/2/3` 直接选项，`↵` 提交 |
| 5 | `submitted` | 提交成功 | **卡片立刻**变只读并插入回执（不等助理回合） | `✓ 已记下：短信 · 汐音正在转达…` |
| 6 | `relayed` | 助理回合完成 | 回执更新 | `✓ #1 按「短信」交代下去` |
| 7 | `next` | 还有待决 | 焦点自动移到下一条，顶部提示 `下一条：#2 登录重构` | 无需再点左栏 |
| 8 | `idle` | 没有了 | 焦点条收起 | 占位符恢复 |

三条实现纪律：

1. **卡片先变只读，再等转达**（第 5 步）。转达可能慢、可能失败，但"我已经答了"
   必须在 100ms 内可见；否则人会重复点。
2. **草稿按 askId 保存**。在 #1 打了一半切到 #2，回来时草稿还在，不会把 #1 的话
   发到 #2 上。
3. **回执必须带 handle**。`✓ #1 按「短信」交代下去` 比 `✓ 已转达` 有用得多 ——
   多条线并发时，后者等于没说。

> 视觉上，"焦点条"是这套交互的锚点。没有它，人只能靠卡片位置猜自己在答哪条；
> 有了它，切换任务变成一次显式操作而不是一次滚动。

## 6. 助理的三项新职责

### 6.1 意图编译（brief）

派发前，把人的自然语言编译成一份可执行的 brief：

```jsonc
{
  "goal": "支付回调失败后按通道重试，先验证通道可用性",
  "done_when": ["失败回调按配置通道重试一次", "有可查询的重试记录"],
  "constraints": ["不改现有支付主链路", "本 phase 不落库持久化"],
  "non_goals": ["多通道降级", "补偿对账"],
  "refs": ["src/pay/callback.ts"],
  "autonomy": "checkpoint",          // approve | checkpoint | hands-off（design 24 §10）
  "decide_by": "human-in-loop"
}
```

派发时的 wake 消息改成**两段**（替换掉现在的 `需求原文（转发，不改写）`）：

```
[汐音 · 代用户转达] 任务「支付回调重试」
授权：mandate=explicit · clarify=ask · autonomy=checkpoint

## 意图（汐音编译，可执行）
goal / done_when / constraints / non_goals / refs …

## 用户原文（逐字，权威）
<人的原话>

冲突时以「用户原文」为准；brief 与原文有出入，先问，不要自行取舍。
```

- **原文保真 + 意图编译**：brief 负责"明确"，原文负责"权威"；
- brief 落 `cabin_job_events(kind='brief')`，并作为任务线程第一条 proxy 消息；
- 主对话里展示一句可展开的「我会这样交代：…」，人可以当场改；
- 确认策略按档位：`inferred` 或影响验收物 → 先出确认卡；`explicit` 直接派发但保留回退入口。

### 6.2 决策转达（relay）

现状是卡片把答案**机械转发**给 doer（`用户回答了以下问题：…`），助理全程没参与。
新路径：

```
人在卡片上选「短信」
   ↓  (server 端写一条 [决策] 用户消息到主会话，可靠落库)
汐音回合：确认 + 补充边界
   ↓  cabin_relay_decision({ askId, taskId, choice, framing })
任务线程收到 proxy 消息：
   决策：短信（逐字，权威）
   理由与边界：只做通道验证；本 phase 不落库；其余按原计划
```

关键约束：

- **verbatim 块不可改**：选择本身逐字来自卡片的 option label；
- `framing` 只允许补充边界、理由、影响，不允许改选择、不允许加新条件；
- 幂等键 `askMessageId`；同一 ask 重复 relay 不重复写；
- **保底**：助理回合失败 / 主会话忙 / 超时（如 20s）→ 自动落回机械转发，
  并在主对话补一条"已直接转达（助理未参与）"。**绝不丢答案**。

### 6.3 编队感知（snapshot）

已有通道：`chat-routes.ts:384` 每回合把 `buildCabinSummaryReminder()` 作为
transient reminder 附在用户消息上（不持久、不污染系统提示）。

升级内容（`cabin-tools.ts:29`）：

```
[编队] Aurora · active · 运行 2 · 待你 3
#1 支付回调  待拍板(answer)  P1·R2   ← 焦点
#2 登录重构  执行中           P2
#3 周报      待验收(review)
最近回执：#1 按「短信」交代（2 分钟前）
自决模式：auto · 默认档位 checkpoint
纪律：一次只处理一条决策；不代答；不改用户的选择，只补边界；不确定就问。
```

现在的这一行要改掉：

> ~~"出 stage=answer 的「待回答」时把用户送去任务线程，不要代答。"~~

改成：

> "出 stage=answer 时，在主对话把信封摊开给人；人答完你用 `cabin_relay_decision` 代述，
> 不要让人切线程。用户原文逐字，你的补充另起一段。"

## 7. 决策状态机

```
asked ──shown──▶ shown ──human_decides──▶ decided ──relay──▶ relayed ──doer_ack──▶ acked
                    │                        │
                    │                        └──relay_timeout/fail──▶ fallback_relayed
                    └──task_ended──▶ expired
```

| 状态 | 触发 | 落点 | 失败处理 |
|---|---|---|---|
| `asked` | doer 调 AskUserQuestion | authorAsk 卡（任务线程）+ 镜像卡（主对话） | — |
| `shown` | 卡片进入主对话转录 | 无需额外写 | 前端轮询/SSE 断 → 刷新可见 |
| `decided` | 人在主对话提交 | `activity.decision` + `[决策]` 用户消息 | 提交失败 → 卡片保持可点 |
| `relayed` | 助理调 `cabin_relay_decision` | 任务线程 proxy 消息 + `cabin_job_events(decision)` | 超时 → 机械转发 |
| `acked` | doer 继续推进（下一条消息/状态变化） | 回执条更新为"作者已继续" | 论文式误判：以 doer 消息为准 |
| `expired` | 任务 done/failed/aborted | 卡片置灰「任务已结束」 | — |

**冲突**：同一 ask 在主对话和任务线程兜底各答一次 → **先到者胜**；
后到者只写一条"已按先到的决定执行"提示，不覆盖。

### 7.1 决策归属：票据、焦点、队列

这是本设计里**最容易出事故**的地方：左边同时有多条 attention，人点开一条、
答完立刻去答另一条。如果系统靠"当前屏幕上显示的是哪张卡"来判断归属，
一次快速点击就可能把 A 的决定送给 B。

#### 三个真相源，主次必须分明

| 来源 | 作用 | 权威性 |
|---|---|---|
| **票据（ticket）**：提交体里携带的 `askId` | 决定这条答案属于哪一问 | **唯一权威** |
| **焦点（focus）**：UI 上的高亮 + composer 绑定 | 帮人理解"我现在在答哪条"；帮自由文本落到正确 ask | 仅提示 |
| **账本（ledger）**：服务端 decision record | 幂等、可重放、可审计 | 事实 |

**规则一：提交永远自带票据。** 卡片提交时从卡片自身的 payload 里取 `askId`，
不从"当前 focus"或"当前滚动位置"取。focus 只影响自由文本的解释，不影响点选提交。

**规则二：账本是幂等的。** `(askId)` 唯一；重复提交返回同一条 record，
前端把卡片置灰并提示"已经答过（你选的是 X）"，不重复转达。

#### 票据形态

```jsonc
{
  "decisionId": "d-7f3a",          // 服务端生成
  "askId": "ask_7f3a",             // = 作者线程那条 assistant 消息 id（现有 askMessageId）
  "taskId": "t-123",
  "taskHandle": "#1 支付回调",
  "choice": "短信",                 // 逐字来自 option label
  "note": "只做通道验证，本 phase 不落库",  // 人的补充（可空）
  "source": "card",                // card | composer | thread_fallback
  "focusAtSubmit": "ask_7f3a",     // 提交瞬间 UI 认为的焦点（仅用于诊断）
  "submittedAt": "2026-11-16T10:02:11Z"
}
```

`focusAtSubmit` 与 `askId` **不一致时不报错**，只记一条诊断日志 —— 它存在的意义是
事后能判断"是归错了，还是人在两张卡之间来回切"。归错的责任永远在提交体，不在焦点。

#### 主会话里长什么样

每条决策在主会话里是一条**结构化用户消息**（不是自由文本）：

```
[决策 · #1 支付回调 · ask_7f3a] 短信
（逐字）短信
（补充）只做通道验证，本 phase 不落库
```

- 方括号里三个字段就是机器可读的部分：handle 给人、askId 给助理；
- `（逐字）` 行是权威，`（补充）` 行是人的附加要求；
- 助理的回合必须**先复述归属**：「收到 #1 的通道选择：短信」，再转达。
  这句复述是给人的最后一道校验 —— 归错了人当场就能看见。

#### 快速连答：合并回合，绝不合并决策

```
t0  人答 #1        → record D1(ask_7f3a)   → 主会话 [决策 · #1 · ask_7f3a]
t1  人立刻答 #2    → record D2(ask_9c11)   → 主会话 [决策 · #2 · ask_9c11]
t2  汐音一个回合    → relay(D1) + relay(D2)      ← 回合可以合并
t3  两条回执        → ✓ #1 …   ✓ #2 …            ← 决策不合并，各自独立
```

- 主会话正在流式输出时，新决策**排队**，不丢弃、不与当前回合抢锁；
- 排队中的决策写进下一回合的 transient reminder（`待转达：D1 #1 · D2 #2`），
  所以即使中间插进一句无关对话，助理也不会把它们忘掉；
- **每条决策各自有 watchdog**：超过 20s 未转达 → 单独机械转发。
  合并回合只是省调用，不能成为丢失的理由。

#### 自由文本怎么落到正确的 ask

| 场景 | 行为 |
|---|---|
| 有焦点，输入框发送 | 绑定到焦点 askId，`source: composer` |
| 有焦点，但人先点了另一张卡 | focus 切换 → **草稿按 askId 分别保留**，不会串 |
| 无焦点，文本明显是回答（"用短信"） | 助理**不许猜**：回一句"这是在回 #1 还是 #2？"，只问一次 |
| 无焦点，文本是普通指令 | 正常对话，不产生 decision |

#### 工具层的硬校验

`cabin_relay_decision({ askId, taskId, choice })` 在服务端校验：

1. `askId` 存在且状态为 `decided`；
2. `askId` 所属任务 === `taskId`；
3. `choice` ∈ 该 ask 的 options（逐字匹配，允许 `note` 附加）。

任一不成立 → 拒绝并返回正确映射（"ask_7f3a 属于 #1 支付回调，当前可选：短信/邮件"）。
**归属正确性不能只靠 prompt 纪律，必须有一层确定性校验。**

**冲突**：同一 ask 在主对话和任务线程兜底各答一次 → **先到者胜**；
后到者只写一条"已按先到的决定执行"提示，不覆盖。

## 8. 代价与降级

| 代价 | 量级 | 处理 |
|---|---|---|
| 每条决策多一个助理回合 | +1 次 LLM 调用 / 决策 | 只在"实质决策"走；机械转发作为 fast path |
| 主对话变吵 | 状态卡合并、摘要折叠 | §5.1 密度分级 |
| 转述漂移 | verbatim 块 + 原文附后 | 一致性测试：verbatim 必须等于 option label |
| 主会话忙 | 409 | 服务端排队；超时走机械转发 |
| 任务线程被弱化后难调试 | 证据面保留完整 | 不做裁剪；只把"作答"降级 |

## 9. 改动清单

### Shared / DB

1. `packages/shared/src/types/cabin.ts:13` — `CabinJobEventKind` 加 `'brief' | 'decision'`。
2. `packages/server/src/db/types.ts:736` — 同步。
3. `packages/shared/src/types/cabin.ts` — 新增 `CabinBriefSchema`、`ProxyTurnSchema`、
   `DecisionStateSchema`（纯类型，不迁移）。

### Server

4. `packages/server/src/services/chat/cabin-tools.ts`
   - 新增 `cabin_write_brief`（可选：brief 也可直接由 dispatch 参数带）；
   - 新增 `cabin_relay_decision({ askId, taskId, choice, framing })`；
   - 重写 `buildCabinSummaryReminder`（§6.3，含 handle、焦点、待决、最近回执、新纪律）；
   - `mcp-catalog.ts` 增补两个工具的描述与 `CABIN_TOOL_NAMES`。
5. `packages/server/src/services/cabin/cabin-comm-service.ts:61`
   - `dispatch()` 接受 `brief`，wake 模板改为两段式（§6.1）；
   - `appendEvent('brief')`；
   - 新增 `relayDecision()`：写 proxy 消息到 doer 会话 + `appendEvent('decision')`。
6. `packages/server/src/services/cabin/cabin-decision-service.ts`（新）
   - **票据**：`submitDecision({askId, choice, note, source})` → 幂等 record；
   - 状态机（asked→shown→decided→relayed→acked / expired）；
   - **决策队列**：主会话忙时排队；reminder 暴露 `待转达` 列表；
   - **每决策 watchdog**（20s）→ 机械转发保底；
   - `[决策 · #handle · askId]` 结构化消息注入主会话（§7.1）；
   - 冲突仲裁（先到者胜）。
7. `packages/server/src/routes/cabin/*`（新路由）
   - `POST /api/cabins/:id/decisions` — 提交决策（校验票据 + 落库 + 排队唤醒 + 返回 receipt），
     让浏览器不再直接对 doer 发流（去掉 409 竞态）；
   - 校验：`askId` 存在 / 状态 decided / 属于 `taskId` / `choice` 逐字命中 options；
     失败返回正确映射，不静默接受。
8. `packages/server/src/services/activity/chat-event-bridge.ts`
   - `requestAuthorAskCard` 落 design 24 信封字段；
   - authorization：卡片带 `taskHandle`；
   - `markAuthorAskAnswered` 写回执；
   - **新增**：同一任务的里程碑在主对话侧合并进摘要（不再逐条 append）。
9. `packages/server/src/routes/agent/chat-routes.ts`
   - 捕获 `fullContent` → `parseDecisionEnvelope`（design 24 §6）；
   - 非 thread 且 cabin 绑定：挂 `octopus-cabin`（已有），确认新工具可见。

### Server · 独立委派（§4.2，P4）

> 单独编号，避免和上面 P0/P1 的条目混在一起。

- D1. `packages/server/src/db/schema.sql` — 新增 `CREATE TABLE IF NOT EXISTS cabin_delegations`
  （`applySchema` 每次全量执行，老库自动补表；**不动** `cabin_jobs.kind` 的 CHECK）。
- D2. `packages/server/src/db/dao/cabin-delegation-dao.ts`（新）+ `db/types.ts` 行类型。
- D3. `packages/server/src/services/cabin/cabin-delegation-service.ts`（新）
  — 创建 / 派发 doer 会话 / 状态迁移 / 取消 / 汇总 result_summary。
- D4. 读侧归一化：`listJobsView`、`deriveCabinView`、`gatherAsks`、
  `requestAuthorAskCard` / `markAuthorAskAnswered`、`fleet-model` 五处（§4.2 表）。
- D5. 工具：`cabin_delegate_task`（派发轻活）+ `mcp-catalog` 描述；
  `cabin_relay_decision` 的 `taskId` 泛化为 `subject: { kind, id }`。

### Web

10. 主对话转录组件（新）：任务脊线 / handle / 颜色 / 四类密度。
11. `components/agent/chat/author-ask-inbox.tsx` → 升级为**决策队列**（分组、键盘、自动下一条）。
12. `components/agent/chat/author-ask-card.tsx` → 决策面板（envelope 上下文 + 提交走新端点）。
    - 提交体**从卡片 payload 取 `askId`**，不从 UI 焦点取；
    - 提交成功立刻置灰 + 插回执（不等转达）。
13. `components/agent/chat/ChatPane.tsx`
    - 任务线程只读条 + `在此处回答（兜底）` 开关；
    - proxy 消息样式（`汐音 · 代你`）。
14. `components/cockpit/face/CockpitAttentionFace.tsx` / `components/cabin/job-face.tsx`
    - 主 CTA 改为**在主对话处理**（`octopus:open-ask`），次 CTA 才是去任务对话。
15. **焦点条**（新）：`正在回答 #1 · 通道选择 ×`，随决策卡展开/收起；
    - 草稿按 `askId` 分桶保存（切换焦点不串）；
    - 提交后自动落到下一条待决卡；键盘 `1/2/3` + `↵`。
16. composer 焦点作用域（`#N` + focused_job_id）：无焦点时自由文本不自动算作回答。
16.1 委派在编队里用 `D1` 段位（与 `#1` 区分），深链 `delegation:`；
     点开进入同一个证据面（doer 会话），但**不出现验收 / 归档 tab**。

### Prompt

17. 汐音（舱主对话）persona：三项职责（编译 / 转达 / 编队），以及"不代答、不改选择"。
18. `task-author` persona：说明"你对话的人是汐音（代用户），不是用户本人；
    跨会话回答会以汐音代述形式到达，verbatim 行为准"。
19. 两份逐字副本同步（`persona.md` + `builtin-clones.ts`）。

### 测试

- 状态机：asked→decided→relayed→acked；超时回退；重复提交幂等；两处作答先到者胜。
- **归属**：提交体缺少 askId / askId 与 taskId 不匹配 / choice 不在 options → 全部拒绝并返回正确映射。
- **快速连答**：连续提交 D1、D2 → 两条 record 独立、两条回执；一个助理回合转达两条；
  其中一条转达失败不影响另一条（各自 watchdog）。
- **焦点**：`focusAtSubmit ≠ askId` 时归错不发生（以 askId 为准），只记诊断日志。
- **草稿**：在 #1 输入一半切到 #2，回到 #1 草稿仍在，且发送后落到 #1。
- 转述保真：verbatim === option label（属性测试）。
- 密度：10 个任务交替更新 → 主对话卡数不随里程碑线性增长。
- 只读：任务线程默认无 composer；打开兜底后可发；发完主对话镜像卡变灰。
- 快照：reminder 含 handle / 焦点 / 待决 / 待转达队列，且不进系统提示（transient）。

## 10. 分阶段

| 阶段 | 内容 | 为什么这个顺序 |
|---|---|---|
| **P0** | design 24 信封 + 回执；决策队列；attention CTA 改主对话 | 先让人"在原地就能答清楚"，不改路径 |
| **P1** | 决策收口：任务线程只读 + `[决策]` 消息 + `cabin_relay_decision` + 保底转发 | 路径切换，必须带保底 |
| **P2** | 意图编译 brief：dispatch 两段式 + 主对话确认卡 | 需要 P1 的 relay 通道已稳定 |
| **P3** | 编队感知升级：handle/颜色/摘要合并/焦点作用域 | 纯 UI + 快照，风险最低但依赖前两步的数据 |
| **P4** | **独立委派实体** `cabin_delegations` + 5 处读侧归一化（§4.2） | 需要 P1 的 relay 与 P3 的 handle 都已稳定，否则两种实体在编队里会打起来 |
| **P5** | 多执行体 `WorkEnvelope`（design 24 §7 P2） | 单执行体都收不住的信封，接多个只会更乱 |

P0 与 P1 可以并行开发，但**P0 必须先在真实任务上跑通**，否则 P1 会把一个不完整的信封
固化成协议。

## 11. 验收（按用户体验写，不按功能写）

1. 舱里派发任务后，**一整天不打开任务线程**，也能完成：澄清、拆分批准、验收、归档。
2. 任意时刻问"我现在有几个任务、各自卡在哪"，主对话顶部能直接看到，不需要点开编队。
3. 三条任务同时提问，能逐条答完，且每答一条都有回执照；不会把 A 的答案送给 B。
4. 打开任务线程，能明确区分"这是汐音代我说的"与"这是作者说的"，并且能一路回溯到我的原话。
5. 助理转述过一个决定后，任务线程里那条消息的 verbatim 行与我当时点选的选项**逐字一致**。
6. 主对话滚动 100 条后，仍然是"决策为主、摘要为辅"，没有被状态卡淹没。
7. **连答**：连着答 #1、#2 两条，两条决定各自送到正确的任务；界面上两条回执都带 handle，
   没有一条被合并或丢失。
8. **归属可见**：任何时刻，屏幕上都有一处明确写着"你正在回答哪一条"（焦点条）；
   答完后它自动移到下一条，不需要回左栏重新点。
9. **委派**：说一句「帮我把这三个方案对比一下」，不建任务、不出 phase、不进验收；
   跑完在主对话留一条结论 + 产物引用；编队里显示 `D1`。
10. **两种实体共存**：任务与委派同时在跑时，handle / 颜色 / attention 不冲突，
    决策卡各自找回自己的主人（不会把委派的答案送给任务）。

## 12. 风险与反直觉点

- **最容易被做错的地方**：把"助理代述"实现成"助理重新理解一遍再转达"。
  一旦如此，doer 收到的就不再是人的决定。→ verbatim 块 + 一致性测试。
- **第二容易做错**：主对话为了"信息全面"重新变成日志流。→ 密度分级是硬约束。
- **第三**：把任务线程彻底锁死，出问题时没有干预点。→ 兜底开关必须保留且显眼。
- **反直觉**：决策收口会增加主对话的**责任**而不只是便利 —— 人不能再以"我在任务线程里
  说过"作为借口，所有决定都在一处留痕。这是收益，但要提前接受。

## 13. 明确不做

- 不做多执行体统一调度（P4）。
- 不改 `AskUserQuestion` 的 tool schema（SDK 内置）。
- 不取消任务线程的作答能力（兜底是设计的一部分）。
- 不让助理替人做不可逆 / 花钱 / 授权类决定（档位 `approve` 覆盖）。
- 不把原文翻译/摘要后丢弃原文。

## 14. 已拍板（2026-11-16）

| # | 选择 | 结论 | 对实现的影响 |
|---|---|---|---|
| 1 | relay 范围 | **全部经汐音转达**，仅超时 / 失败 / 主会话不可用时回落机械转发 | 每条决策 +1 次模型回合；`cabin_relay_decision` 成为主路径，机械转发降为 watchdog 分支 |
| 2 | brief 确认 | **按授权分级**：`inferred` 或影响验收物 → 先确认；`explicit` 直接派发但展示可回退 | 需要 `autonomy` / `mandate` 参与派发前判断；brief 永远是"可回退"的，不做硬门禁 |
| 3 | 轻量委派载体 | **独立实体**（`cabin_delegations`），不并入 `tasks` | **本文件里代价最大的一项**，见 §4.2；编队 / attention / 桥都要支持第二来源 |
| 4 | 同屏决策数 | **最多 3 张展开**，其余折叠；答完焦点自动下一条 | 决策队列需要分组 + 折叠 + 键盘导航 |

第 3 项与本文初稿的建议不同（初稿建议并入 `tasks`）。选择独立实体是对的长期结构，
但它把成本集中到了**读侧适配**：任务与委派从此是两种工作实体，而编队、attention、
决策卡、桥都只有一个入口。§4.2 就是为此写的。

## 15. 如果只做一件事

做 **P1 的 relay 通道 + 任务线程只读**。

理由：信封（P0）解决"看不看得懂"，relay 解决"要不要切来切去"。
你这次的核心诉求是后者 —— 人只在主对话里把事办完。
brief 编译和编队美化都是让它更顺，不是让它成立。

## 16. 文档 ↔ 脉络图的双向同步

这份文档和 `docs/cabin-design/cabin-chat-flow.html` 是**同一个设计的两种表达**：
文档给实现者，图给决策者。两者不同步时，以文档为准，并且必须当场改图 ——
否则实现出来的是文档，验收时用的是图，中间就会出现"看起来对了、用起来不对"。

### 16.1 对应关系

| 本文件 | 脉络图章节 | 同步触发条件 |
|---|---|---|
| §2 角色模型 | 1 · 全景 | 增删角色 / 改职责 |
| §3 不变式 | 首屏"三条不变" | 改动任何一条 |
| §5.1 密度分级 | 4 · 双会话 | 改主对话收什么、任务线程收什么 |
| §5.2–5.4 编队 / 队列 / 输入框 | 2 · 决策归属 | 改焦点、票据、队列行为 |
| §5.5 任务线程只读 | 4 · 双会话 | 改兜底开关 |
| §4.2 独立委派实体 | 1 · 全景（执行线）· 6 · 分阶段 | 委派实体或读侧归一化变化 |
| §6.1 brief | 3 · 时序 A 段 | 改派发消息结构 |
| §6.2 relay | 3 · 时序 B 段 | 改转达路径 |
| §7 状态机 | 2.6 状态流转 | 加状态 / 改仲裁 |
| §10 分阶段 | 7 · 断点 | 阶段顺序或范围变化 |

### 16.2 硬规则

1. **图必须标注状态**：每个要素带 `已落地` / `P0` / `P1` / `P2` 标记。
   图不能只画"未来"，否则没法判断哪些是现状。
2. **图的页脚必须写"对应当前设计：25 · <日期>"**，文档改动未同步到图时，
   在 §16.3 记一行未同步项。
3. **改流程必须同时改两边**：只改文档会让实现者失去"用户看到的画面"这一约束；
   只改图会让实现者没有可执行的细节。
4. **图不引入文档没有的概念**。图里出现一个新框（比如"决策队列"），
   文档必须有对应小节；反之亦然。
5. 验收时**用图走一遍**：照着图的时序用手指点一遍界面，任何一步点不出来就是没做完。

### 16.3 待同步项

| 日期 | 改动 | 图状态 |
|---|---|---|
| 2026-11-16 | **四个选择已拍板**（§14）：relay 全走汐音 / brief 分级确认 / 委派独立实体 / 同屏 3 张 | 已同步（图 1 · 6） |
| 2026-11-16 | 新增 §4.2 独立委派实体 + 5 处读侧归一化 | 已同步（图 1 · 6） |
| 2026-11-16 | 脉络图升级 **v2 · 指挥台版**（三角色 / 决策归属 / 密度分级 / 分阶段） | 已同步 |
| 2026-11-16 | 新增 §7.1 决策归属（票据 / 焦点 / 队列） | 已同步（图 2 节） |
| 2026-11-16 | 新增 §5.6 交互转移 | 已同步（图 2.4） |
| 2026-11-16 | 新增 §5.1 密度分级（里程碑合并为摘要） | 已同步（图 4 节） |
| 2026-11-16 | **P0–P4 实现完成**（§17） | 已同步（图页脚 v2.1） |

## 17. 实现记录（2026-11-16）

| 设计条目 | 落点 | 测试 |
|---|---|---|
| §3 I4 原文/转述分离 · §6.1 brief | `services/cabin/cabin-brief.ts`（`formatDispatchMessage`）、`cabin-comm-service.dispatch` | `__tests__/cabin-brief.test.ts` |
| §6.2 relay · §7 状态机 · §7.1 票据/账本/队列/watchdog | `services/cabin/cabin-decision-service.ts` | `__tests__/cabin-decision.test.ts` |
| §9.7 决策端点 | `routes/cabins.ts` `POST/GET /:id/decisions` | `routes/__tests__/cabins-decisions-routes.test.ts` |
| §4.2 独立委派 | `db/schema.sql` `cabin_delegations`、`dao/cabin-delegation-dao.ts`、`services/cabin/cabin-delegation-service.ts` | `__tests__/cabin-delegation.test.ts` |
| §4.2 读侧归一化 | `CabinService.listWorkView / getView`、`derive-cabin-view.ts`、`chat-event-bridge.resolveAskSubject` | 同上 + `cabin-g2-bridge.test.ts` |
| §4.1 handle / 颜色 | `shared/types/cabin.ts`（`cabinHandleFor/handleColor`）、`services/cabin/cabin-handles.ts` | `cabin-delegation.test.ts` |
| §6.3 编队摘要 | `services/chat/cabin-tools.ts` `buildCabinSummaryReminder` | `cabin-delegation.test.ts` |
| §5.1 回执 | `chat-event-bridge.appendAskReceipt`、`cabin-decision-service.appendReceipt` | `cabin-g2-bridge.test.ts` / `cabin-decision.test.ts` |
| §5.3 决策队列 / §5.6 交互转移 | `author-ask-inbox.tsx`（handle / 3 条折叠 / 焦点条 / 键盘）、`AskUserQuestionCard.hotkeyId` | `author-ask-inbox.test.tsx` |
| §5.5 任务线程只读 + 代述样式 | `ChatArea.composerHidden`、`ChatPane`、`TuiTranscript.proxyTurnOf` | `chat-area-composer-readonly.test.tsx` / `tui-proxy-turn.test.tsx` |
| §9.10 决策卡走新端点 | `author-ask-card.tsx`（票据 / 立即只读 / 信封上下文） | `author-ask-card.test.tsx` |
| §4.2 编队 D1 | `fleet-model.ts`（`delegation` 行）、`use-fleet-query.ts`、`CockpitFleetRail` | `fleet-model.test.ts` / `CockpitFleetRail.test.tsx` |
| §9.17–19 Prompt | `builtin-clones.ts`（舱调度者三项职责）、`core-pack/clones/task-author/persona.md` + 同文副本 | `plan-writeback-discipline.test.ts` |

**P5（多执行体 WorkEnvelope）**：本文件 §4 / design 24 §7 已给出 schema，但只有一个执行体
（舱任务）时收不住的信封，接多个只会更乱 —— 保留为类型与设计，等第二种外部执行体
真正接入时再实现。

**已知边界**：

- `waiting_input` / `failed` 的委派会进 attention；`running` / `done` 只进编队行，
  不进决策队列（跑一趟的小事不该占决策位）。
- 委派 doer 只挂 `cabin_delegation_done` 一个工具，不能派任务、不能建任务。
- 机械转发（watchdog 分支）保留 `用户回答了以下问题：` 兼容行 —— 任务线程里的
  问题卡靠它变只读，doer 的既有解析也认这个格式。
