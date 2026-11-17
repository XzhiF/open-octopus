# 30 · 全舱 v20 落地（cockpit-v20 → `packages/web-app`）

> 对应设计真源：`29-cockpit-v20.md`（原型 `../cockpit-v20.html`，五轮反馈稿）。
> 本文只记录**落地后与原型/设计稿的差异**、**已知边界**与**验证口径**；
> 布局/状态/管线细节以 29 为准，这里不重复。
> 前序落地：`12-cockpit-implementation.md`（v12/v13 壳）、`26-ask-windows.md`（问答窗）。

## 0. 范围：v20 增量进既有壳，不另起模式

全舱（cockpit）仍是 `/cabin/:cabinId/cockpit` 唯一路由、`CockpitStateProvider`
唯一可变状态。v20 的八组能力按「既有组件增量 + 新面板/新组件」落地：

| v20 能力 | 落点 |
|---|---|
| 多作战 tab / 未读 / 立即激活 / 关闭重开 | `fleet/threads-model.ts`（纯派生）+ `chat/CockpitThreadTabs.tsx` + `CockpitChatHost` 双向会话同步 + `fx/CockpitBrief` 到达接线 |
| TUI 转录 gutter / 选项行 / 本地回执 | `ChatArea`（仅 `composerVariant='cockpit'` 加时间戳+角色符签列）+ `chat/CockpitChoices.tsx` + `chat/CockpitReceipts.tsx` |
| 收起停靠 / 边缘 grip / 加高 | `CockpitChatWindow`（docked 态 + `geometry.ts` 左/上缘反向联动 + 双击复位）+ `chat/CockpitDock.tsx` |
| 用户自开多窗口 + WINDOWS 条 | `chat/CockpitPopWindows.tsx`（每窗一个真 ChatPane，composer 内联）+ `chat/CockpitWinBar.tsx`；上限 5、共享 z 栈、聚焦不重建 DOM |
| 决断队列面板 | `panels/CockpitOpsPanel.tsx`（attention awaiting=person 真数据；消项卡 2.6s；入口=编队头 ◈ 决断红点） |
| SESSION LEDGER | `panels/CockpitLedgerPanel.tsx`（`getCabinUsage` 真账本：总览/四格/按模型/作战行→详情）；入口=舰桥 ¥ |
| 舱籍工作树只读查阅 | **新服务端只读路由** `GET /api/cabins/:id/repos/:name/tree|file` + `panels/CockpitWsPanel.tsx`；入口=HUD ⌗ 文件 / 项目面 ⌗ 工作区文件 |
| 详情文件 / 调试页签 | `face/CockpitJobFiles.tsx`（home-tree/home-content 真数据）+ `face/CockpitJobDebug.tsx`（复用 `DebugInspectorWindow` 新增 `inline` 档：统计+过滤单行）；classic 作业窗仍五页签（`WINDOW_TABS`） |
| 12 姿态连续动作 + 图鉴 + 粒子 | `crew/pose-model.ts`（资产单源 import 自 `docs/cabin-design/assets`，不复制）+ `crew/CockpitPoseSprite.tsx`（rAF ping-pong / 隐藏暂停 / reduced 静帧 / 双帧回退）+ `panels/CockpitPosesPanel.tsx` |
| 回传动画 / 随机跃迁 / 模拟弹层 | 编队行/决断卡 `is-arrived-*` + ◈ hex 环（flash nonce 交替重启动画）；`fx/CockpitWarpScheduler.tsx`（45–105s，PROD 常驻）；`fx/CockpitSim.tsx`（**仅 DEV+?demo=1**） |
| 键盘 | `CockpitShortcuts` 增 ⌥C 停靠 / ⌥D 当前线程调试 / ⌥←→ 切 tab；1–9 选项拍板在 `CockpitChoices` |

## 1. 与原型的关键差异（逐条有理由）

1. **真数据纪律沿用 design 12 #11**：原型全 mock；落地全部走真端点
   （fleet/attention/decisions/usage/home-tree/debug-turns/repos）。没有的不上假值：
   工作树树/读文件是**本轮新增的只读路由**（ff-only：只读不写，depth≤6 / 2000 条 /
   512KB / 出根 403，与 home-content 同守卫口径）。
2. **双模式同步不假造 relay**：真实舱主会话就是编排者 —— 「跟汐音说派单」由主会话
   agent 真派 delegation（新线程出现 = relay 事实），客户端只落**本地 overlay 回执**
   （`CockpitReceipts`，不写服务端转录）：直连发送 → 主对话「同步：您直接对「X」交代了…」；
   决断消项 → 主对话「✓ #handle 按「choice」交代下去」（监听真实
   `octopus:author-ask-answered`）。原型的主对话关键词 relay 在真实舱里是 agent 行为，
   客户端不重复代派。
3. **选项拍板走真实决策管线**：`CockpitChoices` 渲染 attention 决策信封的
   options/impact/REC，提交复用 `useAskSubmit`（票据 askId 唯一权威，409 幂等）；
   无信封的行（验收/审批/裁决）给「去处理 ▦」跳真实面，不假造选项。
   键盘 1–9 与渲染同一份 actions 顺序。
4. **模拟弹层不代答决断**：DEV 演示只 staggered 触发「演示」简报 + fx（design 12 #8
   纪律）；原型的「全部按 REC 自动收口」在真实舱是人的决断，演示不代答。
   自动回流 34s / 30% 连发、随机跃迁开关保留。
5. **弹出窗是真 ChatPane 不是转录快照**：窗内可直接回话（同一服务端管线）；
   每窗独立会话状态，`onTelemetry` 不上报（舰桥遥测只认主通讯台）。上限 5 与原型同。
6. **面板模态 z 域**：scrim 159 / panel 160，压住浮窗域（共享 nextZ 100+）与
   WINDOWS 条/dock(140)；Esc 走唯一层栈 priority 85（模块窗 80 之上、立绘设置 90 之下）。
   原型「HUD 永远压面板」在全舱不沿用：模态盖 HUD 是标准模态语义。
7. **简报落空白天空**：`.ck12-brief` 从右上改 left=编队宽+12 / top 78，宽
   min(340, scenePad-24) 保证右缘 ≤ 通讯台左缘-12；≤900 顶中 92vw（通知优先，10s 自隐）。
8. **姿态资产单源**：motion/sheet/pose 三套 PNG 直接 import 自
   `docs/cabin-design/assets`（vite 相对路径出 hash 资产）；静态 import 只进 URL，
   字节按需下载/解码（单激活 sheet ≈16MB，换 pose 释放）。GIF 预览不进 web-app。
9. **boot/typing/command 接线**：boot→salute（mood 映射）；流式等待→typing；
   新 delegation 出现→command 2.6s（`octopus:crew-pose` 事件）；验收 cheer 沿用
   chat-reactions；75s 打盹沿用既有 dormantMinutes prefs（不另造 75s）。
10. **classic 逐字不变**：ChatArea gutter 仅 cockpit 变体；作业窗页签 `WINDOW_TABS`
    五枚；DebugInspectorWindow `inline` 不传时 DOM 逐字不变；close-left 审计仍绿。

## 2. 本轮修掉的真实竞态（e2e 实测根因，非测试妥协）

1. **默认几何首帧量空**：arena 未布局（dev 冷启动 CSS 未到）时 `computeDefaultRect`
   返回 null，旧实现只试一帧 → rect 恒 null、窗零尺寸、tab/grip 全 hidden。
   改：rAF 持续重试直到量到（rect 落定 effect 自停）。
2. **窄 arena 把窗钉在最小宽**：首帧量到窄 arena（320 宽）后不再跟随布局。
   改：`ResizeObserver(#ck12-arena)` 在 `!userAdjusted` 期间跟随默认几何；
   用户拖/缩后交还控制权（与原型 applyGeo 仲裁同语义）。
3. **v12 自动落点收窗竞态**：首拍编队到手 select 默认 ref 会按设计收对话窗；
   e2e 先开窗后落点 → 窗被收。spec 改为等落点定下来再开窗（产品行为不变）。
4. **flash 动画重启**：同 key 连续回传 class 不变动画不重启 → `is-arrived-{nonce%2}`
   双 class 交替（hex 环同法）。

## 3. 已知边界（不是本轮要修的）

- 弹出窗每窗一个 ChatPane：5 窗 = 6 个 ChatPane 实例（SSE/订阅各自一份），
  与原型上限 5 的性能理由同源；再往上需要转录虚拟化，另立项。
- 工作树徽标（被改文件=作战名）取 changes 汇总里 commits>0 的前 6 个任务的
  round-diff(scope=task) 实物文件；拿不到就不画（不猜）。
- `tree` 路由跳 `.git/node_modules/dist/.next/target/__pycache__/.venv`；
  符号链接目录不跟随（readdir withFileTypes 只认真目录/真文件）。
- 本地回执 overlay 只展示最近 3 条（全量在 title），不持久化（刷新即清）——
  它是 UI 反馈层，不是账本。
- 整套 e2e 历史红仍在（auth.spec 等）；本轮验收只跑 cockpit-global + cockpit-v20。
- 服务端/ web-app `tsc --noEmit` 基线红（缺 @types/better-sqlite3 等历史问题），
  本轮新增代码 0 新增类型错误；门禁沿用 test/lint/build/e2e。

## 4. 验证口径

```bash
pnpm --filter @octopus/web-app test     # 204+ files / 1614 tests 全绿
pnpm --filter @octopus/web-app lint     # 0 error（31 历史 warning）
pnpm --filter @octopus/web-app build    # vite build ✓（36 张姿态资产出 hash）
pnpm --filter @octopus/server vitest run src/routes/__tests__ src/services/cabin
# backend 已在 3001；Vite 新鲜端口：
OCTOPUS_E2E_WEB_PORT=<port> pnpm --filter @octopus/web-app test:e2e cockpit-v20     # 9/9
OCTOPUS_E2E_WEB_PORT=<port> pnpm --filter @octopus/web-app test:e2e cockpit-global  # 11/11
```

新增锁：
- 单元：`fleet/__tests__/threads-model.test.ts`（线程派生/表情语义/可见性规则）、
  `state/__tests__/cockpit-v20-state.test.tsx`（tab/未读/回执封顶/窗上限/停靠/面板/flash）、
  `chat/__tests__/geometry-v20.test.ts`（左/上缘反向联动 + 级联夹回）。
- 服务端：`cabins-repos-routes.test.ts` 增 tree/file 两例（跳 node_modules、出根 403、
  目录 404、缺参 400、512KB 413、未绑定 404）。
- E2E `cockpit-v20.spec.ts` 9 例：tab 激活/⌥←→/关闭、停靠+grip 拖拽/双击复位、
  弹出窗+WINDOWS 条最小化/恢复/关闭、决断面板+LEDGER 四格、工作树绑项目→树→预览、
  详情文件+调试单行、12 卡图鉴+playPose+帧推进五采样、DEV 模拟单条/连发、
  900/390 无横溢+dock 在视口内；console audit 全绿。

## 5. 复现 / 再生

姿态资产再生沿用 29 §13（`_prekey/_sheets/_motion-v20.mjs`）；web-app 侧无需再生 ——
import 路径即单源。新增服务端路由无配置项（上限常量在 `routes/cabins.ts` 头部）。
