# 06 — web: playbook 面板(主角)

## What to build
`acceptance/playbook-panel.tsx`:按原型 A′④ 还原 —— 黄头条主角卡、预算表、按票分节 items(操作/预期/反假跑)、✓✗⊘(后果条三色、✗/⊘ 必填原因框)、carryover 首段(上轮⊘/✗重列,「补验/再豁免」)、finePrint 折叠、coverage.missing 诚实条、degraded 注;勾选 debounce→saveChecks;checks 初值 GET 回填;SSE task_artifacts_update 不重拉勾选(本地权威)。

## Blocked by
05

## Status
pending

## Acceptance Criteria
- [ ] AC1: 渲染 payload → 步数/预算/carryover 正确;✗ 存在时 onFailCount>0 冒给父(供 disabled)
- [ ] AC2: 勾选 → 300ms 内 putHomeFile 一次(合批);刷新回填
- [ ] AC3: available:false → 降级卡 + 「配置命令」指引(不白屏)

## Verification Method
**type**: component test(vitest+jsdom,仿 acceptance-surface.test.tsx 的 fetch stub)。
