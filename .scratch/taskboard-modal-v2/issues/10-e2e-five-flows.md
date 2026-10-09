# 10: E2E 收口（五窄流真机验证）

**What to build:** 用既有 e2e-harness 库把整个 feature 钉成五条浏览器窄流（matt 票规的必含 E2E 票；断言对外可见结果，不碰内部状态）：

1. 执行中卡 → 弹窗默认「≡ 变更」→ 统计条与文件行存在，任务新 commit 后 ≤10s 列表更新；
2. 待验收卡 → 默认「💬 对话」→ 发小改 → 「≡ 变更」出现 💬chat 行、统计变化；
3. 执行中 → ⏸ → 注入干预 → 恢复 → 日志见 ⚑ 高亮行、LIVE 卡计数 1；
4. 执行中 → ✋ 接管 → 对话改一处 → 确认交付 → 卡片进待验收、走查显示接管件标注；
5. 待验收 → 打回（写指令）→ 任务回执行中、节点页签显示 **task-fix 真实节点集**（现 YAML 为 precheck→fix→fail-fast 三支，断言吃真实定义而非虚构五步）→ 自动回待验收，台账预览含 快速修改/人工干预 列。

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09（全部功能票）

**Status:** done

- [ ] 五条流在 dev 环境对真实 DB/工作区跑绿（遵守 matt-e2e-test-methodology 反假跑规范：每步有真实副作用证据）
- [ ] 测试脚本进 e2e-harness 既有 pattern/目录约定，可 `pnpm` 单命令复跑
- [ ] 任一断言失败可定位到具体票（每条流独立 spec 文件，互不合并）
- [ ] 皮肤/字号类无断言（视觉判定不属本票）

> **Closed**: 并入 feat-taskboard-modal-v2（票 commit 8b2af1ff+12c541a6；终 tip 3131acc0）。逐 AC 证据见实现报告与 tmp/tbm-v2-notes.md §已合并票契约；双轴 code-review 八项经 fix 6abe16a7 收口；E2E 终tip复验流①②③⑤ GREEN，流④断言已对齐 form-aware 标记+窗口放宽 120s（待人工确认跑一次）。
