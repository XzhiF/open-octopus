---
name: octo-wiki-curate
description: 策展人（archive 分身）写侧技能 — wiki 编译流程、冲突检测三型、git 写权纪律与 user_preference 写保护。仅分身层（clone-tier）分发，消费侧分身不可见不可用。
category: knowledge
tags: [wiki, curator, compile, review-queue, git]
---

# Octo Wiki Curate

## Purpose

你是知识策展人（Curator）。wiki 的一切写入只有你一条通道：
**审核队列 approve → 策展编译 → git commit**（spec D4 写入单一闸门）。
本技能定义编译流程、冲突复核与 git 纪律；服务端执行体是
`WikiCurateService.applyApprovedItem` → `WikiCompileService.compileEntry`，
你的职责是**生成合格的队列条目**并**绝不绕过闸门**。

## Trigger Conditions

- 审核队列出现 `rule` / `wiki-edit` / `wiki-split` / `case` 待审条目
- 用户/分身上报 stale（wiki_refs 附带「词条与实际不符」信号）
- 归档提炼产出候选规则（experience-merger / 票07 蒸馏）
- doctor 巡检提议（衰减退役、拆分整理 — P4 全量开放）

## Behavior Instructions — 编译流水线（写入路径全景）

```
① 素材（归档提炼候选/对话提议/踩坑检测/分身合并/衰减修订）
 → ② 候选入队 PendingItem{type: rule|case|skill|wiki-edit} + 冲突检测
 → ③ 审核（Web 队列 / 策展人对话 / auto_approve）
 → ④ 编译（策展人执行：合并近义·更新小节·超长拆分·断链校验）
 → ⑤ 落库（git commit · rebuildIndex · wiki_fts 同步 · wiki_articles 更新）
```

队列与审核 API：`GET /api/review/pending`；`POST /api/review/:id/action`
（`{action:"approve"|"reject"|"defer"|"edit", org, content?, userNotes?}`）。
approve `type:'rule'`（target 为 wiki 词条形态）与 `type:'wiki-edit'` 会触发策展编译通道，
commit message 自动携带审核引用 `[review:<pending item id>]`（git ↔ 队列审计链）。

编译纪律（服务端已技术强制，你要会**产出合格输入**）：

1. **唯一写入口**：落盘只走 `compileEntry`（异步，await），它内建票02 lint 闸
   （L1 容量 / L3 小节 / L4 INDEX 预算 / L5 断链·禁日期·禁超长代码块 / L6 规则形态）。
   编译被拒 = 条目退回队列，**不存在 appendFile 旁路，也不许造一个**。
2. **合并近义**：与现行规则归一化全等 → 并入现行锚点（不双写、不产生空提交）；
   高重叠同极性 → overlaps 浮出；高重叠极性相反 → contradicts 浮出。
3. **锚点**：新规则行取全库下一个 `oct-NNN`（`<!--#oct-NNN-->`），**永不复用旧号**；
   拆分/退役都不改变存活规则的锚点（effectiveness 不断链）。
4. **断链校验**：`[[wikilink]]` 目标必须存在，断链即编译失败。
5. **常青零日期**：正文禁日期；日期/溯源/审核由 front-matter `sources`（含
   `review:<id>`）、`LOG.md`、git history 三处承接。
6. **volatile 半衰期**：stability=volatile 必带 `review_after`（YYYY-MM-DD）；到期进队列。

冲突检测（蓝图保留，编译时复核）：

| 型 | 语义 | 处置 |
|----|------|------|
| contradicts | 新旧矛盾 | 审核 UI 红色警示，**必须二选一**才能 approve；批准后写面不阻断，冲突记入结果与 LOG |
| overlaps | 部分重叠 | 建议合并为一条（编译器给合并稿） |
| supersedes | 完全替代 | 旧规则行自动迁 `_retired/<anchor>.md`，带 `replaced_by` 指针，与 compile 同一 commit |

wiki-edit 修订草案 JSON（`content` 列）：
`{"kind":"wiki-edit","path":"business/xxx.md","replace":{"anchor":"oct-009","text":"新表述"},"supersedes":["oct-009"]}`
（也支持 `addRule` + `section`；`path` 必须域目录形态，退役目标必须真实存在——否则
`CURATE_SUPERSEDE_TARGET_MISSING` 退回队列）。

## Git 操作纪律

- wiki 根 = 独立 git repo（`~/.octopus/orgs/{org}/knowledge/wiki/`）；一次编译/拆分/修订一个 commit。
- 仓内 pre-commit hook 校验提交来源标记 `OCTOPUS_WIKI_COMMIT_SOURCE`：
  `curate`（服务通道，spawnGit 自动携带）| `manual`（人工维护）。
  **无标记的提交一律被拒**——这就是「写入单一闸门」的技术强制。
- 人工维护用 `OCTOPUS_WIKI_COMMIT_SOURCE=manual git commit -m "..."`。
- 禁止 `--no-verify` 绕 hook（防误写不防恶意，绕闸属恶意）。
- 详情看 `git show <hash>`；人读近史看 `LOG.md`（append-only，编译器自动写）。

## 写权红线

- **`user_preference.md` 永不进入自动写路径**。策展通道对它只有
  「AI 辅助编辑建议 → 人确认」形态（`WikiCurateService.preferenceEditSuggestion`），
  零自动改写；hook 层对 curate 标记 + 触及 preference 的提交同样拒绝。
- 你不直写词条文件、不手改 INDEX.md/LOG.md（导航层由编译器程序化重建，永不经 LLM/人手写）。
- 退役区 `_retired/` 只进不出（replaced_by 指针可追溯）；消费侧分身没有本技能，
  它们只有只读 `octo-wiki` 的查阅纪律。
