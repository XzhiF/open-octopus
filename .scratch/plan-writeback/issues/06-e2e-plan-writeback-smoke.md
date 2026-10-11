# 06: E2E 窄烟测 — 一次对话大改的全链路留痕

> Spec: `.scratch/plan-writeback/spec.md` Testing Decisions 之 S5；harness 先例：taskboard v2 五流（串行 workers）

**What to build:** 一条端到端流证明"确认闸 → 回写 → 可见趋势"在人前真实发生：待验收任务开对话 → 抛一句结构性大改 → doer 回预览（spec diff + 票草稿）→ 人回"确认" → 产物页签「需求票面」出现新票、「规格文档」的 spec 预览尾部出现「变更记录」行。UI 细节不设断言（沿 v2 纪律）。

**Blocked by:** 02, 03, 04, 05。

**Status:** done

- [x] 新流程文件入 taskboard e2e 套件，`--workers=1` 串行口径下绿（复用既有脚本）
- [x] 断言链：预览消息出现 → 确认后 home 侧盘文件含变更记录行与新票 → 产物页签 DOM 可见两者；全程无 doer 直写 ws 批次的成功路径（04 闸生效旁证）
- [x] 既有五流回归不翻红（本票合跑一次全量）
- [x] 失败诊断口径：若 LLM 行为漂移致预览形态不稳，按"重言断言降级为存在性断言"处理并留注，不硬编码回复全文

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-06@c4a03d0d；流⑥单跑 2.8m、六流 workers=1 串跑 6 passed/11.2m；无需 AC4 降级；环境偏差：isolated dev(3306/3307) 替代 --port 口径系 tbv2Env 库名硬约所迫；旁证发现：分支库拷贝缺 ntu.cost_usd 列属本机迁移面，留终审后汇报）。2026-10-10。
