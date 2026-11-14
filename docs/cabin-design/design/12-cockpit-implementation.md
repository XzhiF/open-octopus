# 12 · 全域座舱实现说明（cockpit-v12 → `packages/web-app`）

> 对应计划：`plans/cabin-cockpit-v12.md`（S1–S10）。
> 视觉真源：`../cockpit-v12.html`；设计稿：`11-global-mode.md`。
> 本文只记录**落地后与原型/设计稿的差异**、**已知边界**与**验证口径**；
> 数据来源与文件映射见 `11-global-mode.md` 的「实现状态 / 文件映射 / 数据来源」。

## 实现范围

| 项 | 状态 |
|---|---|
| 路由 `/cabin/:cabinId/cockpit`（`?job` / `?task` / `?attn` / `&cabin` / `&tab`） | 已落地 |
| 唯一状态所有者（selection / tab / chatWindow / fx / Esc 栈） | `CockpitStateProvider` |
| 跨舱编队（单一轮询、attention 合并、task 进度富化上限 12） | 已落地 |
| 左栏编队（舱筛选 / 四组 / ↑↓ / `⌥1` / ≤1120 抽屉） | 已落地 |
| 作业面五页签 + attention-only 面 + 跨舱只读 | 已落地 |
| 聊天：真 composer portal 到底栏、浮窗常驻、拖/缩/收/锁/透明 | 已落地 |
| 舰桥：模型 / 上下文 / token / 本舱 ¥ / 在场 | 已落地，缺数据显式「未就绪」 |
| 立绘 / 控制条 / 在场台词 | 已落地，台词不进 chat |
| 到达简报 / 四边流光 / 中心脉冲 / 星野 | 已落地，`prefers-reduced-motion` 全关 |
| 入口 / 出口 / origin / 快捷键 / 关闭在左 | 已落地 |
| 真数据 E2E / 响应式 / 性能 / 文档 | 本 Step |

## 与 v12 原型的差异（逐条有理由）

1. **关闭按钮在左**：原型 v12 在右；用户硬要求沿用 classic 窗口灯组，`✕ → — → 📌` 从 DOM 顺序到视觉都在左。
   单测 `components/cockpit/__tests__/close-left-audit.test.tsx` + E2E 的关闭审计共同锁住，不用 CSS `order` 伪装。
2. **没有自然语言切场景 / 换色 / 跃迁的 `interpret()`**：真实底栏就是聊天输入框，说话 = 发消息。
   场景切换只走按钮（全域编队 rail / `⛶ 全域` 标记）与快捷键（`⌥1 / ⌥2 / ⌥W / ⌘K`）。
   两套界面（classic / 全域）只靠 classic 右上角入口按钮与全域左上角「← 返回作战舱」互相切换。
3. **简报没有任何按钮**：原型/设计稿曾有「看全集」类入口；实现按用户口径只报信，10s 自动收，Esc 可提前收。
4. **模型是全局设置**：沿用 composer 的进程级 `octopus.composer.settings.v2`，不做舱级 / 作业级覆盖；
   舰桥 popover 明写「仅影响对话 · 全局设置」。这样桌面、旧舱、全域共用一份真源。
5. **跨舱只读**：面可以看别的舱的作业（`&cabin=` 记住归属），但「对接」的投递按钮只对入口舱出现，
   聊天始终绑入口舱主会话；不跨舱重绑。
6. **token / 成本是回合粒度**：`contextUsage` 流式期间实时变；`sessionUsage` 与 `getCabinUsage`
   在回合结束/30s 刷新。UI 文案写「回合结束更新」，不暗示边流边涨。
7. **运行窗 / YAML / 子代理窗挂在 `#ck12-layer-root`**（z-index 25），不嵌在聊天浮窗或 arena 的
   stacking context 里；运行页签只放摘要与「看运行 →」，复用既有 `octopus:open-run-window` 事件路径。
8. **`?demo=1` 仅 DEV**：`demoArrivalEnabled()` 在 PROD 构建下被静态摇掉；演示只 `fx` + 一张标注
   「演示」的简报，不伪造编队数据。生产没有演示入口。
9. **attention-only 面没有 deep-link CTA**：`finding:*` 等目前没有可深链的应用路由，只展示真实字段；
   只有 `task_id` 存在时才给「在对话里打开任务」（review 带 `view:'acceptance'`）。
10. **路由不是 `/global`**：采用 `/cabin/:cabinId/cockpit`，`cabinId` 是入口舱（决定聊天与返回），
    面显示哪条由 `?job/?task/?attn` 决定。这样深链可分享、返回路径唯一、桌面内进出来回不掉窗口。
11. **数字纪律**：非 task 行不再有原型里的假 45%；进度只对 v4 phaseViews 的 task 画。
    缺失一律「未就绪 / 无此数据 / 整段省略」，不写 0 或 `--`。
12. **浮窗几何**：默认值按 arena + `.ck12-scene` 的 `padding-left`（366 / 334 / 300）计算并夹回视口；
    `—` 收成 47px；`◍` 五档 94/82/70/55/100；ticker 收起后 rAF 补满一次。
    这些都取自 v12 源码，未改数值。
13. **底栏只有一行**（2026-11-14 用户口径）：舱主对话身份 `汐音舰长` 从 composer 控件条搬到
    舰桥（模型 / token 之后，只读）；`＋ 挂载` 并进输入行；`composerVariant='cockpit'` 下
    整条控件条不渲染。`ChatArea` 的默认（full）行为逐字不变。
14. **用户输入历史在浮窗里改成索引把手**（2026-11-14 用户口径）：`ChatTimeline` 增加
    `compact` 档，收起态是一个 `≡ N` 手柄，悬停展开原提示词列表。classic / 桌面仍是短杠竖排。
15. **作业概览按 v12 `.sgrid.jg-over` 两栏**：左「汐音 ↔ 作业」事件轨迹（点 / 时间 / 执行者 /
    类型 / 摘要，单行省略），右「作业状态」（状态 / 进度 / 耗时 / 消耗 / 优先 + 舱·执行者·分支·
    迭代 + 授权原文）。进度只来自 v4 `phaseViews`（`pctFromPhases`），缺进度 / 消耗时整段省略；
    ≤900px 折成一栏。合成 task 面（无作业账本）同版式：左摘要（目标 + AC），右状态 + 执行记录。
16. **按钮基线重置放进 Tailwind `base` 层**：原来未分层的 `.ck12-app button{padding:0}` 会连
    portal 进来的真 ChatPane / 任务模块窗的 Tailwind 样式一起抹掉（页签与 ＋ 挂载都变成零内边距）。
    分层后 `.ck12-*` 组件类（未分层）与工具类（utilities 层）都能正常盖过重置。

## 已知边界（不是本轮要修的）

- **整套 e2e 有历史红**：`e2e/tests/auth.spec.ts` 打 `/login`，本 SPA 没有登录页。
  Step 10 的验收只跑 `e2e/tests/cockpit-global.spec.ts`；不要用它判断整套 e2e 健康度。
- **`/round-diff` 在无轮时返回 409 是既有契约**，不是回归。E2E 的 console 过滤只对
  「确实收到 `/round-diff` 409 响应」放行，不吞其它 409。
- **模型 popover 没有关闭按钮**：它复用的是 `ComposerModelPopover`（无 `onOpenChange`），
  按 Radix 语义点外部 / Esc 收；其它三个关灯组（聊天浮窗、作业面、上下文、在场）都在左。
- **演示触发器只存在于 DEV**：`?demo=1` 在 `pnpm build` 的产物里不存在。
- **E2E 播种会创建真实 task/session**：`kind:'task'` 且 `ref_id` 省略时，服务端走生产派发路径创建
  任务与会话（`mandate.strength='inferred'` 让它停在确认路径），并会唤醒 task-author agent。
  fixture 只需要 job/task 行，所以 `e2e/helpers/cockpit-helpers.ts` 在播种后与清理时都用
  **唯一临时目录**（`<dir>/.task` 出现在 agent 命令行）精确匹配并 SIGTERM 该 fixture 的 agent，
  避免 LLM 消耗、真实会话写入与残留进程；随后删除整个临时舱并级联回收 DB 行。
- **主仓库默认 web 端口可能被旧 Vite 占着**：早于 `app/cockpit/` 创建的 Vite 进程可能对
  `./cockpit/index.css` 保留负缓存；重启即好，或另起新鲜 Vite 并设 `OCTOPUS_E2E_WEB_PORT`。

## 验证口径（Step 10）

```bash
pnpm --filter @octopus/web-app test            # 185 files / 1453 tests
pnpm --filter @octopus/web-app lint            # 0 error
pnpm --filter @octopus/web-app build           # vite build
# 后端已在 3001；Vite 新鲜：
OCTOPUS_E2E_WEB_PORT=<port> pnpm --filter @octopus/web-app test:e2e cockpit-global
```

新增 spec 覆盖：classic 与全域互不干扰（编队行仍开作业详情窗）、入口按钮 / 返回、深链落点、
无效深链回退、五页签非空、浮窗开合与拖/收/锁/透明、
关闭在左审计、换色、演示到达（0 按钮 + 10s + 流光）、1440/1280/1024/900 无横向溢出、
离开座舱后 rAF 停止、`prefers-reduced-motion` 不挂载流光。
**未覆盖**：真实发消息 / 流式 / 队列 / 停止（会调 LLM 并写真实会话；由既有单测覆盖）、
`?task` / `?attn` 深链的独立入口（需要历史舱合成行或无 job_id 的 attention 数据源；同一解析器由单测覆盖）。
