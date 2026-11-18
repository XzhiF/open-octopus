# 32 · 指挥舱 v21 高保真作战计划（生产实现 → 原型）

> 状态：**已执行（2026-11-17 → 11-18）**，执行记录见 §9 · 前置：`31-cockpit-v21.md`、原型 `../cockpit-v21.html`
> 目标：把 `/cabin/:cabinId/cockpit` 的生产实现拉到与原型**同视口逐像素可比**；未对齐项只能进 §7 差异登记。
> 已拍板（2026-11-17）：①A HUD 重做 · ②A 默认原型配色、保留换色 · ③A 座舱作用域恢复 UI 字体 · ④A 接入三张场景图 · ⑤A 底栏视觉并入通讯台 · ⑥A 固定样板舱验收。

---

## 0. 完成定义（DoD）

1. 固定样板舱（fixture，不入库）在 **1600×900 / 1200×800 / 900×700 / 560×740** 四档，与原型并排截图，肉眼无可指认的结构差。
2. 关键几何/样式由脚本断言（§8），误差 ≤2px；computed 颜色逐 token 相等。
3. 0 console error、0 失败请求、四档无横向滚动。
4. 剩余差异仅限 §7 登记（composer 架构、真数据源、classic 不改、返回入口等）。
5. 门禁全绿：vitest / lint / build / cockpit e2e。

## 1. 基线实测（本轮，1600×900）

| 面 | 原型 | 现实现 | 结论 |
|---|---|---|---|
| HUD | 指挥官徽 / 舱籍 / SCENE / model+[1M] / tok·ctx·cost / ♪◐✦；导航入口 0 | ←返回 / 品牌 / 4 统计 / 导航入口 6 | **重做** |
| 场景 | 3 张桥景 + crossfade + 视差 + 跃迁 | 场景图 0 张（仅 CSS 星空） | **接入** |
| 配色 | teal `#2EE6D6` / violet `#7B4DFF` 固定 | 当前舱 hyperion `#38BDF8` | **默认校准 + 迁移** |
| 字体 | UI=sans、TUI/数字=mono | 全站 mono | **作用域恢复** |
| 左栏 | 实心 hex + pct + 3px 条 | hex 已对；pct/条**已实现**（fixture 无 pct 才没画） | 夹具补齐 |
| tab | 名称完整 + 状态图标 + 未读 | 作业 tab 名称盒高 0（实测） | **修缺陷** |
| 通讯台底缘 | 844（视口−56） | 788，且与底栏有 57px 断层 | **⑤A 合并** |
| 右栏 | 浮在场景上 | 作业面文字从缝隙透出 | **层叠收口** |
| 右下钟 | 小钟 + 舰桥时间 | 无（只有空态中央大钟） | **补** |
| 状态条 | 无 | 草稿 banner 在 9 作业时仍显示 | **条件收口** |

已对齐、不要重做：左栏 198 / hex 44×50、立绘 444×666 右缘 658、通讯台左缘 636 深 22、右栏 chip 78、console `--cut` 与渐变、立绘静态帧源。

---

## 2. 工作分解

### 阶段 0 · 夹具与对照工具（0.5 天，估）

**产物**
- `docs/cabin-design/_fixture-v21.mjs`：播种固定舱（9 作业：3 workflow 在跑/2 待命/1 归档；1 条 task 带真实 `pct`；3 条 attention 覆盖 blocked/decide/accept；≥3 线程），跑完即删。
- `docs/cabin-design/_fidelity-v21.mjs`：同一脚本拉起原型（`file://`）与生产（`:3000`），四档截图 + rect/style 采样，输出 `shots-fidelity/{原型,生产}-{档}.png` 与 `diff.json`。
- 截图目录沿用 gitignore（`shots-v21/` 同级新增 `shots-fidelity/`，入库前确认忽略）。

**验收**：一条命令产出四档对照；diff.json 含 §8 全部断言。

---

### 阶段 1 · 舱面骨架：场景 / 字体 / 配色（P0）

#### 1.1 场景层（④A）
- 新增 `packages/web-app/components/cockpit/scene/CockpitScene.tsx`
  - `SCENES`：舰桥·日落 / 星空·巡航 / 星云·门（文件名、RA/DEC 逐字取自原型 `SCENES`）。
  - 双层 `<img>` crossfade `.9s`；仅当前场景立即加载，下一张 `requestIdleCallback` 预取。
  - 视差 ±12/8px（`prefers-reduced-motion` 关闭）；`#warp` 星流 1s 衰减。
  - 订阅 `useCockpitState().fx.jumpNonce`：每次 +1 切下一场景（自动跃迁与手动跃迁共用）。
- 新增 `packages/web-app/app/cockpit/scene.css`；`CockpitShell` 的 `.ck12-bg` 内接入 `<CockpitScene />`，保留 nebula/floor 叠加层。
- 场景点：通讯台 footer 右侧 3 枚 9×10 hex（§3.4.7），点击切场景；HUD SCENE pill 同步。
- 验收：首屏 scene img = 1；jump 后 src 变化且 crossfade；reduce 下无 transform；四档图片不变形（`object-fit: cover`）。

#### 1.2 字体作用域（③A）
- `app/cockpit/base.css`：`.ck12-app` 定义 `--ck12-ui`（-apple-system…PingFang）与 `--ck12-mono`（SF Mono…）。
- 组件分级：HUD / 左右栏 / 面板 / 按钮 / 标签 → UI；console 转录、时间戳、token/费用、读秒 → mono + `tabular-nums`。
- 逐组件按原型 §1.2 的字号/字重复核（原字号按 mono 调过，换 sans 后可能偏宽）。
- 验收：HUD/左栏 computed `fontFamily` 命中 Sans 栈；`.ck12-con-log` 命中 Mono 栈；数字 `font-variant-numeric: tabular-nums`。

#### 1.3 默认配色与迁移（②A）
- 新增 v21 语义 token（`--v21-teal/sky/violet/pink/gold/green/amber/red/ink/ink2/metal/indigo/glass/edge`），逐字取自原型 §1.1。
- `THEMES.terminal` 的值校准到原型（a=#2EE6D6、b=#7B4DFF、c=#F5C542）；其余 5 套保留。
- 一次性迁移：把现有 2 间舱的 `cockpit_prefs.theme` 写成 `terminal`（走服务端 PATCH；幂等、可回退）。
- 验收：默认舱 `--ck-a=#2EE6D6`；「更多 → 换色」仍能循环 6 套；迁移脚本重复执行无副作用。

---

### 阶段 2 · HUD 重做（①A，P0）

重写 `components/cockpit/shell/CockpitHud.tsx`，按原型 §3.7：

```
[HUD 54]
 指挥官 hex(32×36) + 名 + CMDR 行 │ 舱籍 chip(32) │ SCENE pill(居中)
 model chip(32) │ tok hex(24×27) │ ctx hex │ cost hex │ ♪ ◐ ✦ (32×36)
 最左：极简 ←（唯一保留的返回入口，进 §7）
```

- 数据来源全部复用现有真源（不新造接口）：
  - model / context / tokens ← `CockpitModelPopover` / `CockpitContextPopover` / `SessionCostChip`（与 `CockpitBridge` 同源，chat=null 显示「未就绪」）。
  - 本舱 ¥ ← `useCabinUsage(entryCabinId)`（30s 轮询，失败留上次值）。
  - 舱籍 / 项目数 ← `useCabinProjects`；点击打开 `CockpitProjectsPopover`。
  - SCENE ← 阶段 1.1 的场景状态；点击打开场景点。
  - ♪ = `prefs.sound`；◐ = 换色；✦ = 动作图鉴（`openPanel('poses')`）。
  - 指挥官徽：`CABIN_MAIN_IDENTITY` 或 org 名 + 稳定短号；拿不到显示「—」，不编造。
- **移除 HUD 现有 6 个导航入口**（全域 / 文件 / 动作 / 换色 / 跃迁 / 汐音）：前五已在右栏「更多」，跃迁在右栏常驻；「全域」并入舱籍 chip 的副动作。
- `CockpitBridge` 的 model/tok/ctx/cost/身份读数迁入 HUD；底栏只留 composer 与状态条（阶段 3），避免双份读数。
- 在场（`在场 · 30s`）从底栏移到右下钟副行，信息不丢（§7 登记为生产独有）。
- 验收：HUD 内导航入口 = 1（←）；读数项 = 5 组；HUD 高 54；fixture 下各 rect 与原型误差 ≤2px；chat=null 时显示「未就绪」不显示 0。

---

### 阶段 3 · 通讯台外壳 + 底栏合并（⑤A，P0）

#### 3.1 修 tab 名称压塌（缺陷）
- 复现（实测）：作业 tab 的 `.ck12-tab-name` `getBoundingClientRect().height = 0`，文字被 `overflow:hidden` 裁掉；去掉 ✕ 后仅 9px，仍小于 line-height 15.5。
- 改法：`CockpitThreadTabs` 内部按原型 `.ctab` 重排 —— ✕(14) / 状态表情 / 名称 / 未读 各自 `flex:none`，名称用 `min-width:0; line-height:1.4; height:auto` 且**不承担 overflow 裁切**；tab 高 26、斜切 6px、max-width 150；激活态 `linear-gradient(90deg, sky 30%, violet 30%)` + teal 边 + 12px 辉光。
- 验收：每个作业 tab 名称盒高 ≥12px；长标题 ellipsis；✕ 仍左置；1200/900 下名称按原型可读。

#### 3.2 头部与状态条
- 头按钮组按原型顺序：`←主对话 / ⚙调试 / ▦详情 / ⧉弹出 / ⌄收起 / ⌃全日志`（文字 chip 24px 高），✕ 左置保留。
- 状态条移回 console 内底部：`SCENE / POSE / CTX / MODEL / TUI SKIN` + 右侧场景点（模板 `--ck12` 值 teal）。

#### 3.3 底栏并入（⑤A）
- console 延伸到底栏上沿（约 845），composer 行改用 console 皮肤：同宽、同 `--cut`、`border-top: 1px rgba(46,230,214,.2)`、无黑断层；中间独立状态行移除（读数已进 HUD / console footer）。
- 保留跨树 composer portal（关窗/收起不丢输入）；≤900 的底部 sheet 同样贴合。
- 验收：`composer.top - console.bottom ≤ 8px`；两元素 computed 背景/边框同源；关窗后输入仍在。

---

### 阶段 4 · 左/右栏与周边（P1）

- **右栏层叠收口**：给 stage/arena 右侧留 `--railr + 10` 的内边距，作业面不再渲到右栏下方；chip / rmenu / fan 加 `--glass2` 背底与正确 z 序。验收：右栏区域截图无底层文字穿透。
- **左栏**：夹具补一条带 `pct` 的 task 行，确认百分比 + 3px 进度条按原型渲染；≤1240 图标栏补 5×5 状态点、脊线移到中线（对照 §3.1.4）。「全部 →」保持 §7 的就地展开并登记。
- **右下角时钟**：新增 `CockpitClock`（right 10 / bottom 10、`--cut`、16/800 绿 + 9 副行），副行显示「舰桥时间 · 全舱正常」+ 在场读数。空态中央大钟保留为 console 收起时的生产态（§7）。
- **状态条收口**：`CockpitStatusBanner` 在编队行 > 0 或 attention > 0 时不再显示草稿文案；只在真正无编队的草稿/初始化态提示。
- 验收：右栏无穿透；clock 常驻；9 作业草稿舱无 banner；task 行有计划进度。

---

### 阶段 5 · 四档断点与回归（P0）

- 按原型 §2.2 逐档收口：≤1320 右 hex 放大 / 隐藏 tok·SCENE 坐标；≤1240 左栏图标栏；≤900 左栏隐藏 + 底 sheet + 立绘缩小；≤560 再缩 + fan 换行。
- 运行 `_fidelity-v21.mjs`：四档 rect/style 断言全过；并排截图归档。
- e2e：
  - 新增 `e2e/tests/cockpit-v21-fidelity.spec.ts`（HUD 读数、tab 名称、场景切换、clock、底栏贴合）。
  - 修既有 `cockpit-v20.spec.ts`「线程 tab」失败（本轮已复现：切 tab 后 tab 消失；先确认是否被 tab 重写修复）。
- 门禁：`pnpm --filter @octopus/web-app test | lint | build` + `test:e2e`。

---

### 阶段 6 · 文档与差异登记

- 更新 `docs/cabin-design/design/31-cockpit-v21.md` §5 落地映射与 §7 差异登记：
  - HUD 唯一保留的返回入口；
  - composer 跨树 portal（底栏视觉并入但不搬进 console）；
  - 右下 time + 在场、空态中央大钟；
  - 左栏「全部 →」就地展开；
  - 6 套主题保留、默认 terminal；
  - 样板夹具与产线真数据的口径。
- 本文件在开工后改为「执行记录」，逐阶段勾选并补实测数字。

---

## 3. 文件清单（预计改动）

| 类型 | 文件 |
|---|---|
| 新增 | `components/cockpit/scene/CockpitScene.tsx` · `app/cockpit/scene.css` · `components/cockpit/shell/CockpitClock.tsx` · `e2e/tests/cockpit-v21-fidelity.spec.ts` · `docs/cabin-design/_fixture-v21.mjs` · `docs/cabin-design/_fidelity-v21.mjs` |
| 重写/大改 | `components/cockpit/shell/CockpitHud.tsx` · `components/cockpit/chat/CockpitThreadTabs.tsx` · `components/cockpit/shell/CockpitShell.tsx` |
| 中改 | `components/cockpit/chat/CockpitChatWindow.tsx` · `components/cockpit/rail/CockpitFleetRail.tsx` · `components/cockpit/rail/CockpitMenuRail.tsx` · `components/cockpit/bridge/CockpitBridge.tsx` · `components/cockpit/shell/CockpitStatusBanner*` |
| 样式 | `app/cockpit/base.css` · `chat.css` · `rail.css` · `rightrail.css` · `scene.css` |
| 数据/迁移 | `components/cabin/cockpit.ts`（THEMES/默认）· 一次性 theme 迁移脚本或 API 调用 |
| 文档 | `design/31-cockpit-v21.md` · 本文件 |

---

## 4. 关键断言（脚本化，§8 明细）

| # | 断言 | 期望（1600） |
|---|---|---|
| 1 | HUD 高 | 54 |
| 2 | HUD 导航入口数 | 1（←） |
| 3 | 场景 img 数（首屏） | 1，src 含 `scene-bridge` |
| 4 | 左栏宽 / hex 环 | 198 / 44×50 |
| 5 | 左栏 task 行 pct + bar | pct 文本 + bar 高 3 |
| 6 | 通讯台 rect | l=636 r=1500 t=66 |
| 7 | console.bottom ↔ composer.top | ≤8px |
| 8 | tab 名称盒高 | ≥12px |
| 9 | 右栏 chip 宽 | 78 |
| 10 | 右栏区域像素 | 无底层文字穿透 |
| 11 | 右下钟存在 | 是，right/bottom=10 |
| 12 | 草稿 banner（9 作业） | 不出现 |
| 13 | 字体 | UI=Sans，TUI=Mono，数字 tabular |
| 14 | 主色 | `--ck-a=#2EE6D6` |
| 15 | 四档 overflow | ≤0 |

---

## 5. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 字体换 sans 后文字变宽，挤压既有布局 | 中高 | 先只换字体跑四档截图；按原型字号逐类回调；必要时给 rail/按钮设固定宽 |
| 3.5MB/张场景图 | 首屏变慢 | 只加载当前 + idle 预取下一张；`decoding=async`；生产懒加载；移动端不预取 |
| HUD 入口迁移改变操作习惯 | 中 | 全部入口在「更多」可达；快捷键不变；HUD 保留 ← |
| 老舱 theme 一次性覆盖 | 低 | 迁移幂等、可再换回；迁移前打印将改动的舱 |
| 右栏 z 序与浮窗/问答窗冲突 | 中 | 保持 design 31 §7 的 z=160 约定；新增背板不改层级 |
| tab 重构影响未读/关闭/快捷键 | 中 | 保留 `data-testid` 与 `aria-selected`；补单测与 e2e |

---

## 6. 顺序与节奏（估）

1. 阶段 0（0.5 天）→ 2. 阶段 1（1.5 天）→ 3. 阶段 3.1（tab 缺陷，0.5 天）→ 4. 阶段 2（HUD，1 天）→ 5. 阶段 3.2/3.3（1 天）→ 6. 阶段 4（1 天）→ 7. 阶段 5（1 天）→ 8. 阶段 6（0.5 天）。
   先把「对照工具 + 场景/字体/配色」落地，再做 HUD 与通讯台，避免在错的底色上做细节。每个阶段结束跑一次 `_fidelity-v21.mjs`，只允许断言前移，不允许「先记着」。

## 7. 差异登记（本轮预计保留）

| 项 | 原型 | 实现 | 理由 |
|---|---|---|---|
| composer | console 内 | 底栏跨树 portal，视觉并入 | 关窗/收起不丢输入（31 §7 已定） |
| 返回入口 | 无 | HUD 最左极简 ← | 应用需要退出舱 |
| 数据 | mock | 真端点；无值「未就绪/—」 | 真数据纪律 |
| 空态大钟 | 无 | console 收起时的中央 MISSION CLOCK | 生产桌面壳空态需要 |
| 在场读数 | 无 | 右下钟副行 | 保留 v13 能力 |
| 换色 | 无 | 「更多」内保留 6 套 | ②A 已拍板 |
| 左栏「全部 →」 | 打开编队面板 | 就地展开 | web-app 无独立编队面板 |
| classic | 不改 | 不改 | 硬约束 |

## 8. 附录：断言脚本输出格式

`_fidelity-v21.mjs` 输出：

```json
{
  "viewport": "1600x900",
  "prototype": { "hud": {...}, "fleetrail": {...}, "console": {...}, "tabNameH": 15 },
  "production": { "...": "同结构" },
  "diffs": [{ "key": "console.left", "proto": 636, "prod": 636, "delta": 0, "ok": true }]
}
```

未通过的项以 `ok:false` 汇总，退出码非 0；四档任一失败即阶段不通过。

---

## 9. 执行记录（2026-11-17 → 11-18）

### 9.1 完成项（阶段 0 → 6 拆解）

| 阶段 | 状态 | 落地 |
|---|---|---|
| 0 · 夹具与对照工具 | ✅ | `_fixture-v21.mjs`（9 作业；2 个 task-kind 写 v4 两 phase → 左栏有真 pct；task 作者进程 SIGTERM 后轮询 `agent_running=false` 再采样）· `_fidelity-v21.mjs`（四档截图 + 每次 30/28/20/20 项断言，`shots-fidelity/diff.json`，失败退出码 1） |
| 1 · 场景 / 字体 / 配色 | ✅ | `scene/scene-model.ts` + `scene/CockpitScene.tsx` + `app/cockpit/scene.css`；`state.travel()` 切幕；`THEMES.terminal` 校准 `#2EE6D6/#7B4DFF/#F5C542`；2 间存量舱已迁移（`_migrate-v21-theme.mjs --apply`，复跑幂等） |
| 2 · HUD 重做 | ✅ | `shell/CockpitHud.tsx` 重写：指挥官徽 / 舱籍 / SCENE pill / model / ▤tok / ◈ctx / ¥cost / ♪◐✦ / ⋯设置；导航入口只剩 ←；`CockpitBridge` 从底栏摘除（组件与单测保留，模型/上下文/用量读数改由 HUD 直读同一真源） |
| 3.1 · tab 名称压塌 | ✅ | 根因：通讯台 tab 复用了 `.ck12-tab`，与作业面页签（`face.css` 的 `flex-direction: column`）撞名。改名 `ck12-ctab*` 并按原型重排；名称盒高 15.5px（原 0/9） |
| 3.2 · 头部与底缘状态行 | ✅ | 头按钮改文字 chip（←主对话 / ⚙调试 / ▦详情 / ⧉弹出 / ⌄收起 / ⌃全日志）；新增 `chat/CockpitConsoleFooter.tsx`（SCENE/POSE/CTX/MODEL/TUI + 三枚场景点） |
| 3.3 · 底栏并入 | ✅ | 底栏总高 56（0 + 52 + 4）；通讯台底缘 = composer 条上沿（@1600×900 实测 844 = 原型）；composer 控制条在 cockpit 变体隐藏（读数已在 HUD），消除 14px 内部空隙 |
| 4 · 左右栏与周边 | ✅ | 作业面右让位 `--railr + 14`（右栏不再挡住页签点击）；右下 `CockpitClock`（right/bottom 10，≤900 隐藏）；9 作业时 draft banner 不再出现 |
| 5 · 四档 + 回归 | ✅ | 1600/1200/900/560 四档断言全过；新增 `e2e/tests/cockpit-v21-fidelity.spec.ts`（3 例）；既有 v20 全 9 例恢复全绿（含此前失败的「线程 tab」「全部决断」入口与新增的 fan 点击修复） |
| 6 · 文档 | ✅ | design 31 §3.7 / §5.9 / §5.10 / §7 与本文件更新 |

### 9.2 实测数字（2026-11-18）

- 四档断言：`1600×900 30/30` · `1200×800 28/28` · `900×700 20/20` · `560×740 20/20`，0 overflow。
- 关键几何（1600×900）：HUD 54 · 左栏 198 / hex 44×50 · 通讯台 636→1500 / top 66 / bottom 844 · 右栏 chip 78 · 时钟 right/bottom 10 · 底缘状态行 25px。
- 720p 级断点：1200 左栏 64（图标栏），与原型同档；900/560 走底部 sheet（生产 composer 独立，sheet 让出 66px）。
- tab 名称盒高：15.5px（原 0）；长标题 ellipsis 生效。

### 9.3 计划外修正（都写进了 31 §7）

1. **tab 撞名根因**：不是单纯的 flex 压缩，而是 `.ck12-tab` 与作业面页签同名。`face.css` 的 `flex-direction: column` 让通讯台 tab 变成竖排并把名称压到 0 高。改名即修。
2. **「更多」点击即收**：指针 `hover` 先开、`click` 又 toggle 关。改为 click 只开，收起走 `pointerleave`；既是 e2e 前置，也是真实鼠标行为。
3. **composer 控制条**：cockpit 变体本已不渲染，但窄屏下仍有内部 14px 空隙；确认为占位 slot 未挂载时的居中态。e2e/对照脚本统一量 `[data-testid="cockpit-command-bar"]` 的上沿。
4. **底缘 8px 浮动**：底栏高度随 composer 队列/草稿条变化，通讯台底缘跟随；对照断言对 bottom/height 放 ±10，其余 ±2。
5. **在场读数**：放进时钟 title，visible 副行保持原型文案，避免压住 composer。

### 9.4 门禁

- `vitest components/cockpit`：24 文件 / 222 例全绿（几何单测按新契约更新：1600 bottom 844、900 footerTop 620→top 228、560 footerTop 660→top 275）。
- `lint`：0 error（31 条既有 warning）。
- `build`：通过。
- e2e：`cockpit-v20` 9/9、`cockpit-v21-fidelity` 3/3、`cockpit-global` 相关用例通过。
- `_fidelity-v21.mjs`：四档 PASS。

### 9.5 二轮收口（2026-11-18 · 原型 A–E 反馈 → 生产）

原型二轮改完后重跑对照，生产同步改到「完全按原型」：

| 原型反馈 | 生产落地 |
|---|---|
| 输入框默认 1 行 | cockpit 变体 `AutoResizeTextarea minRows=1`；多行仍走 v13 草稿浮层（§7 登记） |
| 轮次下拉向下居中、跳转不动整页 | `ChatTimeline compact` 面板按按钮中心定位并夹在通讯台内；`jumpToTurn` 改容器内滚动，不再 `scrollIntoView` |
| 删右上模型切换 / 三枚只读读数 | HUD 只留 token / ctx / 费用（span，不可点）；模型切换进通讯台头部 MODEL |
| CTX / TOKEN 明细对齐 classic | 新增 `chat/CockpitConsoleTelemetry.tsx`：ContextUsagePanel + SessionCostLedger（`hideFooter`）单源复用 |
| 两套账本划清 | 通讯台下拉 = 本会话；`CockpitLedgerPanel` 改名「本舱账本 · 全域只读」并加说明条 |
| 设置弹窗（音效 / 主题 / 透明度 / 跃迁 / 回流） | 新增 `shell/CockpitSettings.tsx` + `settings-store`；`CockpitPrefs.winAlpha`（40–100%）写 `--ck12-winop`，全部舱系窗口跟随 |
| 更多 = 点击开合、图标放大、入口含设置 | `CockpitMenuRail` 去 hover 开合；7 项 = 汐音/动作/日志/文件/模拟/设置/编队；`fitem` 44px / hex 32×36 |
| 窗口/按钮/弹窗统一造型 | 新增 `app/cockpit/v21b.css`：窗口圆角去缺角去括线；图标钮六角（`--ck12-hex`）；文本钮平行四边形（`--ck12-btncut`）；✕ 一律左置无徽记 |
| 编队 / inbox 圆角 + 右栏六角拟物 | `fleetrail/flrow/ip-row/ipd-opt` 圆角；`rhex` 两层同色系（金属边 + 内面高光/内阴影/内圈辉光），去 2px 撞色描边 |
| 去多 tab / 底缘状态行 / 右下时间横条 | 删除 `CockpitThreadTabs` / `CockpitConsoleFooter` / `CockpitClock`；作战线程从编队 💬 进 |

二轮门禁：`vitest components/cockpit` 222 例全绿；`tsc` 改动文件 0 error；`eslint` 0 error；`vite build` 通过；
`_fidelity-v21.mjs` 四档 **37/37 · 35/35 · 29/29 · 29/29 PASS**（新增断言：遥测 3 芯片 / ≡N 轮 / tab 与时钟退役 /
窗口圆角无缺角 / 编队与行圆角 / rhex 外形投影 + 无撞色描边 + 内面 inset）。

**二轮新增 §7 差异**：① 多行输入仍走 v13 草稿浮层（生产把草稿浮成编辑层，原型原地长到 4 行）；
② 输入框上方「待你定」条占高（原型无此条，通讯台底缘随数据 ±16px 浮动）；
③ 设置里主题色 6 套（原型 3 枚示意）。

### 9.6 三轮收口（2026-11-18 · 用户逐项点名 → 生产）

用户在二轮验收后点名五处与原型不一致，按「完全按原型」重做：

| 反馈 | 生产落地 |
|---|---|
| 从编队点一条，要按原型出「编队详情」 | 作业面改为原型 `.panel` 玻璃 dossier：整屏 `.pscrim`（blur 3px + rgba(16,13,40,.4)）+ 居中 `min(760px,94vw)` 面板（top 58 / bottom 30）；头部 `.ph` = ✕ 左置 + 状态表情标题 +「项目 · 分支 · 编号」副行 + 右侧动作；页签改平行四边形 `.dtab`（24px）；概览改原型 kv（状态/进度/执行者/分支/用时/消耗 + 当前在做 + 最近事件 4 条） |
| 输入框、对话框都按原型 | composer + 「待你定」dock 搬进通讯台输入行（原型 `.con-in` / `.con-choices`）：❯(14px teal) + 36px 起高、最多 4 行、mono 12.5 的边框 textarea + 金色六角 ⏎(38×34)；删除屏幕底栏 `CockpitCommandBar` 与多行草稿浮层；placeholder 逐字用原型；通讯台默认展开；作者提问卡在舱内拉平成 `.vchoice` 语言（方角 + 左琥珀脊，选项行同款） |
| 左上方一大一小 | 退出舱的 ← 从「小 chip」退成极简箭号（无边框/无底色），左上只剩一枚指挥官徽（原型 .player） |
| 汐音背景多一层 | 撤掉 `.ck12-pod-vg` 矩形压暗层 —— 立绘脚下只有落地光环（原型 .character） |
| 左下「停靠展开」不对 | 停靠 pill 回到底部居中（`left:50%; bottom:10px`；有弹出窗 → 右下 12/52；≤900 右下 10），补绿点 `.dl`，文案与顺序同原型 `#conDock` |

伴随的契约调整：
- **首载不再自动选中** need 行：详情是「点编队行才开的模态 dossier」（原型一进舱是安静舰桥）；
  无效深链/作业被移出编队 → 收面并清参数，不再自动弹另一条。
- **选面不再收通讯台**（输入框在台里，收台等于把输入藏了）。
- 详情 Esc 优先级 60 → 65：盖过通讯台，低于问答窗 75 / 面板 85。
- z 序：dossier 201 / scrim 200 / HUD 210（原型 panel 40 < hud 50，抬头条在模态上仍可点）。

三轮门禁：`vitest components/cockpit` 221 例全绿；`_fidelity-v21.mjs` 四档 PASS
（1600 档 `console.b/h` 改为 ±2、新增 `composer.inside`；通讯台底缘不再随底栏浮动）；
`cockpit-v21-fidelity` 3/3、`cockpit-global` 全绿；e2e/单测同步更新。

**§7 差异追加**：① 作者提问卡的选项仍是当前应答管线的单选控件（radio），视觉按 `.vchoice` 拉平；
② 详情页签 7 个（原型多一个「项目」页签，生产用头部项目签 + 项目面承载）；
③ HUD ← 为生产独有（原型无退出舱入口）。
