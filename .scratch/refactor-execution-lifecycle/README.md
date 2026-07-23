# Refactor: Decompose ExecutionLifecycle God Class

- **Issue**: https://github.com/XzhiF/open-octopus/issues/27
- **Created**: 2026-07-23
- **Status**: Planned

## Quick Reference

| Phase | 做什么 | 风险 |
|-------|--------|------|
| 0 | 特征测试（锁定行为） | 低 |
| 1 | 接入 EngineFactory | 低 |
| 2 | 对齐+接入 EngineCallbacks | **高**（最复杂的提取） |
| 3 | 接入 HookExecutor | 中 |
| 4 | 接入 GitBranchManager | 低 |
| 5 | 接入 StateFileManager | 低 |
| 6 | 提取 ExecutionQueryService | 低 |
| 7 | 提取 ExecutionRunner | 中 |
| 8 | 最终清理 | 低 |
