# 05 — e2e-verification：真需求 dogfood 首航（新判据生效实证 + #51 AC6 补票）

## What to build
新方法论的首个真实应用：用户发令后（真 LLM 成本面单独授权，KD10），版本探针确认运行态已换新（票 05 Verification step 0），在看板发起 task-author 会话、由**用户投喂一个真多故事需求**（新建 `E2E_TEST_phase-split-dogfood`，不转正旧「全局 token 计费」草稿——其绑 `built-in/matt-dev-pipeline` v3 遗留流，届时 abort 清池），观察 author 按故事判据产出拆分卡（卡头风险行/功能票列且非 MVP 故事 ≥3/无预算列/交付物列可执行回答「验收时我看什么」）；走拆卡 gate → 逐 phase spec → ready gate 四项 → **首 phase 真机派发跑 matt-spec-dev**（衔接信道 prev_handoff_paths 注入 live 验证 = #51 AC6 真 LLM 全链补票面）。

## Blocked by
04（且需用户届时发令 + 投喂需求——Missing Trigger 防线：本票 status 保持 ready-for-agent 直至用户授权）

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC0 版本探针：commit 后 rebuild+重启 :3001；盘上 persona.md 实文含「完整用户故事」；落位 SKILL version=3.4.0
- [ ] AC1 拆分卡四特征：风险行 / 功能票列（非 MVP 故事 ≥3）/ 无预算列 / 交付物列可执行级——用户目测确认
- [ ] AC2 拆相对话未下钻票内部（无表结构/API 字段级提问）；轮次未失控（超载 → author 主动走升级/砍范围话术）
- [ ] AC3 ready gate 四项全过后首 phase 真机派发成功，round-report/handoff.md 产物回流 home（= AC6 补票实证；若真 LLM 面环境不满足 → 如实 SKIP 并记录阻塞面，延续 #51 口径）

## Verification Method
**Verification type**: browser E2E + live manual checklist（真服务真 LLM，R1/R2/R6 全适用，禁 mock）

**Verification steps**:
0. `pnpm --filter @octopus/server build` → 重启 `pnpm dev` → `rg "完整用户故事" ~/.octopus/agent/built-in/task-author/persona.md` 命中 + 落位 SKILL `rg "version: 3.4.0"` 命中
1. 看板 :3000 新建 task-author 会话，用户投喂需求 → 按 spec §live 清单 2-3 执行并截图/摘卡进本票 Verification Result
2. 拆卡批准 → 逐 phase spec 齐 → `POST /api/tasks/$TASK_ID/ready` → 200；触发首 phase → 终态后批次目录含 handoff.md（home LIST 核对）
3. 验收：AC1-AC3 逐项勾；结束按用户决定 abort/归档

**Pass criteria**: AC0-AC3 全过（AC3 环境不满足 → 如实 SKIP 非假绿）
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
