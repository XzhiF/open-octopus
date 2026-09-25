---
name: author-verified-requirement
description: Verification-driven requirement clarification — grilling or wayfinder dialogue that ends in one verified spec.md plus DAG issues/ for a single v4 task phase. Verification strategy is mandatory, not optional. Never executes; the bound workflow does, after the user enqueues.
dependencies: domain-modeling, grilling, wayfinder, research
---

# Verification-Driven Requirement Clarification

你是需求的**挑战者**，不是执行者。一次只问一个问题，每问都带上你的推荐答案；能自己查到的（代码、配置、环境）绝不问用户 —— 只问决策。术语与架构决策一落地就写盘。出口是一份验过的 `spec.md` + DAG `issues/`，交给**一个 v4 phase**，之后由它绑定的工作流执行，与本会话无关。

## 领域建模（两条路都并行做）

- **冒出新词或词义被澄清** → 先挑战（"你说的 account 是 Member 还是 User？两者不同概念"）→ 拿 CONTEXT-MAP.md、各包 CONTEXT.md 和代码交叉比对，主动报矛盾 → 立刻写进该去的地方：跨切概念（3+ 包在用）进 `CONTEXT-MAP.md` 词表，单包概念进 `packages/<name>/CONTEXT.md`（没有就按 CONTEXT-FORMAT.md 建）。有 CONTEXT-MAP 说明这是多上下文仓库，按当前主题推断落哪个。
- **ADR** 三条同时成立才写：**难以回退** / **无上下文会显得莫名其妙** / **确有替代方案被否**。落 `docs/adr/NNNN-slug.md`（按 `domain-modeling` 的 ADR-FORMAT），**绝不落 `<artifacts.dir>/`** —— 那是交付物暂存区，ADR 是项目级永久记录。

## 选路

开头 2-3 问后定型。**默认 Grilling**（快而轻）；局面一直铺开就升 Wayfinder。

| Grilling | Wayfinder |
|---|---|
| 1 个包、边界清楚、决策分支全看得见、~10 轮问得完 | 2+ 个包或边界糊、感得到决策却说不全、要靠地图记账、值得并行调研 |

**中途升级**：grilling 问出了自己还 phrase 不出来的雾 → 停下来提议转 Wayfinder，**用户确认才转**。

### Grilling 六维

一问一穿，别串行堆题：① 范围（做什么 / 明确不做什么）② 数据模型（哪张表、什么字段、缓存）③ 接口契约（路径、参数、响应）④ 前端交互（页面流、组件结构）⑤ **验证策略（核心，见下节硬闸）** ⑥ 验收（用户故事 + 可验 AC）。

### Wayfinder

1. **Destination** —— 一两行写清"跑到终点是什么样"。终点之外即 out of scope。
2. **Breadth-first grill** —— 横扫整个决策空间、哪条都不深挖，用 `/grilling` + `/domain-modeling` 把东西分进三堆：已经定了的 → Decisions so far；能精确成问题的 → decision ticket；感得到但还问不清的 → Not yet specified（雾）。
3. **`map.md`** 落在 `<artifacts.dir>/<feature-slug>/map.md`，节：`## Destination` / `## Notes`（CONTEXT-MAP 领域上下文、相关 ADR、既有偏好）/ `## Decisions so far`（每票一行 gist + 链接）/ `## Not yet specified` / `## Out of scope`。

**Decision ticket** 落 `decisions/NN-<slug>.md`，与实现票的 `issues/` 分开。四型：`research`（AFK，可起 `/research` 子代理查一手资料）、`prototype`（HITL，造完即弃、只留结论）、`grilling`（HITL，一问一答，**默认型**）、`task`（人工前置：开服务、申请权限、凑数据）。

```markdown
# NN — <Question>
Type: research | prototype | grilling | task
Status: open            # open → claimed → resolved
Blocked by: NN, NN (or "None")

## Question
<这张票要定下来什么>
```

**Blocking 第二遍再连**（票得先有号才能互指）。**frontier** = open ∧ 未阻 ∧ 未领，按号取最小。

**research 票并行跑**：领票落盘 → 起子代理，提示词只讲三件事 ——「研究 <票上的问题>；结论写进 <票路径> 的 `## Answer`，置 `Status: resolved`；只取一手资料（官方文档、源码、规格）」→ 期间主会话继续推 HITL 票 → 谁回来读谁的结论，更新 map 并把清掉的雾毕业成票。

**雾还是票**，判据是此刻能不能把问题说准 —— 不是能不能答它。说得准就开票，说不准就留在 Not yet specified。解票常清掉前雾 → 把毕业出来的雾转成新票并从雾段删掉原条目。**雾 ≠ 范围**：超出终点的进 Out of scope，雾只是"还不够利"。

**解票四步**：claim 落盘 → 按型执行（research 起子代理并行跑；prototype 建完记结论；grilling 一问一答；task 做完把凭据位置 / URL / 数据形状记下来）→ 票上补 `## Answer` 并置 `Status: resolved` → 更新 map（decisions 加一行、雾毕业、发现某票其实在终点之外就关掉挪进 out of scope）。**一个主会话只解一张非 research 票**，research 靠子代理并行。

**出口**：所有 decision ticket resolved ∧ map 里没有未毕业的雾 → 写 spec → 走查一问 → 写 issues/。

## 验证策略 —— 六维硬闸

> **写 spec 之前必须有一张专门的 decision ticket（如 `NN-grilling-verification-strategy`）把下面六维问全并 resolved。缺它 = spec 无效。** Wayfinder 路它在 breadth-first 阶段开出、写 map 出口前解掉；Grilling 路它是 Exit 前的最后一问。

1. **验证层级** —— unit（Service 方法）/ integration（API 串 + 交叉）/ browser E2E（Playwright）/ contract（VO ↔ TS interface 字段一致）/ manual checklist（没有自动化框架时的兜底）
2. **中间件连接** —— 哪张表、什么数据状态；哪个 key、什么缓存行为；文件存储、消息队列
3. **设计稿** —— Figma 链接与相关节点、保真度要求（像素级 1:1 还是粗对齐）、素材要不要下载后传 CDN
4. **测试数据** —— 用哪个账号、要预置什么、隔离前缀、测后怎么清理
5. **断言方式** —— API 断哪些字段到什么值、SELECT 什么期望几行什么值、缓存 GET/SCAN 期望什么、UI 该看见什么·**不该**看见什么
6. **前置** —— 环境（UAT / 本地 / 哪个分支）、依赖模块是否需先部署、token 怎么拿

## Exit conditions

两条路共同的硬条件：六维问全 → `spec.md` 落盘 → 走查一问已问且答案已记进 spec 的 `## Execution Decisions` → 选跑的话子代理已跑完、发现已摊给用户确认、spec 已按确认修过 → `issues/` 落盘。另：Grilling ≤15 轮；Wayfinder 决策票 ≤20 张（再多就该拆成另一轮 wayfinder）。

## Story walk-through —— 只问一次，答案必须由用户给

需求清完、spec 草稿写好，问用户**一次**要不要跑独立设计校验子代理。推荐依据：run = 面向用户的功能、跨模块数据流、复杂状态机；skip = 内部小重构、纯 CLI、单模块微调。**必须等到明确回答**，不许静默走默认；答案记进 spec `## Execution Decisions`。

选 skip 到此为止。选 run：

1. 起子代理读 spec 草稿，协议用本技能自带的 `references/story-walkthrough.md`（按 clone 目录解析绝对路径，如 `~/.octopus/agent/built-in/task-author/skills/author-verified-requirement/references/story-walkthrough.md`），允许它自己翻代码逐故事验证。它产两样：人读的 `story-walkthrough.md`（**只给人看，下游不消费**）+ 回给父会话的断裂点清单（CRITICAL/HIGH/MEDIUM/LOW + 建议修法）。**它不许改 spec.md。**
2. **把断裂点摊到用户面前逐条确认（硬闸）** —— CRITICAL/HIGH 每条都要带具体修法（补什么类型/schema/API、加哪条 AC、改哪条 Key Decision），MEDIUM/LOW 说清当场修还是记进 Risks。用户可以全认、否掉某条、给替代方案、自己加意见 —— **没拿到明确确认，不许动 spec**。
3. 按确认结果改 spec：实现决策补类型、AC 补条目、Key Decisions 记 "Story Gap Fixes"、用户意见一并吃进去。结构改动大就重跑一遍；故事轨迹贴进 spec Appendix。

**为什么交给子代理**：裁判 ≠ 球员 —— 作者查不出自己 spec 里的洞，独立读者才看得见。盯六反模式：**Magic Bridge / Orphan Field / Silent Failure / Missing Trigger / Unversioned State / Unconnected Feedback**。

## 产物

`<artifacts.dir>/<feature-slug>/`，slug 小写英文 + 连字符（如 `user-profile-edit`）：

```
brief.md                一页纸给人快审：Overview（一句）· Summary（决策数 / AC 数 / 故事数，各带跳 spec 的锚链接）· Risks · → spec.md。细表一概不放
spec.md                 唯一真相源 = 绑定流实现者的输入
story-walkthrough.md    仅 opt-in：人读报告，无下游消费
issues/                 DAG 实现票
map.md · decisions/     仅 Wayfinder 路
```

**本技能只产这些。** `round-report.md` / `handoff.md` / `fix-report-rN.md` / e2e 证据目录都是入队后执行侧在工作区里产的东西，这里一个都不许建。ADR 也不在此目录（见上）。

**顺序**：建目录 → brief → spec → 走查一问（选跑则校验并按确认改 spec）→ issues（**必含末张 `NN-e2e-*` 票**，细则见 `author-verified-tickets` ③④）→ 更新 `<artifacts.dir>/index.md` → 把路径报给用户，等 [入队]。

`index.md` 每次新特性追加一行：`| N | <feature-slug> | YYYY-MM-DD | feat/<branch> | in-progress |`

## Spec 骨架

写作细则在 `author-verified-spec`，这里是**节名契约**（下游按节名取东西，别改字）：

```markdown
# Spec: [Feature Title]

## Problem Statement     用户视角的问题
## Solution              用户视角的方案
## Projects Involved     - [ ] [project] ([role])  逐仓
## Feature Scope         **Do:** … / **Don't:** …
## Key Decisions         | # | Decision | Conclusion | Reason |   行与编号跨 phase 稳定：改行内、新增标 NEW-rN
## Execution Decisions   走查一问的答案落这里：| 1 | Story Walk-Through | run / skipped (user decision) | |
## Decision Map Summary  仅 Wayfinder：| # | Ticket | Type | Decision | + map.md 链接
## User Stories          穷举覆盖全特性：1. As a [role], I want [capability], so that [benefit]
## Implementation Decisions  模块增改 / 模块间接口 / 数据模型 / API 契约 / 缓存策略 / 架构决策
## Data Model Changes     | Table | Operation | Details |
## API Contracts          | Method | Path | Side | Params | Response | Notes |
## Design Specs           Figma 链接 + 保真度
## Verification Strategy
### Verification Environment   例：local dev `pnpm dev` · 前缀 `/api/` · SQLite `~/.octopus/db/octopus.db` · Admin UI `http://localhost:3000`
### Test Users & Data          账号 · 数据前缀 `E2E_TEST_` · 测后清理
### AC to Verification Method Mapping   | US# | User Story | AC | Verification Level | Verification Method |
### Verification Methods Detail  按 Unit / Integration / Browser E2E / Contract / Manual 分节写具体命令
免走查的 phase 在本段留一行字面量：`Verification Tier: unit-only`（引擎正则精确匹配，别改字、别加前后缀）
### Anti-Fake-Run Standards   R1 真服务不 mock · R2 断具体业务值 · R3 API↔DB 至少双向交叉 · R4 贴响应体 + DB 查询 · R5 写操作验 DB 副作用 · R6 真登录拿 token · R7 `E2E_TEST_` 前缀隔离 · R8 无手工前置可复跑
### Prerequisites            - [ ] …
## Risks & Notes
## Glossary               本次新增的领域术语 | Term | Meaning |
## Appendix: Core User Stories（闭环验证）   逐故事分步轨迹，步骤带 [UI]/[API]/[Data]/[Exec]/[Event] 标注
```

五条纪律：每个用户故事必绑验证方式；验证方式必可执行（具体命令，不是 "test the API"）；术语与 CONTEXT.md 一致；只写决策不写实现代码；不许缩小范围（"先做"「初版」一类措辞禁）。

## Issues

细则全在 `author-verified-tickets`（①–④），这里只补它没有的两条：

- `## Status` 下的值是纯文本四态：`ready-for-agent`（初始）/ `in-progress`（已领）/ `done`（验过）/ `skip`（重试耗尽）。绑定流的执行者读这个字段推进度。
- 末张 `NN-e2e-*` 票**恒产**（本 phase 唯一的端到端走查声明），AC 取自 spec 的 E2E 级 AC，`Blocked by` 指全部功能票。

## 与原始技能的关系

借 `grilling` 的一问一答、`domain-modeling` 的词表与 ADR、`/research` 子代理；**取代** `grill-with-docs`（文档与建模已内置，另加验证策略）；**改编** `wayfinder` 的协议（map / decision ticket / 雾 / frontier）成单入口并挂上验证策略，独立的 `/wayfinder` 仍在流程外可用。spec 与 tickets 的写作细则分别下沉在 `author-verified-spec`、`author-verified-tickets`，本文只管流程与契约。

## 出口

产物写完就把路径交给用户：

> spec 与 tickets 已就位 —— brief / spec / issues（N 票，M 个阶段）。你确认后入队，看板会按该 phase 绑定的工作流跑，每个 phase 末了都有人工验收 gate。

**你的活到此为止：不跑，也不提议跑。** 怎么实现、走查跑不跑、票怎么并行，都是入队之后由看板和流 YAML 决定的事 —— 不是你能拿去问用户的，也不是你能替它开工的。
