# 指挥舱 v19 — 星穿梭 · 多场景 · 汐音动作替换 · TUI 玻璃通讯台

> 状态：**原型（2026-11-16）· 当前稿** · 自包含 HTML：`docs/cabin-design/cockpit-v19.html`
> 验证：`_verify-v19.mjs`（Playwright 1440/1024/390，0 运行时错误）；立绘预制透明化：`_prekey-v19.mjs`
> 迭代链：v16（指令核+甲板）→ v17（VN 主述）→ v18（崩坏3式舰桥 hub）→ **v19（本稿）**
> 场景/立绘资产：`docs/cabin-design/assets/`（原创生成，非版权素材）

---

## 0. 本轮用户四条反馈 → 落地

1. **优化透明感** → 通讯台/面板改低 alpha 玻璃（`--glass:.46` / `--glass2:.56`）+ `backdrop-filter:blur(10~14px) saturate(1.35)`，
   场景（日落/星空/星云）能清晰透出来；顶部高光 + 角标 + 扫描线维持「玻璃仪器」质感，文字白底_indigo 保证对比。
2. **对话放人物右边、不空、TUI 感、战斗舱炫** → 常驻 **TUI 玻璃通讯台**占据立绘右侧整块（`left:calc(5vw+53vh+22px); right:110px; top:66; bottom:56`）。
   mono 字体、`[YOU]/[汐音]/[doer]` 角色色签 + 时间戳 + 左 gutter 线 + 扫描线 + 角标；当前主述大字打字机；galgame 选项行 `[1]…REC`；底部 `❯` 输入行 + 六边形发送。
3. **星空穿梭 + 不同场景切换** → 三张场景板（舰桥·日落 / 星空·巡航 / 星云·门）双层 crossfade；`#warp` canvas 星流在跃迁时加速拉线（`state.warp` 衰减），
   右menu「⟳ 跃迁」/ `⌥W` / 通讯台footer三颗场景点 切换；HUD 场景读数（名+坐标）同步；立绘为独立透明层，**跨场景保持**。
4. **角色更像汐音 + 多动作替换** → 以 `crew/xiyin-idle.png` 为 likeness 参考生成 4 张全身绿幕动作（idle/working/alert/happy），
   `_prekey-v19.mjs` 离线 chroma-key 成透明 PNG（避免 `file://` canvas taint）；`setMood→POSE_OF→setPose` 淡入淡出换动作；footer/立绘牌显示 POSE。

## 1. 布局（桌面）

- 全bleed 场景双层 + grade + grain + warp canvas + flash。
- 立绘：`left:5vw; bottom:2vh; height:80vh`，透明 PNG，drop-shadow 辉光 + 地面光环 + 浮动；点击=说话。
- 左竖排系统 hex：汐音/日志/模拟/换色。右主menu hex：下指令(big)/编队/决断(红点)/详情/跃迁。
- TUI 通讯台（人物右）：head(线程+lamp+主对话/详情/全日志) → log(TUI 行, bottom-anchor) → current(打字机) → choices → input → footer(SCENE/POSE/CTX+场景点)。
- 面板（fleet/ops/detail/log）= 居中玻璃 overlay + pscrim；detail 四页签（概览/运行/变更/验收）+「与汐音谈这条」。
- 回流 banner 顶中；右下时钟widget；HUD 玩家徽+场景读数+货币+音效/换色/模拟。

## 2. 交互闭环（实测）

- 下指令/⌘K → 主线程聚焦；发送 → spawn 新作业进编队 + 汐音回执。
- 决断 hex → ops 面板 → 点卡 → 通讯台切线程 + galgame 选项 → 选项/`1–9`/文字命中 → resolveOp：消项+红点递减+回执+绿色 flash+confirm 音+**立绘换 happy**。
- 编队 hex → fleet → 点行 → detail 四页签 → 「与汐音谈这条」→ 通讯台线程。
- 跃迁/⌥W/场景点 → 星流拉线 + crossfade 换场景 + 读数同步；立绘不变。
- 回流（16s 首条/34s 间隔/手动）→ banner + 红点 + 立绘 alert + 通讯台插话；点 banner → 就地线程选项。
- 全日志展开通讯台加高；Esc 逐层关（banner→panel→full）。
- 音效默认开、HUD 一键静音（⌥M）；换色三套 token。

## 3. 响应式

- ≤1100：立绘 64vh、通讯台左偏移收紧、hex 缩小。
- ≤900：通讯台变底部玻璃 sheet（56vh），立绘站其上方（46vh）；左lbl 隐藏；面板全宽。
- ≤560：立绘 38vh、通讯台 52vh、hex 再缩；输入行始终在视口内（实测）。
- 三档视口无横向溢出、无遮挡/ clipping（红点用未 clip 的外层承载）。

## 4. 资产与生成

- `assets/scene-bridge.png / scene-cruise.png / scene-nebula.png`：原创赛璐璐舰桥/巡航/星云门背景（左留空供立绘）。
- `assets/pose-idle/working/alert/happy.png`：以现有汐音立绘为参考的全身绿幕 → 离线 key 成透明。
- `assets/bridge-v18.png`：v18 用带角色舰桥（存档）。
- 运行时**不**做 canvas key（`file://` 会 taint），直接引用透明 PNG。

## 5. 非目标 / 后续

- 场景自动巡航循环、立绘口型/眨眼微动画、更多场景板留待后续。
- 服务端决策账本/真实作业流对接仍为 mock（原型）。