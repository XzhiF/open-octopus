# 06 — DB 迁移 + Harness API 路由

## What to build
数据库迁移（新表 + 新列）+ Harness REST API 路由 + harness-intervene 扩展。

## Blocked by
01 (shared types for config schema)

## Status
done

## Acceptance Criteria
- [x] AC1: `schema.sql` 新增 `harness_events` 和 `harness_config` 表
- [x] AC2: `schema.ts` 中 `ensureColumn` 为 `node_executions` 新增 `harness_status` + `harness_interventions` 列
- [x] AC3: `ensureColumn` 为 `node_token_usages` 新增 `source` 列 (DEFAULT 'node')
- [x] AC4: `GET /harness/config` 返回 YAML 配置内容
- [x] AC5: `PUT /harness/config` 验证 YAML + 保存 + 版本控制
- [x] AC6: `GET /harness/events/:execId` 返回 harness_events 列表（支持 type/severity 过滤）
- [x] AC7: `harness-intervene` API 扩展支持 `type: "inject"`，内部委托 RepairService.intervene()

## Verification Method
**Verification type**: integration test + API test

**Verification steps**:
1. 启动 dev → 验证 schema 迁移成功 → 验证新表/列存在
2. `curl GET /harness/config` → 返回默认 YAML
3. `curl PUT /harness/config` → 保存 → GET 返回更新内容
4. `curl POST harness-intervene { type: "inject" }` → 验证委托给 RepairService

**Pass criteria**: 迁移无错误 + API 返回正确响应
