# 05: persona 劝退墙→确认闸 + 修复流纪律重写

> Spec: `.scratch/plan-writeback/spec.md` Implementation Decisions 之 S3；词表口径来自 01

**What to build:** 两条执行期 agent 的"计划观"翻新。task-doer：大改不再推走，而是**接住但先对齐** —— plan-before-code 两段式（判定大改 → 给出 spec 变更预览 + 新票草稿 → 人确认 → 经 REST 通道回写 → 才动代码；被否一字不动），persona 内嵌端点 curl 配方。task-fix：删除「修订重跑/打回二分」死引用；"反馈指向规格即改 spec + 开票"成正牌职责（写入走端点留痕）；本轮做不完 → ready-for-agent 票留档；超结构边界 → 范围变更票（ready-for-human）。**双份 persona（内嵌注册表 + core-pack 运行副本）逐字同步**（本仓已知的 fork 同步暗礁）。

**Blocked by:** 01（取词）、02 + 03（配方里的端点必须真实存在）。

**Status:** done

- [x] doer persona：身份边界"批次规格只读"改写为"计划文件仅经计划回写通道可写"；劝退节替换为 plan-before-code 确认闸流程（含预览物 = spec diff + 票草稿、被否不动）；含端点 curl 配方（batch/file/content/reason/source 逐字段示例）
- [x] task-fix YAML：头部注释与修复纪律中「修订重跑」「打回二分」字样清零；纪律改写为上述三出口；报告结构增「计划回写」节（列本轮改了哪些 spec/票、经何来源）；prompt 含同一 curl 配方
- [x] 内嵌 persona 与运行副本 diff 逐字一致（断言比对，先例：v2 双份同步教训）
- [x] 修复流 YAML validate 通过；契约测试绿（先例：task-fix 既有 .test.yaml），断言含"计划回写/范围变更票"词、不含"修订重跑"
- [x] doer 会话端到端抽测：一句大改指令 → 回复为预览形态（spec diff + 票草稿 + 请求确认），未产生代码改动与回写请求
- [x] 01–04 全部 AC 保持绿（回归）

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-05@1e8c8d36；AC5 按预案降级 persona 文本闸+零留痕测试注释在位；作者侧旧口径清扫 4 处：.claude SKILL/core-pack SKILL/core-pack persona/builtin-clones 内嵌；新增 plan-writeback-discipline 契约测试 136 行；终审追加记账：task-lifecycle-service.ts:99 注释改标（ADR-0018→0024 死引用）未入当时自述清单，系纯注释清扫、方向正确，评审裁决记账不返工）。2026-10-10。
