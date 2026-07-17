# Skill 套件设计

## 概述

9 个 skill，放置在 `packages/core-pack/skills/octo-xzf-*/SKILL.md`，运行时通过 resource 模块安装。

所有 skill 使用 `octo-xzf-` 前缀，自包含，不依赖外部 skills。

Skill 定位：为 agent 节点提供方法论和格式规范。在 swarm 节点中通过 `expert.skills` 或 `expert_defaults.skills` 注入；在 agent 节点中通过 `node.skills` 注入。

## 设计原则

- **Skill = 方法论**: skill 包含完整的执行方法、输出格式、处理逻辑
- **Prompt = 编排**: workflow 中的 prompt 只指定输入/输出路径和执行顺序
- **引用关系**: workflow 节点通过 `skills:` 字段加载 skill，skill 内容注入到 agent 上下文
- **Swarm 注入**: swarm 节点通过 `expert_defaults.skills`（全员共享）和 `expert.skills`（per-expert 追加）注入 skill

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

## 9 个 Skill 详细设计

### 0. octo-xzf-init

**文件**: `packages/core-pack/skills/octo-xzf-init/SKILL.md`
**使用节点**: Stage 0 `init` (agent)
**核心职责**: Pipeline 环境初始化

#### 执行步骤

**Step 1: 分支检测**
获取当前 git worktree 分支名。
设变量: `branch`

**Step 2: Remote 检测**
检测 `git remote get-url origin`:
- `github.com` → `github`
- `gitlab` → `gitlab`
- 其他 → `unknown`

设变量: `remote_type`

**Step 3: 目录创建**
创建 `.octopus/xzf/{branch}/` 及子目录:
```
02-research/_scan/, 03-clarification/, 04-stories/,
05-specs/, 06-plans/, 07-execution/, 08-reports/, 09-ship/
```

**Step 4: Workspace 拓扑扫描**

项目发现:
```bash
find . -maxdepth 3 -name ".git" -type d
# 排除 .worktrees/, node_modules/
```

技术栈识别（读取 manifest）:
- `package.json` → Node.js/TypeScript（检查 next/react/vue 等）
- `go.mod` → Go
- `Cargo.toml` → Rust
- `pyproject.toml` → Python

约定提取:
- 读取各项目 `CLAUDE.md`（如存在）
- 提取: 框架、代码风格、测试框架、关键目录

项目间依赖分析:
- workspace 级 package.json 中的 workspace 引用
- go.mod 中的 replace 指令
- import 路径中的跨项目引用

端口检测:
- `.env` / config 文件中的 PORT 设置

**Step 5: 输出 workspace-topology.md**

```markdown
# Workspace 拓扑

> 生成时间: {ISO timestamp}
> 分支: {branch}

## 项目列表
| 项目 | 路径 | 技术栈 | 主要模块 | 端口 |
|------|------|--------|---------|------|

## 项目间通信
| 源 | 目标 | 方式 | 说明 |
|----|------|------|------|

## 项目约定
### {project-name}
- 框架: ...
- 样式: ...
- 状态管理: ...
- 测试: ...

## 关键入口文件
### {project-name}
- 路由: src/app/
- 组件: src/components/
- API: src/app/api/
```

**Step 6: 设置变量**
```json
{"vars_update": {"branch": "...", "remote_type": "...", "workspace_topology": "已生成"}}
```

---

### 1. octo-xzf-research

**文件**: `packages/core-pack/skills/octo-xzf-research/SKILL.md`
**使用节点**: Stage 1 `idea-research` (swarm dispatch, 每位专家加载)
**核心职责**: Codebase 领域研究 + 外部调研

#### 输入

- **Idea 文档**: `.octopus/xzf/{branch}/01-idea.md`
- **Workspace 拓扑**: `.octopus/xzf/{branch}/workspace-topology.md`
- **预扫描结果**: `.octopus/xzf/{branch}/02-research/_scan/`

#### 01-idea.md 格式

```markdown
# Idea
## 需求描述
{原始需求}

## Research 指引（可选）
### 内部研究重点
{codebase 中需要重点研究的模块/方向}

### 外部调研
{需要调研的外部平台/技术/库，可附 URL}
```

#### 三层研究方法论

每位专家的研究文件包含三层:

**1. Internal (Codebase)**
- 现有实现摘要（关键文件、模式、约定）
- 代码结构（入口文件、核心模块）
- 已有能力和限制

**2. External (Domain Knowledge)**
- 相关技术知识和最佳实践
- 外部平台 API 文档（使用 WebFetch 读取）
- 框架特性、库用法

**3. Key Decisions**
- 对后续开发有指导意义的信息
- 技术选型建议
- 风险和注意事项

#### Research 指引处理

如有 Research 指引:
- **内部研究重点** → 优先定位指引中的模块深入分析
- **外部调研** + URL → 使用 WebFetch 读取文档，提取关键信息
- **外部调研** 无 URL → 使用 WebSearch 搜索相关知识

如无 Research 指引:
- 根据 Idea 内容自行判断需要研究什么
- 重点关注 Idea 涉及的现有模块

#### 外部调研输出格式

调研外部平台时，提取:
- 认证方式
- 核心接口列表（Method + Path + 用途）
- 回调/webhook 机制
- 频率限制
- 对本次 Idea 的影响

#### 研究文件输出格式

写入: `.octopus/xzf/{branch}/02-research/{domain}.md`

```markdown
# {领域}研究

## Internal
{现有代码实现摘要}

## External
{外部知识/平台 API/最佳实践}

## Key Decisions
{决策信息}

## GAPS（如有未覆盖领域）
{标记 + 建议在澄清阶段补充}
```

#### 预扫描文件使用

_scan/ 目录文件用于快速定位:
- `file-tree.txt` → 项目文件结构
- `deps.txt` → 依赖和版本
- `claude-mds.txt` → 项目约定
- `api-entries.txt` → API 入口文件
- `db-schemas.txt` → 数据模型文件
- `test-config.txt` → 测试配置

先读预扫描文件定位，再 Read 目标文件深入分析。避免盲读。

---

### 2. octo-xzf-clarify

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
输出到 `.octopus/xzf/{branch}/03-clarification/questions.md`

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

### 测试环境强制清单（退出澄清前必须全部明确）

- [ ] 数据库类型 + 连接信息 + 种子数据方式
- [ ] 中间件（Redis/MQ 等）连接信息
- [ ] 各项目启动命令 + 端口
- [ ] E2E 测试工具（browse/playwright/curl）+ 执行方式
- [ ] 截图/报告保存路径
- [ ] 测试数据准备方式（API/DB fixture/seed script）

如清单未完成，必须在 questions.md 末尾标注:
"⚠️ 环境信息不完整: {缺失项列表}"

Host 综合输出中逐项检查此清单，输出 env_checklist_status:
- "COMPLETE" — 全部明确
- "INCOMPLETE: {缺失项逗号分隔}" — 有未明确项

## 输出规范
- 每个澄清问题提供 2-3 种方案，第 1 个为推荐
- 用户在下一轮 approval 中回答或追加修改
- 问题清单是追加模式，每轮标记 Round N
```

---

### 3. octo-xzf-story-writer

**文件**: `packages/core-pack/skills/octo-xzf-story-writer/SKILL.md`

**核心职责**: Stage 3 用户故事总汇文档生成

**内容要点**:

```markdown
# 用户故事总汇方法论

## 触发条件
Stage 3 swarm 节点，根据澄清后的需求生成完整用户故事文档。

## 输出文件
1. `.octopus/xzf/{branch}/04-stories/summary.md` — 故事总汇
2. `.octopus/xzf/{branch}/04-stories/technical-guide.md` — 技术指导文档（架构决策、技术约束）
3. `.octopus/xzf/{branch}/04-stories/test-environment.md` — 测试环境完整配置（供 Stage 6 执行读取）

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

## 技术约束
- 框架版本限制
- 第三方服务依赖
- 性能要求

## 架构决策
- {决策 1}: {原因}
- {决策 2}: {原因}

## 项目间通信约定
- {project-web} ↔ {project-service}: {协议 + 接口}
```

## 测试环境文档结构

```markdown
# 测试环境配置

## 数据库
| 项目 | 类型 | 连接串格式 | 种子数据 |
|------|------|-----------|---------|

## 中间件
| 类型 | 连接信息 | 用途 | 清理策略 |
|------|---------|------|---------|

## 项目启动（per project）
| 项目 | 命令 | 端口 | 健康检查 |
|------|------|------|---------|

## E2E 测试
- 工具: browse / playwright / curl
- 启动方式: {如何启动/连接}
- 截图目录: .octopus/xzf/{branch}/07-execution/.../screenshots/
- 执行模式: headless / headed

## 测试数据准备
- 方式: {seed script / API fixture / DB insert}
- 脚本路径: {path}
- 测试账号: {pairs}

## 环境就绪检查
E2E 执行前必须确认:
- [ ] 数据库已连接
- [ ] 各项目已启动且健康检查通过
- [ ] 测试数据已准备
- [ ] E2E 工具可用
```
```

---

### 4. octo-xzf-spec-designer

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
```

---

### 5. octo-xzf-task-planner

**文件**: `packages/core-pack/skills/octo-xzf-task-planner/SKILL.md`

**核心职责**: Stage 5 任务拆解与文档生成

**内容要点**:

```markdown
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
```

---

### 6. octo-xzf-orchestrator

**文件**: `packages/core-pack/skills/octo-xzf-orchestrator/SKILL.md`

**核心职责**: Stage 6 执行编排 — 协调者（父 agent）专用，**线性委派器**

**加载方式**: 父 agent 通过 `skills: [octo-xzf-orchestrator]` 加载

**关键设计**: 协调者只做排序 + 委派 + 检查结果。verify-fix 循环下沉到子代理（见 octo-xzf-implementer skill）

**内容要点**:

```markdown
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
```

---

### 7. octo-xzf-implementer

**文件**: `packages/core-pack/skills/octo-xzf-implementer/SKILL.md`

**核心职责**: Stage 6 子 agent 执行方法论 — 自治实现/验证/修复循环

**加载方式**: 所有 subagent 通过 `skills: [octo-xzf-implementer]` 加载

**关键设计**: verify-fix 循环下沉到子代理内部，协调者只看到最终 PASS/FAIL

**内容要点**:

```markdown
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

子代理执行完毕后，**必须**返回结构化 JSON，供协调者解析：

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
```

---

### 8. octo-xzf-ship

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

输出到 `.octopus/xzf/{branch}/09-ship/summary.md`:

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
- 验证详情: `.octopus/xzf/{branch}/07-execution/`
```

## 提交命令

### GitHub
```bash
gh pr create \
  --title "{feature 标题}" \
  --body-file ".octopus/xzf/{branch}/09-ship/summary.md" \
  --base main
```

### GitLab
```bash
glab mr create \
  --title "{feature 标题}" \
  --description "$(cat .octopus/xzf/{branch}/09-ship/summary.md)" \
  --target-branch main
```
```

---

## 设计原则

1. **自包含**: 每个 skill 独立可用，不依赖外部 skills
2. **方法论驱动**: 提供"怎么做"而不是"用什么做"
3. **格式规范**: 统一的文档结构和命名约定
4. **Host 写文件 + 短 synthesis**: swarm host 通过 Write 工具直接写入完整文件（无字数限制），synthesis 文本只放摘要摘要（受 2000 字限制，供下游 approval 显示用）
5. **Expert 直接写文件（dispatch 模式）**: dispatch 模式下 expert 各自使用 Write 工具直接写入指定文件，host 只做一致性检查
6. **可追溯**: 每个阶段的输出都有明确的路径和格式
7. **闭环验证**: 从澄清到交付，每个环节都有验证点
8. **渐进细化**: 从 idea 到 spec 到 task，粒度逐步增加

---

## Skill-Node 引用关系

| Skill | 使用节点 | 节点类型 | 加载方式 |
|-------|---------|---------|---------|
| `octo-xzf-init` | `init` | agent | `skills: [octo-xzf-init]` |
| `octo-xzf-research` | `idea-research` | swarm | `expert_defaults.skills: [octo-xzf-research]` |
| `octo-xzf-clarify` | `brainstorm` | swarm | `expert_defaults.skills: [octo-xzf-clarify]` |
| `octo-xzf-story-writer` | `story-generation` | swarm | `expert_defaults.skills: [octo-xzf-story-writer]` |
| `octo-xzf-spec-designer` | `spec-design` | swarm | `expert_defaults.skills: [octo-xzf-spec-designer]`；test-architect/security-expert 在 **plan-spec** 通过 `expert.skills` 追加 |
| `octo-xzf-task-planner` | `plan-spec` | swarm | `expert_defaults.skills: [octo-xzf-task-planner]`；test-architect/security-expert 在 **spec-design** 通过 `expert.skills` 追加 |
| `octo-xzf-orchestrator` | `execute-spec-tasks` | agent (线性委派器) | 父 agent: `skills: [octo-xzf-orchestrator]` — 只做排序+委派+检查，verify-fix 循环在子代理内部 |
| `octo-xzf-implementer` | `execute-spec-tasks` | agent (自治子代理) | subagents: `skills: [octo-xzf-implementer]` — 自治 verify-fix 循环 (max 3)，返回结构化 JSON |
| `octo-xzf-ship` | `ship-summary` | agent | `skills: [octo-xzf-ship]` |

**Skills 合并策略**（依赖 Phase 1 代码变更 — 见 `01-expertdef-skills-extension.md`）：

```
expert_defaults.skills = [A, B]
expert.skills = [C]
→ 最终 expert.skills = [A, B, C]  // 合并，不覆盖
```

- `expert_defaults.skills` — 全员共享，swarm 节点内所有专家自动加载
- `expert.skills` — per-expert 追加，用于个别专家需要额外方法论时
