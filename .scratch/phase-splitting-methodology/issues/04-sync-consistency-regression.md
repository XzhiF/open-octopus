# 04 — sync-builtin 生效 + 一致性矩阵 + 全量回归收口

## What to build
改造生效与不破坏证明：跑 `node scripts/sync-builtin.mjs` 并核对 task-author 落位 SKILL 实版；执行 spec「静态 grep 断言」全矩阵（逐源强制在场 + 操作三源旧口径清零 + `1\.5h` 行必含票语境机械规则）；跑全量回归五路（shared build / server test 基线 42 / web test 基线 3 files / simulate matt-spec-dev 5/5 / playwright 三 spec 14+1skip）；把本批改动按仓库纪律 commit（`feat(task-author): 拆 Phase 方法论换锚…` 进 `octopus-feat-v4-direct-create-ui`，更新 PR #57），`.scratch/index.md` 登记 #52。

## Blocked by
01、02、03（全部完成后）

## Status
done

## Acceptance Criteria
- [ ] AC1 落位断言：sync-builtin 后 task-author plugin 路径 SKILL `version: 3.4.0`（`rg "version: 3.4.0" <落位路径>` 命中，路径以脚本实测为准）
- [ ] AC2 一致性矩阵全绿：四文件（SKILL/源码 persona/盘上 persona/CONTEXT-MAP）各源「完整用户故事」必中；旧口径操作三源零命中；`rg "1\.5h" SKILL.md | rg -v "票"` 零命中；ADR 豁免人工核
- [ ] AC3 回归五路基线原样（42/3files/5-5/14+1skip/shared 绿）
- [ ] AC4 commit 落分支、index.md #52 登记、无越权改动（`git diff --stat` 只含 SKILL/builtin-clones.ts/CONTEXT-MAP/docs/adr/.scratch 本批物）

## Verification Method
**Verification type**: integration（脚本断言 + 回归套件）

**Verification steps**:
1. `node scripts/sync-builtin.mjs` → 成功退出；`rg -l "version: 3.4.0" ~/.octopus/agent/skills/task-author/`（或实测落位路径）命中
2. 逐条执行 spec.md §Verification Methods Detail「静态 grep 断言」三组，输出行数记录进本票 Verification Result
3. `pnpm --filter @octopus/shared build && pnpm --filter @octopus/server test` → 42 failed 基线不新增；`pnpm --filter @octopus/web-app test` → 3 files
4. `octopus workflow simulate packages/core-pack/workflows/matt-spec-dev.yaml` → 5/5
5. `cd packages/web-app && npx playwright test e2e/task-authoring-v4.spec.ts e2e/task-phase-acceptance.spec.ts e2e/task-phase-board.spec.ts` → 14 pass/1 skip
6. commit + push（PR #57 自动更新）

**Pass criteria**: 1-6 全绿且数字=基线
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason（禁假绿：任何环境红如实记录）

## Verification Result
- sync-builtin: skills 34 成功，落位 `~/.octopus/agent/skills/task-author/SKILL.md` version 3.4.0
- 矩阵：三操作源旧口径 0 命中/新判据逐源在场/1.5h 票语境规则 PASS；ADR 历史引述人工核过
- 回归：shared build ✓ / server 42 failed·10 files=基线 ✓ / web 6 failed·3 files（harness/knowledge/system-pages）=基线 ✓ / simulate 5/5 ✓ / PW 14 pass·1 skip ✓
