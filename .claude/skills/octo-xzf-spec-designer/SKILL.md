---
name: octo-xzf-spec-designer
description: "Spec DSL 设计规范 — 故事线拆分、验证优先"
category: coding-assistant
tags: [xzf-dev]
version: 1.0.0
---

# Spec DSL 设计规范

## 触发条件
Stage 4 swarm 节点，将故事总汇拆分为 N 个 spec。

## 拆分原则
1. 每个 spec = 一条完整用户故事线
2. 从简单到复杂排列（spec-001 最基础）
3. 第一份 spec 通常包含基础底座（DB schema、基础 API、基础 UI 框架）
4. 每个 spec 完成后都是可交付版本
5. spec 之间有依赖但尽量松耦合

## Spec 文件命名
`spec-{NNN}-{name}.md` — 三位数字编号 + 简短英文名称

## Spec 索引文件

Host 在写入所有 spec 文件后，**必须**生成 `05-specs/spec-index.md`，供 Stage 5/6 按序号查找 spec 文件：

```markdown
# Spec 索引

> 生成时间: {timestamp}
> 总数: {N}

| # | 文件名 | 标题 | Priority | Depends |
|---|--------|------|----------|---------|
| 1 | spec-001-user-login.md | 用户登录 | P0 | none |
| 2 | spec-002-dashboard.md | 仪表盘 | P1 | spec-001 |
| 3 | spec-003-settings.md | 用户设置 | P1 | spec-001 |
```

Stage 5/6 的 agent 读取此文件，通过 `#` 列定位第 `$iteration` 个 spec 的文件名。

## Spec DSL 格式

### Meta 区块

```markdown
# Spec-{NNN}: {标题}

## Meta
- ID: spec-{NNN}
- Name: {english-name}
- Priority: P0/P1/P2
- Depends: none | spec-{NNN}
- Roles involved: {角色列表}
```

### Story Line 区块

```markdown
## Story Line
ACTOR: {角色名}
GOAL: {要达成什么}
OUTCOME: {成功后的状态}
SERVICE_CHAIN: project-web (HTTP) → project-service (RPC) → project-db
```

> 当 spec 跨多个 workspace 项目时，`SERVICE_CHAIN` 描述完整的服务链路。单项目 spec 可省略。

### Verification Path 区块（先于实现设计）

```markdown
## Verification Path

### VP-1: {验证场景名}
- PRECONDITION: {前置条件}
- STEPS:
  1. {操作步骤}
  2. {操作步骤}
- ASSERT:
  - {断言 1}
  - {断言 2}
```

### Operation Flow 区块

```markdown
## Operation Flow

### Step N: {步骤标题}
ACTOR: browser | server | database
PROJECT: {project-name}  # 跨项目时标注哪个 workspace 项目处理此步骤
ACTION: {具体操作}
REQUEST: {如果是 API 调用}
  method: POST
  url: http://localhost:3001/api/...
  body: { ... }
FLOW: {如果是服务端处理}
  Controller.method(req)
    → Service.method(params)
    → IF condition: return error
    → DAO.query(params)
    → return result
UI: {如果需要展示 UI}
  ┌───────────────────────┐
  │ ASCII wireframe       │
  └───────────────────────┘
```

### Tech Requirements 区块

```markdown
## Tech Requirements
- DB: {表结构变更}
- API: {新增/修改接口}
- UI: {新增/修改页面或组件}
```
