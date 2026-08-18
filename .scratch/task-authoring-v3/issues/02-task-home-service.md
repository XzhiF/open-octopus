# 02 — TaskHomeService：任务家目录 + artifacts 索引

## What to build
每个 task 由 id 推出家目录 `~/.octopus/tasks/{task-id}/`：创建（skills/ + artifacts/）、删除/reap（**不跟随 junction/symlink**）、artifacts.json 读写（schema 校验；文件缺失→[]；内容损坏→[] + warn log）。这是产物「登记不搬迁」的地基（ADR-0011）。

## Blocked by
01 — shared 类型与 schema（ArtifactIndexEntry）

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `server/src/services/tasks/task-home-service.ts`：createHome(taskId) 建目录骨架；homePath(taskId) 纯函数推路径（不加 DB 字段）
- [ ] AC2: readArtifacts(taskId)：无文件→[]；合法 JSON→解析条目；损坏 JSON→[] + console.warn（SW-BP12）
- [ ] AC3: writeArtifactEntry(taskId, entry)：追加/按 path 去重更新；entry 经 ArtifactIndexEntry 校验，非法条目拒绝
- [ ] AC4: reapHome(taskId)：整目录删除；对 junction/symlink 只删链接不递归目标（SW-BP14）
- [ ] AC5: external=true 条目 path 必须绝对路径；external=false 必须相对（校验）

## Verification Method
**Verification type**: unit test

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/services/tasks/__tests__/task-home-service.test.ts
```
用 temp 目录注入（不改全局 ~/.octopus）：创建→readdir 断言骨架；写 3 条目→读回等值；写入 `{invalid`→readArtifacts===[] 且 warn 被调用；真实目录做 junction（Windows）/symlink（posix）后 reap → 断言链接消失 ∧ 目标目录仍在。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
