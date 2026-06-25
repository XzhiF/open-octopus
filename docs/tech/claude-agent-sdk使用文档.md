# @anthropic-ai/claude-agent-sdk 使用文档

> **版本**: 0.3.143 (Claude Code 内嵌版本 2.1.143)
> **发布日期**: 2026-05-15
> **最低 Node.js**: 18+
> **GitHub**: https://github.com/anthropics/claude-agent-sdk-typescript
> **npm**: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk

---

## 资料来源

| 来源 | 说明 |
|------|------|
| npm 包 `sdk.d.ts` | 所有类型定义的直接来源，安装后位于 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` |
| npm 包 `sdk-tools.d.ts` | 工具输入/输出 Schema 类型定义 |
| npm 包 `bridge.d.ts` | Bridge 子导出类型定义 (@alpha) |
| npm 包 `assistant.d.ts` | Assistant Worker 类型定义 (@alpha) |
| npm 包 `browser-sdk.d.ts` | 浏览器端类型定义 |
| GitHub `anthropics/claude-agent-sdk-typescript` | 示例代码和 shell 脚本 (1.4k stars) |
| Anthropic 官方文档 | `docs.anthropic.com/en/docs/claude-agent-sdk` (部分区域受限) |

---

## 1. 安装与引入

### 1.1 安装

```bash
npm install @anthropic-ai/claude-agent-sdk
# 或
pnpm add @anthropic-ai/claude-agent-sdk
```

**Peer 依赖**:
- `@anthropic-ai/sdk` >= 0.93.0
- `@modelcontextprotocol/sdk` ^1.29.0
- `zod` ^4.0.0

**可选平台二进制**: Linux (x64/arm64/musl), macOS (x64/arm64), Windows (x64/arm64)

### 1.2 包导出映射

| 导出路径 | 类型文件 | 运行文件 | 用途 |
|----------|---------|---------|------|
| `.` (主入口) | `sdk.d.ts` | `sdk.mjs` | 标准用法 |
| `/browser` | `browser-sdk.d.ts` | `browser-sdk.js` | 浏览器端 |
| `/bridge` | `bridge.d.ts` | `bridge.mjs` | 持久 Worker 进程 (@alpha) |
| `/assistant` | `assistant.d.ts` | `assistant.mjs` | claude.ai 集成 (@alpha) |
| `/sdk-tools` | `sdk-tools.d.ts` | — | 仅类型导出 |

### 1.3 引入方式

```typescript
// 标准引入 (Node.js)
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

// 浏览器引入
import { query } from '@anthropic-ai/claude-agent-sdk/browser';

// 工具定义引入
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

// 工具类型引入
import type { ToolInputSchemas } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
```

---

## 2. 核心 API — query 函数

### 2.1 函数签名

> 来源: `sdk.d.ts`

```typescript
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;
```

- `prompt`: 接受纯字符串或 `AsyncIterable<SDKUserMessage>` (多轮流式输入)
- `options`: 可选配置项
- 返回值: `Query` — 一个 `AsyncGenerator<SDKMessage, void>`，可迭代消费

### 2.2 startup 预热函数

> 来源: `sdk.d.ts`

```typescript
export declare function startup(_params?: {
    options?: Options;
    initializeTimeoutMs?: number;
}): Promise<WarmQuery>;

export declare interface WarmQuery extends AsyncDisposable {
    query(prompt: string | AsyncIterable<SDKUserMessage>): Query;
    close(): void;
}
```

预加载 Claude Code 进程，减少后续首次调用延迟。`WarmQuery` 实现 `AsyncDisposable`，可用 `await using` 语法。

### 2.3 浏览器端 query

> 来源: `browser-sdk.d.ts`

```typescript
export declare function query(options: BrowserQueryOptions): Query;

export type BrowserQueryOptions = {
    prompt: AsyncIterable<SDKUserMessage>;
    websocket: WebSocketOptions;
    abortController?: AbortController;
    canUseTool?: CanUseTool;
    hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
    mcpServers?: Record<string, McpServerConfig>;
    jsonSchema?: Record<string, unknown>;
    onElicitation?: OnElicitation;
};
```

浏览器端不支持纯字符串 prompt，必须使用 `AsyncIterable<SDKUserMessage>` + WebSocket 连接。

---

## 3. Query 接口 (返回类型)

> 来源: `sdk.d.ts`

```typescript
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    interrupt(): Promise<void>;
    setPermissionMode(mode: PermissionMode): Promise<void>;
    setModel(model?: string): Promise<void>;
    /** @deprecated Use the `thinking` option in `query()` instead. */
    setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
    applyFlagSettings(settings: { [K in keyof Settings]?: Settings[K] | null }): Promise<void>;
    initializationResult(): Promise<SDKControlInitializeResponse>;
    supportedCommands(): Promise<SlashCommand[]>;
    supportedModels(): Promise<ModelInfo[]>;
    supportedAgents(): Promise<AgentInfo[]>;
    mcpServerStatus(): Promise<McpServerStatus[]>;
    getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
    readFile(path: string, options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }): Promise<SDKControlReadFileResponse | null>;
    reloadPlugins(): Promise<SDKControlReloadPluginsResponse>;
    accountInfo(): Promise<AccountInfo>;
    rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
    seedReadState(path: string, mtime: number): Promise<void>;
    reconnectMcpServer(serverName: string): Promise<void>;
    toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
    setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
    streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
    stopTask(taskId: string): Promise<void>;
    backgroundTasks(toolUseId?: string): Promise<boolean>;
    close(): void;
}
```

### 方法说明

| 方法 | 用途 |
|------|------|
| `interrupt()` | 中断当前查询执行 |
| `setPermissionMode()` | 动态切换权限模式 (仅流式输入模式可用) |
| `setModel()` | 动态切换模型 (仅流式输入模式可用) |
| `applyFlagSettings()` | 合并设置到 flag settings 层 |
| `initializationResult()` | 获取完整初始化结果 |
| `supportedCommands()` | 获取可用 slash 命令列表 |
| `supportedModels()` | 获取可用模型列表 |
| `supportedAgents()` | 获取可用子代理列表 |
| `mcpServerStatus()` | 获取所有 MCP 服务器状态 |
| `getContextUsage()` | 获取上下文窗口使用量 |
| `readFile()` | 从会话文件系统读取文件 |
| `reloadPlugins()` | 从磁盘重新加载插件 |
| `accountInfo()` | 获取认证账户信息 |
| `rewindFiles()` | 回退文件到指定用户消息时的状态 |
| `streamInput()` | 向查询流式输入用户消息 |
| `stopTask()` | 停止运行中的后台任务 |
| `backgroundTasks()` | 将运行中的前台任务转为后台 |
| `close()` | 关闭查询并清理资源 |

---

## 4. Options 类型 (完整)

> 来源: `sdk.d.ts`

```typescript
export declare type Options = {
    abortController?: AbortController;
    additionalDirectories?: string[];
    agent?: string;
    agents?: Record<string, AgentDefinition>;
    allowedTools?: string[];
    canUseTool?: CanUseTool;
    continue?: boolean;
    cwd?: string;
    disallowedTools?: string[];
    toolAliases?: Record<string, string>;
    tools?: string[] | { type: 'preset'; preset: 'claude_code' };
    env?: { [envVar: string]: string | undefined };
    executable?: 'bun' | 'deno' | 'node';
    executableArgs?: string[];
    extraArgs?: Record<string, string | null>;
    fallbackModel?: string;
    enableFileCheckpointing?: boolean;
    toolConfig?: ToolConfig;
    forkSession?: boolean;
    betas?: SdkBeta[];
    hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
    onElicitation?: OnElicitation;
    persistSession?: boolean;
    sessionStore?: SessionStore;
    sessionStoreFlush?: SessionStoreFlush;
    loadTimeoutMs?: number;
    includeHookEvents?: boolean;
    includePartialMessages?: boolean;
    forwardSubagentText?: boolean;
    thinking?: ThinkingConfig;
    effort?: EffortLevel;
    /** @deprecated Use `thinking` instead. */
    maxThinkingTokens?: number;
    maxTurns?: number;
    maxBudgetUsd?: number;
    taskBudget?: { total: number };
    mcpServers?: Record<string, McpServerConfig>;
    model?: string;
    outputFormat?: OutputFormat;
    pathToClaudeCodeExecutable?: string;
    permissionMode?: PermissionMode;
    planModeInstructions?: string;
    allowDangerouslySkipPermissions?: boolean;
    permissionPromptToolName?: string;
    plugins?: SdkPluginConfig[];
    promptSuggestions?: boolean;
    agentProgressSummaries?: boolean;
    resume?: string;
    sessionId?: string;
    resumeSessionAt?: string;
    sandbox?: SandboxSettings;
    settings?: string | Settings;
    managedSettings?: Settings;
    settingSources?: SettingSource[];
    skills?: string[] | 'all';
    debug?: boolean;
    debugFile?: string;
    stderr?: (data: string) => void;
    strictMcpConfig?: boolean;
    systemPrompt?: string | string[] | {
        type: 'preset';
        preset: 'claude_code';
        append?: string;
        excludeDynamicSections?: boolean;
    };
    title?: string;
    spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
};
```

### Options 字段详解

| 字段 | 类型 | 说明 |
|------|------|------|
| `abortController` | `AbortController` | 用于取消查询 |
| `additionalDirectories` | `string[]` | 附加工作目录 |
| `agent` | `string` | 主线程代理名称 |
| `agents` | `Record<string, AgentDefinition>` | 自定义子代理定义 |
| `allowedTools` | `string[]` | 允许使用的工具白名单 |
| `disallowedTools` | `string[]` | 禁止使用的工具黑名单 |
| `toolAliases` | `Record<string, string>` | 工具别名映射 |
| `tools` | `string[] | { type: 'preset'; preset: 'claude_code' }` | 工具配置，或使用预设 |
| `canUseTool` | `CanUseTool` | 自定义权限回调 |
| `continue` | `boolean` | 继续上次会话 (与 `resume` 互斥) |
| `cwd` | `string` | 工作目录 |
| `env` | `{ [key]: string | undefined }` | 环境变量 |
| `executable` | `'bun' | 'deno' | 'node'` | 运行时选择 |
| `executableArgs` | `string[]` | 运行时参数 |
| `fallbackModel` | `string` | 模型不可用时的备选 |
| `enableFileCheckpointing` | `boolean` | 启用文件检查点 (支持 rewindFiles) |
| `toolConfig` | `ToolConfig` | 工具配置详情 |
| `forkSession` | `boolean` | 创建分支会话 |
| `betas` | `SdkBeta[]` | 启用 beta 功能，目前仅 `'context-1m-2025-08-07'` |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | 钩子回调配置 |
| `onElicitation` | `OnElicitation` | MCP Elicitation 请求回调 |
| `persistSession` | `boolean` | 是否持久化会话 (默认 true) |
| `includeHookEvents` | `boolean` | 是否在消息流中包含钩子事件 (默认 false) |
| `includePartialMessages` | `boolean` | 是否包含部分消息 (流式中间状态) |
| `forwardSubagentText` | `boolean` | 是否转发子代理文本到主消息流 |
| `thinking` | `ThinkingConfig` | 扩展思考配置 |
| `effort` | `EffortLevel` | 推理努力级别 `'low' | 'medium' | 'high' | 'xhigh' | 'max'` |
| `maxTurns` | `number` | 最大对话轮次 |
| `maxBudgetUsd` | `number` | 最大预算 (美元) |
| `mcpServers` | `Record<string, McpServerConfig>` | MCP 服务器配置 |
| `model` | `string` | 使用的模型 ID |
| `outputFormat` | `OutputFormat` | 结构化输出格式 |
| `permissionMode` | `PermissionMode` | 权限模式 |
| `planModeInstructions` | `string` | Plan Mode 的自定义指令 |
| `allowDangerouslySkipPermissions` | `boolean` | 跳过权限检查 (危险) |
| `permissionPromptToolName` | `string` | 权限提示工具名称 |
| `plugins` | `SdkPluginConfig[]` | 插件配置 |
| `promptSuggestions` | `boolean` | 启用提示建议 |
| `agentProgressSummaries` | `boolean` | 启用代理进度摘要 |
| `resume` | `string` | 会话 ID，恢复之前的会话 |
| `sessionId` | `string` | 必须为有效 UUID |
| `resumeSessionAt` | `string` | 消息 UUID，从指定消息恢复 |
| `sandbox` | `SandboxSettings` | 沙箱设置 |
| `systemPrompt` | `string | string[] | preset object` | 系统提示词 |
| `title` | `string` | 会话标题 |
| `skills` | `string[] | 'all'` | 启用的技能列表 |
| `spawnClaudeCodeProcess` | `(SpawnOptions) => SpawnedProcess` | 自定义进程启动函数 |

---

## 5. PermissionMode (权限模式)

> 来源: `sdk.d.ts`

```typescript
export declare type PermissionMode =
    | 'default'            // 标准行为，危险操作需确认
    | 'acceptEdits'        // 自动接受文件编辑操作
    | 'bypassPermissions'  // 跳过所有权限检查 (需 allowDangerouslySkipPermissions)
    | 'plan'               // 规划模式，不执行工具
    | 'dontAsk'            // 不提示权限，未预批准的自动拒绝
    | 'auto';              // 使用模型分类器自动批准/拒绝
```

### CanUseTool 回调

> 来源: `sdk.d.ts`

```typescript
export declare type CanUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    options: {
        signal: AbortSignal;
        suggestions?: PermissionUpdate[];
        blockedPath?: string;
        decisionReason?: string;
        title?: string;
        displayName?: string;
        description?: string;
        toolUseID: string;
        agentID?: string;
    }
) => Promise<PermissionResult>;

export declare type PermissionResult =
    | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string; decisionClassification?: PermissionDecisionClassification }
    | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string; decisionClassification?: PermissionDecisionClassification };

type PermissionDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject';
```

---

## 6. ThinkingConfig (扩展思考配置)

> 来源: `sdk.d.ts`

```typescript
export declare type ThinkingConfig =
    | ThinkingAdaptive
    | ThinkingEnabled
    | ThinkingDisabled;

type ThinkingAdaptive = {
    type: 'adaptive';        // Claude 自行决定思考量 (Opus 4.6+)
    display?: 'summarized' | 'omitted';
};

type ThinkingEnabled = {
    type: 'enabled';         // 固定思考 token 预算 (旧模型)
    budgetTokens?: number;
    display?: 'summarized' | 'omitted';
};

type ThinkingDisabled = {
    type: 'disabled';        // 不启用扩展思考
};

export declare type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
```

---

## 7. message.type 所有类型 (SDKMessage 联合类型)

> 来源: `sdk.d.ts`

### 7.1 type + subtype 分类总览

| type 值 | subtype 值 | 对应 TypeScript 类型 | 说明 |
|---------|-----------|---------------------|------|
| `'assistant'` | — | `SDKAssistantMessage` | Claude 助手回复 |
| `'user'` | — | `SDKUserMessage` | 用户消息 |
| `'user'` | — (isReplay=true) | `SDKUserMessageReplay` | 重播的用户消息 |
| `'result'` | `'success'` | `SDKResultSuccess` | 执行成功结果 |
| `'result'` | `'error_during_execution'` | `SDKResultError` | 执行期间出错 |
| `'result'` | `'error_max_turns'` | `SDKResultError` | 达到最大轮次 |
| `'result'` | `'error_max_budget_usd'` | `SDKResultError` | 达到最大预算 |
| `'result'` | `'error_max_structured_output_retries'` | `SDKResultError` | 结构化输出重试超限 |
| `'system'` | `'init'` | `SDKSystemMessage` | 初始化系统消息 |
| `'system'` | `'compact_boundary'` | `SDKCompactBoundaryMessage` | 上下文压缩边界 |
| `'system'` | `'status'` | `SDKStatusMessage` | 状态消息 |
| `'system'` | `'api_retry'` | `SDKAPIRetryMessage` | API 重试通知 |
| `'system'` | `'local_command_output'` | `SDKLocalCommandOutputMessage` | 本地命令输出 |
| `'system'` | `'hook_started'` | `SDKHookStartedMessage` | 钩子开始执行 |
| `'system'` | `'hook_progress'` | `SDKHookProgressMessage` | 钩子执行进度 |
| `'system'` | `'hook_response'` | `SDKHookResponseMessage` | 钩子执行响应 |
| `'system'` | `'plugin_install'` | `SDKPluginInstallMessage` | 插件安装通知 |
| `'system'` | `'task_notification'` | `SDKTaskNotificationMessage` | 任务完成/失败通知 |
| `'system'` | `'task_started'` | `SDKTaskStartedMessage` | 任务启动通知 |
| `'system'` | `'task_updated'` | `SDKTaskUpdatedMessage` | 任务更新通知 |
| `'system'` | `'task_progress'` | `SDKTaskProgressMessage` | 任务进度通知 |
| `'system'` | `'session_state_changed'` | `SDKSessionStateChangedMessage` | 会话状态变更 |
| `'system'` | `'notification'` | `SDKNotificationMessage` | 通知消息 |
| `'system'` | `'files_persisted'` | `SDKFilesPersistedEvent` | 文件持久化事件 |
| `'system'` | `'memory_recall'` | `SDKMemoryRecallMessage` | 记忆召回 |
| `'system'` | `'elicitation_complete'` | `SDKElicitationCompleteMessage` | MCP Elicitation 完成 |
| `'system'` | `'permission_denied'` | `SDKPermissionDeniedMessage` | 权限被拒绝 |
| `'system'` | `'mirror_error'` | `SDKMirrorErrorMessage` | Mirror 错误 |
| `'stream_event'` | — | `SDKPartialAssistantMessage` | 流式中间事件 |
| `'tool_progress'` | — | `SDKToolProgressMessage` | 工具执行进度 |
| `'auth_status'` | — | `SDKAuthStatusMessage` | 认证状态 |
| `'tool_use_summary'` | — | `SDKToolUseSummaryMessage` | 工具调用摘要 |
| `'rate_limit_event'` | — | `SDKRateLimitEvent` | 速率限制事件 |
| `'prompt_suggestion'` | — | `SDKPromptSuggestionMessage` | 提示建议 |

### 7.2 核心消息类型详细结构

#### SDKAssistantMessage

```typescript
export declare type SDKAssistantMessage = {
    type: 'assistant';
    message: BetaMessage;              // Anthropic API 的完整 Message 对象
    parent_tool_use_id: string | null;
    error?: SDKAssistantMessageError;
    uuid: UUID;
    session_id: string;
    request_id?: string;
    subagent_type?: string;
    task_description?: string;
};

export declare type SDKAssistantMessageError =
    | 'authentication_failed'
    | 'oauth_org_not_allowed'
    | 'billing_error'
    | 'rate_limit'
    | 'invalid_request'
    | 'server_error'
    | 'unknown'
    | 'max_output_tokens';
```

#### SDKUserMessage

```typescript
export declare type SDKUserMessage = {
    type: 'user';
    message: MessageParam;              // Anthropic API 的 MessageParam
    parent_tool_use_id: string | null;
    isSynthetic?: boolean;
    tool_use_result?: unknown;
    priority?: 'now' | 'next' | 'later';
    origin?: SDKMessageOrigin;
    shouldQuery?: boolean;
    timestamp?: string;
    uuid?: UUID;
    session_id?: string;
    subagent_type?: string;
    task_description?: string;
};

export declare type SDKMessageOrigin =
    | { kind: 'human' }
    | { kind: 'channel'; server: string }
    | { kind: 'peer'; from: string; name?: string }
    | { kind: 'task-notification' }
    | { kind: 'coordinator' };
```

#### SDKResultSuccess

```typescript
export declare type SDKResultSuccess = {
    type: 'result';
    subtype: 'success';
    duration_ms: number;
    duration_api_ms: number;
    ttft_ms?: number;                   // Time to first token
    is_error: boolean;
    api_error_status?: number | null;
    num_turns: number;
    result: string;
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    structured_output?: unknown;
    deferred_tool_use?: SDKDeferredToolUse;
    terminal_reason?: TerminalReason;
    fast_mode_state?: FastModeState;
    origin?: SDKMessageOrigin;
    uuid: UUID;
    session_id: string;
};
```

#### SDKResultError

```typescript
export declare type SDKResultError = {
    type: 'result';
    subtype: 'error_during_execution'
        | 'error_max_turns'
        | 'error_max_budget_usd'
        | 'error_max_structured_output_retries';
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    errors: string[];
    terminal_reason?: TerminalReason;
    fast_mode_state?: FastModeState;
    origin?: SDKMessageOrigin;
    uuid: UUID;
    session_id: string;
};
```

#### TerminalReason 值

```typescript
type TerminalReason =
    | 'blocking_limit'
    | 'rapid_refill_breaker'
    | 'prompt_too_long'
    | 'image_error'
    | 'model_error'
    | 'aborted_streaming'
    | 'aborted_tools'
    | 'stop_hook_prevented'
    | 'hook_stopped'
    | 'tool_deferred'
    | 'max_turns'
    | 'completed';
```

#### SDKSystemMessage (init)

```typescript
export declare type SDKSystemMessage = {
    type: 'system';
    subtype: 'init';
    agents?: string[];
    apiKeySource: ApiKeySource;
    betas?: string[];
    claude_code_version: string;
    cwd: string;
    tools: string[];
    mcp_servers: { name: string; status: string }[];
    model: string;
    permissionMode: PermissionMode;
    slash_commands: string[];
    output_style: string;
    skills: string[];
    plugins: { name: string; path: string }[];
    fast_mode_state?: FastModeState;
    uuid: UUID;
    session_id: string;
};
```

#### SDKPartialAssistantMessage

```typescript
export declare type SDKPartialAssistantMessage = {
    type: 'stream_event';
    event: BetaRawMessageStreamEvent;   // Anthropic API 流式事件
    parent_tool_use_id: string | null;
    ttft_ms?: number;
};
```

#### SDKToolProgressMessage

```typescript
export declare type SDKToolProgressMessage = {
    type: 'tool_progress';
    tool_use_id: string;
    tool_name: string;
    parent_tool_use_id: string | null;
    elapsed_time_seconds: number;
    task_id?: string;
};
```

#### SDKSessionStateChangedMessage

```typescript
type SDKSessionStateChangedMessage = {
    type: 'system';
    subtype: 'session_state_changed';
    state: 'idle' | 'running' | 'requires_action';
};
```

#### SDKHookStartedMessage / HookProgressMessage / HookResponseMessage

```typescript
type SDKHookStartedMessage = {
    type: 'system'; subtype: 'hook_started';
    hook_id: string; hook_name: string; hook_event: string;
};

type SDKHookProgressMessage = {
    type: 'system'; subtype: 'hook_progress';
    hook_id: string; hook_name: string; hook_event: string;
    stdout: string; stderr: string; output: string;
};

type SDKHookResponseMessage = {
    type: 'system'; subtype: 'hook_response';
    hook_id: string; hook_name: string; hook_event: string;
    output: string; stdout: string; stderr: string;
    exit_code?: number;
    outcome: 'success' | 'error' | 'cancelled';
};
```

---

## 8. Hook 系统

> 来源: `sdk.d.ts`

### 8.1 HookEvent — 29 种钩子事件

```typescript
export declare type HookEvent =
    | 'PreToolUse'              // 工具调用前
    | 'PostToolUse'             // 工具调用后
    | 'PostToolUseFailure'      // 工具调用失败后
    | 'PostToolBatch'           // 工具批量调用后
    | 'Notification'            // 通知事件
    | 'UserPromptSubmit'        // 用户提交提示时
    | 'UserPromptExpansion'     // 斜杠命令/MCP 提示展开时
    | 'SessionStart'            // 会话开始
    | 'SessionEnd'              // 会话结束
    | 'Stop'                    // 正常停止
    | 'StopFailure'             // 异常停止
    | 'SubagentStart'           // 子代理启动
    | 'SubagentStop'            // 子代理停止
    | 'PreCompact'              // 上下文压缩前
    | 'PostCompact'             // 上下文压缩后
    | 'PermissionRequest'       // 权限请求
    | 'PermissionDenied'        // 权限被拒绝
    | 'Setup'                   // Setup 命令执行
    | 'TeammateIdle'            // 团队成员空闲
    | 'TaskCreated'             // 任务创建
    | 'TaskCompleted'           // 任务完成
    | 'Elicitation'             // MCP Elicitation 请求
    | 'ElicitationResult'       // MCP Elicitation 结果
    | 'ConfigChange'            // 配置变更
    | 'WorktreeCreate'          // Worktree 创建
    | 'WorktreeRemove'          // Worktree 删除
    | 'InstructionsLoaded'      // 指令文件加载
    | 'CwdChanged'              // 工作目录变更
    | 'FileChanged';            // 文件变更
```

### 8.2 Hook 回调类型

```typescript
export declare type HookCallback = (
    input: HookInput,
    toolUseID: string | undefined,
    options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;

export declare interface HookCallbackMatcher {
    matcher?: string;         // 匹配模式 (工具名等)
    hooks: HookCallback[];
    timeout?: number;         // 超时秒数
}
```

### 8.3 HookJSONOutput — 回调返回值

```typescript
export declare type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

type AsyncHookJSONOutput = {
    async: true;
    asyncTimeout?: number;
};

type SyncHookJSONOutput = {
    continue?: boolean;
    suppressOutput?: boolean;
    stopReason?: string;
    decision?: 'approve' | 'block';
    systemMessage?: string;
    terminalSequence?: string;   // 仅 OSC 转义序列
    reason?: string;
    hookSpecificOutput?: PreToolUseHookSpecificOutput
        | PostToolUseHookSpecificOutput
        | ...;  // 各事件的特定输出
};
```

### 8.4 BaseHookInput — 所有 Hook 输入的基础字段

```typescript
export declare type BaseHookInput = {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode?: string;
    agent_id?: string;          // 仅子代理钩子中存在
    agent_type?: string;
    effort?: { level: string };
};
```

### 8.5 各事件的 HookInput 和 HookSpecificOutput

#### PreToolUse

> 工具调用前拦截，可修改输入或阻止执行

```typescript
type PreToolUseHookInput = BaseHookInput & {
    hook_event_name: 'PreToolUse';
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
};

type PreToolUseHookSpecificOutput = {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
};
```

#### PostToolUse

> 工具调用完成后，可修改工具输出

```typescript
type PostToolUseHookInput = BaseHookInput & {
    hook_event_name: 'PostToolUse';
    tool_name: string;
    tool_input: unknown;
    tool_response: unknown;
    tool_use_id: string;
    duration_ms?: number;
};

type PostToolUseHookSpecificOutput = {
    hookEventName: 'PostToolUse';
    additionalContext?: string;
    updatedToolOutput?: unknown;
    updatedMCPToolOutput?: unknown;
};
```

#### PostToolUseFailure

```typescript
type PostToolUseFailureHookInput = BaseHookInput & {
    hook_event_name: 'PostToolUseFailure';
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
    error: unknown;
    is_interrupt?: boolean;
    duration_ms?: number;
};

type PostToolUseFailureHookSpecificOutput = {
    hookEventName: 'PostToolUseFailure';
    additionalContext?: string;
};
```

#### Stop

```typescript
type StopHookInput = BaseHookInput & {
    hook_event_name: 'Stop';
    stop_hook_active: boolean;
    last_assistant_message?: string;
};
```

#### SessionStart

```typescript
type SessionStartHookInput = BaseHookInput & {
    hook_event_name: 'SessionStart';
    source: 'startup' | 'resume' | 'clear' | 'compact';
    agent_type?: string;
    model?: string;
};

type SessionStartHookSpecificOutput = {
    hookEventName: 'SessionStart';
    additionalContext?: string;
    initialUserMessage?: string;
    watchPaths?: string[];
};
```

#### PermissionRequest

```typescript
type PermissionRequestHookInput = BaseHookInput & {
    hook_event_name: 'PermissionRequest';
    tool_name: string;
    tool_input: unknown;
    permission_suggestions?: unknown;
};

type PermissionRequestHookSpecificOutput = {
    hookEventName: 'PermissionRequest';
    decision:
        | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown }
        | { behavior: 'deny'; message?: string; interrupt?: boolean };
};
```

#### UserPromptSubmit

```typescript
type UserPromptSubmitHookInput = BaseHookInput & {
    hook_event_name: 'UserPromptSubmit';
    prompt: string;
    session_title?: string;
};

type UserPromptSubmitHookSpecificOutput = {
    hookEventName: 'UserPromptSubmit';
    additionalContext?: string;
    sessionTitle?: string;
    suppressOriginalPrompt?: boolean;
};
```

#### Elicitation

> MCP Elicitation 请求，用于收集用户输入

```typescript
type ElicitationHookInput = BaseHookInput & {
    hook_event_name: 'Elicitation';
    mcp_server_name: string;
    message: string;
    mode?: 'form' | 'url';
    url?: string;
    elicitation_id?: string;
    requested_schema?: Record<string, unknown>;
};

type ElicitationHookSpecificOutput = {
    hookEventName: 'Elicitation';
    action?: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
};
```

#### FileChanged

```typescript
type FileChangedHookInput = BaseHookInput & {
    hook_event_name: 'FileChanged';
    file_path: string;
    event: 'change' | 'add' | 'unlink';
};

type FileChangedHookSpecificOutput = {
    hookEventName: 'FileChanged';
    watchPaths?: string[];
};
```

---

## 9. MCP 服务器配置

> 来源: `sdk.d.ts`

```typescript
export declare type McpServerConfig =
    | McpStdioServerConfig
    | McpSSEServerConfig
    | McpHttpServerConfig
    | McpSdkServerConfigWithInstance;

type McpStdioServerConfig = {
    type?: 'stdio';           // 默认类型
    command: string;          // 启动命令
    args?: string[];          // 命令参数
    env?: Record<string, string>;
    alwaysLoad?: boolean;     // 是否总是加载
};

type McpSSEServerConfig = {
    type: 'sse';
    url: string;              // SSE 连接地址
    headers?: Record<string, string>;
    tools?: McpServerToolPolicy[];
    alwaysLoad?: boolean;
};

type McpHttpServerConfig = {
    type: 'http';             // Streamable HTTP
    url: string;
    headers?: Record<string, string>;
    tools?: McpServerToolPolicy[];
    alwaysLoad?: boolean;
};

type McpServerToolPolicy = {
    name: string;
    permission_policy: 'always_allow' | 'always_ask' | 'always_deny';
};
```

### SDK 内嵌 MCP 服务器

> 来源: `sdk.d.ts`

```typescript
type CreateSdkMcpServerOptions = {
    name: string;
    version?: string;
    tools?: Array<SdkMcpToolDefinition<any>>;
    alwaysLoad?: boolean;
};

export declare function createSdkMcpServer(
    _options: CreateSdkMcpServerOptions
): McpSdkServerConfigWithInstance;
```

---

## 10. 自定义工具定义

> 来源: `sdk.d.ts`

### 10.1 tool 函数

```typescript
export declare function tool<Schema extends AnyZodRawShape>(
    _name: string,
    _description: string,
    _inputSchema: Schema,
    _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
    _extras?: {
        annotations?: ToolAnnotations;
        searchHint?: string;
        alwaysLoad?: boolean;
    }
): SdkMcpToolDefinition<Schema>;
```

### 10.2 SdkMcpToolDefinition

```typescript
type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
    name: string;
    description: string;
    inputSchema: Schema;      // Zod raw shape
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
    handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
};
```

### 10.3 示例: 定义自定义工具

```typescript
import { tool, createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const myTool = tool(
    'calculate_metrics',
    'Calculate business metrics from raw data',
    { data: z.array(z.number()), operation: z.enum(['sum', 'avg', 'max', 'min']) },
    async (args) => {
        const result = args.operation === 'sum'
            ? args.data.reduce((a, b) => a + b, 0)
            : args.operation === 'avg'
            ? args.data.reduce((a, b) => a + b, 0) / args.data.length
            : args.operation === 'max'
            ? Math.max(...args.data)
            : Math.min(...args.data);
        return { content: [{ type: 'text', text: String(result) }] };
    }
);

const mcpServer = createSdkMcpServer({
    name: 'metrics-server',
    version: '1.0.0',
    tools: [myTool],
});

const messages = query({
    prompt: 'Calculate the sum of [1, 2, 3, 4, 5]',
    options: { mcpServers: { metrics: mcpServer } },
});

for await (const msg of messages) {
    if (msg.type === 'result' && msg.subtype === 'success') {
        console.log(msg.result);
    }
}
```

---

## 11. AgentDefinition (子代理定义)

> 来源: `sdk.d.ts`

```typescript
type AgentDefinition = {
    description: string;
    tools?: string[];
    disallowedTools?: string[];
    prompt: string;
    model?: string;
    mcpServers?: AgentMcpServerSpec[];
    criticalSystemReminder_EXPERIMENTAL?: string;
    skills?: string[];
    initialPrompt?: string;
    maxTurns?: number;
    background?: boolean;
    memory?: 'user' | 'project' | 'local';
    effort?: ('low' | 'medium' | 'high' | 'xhigh' | 'max') | number;
    permissionMode?: PermissionMode;
};
```

---

## 12. 会话管理函数

> 来源: `sdk.d.ts`

```typescript
export declare function listSessions(_options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
export declare function getSessionInfo(_sessionId: string, _options?: GetSessionInfoOptions): Promise<SDKSessionInfo | undefined>;
export declare function getSessionMessages(_sessionId: string, _options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
export declare function getSubagentMessages(_sessionId: string, _agentId: string, _options?: GetSubagentMessagesOptions): Promise<SessionMessage[]>;
export declare function listSubagents(_sessionId: string, _options?: ListSubagentsOptions): Promise<string[]>;
export declare function renameSession(_sessionId: string, _title: string, _options?: SessionMutationOptions): Promise<void>;
export declare function tagSession(_sessionId: string, _tag: string | null, _options?: SessionMutationOptions): Promise<void>;
export declare function deleteSession(_sessionId: string, _options?: SessionMutationOptions): Promise<void>;
export declare function forkSession(_sessionId: string, _options?: ForkSessionOptions): Promise<ForkSessionResult>;
export declare function importSessionToStore(_sessionId: string, _store: SessionStore, _options?: ImportSessionToStoreOptions): Promise<void>;
```

---

## 13. 其他重要类型

### AccountInfo

```typescript
type AccountInfo = {
    email?: string;
    organization?: string;
    subscriptionType?: string;
    tokenSource?: string;
    apiKeySource?: string;
    apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle' | 'gateway';
};
```

### ModelInfo

```typescript
type ModelInfo = {
    value: string;
    displayName: string;
    description: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
    supportsAdaptiveThinking?: boolean;
    supportsFastMode?: boolean;
    supportsAutoMode?: boolean;
};
```

### FastModeState

```typescript
type FastModeState = 'off' | 'cooldown' | 'on';
```

### ExitReason

```typescript
type ExitReason = 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other' | 'bypass_permissions_disabled';
```

### SdkBeta

```typescript
type SdkBeta = 'context-1m-2025-08-07';
```

### SpawnedProcess / SpawnOptions

```typescript
interface SpawnedProcess {
    stdin: Writable;
    stdout: Readable;
    readonly killed: boolean;
    readonly exitCode: number | null;
    kill(signal: NodeJS.Signals): boolean;
    on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

interface SpawnOptions {
    command: string;
    args: string[];
    cwd?: string;
    env: { [envVar: string]: string | undefined };
    signal: AbortSignal;
}
```

---

## 14. 完整使用示例

### 14.1 单轮问答

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const messages = query({
    prompt: 'Explain what a monorepo is in one paragraph.',
    options: {
        model: 'claude-sonnet-4-6',
        maxTurns: 1,
    },
});

for await (const msg of messages) {
    if (msg.type === 'assistant') {
        // 处理助手消息
        for (const block of msg.message.content) {
            if (block.type === 'text') {
                console.log(block.text);
            }
        }
    }
    if (msg.type === 'result' && msg.subtype === 'success') {
        console.log(`Cost: $${msg.total_cost_usd.toFixed(4)}`);
        console.log(`Turns: ${msg.num_turns}`);
    }
}
```

### 14.2 多轮流式输入

```typescript
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

async function* userStream(): AsyncIterable<SDKUserMessage> {
    yield {
        type: 'user',
        message: { role: 'user', content: 'Write a hello world in Python' },
        parent_tool_use_id: null,
    };

    // 等待用户输入后继续
    yield {
        type: 'user',
        message: { role: 'user', content: 'Now add error handling' },
        parent_tool_use_id: null,
    };
}

const messages = query({
    prompt: userStream(),
    options: {
        cwd: '/path/to/project',
        permissionMode: 'acceptEdits',
    },
});

for await (const msg of messages) {
    console.log(`Message type: ${msg.type}`);
}
```

### 14.3 带钩子的查询

```typescript
import { query, type Options, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

const preToolUseHook: HookCallbackMatcher = {
    matcher: 'Bash',  // 仅匹配 Bash 工具调用
    hooks: [
        async (input, toolUseID, options) => {
            const toolInput = input as { tool_name: string; tool_input: unknown };
            console.log(`Tool: ${toolInput.tool_name}`);
            console.log(`Input: ${JSON.stringify(toolInput.tool_input)}`);
            return {
                continue: true,
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                },
            };
        },
    ],
};

const options: Options = {
    hooks: {
        PreToolUse: [preToolUseHook],
    },
    includeHookEvents: true,
};

const messages = query({
    prompt: 'List all files in the current directory',
    options,
});

for await (const msg of messages) {
    if (msg.type === 'system' && msg.subtype === 'hook_started') {
        console.log(`Hook started: ${msg.hook_name}`);
    }
    if (msg.type === 'system' && msg.subtype === 'hook_response') {
        console.log(`Hook response: outcome=${msg.outcome}`);
    }
}
```

### 14.4 带 MCP 服务器

```typescript
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

const options: Options = {
    mcpServers: {
        'my-api': {
            type: 'stdio',
            command: 'node',
            args: ['my-mcp-server.js'],
        },
        'remote-api': {
            type: 'sse',
            url: 'https://example.com/mcp/sse',
            headers: { Authorization: 'Bearer xxx' },
        },
    },
    permissionMode: 'default',
};

const messages = query({
    prompt: 'Use the my-api MCP to fetch user data',
    options,
});

for await (const msg of messages) {
    // 消费消息流
}
```

### 14.5 自定义权限回调

```typescript
import { query, type Options, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';

const canUseTool: CanUseTool = async (toolName, input, opts) => {
    // 只允许读取操作
    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
        return {
            behavior: 'allow',
            decisionClassification: 'user_permanent',
        };
    }

    // 阻止所有写操作
    return {
        behavior: 'deny',
        message: `Write operations are not allowed in this context`,
        decisionClassification: 'user_reject',
    };
};

const options: Options = {
    canUseTool,
    cwd: '/safe/read-only-directory',
};

const messages = query({
    prompt: 'Analyze the codebase structure',
    options,
});
```

### 14.6 恢复会话

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const messages = query({
    prompt: 'Continue the previous task',
    options: {
        resume: 'previous-session-id',       // 会话 ID
        resumeSessionAt: 'message-uuid',     // 从指定消息恢复
    },
});
```

### 14.7 结构化输出 (outputFormat)

```typescript
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

const options: Options = {
    outputFormat: {
        type: 'json_schema',
        // JSON Schema 定义结构化输出格式
    },
    maxTurns: 1,
};

const messages = query({
    prompt: 'Analyze this code and return a structured report',
    options,
});

for await (const msg of messages) {
    if (msg.type === 'result' && msg.subtype === 'success') {
        console.log(msg.structured_output);  // 结构化输出数据
    }
}
```

### 14.8 startup 预热

```typescript
import { startup } from '@anthropic-ai/claude-agent-sdk';

// 预加载进程
await using warmQuery = await startup({ options: { model: 'claude-sonnet-4-6' } });

// 首次调用更快
const messages1 = warmQuery.query('What is TypeScript?');

// 后续调用也更快 (进程已启动)
const messages2 = warmQuery.query('Explain monorepos');

// AsyncDisposable 自动 close()
```

---

## 15. 内置工具 Input/Output Schema 类型

> 来源: `sdk-tools.d.ts`

```typescript
type ToolInputSchemas =
    | AgentInput | BashInput | TaskOutputInput | ExitPlanModeInput
    | FileEditInput | FileReadInput | FileWriteInput | GlobInput
    | GrepInput | TaskStopInput | ListMcpResourcesInput | McpInput
    | NotebookEditInput | ReadMcpResourceInput | TodoWriteInput
    | WebFetchInput | WebSearchInput | AskUserQuestionInput
    | TaskCreateInput | TaskGetInput | TaskUpdateInput | TaskListInput
    | EnterWorktreeInput | ExitWorktreeInput | ToolOutputSchemas;

type ToolOutputSchemas =
    | AgentOutput | BashOutput | ExitPlanModeOutput | FileEditOutput
    | FileReadOutput | FileWriteOutput | GlobOutput | GrepOutput
    | TaskStopOutput | ListMcpResourcesOutput | McpOutput | NotebookEditOutput
    | ReadMcpResourceOutput | TodoWriteOutput | WebFetchOutput | WebSearchOutput
    | AskUserQuestionOutput | EnterWorktreeOutput | ExitWorktreeOutput
    | TaskCreateOutput | TaskGetOutput | TaskUpdateOutput | TaskListOutput;
```

对应 Claude Code 的 22 个内置工具:

| 工具名 | Input 类型 | Output 类型 | 说明 |
|--------|-----------|------------|------|
| Agent | `AgentInput` | `AgentOutput` | 子代理调用 |
| Bash | `BashInput` | `BashOutput` | Shell 命令执行 |
| TaskOutput | `TaskOutputInput` | — | 任务输出获取 |
| ExitPlanMode | `ExitPlanModeInput` | `ExitPlanModeOutput` | 退出规划模式 |
| FileEdit | `FileEditInput` | `FileEditOutput` | 文件编辑 |
| FileRead | `FileReadInput` | `FileReadOutput` | 文件读取 |
| FileWrite | `FileWriteInput` | `FileWriteOutput` | 文件写入 |
| Glob | `GlobInput` | `GlobOutput` | 文件模式搜索 |
| Grep | `GrepInput` | `GrepOutput` | 内容搜索 |
| TaskStop | `TaskStopInput` | `TaskStopOutput` | 停止任务 |
| ListMcpResources | `ListMcpResourcesInput` | `ListMcpResourcesOutput` | MCP 资源列表 |
| Mcp | `McpInput` | `McpOutput` | MCP 工具调用 |
| NotebookEdit | `NotebookEditInput` | `NotebookEditOutput` | Notebook 编辑 |
| ReadMcpResource | `ReadMcpResourceInput` | `ReadMcpResourceOutput` | MCP 资源读取 |
| TodoWrite | `TodoWriteInput` | `TodoWriteOutput` | 任务列表写入 |
| WebFetch | `WebFetchInput` | `WebFetchOutput` | 网页获取 |
| WebSearch | `WebSearchInput` | `WebSearchOutput` | 网页搜索 |
| AskUserQuestion | `AskUserQuestionInput` | `AskUserQuestionOutput` | 用户提问 |
| TaskCreate | `TaskCreateInput` | `TaskCreateOutput` | 创建任务 |
| TaskGet | `TaskGetInput` | `TaskGetOutput` | 获取任务 |
| TaskUpdate | `TaskUpdateInput` | `TaskUpdateOutput` | 更新任务 |
| TaskList | `TaskListInput` | `TaskListOutput` | 任务列表 |
| EnterWorktree | `EnterWorktreeInput` | `EnterWorktreeOutput` | 进入 Worktree |
| ExitWorktree | `ExitWorktreeInput` | `ExitWorktreeOutput` | 退出 Worktree |

---

## 16. SDKMessage 处理模式

### 16.1 消息类型判断

```typescript
for await (const msg of messages) {
    switch (msg.type) {
        case 'assistant':
            // 处理助手回复
            break;
        case 'user':
            // 处理用户消息
            break;
        case 'result':
            if (msg.subtype === 'success') {
                // 执行成功
            } else if (msg.subtype === 'error_during_execution') {
                // 执行错误
            } else if (msg.subtype === 'error_max_turns') {
                // 超过最大轮次
            } else if (msg.subtype === 'error_max_budget_usd') {
                // 超过最大预算
            }
            break;
        case 'system':
            switch (msg.subtype) {
                case 'init':
                    // 初始化信息
                    break;
                case 'status':
                    // 状态更新
                    break;
                case 'hook_started':
                    // 钩子开始
                    break;
                case 'hook_response':
                    // 钩子完成
                    break;
                case 'session_state_changed':
                    // idle / running / requires_action
                    break;
                // ... 其他 subtype
            }
            break;
        case 'stream_event':
            // 流式中间事件
            break;
        case 'tool_progress':
            // 工具执行进度
            break;
        case 'auth_status':
            // 认证状态
            break;
        case 'tool_use_summary':
            // 工具调用摘要
            break;
        case 'rate_limit_event':
            // 速率限制
            break;
        case 'prompt_suggestion':
            // 提示建议
            break;
    }
}
```

### 16.2 仅关注最终结果

```typescript
for await (const msg of messages) {
    if (msg.type === 'result') {
        if (msg.subtype === 'success') {
            console.log('Result:', msg.result);
            console.log('Cost:', msg.total_cost_usd);
        } else {
            console.error('Error:', msg.errors);
        }
        break;  // result 是最后一条消息
    }
}
```

---

## 17. Bridge 与 Assistant 子导出 (@alpha)

> 来源: `bridge.d.ts`, `assistant.d.ts`
> 状态: @alpha — 可能变更，不建议生产使用

### Bridge — 持久 Worker 进程

```typescript
// 创建持久会话，跨多次 query 共享进程
import { attachBridgeSession, createCodeSession } from '@anthropic-ai/claude-agent-sdk/bridge';
```

关键类型: `BridgeSessionHandle`, `fetchRemoteCredentials()`, `RemoteCredentials`, `CredentialsFailure`

### Assistant — claude.ai 集成

```typescript
// 运行 Assistant Worker，与 claude.ai 交互
import { runAssistantWorker } from '@anthropic-ai/claude-agent-sdk/assistant';
```

关键类型: `AssistantWorkerHandle`, `AssistantWorkerOptions`, `AssistantWorkerError`

---

## 18. 常量

> 来源: `sdk.d.ts`

```typescript
export declare const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

export declare const HOOK_EVENTS: readonly [
    "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch",
    "Notification", "UserPromptSubmit", "UserPromptExpansion",
    "SessionStart", "SessionEnd", "Stop", "StopFailure",
    "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
    "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle",
    "TaskCreated", "TaskCompleted", "Elicitation", "ElicitationResult",
    "ConfigChange", "WorktreeCreate", "WorktreeRemove",
    "InstructionsLoaded", "CwdChanged", "FileChanged"
];
```

---

## 附录: 快速参考卡片

| API | 用途 |
|-----|------|
| `query({ prompt, options })` | 执行查询，返回 AsyncGenerator |
| `startup({ options })` | 预加载进程，返回 WarmQuery |
| `tool(name, desc, schema, handler)` | 定义自定义 MCP 工具 |
| `createSdkMcpServer({ name, tools })` | 创建内嵌 MCP 服务器 |
| `listSessions()` | 列出所有会话 |
| `getSessionInfo(id)` | 获取会话信息 |
| `getSessionMessages(id)` | 获取会话消息 |
| `forkSession(id)` | 创建分支会话 |
| `resolveSettings()` | 解析设置 |

| PermissionMode | 说明 |
|---------------|------|
| `'default'` | 标准模式，危险操作需确认 |
| `'acceptEdits'` | 自动接受文件编辑 |
| `'bypassPermissions'` | 跳过所有权限 (危险) |
| `'plan'` | 规划模式 |
| `'dontAsk'` | 不提示，自动拒绝 |
| `'auto'` | 模型自动决策 |

| ThinkingConfig | 说明 |
|---------------|------|
| `{ type: 'adaptive' }` | 自适应思考 |
| `{ type: 'enabled', budgetTokens?: number }` | 固定预算思考 |
| `{ type: 'disabled' }` | 禁用思考 |

| EffortLevel | 说明 |
|------------|------|
| `'low'` | 低推理 |
| `'medium'` | 中等推理 |
| `'high'` | 高推理 |
| `'xhigh'` | 极高推理 |
| `'max'` | 最大推理 |