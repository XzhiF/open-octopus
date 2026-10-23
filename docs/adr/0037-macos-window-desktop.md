# 桌面壳 v1：macOS 式应用窗口 + 常驻对话桌面

## Context

ADR-0034 把 web 壳定为「左导轨 + 内容区 + 右作业坞」，ADR-0035 把 5 组详情升级为顶部常驻标签。两者都建立在「网页式布局」上：导航是一条常驻侧栏，详情是并列标签。owner 要求进一步桌面化：取消左导轨，左上 Octopus logo 变成 Apple 菜单式入口；对话永远作为最底层主界面；菜单打开的应用以浮动窗口呈现，带 macOS 左侧三色按钮；全局 header 承载打开的窗口图标、运行中的 agent 图标与窗口总览；总览用真实窗口缩略图。

硬约束：Electron 宿主仍是单个 BrowserWindow（ADR-0036），本轮不做 OS 级多窗口；现有应用页面内部不改；Vite SPA、`lib/app-navigation` 作用域、URL 路由继续复用。

## Decision

- **窗口 = 应用，单实例**。9 个应用（今日、任务看板、工作空间、Agent、知识中心、资源、系统调度、系统管理、设置）各一个窗口；再次打开只聚焦/恢复，不重置路由。
- **对话是桌面层**。`ConversationHome` 永远挂载在 stage 的 z=1，不进入窗口 z-order；窗口 z = order+2。桌面可被窗口遮挡，点击可见区域聚焦桌面。
- **详情在窗口内钻取**。`/workspaces/:id`、归档、运行观测、`/resources/:type/:name`、`/scheduler/jobs/:id` 由 `ownerView` 归属到对应应用窗口；窗口内始终挂载该应用列表视图（`basePath/baseSearch`），详情层覆盖其上，返回列表保留筛选/滚动。旧 `detail-tabs` 删除。
- **URL = 焦点目标的完整路由**（桌面 = `/`）。切换焦点一律 `replace`；窗口内导航 `push`；深链打开归属窗口；刷新从 localStorage 恢复窗口布局，URL 决定焦点；`popstate` 只切换焦点/路由，不重写历史。`/agent?tab=chat` 作为 query 级退役重定向在窗口层解析，避免先开 Agent 窗口再跳桌面。
- **每窗口独立 `AppNavigationScope`**：`active` 仅焦点窗口为真；桌面层在非焦点时 pinned `'/'` + `active:false`。全局快捷键（Cmd-K/S/F）由 M1 的 `useIsActiveRoute` 门禁，另加 capture 门禁兜底隐藏窗口；可见非焦点窗口不 `inert`（首击聚焦），最小化窗口 `display:none + inert`。
- **窗口 chrome**：36px 标题栏，左侧 macOS 顺序三色按钮（关闭/最小化/最大化），标题居中；1.5px pop 描边、`rounded-xl`、贴纸阴影；拖拽标题栏 + 八向缩放 + 双击最大化；最小 480×320，标题栏至少 160px 留在 stage 内；新窗口 24px 阶梯。
- **全局 header**：logo 菜单 → 打开的窗口图标（按 order，焦点高亮，最小化变暗+点）→ 运行中 agent（最新在最右）→ 最右窗口总览。菜单按工作/资产/系统分组，底部「关闭所有窗口」；<768 用 Sheet。
- **窗口总览**：对同一批已挂载窗口 DOM 做 `translate/scale`，桌面也算一格；最小化窗口暗显；格子点击聚焦/恢复；F3 / Ctrl+↑ 开关，Esc 关闭；<768 退化为底部面板。
- **运行中 agent**：`GET /api/agent/sessions/running` 读内存 `activeStreams`，org 过滤，返回 `{id,title,clone_name,session_type,started_at,stream_count}`；客户端 5s 轮询、页面隐藏时暂停。点击 = 选中会话 + 最小化全部窗口 + 聚焦桌面。
- **响应式**：≥1024 浮动；768–1023 强制最大化；<768 只渲染焦点窗口、菜单抽屉、header 图标横滚、总览底部面板。
- **持久化**：`localStorage['octopus.desktop.v1']` 存 9 个应用窗口的路由/几何/最小化/最大化/顺序/焦点；`dev`/`not-found` 不持久化。拖动落点后一次写入，250ms debounce。

## Considered Options

- **详情独立窗口**（每个详情一个窗口）：能并排对比，但 header 图标可达 17 个，偏离 macOS 应用模型；弃。需要并排时再引入「同应用新窗口」。
- **同应用多实例**：首版不做，避免窗口 key、路由归属和持久化复杂化。
- **底部 Dock**：header 已承担窗口切换，Dock 重复且挤压 stage；弃。
- **服务端持久化窗口布局**：单机桌面应用无此需求，localStorage 足够；弃。
- **截图式总览**：需要额外渲染库且状态滞后；直接用已挂载 DOM 做 CSS transform，零截图；采用。
- **继续保留左导轨/右作业坞**：与「对话为桌面、应用为窗口」的交互冲突；删除。

## Consequences

- 删除 `AppRail`、`WorkDock`、`nav-config`、`DetailTabBar`、`DetailTabsHost`、`ViewHost`、`detail-tabs` 及对应单测；E2E 外壳用例改为菜单/窗口语义。
- ADR-0034 的三栏壳布局与 ADR-0035 的顶部详情标签被本 ADR 取代；ADR-0035 的 Vite SPA/静态托管部分继续有效。
- `position: fixed` 的子组件（harness 浮动面板、Radix 对话框）仍相对视口。对话框作为全局遮罩可接受；harness 面板后续应改为窗口内 absolute 或明确为系统级浮层。
- 9 个应用首次打开后常驻内存（与旧 ViewHost 同量级）；关闭即卸载。
- 窗口总览缩放 Monaco/图表可能出现像素化（实时 DOM 缩放），接受。
- localStorage schema 带 version；未知应用 id 丢弃。焦点切换 `replace` 意味着跨窗口的纯焦点切换不产生历史项。
- 运行中 agent 只反映当前 server 进程的内存流；多实例部署时需另加聚合。
