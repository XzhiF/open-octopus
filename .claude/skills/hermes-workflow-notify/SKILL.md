---
name: hermes-workflow-notify
description: "为 Octopus 工作流 YAML 添加 Hermes 实时通知。每个阶段完成后通过 hermes send 推送进度到群聊，agent 节点输出 conclusion 字段提供结论性信息。当用户要求给工作流加通知、加 hermes 推送、或改造为 hermes 版工作流时使用。"
---

# Hermes 工作流通知模式

为 Octopus 工作流 YAML 添加 `hermes send` 实时通知，让每个阶段完成后自动推送进度到指定聊天群。

## 核心原则

1. **直接调用 `hermes send`** — 不写文件、不轮询，每个阶段完成后立即推送
2. **通知发群里** — 使用 `telegram:xzf_hermes` 群聊，避免 DM 干扰
3. **结论性信息** — agent 节点在 `vars_update` 中输出 `conclusion` 字段，通知中展示分析/决策/结论摘要
4. **多项目感知** — setup 遍历所有 `projects/` 下的 git 项目，通知显示完整项目列表

## 改造步骤

### 第 1 步：添加通知变量

在 `variables` 中新增：

```yaml
variables:
  notify_target: "telegram:xzf_hermes"
  # 其他变量...
```

将原有的单项目变量（`project_name`、`project_path`）改为多项目：

```yaml
  projects: ""        # 逗号分隔的项目列表，如 "proj-a, proj-b, proj-c"
```

### 第 2 步：改造 setup 节点

setup 必须遍历所有项目，而非只取第一个：

```bash
# 遍历所有 projects/ 下的 git 项目
PROJECTS=""
FIRST_PROJECT=""
if [ -d projects ]; then
  for dir in projects/*/; do
    if [ -d "$dir/.git" ] || [ -f "$dir/.git" ]; then
      name=$(basename "$dir")
      if [ -z "$FIRST_PROJECT" ]; then
        FIRST_PROJECT="${dir%/}"
      fi
      if [ -z "$PROJECTS" ]; then
        PROJECTS="$name"
      else
        PROJECTS="$PROJECTS, $name"
      fi
    fi
  done
fi
```

`vars_update` 中输出 `projects`（复数）而非 `project_name`。

### 第 3 步：为每个业务节点添加 notify bash 节点

**模式**：在每个业务节点后插入一个 `notify-{node_id}` bash 节点：

```yaml
- id: notify-setup
  type: bash
  depends_on: [setup]
  timeout: 15
  bash: |
    hermes send -t "$vars.notify_target" -q "🚀 *{workflow-name}* 启动
    📂 项目: $vars.projects
    🌿 分支: $vars.branch → $inputs.base_branch
    📦 包管理: $vars.pkg_manager
    📋 需求: $inputs.requirement" 2>&1 || echo "WARN: hermes send failed"
```

**关键规则**：
- 每个 notify 节点 `timeout: 15`
- 所有 notify 以 `2>&1 || echo "WARN: hermes send failed"` 结尾（非阻塞）
- 下游业务节点 `depends_on` 指向上一个 notify 节点（而非直接指向上一个业务节点）

### 第 4 步：修改依赖链

原链：
```
setup → analyze → plan → implement → review → ship
```

改造后：
```
setup → notify-setup → analyze → notify-analyze → plan → notify-plan → ...
```

### 第 5 步：为 agent 节点添加 conclusion 输出

每个 agent 节点的 prompt 末尾，要求在 `vars_update` 中输出 `conclusion` 字段：

| 阶段 | conclusion 要求 |
|------|----------------|
| analyze | 2-3句话总结：分析了什么、确定了什么技术方向、关键设计决策 |
| plan | 2-3句话总结：计划包含几个步骤、主要改动范围、预计复杂度 |
| implement | 2-3句话总结：实际改了哪些文件、新增/修改了多少行代码、主要实现了什么功能 |
| review | 2-3句话总结：发现多少问题、修复了多少、剩余问题严重程度（无/低/中/高） |
| conflict-resolve | 2-3句话总结：分析了哪些冲突、采用了什么策略、最终结果 |
| modify | 2-3句话总结：修改了哪些文件、做了什么改动、是否符合预期 |
| push | 推送成功/失败原因和建议 |

示例 prompt 末尾：

```yaml
      完成后在回复末尾输出：
      ---ANALYSIS_COMPLETE---
      {"vars_update":{"spec_file":"<路径>","conclusion":"<2-3句话总结：分析了什么、确定了什么技术方向、关键设计决策>"}}
```

### 第 6 步：编写通知消息

notify bash 中引用 `$vars.conclusion` 展示结论：

```yaml
- id: notify-analyze
  type: bash
  depends_on: [analyze]
  timeout: 15
  bash: |
    hermes send -t "$vars.notify_target" -q "📝 *{workflow-name}* — Analyze 完成
    📂 项目: $vars.projects | 🌿 $vars.branch
    📄 规格文档: $vars.spec_file

    💡 *分析结论*:
    $vars.conclusion" 2>&1 || echo "WARN: hermes send failed"
```

## 通知消息模板

### 启动通知（setup 后）

```
🚀 *{workflow-name}* 启动
📂 项目: {projects}
🌿 分支: {branch} → {base_branch}
📦 包管理: {pkg_manager}
📋 需求: {requirement}
```

### 阶段完成通知（agent 节点后）

```
{icon} *{workflow-name}* — {Phase} 完成
📂 项目: $vars.projects | 🌿 $vars.branch
{额外信息：文档路径、PR URL 等}

💡 *{结论标签}*:
$vars.conclusion
```

### 阶段完成通知（bash 节点后，简单信息）

```
{icon} *{workflow-name}* — {Phase} 完成
📂 项目: $vars.projects | 🌿 $vars.branch
{简短状态描述}
```

### 最终通知

```
{icon} *{workflow-name}* — 最终状态: {status}
📂 项目: $vars.projects
🌿 PR #{pr_number}: {pr_title}
🔗 {pr_url}
🎯 {branch} → {base_branch}
📝 {summary}
```

### 图标选择

| 场景 | 图标 |
|------|------|
| 启动 | 🚀 |
| 分析完成 | 📝 |
| 计划完成 | 📋 |
| 实现完成 | ⚙️ |
| 审查完成 | 🔍 |
| 测试通过 | ✅ |
| 测试未通过 | ⚠️ |
| 成功 | ✅ |
| 失败 | ❌ |
| 推送成功 | 🚀 |
| 冲突解决 | 🔀 |
| 中止 | 🚫 |

## hermes send 用法

```bash
# 基本用法：发送文本消息到指定目标
hermes send -t "telegram:xzf_hermes" -q "消息内容"

# 参数说明
# -t TARGET   目标（群聊/频道）
# -q          静默模式（成功时不输出，仅返回 exit code）

# 错误处理（非阻塞）
hermes send -t "$vars.notify_target" -q "消息" 2>&1 || echo "WARN: hermes send failed"
```

### 可用目标

通过 `hermes send --list` 查看：

```
Telegram:
  telegram:ZF Xie (dm)           # 私聊
  telegram:xzf_hermes (group)    # 群聊 ← 工作流通知用这个
```

## 条件路由中的通知

当工作流有条件分支时，notify 节点放在条件节点**之前**：

```yaml
# 1. 业务节点
- id: pull-merge
  type: bash
  ...

# 2. 通知节点（在条件之前）
- id: notify-pull-merge
  type: bash
  depends_on: [pull-merge]
  bash: |
    if [ "$vars.has_conflicts" = "true" ]; then
      hermes send ... "⚠️ 检测到合并冲突..."
    else
      hermes send ... "✅ 合并成功，无冲突"
    fi

# 3. 条件节点
- id: conflict-check
  type: condition
  depends_on: [notify-pull-merge]
  cases:
    - when: '$vars.has_conflicts == "false"'
      then: next-step
    - when: default
      then: conflict-resolve
```

## 完整改造对照

### 改造前

```yaml
nodes:
  - id: setup
    type: bash
    ...
  - id: analyze
    type: agent
    depends_on: [setup]
    ...
  - id: plan
    type: agent
    depends_on: [analyze]
    ...
```

### 改造后

```yaml
variables:
  notify_target: "telegram:xzf_hermes"
  projects: ""
  ...

nodes:
  - id: setup
    type: bash
    ...  # 遍历所有项目，输出 projects 变量

  - id: notify-setup
    type: bash
    depends_on: [setup]
    timeout: 15
    bash: |
      hermes send -t "$vars.notify_target" -q "🚀 ..." 2>&1 || echo "WARN"

  - id: analyze
    type: agent
    depends_on: [notify-setup]    # ← 依赖 notify 而非 setup
    ...
    prompt: |
      ...
      {"vars_update":{"spec_file":"...","conclusion":"<分析结论>"}}

  - id: notify-analyze
    type: bash
    depends_on: [analyze]
    timeout: 15
    bash: |
      hermes send -t "$vars.notify_target" -q "📝 ...
      💡 *分析结论*:
      $vars.conclusion" 2>&1 || echo "WARN"

  - id: plan
    type: agent
    depends_on: [notify-analyze]  # ← 依赖 notify 而非 analyze
    ...
```

## 注意事项

- **不要删除已有的最终 notify 节点** — 它提供工作流级别的最终状态汇总
- **bash 节点的通知可以简单** — 只报状态，不需要 conclusion
- **agent 节点必须有 conclusion** — 这是通知的价值所在，展示 AI 的分析结论
- **`-q` 参数必加** — 静默模式，hermes send 成功时不输出任何内容
- **`|| echo "WARN"` 必加** — 通知失败不应阻塞工作流

## 参考文件

- `packages/core-pack/presets/workflows/hermes-dev-flow.yaml` — 6 阶段开发流程
- `packages/core-pack/presets/workflows/hermes-workflow-dev-flow.yaml` — 8 阶段工作流开发
- `packages/core-pack/presets/workflows/hermes-pr-follow-up-flow.yaml` — PR 跟进流程
