# 10: 右栏 token 账浮层 — 待执行控制台

> Spec: 同 07 追加裁决轮；原型 ⓬ railReady 账台（用户三轮打回定稿：浮层不推挤、三出口）

**What to build:** ready 控制台右栏「⚡ 触发」上方一枚常驻角标 `tok <总量> · cache <命中率> · <成本> ▾ 展开`（Radix Popover，与草稿 SessionCostChip 同族）：点开 = 浮层盖界不推挤原布局，明细=输入/输出/缓存读/缓存写/总和/命中率/预估费用/按模型 +「完整台账 →」`target=_blank`；✕、再点角标、点外三出口关闭。数据 = `GET /api/sessions/:id/llm-calls`（id = source_chat_session_id）。

**Blocked by:** 07。

**Status:** done

- [x] 复用/抽取 SessionCostChip 的账本渲染（单源，不复制第二套明细 JSX；chip 现为 Popover 内联，可提出 ledger 内容组件共用），命中率显示即 ADR-0027 新口径
- [x] 无会话 id / 账本空（0 请求）→ 角标不渲染（仿 chip 短路纪律），不出现空壳
- [x] 「完整台账」新标签（target=_blank rel=noopener，本分支 1e842875 同款）
- [x] 展开不影响右栏布局（组件测试断言触发钮位置不变或快照；浮层 portal 渲染）
- [x] 07–09 装配/回放/规格测试保持绿

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-10@1fa95475；✕ 收回未复刻=Radix 再点/点外/Esc 三出口预裁；挂位 DOM 序钉在 [data-rail-acts] 触发钮上方）。2026-10-10。
