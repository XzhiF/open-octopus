---
name: octo-xzf-implementer
description: "Tracer Bullet 执行方法论 — 全栈实现 + 自治 verify-fix + checkpoint 标准"
category: coding-assistant
tags: [xzf-dev]
version: 2.0.0
---

# Tracer Bullet 执行方法论

## 触发条件
execution-loop 中的 agent 节点，按依赖顺序逐个执行 spec 下的 tracer bullets。

## 执行流程

### 每个 Tracer Bullet

```
1. 读取 T-N.md（目标 + 验收标准 + 验证方式 + 依赖）
2. 读取 spec 文件（反假跑标准）
3. 实现（全栈：DB → API → UI → test）
4. 自治 verify-fix 循环（max 3）:
   a. 运行 T-N.md 中定义的验证方式
   b. 对照 spec 反假跑标准，确认"真通过"
   c. IF 通过 → 更新 checkpoint → 下一个 task
   d. IF 失败 → 分析原因 → 修复 → 重试
   e. IF 3 次仍失败 → 写入 checkpoint failure → 报告
5. 所有 task 完成后，更新 checkpoint 为 completed
```

## Checkpoint 标准

### 文件路径
`.octopus/xzf/{feature}/05-execution/spec-{NNN}/checkpoint.json`

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
      "attempts": 1,
      "verify_evidence": "05-execution/spec-NNN/verify/T-1.md"
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
    "reason": "验收标准未满足：...",
    "attempts": 3,
    "last_error": "具体错误信息",
    "fix_log": [
      "尝试 1: {做了什么} → {结果}",
      "尝试 2: {做了什么} → {结果}",
      "尝试 3: {做了什么} → {结果}"
    ],
    "failed_at": "ISO-8601 timestamp"
  }
}
```

### Checkpoint 操作规则

| 时机 | 操作 |
|------|------|
| spec 开始执行 | 创建 checkpoint，status="in_progress"，所有 task 在 tasks_remaining |
| 每个 task 通过 | 从 tasks_remaining 移到 tasks_completed，更新 updated_at |
| task 失败（3 次） | status="failed"，写入 failure 字段 |
| 所有 task 通过 | status="completed"，保留 checkpoint 作为执行记录 |
| 恢复执行 | 读 checkpoint → 跳过 tasks_completed → 从 tasks_remaining 开始 |

### 字段约束

- `status` 只允许三个值: `"in_progress"` | `"completed"` | `"failed"`
- `tasks_completed` 中每个对象的 `status` 只允许 `"passed"`
- `tasks_remaining` 是字符串数组（文件名），不是对象
- `failure` 为 null 或对象，不存在其他状态
- 所有时间字段必须是 ISO-8601 格式
- 每次写入 checkpoint 必须同时更新 `updated_at`

## 验证结果文件

路径: `05-execution/spec-{NNN}/verify/T-N.md`

```markdown
# T-N 验证结果

## 状态: ✅ PASS | ❌ FAIL
## 完成时间: {ISO-8601}
## 尝试次数: {N} / 3

## 验收标准检查
- [x|空] {条件 1} — {证据}
- [x|空] {条件 2} — {证据}

## 反假跑检查
- [x|空] {反假跑条件} — {真实证据}

## 证据
### 测试输出
{命令输出}
### 截图（如有）
![](screenshot-{timestamp}.png)
### DB 验证（如有）
{查询结果}

## 修复记录（如有）
### 修复 {N}:
- 问题: {什么失败}
- 修复: {改了什么}
- 结果: {pass/fail}
```

## 保真要求
- 不允许跳过验证
- 不允许伪造通过
- 必须对照反假跑标准确认真通过
- 必须有真实性证明（测试输出、截图、DB 查询结果）
- 不确定时如实报告，不猜测
- 每次 fix attempt 都记录到验证结果文件

## 完成输出

spec 全部 task 通过后:
```json
{"vars_update": {"spec_status": "passed", "user_guidance": ""}}
```

失败时:
```json
{"vars_update": {"spec_status": "failed", "failure_reason": "T-N 失败: ..."}}
```
