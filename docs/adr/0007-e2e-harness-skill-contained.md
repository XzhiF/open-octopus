# ADR-0007: E2E Harness 采用 Skill 内聚架构

## Status

Accepted (2026-08-03)

## Context

Octopus 的 E2E 测试存在两个完全隔离的生态：
1. `.scratch/*/e2e-scripts/` — 14 个 feature 的 ad-hoc `.mjs` 脚本，~5,152 行一次性代码
2. `packages/web-app/e2e/` — 14 个正式 Playwright `.spec.ts` 文件，有 config 和 helpers

两个生态零交叉复用。`.scratch/` 脚本中 6-8 个基础设施函数（workspace 生命周期、execution 轮询、浏览器管理、结果记录）在每个 feature 中被完整重写，造成 ~2,400 行重复代码和巨大的调试成本。

需要建立一个可复用的 E2E 测试基础设施，核心问题是：**代码存放在哪里？**

## Decision

采用 **Skill 内聚 (Self-Contained Skill)** 方案：所有 lib/ 模块、patterns/、recipes/、baselines/ 全部存放在 `.claude/skills/e2e-harness/` 内部。

### 被否决的替代方案

1. **共享代码库 (Unified)**：核心模块放在 `packages/web-app/e2e/helpers/`，与正式 Playwright 测试共享。被否决原因：Skill 跨两个目录位置，依赖 web-app 的 TypeScript 编译链，不可移植。

2. **独立共享层 (Three-Layer)**：在项目根目录创建 `e2e-harness/` 作为 workspace package。被否决原因：引入新的顶层目录，增加项目结构复杂度，对于一个 skill 来说过重。

## Consequences

**正面：**
- Skill 完全自包含，可以复制到其他项目使用
- import 路径简单（相对路径 `./lib/workspace.mjs`）
- 不依赖 web-app 的 TypeScript 编译链（纯 .mjs）
- 与 `.claude/` 生态（skills, agents, commands）保持一致

**负面：**
- 与 `packages/web-app/e2e/` 的正式 Playwright 测试不共享代码
- 两套测试基础设施并行维护（但职责明确分离：ad-hoc 验证 vs 持续回归）

**缓解：**
- 两者的职责边界清晰：`web-app/e2e/` 负责持续回归测试（CI/CD），`e2e-harness` 负责 feature 开发阶段的快速验证
- 如果未来需要共享，可以通过 `e2e-harness` 的 modules 导出给 web-app 测试使用
