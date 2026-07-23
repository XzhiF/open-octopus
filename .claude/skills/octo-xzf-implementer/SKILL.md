---
name: octo-xzf-implementer
description: "Tracer Bullet 执行方法论 — 全栈实现 + checkpoint 标准"
category: coding-assistant
tags: [xzf-dev]
version: 3.0.0
---

# Tracer Bullet 执行方法论

## 触发条件
execution-loop 中的 agent 节点，按依赖顺序逐个执行 spec 下的 tracer bullets。

## 核心理念

**实现优先，轻量验证。** 每个 tracer bullet 写完代码后跑单测确认基本正确，
不做深度集成验证和反假跑检查——这些由 Stage 6 E2E 统一覆盖。

## 执行流程

### 准备工作

开始实现前，读取项目领域知识：
```
{project}/CONTEXT.md 或 CONTEXT-MAP.md   ← 领域术语
```
变量、函数、类、模块命名必须使用 CONTEXT.md 中已有的术语。如术语不存在于 CONTEXT.md，按 codebase 现有命名约定保持一致。

### 每个 Tracer Bullet

```
1. 读取 T-N.md（目标 + 验收标准 + 依赖）
2. 实现（全栈：DB → API → UI）
3. 写关键单测（覆盖核心逻辑路径，不追求覆盖率）
4. 验证:
   a. 编译通过（tsc --noEmit / pnpm build / 对应语言的编译检查）
   b. 单测通过（仅跑当前变更相关的测试，不跑全量）
   c. Code smell 扫描:
      grep -rn "TODO\|FIXME\|HACK\|XXX\|console\.log\|debugger" {变更文件}
      发现遗留 → 清理
5. IF 全部通过 → 更新 checkpoint → 下一个 task
6. IF 失败 → 修复 → 重试（max 2 次）
7. IF 2 次仍失败 → 写入 checkpoint failure → 继续下一个 task
8. 所有 task 完成后，更新 checkpoint 为 completed
```

### 验证边界（做什么 / 不做什么）

| ✅ 做 | ❌ 不做 |
|--------|---------|
| 核心逻辑的单测 | 追求覆盖率 |
| 编译/构建检查 | 全量测试套件 |
| Code smell 清理 | 集成测试（E2E 覆盖） |
| 当前变更相关的测试 | 反假跑检查 |
| | 验证证据文件 |

## Checkpoint 标准

### 文件路径
`.scratch/{feature}/04-execution/spec-{NNN}/checkpoint.json`

### Schema（严格遵循，不可增删字段）

```json
{
  "spec_id": "spec-NNN",
  "spec_file": "spec-NNN-{name}.md",
  "status": "in_progress | completed | failed",
  "started_at": "ISO-8601 timestamp",
  "updated_at": "ISO-8601 timestamp",
  "tasks_completed": [
    {
      "task": "T-1-{name}.md",
      "status": "passed",
      "completed_at": "ISO-8601 timestamp",
      "attempts": 1
    }
  ],
  "tasks_remaining": [
    "T-2-{name}.md",
    "T-3-{name}.md"
  ],
  "failure": null
}
```

### failure 字段（仅在 status=failed 时非 null）

```json
{
  "failure": {
    "task": "T-2-{name}.md",
    "reason": "编译失败: ...",
    "attempts": 2,
    "last_error": "具体错误信息",
    "failed_at": "ISO-8601 timestamp"
  }
}
```

### Checkpoint 操作规则

| 时机 | 操作 |
|------|------|
| spec 开始执行 | 创建 checkpoint，status="in_progress"，所有 task 在 tasks_remaining |
| 每个 task 通过 | 从 tasks_remaining 移到 tasks_completed，更新 updated_at |
| task 失败（2 次） | 记录到 failure，继续下一个 task（不阻断整个 spec） |
| 所有 task 完成 | status="completed"（含部分失败也标 completed，failure 字段记录详情） |
| 恢复执行 | 读 checkpoint → 跳过 tasks_completed → 从 tasks_remaining 开始 |

### 字段约束

- `status` 只允许三个值: `"in_progress"` | `"completed"` | `"failed"`
- `tasks_completed` 中每个对象的 `status` 只允许 `"passed"`
- `tasks_remaining` 是字符串数组（文件名），不是对象
- `failure` 为 null 或对象，不存在其他状态
- 所有时间字段必须是 ISO-8601 格式
- 每次写入 checkpoint 必须同时更新 `updated_at`

## 完成输出

spec 全部 task 完成后:
```json
{"vars_update": {"spec_status": "passed", "current_spec": "<当前值+1>"}}
```

有 task 失败但未阻断时:
```json
{"vars_update": {"spec_status": "partial", "current_spec": "<当前值+1>"}}
```
