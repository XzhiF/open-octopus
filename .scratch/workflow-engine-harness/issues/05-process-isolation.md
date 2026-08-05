# 05 — 进程隔离: Wrapper + 环境变量注入

## What to build
增强 BashExecutor 和 PythonExecutor 的进程隔离。Wrapper 拦截危险命令 + 环境变量注入。

## Blocked by
02 (engine callbacks for onBeforeNode)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: BashExecutor 注入 `OCTOPUS_HOST_PID` 和 `OCTOPUS_HOST_PORTS` 环境变量
- [ ] AC2: PythonExecutor 同样注入环境变量
- [ ] AC3: BashExecutor 在脚本前 prepend Wrapper (safe_kill/safe_taskkill 函数)
- [ ] AC4: PythonExecutor 修复进程组 kill (Unix: os.killpg, Windows: taskkill /T)
- [ ] AC5: 超时后 SIGTERM → 5s → SIGKILL 的强制 kill 链
- [ ] AC6: Wrapper 拦截成功时记录到 harness_events (type: "blocked")
- [ ] AC7: ProcessConflictDetector 静态扫描 + Wrapper 运行时拦截双层工作

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
1. 单元测试: 验证 Wrapper 脚本正确拦截 kill $OCTOPUS_HOST_PID
2. 集成测试: 创建包含 kill 命令的 workflow → 验证被阻断 + 宿主进程存活
3. 集成测试: PythonExecutor 超时后验证子进程树被完全杀死

**Pass criteria**: 宿主进程不被杀 + 子进程超时后被干净杀死
