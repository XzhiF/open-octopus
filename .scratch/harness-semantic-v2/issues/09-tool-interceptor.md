# 09 — Tool Interceptor for Agent Nodes

## What to build
在 agent executor 中增加 tool call 拦截层，在 bash tool 执行前扫描命令，危险则 block + pause + 指导 + resume。

## Blocked by
01 — Shared Types + DB Migration
02 — Harness Agent Core-Pack Definition

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: agent executor 注册 `onBeforeToolCall` hook（或等效机制）
- [ ] AC2: hook 接收 tool name + input（bash command string）
- [ ] AC3: 复用 ProcessConflictDetector 的危险模式匹配（kill/pkill/端口绑定等）
- [ ] AC4: 匹配到危险模式 → block tool execution + 生成 DiagnosisReport
- [ ] AC5: block 后 pause agent session → 调 Harness Agent 生成指导 → 注入对话 → resume
- [ ] AC6: 安全命令正常放行（无性能影响）
- [ ] AC7: 单元测试覆盖：危险命令被拦截、安全命令放行

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
1. `pnpm --filter @octopus/server test -- tool-interceptor` — 单元测试通过
2. Mock agent session 验证: bash('kill $HOST_PID') → blocked + paused + guided
3. Mock agent session 验证: bash('echo hello') → allowed
4. 集成测试: agent 节点执行包含危险命令 → 验证拦截+指导+恢复流程

**Pass criteria**: 危险命令被拦截，安全命令放行，指导注入成功
