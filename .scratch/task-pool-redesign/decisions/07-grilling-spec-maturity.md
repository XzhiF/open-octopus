# 07 — Authoring chatbot 产多完整的 spec？（决定 workflow 入口阶段）

Type: grilling
Status: resolved
Blocked by: None

## Question

D3 定了 authoring chatbot = 新 task-author clone 产 spec。但 spec 产多完整？这决定 pin 的 workflow 从哪阶段起，也决定是否重复工作（chatbot 写 spec + workflow 再 clarify/spec）。

### (i) 结构化 spec 始终 + workflow_ref 选精炼深度 ★推荐
chatbot 始终产结构化 spec（goal / AC / 数据模型 / 契约）。pin 的 `workflow_ref` 决定入口：
- **execution-only spec-workflow（默认）**：消费 spec → 实现 → PR（不 re-spec）。
- **full xzf-dev（opt-in，复杂需求）**：clarify→spec→tasks→execution（re-elaborate）。
复合任务：chatbot 产 composition 级 spec（subunits + topology + integration goal），每 subunit pin 自己的 `workflow_ref`（深度可不同）。
- 匹配你早先倾向（"chatbot 创建 spec"、"像 coding agent 直观"、"不一定要跑工作流"）。

### (ii) chatbot 产粗 idea 始终 + pin 全 xzf-dev 精炼
chatbot 只产粗 idea；pin 的 workflow = 全 xzf-dev（clarify→spec→tasks→execution）。
- authoring 轻，但重度依赖 xzf-dev、可控性弱、token 重。

## Recommendation

**(i)**。结构化 spec 始终；`workflow_ref` 选深度（execution-only 默认，xzf-dev opt-in）。复合时每 subunit 独立 pin 深度。匹配你的 coding-agent 直觉 + "不一定要跑工作流"。xzf-dev 从"默认全流程"降级为"opt-in 精炼器"，桥接 gap #10。

## Answer
**(i) — structured spec always + workflow_ref picks depth.** User chose (i).

Chatbot always produces structured spec (goal/AC/数据模型/契约). The pinned `workflow_ref` decides entry stage: **execution-only spec-workflow (default, consume→implement→PR)** or **full xzf-dev (opt-in, clarify→spec→tasks→execution)**. Composite: each subunit pins its own depth. xzf-dev demoted to opt-in 精炼器 → bridges gap #10. Matches user lean ("chatbot 创建 spec", coding-agent 直观, 不一定要跑工作流).
