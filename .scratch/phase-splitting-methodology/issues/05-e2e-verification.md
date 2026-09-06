# 05 — e2e-verification：真需求 dogfood 首航（新判据生效实证 + #51 AC6 补票）

## What to build
新方法论的首个真实应用：用户发令后（真 LLM 成本面单独授权，KD10），版本探针确认运行态已换新（票 05 Verification step 0），在看板发起 task-author 会话、由**用户投喂一个真多故事需求**（新建 `E2E_TEST_phase-split-dogfood`，不转正旧「全局 token 计费」草稿——其绑 `built-in/matt-dev-pipeline` v3 遗留流，届时 abort 清池），观察 author 按故事判据产出拆分卡（卡头风险行/功能票列且非 MVP 故事 ≥3/无预算列/交付物列可执行回答「验收时我看什么」）；走拆卡 gate → 逐 phase spec → ready gate 四项 → **首 phase 真机派发跑 matt-spec-dev**（衔接信道 prev_handoff_paths 注入 live 验证 = #51 AC6 真 LLM 全链补票面）。

## Blocked by
04（且需用户届时发令 + 投喂需求——Missing Trigger 防线：本票 status 保持 ready-for-agent 直至用户授权）

## Status
in-progress (判据面 AC1/AC2 PASS·真 LLM 首航成功；执行面 AC3 待用户续会话补写 phases 后走 ready/派发)

## Verification Result（2026-09-06 真机首航实录）
用户自建真 v4 任务「全局 token 计费」(`6c0db77d`)，task-author 会话真跑（provider session `348ab0b9`，真 LLM）。

**判据面 PASS（方法论首航成功）**：
- ✅ AC1 拆分卡四特征全中——卡头「最高风险=计费正确性 → phase1 MVP 切穿路径」、phase 名全是故事（「MVP：配好价格一次调用端到端算对钱」「一次调用都不会漏：聊天侧全路径记账」）、功能票列在（5/5/4）、无预算列、验收物可执行级。
- ✅ AC2 两段式预算被忠实执行——拆相轮 Q3/Q4 结构 grilling → 出卡 → 批准后才进 Q5/Q6 内容轮；无提前下钻。
- ✅ 批次产物全齐且干净：`.scratch/20260906/{billing-core-1,billing-coverage-2,billing-report-3}/` = 3 spec + 16 功能票 + 3 E2E 票，`file` 验为 UTF-8，spec.md 含 MVP 切穿最高风险段的 Problem Statement（Write 工具落盘不经 curl，故无乱码）。

**工程面揪出 4 根因（判据无责，均已修）**：
- RC1a UI 硬编码「来自 MoA」→ 按 format 条件渲染（v4=「拆相对话的全局决策·供验收参考」）。
- RC1b **P0 编码 bug**：mingw curl（`/mingw64/bin/curl`）内联 `-d '{中文}'` 经 Windows ANSI 936 码页转 GBK、server 按 UTF-8 解存成 `U+FFFD`——本会话同路径复现坐实。**修法**：SKILL/persona 全部 curl 配方改「Write body 到 ASCII 路径文件 → `--data-binary @file`」。**已把被乱码毁的 5 条 decisions 从 JSONL 原样恢复回写（version 7）**。
- RC2 agent **0 次写 phases**（全 session 仅 projects+decisions 两次 spec-field）→ 根因「批准前不做任何绑定」被读成「不写 phases」。SKILL/persona 明确「拆卡批准 → 立即写 phases 骨架，绑定只补 workflowRef/inputValues」。
- RC3 SpecPanel 产物区只读 artifacts.json（执行期产物），v4 起草产物落 .scratch 看不见 → 产物区改名「执行产物」+ 空态指向 Phase 绑定列；真正可见面（WorkflowBox 按 phases[] 渲染）随 RC2 修复自动亮。

**未竟（转后续）**：AC3（ready gate + 首 phase 真机派发 + handoff 回流）未跑——因 RC2 致 phases[] 空、用户转向问询会话止于此。用户在新 persona/SKILL 下续该会话补写 phases 后可继续；本轮判据面结论已足够支撑方法论定稿。

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
