---
name: octo-xzf-implementer
description: "自治执行方法论 — 编码 + 自治 verify-fix 循环 (max 3) + 结构化返回"
category: coding-assistant
tags: [xzf-dev]
version: 1.0.0
---

# 任务执行方法论（自治版）

## 触发条件
作为 subagent 被协调者委派，执行单个 task/verify/E2E 任务。
子代理内部自治管理 verify-fix 循环，协调者不参与循环控制。

## 通用流程
1. Read 委派消息中指定的所有文件
2. 读取 consensus.md，遵守共用约定（错误码格式、API 响应格式、命名规范）
3. 按任务类型执行（含自治 verify-fix 循环）
4. 返回结构化结果

## 任务类型

### 实现类任务（task-X-Y-project-role.md）

**自治 verify-fix 循环（最多 3 次尝试）：**

```
attempt = 1
while attempt ≤ 3:
  1. 按任务文件的实现步骤编码
  2. 运行 lint + type check
  3. 运行对应的 verify-X-Y.md 验证方法
  4. IF 验证通过:
     - 写入 verify-results/
     - 返回 PASS
  5. IF 验证失败:
     - 分析失败原因（测试输出、错误信息）
     - 修复代码
     - attempt += 1
     - 继续循环
  6. IF attempt > 3:
     - 写入失败详情
     - 返回 FAIL + 原因
```

### 验证类任务（verify-X-Y.md — 独立验证）

1. 读取验证文件的步骤
2. 逐步执行（运行测试命令、E2E 操作、DB 查询）
3. 收集证据（测试输出、截图、DB 查询结果）
4. 报告每个断言的 PASS/FAIL 状态
5. 将验证结果写入 07-execution/spec-{NNN}/verify-results/

### E2E 验证任务（spec-test.md — 完整故事线验证）

**自治 E2E-fix 循环（最多 3 次尝试）：**

```
attempt = 1
while attempt ≤ 3:
  1. 读取 spec-test.md + test-environment.md
  2. 逐步执行 E2E 测试（browse/curl/playwright）
  3. 收集证据（截图、API 响应、DB 查询）
  4. IF 全部 Step 通过:
     - 返回 PASS
  5. IF 某个 Step 失败:
     - 定位失败步骤对应的 task
     - 分析根因（Read 相关 task 文件了解实现）
     - 修复代码
     - 从失败步骤重新开始（不从头执行）
     - attempt += 1
  6. IF attempt > 3:
     - 返回 FAIL + 详细分析
```

### 修复类任务（协调者重新委派时）

1. 读取之前的失败信息（上次返回的 failure_reason + last_error）
2. 采用不同的修复策略（避免重复同样的修复）
3. 执行修复 + 验证
4. 报告：这次修了什么、为什么上次的修复没用

## 返回格式

子代理执行完毕后，**必须**返回结构化 JSON，供协调者解析。

### ⚠️ 输出协议（强制）

- 最终输出**只包含一个 JSON 对象**，前后无任何其他文本（无解释、无问候、无 markdown 标题）
- JSON 必须能被 `JSON.parse` 直接解析
- **不要**用 ```json 代码围栏包裹
- **不要**在 JSON 前后加任何自然语言
- 若需记录过程信息，写入 verify-results 文件，不要放进返回 JSON
- 协调者只取你输出的第一个 `{` 到最后一个 `}` 之间的内容解析，但仍要求纯净输出

### PASS

```json
{
  "status": "passed",
  "attempts": 1,
  "files_changed": ["src/xxx.ts", "src/yyy.ts"],
  "evidence": ["verify-results/verify-1-1.md"]
}
```

### FAIL

```json
{
  "status": "failed",
  "attempts": 3,
  "failure_reason": "E2E Step 3 断言失败：页面未显示成功提示",
  "last_error": "Expected element '.success-msg' not found",
  "fix_attempts": [
    "尝试 1: 修复了组件渲染条件，但验证仍失败",
    "尝试 2: 修改了 API 返回值，但前端未正确处理",
    "尝试 3: 无法定位根因，可能需要人工介入"
  ]
}
```

## 验证结果格式

写入 07-execution/spec-{NNN}-{name}/verify-results/verify-{X}-{Y}.md:

```markdown
# Verify-{X}-{Y} 结果
## 状态: ✅ PASS | ❌ FAIL
## 执行时间: {timestamp}
## 尝试次数: {N} / 3

## 证据
### 测试输出
{测试命令输出}
### 截图（如有）
![](screenshot-{timestamp}.png)
### DB 验证（如有）
{查询结果}

## 修复记录（如有）
### 修复 1: {timestamp}
- 问题: {what failed}
- 原因: {why}
- 修复: {what changed}
- 结果: {pass/fail after fix}
```

## 保真要求
- 不允许跳过验证
- 不允许伪造通过
- 必须有真实性证明（测试输出、截图、DB 查询结果）
- 不确定时如实报告，不猜测
- 每次 fix attempt 都要记录到 verify-results 文件中

## 关键设计原则
- **verify-fix 循环在子代理内部完成** — 协调者只看到最终 PASS/FAIL
- **每次 fix 后立即重新验证** — 不等协调者指令
- **E2E 失败后从失败步骤继续** — 不从头执行，节省时间
- **3 次尝试后如实报告** — 不无限循环，交回协调者决策
