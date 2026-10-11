# 07: 待执行三签态 — 页签装配 + 节点静态预览

> Spec: `.scratch/plan-writeback/spec.md` 追加裁决轮（原型 ⓬ @37844643，2026-10-10 用户真机定稿）

**What to build:** ready（待执行）任务打开控制台 = 三页签「💬 对话 · ▤ 规格 · ◆ 节点」，默认落节点；节点页不再"无节点"——显示**下一 phase 绑定流**的 YAML 顶层节点序列（如 matt-spec-dev 七节点），全 ○ 未开始、用时/成本 `—`，展开一行给"未执行 · 等待触发"占位。触发转 running 后自动回既有动态装配（变更·节点·消耗·产物·控制台），无缝衔接。

**Blocked by:** None（原型即真相源）。

**Status:** done

- [x] tab-assembly 装配表加 ready 行：keys=[chat,spec,nodes] 默认 nodes；新键 `spec` 的标签「▤ 规格」进 TAB_LABELS；cycleTab/键盘 ←/→ 兼容三签；**其余状态装配零变化**（回归既有装配测试）
- [x] 节点静态预览数据源 = 任务 task_spec 下一待执行 phase 的 workflowRef → 解析其 YAML nodes 声明序（复用既有 workflow 解析/读取通路，引擎零改动）；无执行行时全部渲染 ○；有执行行后走既有动态模型（判据=该 phase 是否已有 execution）
- [x] 右栏 ready 动作区保持现状（触发/回草稿/中止/复制），不改
- [x] 单测：装配表 ready 行钉死 + 静态节点行序/状态符断言（先例：tab-assembly 既有测试、nodes-model 测试）
- [x] 对话/规格两签本票先落**占位壳**（页签可点、内容"加载中"），08/09 各接真内容——装配先行防三票互相等

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-07@f4e4d750；占位壳 testid ready-chat-placeholder/ReadySpecPlaceholder 钉死 08/09 接入位；静态节点源=getBuiltInWorkflowDetail→home 回落，engine/server/shared 零改动）。2026-10-10。
