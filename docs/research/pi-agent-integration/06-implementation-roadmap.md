# 第六章：分阶段实现计划与风险清单

> 本章定义具体的实现阶段、交付物和时间估算。

---

## 6.1 阶段总览

```
Phase 1: 基础设施          Phase 2: 核心桥接           Phase 3: 功能扩展
(1-2 天)                   (2-3 天)                    (2-3 天)
┌─────────────────┐    ┌──────────────────┐     ┌──────────────────┐
│ • 依赖安装       │    │ • async-bridge   │     │ • 子代理工具      │
│ • 文件结构       │───→│ • event-mapper   │────→│ • 技能注入        │
│ • 模型解析       │    │ • token-agg      │     │ • Session Resume  │
│ • 单元测试框架   │    │ • provider.ts    │     │ • System Prompt   │
│                 │    │ • 集成测试        │     │ • E2E 测试        │
└─────────────────┘    └──────────────────┘     └──────────────────┘
                                                        │
                    Phase 4: 生产加固                     │
                    (1-2 天)                              │
                    ┌──────────────────┐                  │
                    │ • 错误处理       │←─────────────────┘
                    │ • 性能优化       │
                    │ • 文档更新       │
                    │ • 多提供商验证   │
                    └──────────────────┘
```

---

## 6.2 Phase 1：基础设施（1-2 天）

### 目标

搭建项目结构，安装依赖，完成可独立测试的工具模块。

### 任务清单

- [ ] **1.1 安装 Pi 依赖**
  ```bash
  cd packages/providers
  pnpm add @earendil-works/pi-ai@0.80.3 @earendil-works/pi-agent-core@0.80.3 @earendil-works/pi-coding-agent@0.80.3
  ```
  - 验证 `pnpm build` 通过
  - 检查 TypeScript 类型兼容性
  - 如果有版本冲突，使用 `pnpm overrides` 解决

- [ ] **1.2 创建文件结构**
  ```
  packages/providers/src/pi/
  ├── provider.ts          # 空壳
  ├── async-bridge.ts      # 空壳
  ├── event-mapper.ts      # 空壳
  ├── model-resolver.ts    # 空壳
  ├── token-aggregator.ts  # 空壳
  ├── session-cache.ts     # 空壳
  └── extensions/
      ├── sub-agent-tool.ts
      └── octopus-hooks.ts
  ```

- [ ] **1.3 实现 `token-aggregator.ts`**
  - 纯计算模块，无外部依赖
  - 编写完整单元测试

- [ ] **1.4 实现 `model-resolver.ts`**
  - 别名映射表
  - `resolveModel()` 函数
  - Mock ModelRegistry 单元测试

- [ ] **1.5 实现 `async-bridge.ts`**
  - `AsyncEventBridge` 类
  - 完整的 push/end/fail/generator 流程
  - 并发安全测试

- [ ] **1.6 更新注册表**
  - `registry.ts` 添加 `pi` 工厂
  - `index.ts` 添加 export

### 交付物

- 可编译的 `packages/providers` 包
- 3 个工具模块的完整单元测试
- `pnpm test --filter @octopus/providers` 全绿

### 验证

```bash
pnpm build --filter @octopus/providers
pnpm test --filter @octopus/providers -- --testPathPattern="pi/(token-aggregator|model-resolver|async-bridge)"
```

---

## 6.3 Phase 2：核心桥接（2-3 天）

### 目标

实现 PiAgentProvider 核心类，能够执行简单的 agent 任务并产出正确的 MessageChunk 流。

### 任务清单

- [ ] **2.1 实现 `event-mapper.ts`**
  - 完整映射表（参见第三章 3.4 节）
  - 处理所有 AgentSessionEvent 类型
  - 处理所有 AssistantMessageEvent 子事件
  - 编写完整单元测试（覆盖每种事件类型）

- [ ] **2.2 实现 `session-cache.ts`**
  - Session 创建和缓存
  - 按 cwd 查找活跃 session
  - `dispose()` 清理

- [ ] **2.3 实现 `provider.ts` 核心**
  - `sendQuery()` 方法
  - 集成 async-bridge + event-mapper + session-cache
  - abort 信号处理
  - 模型解析和设置

- [ ] **2.4 首次冒烟测试**
  ```bash
  # 设置 API Key
  export ANTHROPIC_API_KEY="sk-ant-..."
  
  # 运行简单 prompt
  cat > /tmp/pi-smoke.ts << 'EOF'
  import { PiAgentProvider } from './packages/providers/src/pi/provider'
  
  const provider = new PiAgentProvider()
  for await (const chunk of provider.sendQuery('Say hello', process.cwd())) {
    console.log(chunk.type, JSON.stringify(chunk).slice(0, 100))
  }
  provider.dispose()
  EOF
  
  npx tsx /tmp/pi-smoke.ts
  ```

- [ ] **2.5 编写集成测试**
  - text 输出验证
  - tool call 验证
  - token 追踪验证
  - abort 验证

### 交付物

- 可工作的 `PiAgentProvider`
- 事件映射的完整测试覆盖
- 集成测试通过（至少 text + tool_call + result）

### 验证

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
pnpm test --filter @octopus/providers -- --testPathPattern="pi/(event-mapper|provider.integration)"
```

---

## 6.4 Phase 3：功能扩展（2-3 天）

### 目标

支持 Octopus 工作流的所有特性：子代理、技能注入、Session Resume、System Prompt。

### 任务清单

- [ ] **3.1 实现子代理工具**
  - `extensions/sub-agent-tool.ts`
  - `createSubAgentTools()` 函数
  - 测试：委派任务 → 子代理执行 → 返回结果

- [ ] **3.2 实现技能注入**
  - 首版：直接拼接到 prompt
  - 优化版：通过 `before_provider_request` hook

- [ ] **3.3 实现 System Prompt 覆盖**
  - `applySystemPrompt()` 函数
  - 处理 string 和 preset 两种格式

- [ ] **3.4 实现 Session Resume**
  - `session-cache.ts` 扩展
  - 通过 Pi SessionManager 恢复历史 session

- [ ] **3.5 E2E 工作流测试**
  - 简单 agent 工作流
  - 带子代理的工作流
  - Swarm 模式工作流

### 交付物

- 子代理委派功能
- 技能注入功能
- Session 恢复功能
- 至少 3 个 E2E 工作流测试通过

### 验证

```bash
# E2E 测试
export ANTHROPIC_API_KEY="sk-ant-..."
pnpm test -- --testPathPattern="e2e/pi-"

# 手动工作流测试
octopus workflow run ./tests/fixtures/pi-integration-test.yaml --org xzf
```

---

## 6.5 Phase 4：生产加固（1-2 天）

### 目标

错误处理、性能优化、多提供商验证、文档完善。

### 任务清单

- [ ] **4.1 错误处理加固**
  - API Key 缺失 → 清晰的错误消息
  - 模型不存在 → 友好提示 + 可用模型列表
  - Session 创建失败 → 优雅降级
  - 网络超时 → 重试机制（Pi 内置）

- [ ] **4.2 多提供商验证**
  - Anthropic（claude-haiku）✅
  - OpenAI（gpt-4o-mini）
  - Google（gemini-2.5-flash）
  - DeepSeek（deepseek-chat）

- [ ] **4.3 性能优化**
  - Session 创建延迟加载
  - 事件映射零分配（避免不必要的对象创建）
  - 内存泄漏检测（长时间运行的 session）

- [ ] **4.4 文档更新**
  - CLAUDE.md 添加 Pi Provider 使用说明
  - 工作流 YAML 示例（多提供商）
  - 环境变量配置指南

- [ ] **4.5 回归测试**
  - 确保 ClaudeSDKProvider 仍然正常工作
  - 混合 Provider 工作流测试

### 交付物

- 生产就绪的 PiAgentProvider
- 多提供商验证报告
- 更新的文档

### 验证

```bash
# 回归测试
pnpm test --filter @octopus/providers
pnpm test -- --testPathPattern="e2e/"

# 多提供商测试
export OPENAI_API_KEY="sk-..."
export GOOGLE_API_KEY="..."
export DEEPSEEK_API_KEY="..."
octopus workflow run ./tests/fixtures/pi-multi-provider-test.yaml --org xzf
```

---

## 6.6 风险清单

### 高风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| **Pi 包未发布到 npm** | 无法安装依赖 | 使用本地 `file:` 引用 + git submodule |
| **TypeBox vs Zod 冲突** | 类型不兼容 | Pi 内部用 TypeBox，Octopus 接口不变，转换在边界完成 |
| **Pi Agent Loop 行为差异** | 工具调用/结果格式不同 | event-mapper 适配层 + 充分的集成测试 |
| **Session 持久化格式不兼容** | 无法跨进程 resume | 首版仅支持同进程 resume |

### 中风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| **pi-coding-agent 包体积大** | 构建时间增加 | 动态 import + 按需加载 |
| **ESM/CJS 兼容问题** | 运行时错误 | pnpm 的 ESM 模式 + 动态 import |
| **多提供商 API Key 管理** | 用户配置复杂 | 环境变量约定 + 清晰的错误提示 |
| **Pi 版本更新频繁** | API 变更 | 锁定版本 0.80.3 + 升级测试 |

### 低风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| **事件映射遗漏** | 部分 UI 信息丢失 | 单元测试覆盖所有事件类型 |
| **性能略低于 ClaudeSDKProvider** | 工作流执行稍慢 | 基准测试对比 + 优化热点 |
| **子代理嵌套深度限制** | 复杂编排失败 | 设置最大嵌套深度（默认 3） |

---

## 6.7 依赖安装方案

### 方案 A：npm 直接安装（首选）

如果 Pi 包已发布到 npm：

```bash
cd packages/providers
pnpm add @earendil-works/pi-ai@0.80.3 @earendil-works/pi-agent-core@0.80.3 @earendil-works/pi-coding-agent@0.80.3
```

### 方案 B：本地 file: 引用

如果未发布，使用本地路径：

```json
// packages/providers/package.json
{
  "dependencies": {
    "@earendil-works/pi-ai": "file:C:/MiYuan/github/pi-mono/packages/ai",
    "@earendil-works/pi-agent-core": "file:C:/MiYuan/github/pi-mono/packages/agent",
    "@earendil-works/pi-coding-agent": "file:C:/MiYuan/github/pi-mono/packages/coding-agent"
  }
}
```

### 方案 C：Git Submodule

```bash
cd c:/xzf/ai/open-octopus
git submodule add https://github.com/earendil-works/pi.git vendor/pi-mono
```

```json
// packages/providers/package.json
{
  "dependencies": {
    "@earendil-works/pi-ai": "file:../../vendor/pi-mono/packages/ai",
    "@earendil-works/pi-agent-core": "file:../../vendor/pi-mono/packages/agent",
    "@earendil-works/pi-coding-agent": "file:../../vendor/pi-mono/packages/coding-agent"
  }
}
```

### 注意事项

- Pi 使用 **npm workspaces**（不是 pnpm），`file:` 引用可能需要先 `npm install` 构建
- Pi 的构建使用 `tsgo`，可能需要先 `cd pi-mono && npm install && npm run build`
- TypeBox 版本必须与 Pi 使用的一致（v1.1.38）

---

## 6.8 里程碑时间线

| 阶段 | 时间 | 里程碑 |
|------|------|--------|
| Phase 1 | Day 1-2 | 依赖安装 + 工具模块 + 单元测试 |
| Phase 2 | Day 3-5 | 核心 Provider + 事件映射 + 集成测试 |
| Phase 3 | Day 6-8 | 子代理 + 技能 + Session + E2E |
| Phase 4 | Day 9-10 | 加固 + 多提供商 + 文档 |
| **总计** | **~10 天** | **生产就绪的 PiAgentProvider** |

### 关键决策点

- **Day 2 结束**：依赖安装是否成功？如果 Pi 包不可用，需要切换到方案 B/C
- **Day 5 结束**：核心桥接是否工作？如果事件映射有重大问题，需要重新评估方案
- **Day 8 结束**：E2E 测试是否通过？如果子代理/Session 有问题，可以降级为首版不支持

---

## 6.9 首版最小可行范围（MVP）

如果时间紧张，首版只实现：

1. ✅ 核心 `sendQuery()` — text + tool_call + tool_result + result
2. ✅ 事件映射 — 覆盖最常用的 10 种事件
3. ✅ 单提供商（Anthropic）
4. ✅ 简单 agent 节点
5. ⏳ 子代理（延后）
6. ⏳ Session Resume（延后）
7. ⏳ 多提供商（延后）

MVP 预计 **5 天**，足以运行简单的 `engine: pi` 工作流。
