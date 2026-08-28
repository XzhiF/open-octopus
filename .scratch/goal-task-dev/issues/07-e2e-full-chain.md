# 07 — E2E:看板全链路真跑 + weekly 绊网

## What to build
端到端验收:从看板 API 建任务(模拟真实路径)→ WorkflowBox 数据链绑定 task-dev(含 max_turns 覆盖)→ 入队 → **真实无人值守执行**最小 goal 任务 → 四向交叉验证(API↔DB↔JSONL↔文件系统);headless /goal 探针脚本入库 weekly(版本漂移绊网,R1)。

## Blocked by
03, 04, 05, 06

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 全链路:POST task(goal=最小可判任务, ac 一条)→ PUT workflow_ref+input_values → confirm → schedule 执行 → 断言节点 completed、产物文件内容正确、DB 状态流转、JSONL 含 active_goal 证据链
- [ ] AC2: max_turns 覆盖路径:input_values.max_turns="5" → 物化 config 含该值 →(不真跑满)单测/断言证明 $inputs 解析
- [ ] AC3: weekly 绊网:`scripts/goal-realrun-probe.mjs` 纳入 pi-compat-check 同级 CI 面(或文档化的手动周报),跑 /goal 收敛+保险丝两探针
- [ ] AC4: 反假跑 R1-R8 全满足:真 CLI/真服务/前缀 E2E_TEST_GTD_/cleanup/证据文件落 .scratch/goal-task-dev/e2e-*
- [ ] AC5: 回归基线:server/engine 测试失败集与开工前一致(不新增)

## Verification Method
**Verification type**: Browser/API E2E + 真执行
**Verification steps**: 执行 e2e-scripts(03/05 复用),`pnpm test`(engine/server/shared 三套),截图:绑定表单显示 200、执行详情 active_goal 事件。
**Pass criteria**: 全 PASS 出 pipeline-report
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
