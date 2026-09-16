# 08 — web: 验货台 A′ 重构(布局+占比+单滚动)

## What to build
acceptance-surface.tsx:①②③④ 顺序入 mid(①RoundDiff 外层包「状态条↔内联展开」壳:一行聚合数字、点击展开原组件;②VerifyPanel 保留但日志拆滚动:尾 15 行内联+指向 verdict;③PreviewBar;④PlaybookPanel);右栏 360→240、删 summary 块+TaskAiUsageCard+fetchLLMCalls,新进度卡(走查/⊘→下轮/复检/预览四行)挂 `data-acceptance-col-summary`(兼容 e2e 三列断言);round-diff patch 与叙述 round-report 的 max-h-[420px] 内滚拆除;wsGone 等既有 disabled 逻辑迁到进度卡说明行。

## Blocked by
06, 07

## Status
done

## Acceptance Criteria
- [ ] AC1: 三列锚点 testid 仍可过;acceptance-surface.test.tsx 全绿(含断言更新)
- [ ] AC2: 渲染树内 overflow-y 容器 ≤2(mid 主滚 + 叙述文件列表),patch/verify/round-report 无嵌套滚 —— jsdom 样式断言 + 真栈目检截图
- [ ] AC3: 无 awaiting → 现有空态不回归

## Verification Method
**type**: component test + 手工目检(dev 栈,留 screenshot 至 e2e-screenshots/)。
