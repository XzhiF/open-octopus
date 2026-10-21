# Octopus Desktop — v8

**基于 v1 的收口版。** v1 的信息密度、业务边界和 Codex-quiet 气质最接近 Octopus；v8 不换路线，修的是可用性。

1. **窗口默认铺满**：每个场景首次打开按主窗 + 辅助窗铺满画布。
2. **字号**：正文 13 → 15.3px，整体约放大 18%。
3. **整理桌面**：底部常驻「整理桌面」，按主窗 + 辅助窗自动排布；`⌥⇧T`。
4. **八向 resize**：上/下/左/右 + 四角都能拖。
5. **切换更清楚**：左侧 rail 分成 **Workspaces / Apps**；底部是 **Windows 任务条**。
6. **明亮模式重做**：白底 + 中性纸色 + 铜色强调。
7. **去掉 macOS 红黄绿**：顶部左侧只保留 Octopus 品牌。

## Open it

- <http://localhost:4173/prototype/desktop-v8/index.html>
- `pnpm dev` → <http://localhost:3000/prototype/desktop-v8/index.html>

## 桌面模型

```text
top bar      scene · current Workspace · command palette · status
left rail    WORKSPACES（项目工作区）+ APPS（场景）
canvas       floating windows
bottom       WINDOWS（窗口任务条）+ 整理桌面 + 全部窗口
```

### Workspaces

rail 顶部是**项目工作区**，不是自定义窗口组合：

- `feat-desktop-shell` / `research-scout` / `main` 是当前 open-octopus 下的 workspace / worktree。
- 点一次直接进入对应 workspace。
- `⌘1 / ⌘2 / ⌘3` 直接切换 Workspace；当前 workspace 也显示在顶部 chip 和 breadcrumb。
- 每个 workspace 的窗口布局、标签页状态分开持久化。

### Task / Workspace / Run

- **Task**：可验收的工作项；Task 详情里直接 `Open workspace`。
- **Workspace**：worktree / 执行环境；同一 workspace 可以有多条 Run。
- **Run**：一次执行尝试；完整 graph / logs / cost / timeline 在 Workspace 的 run 现场。
- **Runs App**：跨 Task / Workspace 的全局索引，只做筛选、定位和跳转；点一行进入对应 Workspace 的对应 Run。
- Workspace 顶部有 `Task / Workspace / Run` 面包屑，Run 窗口顶部有该 workspace 的 run switcher。
- URL 约定：`workspace.html?space=feat-desktop-shell&run=e2e4`。

### Windows

- 底部每个 chip 显示**窗口标题**，不是 App 图标。
- 点击窗口 chip 只做聚焦 / 恢复；点击当前窗口不会最小化。
- 最小化仍走标题栏 `−`；关闭窗口后从命令面板恢复。
- rail 是「去哪」，底部是「当前开了什么」。

### 自动铺满 + 整理桌面

- 首次打开一个场景时，按 **主窗 + 辅助窗** 自动铺满画布；主窗占左侧 55%，右侧上下分辅助窗。
- 每个场景用 `data-primary="1"` 指定主窗。
- 2 个窗口：左右分；3 个：主窗左，右侧上下；4 个：2×2；更多：网格。
- 底部「整理桌面」或 `⌥⇧T` 随时重排；`Reset layout` 回到默认可见窗口组合并重新铺满。

### Resize

- 八个方向：`n/s/e/w/ne/nw/se/sw`。
- 左上拖动会同时改 `x/y/w/h`；右下只改宽高。
- 最小尺寸 240×150；拖动时内容不接收点击，松手后持久化。

## 默认布局

- **Home**：Today + main agent，自动 55/45 铺满。
- **Live runs / Inbox** 默认在底部任务条。
- **Tasks**：Task board + inspector。
- **Runs**：全局 Task / Workspace / Run index。
- **Workspace**：flow + run history + run inspector + terminal。
- **Agent**：sessions + chat + context。
- **Wiki**：full-height tree + article + curator。
- **Settings**：prefs + models + billing。

## Shortcuts

| Key | Action |
| --- | --- |
| `⌘K` / `Ctrl+K` | 命令面板 |
| `⌘⇧M` / `Ctrl+Shift+M` | Mission Control |
| `⌥⇧T` | 整理桌面 |
| `⌥T` | 等分平铺 |
| `⌘1 / ⌘2 / ⌘3` | 切换 Workspace |
| `⌥W` | 关闭当前窗口 |
| `⌥]` | 下一个窗口 |
| `Esc` | 关闭浮层 |

## State

- key：`octopus.desktop.v8.2.{space}.{page}` — 窗口几何 / 最小化 / 关闭状态
- tabs：`octopus.desktop.v8.2.{space}.tabs.{page}`
- active Workspace：`octopus.desktop.v8.space`
- `workspace.html?space=research-scout&run=e2f5` 会切换标题、branch、activity、Run switcher 和选中 Run。

## 边界

- 业务数据仍是假数据；workspace 切换只换上下文标签与布局。
- 任意跨 App 窗口组合仍未做（需要 window library / desk composer）。
- Wiki 目前是目录树；Tree / Table 双视图可以下一步加。
- 仍是浏览器原型；窗口模型可平移到 Tauri/Electron。

## Files

- `index.html` — 各场景的窗口内容。
- `assets/app.js` — shell、Workspaces、窗口管理器、任务条、整理算法、八向 resize、palette、mission、持久化。
- `assets/app.css` — v1 视觉 + v8 字号 / rail / 任务条 / 明亮模式 / resize 覆盖。
