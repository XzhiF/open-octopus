# 06 — web: playbook 面板(主角)

## What to build
`acceptance/playbook-panel.tsx`:按原型 A′④ 还原 —— 黄头条主角卡、预算表、按票分节 items(操作/预期/反假跑)、✓✗⊘(后果条三色、✗/⊘ 必填原因框)、carryover 首段(上轮⊘/✗重列,「补验/再豁免」)、finePrint 折叠、coverage.missing 诚实条、degraded 注;勾选 debounce→saveChecks;checks 初值 GET 回填;SSE task_artifacts_update 不重拉勾选(本地权威)。

## Blocked by
05

## Status
done

## Acceptance Criteria
- [x] AC1: 渲染 payload → 步数/预算/carryover 正确;✗ 存在时 onFailCount>0 冒给父(供 disabled) —「T06 剧本渲染」「T09 决策闭环」+ java 靶 live(5 步/预算 7min 见截图)
- [x] AC2: 勾选 → 300ms 内 putHomeFile 一次(合批);刷新回填 —「T06 AC2 勾选合批写回/刷新回填」2 测;live:盘上 .md 跨刷新/重启回填 ✓2·⊘1
- [x] AC3: available:false → 降级卡 + 「配置命令」指引(不白屏) —「T06 AC3 降级」点名缺源 + 决策面在场

## Verification Method
**type**: component test(vitest+jsdom,仿 acceptance-surface.test.tsx 的 fetch stub)。
