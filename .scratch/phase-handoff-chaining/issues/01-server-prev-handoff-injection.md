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

done

## Exploration

**Analog studied**: task-fix 打回路由的 `feedback_path`/`task_artifacts_dir` 注入（`acceptance()` rejected 分支 :2144-2155 合成 inputOverride → `dispatchPhaseRound` opts 参数落 chain[0]）——同族「server 合成内置键 → dispatchPhaseRound 持久化」模式；测试族 harness = `tasks-v4-acceptance.test.ts`（真 DB + tmp home + ExecutionService stub，chain JSON 直读 schedules.config）。

**判定源确认**：accepted 前序复用 `deriveView(row)` → `TaskPhaseView.status === 'accepted'`（deriveTaskView 是唯一真相，账本为真相；acceptance() 在 :2106 先插账本行再派发，故 helper 内部**重新 derive** 即天然含刚 accepted 的本 phase——AC1 的「phase1 自己的 handoff 也进列表」由此免费成立）。specDir 解析用已 import 的 `resolvePhaseSpecDir(envelope.config, index)`（票 06/04 同 mount），非新造。

**需改文件**（仅一个）：
- `packages/server/src/services/tasks/tasks-service.ts`：① 私有 `collectPrevHandoffPaths(taskId, targetPhaseIndex): string[]`（放 `phaseSpecDir` 旁）；② `dispatchPhaseRound` opts 增可选 `prevHandoffPaths?: string[]`，stepInputValues 与 feedback 同段 append `...(len ? { prev_handoff_paths: join("\n") } : {})`；③ 调用点 ×2：:2173（accepted→下 phase）、:2356（advancePhase）。
- 新测试文件 `packages/server/src/__tests__/tasks-v4-handoff-injection.test.ts`（挂既有家族旁，spec Verification 口径「挂既有 task 域测试文件旁」）。

**零触碰**：信封 phases[]（只读）、`template-resolver.ts`、DB schema、routes、v3 路径（acceptance/advance 的 v4 gate 原样挡死）。

**签名微偏离**：spec 伪码 `collectPrevHandoffPaths(spec, targetPhaseIndex)` 的 `spec` 参数落为 `taskId`——判定源 deriveView 需要 DAO 访问（executions join + acceptanceDAO），纯 spec 参数拿不到 accepted 态；行为契约（判定源复用/存在性过滤/升序/换行）不变。值形态按 spec「平台原生绝对路径」（`path.join`，Windows 反斜杠），区别于 task-fix `feedback_path` 的 posix 相对位（那是 ws 内位，本键是 home 绝对位——语义不同，各有先例）。

## Acceptance Criteria

- [x] AC1: accept phase1（预置 phase1 handoff.md）→ 新 round chain input_values 含 `prev_handoff_paths`，值=phase1 `{specDir}/handoff.md` 绝对路径（四方：API↔DB↔fs）
- [x] AC2: 前序 handoff.md 不存在 → 该路径被过滤；全空 → 键不出现
- [x] AC3: 打回 rerun 不注入；多前序（phase3 开轮见 1+2 两行）按 index 升序
- [x] AC4: 手动推进路径与 autoAdvance 路径行为一致
- [x] AC5: v3 任务 / 首 phase 开轮完全不受影响（回归）

## Verification Method

**Verification type**: integration test（真 DB + 临时 home fs）

**Verification steps**:
```bash
pnpm --filter @octopus/server test            # 新用例全绿；基线 43 failed 不增加
```
用例挂既有 task 域测试家族（`dispatchPhaseRound` 同文件族），断言 materialized chain JSON。

**Pass criteria**: AC1–AC5 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
