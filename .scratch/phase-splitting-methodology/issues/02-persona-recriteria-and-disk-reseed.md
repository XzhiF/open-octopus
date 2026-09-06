# 02 — persona 两处同口径重写 + 盘上运行时态收口

## What to build
`packages/server/src/services/agent/builtin-clones.ts` task-author persona 两处旧口径按 KD1-KD3 同口径重写：**L108「拆 Phase」行**（现文案「预算：coding agent 约 1h，含复杂 E2E ≤1.5h；3~5 人天 ≈ 4~5 个 phase」）与**拆分确认 gate 段「票归属/预算」**字样（walk-through B3 实测第二处）。因 persona **盘上优先加载**且 clone-init skip-if-exists（B1：`~/.octopus/agent/built-in/task-author/persona.md` 现为 79 行 v3 遗物），本票还含运行时收口操作：删盘上 persona.md → rebuild server → 重启 :3001 → clone-init 重 seed → 断言盘上实文新口径。机制缺陷（内置分身盘上遗物不可升级）不修 server 代码，只记 spec R5 另案。

## Blocked by
None — can start immediately（与票 01 并行；两票措辞一致性由票 04 矩阵兜底）

## Status
done

## Acceptance Criteria
- [ ] AC1 源码 persona：旧口径（L108 预算句 + gate 段预算字样）清零，新判据（完整用户故事/MVP 首 slice/功能票 ≥3/MVP 豁免）在场，篇幅风格与邻段一致
- [ ] AC2 `pnpm --filter @octopus/server test` 无 persona 相关新增红；`persona-v3-instructions.test.ts` 三段相邻契约不误伤
- [ ] AC3 盘上收口链走通：删文件→重启→重 seed→`~/.octopus/agent/built-in/task-author/persona.md` 实文含「完整用户故事」

## Verification Method
**Verification type**: unit test + grep（盘上探针）

**Verification steps**:
1. `rg "1h，含复杂 E2E|≈1\.5h|3~5 ?人天|票归属/预算" packages/server/src/services/agent/builtin-clones.ts` → 零命中
2. `pnpm --filter @octopus/server test` → 基线 42 failed 不新增红（尤其 persona 相关文件）
3. 停 dev → `pnpm --filter @octopus/server build` → 重启 `pnpm dev` → 触发 clone-init（server 启动即跑）→ `rg "完整用户故事" ~/.octopus/agent/built-in/task-author/persona.md` → 命中；`wc -l` 对比 79 行遗物已换

**Pass criteria**: 三步全过
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Verification Result
- 源码 L108/L155 重写 + L141 示例换故事名（自查补刀：原「数据层/db-layer」= 新判据反面教材）；vitest persona/clone/builtin 定向 = 唯一红 clone-file-mgmt（TEST_DIR fixture 404 环境红属基线，断言对象「全栈开发助手」与本改无关）；全量 42/10 files = 基线
- 盘上收口：删 79 行 v3 遗物 → rebuild → :3001 --kill 重启 → 重 seed 80 行新版，`rg 完整用户故事` 命中 ×1、旧口径 0
