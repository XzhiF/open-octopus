# 31 · 指挥舱 v21 实现规格（cockpit-v21 → 全舱）

> 状态：**实现规格**（2026-11-17）· 原型真源：`../cockpit-v21.html`（自包含 HTML，CSS/JS 全内联，资产走相对路径）
> 前置：v20 已落地 `packages/web-app`（差异/边界见 `30-cockpit-v20-webapp.md`）。v21 仍是 `/cabin/:cabinId/cockpit` 唯一路由的增量稿，不新起模式、不动 classic。
> **高保真约束**：本文所有数值直接摘自原型 CSS。落地必须逐项对齐（尺寸 / 颜色 / 字体 / 裁切 / 断点 / 动效时长）。任何不得不偏离原型的项，只能出现在 §7「差异登记」，并写明理由与替代方案。
> 验证基准：`_verify-v21.mjs`（Playwright，1600×900 / 1200 / 900 / 560 四档，布局几何 + 交互 + 0 console 错误）；对照截图 `../shots-v21/01-desktop.png` … `12-narrow-560.png`（本地生成，不入库）。
> 高保真验收方法：实现页与原型页**同视口**并排截图 + 关键 rect/颜色用 `getBoundingClientRect()` / `getComputedStyle()` 采样比对（§6）。

---

## 0. 增量总览（v20 → v21）

| # | v21 能力 | 原型实现 | 落地落点（web-app） |
|---|---|---|---|
| 1 | 左栏编队改**单列 hex 卡**，按状态 + 创建时间排序，默认 6 行可展开 | `#fleetrail` / `renderFleetRail()` | `rail/CockpitFleetRail.tsx` 重写（数据仍走 `fleet/CockpitFleetProvider`） |
| 2 | 右栏**待办紧凑 chip** + 悬浮列表 + 就地回复卡（不跳线程） | `#inboxchip` / `#inboxPop` / `renderInbox()` | 新增 `rail/CockpitAttentionChip.tsx` + `rail/CockpitInboxPopover.tsx`（复用 `useAskSubmit`） |
| 3 | 右栏主按钮缩 1/4；**消耗 / 调试常驻**；「更多」向左横排展开 | `.rmenu` / `.rhex` / `.fanwrap` | 新增 `rail/CockpitMenuRail.tsx`（动作复用 panels/bridge 现有入口） |
| 4 | 主 chat **左移贴住立绘**（重叠 22px）并加宽 | `.console{left:calc(var(--railw) + 16px + var(--charw) - 22px)}` | `chat/CockpitChatWindow.tsx` + `chat/geometry.ts` 默认几何 |
| 5 | chat 皮肤统一到舱系：**深色终端屏**（压场景、可读） | `.console` / `.con-log` / `.cwin` 新皮肤 | `app/cockpit/chat.css`（纯皮肤，不改内容） |
| 6 | 关闭按钮**统一左置**（面板 / 窗口 / tab / inbox / banner） | `.phx`、tab `.cl`、`.ipx`、`.bx` 均首位 | 已有约定，v21 新增组件照做；e2e close-left 审计扩到新组件 |
| 7 | 回传 banner 移到**汐音头顶的空白天空**（不压 chat / 不压立绘） | `.banner{left:…+charw/2;top:58}` | `fx/CockpitBrief.tsx` 几何 |
| 8 | 开机**不再敬礼**，待命起步；`motion-sheet-idle` 用睁眼立绘重建 | boot 只 `setMood('idle')` | `crew/pose-model.ts` + `crew/CockpitPoseSprite.tsx`（boot 映射） |

---

## 1. 设计真源

### 1.1 颜色 token（逐字）

| token | 值 | 用途 |
|---|---|---|
| `--teal` | `#2EE6D6` | 系统 / live / 描边 / 光标 |
| `--sky` | `#35C7F0` | 信息 / 工具名 / 项目色（账务核心） |
| `--violet` | `#7B4DFF` | 分身 / 屏光 / 面板渐变 |
| `--pink` | `#FF5C8A` | 面板渐变第四段 / 进度条尾 |
| `--gold` | `#F5C542` | 用户提示符 / 拍板按钮 / TUI 选项 |
| `--green` | `#3DDC97` | 完成 / 验收通过 / 在线 |
| `--amber` | `#FFB020` | 等你 / 待你定 / 受阻外的高亮 |
| `--red` / `--dot` | `#FF3B5C` | 受阻 / 关闭 hover / 未读红点 |
| `--hazard` | `#FFB020` | inbox chip 主色 |
| `--ink` | `#EDEBFA` | 主文字 |
| `--ink2` | `#A9A3C8` | 次级文字 |
| `--metal` / `--metal2` | `#B9B3D9` / `#8D86B8` | 描边 / 微标签 |
| `--indigo` / `--indigo2` | `#100D28` / `#1B1638` | 底色 |
| `--glass` | `rgba(16,13,40,.46)` | 玻璃底 |
| `--glass2` | `rgba(20,16,48,.56)` | 面板玻璃 |
| `--edge` | `rgba(46,230,214,.38)` | 面板描边 |

项目色：账务核心 `#35C7F0` · API 网关 `#8B7CF6` · 风控引擎 `#FFB020` · 边缘节点 `#3DDC97`。

### 1.2 字体

- UI：`-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`
- Mono：`'SF Mono', 'JetBrains Mono', Menlo, Consolas, ui-monospace, monospace`
- 规则：**标签与正文用 UI 字体；TUI 转录、数字、读秒、token/费用一律 mono + `font-variant-numeric: tabular-nums`**。

### 1.3 形状

- 面板裁切 `--cut`：`polygon(14px 0,100% 0,100% calc(100% - 14px),calc(100% - 14px) 100%,0 100%,0 14px)`（左上、右下切角 14px）。
- 六边形 `--hex`：`polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)`。
- 小 chip 斜切：`polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%)`；更小件用 3–5px。

### 1.4 动效时长

| 动效 | 时长/曲线 |
|---|---|
| 转录行入场 `mi` | `.3s` ease，上移 6px |
| 回传行 `rowArr` | `1.2s` ease（accent 34% 底 + 右移 7px + 辉光衰减） |
| 决断卡 `cardArr` | `.9s` cubic-bezier(.2,.9,.3,1.25) |
| hex 环 `hexRing` | `1.2s` |
| 面板 `pin` | `.28s` cubic-bezier(.2,.8,.2,1) |
| banner 进出 | `.3s` |
| 跃迁 crossfade | `.9s`；`#warp` 星流 `1s` 衰减 |
| tab ping | `.9s` |
| inbox 回执 → 回列表 | 1400ms；全清后收起再等 700ms |

---

## 2. 布局几何

### 2.1 桌面（>1320）

```
┌ HUD 54px：玩家徽 | ⧉舱籍 | SCENE读数 | model[1M] | ▤tok | ◈ctx | ¥cost | ♪ ◐ ✦ ┐
│ 左 : .fleetrail  left 10  top 72  w 198  max-h calc(100vh-88)                  │
│ 立绘: left calc(198+16)=214  bottom 2vh  h 74vh  aspect 2/3                     │
│ 通讯台: left calc(198+16+charw-22)  right 100  top 66  bottom 56               │
│   └─ 与立绘重叠 22px（1600×900 时 charw=444 → console.left=636）                │
│ banner: left calc(198+16+charw/2)  top 58  w min(390, charw-54)                 │
│ 右 : rightrail right 10  top 64  bottom 58 → inboxchip(78) + rmenu(63×72)       │
│ 时钟 widget right 10 bottom 10                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

关键断言（1600×900）：`fleetrail` 宽 198；`console.left=636`；立绘右缘 658 → 重叠 22；`console.right` 到视口右缘 100；banner 中心 436、宽 390、右缘 631 < console.left 636。

### 2.2 断点（逐档，全部来自原型）

| 断点 | 变量 / 布局 |
|---|---|
| ≤1320 | `--railw:186 --railr:104 --charh:70vh`；右 hex 放大到 78×90（big 96×110，more 70×80）；隐藏 `.cur.tok`、SCENE 坐标 |
| ≤1240 | `--railw:64 --railr:104 --charh:66vh`；左栏收成图标栏（见 §3.1.4）；inboxchip 78；banner 副标题隐藏 || ≤900 | 左栏 `display:none`（入口留在「更多」）；立绘 `h 34vh; left 6; bottom calc(56vh+8)`；通讯台变底部 sheet：`left 52 right 92 bottom 10 height 56vh`；右栏 `top 58 right 6 bottom 10`，hex 56×64（big 68×78，more 50×56）；inboxchip 74；inbox 浮层 `right 86 top 56 max-h calc(100vh-120)`，回复卡态隐藏列表；banner 顶中 92vw；隐藏 sceneread/时钟/grip |
| ≤560 | 立绘 `h 32vh; bottom calc(52vh-10)`；通讯台 `left 46 right 80 height 52vh`；右栏 right 4，hex 48×55（big 58×66，more 44×50），inboxchip 64；inbox 浮层 `right 74 w min(340,88vw)`；fan 换行；footer 隐藏 POSE/MODEL；head 隐藏 ←主对话/⚙调试/⌃全日志；`.con-cur .line` 13.5/42 |

### 2.3 几何仲裁

- `applyGeo()` 写 inline `left/top/bottom`；`bottom` 必须分档：`full ? 10 : (innerWidth<=900 ? 10 : 56)`。**不得用桌面值覆盖移动端 media**（v20 踩过的根因）。
- 通讯台手动拖拽 clamp：`conLeft ∈ [320, W-360]`，`conTop ∈ [56, H-240]`；双击 grip 复位 `null`（回 CSS 默认几何）。
- 「全日志」`state.full`：`top 66 / bottom 10`；与收起互斥语义独立。
- z 序：窗口 31–36 < pscrim 38 < panel 40 < banner 45 < HUD 50 < WINDOWS 条 55。
- banner 右缘必须 ≤ 通讯台左缘：宽度上限即由此推导，不是装饰值。

---

## 3. 组件规格

### 3.1 左栏编队（`.fleetrail`）

**3.1.1 排序与行数**

- `STATUS_RANK = {blocked:0, wait:1, run:2, queue:3, done:4}`；同状态按 `born` **升序**（数值小=新→旧）。
- 默认 `LIMIT=6` 行；`fleetOpen=false`。超过 6 行时底部出「更多 `+N` ⌄ / 收起 ⌃」，切换只重渲染左栏，不动其它面。
- 顶部摘要：`在跑 n · 待命 n · 归档 n`（待命=queue）；`全部 →` 打开 v20 编队面板。

**3.1.2 卡片（`.flrow`，逐值）**

| 项 | 规格 |
|---|---|
| 容器 | `padding:6px 7px 7px 5px; margin-bottom:5px; gap:9px`；`--cut` 裁切；`background:linear-gradient(90deg,rgba(255,255,255,.055),rgba(255,255,255,.018))`；`border:1px solid rgba(185,179,217,.13)`；`border-left` 不单独画，靠 `::before` |
| hex 环 | `44×50`；`::before` `conic-gradient(from 90deg, var(--accent) calc(var(--p)*1%), rgba(185,179,217,.2) 0)`；`::after` `inset 2.5px` 内衬 `linear-gradient(160deg,rgba(255,255,255,.14),rgba(16,13,40,.82))` |
| 实心亮色字形 | `.flhg{inset:4px}` hex；`linear-gradient(160deg, color-mix(accent 92%,#fff), color-mix(accent 48%,#120f2b))`；`font-size:16px; font-weight:800; color:#fff` |
| 文案 | 标题 11.5/800 UI；进度 8.5 mono；状态 pill 7.5/800（clip 3px）；副行 8.5，`ellipsis` |
| 进度条 | 高 3px；`linear-gradient(90deg, accent, --pink)` + accent 辉光；done 行不画 |
| hover | `translateX(2px)` + accent 13% 底 + 45% 边框 |
| 选中（当前线程） | accent 24% 底 + 62% 边框 + 16px 辉光 + 左侧 2px accent 竖条（`::before`） |
| done | `opacity:.72`，无进度条 |
| 脊线 | `.fr-list::before`：`left:30px; width:1px; background:linear-gradient(180deg,rgba(46,230,214,.34),rgba(46,230,214,.04))` |

状态色：run 天蓝、wait 琥珀、blocked 红（脉冲）、done 绿；表情 `⚡ ❗ 💦 💤 ✅`；标签 `作战中 / 等你答 / 受阻 / 待命 / 已归档`。

**3.1.3 头部**

- `.fr-h`：`padding:8px 17px 7px 9px`；`25×29` hex 标（teal→sky，indigo 字）；标题 9.5/800、`letter-spacing:.14em`；数量 11 白；运行中绿点 5px 脉冲；`全部 →` 高 20、斜切 4px。
- `.fr-sub`：8.5 mono，`待命` 计 queue。

**3.1.4 ≤1240 图标栏**

- 宽 64；头部只留 `⬡ + 总数`；行内只显示 hex（`.flbody` 隐藏），右下 5×5 状态点（run 天蓝 / wait 琥珀 / blocked 红脉冲 / done 绿）；`更多` 只留 `+N`；脊线移到中线。

### 3.2 右栏待办（inbox）

**3.2.1 chip（`.inboxchip`）**

- 宽 78；`padding:7px 6px 6px`；`--cut`；`--glass2` + `blur(10px)`；边框 `rgba(255,176,32,.4)`。
- hex 图标 `30×34`（hazard→sun 渐变，indigo 字）；标题 9/800 白；右上计数 18px 圆标（hazard 底、indigo 字、10px 辉光）。
- 零待办：`.zero` 边框改 `rgba(185,179,217,.22)`，图标/角标转灰。
- 新回传 `ping` 动画 1s（外扩 16px）。

**3.2.2 浮层（`.inboxpop`）**

- 几何：`right:calc(var(--railr) - 6px); top:62px`；宽 378（回复卡态 764）；`max-height:calc(100vh - 126px)`；`--glass2` + `blur(16px) saturate(1.3)`；`--cut`；`0 22px 64px rgba(16,13,40,.62)`；入场 `popin .2s`。
- 列表头：高约 34；**✕ 在左**（22×24 hex）；标题「要我处理」9.5/800 .14em hazard；总数 11；右侧拆分 `待你定 n · 验收 n · 受阻 n` 8.5 mono。
- 分组：`待你定（amber）/ 待验收（green）/ 受阻（red）`，组头 8.5/800 .14em；空组不渲染。
- 行（`.ip-row`）：`padding:7px 8px`；两行：`[handle 类型签] 作业 short …… 回答 →/验收 →` + 问题单行省略；hover 7% 白底；选中 teal 2px 内左条 + 天蓝→紫 20%/14% 渐变。
- 回复卡（`.ipd`）：头 **✕ 再 ←**（均 22×24 hex）；kind 色签；正文=作业名 11.5/800 UI → ctx 10（左 2px accent 条）→ 问题 15/800 UI → 选项（`padding:7px 9px`，左 3px accent，`[n]` + 标签 11.5/800 + impact 9.5 + `REC` 金标）→ 自由输入（28px + 发送）→ 脚注；底部「稍后 / 提交回答」（26px，primary 金）。
- **交互**：点行在**列表左侧**开回复卡（两栏），不跳作战线程；提交走真实决策管线；答完回执 `✓ 已答 · choice`，1400ms 回列表；全清后 700ms 自动收起。
- Esc / 点击浮层外 / 点 chip 收起；打开面板时自动收起 inbox。

### 3.3 右栏主按钮（`.rmenu`）

- 常驻顺序：**下指令（big）→ 跃迁 → 消耗 → 调试 → 更多**；`gap:12px`，垂直居中。
- `.rhex` 63×72；`::before` hex `linear-gradient(160deg,rgba(53,199,240,.26),rgba(123,77,255,.3))`，`inset 0 0 0 2px var(--edge)`；hover `scale(1.06)` + teal 环 22px 辉光。
- big 76×88（暖橙→粉，hazard 边）；warp 紫→青；more 56×63（灰紫）。
- 文案 9.5/800 UI；图标 16。≤1320 放大到 78×90 / 96×110 / 70×80；≤900 → 56×64 / 68×78 / 50×56；≤560 → 48×55 / 58×66 / 44×50。
- 「更多」悬停/点击**向左横排**：`.fanwrap{right:calc(100%+8px)}`；`--glass2` + blur14 + `--cut`；项高 34、斜切 6px、hex 22×25；7 项（汐音 / 动作 / 日志 / 文件 / 模拟 / 换色 / 编队），stagger 24ms；离开延迟 240ms 收起。

### 3.4 通讯台（chat）——v21 重点

> 原则不变：**内容=TUI 语法，外壳只是皮肤**（同一消息在通讯台与独立窗口同步；classic 逐字不变）。v21 只重做外壳皮肤。

**3.4.1 外壳（新皮肤，逐值）**

```css
.console{
  background:
    radial-gradient(120% 80% at 82% 0%, rgba(123,77,255,.16), transparent 55%),
    linear-gradient(180deg, rgba(22,17,50,.80), rgba(11,8,26,.90) 38%, rgba(8,6,20,.92));
  backdrop-filter: blur(16px) saturate(1.2);
  border: 1px solid var(--edge);
  clip-path: var(--cut);
  box-shadow: 0 20px 60px rgba(16,13,40,.55), 0 0 30px rgba(46,230,214,.08),
              inset 0 1px 0 rgba(255,255,255,.08);
}
.console::before{ /* 顶线 2px，与面板同色 */}
  background: linear-gradient(90deg, var(--teal), var(--sky), var(--violet), var(--pink)); opacity:.8;
.console::after{ /* 扫描线 */ opacity:.05;
  background: repeating-linear-gradient(180deg, var(--teal) 0 1px, transparent 1px 4px); }
```

- 四角括线：`tl`/`br` 各 16×16、2px teal，opacity .8。
- 头部 `.con-h`：`9px 14px 7px`；底边 `rgba(46,230,214,.2)`；顶部青色 5.5% 洗光。
- 头部内容：hex 标 26×30（sky→violet）；标题 12.5/800 UI；副行 8.5 `.1em`（项目 · agent · branch）；lamp 6px（绿；wait 琥珀脉冲 1.5s）；按钮组 24px 高斜切 6px（←主对话 / ⚙调试 / ▦详情 / ⧉弹出 / ⌄收起 / ⌃全日志）。

**3.4.2 多作战 tab（`.tabstrip` / `.ctab`）**

- 条：`padding:6px 12px; gap:5px`；底 `rgba(6,5,16,.35)`；底边 teal .16；横向滚动条 4px。
- tab：高 26、斜切 6px、字号 10/700 UI、`max-width:150`；**✕ 在内容最左**（14×14，hover 红底）；未读 14px 圆标。
- 激活：`linear-gradient(90deg, sky 30%, violet 30%)` + teal 边 + 12px 辉光；新回传 `ping`。
- 排序同左栏（blocked→wait→run→queue→done）；关闭只入 `tabClosed`，历史保留；新消息自动重开。

**3.4.3 转录区（`.con-log`）与 TUI 行**

- 屏幕：`padding:12px 18px; gap:7px`；
  `radial-gradient(120% 70% at 50% 0%, teal 7%, transparent 62%) + linear-gradient(180deg, rgba(6,5,16,.42), rgba(6,5,16,.20)) + 32px 网格（teal .035）`；
  `border-top:1px solid rgba(46,230,214,.1)`；内投影上下 26px。
- 底部对齐（`::before{margin-top:auto}`），消息从底部往上长。
- 行语法（高保真逐符）：

| 角色 | 标记 | 样式 |
|---|---|---|
| 你 | `❯` | 12.5/800 金 + 10px 金辉光；正文 `border-left:2px solid rgba(245,197,66,.5)`、`padding:1px 10px`、**无底色无气泡** |
| 汐音 | `✦` | `#C9BFFF` 加辉光；正文白；上方 meta 行 9px mono（`已完成 · Xs · N 步 · 工具 N · 思考 N · tok · ¥`），`padding-left:20px`，完成态绿 |
| doer/工具 | `▸` | teal 800；名称 sky 700（max 140 省略）；正文 `--ink2`；状态 `[✓]` 绿 / `[✗]` 红 / `[…]` 灰；字号 11.5 |
| 系统 | `—— … ——` | 居中 9.5 `.08em` `--metal2` |
| 时间戳 | `HH:MM` | 8.5 mono，右对齐，`rgba(141,134,184,.55)` |

**3.4.4 当前回话（`.con-cur`）**

- `padding:7px 18px 9px`；顶边 teal .14；青色 3.5% 洗光。
- 说话人标签 9/700 `.14em`，**汐音紫 `#C9BFFF`** + 5px 紫点（替换旧金色）。
- 正文 mono 12.5/1.65 白，min-height 36；打字光标 `▸` **teal**，1s steps 闪烁；等待三点同汐音紫。

**3.4.5 选项行（`.con-choices`）**

- `padding:2px 18px 8px`；行 11 mono；`[n]` accent 色 + 标签 + impact 9.5 + `REC` 金标；hover `translateX(2px)` + accent 18% 底 + 辉光；键盘 `1–9` 直达。

**3.4.6 输入（`.con-in`）**

- `padding:8px 14px 10px`；顶边 teal .2；底 `rgba(6,5,16,.5)`。
- `❯` teal 14（行高 34）；textarea mono 12.5，边框 teal .22，底 `rgba(6,5,16,.55)`，`min 34 / max 100`，autogrow；空发送 shake `.3s` + deny。
- 发送：38×34 hex，金→橙，16px 辉光。

**3.4.7 状态条（`.con-f`）**

- 9px `.06em` metal2；`SCENE / POSE / CTX / MODEL / TUI SKIN` 值 teal；右侧三个 9×10 hex 场景点（当前 teal 发光）。

**3.4.8 独立窗口（`.cwin`）与 WINDOWS 条**

- 窗口：`linear-gradient(180deg, rgba(20,16,48,.86), rgba(10,8,24,.9) 40%, rgba(8,6,20,.92))` + blur16 + `--cut` + `--edge`；聚焦 teal 边 + 22px 辉光。
- 标题栏：`7px 10px`；**✕（关）→ —（最小化）在左**；状态表情 + 标题 11/800；拖拽移动。
- 转录：`.cwl` 同屏幕皮肤（28px 网格、`rgba(6,5,16,.4→.22)`）；复用同一 TUI 行渲染（末 40 行）。
- 输入：同 `.con-in` 缩版（textarea 28–70）。
- 级联：`x=120+n*64, y=84+n*34`（clamp）；尺寸 `min(380,W-24) × min(440,H-140)`；移动端高度让开通讯台；上限 5。
- WINDOWS 条（左下）：24px chip，主对话 chip + 每窗 chip（表情 + short + 未读 + 最小化虚线态）。

**3.4.9 收起 / 停靠 / grip / 全日志**

- grip：左缘 6px（ew-resize）、上缘 6px（ns-resize），hover 显形；双击复位。
- 收起 `⌥C`：console 隐藏；停靠 pill 34px（`--cut`，💬 + 线程 short + 总未读 + 「通讯停靠 · 点击展开」）；新消息 ping。
- 有窗口时 pill `right:12; bottom:52`；移动端 `right:10`。
- 全日志：`top 66 / bottom 10`。

### 3.5 立绘与动作

- 几何：`left:calc(var(--railw)+16px); bottom:2vh; height:var(--charh); aspect-ratio:2/3`；`filter:drop-shadow(0 0 34px violet 34%)`；地面光环（70% 宽椭圆，3s 呼吸）。
- 帧播放：单张 12 帧 sprite sheet，**每帧 480×720，整图 480×8640**；`img.height=frames*100%`；rAF ping-pong，`translateY(-idx*100/frames)%`；每姿态 fps：
  `idle 10 · working 12 · thinking 8 · alert 10 · worried 8 · happy 12 · cheer 14 · wink 10 · sleep 6 · salute 8 · command 12 · typing 16`。
- 回退链：motion-sheet → 双帧 sheet（625ms/帧）→ pose PNG（1024×1536）；sheet 缺项回退 `POSE_SRC`。
- 隐藏页暂停；`prefers-reduced-motion` 静帧。
- **开机=待命**：`setMood('idle')`，不播敬礼；`motion-sheet-idle.png` 曾用睁眼 `pose-idle.png` 重建（呼吸 ±0.6%，脚底线 y=717，帧 bbox 104,6,376,717）。2026-11-17 全身重绘后进入静态阶段：`MOTION={}`，12 帧 sheet 待 VideoGen 重出。
- 已剔除不满意的立绘：`POSE_SRC` 无 happy/sleep；`SHEET_SRC` 无 idle/salute/sleep（这些动作仍可走 motion sheet / 胸像）。
- 名牌：立绘底部居中，`--cut` 玻璃，9.5 `.12em` teal，绿点在线。
- 粒子层：confetti / spark / heart / bubble / zzz / sweat / keys / holo / beam / fly / ring / bang，按 `POSE_META.fx`。

### 3.6 回传 banner

- 几何：`left:calc(--railw + 16px + --charw/2); top:58px; width:min(390px, calc(--charw - 54px)); min-width:260`；中心对齐**立绘中线**。
- 光锥：`::after` 底部 140×14，`polygon(0 0,100% 0,72% 100%,28% 100%)`，accent 34% → 透明。
- 内容：**✕ 在左** + kind 标（block 红 / decide 天蓝 / accept 绿 / confirm 琥珀）+ 「刚刚回传」红点；标题 12.5/800 UI；副行 9.5；底部「就地回复 →」。
- 行为：10s 自动隐藏；点卡片 → 直接打开 inbox 对应回复卡；**不强制切线程**；键盘可达（role=button / tabindex）。
- ≤900 顶中 92vw；≤560 隐藏副行。

### 3.7 HUD / 时钟 / 场景

- HUD：高 54，左→右：玩家徽（`32×36` hex + 12.5/800 + CMDR 行）→ 舱籍 chip（高 32）→ SCENE 读数 pill（居中）→ model chip（高 32，`pro ▾ [1M]`）→ tok/ctx/cost（`24×27` hex + 14/800）→ ♪ / ◐ / ✦ hex 32×36。
- 时钟：右下 10，`--cut` 玻璃，16/800 绿 + 9 副行。
- 场景：三层 `scene-bridge / scene-cruise / scene-nebula` 双层 img crossfade（.9s）；视差 ±12/8px；`#warp` 星流 canvas；随机跃迁 45–105s（可关）；场景点三枚。

---

## 4. 状态与交互

### 4.1 state（v21 相关）

`thread, panel, detailJob, detailTab, full, focusJob, fleetFilter, fleetOpen` · `jobs[], ops[], pool[], threads{}, unread{}, tabClosed:Set` · `inboxOpen, inboxSel, inboxPick` · `conMin, conLeft, conTop, wins[], winSeq, zTop` · `mood, pose, poseSeq, lastAct, brief` · `simAuto, autoWarp, flash, sound, theme`。

### 4.2 关键流程

1. **回传**：`arriveNext()` → ops 入列 + job 置 blocked/wait → 线程插汐音话 → flash 标记 → 左栏行/决断卡入场动画 + hex 环 → 编队/右栏消项刷新 → mood + 屏闪 + 音效 → banner（天空） → **不切线程**，tab 标未读。
2. **就地回答**：inbox 行 → 回复卡 → 选项/自由文本 → `useAskSubmit` 真管线 → 回执 1.4s → 回列表（全清 0.7s 后收起）。
3. **直连 / 委托**：主对话提关键词且无新建动词 → relay 到作战线程（署名「指挥官 · via 汐音」）+ 主对话回执；含新建动词 → 新作战入编队 + 建线程 + command 动作。
4. **关 tab**：入 `tabClosed`，当前线程回主对话；同线程新消息自动重开 + 未读 + ping。
5. **排序实时**：进度 tick 只改百分比/进度条/`--p`，不重建整条 rail（避免悬停闪烁）。

### 4.3 键盘

| 键 | 行为 |
|---|---|
| `⌘/Ctrl+K` | 回主对话并聚焦输入 |
| `⌥M` | 静音 |
| `⌥W` | 跃迁 |
| `⌥D` | 当前线程调试 |
| `⌥C` | 收起/展开通讯台 |
| `⌥1` | 最紧要一条 |
| `⌥←/→` | 切 tab |
| `1–9` | 当前线程选项拍板 |
| `Esc` | 逐层：pop → banner → panel → full |

---

## 5. 落地映射（`packages/web-app`）

### 5.1 左栏

- 文件：`components/cockpit/rail/CockpitFleetRail.tsx`（重写）+ `app/cockpit/rail.css`。
- 数据：`fleet/CockpitFleetProvider`（jobs/counts/attention）；排序在纯函数 `sortFleet()` 里单测（状态 rank + born）。
- 保留真实行点击 = 选中作业面；「全部 →」打开 v20 编队面板；`fleetOpen` 只是 UI 态。

### 5.2 右栏待办

- 新增 `components/cockpit/rail/CockpitAttentionChip.tsx`、`CockpitInboxPopover.tsx`（或并入一个组件）。
- 数据：`view.attention`（awaiting=person）；选项提交复用 `CockpitChoices` / `useAskSubmit`；没有信封的行给「去处理 ▦」，不假造选项。
- **不跳线程**：回复卡提交后只做本地回执 + 刷新 attention；这是 v21 与 v20「决断面板」的关键区别（面板仍在，作为「全部决断」入口）。

### 5.3 右栏菜单

- 新增 `components/cockpit/rail/CockpitMenuRail.tsx`；动作复用：下指令=`chatWindow.openWithFocus`、跃迁=`CockpitWarpScheduler/travel`、消耗=`CockpitPanels(usage)`、调试=`CockpitJobDebug`、更多=fan。
- ≤900 时左栏隐藏，`更多 → 编队` 必须可达（与原型一致）。

### 5.4 通讯台

- 几何：`chat/CockpitChatWindow.tsx` + `chat/geometry.ts` 默认左边 = 立绘右缘 − 22px；右缘让出右栏；**底缘 = composer 条上沿**（宽屏通常 844 @900，等于原型；底栏变高时跟随）。≤900 切底部 sheet，底缘让开实测的底栏上沿。
- 皮肤：`app/cockpit/chat.css`（纯附加样式，classic 不加载）；转录内容仍走 `ChatArea`（`tui` + `composerVariant='cockpit'`）。
- 变更点：用户行去气泡（`border-left` 金线）；live 行颜色改汐音紫；全屏背景改深色终端屏；弹出窗 `.ck12-cwin` 同皮肤。
- **不改内容**：不新造气泡 / 表格 / 卡片；工具调用仍是 TUI 行；同一消息在所有窗口同步。

### 5.9 舱景 / HUD / 时钟（2026-11-17 落地）

- 舱景：`scene/scene-model.ts`（三幕定义）+ `scene/CockpitScene.tsx`（双层 img crossfade .9s、指针视差 ±12/8、空闲预取下一幕、reduced-motion 关闭）+ `app/cockpit/scene.css`（.grade / .grain 逐字照原型）。星流仍由 `CockpitStarfield` 订阅 `fx.jumpNonce`。
- 切幕：`CockpitStateProvider.travel()` = 「下一幕 + jump 星流」，自动跃迁 / ⌥W / 右栏跃迁 / SCENE pill 共用；换色、回传入场只 jump 不切幕。
- 场景点：`chat/CockpitConsoleFooter.tsx` 右侧三枚 9×10 hex（`cockpit-scene-dot-*`），直选某幕。
- HUD：`shell/CockpitHud.tsx` 重写为原型抬头条（指挥官徽 / 舱籍 / SCENE pill / model / ▤tok / ◈ctx / ¥cost / ♪◐✦ / ⋯设置）；导航入口只留最左 ←。读数复用真源：`CockpitModelPopover`、`chat.contextUsage`、`chat.usage`、`useCabinUsage`；缺值写「未就绪」，不写 0。
- 底缘状态行：`chat/CockpitConsoleFooter.tsx`（SCENE / POSE / CTX / MODEL / TUI + 场景点），读数同源。
- 时钟：`shell/CockpitClock.tsx`（右下 10，16/800 绿 + 副行；分钟对齐刷新；≤900 隐藏）。在场读数放进 title（原型副行只有「舰桥时间 · 全舱正常」）。
- 配色：`THEMES.terminal` 校准为原型三主色（a `#2EE6D6` / b `#7B4DFF` / c `#F5C542`）；存量舱一次性迁移脚本 `docs/cabin-design/_migrate-v21-theme.mjs`（dry-run 默认，`--apply` 才写，幂等）。
- 断点：HUD 按原型压缩（≤1320 隐 tok/坐标；≤900 隐 SCENE/ctx/舱名；≤560 隐 ◐✦、缩玩家名与间距）。

### 5.10 对照工具（不入库）

- `docs/cabin-design/_fixture-v21.mjs`：固定样板舱（9 作业 / 2 task-kind 带 v4 phases / 真实 attention），跑完即删。
- `docs/cabin-design/_fidelity-v21.mjs`：原型 ⇄ 生产同视口四档截图 + 30/28/20/20 项几何与样式断言，`shots-fidelity/diff.json`；任一失败退出码 1。


### 5.5 立绘

- `crew/pose-model.ts`：12 个姿态键换新（`smile/concerned/ready` 替换 `happy/worried/salute`）；mood 键不动，经 `MOOD_POSE`（happy→smile、worried→concerned、boot→idle）与 `POSE_MOOD` 双向映射；`ACTION_POSES = cheer/command/ready`；boot 映射 idle。
- **静态阶段（2026-11-17）**：`MOTION_SHEETS` / `FALLBACK_SHEETS` 为空表，`framesFor()` 全返回 1，立绘走单帧 `pose-*.png`（1024×1536 透明底）；`poseSource()` / `fallbackSource()` 已就位，VideoGen 补齐 sheet 后只填表即回到 12 帧。
- `crew/CockpitPoseSprite.tsx`：rAF ping-pong、隐藏暂停、reduced 静帧、逐级回退；单帧时不启动 rAF。
- **ready 由真实事件驱动**：从休眠唤醒（mood sleep → 醒）与接管另一间舱（`scene.key` 变化）播报到；首次进舱保持待命，不播敬礼（沿用 §3.5）。
- 对话框（图鉴）点卡仍是显式查看入口；运行时没有点击轮播。

### 5.6 banner

- `fx/CockpitBrief.tsx`：left = 立绘中线；width 上限 = `charw-54`；右缘必须 < 通讯台左缘；10s 自隐；点击进 inbox 回复卡。

### 5.7 关闭左置

- 新增组件同样把 ✕ 放容器首位（DOM 顺序即焦点顺序）；e2e close-left 审计扩展到：左栏?（无关闭）、inbox chip 浮层、回复卡、弹出窗、tab、banner、面板。

### 5.8 真数据纪律

- 一切行/计数/进度/消耗来自现有端点；拿不到就不画（不写 0 冒充）。模拟层仅 DEV+`?demo=1`，不代答决断。

---

## 6. 验收（高保真）

### 6.1 视觉矩阵

同视口并排截图（原型 vs 实现）：1600×900 / 1200×800 / 900×700 / 560×740。保存到 e2e artifacts。

### 6.2 几何/样式断言（建议 e2e 采样）

| 断言 | 期望 |
|---|---|
| `fleetrail.width` | 198 / 186 / 64 / 隐藏 |
| `console.left`（1600） | 立绘右缘 − 22（±1） |
| `console.right` | 视口 − 100 |
| 通讯台默认行数 | 6；`更多 +N` 存在 |
| `rhex` 尺寸 | 63×72（big 76×88；more 56×63） |
| `inboxchip.width` | 78 |
| banner 中心 | = 立绘中心；右缘 < console.left |
| banner 宽度（1600） | 390 |
| 关闭按钮 | 各容器 header 首个可聚焦子元素 |
| 转录字体 | mono；时间戳 tabular-nums |
| 用户行 | `background` 透明；`border-left` 金色 |
| 通讯台底色 | 与 §3.4.1 渐变一致（computed style 采样） |
| 开机姿态 | `pose=idle`、`src` 含 `motion-sheet-idle`、frames=12 |

### 6.3 e2e 场景

- 左栏排序/6 行/更多/点击选中/实时进度不闪。
- inbox chip 计数/浮层分组/就地回答/回执/自动收起/点击外关。
- 更多横排 7 项可达；消耗/调试常驻打开正确面板。
- chat：tab 切换/关闭/未读/重开；选项 1–9；收起/停靠/展开；全日志；弹出窗 5 上限/最小化/恢复。
- banner 位置/点击/10s 自隐/不切线程。
- 900/560 无横溢、dock 在视口内、右栏不出屏。

### 6.4 门禁

```bash
pnpm --filter @octopus/web-app test
pnpm --filter @octopus/web-app lint
pnpm --filter @octopus/web-app build
# 真 backend 起在 3001；Vite 新鲜端口：
OCTOPUS_E2E_WEB_PORT=<port> pnpm --filter @octopus/web-app test:e2e cockpit-v21
```

---

## 7. 差异登记（实现 vs 原型）

> 只写不得不做的偏离；未列出的项一律按原型逐像素实现。

| 项 | 原型 | 实现 | 理由 |
|---|---|---|---|
| 数据 | mock（JOBS_INIT/OPS_INIT） | 真端点 | 沿用 v20 真数据纪律 |
| 说明/演示 | 模拟回流、自动收口 | 仅 DEV + `?demo=1`；不代答决断 | design 12 #8 / design 30 §0 |
| 多窗口内容 | 转录快照 | 真 ChatPane | v20 已定，v21 不改 |
| 帧资产 | 原型本地 PNG | 单源 import `docs/cabin-design/assets` | 避免复制与漂移 |
| `classic` | — | 不改一行 | 硬约束 |
| 左栏「全部 →」 | 打开 v20 编队面板 | 就地展开全部行（再点收起） | web-app 没有独立「编队面板」；折叠/展开是同一信息量的最近入口，不新造模态 |
| 通讯台底缘 | 视口底 − 56（composer 在壳内） | 宽屏 = composer 条上沿（通常 844 @900，±10 随底栏行数）；≤900 sheet 停在底栏上沿 | 应用保留常驻 composer（关窗后仍能输入，plans §2.4）；两者同皮肤、无断层，视觉连成一台 |
| 通讯台输入行 | `.con-in` 在壳内 | 真 composer 在底栏槽（通讯台正下方） | 同上：composer 是跨树 portal，关窗/收起不能丢输入 |
| 窄屏 sheet | bottom 10（composer 在壳内） | 停在底栏上沿（让出 56–80px） | 生产 composer 独立成条，覆盖它会让输入行不可用 |
| 返回入口 | 无 | HUD 最左极简 ← | 应用需要退出舱；其余导航入口全在右栏「更多」 |
| 右下钟副行 | 「舰桥时间 · 全舱正常」 | 同文案；在场档位进 title | 原型副行没有在场读数；visible 宽度超出会压住 composer |
| HUD 读数缺值 | mock 恒有值 | 「未就绪」占位 | 真数据纪律（不写 0 冒充） |
| HUD 舱籍 chip | `账务中台 · 4 项目` | 舱名 + 项目数（真实舱籍） | 真数据；无项目时给「＋ 绑定项目」入口 |
| 指挥官徽 | 等级 16 + CMDR 编号 | `CABIN_MAIN_IDENTITY` + `CMDR · <org/全域>` | 应用没有「玩家等级」数据；用真实舱主身份，不编造编号 |
| 跃迁切幕 | 每次 gotoScene | `travel()` 切幕；换色/回传只 jump | 同一物理动作才换场景，避免换色把船开走 |
| 通讯台底色 | 原型渐变（alpha .8–.92） | 同渐变 + 一层近黑底（alpha .62） | 全舱背后常是明亮作业面；纯 .8 渐变会透字，终端屏读不清（用户 2026-11-17 强调可读） |
| 右栏 z 序 | 22（在 app 下、通讯台 10 之上） | 160（压在 chat / 问答窗之上） | 本应用通讯台是 z100+ 浮窗；右栏与 inbox 浮层必须始终可点 |
| ≤900 作业面打开时 | 原型无作业面 | 隐藏立绘 | 面在窄屏占满宽度，立绘只剩一条边；隐去比露边干净 |
| 立绘启动姿态 | 待命 | 待命（`MOOD_POSE.boot='idle'`） | 已对齐；有 pending 待办时 mood 派生为 alert，属真实状态 |
| 项目色 | 原型手写 4 色 | 项目 key 稳定 hash → 同一 4 色 | 真数据里没有颜色字段，hash 不新增接口且跨刷新稳定 |

---

## 8. 已知边界

- 弹出窗每窗一个 ChatPane（5 窗 = 6 实例，SSE/订阅各自一份）；再往上需转录虚拟化。
- 12 帧 sheet 单张约 16MB 解码；换姿态释放旧图；移动端首屏需按需加载。
- 左栏 ≤1240 图标栏隐藏副行/进度，只靠状态点；信息密度取舍按原型。
- banner 宽度依赖 `--charw`，立绘尺寸变化时需同步 `calc`。

---

## 附录 A · 资产

- 场景：`assets/scene-bridge.png` / `scene-cruise.png` / `scene-nebula.png`
- 12 帧：`assets/motion-sheet-{idle,working,typing,cheer,happy,thinking,worried,sleep,wink,salute,command,alert}.png`（480×8640）
- 双帧：`assets/sheet-{working,thinking,alert,worried,happy,cheer,wink,command,typing}.png`
- 立绘：`assets/pose-{idle,working,alert,thinking,worried,cheer,wink,salute,command,typing}.png`
- 胸像：`crew/xiyin-{idle,alert,working,thinking,worried,happy,cheer,wink,sleep}.png`
- 再生管线：`_prekey-v19.mjs` / `_sheets-v20.mjs` / `_motion-v20.mjs`（raw/alt/mp4 为可再生中间产物，已 gitignore）

## 附录 B · 原型索引

- 布局/皮肤 CSS：`cockpit-v21.html` L1–L800（token、console、fleetrail、inbox、banner、responsive）
- 数据与状态：L900–L1020（PROJECTS/JOBS/OPS/THREADS/POSE/MOTION/state）
- 左栏/右栏：L1116–L1200（renderFleetRail / renderInbox / renderInboxDetail）
- 通讯台：L1213–L1300（tabs / renderConsole / tlHTML / tuiMeta / applyGeo）
- 窗口与停靠：L1522–L1590
- banner/回传：L1593–L1620
- 交互总装：L1659–L1742（fan / events / keyboard / boot）
