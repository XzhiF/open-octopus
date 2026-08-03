# Requirement Brief

## Overview
将 `octo-workflow-dev` 重构为 AI 友好的向导型 Skill，整合 `octo-swarm-dev` 和 `octo-workflow-test`，补全 interaction/sub_workflow 节点，生成 L1-L3 schema 验证脚本。

## Projects Involved
- [ ] .claude/skills/ (skill 文件)
- [ ] packages/core-pack/ (skill 副本同步)
- [ ] packages/shared/ (Zod → JSON Schema 生成)

## Feature Scope
**Do:**
- 重构 octo-workflow-dev SKILL.md 为分步向导流程编排器
- 拆分 reference 文档为 8 个专门文件（按职责拆分）
- 整合 octo-swarm-dev 内容到 octo-workflow-dev
- 整合 octo-workflow-test 内容到 octo-workflow-dev
- 补全 interaction 和 sub_workflow 节点类型文档
- 生成新的 validate 脚本覆盖 L1（结构）+ L2（交叉约束）+ L3（语义）
- 生成 Zod → JSON Schema 工具供 validate 脚本使用
- 添加 depends_on 完整性检查作为硬约束
- 删除 octo-swarm-dev 和 octo-workflow-test 目录
- 所有 skill description 改为 "When using" 英文格式
- 向导完成后询问用户是否生成测试

**Don't:**
- 不修改 engine 执行器代码
- 不修改 Zod schema 定义本身
- 不修改 web-app UI
- 不修改其他 skill

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | Skill 结构 | 向导流程编排器 + 8 个 reference 文档 | AI 友好，不需要从大文档自己推导路径 |
| 2 | 使用模式 | 完整向导（≥4 节点或复杂类型）+ 快速路径（≤3 简单节点） | 兼顾最小功能测试场景 |
| 3 | 复杂度判断阈值 | ≤3 节点且无 swarm/loop/sub_workflow → 快速路径 | 简单需求不需要完整向导 |
| 4 | Reference 拆分策略 | 按职责拆分（schema/patterns/swarm/composition/conventions/variables/testing/testing-ref） | 每个文件单一职责，AI 按需加载 |
| 5 | Schema 验证级别 | L1（结构）+ L2（交叉约束）+ L3（语义）全覆盖 | 用户明确要求完全覆盖 |
| 6 | depends_on 检查 | 硬约束 — 验证脚本扫描所有非首节点，无 depends_on 报 warning | 高频遗漏问题，需要机器检查而非仅靠文档提醒 |
| 7 | 测试整合时机 | 两个路径都在生成+验证后询问是否生成测试 | 用户明确要求 |
| 8 | 描述格式 | "When using" 英文开头 | Skill 列表一眼可判断是否加载 |
| 9 | 分支名 | feat/skill-workflow-dev-v2 | 新分支 |
| 10 | Skill slug | octo-workflow-dev（原地升级） | 保持兼容性 |

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | AI agent 使用 octo-workflow-dev 创建复杂工作流 | SKILL.md 引导 agent 走 Step 1→6 完整流程，生成的 YAML 通过 validate 脚本 | 端到端：用真实需求走一遍 |
| 2 | AI agent 快速生成最小工作流测试 | ≤3 节点需求自动走快速路径，跳过需求深挖 | 端到端：请求"生成一个 bash 节点测试" |
| 3 | 生成含 interaction 节点的工作流 | interaction_agent、interaction_exit_when、interaction_display 字段正确 | Schema 验证 L3 |
| 4 | 生成含 sub_workflow 节点的工作流 | input_mapping/output_mapping 语法正确，on_error 配置存在 | Schema 验证 L3 |
| 5 | 生成含 swarm 节点的工作流 | 5 种模式文档齐全，交叉约束（expert_pool/experts 互斥等）被检查 | 内容覆盖 + Schema 验证 L2 |
| 6 | 生成缺少 depends_on 的工作流 | validate 脚本报 warning，agent 自动修复 | Schema 验证 L3 |
| 7 | 向导完成后询问测试 | 两个路径都在 Step 5 后询问"是否生成测试" | 流程检查 |
| 8 | 旧 skill 清理 | octo-swarm-dev 和 octo-workflow-test 目录不存在，skill 列表无残留 | 文件检查 |
| 9 | 8 个 reference 文档齐全 | 每个文件存在且内容覆盖对应职责 | 结构完整性检查 |
| 10 | core-pack 同步 | packages/core-pack/skills/octo-workflow-dev/ 包含新文件 | 文件对比 |

## Verification Strategy

### Global Config
- Environment: local
- Test user: N/A (skill 文件，无运行时)
- Data prefix: N/A

### Per-layer Methods
#### Schema 验证脚本测试（最高优先级）
准备测试 YAML 集：
- **合法 YAML**: 含所有 9 种节点类型的工作流 → validate 应通过
- **L1 错误**: 缺少必填字段、类型错误 → validate 应报结构错误
- **L2 错误**: swarm expert_pool+experts 共存、moa 无 aggregator → validate 应报交叉约束错误
- **L3 错误**: depends_on 引用不存在的节点、变量引用语法错误、interaction_exit_when 表达式非法 → validate 应报语义错误

#### 内容覆盖交叉检查
- 对照 `packages/shared/src/types/workflow.ts` 确认 node-schema.md 覆盖所有 9 种节点
- 对照 `packages/shared/src/types/swarm.ts` 确认 swarm-modes.md 覆盖 5 种模式
- 对照 `packages/shared/src/simulator/schemas.ts` 确认 testing.md 覆盖 mock 类型

#### 向导流程端到端
- 用真实需求（"生成含 interaction + sub_workflow 的工作流"）让 agent 走 SKILL 流程
- 验证每个 Step 被触发、reference 被正确引用

#### 结构完整性
- 8 个 reference 文件存在
- SKILL.md 中引用路径全部可解析
- scripts/validate-workflow.* 可执行

#### 清理检查
- `.claude/skills/octo-swarm-dev/` 目录不存在
- `.claude/skills/octo-workflow-test/` 目录不存在
- skill 注册列表无 octo-swarm-dev 和 octo-workflow-test 条目

### Prerequisites
- [ ] 分支 feat/skill-workflow-dev-v2 已创建
- [ ] packages/shared 已构建（Zod schema 可导入）
- [ ] 现有 octo-swarm-dev 和 octo-workflow-test 内容已读取

## Risks & Notes
- R1: Zod → JSON Schema 转换可能有 edge case（如 Zod refine 无法自动转）→ 手动补充
- R2: SKILL.md 向导步骤过多可能导致 AI 跳过步骤 → 保持步骤精简，每步有明确产出
- R3: 快速路径判断阈值（≤3 节点）可能需要调整 → 先用这个值，后续根据使用反馈调整
- R4: core-pack 同步可能遗漏文件 → 用 diff 工具对比

## Glossary (new domain terms)
| Term | Meaning |
|------|---------|
| **向导流程编排器** | SKILL.md 的新结构 — 分步骤引导 AI agent 完成工作流创建，而非参考文档堆砌 |
| **快速路径** | 复杂度 ≤3 简单节点时跳过的精简流程，直接生成+验证 |
| **L1 结构验证** | YAML 可解析、必填字段存在、类型正确 |
| **L2 交叉约束** | 字段间的逻辑约束（互斥、依赖、拓扑） |
| **L3 语义检查** | 引用完整性（depends_on 目标存在、变量语法合法、表达式可解析） |
