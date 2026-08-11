# 06 — Dual Store Cleanup

## What to build
废弃文件存储路径，统一到 DB。删除 SubsystemAdapter.writeExperience()，清理 InitService 目录创建，将 searchExperiences() 委托给 EvolutionDAO。

## Blocked by
01 — Schema Migration (new DAO methods must exist before redirecting SubsystemAdapter)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: SubsystemAdapter.writeExperience() 方法已删除
- [ ] AC-2: SubsystemAdapter.searchExperiences() 委托给 EvolutionDAO.searchByScope()
- [ ] AC-3: InitService 不再创建 evolution/experiences/ 目录
- [ ] AC-4: AgentService.getExperiences() 使用新 DAO 方法
- [ ] AC-5: 所有引用 writeExperience 的代码已更新或删除
- [ ] AC-6: 现有 Agent 功能不受影响（experience 读写走 DB）

## Verification Method
**Verification type**: unit test + grep verification

**Verification steps**:
```bash
# 1. Verify no references to writeExperience remain
grep -rn "writeExperience" packages/server/src/ --include="*.ts"

# 2. Run affected tests
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/subsystem-adapter.test.ts

# 3. Verify AgentService experience listing
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/agent-service.test.ts
```

**Pass criteria**: All 6 ACs pass, grep returns no results for writeExperience
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
