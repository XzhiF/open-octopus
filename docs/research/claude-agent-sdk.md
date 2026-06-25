# Claude Agent SDK 研究总结

> 基于官方文档 code.claude.com/docs 的系统性调研，覆盖 SDK vs CLI 对比、Context 管理、TypeScript 最佳实践、认证与连接配置。

---

## 1. SDK vs CLI 核心对比

### 定位差异

| 维度 | CLI | SDK |
|------|-----|-----|
| 定位 | 交互式开发工具（人用） | 编程式嵌入式库（程序用） |
| UI | 丰富 TUI + 桌面 app + IDE 集成 | 无 UI，纯 API |
| 交互 | 实时对话、快捷键、滚动、搜索 | `for await` 异步流 |
| 审批 | 弹窗按 y/n | `canUseTool` 回调 + 程序式 Hook |
| 安装 | CLI 工具 | `npm install @anthropic-ai/claude-agent-sdk` / `pip install claude-agent-sdk` |

### SDK 独有能力（CLI 没有）

| 能力 | 说明 |
|------|------|
| 自定义工具 | Zod schema + handler 函数，进程内 MCP server |
| 程序式 Hook | 回调函数而非 shell 命令，可阻断/修改工具调用 |
| 结构化输出 | JSON Schema + Zod/Pydantic 类型安全验证 |
| 类型化消息 | `AssistantMessage`/`ResultMessage` 等类/接口 |
| 按步骤成本追踪 | 每步、每模型的 token 和费用拆分 |
| 热启动 `startup()` | 预初始化，后续 `query()` 无启动延迟 |
| 进程内 MCP server | `createSdkMcpServer()` 无需单独进程 |
| Session 管理 API | `listSessions()`/`getSessionMessages()`/`renameSession()`/`tagSession()` |
| 多租户部署 | `settingSources: []` + `sandbox` 文件系统隔离 |
| OpenTelemetry | traces/metrics 导出 |
| 预算/轮次限制 | `maxBudgetUsd`/`maxTurns` 防止失控 |
| `canUseTool` | 程序式审批回调，可动态 allow/deny/修改参数 |
| `excludeDynamicSections` | 将环境信息移至 user message，提升 prompt cache 复用 |

### CLI 独有能力（SDK 没有）

| 能力 | 说明 |
|------|------|
| 交互式 TUI | 滚动、搜索、Vim 模式、快捷键、视觉 diff |
| Agent Teams | 多代理共享任务列表 + 代理间消息 |
| Agent View | TUI 监控面板 |
| 桌面应用 | macOS/Windows/Linux native app |
| IDE 集成 | VS Code / JetBrains 扩展 |
| 计算机操控 | 截图 + 鼠标键盘桌面自动化 |
| Chrome 扩展 | 浏览器自动化 |
| 语音输入 | 录音转文字 |
| 交互式斜杠命令 | `/memory` `/review` `/init` `/config` `/doctor` 等 30+ |
| `/loop` 定时任务 | 定期重复运行 |
| Plan Mode 审批 UI | 交互式计划审核 |
| Remote Control | 从其他设备连接 CLI 会话 |

### 选择指南

- **用 CLI**：日常交互开发、单次任务、需要富终端 UI、IDE 集成、交互审批
- **用 SDK**：构建嵌入 Claude 的自定义应用、CI/CD 自动化、多租户部署、需要程序式控制
- **常见模式**：两者并用 — CLI 日常开发，SDK 用于自动化和生产

---

## 2. Context 管理

### 上下文窗口构成

| 来源 | 加载时机 | 缓存行为 |
|------|----------|----------|
| 系统提示 | 每次请求 | 跨轮次自动 prompt cache |
| CLAUDE.md | 会话启动（via `settingSources`） | 跨轮次缓存，仅首次付全价 |
| 工具定义 | 每次请求 | MCP 工具默认延迟加载（tool search） |
| 对话历史 | 逐轮累积 | 主要上下文增长来源 |

静态内容（系统提示、工具定义、CLAUDE.md）自动 prompt cache。大文件读取/命令输出是上下文膨胀的主因。

### Compaction（自动压缩）

上下文接近上限时，SDK 自动压缩旧历史，保留近期交互和关键决策：

- 旧消息被替换为摘要
- 流中发出 `subtype: "compact_boundary"` 信号
- **关键**：早期 prompt 指令可能不在摘要中 → 重要规则应写在 CLAUDE.md（每轮重新注入，压缩后不丢失）

自定义压缩行为：
1. CLAUDE.md 中写摘要指令（告诉压缩器哪些内容必须保留）
2. `PreCompact` hook — 压缩前运行自定义逻辑
3. 手动压缩 — prompt 传 `/compact`

防抖保护：如果单次工具输出太大导致压缩后立即重新填满，SDK 在几次尝试后停止并报错。

### Session 管理

#### 存储位置与格式

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```

- `encoded-cwd` = 工作目录 URL-safe 编码
- 格式 = JSONL（每行一条消息）
- **CLI 和 SDK 完全相同格式，双向互操作**

#### 三种恢复方式

| 方式 | 说明 | SDK 选项 |
|------|------|----------|
| Continue | 找当前目录最近的会话 | `continue: true` |
| Resume | 指定具体 session ID | `resume: sessionId` |
| Fork | 从原会话复制出新分支，原会话不变 | `forkSession: true` |

#### 多轮连续调用

```typescript
// 第 1 次：创建新会话
for await (const m of query({ prompt: "分析代码" })) {
  if (m.type === "result") sessionId = m.session_id;
}

// 第 2 次：继续同一会话（Claude 保留上下文）
for await (const m of query({ prompt: "现在修复", options: { resume: sessionId } })) {
  if (m.type === "result") console.log(m.result);
}
```

#### 持久化控制

- 默认：持久化到磁盘（与 CLI 一致）
- `persistSession: false`：会话只存在于调用期间（多租户/一次性 CI 场景）

#### 跨机器

JSONL 文件默认只在本地。跨机器 resume 需手动迁移文件或使用 SessionStore adapter 写外部存储（S3/GCS/数据库）。

### settingSources — 控制文件配置加载

| 来源 | 加载内容 | 路径 |
|------|----------|------|
| `"project"` | 项目 CLAUDE.md、`.claude/rules/*.md`、skills/hooks | `<cwd>/.claude/` |
| `"user"` | 用户 CLAUDE.md、`~/.claude/rules/*.md`、skills | `~/.claude/` |
| `"local"` | CLAUDE.local.md、`.claude/settings.local.json` | `<cwd>/.claude/` |

传 `[]` 可完全禁用文件配置（多租户部署场景）。

### System Prompt 自定义

三种模式：
1. **默认最小提示**（省略 `systemPrompt`）— 仅含工具调用支持
2. **`claude_code` preset** — 完整 Claude Code 提示 + `append` 附加自定义指令
3. **完全自定义字符串** — 自己负责所有工具指导和安全说明

`excludeDynamicSections` 将环境信息移到第一条 user message，改善跨会话 prompt cache 复用。

### Subagent 上下文隔离

每个子代理在独立全新上下文窗口运行：

| 子代理获得 | 子代理不获得 |
|------------|-------------|
| 自己的系统提示 + Agent 工具 prompt 字符串 | 父对话历史或工具结果 |
| 项目 CLAUDE.md（via `settingSources`） | 父的系统提示 |
| 工具定义（继承或 `tools` 子集限定） | 未列在 `skills` 字段中的 skill |

父→子通过 Agent 工具 prompt 传信息；子→父仅返回最终摘要。子代理不能嵌套（不能在自己的 `tools` 中包含 `Agent`）。

### 预算和轮次限制

| 选项 | 控制内容 | 默认 |
|------|----------|------|
| `maxTurns` | 最大工具使用轮次 | 无限制 |
| `maxBudgetUsd` | 最大费用（美元） | 无限制 |
| `effort` | 推理深度 `"low"` ~ `"max"` | 默认 |
| `thinking` | `adaptive`/`enabled`/`disabled` | adaptive |

达到限制时返回 `error_max_turns` 或 `error_max_budget_usd`，可 resume 会话并提高限制。

### 上下文优化策略

1. 用子代理处理子任务 — 新上下文，仅摘要回传
2. 限定子代理工具集 — 只给最少必要工具
3. 低 effort 用于只读任务 — `effort: "low"`
4. 参考性内容放 Skills 而非 CLAUDE.md — CLAUDE.md 每轮加载，Skills 按需加载
5. 启用 1 小时缓存 TTL — `ENABLE_PROMPT_CACHING_1H`

---

## 3. TypeScript 最佳实践

### 核心 API

```typescript
import { query, startup } from "@anthropic-ai/claude-agent-sdk";
```

#### `query()` — 主入口

一次完整 `for await` 遍历 = Claude 自主跑完所有工具调用轮次 = 1 次 session 调用。

消息流生命周期：
```
system(init) → assistant(思考+决定用工具) → user(工具结果返回) → assistant(再思考) → ... → result(最终答案)
```

中间 `assistant`/`user` 是工具调用中间态，通常只关心 `result`。

#### `startup()` — 热启动

预初始化 CLI 子进程，后续 `query()` 无启动延迟：

```typescript
const warm = await startup({ options: { maxTurns: 5 } });
try {
  for await (const m of warm.query("分析代码")) {
    if (m.type === "result" && m.subtype === "success") console.log(m.result);
  }
} finally {
  warm.close();
}
```

### Options 关键字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `allowedTools` | `string[]` | 允许的工具列表 |
| `permissionMode` | `PermissionMode` | `"default"`/`"acceptEdits"`/`"dontAsk"`/`"bypassPermissions"`/`"plan"`/`"auto"` |
| `systemPrompt` | `string | { type, preset, append?, excludeDynamicSections? }` | 系统提示配置 |
| `settingSources` | `SettingSource[]` | 加载哪些文件配置，传 `[]` 禁用全部 |
| `maxTurns` | `number` | 最大工具轮次 |
| `maxBudgetUsd` | `number` | 费用上限 |
| `effort` | `string` | 推理深度 |
| `thinking` | `ThinkingConfig` | 思考模式 |
| `mcpServers` | `Record<string, McpServerConfig>` | MCP 服务器配置 |
| `hooks` | `Record<HookEvent, HookCallbackMatcher[]>` | 程序式 Hook |
| `canUseTool` | `CanUseTool` | 工具审批回调 |
| `agents` | `Record<string, AgentDefinition>` | 子代理定义 |
| `continue` | `boolean` | 继续最近会话 |
| `resume` | `string` | 指定 session ID 继续 |
| `forkSession` | `boolean` | 分支会话 |
| `persistSession` | `boolean` | 是否持久化到磁盘 |
| `outputFormat` | `{ type: "json_schema", schema }` | 结构化输出 |
| `includePartialMessages` | `boolean` | 流式输出 |
| `env` | `Record<string, string|undefined>` | 传给 CLI 子进程的环境变量 |
| `cwd` | `string` | 工作目录 |
| `sandbox` | `SandboxSettings` | 沙箱隔离配置 |
| `model` | `string` | 模型名称 |
| `outputStyle` | `string` | 输出风格 |
| `enableFileCheckpointing` | `boolean` | 文件快照与回滚 |
| `plugins` | `SdkPluginConfig[]` | 插件配置 |

### 自定义工具（Zod + MCP Server）

```typescript
import { tool, createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const getTemperature = tool(
  "get_temperature",
  "获取指定位置的当前温度",
  {
    latitude: z.number().describe("纬度"),
    longitude: z.number().describe("经度"),
  },
  async (args) => {
    try {
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m`
      );
      if (!res.ok) {
        // 永远不要抛未捕获异常，用 isError 返回让 agent loop 继续
        return {
          content: [{ type: "text", text: `API 错误: ${res.status}` }],
          isError: true,
        };
      }
      const data: any = await res.json();
      return { content: [{ type: "text", text: `温度: ${data.current.temperature_2m}°C` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `请求失败: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } } // readOnlyHint 让 Claude 可并行调用
);

const weatherServer = createSdkMcpServer({
  name: "weather",
  version: "1.0.0",
  tools: [getTemperature],
});

for await (const msg of query({
  prompt: "北京天气怎么样？",
  options: {
    mcpServers: { weather: weatherServer },
    allowedTools: ["mcp__weather__get_temperature"],
  },
})) {
  if (msg.type === "result" && msg.subtype === "success") console.log(msg.result);
}
```

**关键原则：**
- 工具错误用 `isError: true` 返回，不抛异常 — 让 agent loop 继续，Claude 可自适应
- `readOnlyHint` annotation — 让 Claude 并行批量调用只读工具
- 自定义工具通过 `mcp__{server}__{tool}` 命名规则引用

### 程序式 Hook

```typescript
import { query, type HookCallback, type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

// 阻止对 .env 文件的写入
const protectEnvFiles: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput;
  const toolInput = preInput.tool_input as Record<string, unknown>;
  const filePath = (toolInput?.file_path as string) ?? "";
  const fileName = filePath.split("/").pop();

  if (fileName === ".env" || fileName === ".env.local") {
    return {
      hookSpecificOutput: {
        hookEventName: preInput.hook_event_name,
        permissionDecision: "deny",
        permissionDecisionReason: "禁止修改环境变量文件",
      },
    };
  }
  return {}; // 空对象 = 允许
};

// 自动批准只读工具
const autoApproveReadOnly: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput;
  if (["Read", "Glob", "Grep"].includes(preInput.tool_name)) {
    return {
      hookSpecificOutput: {
        hookEventName: preInput.hook_event_name,
        permissionDecision: "allow",
      },
    };
  }
  return {};
};

// 重定向写入路径到沙箱
const redirectToSandbox: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput;
  const toolInput = preInput.tool_input as Record<string, unknown>;
  if (preInput.tool_name === "Write") {
    const originalPath = toolInput.file_path as string;
    return {
      hookSpecificOutput: {
        hookEventName: preInput.hook_event_name,
        permissionDecision: "allow",
        updatedInput: { ...toolInput, file_path: `/sandbox${originalPath}` },
      },
    };
  }
  return {};
};

for await (const msg of query({
  prompt: "重构 auth 模块",
  options: {
    hooks: {
      PreToolUse: [
        { matcher: "Write|Edit", hooks: [protectEnvFiles, redirectToSandbox] },
        { hooks: [autoApproveReadOnly] },
      ],
    },
  },
})) { /* ... */ }
```

**HookEvent 类型：**
`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` / `Notification` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` / `Stop` / `SubagentStart` / `SubagentStop` / `PreCompact` / `PermissionRequest` / `Setup` / `TeammateIdle` / `TaskCompleted` / `ConfigChange` / `WorktreeCreate` / `WorktreeRemove`

**审批优先级链：** Hook → Deny 规则 → PermissionMode → Allow 规则 → `canUseTool`

### 人机交互审批 — `canUseTool`

```typescript
for await (const msg of query({
  prompt: "重构 auth 模块",
  options: {
    permissionMode: "default",
    canUseTool: async (toolName, input, opts) => {
      // 自动批准安全的操作
      if (["Read", "Glob", "Grep"].includes(toolName)) {
        return { behavior: "allow" };
      }

      // 写文件 → 需要人工确认（可对接 Slack/Web UI/审批系统）
      if (["Write", "Edit"].includes(toolName)) {
        const approved = await askHumanViaWebSocket({
          question: `允许 ${toolName} 操作 ${input.file_path}？`,
        });
        if (approved === "allow") return { behavior: "allow" };
        if (approved === "deny") return { behavior: "deny", message: "用户拒绝了此操作" };
        // 修改参数（如重定向到沙箱）
        return { behavior: "allow", updatedInput: { ...input, file_path: `/sandbox${input.file_path}` } };
      }

      // Bash → 检查危险命令
      if (toolName === "Bash") {
        const cmd = input.command as string;
        if (cmd.includes("rm -rf") || cmd.includes("DROP TABLE")) {
          return { behavior: "deny", message: "危险命令被阻止" };
        }
        return { behavior: "allow" };
      }

      return { behavior: "allow" };
    },
  },
})) { /* ... */ }
```

### 子代理（Subagent）

```typescript
import { query, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

// 动态工厂
function createSecurityAgent(level: "basic" | "strict"): AgentDefinition {
  return {
    description: `安全审查专家（${level}级）`,
    prompt: `你是 ${level === "strict" ? "严格" : "平衡"} 的安全审查专家...`,
    tools: ["Read", "Grep", "Glob"], // 只读
    model: level === "strict" ? "opus" : "sonnet",
    effort: level === "strict" ? "max" : "high",
  };
}

for await (const msg of query({
  prompt: "审查 auth 模块的安全问题",
  options: {
    allowedTools: ["Read", "Glob", "Grep", "Agent"], // 必须包含 Agent
    agents: {
      "security-reviewer": createSecurityAgent("strict"),
      "test-runner": {
        description: "测试执行专家",
        prompt: "你是测试执行专家...",
        tools: ["Bash", "Read", "Grep"],
        model: "sonnet",
      },
    },
  },
})) { /* ... */ }
```

**AgentDefinition 字段：**
`description`(必填) / `prompt`(必填) / `tools` / `disallowedTools` / `model` / `skills` / `mcpServers` / `maxTurns` / `background` / `effort` / `permissionMode` / `memory`

子代理不能嵌套（不能在 `tools` 中包含 `Agent`）。

### 结构化输出

```typescript
import { z } from "zod";

const FeaturePlan = z.object({
  feature_name: z.string(),
  summary: z.string(),
  steps: z.array(z.object({
    step_number: z.number(),
    description: z.string(),
    estimated_complexity: z.enum(["low", "medium", "high"]),
  })),
  risks: z.array(z.string()),
});

const schema = z.toJSONSchema(FeaturePlan);

for await (const msg of query({
  prompt: "规划暗黑模式支持",
  options: { outputFormat: { type: "json_schema", schema } },
})) {
  if (msg.type === "result" && msg.subtype === "success" && msg.structured_output) {
    const parsed = FeaturePlan.safeParse(msg.structured_output);
    if (parsed.success) {
      const plan = parsed.data;
      plan.steps.forEach((s) => console.log(`${s.step_number}. [${s.estimated_complexity}] ${s.description}`));
    }
  }
}
```

### 流式输出

```typescript
for await (const msg of query({
  prompt: "分析项目",
  options: { includePartialMessages: true, allowedTools: ["Read", "Glob"] },
})) {
  if (msg.type === "stream_event") {
    const event = msg.event;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      process.stdout.write(event.delta.text);
    }
  }
  if (msg.type === "result" && msg.subtype === "success") console.log(msg.result);
}
```

### Session Fork — 分支探索

```typescript
// 主会话：JWT 方案分析
let sessionId: string | undefined;
for await (const m of query({ prompt: "分析 JWT 迁移方案" })) {
  if (m.type === "result") sessionId = m.session_id;
}

// Fork：探索 OAuth2 方案（不影响主会话）
let forkedId: string | undefined;
for await (const m of query({
  prompt: "用 OAuth2 方案替代 JWT",
  options: { resume: sessionId, forkSession: true },
})) {
  if (m.type === "system" && m.subtype === "init") forkedId = m.session_id;
  if (m.type === "result" && m.subtype === "success") console.log("OAuth2:", m.result);
}

// 回到主会话继续 JWT 方案
for await (const m of query({
  prompt: "继续执行 JWT 方案",
  options: { resume: sessionId },
})) { /* ... */ }
```

### 多租户隔离部署

```typescript
async function runTenantAgent(tenantId: string, task: string) {
  for await (const m of query({
    prompt: task,
    options: {
      cwd: `/workspaces/${tenantId}`,
      settingSources: [],              // 禁用所有文件配置
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: `你是 ${tenantId} 项目专用助手。只操作 /workspaces/${tenantId}/ 下文件。`,
        excludeDynamicSections: true,  // 提升 prompt cache 跨租户复用
      },
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      maxBudgetUsd: 1.0,
      maxTurns: 20,
      persistSession: false,           // 不持久化，防止租户间数据泄漏
    },
  })) {
    if (m.type === "result" && m.subtype === "success") return m.result;
  }
}

const results = await Promise.all([
  runTenantAgent("tenant-a", "修复 auth.py bug"),
  runTenantAgent("tenant-b", "给 API 添加分页"),
]);
```

### 斜杠命令

SDK 仅支持 `/compact` 通过 prompt 字符串触发。其余 CLI 斜杠命令（`/memory` `/review` `/init` 等）无 SDK 等效 API，但有程序式替代：

| CLI 命令 | SDK 替代 |
|----------|---------|
| `/compact` | prompt 传 `/compact` |
| `/memory` | 直接读写 memory 文件 |
| `/review` | 自定义子代理 |
| `/init` | 自己写 CLAUDE.md |
| `/config` | Options 各项配置 |
| `/model` | `options.model` |
| `/loop` | 自己实现定时器 + `query()` |

### PermissionMode

| Mode | 行为 | 场景 |
|------|------|------|
| `default` | 无自动批准；未匹配触发 `canUseTool` | 自定义审批流程 |
| `acceptEdits` | 自动批准文件编辑 + mkdir/touch/rm 等 | 可信开发流程 |
| `dontAsk` | 拒绝不在 `allowedTools` 中的所有操作 | 锁定的 headless agent |
| `bypassPermissions` | 所有工具自动批准 | 完全沙箱/可信环境 |
| `plan` | 只读工具；Claude 分析不编辑 | 代码审查/规划 |
| `auto` | 模型分类自动批准/拒绝（TS only） | 自主 agent |

---

## 4. 认证与连接配置

SDK 和 CLI 读同一套环境变量，通过 `options.env` 传入。

### 基本用法

```typescript
for await (const msg of query({
  prompt: "...",
  options: {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: "https://your-proxy.example.com",
      ANTHROPIC_AUTH_TOKEN: "your-bearer-token",
    },
  },
})) { /* ... */ }
```

也可以直接在 shell 设环境变量，SDK 自动继承。

### 认证凭证优先级（高→低）

1. 云服务商凭证（Bedrock/Vertex/Foundry 启用时）
2. `ANTHROPIC_AUTH_TOKEN` — `Authorization: Bearer <value>`
3. `ANTHROPIC_API_KEY` — `X-Api-Key: <value>`
4. `apiKeyHelper`（settings.json shell 脚本）
5. OAuth token（`/login` 或 `CLAUDE_CODE_OAUTH_TOKEN`）

### 端点/供应商配置

| 变量 | 用途 |
|------|------|
| `ANTHROPIC_BASE_URL` | 覆盖 Anthropic API 端点（LLM 网关/代理） |
| `CLAUDE_CODE_USE_BEDROCK=1` | 启用 Amazon Bedrock |
| `CLAUDE_CODE_USE_VERTEX=1` | 启用 Google Vertex AI |
| `CLAUDE_CODE_USE_FOUNDRY=1` | 启用 Microsoft Foundry |
| `CLAUDE_CODE_USE_ANTHROPIC_AWS=1` | 启用 Claude Platform on AWS |
| `ANTHROPIC_BEDROCK_BASE_URL` | Bedrock 端点覆盖 |
| `ANTHROPIC_VERTEX_BASE_URL` | Vertex 端点覆盖 |
| `ANTHROPIC_AWS_BASE_URL` | AWS 端点覆盖 |
| `ANTHROPIC_FOUNDRY_BASE_URL` | Foundry 端点覆盖 |

### 认证跳过（网关场景）

| 变量 | 用途 |
|------|------|
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1` | 跳过 AWS SigV4，网关处理认证 |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH=1` | 跳过 GCP auth |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH=1` | 跳过 Azure auth |
| `CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH=1` | 跳过 AWS SigV4 |

### 常见场景

#### LLM 网关/代理

```typescript
env: {
  ...process.env,
  ANTHROPIC_BASE_URL: "https://gateway.internal.example.com",
  ANTHROPIC_AUTH_TOKEN: process.env.GATEWAY_TOKEN!,
}
```

#### Amazon Bedrock

```typescript
env: {
  ...process.env,
  CLAUDE_CODE_USE_BEDROCK: "1",
  ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-gateway.example.com",
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
}
```

#### 企业代理 + mTLS

```typescript
env: {
  ...process.env,
  HTTPS_PROXY: "https://proxy.corporate.example.com:3128",
  ANTHROPIC_BASE_URL: "https://llm-gateway.corporate.example.com",
  ANTHROPIC_AUTH_TOKEN: process.env.CORP_TOKEN!,
  CLAUDE_CODE_CLIENT_CERT: "/certs/client.crt",
  CLAUDE_CODE_CLIENT_KEY: "/certs/client.key",
}
```

### 网关额外配置

| 变量 | 用途 |
|------|------|
| `CLAUDE_CODE_ATTRIBUTION_HEADER=0` | 禁用 attribution header，提升 prompt cache |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | 禁用 `anthropic-beta` header |
| `ENABLE_TOOL_SEARCH=true` | 网关转发 tool_reference 时重新启用 MCP 工具搜索 |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` | 从网关 `/v1/models` 获取模型列表 |
| `ANTHROPIC_CUSTOM_HEADERS` | 自定义请求头 `Name: Value\n` |
| `CLAUDE_CODE_EXTRA_BODY` | JSON 合入每个请求体 |

### TLS/代理

| 变量 | 用途 |
|------|------|
| `HTTPS_PROXY` / `HTTP_PROXY` | 标准 HTTP 代理 |
| `CLAUDE_CODE_CERT_STORE` | CA 证书源，默认 `bundled,system` |
| `CLAUDE_CODE_CLIENT_CERT` | mTLS 客户端证书路径 |
| `CLAUDE_CODE_CLIENT_KEY` | mTLS 客户端密钥路径 |
| `CLAUDE_CODE_PROXY_RESOLVES_HOSTS=1` | 代理执行 DNS 解析 |

---

## 5. 最佳实践清单

| 实践 | 原因 |
|------|------|
| 工具错误用 `isError: true` 返回，不抛异常 | agent loop 继续，Claude 可自适应 |
| `readOnlyHint` annotation | Claude 并行批量调用只读工具 |
| `settingSources: []` + 自定义 `systemPrompt` | 多租户完全隔离 |
| `excludeDynamicSections: true` | prompt cache 跨会话/跨租户复用 |
| `permissionMode: "plan"` | 审查场景只读，不误改代码 |
| `maxBudgetUsd` + `maxTurns` | 防止生产环境失控 |
| `persistSession: false` | 临时任务不写磁盘，避免数据泄漏 |
| 重要规则写在 CLAUDE.md | 压缩后仍重新注入，prompt 指令可能丢失 |
| 子代理只给最少必要 `tools` | 减少上下文消耗 + 权限最小化 |
| `startup()` 预热 | 批量/高频调用减少启动延迟 |
| Fork 而非修改原会话 | 探索不同方案不破坏主会话 |
| 自定义工具通过 `mcp__{server}__{tool}` 命名 | 统一命名规则 |
| Hook 先做规则审批，`canUseTool` 做人工审批 | 分层审批逻辑 |

---

## 参考文档

- Agent SDK Overview: https://code.claude.com/docs/en/agent-sdk/overview.md
- TypeScript SDK Reference: https://code.claude.com/docs/en/agent-sdk/typescript.md
- Python SDK Reference: https://code.claude.com/docs/en/agent-sdk/python.md
- Custom Tools: https://code.claude.com/docs/en/agent-sdk/custom-tools.md
- Hooks: https://code.claude.com/docs/en/agent-sdk/hooks.md
- Sessions: https://code.claude.com/docs/en/agent-sdk/sessions.md
- Subagents: https://code.claude.com/docs/en/agent-sdk/subagents.md
- Hosting: https://code.claude.com/docs/en/agent-sdk/hosting.md
- Permissions: https://code.claude.com/docs/en/agent-sdk/permissions.md
- MCP: https://code.claude.com/docs/en/agent-sdk/mcp.md
- Cost Tracking: https://code.claude.com/docs/en/agent-sdk/cost-tracking.md
- System Prompts: https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts.md
- Streaming Output: https://code.claude.com/docs/en/agent-sdk/streaming-output.md
- Structured Outputs: https://code.claude.com/docs/en/agent-sdk/structured-outputs.md
- Environment Variables: https://code.claude.com/docs/en/env-vars.md
- Authentication: https://code.claude.com/docs/en/authentication.md
- LLM Gateway: https://code.claude.com/docs/en/llm-gateway.md
- Secure Deployment: https://code.claude.com/docs/en/agent-sdk/secure-deployment.md
- Amazon Bedrock: https://code.claude.com/docs/en/amazon-bedrock.md
- Google Vertex AI: https://code.claude.com/docs/en/google-vertex-ai.md
- Microsoft Foundry: https://code.claude.com/docs/en/microsoft-foundry.md
- Demo Repository: https://github.com/anthropics/claude-agent-sdk-demos