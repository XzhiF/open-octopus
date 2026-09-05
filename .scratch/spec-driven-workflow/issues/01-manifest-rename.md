# 01 — manifest 更名 + goal/ac 残留清理

Status: done

## What
`{home}/spec.json → manifest.json`（常量单源、writeManifestFile/writeManifestSnapshot、/context 字段 manifestContent/manifestPath+读回退、v4 快照 V3_ONLY_SPEC_KEYS 过滤、懒迁移[legacy 删除+rules stale-marker+rename]、context.md/rules/UI 三处文案、tasks-api/output-viewer、SKILL 7 处 + sync-builtin、server 4 测试文件 + e2e 3 文件）。

## Verification Method
- `npx vitest run task-home-service tasks-v3-routes tasks-v4-create tasks-home-file`（含新增 过滤/迁移/stale 用例）
- `npx vitest run components/tasks`（web）
- playwright `task-authoring-v4` ③ / `task-phase-acceptance` AC3 / `task-domain-draft-linkage` AC2
