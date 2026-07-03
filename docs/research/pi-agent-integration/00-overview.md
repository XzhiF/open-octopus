# Pi Agent SDK 集成调研报告 — 总览

> 调研日期：2026-07-03
> Pi 版本：`@earendil-works/pi-*@0.80.3`
> Octopus 版本：`1.0.0`
> 状态：**调研完成 + 实测验证通过 ✅**（DashScope qwen3-max 三层全链路 3/3 测试通过）

---

## 背景与目标

Octopus 当前的 `IAgentProvider` 仅有 `ClaudeSDKProvider` 一个实现，绑定 Anthropic Claude Agent SDK。目标是集成 Pi Agent SDK（`@earendil-works/pi-coding-agent`）作为第二个 Provider，实现：

1. **多 LLM 提供商支持** — 通过 pi-ai 支持 40+ 提供商（OpenAI、Google、DeepSeek、Mistral 等）
2. **完整 Agent Loop** — 使用 pi-agent-core 的 agent-loop，含扩展系统、工具执行管道
3. **工作流兼容** — 完美支持 YAML 中所有特性（子代理、技能、Auto Answers、变量系统、Goal Mode）
4. **可扩展架构** — Pi 的 Extension 系统为 Octopus 提供自定义工具、Hook、Provider 注册能力

## 用户决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 基础层 | `pi-coding-agent` | 完整工具集（Bash/Read/Write/Edit/Grep/Find/Ls）、Extension 系统、Session 管理 |
| 代码位置 | `packages/providers/src/pi/` | 与现有 ClaudeSDKProvider 共享类型和注册表 |
| LLM 提供商 | 全部 pi-ai 提供商 | 支持工作流节点级别切换模型/提供商 |

## 文档导航

| 章节 | 文件 | 内容 |
|------|------|------|
| 1 | [01-pi-architecture.md](./01-pi-architecture.md) | Pi 三层架构深度分析：pi-ai → pi-agent-core → pi-coding-agent |
| 2 | [02-octopus-provider-analysis.md](./02-octopus-provider-analysis.md) | Octopus Provider 体系：接口、消息协议、引擎集成 |
| 3 | [03-integration-design.md](./03-integration-design.md) | **核心设计**：事件映射、异步桥接、文件结构、关键代码模式 |
| 4 | [04-feature-bridging.md](./04-feature-bridging.md) | 功能桥接：子代理、技能注入、Auto Answers、Session Resume |
| 5 | [05-testing-strategy.md](./05-testing-strategy.md) | **真实测试策略**：单元/集成/E2E 三层测试 + Mock 方案 |
| 6 | [06-implementation-roadmap.md](./06-implementation-roadmap.md) | 分阶段实现计划 + 风险清单 |
| 7 | [07-model-alias-strategy.md](./07-model-alias-strategy.md) | **模型别名路由**：pro-max/pro/se tier 系统 + 配置文件设计 |
| 8 | [08-feasibility-verification.md](./08-feasibility-verification.md) | **可行性验证**：三项源码验证 + 设计修正 + **实测结果** + 最终风险矩阵 |

## 重点范围

### 核心难点（必须解决）

1. **异步桥接** — Pi 的 push-based `Agent.subscribe()` → Octopus 的 pull-based `AsyncGenerator<MessageChunk>`
2. **事件映射完整性** — Pi 的 10 种 AgentEvent + 12 种 AssistantMessageEvent → Octopus 的 18 种 MessageChunk
3. **子代理工具化** — YAML `agents` 定义 → Pi Extension Tool，支持嵌套 Session
4. **多提供商模型解析** — Octopus 的 `model: "gpt-4o"` 字符串 → Pi 的 `Model<Api>` 对象
5. **模型别名路由** — YAML 中 `pro-max`/`pro`/`se` → 按 provider 解析为真实模型名（第 7 章）

### 次要但重要

5. **Session Resume** — Octopus `resumeSessionId` → Pi Session 持久化/恢复
6. **System Prompt 覆盖** — Octopus executor 构建的 prompt 注入到 Pi 的 system prompt
7. **Token 追踪** — Pi 的 `Usage` → Octopus 的 `TokenUsage` + `ModelUsageEntry[]`
8. **Abort 信号传递** — Octopus `AbortSignal` → Pi `Agent.abort()`

### 明确不做

- ❌ 不替换 ClaudeSDKProvider（共存，按 `engine` 字段路由）
- ❌ 不实现 Pi 的 TUI（Octopus 用 web-app，Pi 在 headless 模式运行）
- ❌ 不实现 Pi 的 OAuth 流程（首版只用 API Key）

### 实现优先级

模型别名系统（第 7 章）**独立于 Pi 集成**，可以先行实现，让现有 ClaudeSDKProvider 立刻受益。推荐顺序：

1. **先做**：模型别名路由（~2 小时）— 所有 provider 通用
2. **再做**：Pi Provider 核心集成（Phase 1-2，~5 天）
3. **最后**：Pi 功能扩展 + 生产加固（Phase 3-4，~5 天）

## 快速验证方法

```bash
# 1. 安装 Pi 依赖（本地开发）
cd C:/xzf/ai/open-octopus
pnpm add @earendil-works/pi-ai@0.80.3 @earendil-works/pi-agent-core@0.80.3 @earendil-works/pi-coding-agent@0.80.3

# 2. 构建
pnpm build --filter @octopus/providers

# 3. 最小验证：单 agent 节点
cat > test-pi.yaml << 'EOF'
apiVersion: octopus/v1
kind: Workflow
name: pi-smoke-test
engine: pi
model: anthropic/claude-sonnet-4-20250514
nodes:
  - id: hello
    type: agent
    prompt: "Say hello and list files in current directory using bash."
EOF

octopus workflow run ./test-pi.yaml --org xzf
```
