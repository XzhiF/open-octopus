# 01 — server：prev_handoff_paths 自动注入（accepted→下 phase / 手动推进）

## What to build

v4 任务 phase i accepted（autoAdvance 或手动推进）开 i+1 首轮时，执行输入里自动带上全部已 accepted 前序 phase 的 `handoff.md` home 绝对路径（内置键 `prev_handoff_paths`，换行连接，存在性过滤，空则不注入键）。与 `feedback`/`task_artifacts_dir` 注入同族；`workflow_chain[0]` 持久化 ⇒ 崩溃 re-claim 可复现。同 phase 打回 rerun **不**注入。

落点：`packages/server/src/services/tasks/tasks-service.ts`
- `collectPrevHandoffPaths`：遍历 `index < target` 且最新 round 已 accepted 的 phase（复用既有判定源），`resolvePhaseSpecDir` → `join(specDir,'handoff.md')` → `fs.existsSync` 过滤
- 注入点 ×2：`acceptance()` accepted→`dispatchPhaseRound(nextPhaseIndex,1)`（~:2173）与手动推进（~:2356）
- 信封 phases[] 零触碰（K16）；`template-resolver.ts` 零改动

## Blocked by

None — can start immediately.

## Status

ready-for-agent

## Acceptance Criteria

- [ ] AC1: accept phase1（预置 phase1 handoff.md）→ 新 round chain input_values 含 `prev_handoff_paths`，值=phase1 `{specDir}/handoff.md` 绝对路径（四方：API↔DB↔fs）
- [ ] AC2: 前序 handoff.md 不存在 → 该路径被过滤；全空 → 键不出现
- [ ] AC3: 打回 rerun 不注入；多前序（phase3 开轮见 1+2 两行）按 index 升序
- [ ] AC4: 手动推进路径与 autoAdvance 路径行为一致
- [ ] AC5: v3 任务 / 首 phase 开轮完全不受影响（回归）

## Verification Method

**Verification type**: integration test（真 DB + 临时 home fs）

**Verification steps**:
```bash
pnpm --filter @octopus/server test            # 新用例全绿；基线 43 failed 不增加
```
用例挂既有 task 域测试家族（`dispatchPhaseRound` 同文件族），断言 materialized chain JSON。

**Pass criteria**: AC1–AC5 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
