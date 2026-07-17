---
name: octo-xzf-task-planner
description: "任务拆解方法论 — consensus + verify + task + spec-test 文档生成"
category: coding-assistant
tags: [xzf-pipeline]
version: 1.0.0
---

# 任务拆解方法论

## 触发条件
Stage 5 swarm 节点，为每个 spec 生成任务计划文档。

## 输出文件（per spec）

```
06-plans/spec-{NNN}-{name}/
├── consensus.md          # 总纲领
├── verify-1-1.md         # 验证方法
├── task-1-1-{project}-backend.md   # 任务分配（含项目归属）
└── spec-test.md          # 完整 E2E 验证路线
```

## consensus.md — 总纲领
专家团讨论后达成的共识，除共用事项外不需要细节：

```markdown
# Spec-{NNN} 总纲领

## DB 变更
- 新增表: tb_xxx (字段列表)
- 修改表: tb_yyy (ALTER ...)
- 删除表: 无

## 文件变更
- 新增: src/controllers/XxxController.ts
- 修改: src/routes/index.ts
- 删除: 无

## 共用约定
- 错误码格式: {module}_{error_type}
- API 响应格式: { data, error, meta }
- 认证方式: JWT Bearer token

## 并行开发边界
- 后端: 独立 Controller/Service/DAO
- 前端: 独立组件/页面
- 共用: API 接口契约（先对齐再开发）
```

## verify-x-y.md — 验证方法
先设计验证，再设计实现：

```markdown
# Verify-{X}-{Y}: {验证标题}

## 验证目标
{验证什么功能/行为}

## 验证方法
### 单元测试
```typescript
test('{描述}', () => {
  // Arrange
  const input = { ... }
  // Act
  const result = targetFunction(input)
  // Assert
  expect(result).toBe(expected)
})
```

### 集成测试
```typescript
test('{描述}', async () => {
  const response = await request(app)
    .post('/api/xxx')
    .send({ ... })
  expect(response.status).toBe(200)
  expect(response.body.data).toMatchObject({ ... })
})
```

## 通过标准
- [ ] 所有单元测试通过
- [ ] 所有集成测试通过
- [ ] 覆盖率 ≥ 80%
```

## task-x-y-project-role.md — 任务分配
X = 任务号（相同 X 可并行），Y = 子任务号，project = 所属 workspace 项目：

```markdown
# Task-{X}-{Y}-{Project}-{Role}: {任务标题}

## 任务描述
{简要描述做什么}

## 项目归属
- Project: {project-name}
- 工作目录: worktrees/{project-name}/

## 依赖
- 前置任务: task-{X'}-{Y'}-{Project'}-{Role'} 或 none
- 共用文件: consensus.md 中的约定

## 实现步骤
1. {步骤 1}
2. {步骤 2}
3. {步骤 3}

## 验证
参照 verify-{X}-{Y}.md

## 涉及文件
- src/xxx/yyy.ts (新增)
- src/xxx/zzz.ts (修改)
```

> **跨项目并行**: 同一 spec 中属于不同 project 的 task，在 consensus.md 对齐接口契约后可并行执行。

## spec-test.md — 完整 E2E 验证路线

```markdown
# Spec-{NNN} E2E 验证路线

## 概述
按步骤执行完整故事线验证，使用 browse/playwright 进行 E2E 测试。

## 前置条件
- 服务已启动: localhost:3000 (前端), localhost:3001 (后端)
- 测试数据已准备: {种子数据脚本}
- DB 连接: {连接信息}

## 执行步骤

### Step 1: 验证页面渲染
```bash
browse snapshot http://localhost:3000/{page}
# 预期: 页面包含 {元素}
```

### Step 2: 验证用户操作
```bash
browse fill "#username" "test@example.com"
browse fill "#password" "password123"
browse click "#login-btn"
# 预期: 页面跳转到 /dashboard
```

### Step 3: 验证数据持久化
```bash
# 查询 DB 验证数据
sqlite3 octopus.db "SELECT * FROM tb_xxx WHERE ..."
# 预期: 记录存在且字段正确
```

### Step 4: 验证异常处理
```bash
browse fill "#username" ""
browse click "#login-btn"
# 预期: 显示错误提示 "用户名不能为空"
```

## 通过标准
- [ ] 所有 Step 执行成功
- [ ] 截图证据完整
- [ ] DB 数据符合预期
```
