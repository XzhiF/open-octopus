# 01 — Version Management Foundation (DB + Paths + Service)

## What to build
构建 Agent 版本管理的完整后端基础设施：DB schema migration (v32→v33)、filesystem paths 扩展、AgentVersionService 服务层、版本 API 路由。这是所有版本相关功能的基础。

## Blocked by
None — can start immediately.

## Status
done

## Acceptance Criteria
- [ ] AC1: `agent_versions` 表存在于 SQLite，含 id, agent_name, version, major, minor, patch, stage, status, snapshot(JSON), changelog, published_at, published_by, created_at
- [ ] AC2: `clones` 表新增 `current_version_id TEXT` 列
- [ ] AC3: `paths.ts` 新增 `getVersionsBaseDir()`, `getVersionDir(name, version)`, `getVersionPersonaPath(name, version)` 函数
- [ ] AC4: `AgentVersionService` 实现 publish(), list(), get(), diff(), rollback(), archive() 方法
- [ ] AC5: publish() 使用补偿事务模式（DB write + FS copy, FS 失败则 DB 回滚）
- [ ] AC6: rollback() 使用原子替换（temp dir → clone dir）
- [ ] AC7: `filesToSnapshot()` 和 `snapshotToFiles()` 双向转换函数
- [ ] AC8: snapshot 使用 `config.json` 格式（与 clone-resolver.ts 一致）
- [ ] AC9: 6 个 API 路由可用: GET versions, GET version/:version, POST versions, PATCH version/:version, POST rollback, GET diff
- [ ] AC10: 版本解析支持: "latest" → 最新 stable, 精确版本号, min_stage 过滤

## Verification Method
**Verification type**: integration test + DB assertion

**Verification steps**:
```bash
# 1. 启动 server, 检查 schema migration
sqlite3 ~/.octopus/db/octopus.db ".schema agent_versions"
# Expect: CREATE TABLE with all columns

# 2. 发布版本
curl -X POST http://localhost:3001/api/clones/workspace/versions \
  -H 'Content-Type: application/json' \
  -d '{"version":"1.0.0","stage":"stable","changelog":"Initial"}'
# Expect: 201 + version object

# 3. 检查双存储
ls ~/.octopus/agent/versions/workspace/1.0.0/
# Expect: persona.md, config.json, skills/

sqlite3 ~/.octopus/db/octopus.db \
  "SELECT version, stage, status FROM agent_versions WHERE agent_name='workspace'"
# Expect: 1.0.0 | stable | published

# 4. 回滚测试
curl -X POST http://localhost:3001/api/clones/workspace/versions/1.0.0/rollback
# Expect: 200 + {success: true}

# 5. diff 测试
curl "http://localhost:3001/api/clones/workspace/versions/diff?from=1.0.0&to=1.1.0"
# Expect: { persona_diff, config_diff, skills_diff }
```

**Pass criteria**: All 10 ACs pass, all curl commands return expected responses
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
