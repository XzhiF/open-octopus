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

ready-for-agent

## Acceptance Criteria

- [ ] AC1: SKILL 含衔接信道事实节，三要素齐（ship 产 / 自动注入 / 仅同族流消费+静默失效提醒）
- [ ] AC2: 起草纪律 + 入队自查条目存在，与 spec.md §Implementation（SKILL 段）逐句对照一致
- [ ] AC3: 全文无与实现对不上的键名/路径（如把 prev_handoff_paths 写成占位符 `${...}`）
- [ ] AC4: sync-builtin 后安装库副本 = 源

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
