# Requirement Brief: Workflow Simulator V2 — 闭环测试

## Overview
补全 V1 缺失的"后半段"——通过 `octo-workflow-test` skill 让 workspace clone 具备智能 fixture 生成、模拟执行、结果解读和自动迭代修复能力，实现工作流测试的完整闭环。

## Projects Involved
- [x] `packages/core-pack` (新 skill: `octo-workflow-test`)
- [x] `packages/core-pack` (扩展: `octo-workflow-dev` §10 添加测试引用)
- [x] `packages/cli` (Phase 2: `workflow test` 命令，CLI → Server → Clone)
- [ ] `packages/server` (无需改动 — 复用现有 `POST /api/agent/chat` + `delegate_to`)
- [ ] `packages/engine` (无需改动 — V1 simulator 已完整)

## Feature Scope

**Do:**
- 创建 `octo-workflow-test` skill — 教会 agent 完整的测试闭环
  - 工作流结构分析 (扫描节点类型、变量流向、依赖图)
  - 智能 mock 数据生成 (从 prompt/outputs/when 推断语义)
  - 自动生成 test.yaml fixture
  - 执行 `octopus workflow simulate` 并解析结果
  - 失败时自动修复 test.yaml (最多 3 轮)
  - 生成诊断报告 (3 轮后仍失败时)
- 扩展 `octo-workflow-dev` — §10 添加 `octo-workflow-test` 引用
- Phase 2: CLI `octopus workflow test` 命令 (CLI → Server API → workspace clone)

**Don't:**
- 改动 simulator engine (V1 已完整)
- 改动 server API (复用现有 delegate_to 机制)
- Web UI 集成 (future)
- CI/CD 集成 (future)

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | Skill 设计 | 独立 `octo-workflow-test` skill | 职责单一，workspace clone `skills:[]` 自动继承 |
| 2 | 调用路径 | Workspace clone + skill | 自然利用现有 clone 架构，agent 有完整工具链 |
| 3 | Mock 智能 | Skill 教 agent 从 YAML 推断 | prompt/outputs/when 包含足够语义信息 |
| 4 | CLI bridge | 复用 `POST /api/agent/chat` | 已有完整的 SSE 流式通信，无需新建 |
| 5 | 闭环协议 | 全自动修复，最多 3 轮 | 最少人工干预，超出交开发者 |

## Decision Map Summary

| # | Ticket | Type | Decision |
|---|--------|------|----------|
| 01 | Skill 设计 | grilling | 独立 skill `octo-workflow-test` |
| 02 | 调用路径 | grilling | Workspace clone + skill (Claude Code 直接 / CLI Phase 2) |
| 03 | Mock 智能 | research | 从 prompt/outputs/when/depends_on 推断 mock 数据 |
| 04 | CLI bridge | research | 复用 `POST /api/agent/chat { delegate_to: "workspace" }` |
| 05 | 闭环协议 | grilling | 全自动 3 轮迭代，超出则诊断报告 |

Map: [map.md](./map.md)

## Skill 设计: `octo-workflow-test`

### SKILL.md 结构

```markdown
---
name: octo-workflow-test
description: 工作流测试助手 — 分析工作流结构，智能生成 test.yaml fixture，运行模拟器，自动迭代修复直到测试通过。
category: devops
tags: [workflow, testing, simulation, mock]
---

# 工作流测试助手

## 1. 前置条件
- 已有 workflow.yaml (通过 octo-workflow-dev 创建)
- octopus CLI 可用 (pnpm build 已执行)

## 2. 工作流分析
读取目标 workflow.yaml，提取:
- 所有节点 (id, type, depends_on)
- 副作用节点列表 (agent/swarm/bash/python/approval)
- 变量流向图 (outputs 映射 → VarPool → 下游 condition/loop)
- 条件表达式 (condition.when, loop.while, loop.break_when)
- 循环结构 (loop.nodes 内部节点)

## 3. Mock 数据生成规则

### Agent 节点
- 从 `prompt` 字段推断输出语义
- 如果有 `outputs:` 映射，为每个 key 生成有意义的 mock 值
- 值应让下游 condition 按 happy path 匹配

### Bash 节点
- 从 `bash` 脚本内容推断输出
- 如果脚本是 `echo "..."` → mock output = echo 的内容 (变量已替换)
- 如果脚本有副作用 (curl/git/npm) → 只 mock output

### Python 节点
- 从 `python` 脚本的 print/return 推断输出
- 与 bash 类似处理

### Swarm 节点
- 整体 mock — 从 `topic` 和 `mode` 推断合理的共识结果
- 输出映射到 `outputs:` 定义

### Approval 节点
- 默认 choice = 第一个 option
- 如果需要测试拒绝路径，生成第二个 scenario

### Loop 节点
- 分析 `while`/`break_when` 条件
- 生成按迭代索引的 mock 数组
- update_vars 必须最终满足终止条件

## 4. Fixture 生成
生成 `{workflow-name}.test.yaml`:
- 至少 1 个 happy path scenario
- 可选: 1 个 failure path scenario (如果工作流有条件分支)
- assertions 包含: status, vars (关键变量), node_trace (executed/skipped)

## 5. 执行与迭代
1. 运行: `pnpm exec octopus workflow simulate {wf.yaml} --json`
2. 解析 JSON 输出
3. 如果 passed=true → 报告成功
4. 如果 passed=false → 分析 assertionReport:
   - vars 不匹配 → 调整 mock 的 update_vars 或 outputs
   - node_trace 不匹配 → 调整 condition mock 让分支正确
   - status 不匹配 → 检查 mock 的 status 字段
5. 修改 test.yaml → 重新运行 (最多 3 轮)
6. 3 轮后仍失败 → 输出诊断报告

## 6. 诊断报告格式
当 3 轮后仍失败时输出:
- 哪些 assertion 持续失败
- 每轮尝试了什么修复
- 可能的根因分析
- 建议开发者检查的方向
```

### octo-workflow-dev §10 扩展

在现有 §10 "验证与运行" 中添加:

```markdown
### 测试 (Simulator)

工作流测试使用 `octo-workflow-test` skill:

1. **自动生成 fixture**: workspace clone 分析工作流 → 生成 `.test.yaml`
2. **运行模拟**: `octopus workflow simulate wf.yaml --verbose`
3. **闭环迭代**: 失败时自动修复，最多 3 轮

详见 `octo-workflow-test` skill。
```

### Phase 2: CLI `workflow test` 命令

```typescript
// packages/cli/src/commands/workflow.ts 新增

workflowCmd
  .command("test")
  .description("智能测试工作流 (workspace clone 生成 fixture + 运行模拟)")
  .argument("<yaml-path>", "工作流 YAML 文件路径")
  .action(async (yamlPath: string) => {
    // POST /api/agent/chat { message, delegate_to: "workspace" }
    // message: "使用 octo-workflow-test skill 测试 {yamlPath}"
    // 读取 SSE 流，打印结果
  })
```

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 开发者创建了一个 workflow.yaml | workspace clone 能分析结构并生成 test.yaml | 手动测试: 对 xzf-dev.yaml 运行 skill |
| 2 | 生成的 test.yaml 有合理的 mock 数据 | mock 值让 happy path 条件正确匹配 | 运行 simulate 后 assertion status=completed PASS |
| 3 | 生成的 test.yaml 包含有意义的 assertions | 包含 status + vars + node_trace | 检查生成的 YAML 内容 |
| 4 | Agent 能运行模拟并解读结果 | 正确解析 --json 输出并识别失败原因 | 手动测试: 注入错误 mock，观察 agent 诊断 |
| 5 | 测试失败时 agent 能自动修复 | 修改 test.yaml 并重新运行，最多 3 轮 | 手动测试: 创建必然失败的场景 |
| 6 | 3 轮后仍失败输出诊断报告 | 报告包含失败原因、尝试过的修复、建议 | 手动测试: 创建无法自动修复的场景 |
| 7 | octo-workflow-dev 引用 octo-workflow-test | §10 中有明确引用 | 检查 skill 文件 |
| 8 | (Phase 2) CLI `workflow test` 可用 | 命令通过 server 委托 workspace clone | E2E: 运行 CLI 命令，验证输出 |

## Verification Strategy

### Unit Tests
- Skill 文件存在且 frontmatter 格式正确
- octo-workflow-dev §10 包含 `octo-workflow-test` 引用

### Integration Tests (手动)
- 对 `packages/core-pack/workflows/xzf-dev.yaml` 运行 skill → 验证生成的 fixture
- 对 swarm templates 运行 skill → 验证 swarm mock 生成
- 注入错误 mock → 验证 agent 能诊断并修复

### E2E Tests
- Claude Code 中 `@@workspace 测试 workflows/xzf-dev.yaml` → 验证完整闭环
- (Phase 2) `octopus workflow test xzf-dev.yaml` → 验证 CLI → Server → Clone 路径

### Prerequisites
- [ ] `pnpm build` 成功
- [ ] Server 运行中 (`pnpm dev`)
- [ ] Workspace clone 已初始化

## Risks & Notes

- **R1: Agent 可能生成不符合意图的 mock** — 3 轮限制 + 诊断报告缓解
- **R2: xzf-dev.yaml 619 行，fixture 可能很大** — skill 应指导 agent 只 mock 副作用节点
- **R3: Skill 依赖 agent 的 YAML 读写能力** — Claude Code SDK 已原生支持文件操作
- **R4: Phase 2 CLI 依赖 server 运行** — 文档中说明 server 必须启动

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| **闭环测试** | 从工作流 YAML 到测试通过的完整自动化流程: 分析 → 生成 fixture → 运行 → 修复 → 通过 |
| **Mock 推断** | Agent 从节点的 prompt/outputs/when 字段推断合理的 mock 数据值 |
| **诊断报告** | 3 轮自动修复后的结构化失败分析，包含根因、尝试记录、建议方向 |
