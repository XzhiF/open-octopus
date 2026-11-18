# 33 · 指挥舱 v22 实现规格（纯视频立绘 → web-app）

> 状态：**已落地**（2026-11-19）· 原型真源：`../cockpit-v22.html`（自包含 HTML）
> 基线：v21 已落地 `packages/web-app`（规格 `31-cockpit-v21.md` / 收口 `32-cockpit-v21-fidelity-plan.md`）。
> 本文只记 v22 的三件事：**立绘换纯视频（13 支）**、**动作图鉴换 13 片段**、**立绘左移 36px 把宽度给通讯台**。
> 不改路由、不改 classic、不改数据层 mood 词表。

---

## 0. 增量总览

| # | v22 能力 | 原型 | 生产落点 |
|---|---|---|---|
| 1 | 立绘 = 纯视频（无静图） | `.character > video.mv` | `crew/CockpitPoseSprite.tsx` 重写为 `<video>` |
| 2 | 13 支片段单源 + 旧/新批次 | `CLIPS[]` | `crew/pose-model.ts` 新增 `CLIPS` / `POSE_CLIP` |
| 3 | 动作图鉴 = 13 片段（悬停预览 / 点击跳段） | `[data-clip]` + `.posecard .cv` | `panels/CockpitPosesPanel.tsx` 重写 + `panels.css` |
| 4 | 立绘左移 36px，宽度给主通讯台/作业面/提示条 | `--charshift:36px` | `base.css --ck12-charshift` + `crew.css` / `face.css` / `fx.css` / `chat/geometry.ts` |
| 5 | 片段下标进状态（图鉴金边按片段，不按姿态合并） | `state.clip` | `cockpit-state.ts` / `CockpitStateProvider` 新增 `clip` |

**不迁的部分**：原型「点立绘 = 顺序播下一支」是**验收入口**（原型注释明确写了正式实现必须由真实状态/事件驱动）。
生产保持 v13 起的铁律 **点立绘 = 跟她说话**；顺序轮播由图鉴与真实事件（mood / 派单 / 报到 / 回复中）承担。

---

## 1. 片段资产与顺序

资产真源 `docs/cabin-design/assets/v22/`（原型与全舱共用，不复制进 `public/`）：

| # | 文件 | pose | 批次 |
|---|---|---|---|
| 01 | `01-wink.webm` | wink | 旧 |
| 02 | `02-thinking.webm` | thinking | 旧 |
| 03 | `03-command.webm` | command | 旧 |
| 04 | `04-alert.webm` | alert | 新 |
| 05 | `05-concerned.webm` | concerned | 新 |
| 06 | `06-command.webm` | command | 新 |
| 07 | `07-idle.webm` | idle | 新 |
| 08 | `08-ready.webm` | ready | 新 |
| 09 | `09-smile.webm` | smile | 新 |
| 10 | `10-thinking.webm` | thinking | 新 |
| 11 | `11-typing.webm` | typing | 新 |
| 12 | `12-wink.webm` | wink | 新 |
| 13 | `13-working.webm` | working | 新 |

- 13 支 = 旧 3 + 新 10；command / thinking / wink 各出现两次，**按片段各自保留**。
- 图鉴缩略图：`assets/v22/thumbs/NN-pose.png`（视频 1.2s 抽帧，320×480）。
- 生成管线：`_motion-v22.mjs`（ffmpeg `colorkey` + `despill` → 并集 bbox 裁切 → 统一归一化 → `libvpx-vp9 -auto-alt-ref 0 -pix_fmt yuva420p -crf 24 -colorspace bt709 -color_range tv`）。

## 2. 归一化（13 支同一目标，所以比例/大小一致）

| 项 | 值 |
|---|---|
| 输出画布 | 768 × 1152（2:3，与 `.ck12-crew` aspect-ratio 一致） |
| 人物高 | 1040 |
| 脚底基线 | 1105 |
| 躯干中轴 | 384（画布中线） |
| 帧率 | 30（源即 30fps，不抽帧） |

按**逐帧中位数**（而非单帧）对齐，避免抬手/浮动帧把基线拉偏；验收容差：人物高极差 ≤12px、脚底 ≤8px、中轴 ≤12px。

## 3. 渲染模型（pose-model）

```
mood（语义，数据层不改名）
  → MOOD_POSE → pose
  → POSE_CLIP → 片段下标（同 pose 取最早一支）
  → CLIPS[i].src（<video>）
```

- `cheer` / `sleep` 没有专属片段：落到语义最近的 `smile`（09）/ `idle`（07）。
- `POSE_SRC` 仍保留，但**只用于视频解码失败兜底**；正常路径全程视频（满足「纯视频」）。
- 组件细节：
  - `playing` 事件后才淡入（opacity 0→1，0.22s），切段先压回 0，防闪黑；
  - `document.hidden` 暂停，回来续 play；
  - `prefers-reduced-motion`：不自动播，`currentTime=0.5` 停在视频真源的一帧；
  - 失败不永久降级：`failedSrc === src` 才用静图，换段自动重试。
- `octopus:crew-pose` 事件 payload 扩展 `clip?: number`：图鉴点卡可精确播放重复姿态的第二支。

### 3.1 待命自走（v22.1：让她“动起来”）

只靠 mood 驱动时，待命会一直循环 07-idle，观感固定。增加两条动效：

| 机制 | 规则 |
|---|---|
| 待命自走 | **真空闲**（无动作 override / 不在回复或倾听 / 语义姿态 = idle）时，首支 3.5–6s、之后 7–11s 随机换一支日常片段；池 = 07 idle / 09 smile / 12 wink / 10 thinking / 08 ready / 13 working / 02 thinking(旧) / 03 command(旧)，**不含 alert / concerned / typing** |
| 重复姿态交替 | command / thinking / wink 各两支片段，事件生成时在变体间交替（这次 A、下次 B），不再每次都同一支 |

优先级：`动作点名（图鉴/事件） > 待命自走 > pose 首选片段`。任何对话、动作、倾听、reduced-motion 都会立即结束自走；回到 idle 后重新起算。

## 4. 图鉴（CockpitPosesPanel）

- 标题：`汐音动作视频` / `CLIP GALLERY · 13`。
- 每卡：缩略图（2:3，`object-fit: contain`）+ 悬停/聚焦自动预览 + 角标 `NN · 旧/新` + 中文名/英文名/描述。
- 悬停预览用 `preload="none"`，不悬停不下载；reduced-motion 下隐藏视频层。
- 点卡：关面板 + 派发 `{ pose, clip, ms:2600 }` → 立绘就地演 + 粒子 + 台词 + toast。
- 金边按 `state.clip`（不是 pose），重复姿态也能区分当前段。

## 5. 布局（左移 36px）

同一变量 `--ck12-charshift: 36px`（`base.css`）喂给：

| 落点 | 公式 |
|---|---|
| 立绘 `crew.css` | `left: railw + 16 - shift` |
| 通讯台 `chat/geometry.ts` | `left: railw + 16 + charw - 22 - shift`（宽屏分支；≤900 sheet 不变） |
| 底栏 `base.css .ck12-cmd` | `padding-left: railw + 16 + charw - 22 - shift` |
| 作业面 `face.css` / quiet / loading | `railw + charw + 10 - shift` |
| 回传 banner `fx.css` | `left: max(railw + 12 + min(390, charw-54)/2, railw + 16 - shift + charw/2)` |

- 1600 宽：立绘可见左右空隙各 84px；通讯台加宽 36px。
- banner 用 `max()` 夹在「编队右缘 + 12px」与「立绘中轴」之间，任何宽度都不压左侧编队。
- ≤900 的竖排 sheet 布局不使用 shift。

## 6. 与原型不得不偏离的项（差异登记）

| 项 | 原型 | 生产 | 理由 |
|---|---|---|---|
| 点立绘 | 顺序播下一支（验收入口） | 跟她说话（保留 v13 铁律） | 原型注释要求正式实现由真实状态驱动；对话入口不能丢 |
| 无专属片段的 pose | `setPose('cheer')` 静默无效 | 映射到 smile / idle 片段 | 生产 mood 词表保留 cheer/sleep，不能出现空白立绘 |
| 视频失败 | 保持透明 | 单帧 pose PNG 兜底 | 生产韧性；正常路径不触发，仍是纯视频 |
| 标签 | `汐音 · 俏皮 · 1/13` | `汐音 · 全域助理 · 俏皮 · 07/13` | 沿用生产 XIYIN 状态标签，补片段计数 |

## 7. 验证

- `pose-model.test.ts`：13 支顺序/批次/重复姿态/URL、pose↔clip 映射、回环、mood 双向映射。
- `geometry-v20.test.ts`：1600 / 1200 通讯台左缘各左移 36（600 / 374）。
- `CockpitCrew.test.tsx`：点立绘=说话、ready 报到、图鉴事件仍走 action pose。
- `e2e/tests/cockpit-v20.spec.ts`：立绘 `<video>` 播放 07-idle、图鉴 13 卡、旧/新角标、点 09 跳段。
- 构建：`packages/web-app` `vite build` 成功，dist 产出 13 支 webm（约 43MB）。
