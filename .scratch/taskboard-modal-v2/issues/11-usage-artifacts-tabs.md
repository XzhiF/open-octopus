# 11: ⑩ 真机走查回补 — 消耗/产物页签 · 日志归位 · 中止归栏

**What to build:** 真机验收发现三处与原型（v4 定稿）不符 + 两个新页签，按原型回补：

1. **走查去内列 + 中止归栏**：待验收弹窗里「✓ 走查」页签内容区不再嵌「摘要+动作 / 验收进度」内列（AcceptanceSurface 自带右栏在壳内渲染路径剔除，独立验收台若仍有其它挂载点则不动）；「■ 中止」并入壳最右栏动作区、落「打回 · 写反馈」下方（复用既有任务级中止端点/确认流，不新增状态、不新增端点）。
2. **日志页签归位**：`tab==="console"` 现挂载 TaskAiUsageCard（错）。改为渲染绑定执行的工作区事件流：agent_events 时间正序（工具/编辑/成败/警告分类行 + ⚑ 人工干预粉色高亮行——票06 已把干预写入 agent_events），有既有 SSE 通道则实时追加、无则节流轮询；数据端点用既有 agent_events 读取面（先侦察再定，缺则补只读 GET）。
3. **▤ 消耗页签**：挂载既有 TaskAiUsageCard（总计瓷砖/按模型/分轮账本/⇕ 一键全展开，K/M 记数——基本现成），并补「按会话/节点」明细：每节点 usage 汇总逐行 + task-doer 对话单独一行（按 doer_session_id 归属，两账不混，ADR-0025 口径）；页签徽标显示任务成本。
4. **▣ 产物页签**：新增只读端点 `GET /api/tasks/:id/artifacts` 返回分组清单（需求票面 spec/issues、轮次报告 report、证据 evidence、验收台账 acceptance-ledger 文件、原型 prototype 目录），路径全部限定任务工作区/仓库内（复用既有 path guard 思路，禁止遍历出界），文件不存在 → 该组空数组优雅降级；UI 按组分列，行带 预览（最小实现：抽屉/对话框现读文本）与 复制路径。

页签装配（tab-assembly.ts 加 `usage`/`artifacts` 两 key，←/→ 循环含新页签）：
- running/paused/fixing：变更 · 节点 · 消耗 · 产物 · 控制台（fixing 保留 dock；默认页签不变）
- takeover：对话接管 · 变更 · 节点 · 消耗 · 产物 · 日志（默认对话）
- awaiting：对话 · 变更 · 走查 · 消耗 · 产物 · 日志（默认对话）；右栏动作 = 通过 → 打回 → 中止

参考：原型 `packages/web-app/public/prototype/taskboard-v2.html`（⑩ 定稿即真相源）、spec.md 页签装配表 + ⑩ 回补条目、tmp/tbm-v2-notes.md（环境与测试口径）。

**Blocked by:** 01–10（已并入 feat-taskboard-modal-v2）

**Status:** done

- [x] 待验收弹窗：走查内容区无「摘要+动作/验收进度」内列；右栏自上而下 = 通过/打回/■中止，中止走既有动作且确认后任务态正确
- [x] 日志页签不再出现「任务 AI 消耗」卡；渲染 agent_events 事件流且 ⚑ 干预行为粉色高亮行；执行中新事件 ≤10s 可见
- [x] 消耗页签：TaskAiUsageCard 三段齐（总计/按模型/分轮账本，K/M）+ 明细表逐节点行 + task-doer 单独行；无对话历史的任务不出现 doer 行
- [x] 产物端点：分组正确、路径守卫拒遍历（`..` 越界 400/403 级断言）、缺文件空组降级；API 测试覆盖各态
- [x] tab-assembly：三形态页签组合与循环顺序按上表；徽标计数（产物×N、成本$）正确；默认页签回归不变（待验收=对话、running=变更、fixing=节点）
- [x] web 单测：装配表/消耗明细模型聚合/事件流映射/产物模型 各锁行为；e2e 在既有 flow spec 补最小断言（待验收有消耗/产物页签 + 日志页签无「任务 AI 消耗」字样），起不了真机环境则标注未跑
- [x] 基线不放大：server 既有 44 fail / web 6 / shared 1 不变；engine 零改动；buildPathGuard 零放宽

> **终裁补记（2026-10-09 真机验收中）**：日志页签内旧 Phase/Report 叠面（发射门禁/R1 交付报告/轮次账本/盘上文件/大事报）用户裁决「这些不需要了」——整体撤场不另找落点，页签=纯事件流；双轴 review 七项已收口（373c8aac），叠面撤场为收口后追加票内动作。

> Tracker: `.scratch/taskboard-modal-v2/`（本地文件票）

> **终裁追加②（2026-10-09）**：待验收右栏不收「⧉ 复制整单」——决断面只留 通过/反馈打回/工作空间↗/中止 四钮；其余形态复制照旧（7b44132a）。
> **Closed**: 并入 feat-taskboard-modal-v2（票 commit abf952c9/c2a96e03；双轴 review 收口 373c8aac；终裁撤面 07160c3d；⑪复点三条+四色 102cee01；终裁追加②去复制 7b44132a；tip 3701f6db）。真机验收 2026-10-09 用户口头「验收过」；e2e 五流复跑含 flow-2 新四钮断言归 push 前收口轮。
