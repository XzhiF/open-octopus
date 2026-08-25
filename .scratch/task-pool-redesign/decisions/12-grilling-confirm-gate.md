# 12 — Confirm gate：authoring → dispatch 交接 = 手动确认还是自动入队？

Type: grilling
Status: resolved
Blocked by: None

## Question

Spec（07=(i)）由 chatbot 产出后，`draft → queued` 的交接怎么做？

### (i) 手动确认（enqueue 按钮）★推荐
chatbot 产 spec → 落为 **draft**（看板 draft 列）→ 用户在 spec 预览卡点"入队"→ `queued`。
- 复用现有 `POST /jobs/:id/enqueue`（gap #2/#3 早就缺这个按钮——本决策直接关掉它）。
- 匹配你"创建草稿、确认需求面板"的直觉——面板就是确认动作宿主。
- draft = 审查态；复合任务可在 draft 态继续编辑 subunits / 调整 pin。

### (ii) 自动入队
chatbot 产完 spec 即 auto-queue，无人工审查。
- 快，但跳过审查；错配 `workflow_ref` 直接进调度。

### (iii) 可配
简单任务自动、复合任务手动（按 `subunits.length` 阈值或 workflow_ref 类型）。

## Recommendation

**(i) 手动确认**。"入队"按钮就是 confirm gate，同时关掉 gap #2/#3（预览卡无 enqueue）。draft 列即审查态，复合任务在此编辑 subunits。匹配你的 draft+confirm 面板直觉，且不丢 draft 这个有价值的中间态。

## Answer
**(i) — manual confirm via enqueue button.** User chose (i).

The enqueue button on the spec preview card IS the confirm gate: chatbot 产 spec → draft → user hits "入队" → queued. Closes gap #2/#3 (preview card had no enqueue). `draft` = review/edit state — composite tasks edit subunits / adjust pin here. Reuses existing `POST /jobs/:id/enqueue`.
