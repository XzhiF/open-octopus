# 指挥舱 v20 — 多作战回传 · 多窗口 · 调试 inspect · 模型账本 · 舱籍/文件树 · 12 姿态连续动作

> 状态：**原型（2026-11-17）· 当前稿** · 自包含 HTML：`docs/cabin-design/cockpit-v20.html`（CSS/JS 全内联，资产相对路径）
> 验证：`_verify-v20.mjs`（Playwright 1440/1024/390，约 145 断言，0 运行时错误，连续多轮稳定）
> 迭代链：v16（指令核+甲板）→ v17（VN 主述）→ v18（崩坏3式舰桥 hub）→ v19（星穿梭+TUI 玻璃通讯台）→ **v20（本稿，五轮反馈）**
> 设计参考：`~/Desktop/崩快3.png`（崩坏3舰桥 hub 的 diegetic 菜单/资源条/角色站场基因）；场景/立绘资产均为原创生成
> 提交：`50af5da4`（feat-new-ui-20261022）

---

## 0. 反馈轮次 → 落地总览

| 轮 | 反馈 | 落地 |
|---|---|---|
| 一 | ① 作业坞式调试 ② 换模型/ctx/token/费用 ③ 看舱绑定项目 ④ 回传位置放空白处 ⑤ 编队/决断/详情联动 ⑥ 详情加作战文件目录树 ⑦ 多 tab 多回传模拟+状态表情 | 调试 inspect 五页签；model 弹层+SESSION LEDGER；舱籍面板；回传全息落立绘头顶空白天空；三向联动+focusJob；task home 文件树；tab 条+状态表情+未读+立即激活+模拟弹层 |
| 二 | ① 聊天框太右与按钮重合 ② 缺作战舱文件树 ③ 详情头部太挤 ④ 详情/决断/编队概念重组 ⑤ chat 回归 TUI 风格 ⑥ tab 可关闭+直连/委托双模式同步 | 通讯台 insets 让位两侧 hex；worktree 文件树面板；详情动作收进标题行 hex+面板加高；右菜单四 hex（详情入编队/决断/通讯台）；mono 转录+TUI 选项行；tab ✕+relay/直连双向同步 |
| 三 | ① 调试统计与过滤同行 ② 连续多条消息模拟 ③ 回传要有编队/决断动画 ④ 去左右晃动要 GIF 式真动作 ⑤ chat 可 resize/收起/停靠再开 ⑥ 用户自开多窗口+后台式切换 ⑦ 跃迁随机发生 | 单行 dbg-h；连发回流×4–6+自动偶发连发；rowArr/cardArr/hexRing；帧播放器替代晃动；grip resize+停靠 pill；⧉ 弹出多窗口+WINDOWS 条；45–105s 随机跃迁 |
| 四 | 2 帧太闪，要游戏式连续动作；GIF 或视频皆可 | 12 姿态视频衍生 12 帧 sprite sheet + ping-pong 帧播放器；4 个无缝 GIF 预览；**结论：PNG sheet 优于 GIF**（见 §9.6） |
| 五 | 精修（自查+验收驱动） | 多窗口 cascade/几何互斥、移动端 inline 几何覆盖 media 根因、头部按钮溢出收纳、toast 分层、flash 先于渲染、hex 环共享计时器、验收采样别名修复 |

---

## 1. 布局与几何

### 1.1 桌面（>1100）

```
┌ HUD：玩家徽 | ⧉舱籍chip | SCENE读数 | model chip[1M] | ▤token | ◈ctx | ¥cost | ♪ ◐ ✦ ┐
│ 左stack(8 hex)：汐音 动作 日志 文件 消耗 调试 模拟 换色                              │
│ 立绘 left:5vw bottom:2vh h:80vh (aspect 2/3)   ┌ TUI 通讯台 ────────────┐  右menu(4 hex)│
│  · .spr 裁切窗 + 多帧 sheet                    │ head(线程+lamp+按钮行)  │  下指令(big) │
│  · 粒子层 .fx + 地面光环 + 名牌                 │ tabstrip(多作战 tab)    │  编队        │
│ 回传全息 banner：left:118 top:60               │ con-log(TUI 转录)       │  决断(红点)  │
│  （立绘头顶左、通讯台左外的空白天空）            │ con-cur(live 主述)      │  跃迁        │
│                                                │ con-choices(TUI 选项)   │              │
│                                                │ con-in(❯ 输入+⏎)       │              │
│                                                │ con-f(SCENE/POSE/CTX/MODEL+场景点) │  │
│                                                └────────────────────────┘              │
│ 停靠pill(收起时) · WINDOWS条(有窗口时) · 时钟widget · toast · popModel/popSim · panel+scrim │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- 通讯台：`left:calc(5vw + 53vh + 22px); right:132px; top:66px; bottom:56px`。right 132 让开右 menu 大 hex（110 宽+right 10+hover scale）。
- 场景层：双层 `<img>` crossfade（`scene-bridge/cruise/nebula`）+ grade + grain + `#warp` 星流 canvas + `#flash` 屏闪；pointermove 视差 ±12/8px。
- 面板：居中玻璃 overlay `width:min(760px,94vw); top:58; bottom:30`（二轮加高腾内容空间）+ pscrim 模态。

### 1.2 响应式断点

| 断点 | 关键变化 |
|---|---|
| ≤1100 | 立绘 64vh/left 3vw；通讯台 `left:calc(3vw+43vh+16px); right:112px`；banner 宽 `calc(3vw+43vh+16px-126px)`；隐藏 token 读数与 SCENE 坐标 |
| ≤900 | 通讯台变底部 sheet：`left:52; right:104; bottom:10; height:56vh`（让开左右 hex 列）；立绘站其上方 46vh；banner 顶中；隐藏时钟/SCENE读数/grip；WINDOWS 条 `bottom:calc(56vh+16px)`；停靠 pill 右下；文件树/预览改纵向 |
| ≤560 | 通讯台 `left:46; right:86; height:52vh`；立绘 32vh；banner 紧凑（隐藏副标题）；头部隐藏 ←主对话/⚙调试/⌃全日志（tab 条含主对话、左 hex 有调试/日志兜底）；cbtn 收窄；WINDOWS 条 `bottom:calc(52vh+16px)`；tokcells 2 列 |

### 1.3 几何仲裁规则（防遮挡，全部有验收断言）

- `applyGeo()` 写 inline left/top/bottom；**bottom 必须分档**：`full?10 : (innerWidth<=900?10:56)`。曾因 inline 56 覆盖移动端 media 的 10，把通讯台顶抬高 46px 钻到浮窗下（五轮根因修复）。resize 事件重跑 applyGeo。
- 浮窗 z 域 31–36（`bumpZ` 超限归一化），低于 pscrim 38/panel 40/HUD 50/WINDOWS 条 55 → 模态与 HUD 永远压浮窗。
- 有窗口时（`#app.has-wins`）：停靠 pill `right:12; bottom:52`（移动端 right:10），与时钟（bottom 10）、WINDOWS 条（bottom 10）垂直分离；toast `bottom:100` 避免压 pill。
- 移动端浮窗高度约束在通讯台之上：`conTop = H-10-(≤560?.52:.56)*H`，`hh=max(260,min(440,H-140,conTop-68))`，y clamp 到 `conTop-hh-8`。
- banner 宽桌面 `min(430px, calc(5vw+53vh+22px-126px))` 保证右缘 ≤ 通讯台左缘；≤1100 用对应 calc；≤900 顶中 92vw。

---

## 2. 状态与数据模型

### 2.1 `state` 字段分组

| 组 | 字段 |
|---|---|
| 会话/面板 | `thread, panel, detailJob, detailTab, full, focusJob, fleetFilter, pop` |
| 作业/决断 | `jobs[], ops[], pool[], threads{}, unread{}, tabClosed:Set, handleSeq, seq` |
| 舱况 | `scene, sceneFront, warp, cost, tokens, tokIn/tokOut/tokCR/tokCW, requests, cacheHit, model, effort, ctxMax` |
| 角色 | `mood, pose, poseSeq, lastAct, brief` |
| 文件树 | `treeOpen{}, fileSel{}, fileQ{}`（task home）；`wsProj, wsOpen{}, wsSel{}, wsQ`（worktree） |
| 调试 | `dbgTurn{}, dbgTab, dbgFilter`（+`dbgPRaw` 原始/实际发送切换） |
| 窗口/通讯台 | `wins[], winSeq, zTop, conMin, conLeft, conTop` |
| 模拟/动态 | `simAuto, autoWarp, flash{job,op,at}, sound, theme` |

帧播放器独立常量态：`mo={idx,dir,acc,last,frames}`。

### 2.2 常量与 mock 数据（对齐真实项目语义）

- `PROJECTS`：4 项目（账务核心/API 网关/风控引擎/边缘节点）含 org/group/branch/HEAD/commit/dirty —— 对齐 `task-project-chip` 与 design 21 舱籍三层。
- `JOBS_INIT`：9 作战，字段 `id/proj/kind/title/short/status/pct/doing/agent/branch/clock/cost/tok/rarity/tid/slug`；`KW` 关键词表供主对话 relay 识别。
- `STATE_LABEL/STATE_EMO`：`run 作战中⚡ / wait 等你答❗ / blocked 受阻💦 / queue 待命💤 / done 已归档✅`。
- `OPS_INIT/OPS_POOL`：决断信封（block/decide/accept/confirm，pri 排序、options+rec+impact），对齐 design 24/25。
- `MODELS`：`pro-max(×3)/pro(×1,默认)/se(×0.4)`，eff 映射 `pi/qwen3.7-max|plus|qwen3.6-plus`；`EFFORTS=['低','标准','高','极深']`（费倍 0.7/1/1.2/1.5）；ctx 200k/1M —— 对齐 `composer-model-popover` 与 models.yaml tiers。
- `THREADS_INIT/JOB_EVENTS/CHANGES/AC`：TUI 转录种子、事件流、diff、验收单。
- `WS_FILES`：四项目 worktree 真实感仓库布局（src/config/scripts/wiki/package.json…），被改文件带作战徽标。
- task home 树由 `filesFor(j)` 生成：`manifest.json/context.md/skills//workflows//artifacts//.scratch/<date>/<slug>/{spec.md,issues/01..03-e2e,round-report.md}` —— 对齐 `task-home-service` 与 batch-tree。
- `POSE_META/POSE_ORDER/SHEET_SRC/MOTION/MO_FPS`：12 姿态元数据与帧率（§9）。
- `SCENES/THEMES/ACK/SAY/PROGRESS`：场景三板、三套色 token、话术池。

---

## 3. TUI 通讯台与双模式同步

### 3.1 TUI 主体（二轮⑤）

- 转录行：`时间戳(38px gutter) + 角色符签(82px, ❯YOU/✦汐音/⚙doer, 角色色) + mono 正文 + 左 gutter 线`；sys 行居中 mono 小字（回执落这里）。
- live 主述 `con-cur`：mono 12.5px 打字机 + 金色光标▸；typing 三点等待态。
- 选项 `con-choices`：TUI 菜单行 `[n] 标签 · impact … REC`，mono、左 accent 边、hover 平移+辉光；键盘 `1–9` 直达。
- 输入：`❯` + mono textarea（⏎ 发送/⇧⏎ 换行/autogrow）+ 六边形⏎；空发送 shake+deny 音。
- head：线程名/副标题(项目·agent·branch)/lamp(wait 琥珀脉冲)/←主对话/⚙调试/▦详情/⧉弹出/⌄收起/⌃全日志。
- footer：SCENE/POSE/CTX/MODEL 读数 + 三场景点。

### 3.2 多作战 tab 条

- `renderTabs()`：主对话 + 按状态排序（blocked>wait>run>queue>done）的作战 tab；每 tab = 状态表情 + short + 未读红点 + 悬停/激活出 ✕。
- 关闭 `closeTab`：入 `tabClosed`，激活态回主对话；**历史保留**；`pushMsg` 到已关闭线程自动重开（delete+unread+ping）。
- 回传 `arriveNext` 末尾 `openThread(o.job)` = **立即激活**；未读只在不可见时累加。
- `⌥←/→` 循环切 tab。

### 3.3 双模式同步（二轮⑥的产品平衡）

| 路径 | 行为 |
|---|---|
| 委托：主对话提到作战关键词（`KW`/spawn kw）且无新建动词 | `relayTo`：作战线程落 `指挥官 · via 汐音` 署名行 + doer 回执；主对话汐音 ack「已 relay…」；tab ping+toast |
| 委托：主对话含新建动词 | `maybeSpawn` 新作战入编队+建线程+command 动作 |
| 直连：作战线程/浮窗发送 | doer 回执 + 汐音盯梢 + **主对话「同步：您直接对「X」交代了…」回执**（1.7s） |
| 决断消项 | 作战线程拍板行+汐音回执；**主对话 sys 行 `✓ #n 按「choice」交代下去 · 标题`** |

可见性规则（`pushMsg`）：`conVisible = thread===t && !conMin`；`winVisible = 存在该线程非最小化浮窗`；两者皆否才 unread++/ping；否则渲染对应面；收起态 dock 脉冲+总未读。

---

## 4. 多窗口管理器（三轮⑥）

- **入口仅用户主动**：head「⧉ 弹出」（主对话隐藏）→ `openWin(jid)`；已存在则 focus；上限 5（toast 拒绝）。
- 窗口结构：标题栏（状态表情+标题+—最小化+✕关闭，grab 拖拽）→ `.cwl` 转录（tlHTML 复用，末 40 行）→ `.cwc` live 行 → `.cwch` 选项（可就地拍板，note 取本窗输入）→ `.cwi` 输入（⏎/按钮发送走 `sendFrom(job, el)`）→ 右下 resize grip。
- 级联：`x=120+n*64, y=84+n*34`（clamp 视口）；尺寸 `min(380,W-24) × min(440,H-140)`，移动端再受 §1.3 约束。
- 焦点：`bumpZ` 自增 z，>36 时按 z 排序归一化 31..36；**pointerdown 聚焦只改 inline zIndex/focus class，不重建 DOM**（重建会吞掉本次 click——五轮修复）。
- 拖拽/resize：pointerdown 记起点，window 级 pointermove/up 闭包更新 w.x/y/w/h 并直写 style（不重渲染）。
- 最小化：`w.min=true` → 窗口隐藏、WINDOWS 条 chip 虚线态；点 chip 恢复+focus+清未读。
- WINDOWS 条（`#winBar`，左下）：`WINDOWS` 标 + 主通讯 chip + 每窗 chip（表情+short+未读点+min 态）；主 chip 点击展开通讯台；无窗自动隐藏并摘 `has-wins`。
- 关闭：移出 wins；线程历史仍在 tab/面板可回。

---

## 5. 通讯台收起 / resize / 停靠（三轮⑤）

- grips：`.grip-l`（左缘竖条，ew-resize）/`.grip-t`（上缘横条，ns-resize），hover 显形；拖拽写 `state.conLeft/conTop`（clamp 320..W-360 / 56..H-240）→ applyGeo；**双击复位** null。
- 收起：head「⌄ 收起」或 `⌥C` → `setConMin(true)`：console hidden、`#conDock` pill 显形（💬+当前线程 short+总未读+「通讯停靠·点击展开」）；新消息 pill ping；点 pill/⌥C/WINDOWS 主 chip 展开。
- 全日志 `⌃`：console top 66/bottom 10 加高（与收起互斥语义独立）。

---

## 6. 面板系统（8 面板，模态 scrim）

| 面板 | 入口 | 内容与联动 |
|---|---|---|
| fleet 编队 | 右 hex | 项目 filter chips + 「◈ 待你决断 n」跳转；行=_kind glyph+标题+★+项目·doing+进度条+状态表情签+需要你红点+💬/◈ 快捷；行点击→detail；回传行 `arrived` 入场动画 |
| ops 决断 | 右 hex（红点计数） | open 按 pri 排序卡（handle/kind/age/表情/问题/就地回答→/▦ 详情）+ done 卡（✓ choice，2.6s 后 collapse）；回传卡 `arrived` 弹入 |
| detail 作战详情 | 编队行/决断卡/通讯台▦ | 标题行 hex 动作（💬谈/◈去决断(有 open op)/⚙调试/⧉舱籍）+ 六页签：概览(KV+doing+事件)/运行(事件流)/变更(diff 文件卡)/验收(AC+通用项)/文件(task home 树)/调试(inspect) |
| log 日志 | 左 hex | 当前线程气泡全史（汐音头像=mood portrait） |
| usage 消耗 | 左 hex / HUD ¥·◈·▤ | SESSION LEDGER（总 tok+¥+请求数+cache%）→ 四 token 格 → 按模型行 → 作战账本行（点击→detail）；4s tick 实时 |
| projects 舱籍 | HUD ⧉ chip / detail ⧉ | 只读 ff-only 提示 + 4 项目卡（org/group、branch·HEAD·commit、clean/dirty、作战/在跑/工作树/消耗、worktree 路径）→「看该项目作战」(fleet filter)/「⌗ 工作区文件」(ws) |
| ws 作战舱文件 | 左 hex「文件」/ 舱籍卡 | 项目 chips + 筛选 + worktree 树（默认全展开）+ 只读预览；被改文件徽标=作战 short；预览头「▦ 看作战变更」→detail changes |
| poses 动作图鉴 | 左 hex「动作」 | 12 卡（缩略图+中英名+描述）；点卡 `playPose`：就地换动作+粒子+台词+toast；当前卡金边 |

detail 文件树：`filesFor` 生成 task home；目录展开态 `treeOpen[j]`（默认展开 .scratch 链+issues）；筛选自动展开匹配链；选中预览 mono pre；spec 带 phases/AC，issues 带票徽标。
滚动保持：`renderPanel` 以 `panel|detailJob|detailTab|fleetFilter` 签名判断同面重渲染保留 scrollTop（实时 tick 不跳scroll）。

---

## 7. 回传、模拟与随机跃迁

### 7.1 回传流（arriveNext）

pool shift（空则 `genOp` 造一条安全点决断）→ ops push + job 状态置 blocked/wait → 线程插汐音话 → **flash 标记先设** → hex 环（共享 `hexT` 1300ms，多连发不误清）→ renderDots/renderPanel → mood+屏闪+arrive 音 → **banner 全息**（空白天空，10s 自动隐，点击进线程聚焦输入）→ **openThread 立即激活** → scheduleArrival。

### 7.2 入场动画（三轮③）

`state.flash={job,op,at}`；渲染时 `Date.now()-at<1400` 命中行/卡加 `arrived`：`rowArr`（accent 34% 底+右移 7px+辉光衰减）、`cardArr`（上浮 10px+scale .96+辉光）；hex `hexRing`（inset 边+外扩 26px 环衰减）。progress tick 也写 flash.job → 编队行微闪。

### 7.3 模拟弹层（左 hex✦）

单条回流 / 三连回流(1.1s 间隔) / **连发回流×4–6(430ms 间隔+260ms 处插一条 progress)** / 全部按 REC 自动收口(450ms 级联) / 自动回流开关(34s，**30% 概率改为 2–3 连发**) / 随机跃迁开关。HUD ✦ = 单条。

### 7.4 随机跃迁（三轮⑦）

`scheduleWarp`：45–105s 随机 setTimeout → 非隐藏页则 travel；travel/gotoScene/手动场景点均重排；跃迁=星流拉线(state.warp 衰减)+双层 crossfade+读数同步+立绘保持。

---

## 8. 模型 / ctx / token / 费用

- HUD model chip `model pro ▾ [1M]` → popModel：三模型卡（desc+费倍+默认标+✓）→ 思考强度 seg(4) → 最大上下文 seg(200k/1M) → 注脚「运行 pi/<eff> [1m] · 切换模型将重建会话缓存」。
- 切换：model/effort 即时生效+toast+ violet 屏闪；ctx 切 200k 时 `tokens=min(tokens, .93*ctxMax)`（缓存重建压缩）+toast；`refreshPop` 重绘弹层（修复同 kind 自toggle 关闭 bug）。
- 读数：`pct=min(100, tokens/ctxMax)`，>85% 琥珀 hot；token fmtK；footer 同步。
- 实时 tick（4s）：每 run 作战 `dt=260*modelMult()` → job.tok/cost、state.tokens(封顶 .98ctxMax)/四拆/requests/cost 累加 → renderHUD + usage/fleet 面板刷新。
- 调试 inspect 的成本/用量为轮级 mock（含缓存读/写、ttft、stop reason、sys hash、身份 rev），与账本语义一致。

---

## 9. 汐音 12 姿态 · 真·连续动作

### 9.1 姿态表

| key | 名 | 触发 | fps |
|---|---|---|---|
| idle 待命 | 静默呼吸 | 默认/回落 | 10 |
| working 作业 | 盯执行 | mood working | 12 |
| thinking 思考 | 整理证据 | mood thinking | 8 |
| alert 警觉 | 异常举牌 | mood alert/回传 | 10 |
| worried 担忧 | 现场冻结 | mood worried | 8 |
| happy 愉悦 | 消项回执 | mood happy | 12 |
| cheer 振奋 | 验收欢呼 | accept 消项（2.6s） | 14 |
| wink 俏皮 | 眨眼 | mood wink/唤醒 | 10 |
| sleep 休眠 | 久置打盹 | 无交互 75s（面板外任意键唤醒→wink） | 6 |
| salute 敬礼 | 接管报到 | boot 2.4s | 8 |
| command 指挥 | 派单/relay | spawn/relayTo 2.6s | 12 |
| typing 键入 | 全息键盘 | progress 命中当前线程 1.8s | 16 |

`ACTION_POSES=[cheer,command,salute]` 期间 mood 不覆盖 pose；结束 `forcePose(POSE_OF[mood])` 回落。

### 9.2 资产管线（四段）

```
ImageGen(绿幕全身, reference=现有立绘保 likeness)
  → assets/raw-v20/pose-*.png (8 新) / alt-*.png (12 第二帧)
  → _prekey-v20.mjs / _sheets-v20.mjs 内 chroma-key：
      gn=g-max(r,b); gn>40&&g>90 → alpha 0；gn>10&&g>70 → 羽化 alpha 并 g=max(r,b) 去绿边
  → assets/pose-*.png（单帧，图鉴缩略图真源）
  → assets/sheet-*.png（双帧 640×1920，回退真源）
VideoGen(first_frame_to_video, 首帧=绿幕 raw, 5s 720×1280, 固定机位纯绿背景)
  → assets/motion-*.mp4（不入库）
  → _motion-v20.mjs：浏览器内 video seek 12 帧于 [0.3dur, +min(1.15, .45dur)]
      逐帧 key → union bbox(pad 6) → 等比缩放 480×720 底对齐 → 竖叠 12 帧
  → assets/motion-sheet-*.png（480×8640，运行时真源）
  → 主姿态 4 个：叠 scene-bridge 裁切(0,12%H,40%W,88%H) → 22 帧 ping-pong 序
      → ffmpeg palettegen(diff)+paletteuse(bayer4) @12fps → assets/gifs/xiyin-motion-*.gif
```

### 9.3 运行时帧播放器

- `.character .spr{overflow:hidden}` 裁切窗；`img{width:100%; height:frames*100%; object-fit:fill}`（sheet 1:3 与窗 2:3×frames 精确同比例，无拉伸）。
- 单 rAF `tickMo`：dt 累积 → 每 `1000/fps` 步 `idx+=dir`，端点折返（**ping-pong 保证任意视频片段首尾相接循环无跳变**）→ `transform:translateY(-idx*100/frames%)`。
- `document.hidden` 暂停；`prefers-reduced-motion` 静帧 0；换 pose 120ms opacity 淡入淡出（无 scale/blur 晃动）。
- `setPose` 设 `mo.frames=MOTION[p]?12:2` + height；`img.onerror` 命中 motion-sheet 时回退 `SHEET_SRC[p]` 双帧（fps 降 1.6 防眨闪）。
- 粒子层 `.fx` 与帧动画解耦：confetti/spark/heart/bubble/zzz/sweat/keys+holo/beam/shine/ring 按 `POSE_META.fx` 发射；loop 类常驻至换 pose；reduced 全禁。

### 9.4 事件驱动接线

boot salute→idle；spawn/relay command→working；accept cheer→happy；progress typing→working；40s SAY 轮播、75s sleep、面板外 pointerdown/keydown 唤醒 wink；图鉴 playPose 直接演+台词。

### 9.5 验收锚点

12 卡缩略图几何（150px 定高，修 grid auto 行 height:100% 失效）、8 新形象逐一点换 src/naturalWidth、`height==='1200%'`、transform 五连采样有差异（修 ping-pong 采样别名）、GIF 存在、粒子 childElementCount>0。

### 9.6 为什么 PNG sheet 而不是 GIF（四轮用户提问的结论）

GIF：256 色/帧（赛璐璐渐变 banding）、**无 alpha**（绿幕抠图边缘脏）、体积大、**无法按姿态控速/暂停/静帧**。
PNG 竖叠 sheet + steps/rAF：全色全 alpha、每姿态独立 fps、隐藏页暂停、reduced-motion 静帧、缺源回退——游戏角色循环的标准做法。
 animated WebP/APNG 虽有 alpha 但同样不可控速，故不选。GIF 仅作为**叠好场景的预览交付物**（ffmpeg 调色板抖动保证观感）。

---

## 10. 音频 / 换色 / 键盘

- WebAudio：舰桥低鸣（55/82.4Hz triangle + lowpass LFO）+ 9 种 sfx（click/open/close/send/arrive/confirm/deny/warp）；首次指针/键解锁；HUD ♪ 一键静音（⌥M）。
- 换色三套 token（teal/sky/violet 轮换）+ 屏闪。
- 键盘：`⌘K` 主对话聚焦；`⌥M` 静音；`⌥W` 跃迁；`⌥D` 调试；`⌥C` 收起/展开；`⌥1` 最高优先决断线程；`⌥←/→` 切 tab；`Esc` 逐层（pop→banner→panel→full）；`1–9` 当前线程选项拍板。

---

## 11. 验证（_verify-v20.mjs）

运行：`cd docs/cabin-design && node _verify-v20.mjs`（需 playwright；GIF 断言需 ffmpeg 产物已生成）。
断言组（约 145）：

1. 启动：场景/立绘加载、boot salute、10 tab、右 menu 4 hex、通讯台与左右 hex 零重合、TUI mono 字体、无横溢。
2. 回传：banner 几何（右缘≤通讯台左缘、底≤立绘头顶+40）、立即激活、键盘拍板消项+happy。
3. 多 tab：三连/连发、选项就地、切 tab、resolve-all 后未读红点（含主对话回执）、点 tab 消点、tab 关闭/回主/编队重开。
4. 模型/账本：pro-max 切换+toast、200k ctx 重算(>80%)、effort、ledger 四格+按模型+作战行→detail。
5. 舱籍/编队/详情：4 项目卡+ff-only、fleet filter=3 行、行💬直达、6 页签、去决断→选项、▦ 重开 focus、头部 hex≥3、文件树/spec 预览/e2e 筛选、调试单行+轮尺+五页签+快照复制 toast、谈这条关面板、决断卡▦详情。
6. 图鉴/动作：12 卡+缩略图几何、8 新 sheet 逐一点换、1200% 高、transform 推进、粒子、accept→cheer。
7. 同步：relay 署名进作战线程、直连→主对话「同步：」。
8. 动画：连发≥4 决断、编队行/决断卡 arrived、hex 环（开面板后主动单条保证确定性）。
9. 通讯台：收起 hidden+pill、pill 展开、grip 拖拽 +120px、双击复位。
10. 多窗口：弹出×2、WINDOWS 条、最小化/chip 恢复、窗内发送落本线程、关闭×2 条隐藏；dock 与 bar/clock 零相交；移动端 dock+bar 共存且 pill 在视口内。
11. 跃迁/音效/稳定性：warp 换场景、场景点回舰桥、静音态、6 次 tab churn+2 单条后结构 intact。
12. 三档视口：无横溢、通讯台/输入在视口内、移动发送、model pop 在视口内、banner 在视口内。

结果：连续多轮 **0 console error / 0 pageerror / 0 ASSERT FAIL**；截图 `shots-v20/`（不入库）。

---

## 12. 资产与入库边界

| 路径 | 角色 | 入库 |
|---|---|---|
| `cockpit-v20.html` | 成品原型 | ✅ |
| `_verify-v20.mjs / _prekey-v20.mjs / _sheets-v20.mjs / _motion-v20.mjs` | 验收/抠图/双帧/多帧+GIF 管线 | ✅ |
| `assets/pose-*.png`(12) | 单帧立绘（图鉴缩略图/回退帧 A） | ✅ |
| `assets/sheet-*.png`(12) | 双帧 sheet（回退真源，640×1920） | ✅ |
| `assets/motion-sheet-*.png`(12) | 12 帧 sheet（运行时真源，480×8640，合计≈32MB） | ✅ |
| `assets/gifs/xiyin-motion-{idle,typing,cheer,command}.gif` | 无缝预览（22 帧@12fps，各≈215KB） | ✅ |
| `assets/scene-*.png / crew/*.png` | 场景三板/汐音头像九 mood | ✅（沿用） |
| `assets/raw-v20/`(20)、`assets/alt-*.png`(12)、`assets/motion-*.mp4`(12) | 绿幕源/第二帧/视频源（可再生） | ❌ gitignore |
| `vibe_images/ vibe_videos/` | 生成工具落盘原始产物 | ❌ gitignore |
| `shots-v20/` | QA 截图 | ❌ gitignore |

---

## 13. 复现与再生

```bash
cd docs/cabin-design
node _prekey-v20.mjs                 # 8 新绿幕 → 透明 pose（需 raw-v20/pose-*.png）
node _sheets-v20.mjs                 # 12 姿态 alt 抠图 + 双帧 sheet（需 raw-v20/alt-*.png）
node _motion-v20.mjs [pose ...]      # 视频 → 12 帧 sheet + 主姿态 GIF（需 assets/motion-*.mp4 + ffmpeg）
node _verify-v20.mjs                 # 全量验收（需 playwright）
```

视频再生要点（VideoGen first_frame_to_video）：首帧=对应绿幕 raw；prompt 必含 *locked-off static camera / no zoom·pan·cuts / flat solid #00FF00 background at all times / same scale centered / smooth continuous 2D cel-shaded motion* + 姿态专属循环动作描述；5s · 720×1280。
注意：内容审核对军事化措辞敏感（command 首审被拒），改用「confident presenting gesture / speaks brightly」类措辞重试通过。

---

## 14. 非目标与已知限制

- 全 mock：不接 server/真实 worktree/真实账本；数据语义对齐真实项目（design 21/24/25/26、task-home、models.yaml、debug-inspector）但值为种子。
- 帧循环为 ping-pong：非周期动作（如挥手方向）会折返，观感自然但非物理周期；如需单向循环需视频首尾匹配或更长抽帧窗。
- 单激活 sheet 解码内存≈16MB（480×8640×4）；换 pose 释放旧图；12 sheet 全载才会到 ~200MB，当前设计避免。
- GIF 为 256 色调色板抖动预览，边缘略损；运行时真源始终 PNG alpha。
- 浮窗上限 5；file:// 下 clipboard 走 execCommand 回退；移动端浮窗与回传 banner 短暂叠层（通知优先，可 ✕/10s 自隐）。
- 后续候选：场景自动巡航循环、立绘口型、sheet 横向打包降高、真实 server 决策账本对接（沿用 v19 非目标）。