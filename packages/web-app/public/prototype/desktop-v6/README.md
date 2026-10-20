# Octopus Desktop — v6 原型

**v5 的骨架，安静的皮。**（r2：图标全部换成 24px 线性 SVG；任务看板改为一窗连贯（看板+右侧详情联动，
Approve/Reject 就地流转不再弹独立窗口）；右下角可见拖拽把手（悬停高亮）；正文整体加大半号。） 窗口几何、rail 快捷键（⌥1-8）、底栏常驻控制台、⌘K 面板、
Mission Control 全部保留；视觉从 Matrix 荧光换回克制中性 —— 参照 Codex 最新版的
语言：暖白纸面 / 中性深灰双主题、正文无衬线、等宽只留给数据与命令行、颜色只做状态。
v1–v5 原型保留对照。

## 相对 v5 的三处改动

1. **去激进**：数字雨、扫描线、glow、boot 启动动画、phosphor 配色全部移除；
   换成 light/dark 双主题（右上角 ☀/☾，或控制台 `theme light|dark`，选择持久化）。
   正文对比度、字号回到可读水平。
2. **Space 切换收进下拉**：顶部一排 tab 太突兀 —— 改为左上角 `open-octopus ▾` 按钮，
   点开菜单列全部桌面（含每个桌面的活窗口数），支持 Esc / 点击外部关闭；⌥←/→ 仍可直接切。
3. **控制台保留但降噪**：提示符从 `root@octopus:~$` 改为 `octopus ❯`；短输出只 toast
   不弹回显面板，多行/错误才展开 scrollback。

## 保留的交互骨架

```text
顶栏     octopus · 桌面下拉 · ⌘K 搜索 · 体征（t/s · RUN · NEEDS-YOU）· ☀/☾ · ?
左 rail  ⌥1-8 一键直达 TODAY/TASKS/RUNS/AGENT/SCHED/WIKI/LIBRARY/SYSTEM
桌面     浮动窗口：拖拽 · 缩放 · 边缘吸附 · 最小化→shelf（关 ≠ 停，数据活着）
底栏     命令行：new <标题> · run <任务> · ask <文本> · open <app> · goto <space>
         tile · cascade · theme light|dark · reset · help（↑↓ 历史）
```

## 模块

Today（体征卡+sparkline+live feed+NOW）· Tasks（四泳道看板 + 右侧联动详情：phases 时间线/验收清单/Run·Approve·Reject 就地流转，泳道挤压时可横滚）·
Runs（列表 + GRAPH/LOGS/COST，日志实时流、进度爬升）· Main Agent（全局，打字机回复）·
Scheduler · Wiki · Library · System（主题/布局/关于）· Inbox（NEEDS-YOU 就地闭环）。

## 实现与验证

- `index.html` 骨架 · `assets/app.css` 全部视觉（双主题 token）· `assets/app.js` 窗口管理 + 控制台 + 数据
- 窗口 DOM 按 space 层作用域寻址，跨桌面同 id 不串台（v5 smoke 修出的教训）
- Playwright smoke 11 项全过、零 pageerror：桌面下拉切换/Esc/外点关闭、rail 快捷键、
  看板→Inspector、控制台 new/run/ask、theme 切换持久化、⌘K、Mission、shelf、拖拽吸附、刷新保几何

## 接真实数据

同 v5 结论：窗口绑 resource id；Runs 日志接 SSE、看板接 /api/tasks、控制台指令映射 server 端点。
主题 token 已按语义命名（--panel/--accent/--ok/--warn…），移植到 web-app 时直接映射到现有 :root token 层。
