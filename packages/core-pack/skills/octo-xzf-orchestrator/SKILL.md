---
name: octo-xzf-orchestrator
description: "线性委派器 — 依赖排序 + 委派子代理 + 检查结果 + 重试决策"
category: coding-assistant
tags: [xzf-pipeline]
version: 1.0.0
---

# 执行编排方法论（线性委派版）

## 触发条件
Stage 6 agent 节点（协调者），编排 subagent 执行 spec 的实现和验证。

## 协调者职责（三件事）
1. **排序**: 读取 consensus.md + 文件名，确定任务执行顺序
2. **委派**: 按顺序 delegate_to_xxx-expert，传递文件路径
3. **检查**: 解析子代理返回的 JSON（status: passed/failed），决定下一步

⚠️ 协调者不实现代码、不运行测试、不修复 bug、不管理 verify-fix 循环。

## 上下文管理
- 不预读所有 task/verify 文件内容
- 只读取：consensus.md（全景）+ 文件名列表（排序依据）+ test-environment.md（环境检查）
- 委派时传递文件路径，让子代理自行 Read

## 执行流程

### Phase 0: 环境就绪检查
读取 test-environment.md 的「环境就绪检查」清单：
- 确认服务已启动、DB 已连接、E2E 工具可用
- 未就绪则尝试自动准备（Bash 命令启动服务）
- 仍失败则直接报告 failed，等待人工干预

### Phase 1: 实现任务（按依赖拓扑排序）

**排序逻辑**:
从 consensus.md 和文件名 (task-X-Y-project-role.md) 分析依赖：
- 无依赖的 task → 第一批执行
- 有依赖的 task → 等前置 task 完成后执行
- X 值递增顺序执行（v1: 顺序；v2 可引入 batch 并行）

**委派循环（线性，非 loop 节点）**:

```
for each task in dependency_order:
  1. delegate_to_{role}-expert(task: |
     执行任务。请先 Read:
     - 任务: 06-plans/spec-NNN/{task-file}
     - 共识: 06-plans/spec-NNN/consensus.md
     - 环境: 04-stories/test-environment.md
     按 octo-xzf-implementer skill 的自治 verify-fix 流程执行。
  )

  2. 解析子代理返回 JSON
  3. IF status == "passed":
     - 记录通过，继续下一个 task
  4. IF status == "failed":
     - 记录失败原因到 fix-log.md
     - 重新委派同一 task（携带上次失败信息，fresh attempt）
     - 解析新返回 JSON
     - IF 仍然 failed:
       → 输出 spec_status: "failed"
       → 停止执行，进入失败报告
```

**委派格式（传路径 + 上次失败信息）**:

```
# 首次委派
delegate_to_backend-expert(task: |
  执行任务。请先 Read:
  - 任务: 06-plans/spec-001/task-1-2-auth-backend.md
  - 共识: 06-plans/spec-001/consensus.md
  - 环境: 04-stories/test-environment.md
  按 octo-xzf-implementer skill 执行。
)

# 重试委派（携带失败信息）
delegate_to_backend-expert(task: |
  上次执行失败，请重新尝试。
  上次失败信息:
  - failure_reason: "E2E Step 3 断言失败"
  - last_error: "Expected element not found"
  - fix_attempts: ["修复了渲染条件", "修改了返回值"]
  请采用不同策略重新实现。
)
```

### Phase 2: E2E 验证

所有 task 通过后，委派 test-expert 执行完整故事线验证：

```
1. delegate_to_test-expert(task: |
   执行 E2E 验证。请先 Read:
   - 测试路线: 06-plans/spec-001/spec-test.md
   - 环境: 04-stories/test-environment.md
   按 octo-xzf-implementer skill 的自治 E2E-fix 流程执行。
)

2. 解析返回 JSON
3. IF status == "passed": spec 完成
4. IF status == "failed":
   - 重新委派 test-expert（携带上次失败信息）
   - IF 仍然 failed → spec_status: "failed"
```

## 失败报告
子代理返回 failed 且重试仍失败后，协调者写入 `08-reports/failure-{timestamp}.md`:

```markdown
# 失败报告

## 基本信息
- Spec: spec-{NNN}
- 失败 Task: {task-file}
- 失败 Verify: verify-{X}-{Y}

## 子代理报告
{直接引用子代理返回的 failure_reason + last_error + fix_attempts}

## 已尝试的修复
### 子代理内部尝试（3 次）
{fix_attempts 详情}
### 协调者重试（1 次）
{重试委派结果}

## 建议的人工干预方案
{基于 failure_reason 的建议}
```

## 通知
失败时通过 Octopus notify → hermes CLI → xzf_hermes 群

## 完成输出

所有验证通过:

```json
{"vars_update": {"spec_status": "passed"}}
```

失败:

```json
{"vars_update": {"spec_status": "failed", "failure_reason": "..."}}
```

## 重试策略总览

| 层级 | 谁管理 | 次数 | 触发条件 |
|------|--------|------|---------|
| Layer 1 | 子代理内部 (implementer skill) | max 3 | verify 失败 |
| Layer 2 | 协调者 (orchestrator skill) | max 1 | 子代理返回 failed |
| Layer 3 | Workflow (human-intervention) | 用户决定 | 协调者报告 failed |
