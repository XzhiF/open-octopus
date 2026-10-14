---
name: octo-wiki-curate
description: 策展人（archive 分身）写侧操作手册 — 指向 SCHEMA.md 共演约定 + 编译 API 用法。纪律正文已入册 SCHEMA.md（知识中心票05），本技能只留指针与接口。仅分身层（clone-tier）分发，消费侧分身不可见不可用。
category: knowledge
tags: [wiki, curator, compile, schema, git]
---

# Octo Wiki Curate（瘦身版 · 知识中心票05）

## Purpose

wiki 的一切写入只有一条通道：**编译服务（唯一写闸）+ git commit**。审批队列已废除——
输入即审批，质控事后六道（溯源回指 / git 可逆 / lint 硬闸 / findings 对话裁决 / 写保护）。

本技能原先承载的**编译纪律 / 页格式约定 / 命名法 / 工作流**已整体迁入
`~/.octopus/knowledge/SCHEMA.md`（层 3 共演约定文档，每次编译前必读）。
**纪律文本以 SCHEMA.md 为准**；本文件只保留两件事：指向 SCHEMA + 编译 API 用法。

## Trigger Conditions

- 对话投喂（URL / 粘贴 / 本地文件）→ raw 落盘冻结 → 编译（Ingest 入口 A）
- 任务归档总结自动投喂 → `raw/archives/` → 编译（入口 B，属票10）
- finding 裁决后 fix-forward 重编译；巡检/体检触发（属票13）

## 先读约定（不在本技能重复正文）

1. `~/.octopus/knowledge/SCHEMA.md` — 三层契约 / 五类页格式 / 命名法 / 编译纪律 / 工作流
2. `~/.octopus/knowledge/wiki/INDEX.md` — 现库导航（程序化重建，≤800 token）
3. raw 源**全文** — 不可变真源；对质与重编译都凭它（front-matter 的 hash）

## 编译 API 用法（服务端唯一写闸）

| 要做的事 | 用法 |
|---|---|
| 投喂落 raw 并冻结 | `POST /api/knowledge/ingest`，body `{mode:"url"|"text"|"file", …}` → 200 raw 指针（path/hash/origin/bytes）；带 `?compile=true` 同时投递编译任务，响应多出 `compileTask:{taskId,status}` |
| 显式触发一次编译 | `POST /api/knowledge/wiki/compile`，body `{path:"raw/inbox/<文件>.md"}` → 202 `{taskId,status:"queued"}` |
| 查任务状态 | `GET /api/knowledge/wiki/compile/task/:id` → `task{status: queued→compiling→committed/failed, result?/error?}`；`result.touched` 即编译 DIFF 卡的触及页明细 |
| 分身/脚本直驱单次编译 | `CuratorCompileService.compileRaw(rawPointer)` — 多页编译单 commit、原子回滚、同 raw 幂等（diff 空）；这是票06 队列要整包互斥的原子单位 |

你经对话产出的是**合格输入**（选对 raw、说清要合入哪页），落盘由编译服务执行；
你不手写页文件、不手改 INDEX.md/LOG.md、不造旁路。锚点由服务发号（模型侧只许
`oct-NEW` 占位）；矛盾断言两页内标记 + finding 报对话，不静默覆盖、不阻塞编译。

## P3 资产化 API（票02/03/04 移交账兑现——owner 对话时代行执行的确定性端点）

| 要做的事 | 用法 |
|---|---|
| 看素材包 | `GET /api/knowledge/wiki/pack/:taskId` → 件清单（名/类/大小/sha/剔除态；旧单文件归档回 `{legacy:true}`） |
| 剔除某件 / 焦点重编译 | `POST /api/knowledge/wiki/pack/:taskId/recompile`，body `{excludePath?,focus?}` → 202（archive-compile 队列通道；「重点看 phase-2 打回那段」就是 focus 原文） |
| 判例退役 | `POST /api/knowledge/wiki/case/retire`，body `{caseId}` → 202（case-archive 队列唯一写闸；事后纠即时生效，**无 pending 态**） |
| 列 skill 草案 | `GET /api/knowledge/drafts` → `{drafts:[{name,status,origin,source,description,path}]}` |
| 读草案全文 | `GET /api/knowledge/drafts/:name`（`content` = SKILL.md 全文） |
| 改写草案（owner 说改哪里） | `POST /api/knowledge/drafts/:name/revise`，body `{instruction}` → 200（策展人改写 drafts 文件本体；status 恒 draft；granted/revoked 拒 409） |
| 退役草案 | `POST /api/knowledge/drafts/:name/retire` → 200（status→revoked 留档，不删文件） |

纪律：草案住知识根 `drafts/skills/`（非 wiki、非知识页、不进 INDEX）；**授予/撤销的
生效链不在本 API**（人裁治理边界——任何把草案手放进分身技能目录或发版本的动作都禁止）。
drafts 区不受 wiki 串行队列约束，但同样禁越界写 wiki/cases/user_preference/SCHEMA。

## Git 与写权纪律（不变项）

- wiki 根 = 独立 git 仓（`~/.octopus/knowledge/wiki/.git`）；一次编译一个 commit，
  整包可 revert（UI 一键回滚属票12）。
- 仓内 pre-commit 来源标记闸保留：服务通道 `curate`（spawnGit 自动携带）/ 人工
  `OCTOPUS_WIKI_COMMIT_SOURCE=manual`；无标记拒；自动通道触及人工文件拒。
- **`user_preference.md` 与 `SCHEMA.md` 永不自动改写**——策展人只出建议文本，人确认后落笔。
- 禁止 `--no-verify` 绕 hook（防误写不防恶意，绕闸属恶意）。
- 退役区 `_retired/` 只进不出；消费侧分身没有本技能，它们只有只读 `octo-wiki` 查阅纪律。
