# Skill 套件设计

## 概述

6 个 skill，放置在 `packages/core-pack/skills/octo-xzf-*/SKILL.md`，运行时通过 resource 模块安装。

所有 skill 使用 `octo-xzf-` 前缀，自包含，不依赖外部 skills。

Skill 定位：为 agent 节点提供方法论和格式规范。在 swarm 节点中通过 `expert.skills` 或 `expert_defaults.skills` 注入；在 agent 节点中通过 `node.skills` 注入。

---

## 通用 SKILL.md frontmatter 格式

```yaml
---
name: octo-xzf-{name}
description: "[一句话描述]"
category: coding-assistant
tags: [xzf-pipeline, ...]
version: 1.0.0
priority: high
---
```

---

## 6 个 Skill 详细设计

### 1. octo-xzf-clarify

**文件**: `packages/core-pack/skills/octo-xzf-clarify/SKILL.md`

**核心职责**: Stage 2 澄清循环中的头脑风暴方法论

**内容要点**:

```markdown
# 需求澄清方法论

## 触发条件
当 swarm 节点进行需求澄清头脑风暴时加载此 skill。

## 澄清流程

### 第一步：功能完整性分析
无论什么 idea，都要思考功能完整性和所有环节的闭环：
- 输入端：用户从哪来？什么角色？
- 处理端：核心业务逻辑是什么？
- 输出端：结果呈现给谁？以什么形式？
- 异常端：失败、超时、并发怎么处理？
- 边界端：数据量极限、并发极限、权限极限

### 第二步：澄清问题清单生成
输出到 `.octopus/xzf/{branch}/02-clarification/questions.md`

格式要求：
```markdown
# 澄清问题清单 — Round {N}

## 核心分解
[将 idea 分解为核心功能模块]

## 澄清项

### Q-1: [问题标题]
**背景**: [为什么需要澄清]
**推荐方案**: [方案 A — 推荐]
  - 描述: ...
  - 优点: ...
  - 缺点: ...
**备选方案 1**: [方案 B]
  - 描述: ...
**备选方案 2**: [方案 C]
  - 描述: ...

### Q-2: [问题标题]
...

## Research 项（需要专家深入理解的内容）

### R-1: Codebase Research
- **范围**: {哪些模块/文件需要专家重点研究}
- **目的**: {为什么需要理解这部分}
- **用户补充**: {用户可以提供的上下文/文档链接}

### R-2: 技术调研
- **范围**: {需要调研的技术方案/第三方库}
- **目的**: {为什么需要调研}
- **用户补充**: {已知的参考资料/对比候选}
```

> Research 项与功能澄清项、环境澄清项并列，不是独立阶段。用户在 approval 中一并回答。
> Research 答案下游流入 `technical-guide.md`（技术调研结论）和对应 spec 文件（codebase 研究结论）。

### 第三步：测试环境澄清（关键）
**必须**澄清以下 E2E 测试环境信息，否则验证阶段无法执行：

1. **数据库**
   - 类型（SQLite/PostgreSQL/MySQL）
   - 连接信息（host, port, database, user, password）
   - 初始 Schema 和种子数据
   - 测试隔离策略（事务回滚/独立数据库/表前缀）

2. **缓存服务**
   - Redis/Memcached 连接信息
   - 如果项目需要但没有，是否需要安装

3. **项目启动**
   - 启动命令（pnpm dev / npm start / 等）
   - 端口分配（前端、后端）
   - 环境变量配置

4. **测试执行**
   - 如何运行 E2E 测试（browse CLI / playwright / curl）
   - 测试数据准备方式
   - 截图保存路径

5. **依赖安装**
   - 已安装的依赖列表
   - 需要安装但尚未安装的依赖
   - 安装命令提示

### 第四步：充分性评估
每轮澄清后评估：
- 是否所有核心功能都有对应澄清项
- 测试环境信息是否完整
- 是否可以结束澄清进入下一阶段

## 输出规范
- 每个澄清问题提供 2-3 种方案，第 1 个为推荐
- 用户在下一轮 approval 中回答或追加修改
- 问题清单是追加模式，每轮标记 Round N
```

---

### 2. octo-xzf-story-writer

**文件**: `packages/core-pack/skills/octo-xzf-story-writer/SKILL.md`

**核心职责**: Stage 3 用户故事总汇文档生成

**内容要点**:

```markdown
# 用户故事总汇方法论

## 触发条件
Stage 3 swarm 节点，根据澄清后的需求生成完整用户故事文档。

## 输出文件
1. `.octopus/xzf/{branch}/03-stories/summary.md` — 故事总汇
2. `.octopus/xzf/{branch}/03-stories/technical-guide.md` — 技术指导文档

## 故事总汇文档结构

```markdown
# 用户故事总汇

## 功能概述
[一段话描述本次 feature 的核心价值]

## 角色定义
| 角色 | 描述 | 关键场景 |
|------|------|---------|
| [角色A] | [描述] | [主要使用场景] |

## 完整故事线

### 故事 1: [故事标题]
**角色**: [谁]
**目标**: [要达成什么]
**路径**: [从头到尾的操作流程]
**完成标准**: [怎么算完成]

### 故事 2: [故事标题]
...

## 功能组合矩阵
[哪些故事共享功能模块，哪些独立]

## 功能闭环检查
- [ ] 每个角色的所有场景都已覆盖
- [ ] 异常流程已考虑（网络断开、权限不足、数据不存在）
- [ ] 数据生命周期完整（创建→读取→更新→删除）
```

## 技术指导文档结构

```markdown
# 技术指导文档

## 测试环境配置
[基于澄清阶段的测试环境信息]

### 数据库配置
- 类型: ...
- 连接: ...
- 初始数据: ...

### 服务启动
- 前端: ...
- 后端: ...

### E2E 测试方法
- 工具: browse / playwright / curl
- 执行方式: ...
- 截图路径: ...

## 技术约束
- 框架版本限制
- 第三方服务依赖
- 性能要求

## 测试数据准备
- 种子数据脚本
- 测试用户账号
- Mock 数据策略
```
```

---

### 3. octo-xzf-spec-designer

**文件**: `packages/core-pack/skills/octo-xzf-spec-designer/SKILL.md`

**核心职责**: Stage 4 Spec DSL 设计

**内容要点**:

```markdown
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
```

---

### 4. octo-xzf-task-planner

**文件**: `packages/core-pack/skills/octo-xzf-task-planner/SKILL.md`

**核心职责**: Stage 5 任务拆解与文档生成

**内容要点**:

```markdown
# 任务拆解方法论

## 触发条件
Stage 5 swarm 节点，为每个 spec 生成任务计划文档。

## 输出文件（per spec）
```
05-plans/spec-{NNN}-{name}/
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
```

---

### 5. octo-xzf-executor

**文件**: `packages/core-pack/skills/octo-xzf-executor/SKILL.md`

**核心职责**: Stage 6 任务执行与 verify-fix 循环

**内容要点**:

```markdown
# 任务执行方法论

## 触发条件
Stage 6 agent 节点，执行 spec 的实现和验证。

## 执行流程

### Phase 1: Task 实现
对每个 task-x-y-role.md：
1. 读取任务文档，理解需求
2. 读取 consensus.md，遵守共用约定
3. 按实现步骤编码
4. 确保代码通过 lint 和 type check

### Phase 2: Task 验证（verify-fix 循环）
对每个 verify-x-y.md：
```
loop (max 3 times):
  1. 按 verify 文档执行验证
  2. IF 通过 → break, 记录结果
  3. IF 失败 → 分析原因, 修复代码, 重新验证
  4. IF 达到 max → 生成失败报告, 通知用户, 等待干预
```

### Phase 3: Spec E2E 验证
所有 task 通过后：
```
loop (max 3 times):
  1. 按 spec-test.md 逐步执行 E2E 验证
  2. IF 全部通过 → break, spec 完成
  3. IF 失败 → 分析失败步骤, 定位问题 task, 修复
  4. IF 达到 max → 生成失败报告, 通知用户, 等待干预
```

## 验证结果记录
每个验证结果写入 `06-execution/spec-{NNN}-{name}/verify-results/`:
```markdown
# Verify-{X}-{Y} 结果

## 状态: PASS / FAIL
## 执行时间: {timestamp}
## 证据
### 测试输出
```
{测试命令输出}
```
### 截图（如有）
![](screenshot-{timestamp}.png)
### DB 验证（如有）
```sql
{查询结果}
```
```

## 失败报告格式
失败时写入 `07-reports/failure-{timestamp}.md`:
```markdown
# 失败报告

## 失败位置
- Spec: spec-{NNN}-{name}
- Task: task-{X}-{Y}-{Role}
- Verify: verify-{X}-{Y}

## 失败原因
{详细分析}

## 已尝试的修复
1. {修复 1}: {结果}
2. {修复 2}: {结果}
3. {修复 3}: {结果}

## 建议的人工干预方案
{给用户的建议}

## 现场保留
- 代码变更: {git diff 摘要}
- 日志: {相关日志路径}
- 截图: {截图路径}
```

## 通知
失败时通过 Octopus notify → hermes CLI → xzf_hermes 群：
- 消息格式: "[xzf-pipeline] Spec-{NNN} Task-{X}-{Y} 验证失败，已生成报告: 07-reports/failure-{timestamp}.md"

## 保真要求
- 不允许跳过验证
- 不允许伪造通过
- 必须有真实性证明（测试输出、截图、DB 查询结果）
- 阻塞时说明理由，等待用户干预
```

---

### 6. octo-xzf-ship

**文件**: `packages/core-pack/skills/octo-xzf-ship/SKILL.md`

**核心职责**: Stage 7 PR/MR 生成与提交

**内容要点**:

```markdown
# Ship 交付方法论

## 触发条件
Stage 7 agent 节点，所有 spec 执行完毕后生成 PR/MR。

## Remote 检测

```bash
REMOTE_URL=$(git remote get-url origin)

# 判断平台类型
if echo "$REMOTE_URL" | grep -q "github.com"; then
  PLATFORM="github"
elif echo "$REMOTE_URL" | grep -q "gitlab"; then
  PLATFORM="gitlab"
else
  PLATFORM="unknown"
fi
```

## PR/MR Summary 生成

输出到 `.octopus/xzf/{branch}/08-ship/summary.md`:

```markdown
# {Feature 标题}

## 功能概括
[一段话描述核心功能]

## 实现内容

### 模块 A: {模块名}
- {简要描述}
- 涉及文件: {文件列表}

### 模块 B: {模块名}
- {简要描述}
- 涉及文件: {文件列表}

## 用户故事
- ✅ 故事 1: {描述}
- ✅ 故事 2: {描述}
- ✅ 故事 3: {描述}

## DB Schema 变更
| 操作 | 表名 | 变更内容 |
|------|------|---------|
| 新增 | tb_xxx | {字段} |
| 修改 | tb_yyy | {变更} |

## 核心实现
### 技术决策
- {决策 1}: {原因}
- {决策 2}: {原因}

### 约定
- {约定 1}
- {约定 2}

## E2E 验证结果
- ✅ Spec-001: 全部通过
- ✅ Spec-002: 全部通过
- 验证详情: `.octopus/xzf/{branch}/06-execution/`
```

## 提交命令

### GitHub
```bash
gh pr create \
  --title "{feature 标题}" \
  --body-file ".octopus/xzf/{branch}/08-ship/summary.md" \
  --base main
```

### GitLab
```bash
glab mr create \
  --title "{feature 标题}" \
  --description "$(cat .octopus/xzf/{branch}/08-ship/summary.md)" \
  --target-branch main
```
```

---

## 设计原则

1. **自包含**: 每个 skill 独立可用，不依赖外部 skills
2. **方法论驱动**: 提供"怎么做"而不是"用什么做"
3. **格式规范**: 统一的文档结构和命名约定
4. **可追溯**: 每个阶段的输出都有明确的路径和格式
5. **闭环验证**: 从澄清到交付，每个环节都有验证点
6. **渐进细化**: 从 idea 到 spec 到 task，粒度逐步增加
