# 03 — task-author SKILL：衔接信道事实节 + 起草纪律 + 入队自查

## What to build

`packages/core-pack/skills/task-author/SKILL.md`（ADR-0018 §6 纪律载体=SKILL 不写 server 代码）：

1. **新节「phase 衔接信道」**：事实段 — handoff.md 由 ship 每轮产/覆写于批次目录；accepted→下一 phase 时 server 自动注入 `prev_handoff_paths`（内置键，登记到既有 v4 占位符词表节旁，标注**非占位符**）；消费前提是绑定 matt-spec-dev 或遵循同契约的流——**绑自定义流信道静默失效，拆分流推荐时须提醒**。
2. **起草纪律**：后继 phase spec 正文不抄前序接口/决策细节，改写「依赖 phase <i> 的 Confirmed Interfaces（运行时衔接信道读取）」——这是拆分表「依赖前序」列从人读到有真实信道支撑的反向锁。
3. **入队 gate 前自查**：拆分表「依赖前序」引用的 batch slug 全部存在。

改毕 `node scripts/sync-builtin.mjs`（skills 域适用）。

## Blocked by

01（注入键最终名/形态落定）、02（handoff.md 实际段落结构落定）— 文案须与实现对齐。

## Status

done

## Acceptance Criteria

- [x] AC1: SKILL 含衔接信道事实节，三要素齐（ship 产 / 自动注入 / 仅同族流消费+静默失效提醒）— §phase 衔接信道（SKILL.md :148-160，三环 + 边界含「绑自定义流静默失效须提醒」）
- [x] AC2: 起草纪律 + 入队自查条目存在，与 spec.md §Implementation（SKILL 段）逐句对照一致 — 拆 Phase 方法论 item 3「不抄前序」(:168) + §4 入队前自查 slug 存在性(:263)
- [x] AC3: 全文无与实现对不上的键名/路径（如把 prev_handoff_paths 写成占位符 `${...}`）— `grep '\${prev_handoff_paths}'` 零命中；词表登记处(:145)明确标注非占位符
- [x] AC4: sync-builtin 后安装库副本 = 源 — `[sync-builtin] skills: 34`；diff 两目标（`.claude/skills/` 与 `~/.octopus/agent/skills/`）均 identical

## Exploration

**Analog 研究**：本票是 SKILL 文档票（K5 文本档，无代码）。文案事实源 = Stage 0 已落地实现（95c0e7a5），逐处读码核对：

1. **server 半**（`packages/server/src/services/tasks/tasks-service.ts`）：
   - `collectPrevHandoffPaths(row, targetPhaseIndex)`（:2439）：`deriveView` 取 accepted 前序（index < target，**刚 accepted 的本 phase 也在集合内**，AC1 注记）→ `resolvePhaseSpecDir(configJson, p.index)` → `join(specDir,'handoff.md')` → `fs.existsSync` 过滤 → index 升序。
   - 注入点 ×2：`acceptance()` accepted→`dispatchPhaseRound(nextPhaseIndex,1,{prevHandoffPaths})`（:2189，autoAdvance 分支）与 `advancePhase()` 手动推进（:2374）——两处同行为确认。
   - 落位（:1789）：`workflow_chain[0].input_values.prev_handoff_paths = paths.join("\n")`，`?.length` 守卫 ⇒ **空 ⇒ 键不出现**；与 `feedback`/stamps 同段 append。rerun/fix 路由对象从不传 `prevHandoffPaths` ⇒ 同 phase 打回不注入，确认。
2. **产物半**（`packages/core-pack/workflows/matt-spec-dev.yaml` ship-pr 第 4 步）：头块 = 「phase 名与 batch slug · 终态轮次 rN · PR 链接 · 批次路径」；三段标题逐字 = `## Protected Decisions` / `## Confirmed Interfaces` / `## Gap Targets`；纪律 = 整页重写禁追加 / 一屏内 / 引用 round-report.md 不复制 / 只写 ws collect 回流。
3. **消费半**（同文件）：inputs 登记 `prev_handoff_paths`（描述含「内置键，非占位符，绑定表单无需手填」）；`spec-resolve` 逐行探测 → `vars.prev_handoffs`/`prev_handoff_count`，缺失静默跳过；消费提示词三处 = spec-review / ticket-dag 普通票 / ship-pr。绑定非 matt-spec-dev 流 ⇒ 键无人读 = 静默失效，与 K3/R4/R2 口径一致。

**目标文件既有结构**（`packages/core-pack/skills/task-author/SKILL.md`，339 行）：批次目录树在「Batch 目录与 phases 协议 §目录约定」（需登记 handoff.md 家族成员）；占位符词表节含「管理键自动注入」bullet（prev_handoff_paths 登记位）；拆 Phase 方法论 item 3 = 依赖排序（起草纪律挂旁）；写权环表（加 handoff.md 行）；§4 入队（自查条目挂此）；物化与执行环（autoAdvance 句加交叉链接）。版本惯例：每特性 bump minor（3.0.0→3.1.0 见 2a3a2d00）→ 本票 3.2.0。

**修改文件清单**：仅 `packages/core-pack/skills/task-author/SKILL.md` + 改毕 `node scripts/sync-builtin.mjs`（skills 域：→ `.claude/skills/` 与 `~/.octopus/agent/skills/` 两目标）。

**AC3 纪律**：全文不得出现 `${prev_handoff_paths}` 字面量（含反例示例——用「任何 `${...}` 写法」措辞规避）。

## Verification Method

**Verification type**: manual checklist

**Verification steps**:
```bash
node scripts/sync-builtin.mjs
grep -n "衔接信道\|prev_handoff_paths\|Confirmed Interfaces" packages/core-pack/skills/task-author/SKILL.md
```
对照 spec §Implementation Decisions（core-pack—task-author SKILL 段）三项逐条勾。

**Pass criteria**: AC1–AC4 全过
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
