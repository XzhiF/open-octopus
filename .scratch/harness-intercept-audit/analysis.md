# Harness 拦截审计报告

> 2026-08-08 · feat/workflow-engine-harness

## 执行摘要

| 维度 | 修复前 | 修复后 |
|------|--------|--------|
| Bash 节点静态扫描 | ✅ 工作 | ✅ 工作 |
| Agent 工具拦截 (onBeforeToolCall) | ❌ hook 触发但不生效 | ✅ 完全拦截 |
| Bash Wrapper 别名 | ⚠️ 可绕过 | ⚠️ 可绕过 (待改进) |
| Python 节点运行时 | ❌ 无运行时保护 | ❌ 无运行时保护 (待改进) |
| 宿主进程保护 (kill host PID) | ❌ Agent 可杀进程 | ✅ 完全保护 |

**关键修复**: `permissionMode: 'bypassPermissions'` 覆盖了 SDK 的 `canUseTool` 和 `PreToolUse` hook deny 决策。移除后，`canUseTool` 成为权威授权门控，harness 工具拦截器正常工作。

## 架构分析

### 5 层拦截体系

```
Layer 1: 静态扫描 (ProcessConflictDetector)
├── 触发: onBeforeNode callback (节点执行前)
├── 范围: bash/python 节点 YAML 脚本文本
├── 时机: 变量替换前
└── 状态: ✅ 工作

Layer 2: Agent 工具拦截 (onBeforeToolCall → canUseTool)
├── 触发: Claude SDK canUseTool callback
├── 范围: agent 节点中 Bash/PowerShell 工具调用
├── 时机: 每次工具调用前
└── 状态: ✅ 修复后工作

Layer 3: Bash Wrapper (HARNESS_WRAPPER)
├── 触发: 每个 bash 脚本执行时
├── 范围: kill/pkill 命令别名
├── 时机: 运行时
└── 状态: ⚠️ 可绕过 (绝对路径, command builtin)

Layer 4: Host Safety System Prompt
├── 触发: agent 节点 systemPrompt 注入
├── 范围: LLM 行为约束 (advisory)
├── 时机: 会话开始时
└── 状态: ⚠️ 依赖 LLM 合规性

Layer 5: 环境隔离 (buildHostEnv)
├── OCTOPUS_HOST_PID 注入到子进程
├── OCTOPUS_HOST_PORTS 注入到子进程
├── OCTOPUS_DB_PATH 从子环境移除
└── 状态: ✅ 工作
```

### 数据流链路

```
Engine.executeNode(node)
  │
  ├─ callbacks.onBeforeNode(nodeId, type, nodeDef)
  │    └─ DetectorPipeline Proxy → ProcessConflictDetector.observe(script)
  │         └─ regex match → DiagnosisReport → StrategyEngine → delegation
  │              └─ block_node → {action: "skip"} → engine skips node
  │
  ├─ executor.execute()
  │    ├─ BashExecutor: substituteVars → prependWrapper → spawn("bash")
  │    ├─ AgentExecutor: runner.run(opts.onBeforeToolCall)
  │    │    └─ provider.sendQuery(opts)
  │    │         └─ canUseTool(toolName, input)
  │    │              └─ options.onBeforeToolCall(toolName, input)
  │    │                   └─ DetectorPipeline Proxy → DangerousPatternMatcher
  │    │                        └─ match → {allow: false, reason}
  │    │                             └─ SDK denies tool → model sees guidance
  │    └─ PythonExecutor: substituteVars → spawn("python3")
  │
  └─ callbacks.onNodeEnd(nodeId, status, result)
```

## 根因分析: Agent 工具拦截失效

### 问题
Agent 节点执行 `kill -9 $OCTOPUS_HOST_PID` 或 `nc -z localhost 3001` 时:
- `onBeforeToolCall` hook 正确触发
- `DangerousPatternMatcher` 正确匹配
- 返回 `{allow: false, reason: "..."}`
- **但工具仍然执行了**

### 根因
`packages/providers/src/claude/provider.ts` 设置了:
```typescript
permissionMode: 'bypassPermissions'
allowDangerouslySkipPermissions: true
```

Claude Agent SDK 的 `bypassPermissions` 模式会绕过**所有**权限检查:
- `PreToolUse` hook 的 `permissionDecision: 'deny'` → 被忽略
- `canUseTool` callback → 不被调用

### 修复
移除 `permissionMode: 'bypassPermissions'`，让 `canUseTool` 成为唯一授权门控:
```typescript
// canUseTool 始终活跃
const canUseTool = async (toolName, input, cbOptions) => {
  // 1. Harness tool interceptor
  if (options?.onBeforeToolCall) {
    const decision = await options.onBeforeToolCall(toolName, input)
    if (decision?.allow === false) return { behavior: 'deny', message: decision.reason }
  }
  // 2. Interaction controls
  // 3. Default allow
  return { behavior: 'allow', toolUseID: cbOptions.toolUseID }
}
```

## 测试验证

### Test 1: 静态扫描 ✅
- `kill -9 $OCTOPUS_HOST_PID` 在 bash YAML 中
- ProcessConflictDetector 匹配 → delegation → block_node
- 节点被 skip, 脚本不执行

### Test 2: Agent 工具拦截 ✅ (修复后)
- Agent 被要求执行 `kill -0 $OCTOPUS_HOST_PID` 和 `kill -9 $OCTOPUS_HOST_PID`
- canUseTool 调用 onBeforeToolCall → pid_conflict 匹配 → deny
- 两个命令都被阻止, 宿主进程存活
- Agent 输出: "Both commands were blocked by the harness tool interceptor"

### Test 3: Port 冲突拦截 ✅ (修复后)
- Agent 被要求执行 `nc -z localhost 3001`
- canUseTool → port_conflict 匹配 → deny
- 命令被阻止, Agent 理解并报告

## 已知缺陷 (待改进)

### 1. Bash 节点运行时绕过
变量替换后的脚本不做二次扫描:
```bash
# YAML: kill $vars.target_pid → 静态扫描看到 "kill $vars.target_pid"
# 运行时: kill 12345 → 不检查
```
**修复方向**: BashExecutor 中增加 `onBeforeScriptExecution` callback

### 2. Bash Wrapper 可绕过
```bash
/bin/kill 1234      # 绝对路径绕过 alias
command kill 1234   # command builtin 跳过 alias
\kill 1234          # 转义绕过 alias
```
**修复方向**: 使用 shell function 而非 alias, 或 BASH_FUNC_kill%% 环境变量

### 3. Python 无运行时保护
PythonExecutor 没有 prependWrapper 等效机制。
`getattr(os, 'kill')(int(os.environ['OCTOPUS_HOST_PID']))` 绕过静态扫描。
**修复方向**: 添加 Python wrapper (monkey-patch os.kill)

### 4. Regex 可被编码绕过
```bash
echo a2lsbCAxMjM0 | base64 -d | bash  # "kill 1234"
CMD="ki"; CMD+="ll"; $CMD 1234        # 变量拼接
```
**修复方向**: AST 分析或 syscall 级拦截 (seatbelt/bubblewrap)

### 5. seatbelt/bubblewrap 未实现
`IsolationConfig.sandbox` 字段已定义但未实现:
- `"auto"` / `"seatbelt"` (macOS) / `"bubblewrap"` (Linux) 配置存在
- 无任何 profile 文件或运行时代码

## 文件变更

| 文件 | 变更 | 原因 |
|------|------|------|
| `packages/providers/src/claude/provider.ts` | 移除 bypassPermissions, canUseTool 始终活跃 | 核心修复 |
| `packages/server/.../detector-pipeline.test.ts` | 修复 onBeforeRetry context arg 断言 | 测试修复 |

## 测试 Workflow

已创建 5 个测试 workflow 在 `test-harness-2` 工作空间:
1. `intercept-test-1-static-scan.yaml` — 静态扫描验证
2. `intercept-test-2-agent-tool.yaml` — Agent 工具拦截
3. `intercept-test-3-hook-verify.yaml` — Hook 链路验证
4. `intercept-test-4-hook-debug.yaml` — canUseTool 调试
5. `intercept-test-5-kill-host.yaml` — 核心场景: kill host PID
6. `harness-intercept-audit.yaml` — 完整审计矩阵
