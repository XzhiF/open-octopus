# 08 — 归档 = 产物合并归位

Type: grilling
Status: resolved
Blocked by: ~~07~~（resolved）

## Question

末 phase 验收通过后的归档合并：ADR 编号冲突处理（全局顺延 or per-project）、CONTEXT.md/术语表合并策略（追加 or 人工合并？冲突）、.scratch batch 目录归位到各 project 的哪层（仓库 or 忽略，因为本来就在 worktree 分支上随 PR 进仓库？）、提交形态（直接 commit 到 task 分支 vs 独立归档 PR）、归档失败的可重试性（预留 hook）。

## Answer

Q8.1 裁决 A（五条全收），见 map D16。关键收窄：因 D15 seed 用物理拷贝进 worktree，`.scratch`/报告/issues 已随 phase PR 在仓库里——**归档面只剩 task home 草稿期独有件**：

1. **归并面**：task home 的 `docs/adr/` + `context-notes.md`（per-project 归属）合并进对应 project；其余不搬
2. **ADR**：扫目标 project 现有最大编号顺延重编号，文件名 slug 保语义，正文尾行记 task id 溯源
3. **CONTEXT.md**：append-only 绝不覆盖；同名不同义词条不自动合并，冲突清单进 PR 描述，人的裁决 gate=既有 PR review
4. **提交**：每受影响 project 的 task 分支加归档 commit（`chore(archive): <task> syncback <date>`）→ push → 并入开放 PR 或开独立归档 PR；archiving 卡住仅限 git 失败（人工冲突不阻塞状态机）；全部成功 → done
5. **回收**：done ⇒ ws 豁免解除（retention 闸条件="task 已归档"兑现），产物双落地（仓库+task home）后可安全回收
