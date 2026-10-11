# 绑定存在即确认 — 入队闸 ⑤ bindingConfirmed 废除

日期:2026-10-10 · 状态:Accepted · 关联:amends task-phase-redesign 时代入队闸契约（chat-draft-v4 原型拍板 2026-09-24 落地的加严闸 ⑤，见 `task-materialize.ts` resolveV4Phases 头注释）；闸 ⑥（issues/ 产物基线）与 runbook 硬闸（2026-09-22）均不动

## Decision

**入队闸 ⑤ bindingConfirmed（「逐 phase 人工确认绑定」）废除：绑定存在且可解析 = 已确认。**

- **server**：`resolveV4Phases` 在 `enqueueChecks`（readyTask 入队路径）下不再检查 `phase.bindingConfirmed`，miss 码 `phase:<i>:binding-unconfirmed` 从此不再产出（契约退役，web 409 反解同步删分支）；launch 重解析路径本就不吃 ⑤，行为不变。
- **shared**：`TaskPhase.bindingConfirmed` **保留 optional 仅作 wire 兼容**（老任务行 / 老请求带本字段仍可解析，不破坏在途客户端），schema 标注 `@deprecated`；值不再被任何运行时逻辑读取。
- **web**：SpecPanel 入队清单删「绑定确认」整行（七行 → 六行，顶栏计数 N/7 → N/6）；添加 / 编辑 / 绑定弹窗保存一律不再写该字段（`workflowRef`/`inputValues` 照旧）；phase 卡上「已确认 / 待确认」角标移除。
- **authoring 流程**：对话里仍逐 phase 与用户确认绑定（task-author SKILL「确认 gate 两连」：拆分确认 → [入队]）——「确认」的语义落**在对话**，不再落弹窗保存仪式。

## Considered Options

- **保留 ⑤，把「弹窗保存」写入口扩到对话确认路径**（agent 确认一次即替用户写 bindingConfirmed:true）— 被否（用户裁决）：写入口从「人手点保存」变成「agent 代写」，人工确认反而更形同虚设；且要为纯仪式字段新增一条 spec-field 通路，协议面扩大、收益为零。
- **物理删除 bindingConfirmed 字段** — 被否：wire 兼容破在途请求与存量任务行（task_spec JSON 落库带该键），且 Zod strict 面删除会让老 payload 直接 400，属不必要激进。

## 为什么

双闸同义反复 + 对话确认与闸口径彻底脱节。② workflow-ref 已经拦「绑定不存在 / 不可解析」，③ 已经拦「必填 inputs 未填」—— ⑤ 在两者齐备之后还要人再点一次弹窗保存，不增加任何安全边际，纯属仪式。更致命的是：该字段**唯一写入口是看板绑定弹窗保存**（`phase-binding-dialog.tsx`），authoring 对话里经 REST `spec-field field=phases` 写回的绑定**根本不经过它**。现场案例（用户 2026-10-10 真机终裁动因）：任务「octopus前端多主题」对话里已逐 phase 确认绑定并写回，入队仍被「绑定确认 0/3」409 挡死——闸想拦的「没确认」拦不到，闸实际拦下的全是「确认了但没走对 UI 入口」的正常交付。

## Consequences

- 历史在队 / 老任务行为零扰动：`bindingConfirmed: true` 或字段缺失都不改变任何判定（launch 重解析从未吃 ⑤；入队重试点也不再读它）；字段留在 schema 里只是注释层面的 deprecated。
- 闸 ⑥（issues/ ≥1 票产物基线）与 runbook 硬闸原样保留——被废的只有「人工确认」这一个仪式维度。
- 测试面：server tasks-v4-gate ⑤ 用例翻为**正反回归**（绑定齐 + 产物齐，bindingConfirmed false/省略 → 200；缺 ref 仍被 ② workflow-ref 单因挡）；web 钉「confirm 行本地即拦」的用例翻为「confirm 行退役 + runbook 即拦保留」；shared 契约快照仍含该键（键集不变，doc 改口径）。
- SKILL 双份（`.claude/skills` 与 `core-pack`）「确认 gate 三连」→「两连」；`public/prototype/chat-draft-v4.html` 为历史设计快照，按惯例不回写。
