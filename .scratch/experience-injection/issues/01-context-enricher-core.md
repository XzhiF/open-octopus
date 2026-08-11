# 01 — ContextEnricher Core + DAO searchByScopes

## What to build
创建 ContextEnricher 服务 — 统一经验富化层。包含搜索策略、可见性规则、关键词检测、预算管理和格式化输出。同时扩展 EvolutionDAO 新增 searchByScopes 方法支持多 scope 搜索。

## Blocked by
None — can start immediately

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: `ContextEnricher` 类在 `packages/server/src/services/agent/context-enricher.ts`
- [ ] AC-2: `enrich()` 方法接受 `{scope, query, org, budget, forceSearch}` 参数
- [ ] AC-3: agent scope 实现关键词检测（触发词正则匹配）
- [ ] AC-4: harness/workflow scope 为 forceSearch=true（always-on）
- [ ] AC-5: 可见性规则：agent→[agent,global], harness→[harness,global], workflow→[workflow,global]
- [ ] AC-6: 格式化输出为结构化 markdown（日期 + 模式 + 决策 + 结果标记）
- [ ] AC-7: 预算截断：>budget 时减少条数（5→3→1）
- [ ] AC-8: `EvolutionDAO.searchByScopes(query, scopes[], limit)` 支持多 scope IN 查询
- [ ] AC-9: searchByScopes 有 FTS5 + LIKE fallback（wildcard 转义）
- [ ] AC-10: 无匹配时返回 `{segment: null, count: 0, tokensUsed: 0}`

## Verification Method
**Verification type**: unit test

```bash
pnpm --filter @octopus/server exec vitest run src/__tests__/context-enricher.test.ts
pnpm --filter @octopus/server exec vitest run src/__tests__/evolution-dao-v2.test.ts
```
