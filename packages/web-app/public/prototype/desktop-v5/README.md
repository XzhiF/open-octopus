# Octopus Desktop — v5 原型 · NEXUS

**黑客帝国指挥甲板。** v4 的窗口几何 + v1 的快捷直达，换上一层 phosphor CRT 皮肤：
一切可见即可敲 —— 底栏常驻命令行是这版的一等公民。v1–v4 原型保留对照。

> There is no spoon. 没有「页面」，只有进程和窗口。

## 打开

- 直接：浏览器打开 `index.html`（首屏放 boot 启动动画，任意键跳过；`boot` 命令可重放）。
- 经 dev server：`pnpm dev` → <http://localhost:3000/prototype/desktop-v5/index.html>

## 桌面模型

```text
HUD 顶栏     会话页签(Space) · ⌘K 搜索 · 系统体征: t/s 吞吐 · RUN 数 · NEEDS-YOU 脉冲
左 rail      V1 快捷方式回归：⌥1-8 一键直达 8 个模块（比 v4 的 Launcher 快两步）
桌面         浮动窗口：拖拽 / 缩放 / 边缘吸附(左右半屏·上最大化·两角四分之一) / 最小化→shelf
底栏控制台    root@octopus:~$ 常驻命令行 + 最小化 shelf 芯片 + 时钟
agent        全局窗口，跨 space 存活（⌘J）
```

## 快捷方式（v4 丢掉的东西，全部找回）

| 键 | 动作 |
| --- | --- |
| `⌥1…8` | TODAY / TASKS / RUNS / AGENT / SCHED / WIKI / LIBRARY / SYSTEM |
| `` ` `` 或 `/` | 聚焦命令行（macOS 下 ⌥+数字会被合成成符号，所以 rail 用 `e.code` 判定） |
| `⌘K` / `Ctrl+K` | 命令面板：窗口 / 应用 / 任务 / space / 指令 / 兜底「ask main」 |
| `⌘J` | 主 Agent |
| `⌘⇧M` | Mission Control（跨 space 的全部 proc 卡片） |
| `⌥T` | 平铺当前 space |
| `⌥←/→` | 切 Space |
| `⌘W` / `⌘M` | 关聚焦窗口（只释放视图，run 继续流）/ 最小化到 shelf |
| `?` | 键位表 |
| `Esc` | 逐层退出浮层 |

## 控制台指令（都能真的改状态）

```text
new <标题>      建任务(QUEUED 泳道，看板实时多一张卡)
run <query>     匹配任务推入 EXECUTING + 打开 RUNS
ask <文本>      问主 Agent（打字机流式回答）
open/close <app> · goto <space> · tile · cascade · mission
theme green|amber|ice · rain on|off · scan on|off · boot · reset · help
↑/↓ 历史命令
```

## 三种荧光（都是深色，风格不同）

- **green** 默认：经典红药丸绿 +  katakana 数字雨
- **amber**：复古 CRT 甜橙（老终端机）
- **ice**：冷蓝（科技感更冷峻）

HUD 右端 ◉ 按钮循环切换，或 `theme amber`。数字雨 / 扫描线在 SYSTEM 窗口可单独关。

## 功能取舍（相对 v4）

| v4 | v5 | 理由 |
| --- | --- | --- |
| Launcher 应用网格 | **删** | rail(⌥N) + 控制台(open x) + ⌘K 三路直达，网格成了多余一层 |
| Dock 大图标条 | **删，缩成 shelf 芯片** | dock 的价值是"打开的窗口"，一行芯片足够，省 60px |
| Ask 按钮 | **删** | ⌘J / 控制台 `ask` 更快 |
| 通知面板 | **并入 NEEDS-YOU 脉冲 → INBOX 窗口** | 通知不该是浮层，是待办；Approve/Answer 就地闭环 |
| Today | 强化为 **VITALS**：sparkline + LED 进度 + live feed 滚动 | 一屏扫完系统状态 |
| Runs | 列表 + GRAPH/LOGS/COST 三签，**日志实时流 + 进度爬升** | 执行监控要"活" |
| 新增 INBOX 窗口 | `! NEEDS-YOU` 点击直达 | v1 的 parked-decisions 回归 |

## 活体细节（原型要演真）

- 启动 kernel boot log → fade 进入桌面
- 数字雨 canvas 实时渲染，跟着荧光色走
- RUNS 日志页签每 2.6s 追加新行、进度条爬、GRAPH 的 ◐ 节点同步
- TODAY 的 EVENT FEED 每 6s 滚入新事件
- HUD `t/s` token 吞吐跳数；NEEDS-YOU 琥珀色脉冲闪烁
- 命令行有历史(↑↓)与 scrollback(`▴` 展开；短输出只 toast 不遮挡桌面)
- 窗口聚焦时 0.3s glitch 抖动；标题栏带 `pts/N` 伪 tty

## 实现

- `index.html` — HUD / rail / 桌面层 / 控制台 / 三个浮层骨架
- `assets/app.css` — 三套荧光 token、CRT 扫描线+暗角、窗口 chrome、全部模块样式
- `assets/app.js` — 窗口管理器(space 隔离几何 + localStorage 持久化)、控制台解析、
  数字雨、boot、事件流；无依赖无构建
- 窗口 DOM 按 space 层作用域寻址（`winEl`），跨 space 同 id 不串台（smoke 修出的真 bug）

## 验证

Playwright smoke 15 项全过（boot→rail→看板→inspector→控制台 new/run/ask/theme→
⌘K 键盘导航→mission→shelf→space 切换→拖拽吸附→刷新保几何），零 pageerror。

## 接入真实数据时

- 窗口绑 resource id 不拥有 resource（同 v1 结论）；RUNS 日志接 SSE、看板接 /api/tasks、
  控制台指令直接映射 CLI/server 端点。
- `⌥N` 的 N 与真实路由表绑定即得 v1 级直达；命令行是唯一新契约，其余全是窗口内容替换。
