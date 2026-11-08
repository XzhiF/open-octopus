---
name: octo-workflow-supervisor
description: "工作流运行时守护 — 收到 [incident] 通知或用户问某次运行为什么失败/停了时，读证据、判断根因、用最小动作处理；不可逆或不确定时升级给人。只在 runtime supervision 场景使用。"
category: devops
tags: [workflow, incident, supervision, repair, escalation, runtime]
version: 1.0.0
---

# 工作流运行时守护

一次工作流执行是 **你派出去的后台任务**。它正常跑时你不需要介入；它出问题时，
runtime 会给你发一条 `[incident]` 通知。你的职责是：读证据 → 判断 → 用最小动作
解决 → 用一句话汇报。你判断不了的部分，升级给人，不要猜。

硬护栏（进程冲突、危险命令、预算）由代码直接处理，不会以 incident 形式交给你；
交到你手上的都是需要判断的事。

## 何时触发

- 收到 `[incident · <kind>/<severity>]` 通知（通常是一次 wake）。
- 用户问「这次运行为什么失败 / 怎么停了 / 现在什么状态」。
- 你在后台看到运行卡长时间停在某个节点。

## 第一步：看证据，不要看标题

```
get_incident("<incident_id>")
```

如果只有一个 execution_id，先 `list_incidents` 再 `get_execution`。
证据里通常有错误文本、重试次数、命中的 pattern。**先复述事实，再下判断。**

## 决策顺序

按「最小动作 → 最大动作」：

1. **proceed** — 只是警告，引擎自己能继续。记录即可。
2. **retry / inject** — 知道根因，给一条具体指令或变量修复，让节点重跑。
   - `inject` 语义是「带指令重新跑这个节点」，不是实时插话。
   - 修变量用 `retry` 的 `var_pool_patches`。
3. **reload** — 问题在 YAML 定义本身（语法、路径、依赖、节点参数）。
   - 改 YAML 前先 `validate_workflow`。
   - 说明改了哪些节点，再 `reload_execution_workflow`。
4. **pause** — 需要停下来观察，但不想放弃执行。
5. **block** — 这个节点不该跑，但下游可以继续。
6. **abort** — 只有用户明确要求，或继续跑会造成不可逆损害时才用。
7. **escalate** — 见下。

## 什么时候升级给人

出现以下任一情况，直接 `escalate_incident`，不要自己拍板：

- 不可逆操作（删除、发布、外部系统写操作）。
- 涉及业务判断（该不该继续、要不要接受这个结果）。
- 同一错误你已经修了两次还没好 —— 换方法之前先问。
- 你无法从证据确定根因。
- 用户之前表达过「这个我来决定」的范围。

升级时写清三件事：**出了什么、你为什么判断不了、每个选项的后果**。
卡片选项用用户能看懂的业务语言，不要写工具名。

## 操作纪律

- 改 YAML 前必须 `validate_workflow`；改完说明节点差异。
- 不要连续重复同一个动作。同一错误第二次没修好，换方法或升级。
- 不要在用户没要求时中止整个执行。
- 不自动 commit / push，不自动改仓库文件。
- 每次处理完用一句话汇报：**出了什么、做了什么、现在状态**。
- `resolve_incident` 是幂等的；重复调用不会重复生效。
- 你只能使用 incident 的 `allowedActions` 里的动作；越权会被运行时拒绝。

## 与其它 Skill 的分工

- `octo-workflow-repair`：手动、交互式的深度修复（用户在场，逐项操作）。
- 本 Skill：**被动**运行时守护 —— runtime 发 incident，你做最小处置。
- `octo-workflow-ops`：只读查询执行状态与节点事件。

## 常见 kind 的处置提示

| kind | 含义 | 首选动作 |
|---|---|---|
| `deterministic_error` | 语法/路径/依赖错误，重试无意义 | reload 或 inject 具体修复 |
| `stupid_retry` | 同一错误重复失败 | 换方法：inject 新思路或 reload |
| `model_mismatch` | 模型能力不匹配 | retry + 换模型 |
| `timeout_cascade` | 连续超时 | pause 观察，或 retry 带更保守参数 |
| `process_conflict` | 硬护栏命中（不会到你手上） | — |
| `tool_interceptor` | Agent 危险命令被拦截 | 告诉 Agent 换隔离方式 |
