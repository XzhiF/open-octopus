# 18 · 新建作战舱 v4：实现计划

> 依据：原型 `docs/cabin-design/cabin-new-v4.html` · 设计 `design/17-cabin-new-v4.md` · 位置稿 `design/16-cabin-new-v3.md`
> 范围：把「新建作战舱」从**单页表单**改成**居中大输入框 + 她取名 + 目录/项目两颗控件**，并在壳里做成**左栏一行草稿 + 右边一页**。
> 状态：**计划**，未开始实现。本文按 P0→P5 给出可独立验收的批次。

---

## 1. 目标与不变量

**目标**：点「新建作战舱」→ 左栏立刻多一行草稿 → 右边一页大输入框 → 你只说需求（+ 可选目录/项目）→ 她给你一个舱名和初始化意见 → 你点头 → 真的建。

**不变量**（实现时逐条守住）：

| # | 不变量 | 为什么 |
|---|---|---|
| I1 | **需求是唯一必填**。没有需求，「开始创建」不可用 | 用户："中间的大输入框是必须说出需求的" |
| I2 | **没有舱名字段**。名字由她给，可改；改了只是称呼 | 用户："不用自己起名字…它才会真正建立它的名字" |
| I3 | **一个目录只能有一个舱**。已有舱的目录只能"打开"，不能建 | 用户："不允许在同一个目录创建多个作战仓" |
| I4 | **不选目录 = 新建工作空间**，跟着任务目录同族，不额外解释 | 用户："不选择目录的话，默认是新建工作空间…不需要特意提及" |
| I5 | **项目是关联，不是拷贝**；可跨多个 org 同时绑 | 用户："绑定项目是一种关联的关系，支持跨多 org" |
| I6 | **确认前零写操作**：不建目录、不落库、不接仓库 | v2/v3/v4 一致；取消无需二次确认 |
| I7 | **取消安全**：`×` 只丢草稿；走开（切舱/切任务）草稿留着 | 用户："有时候我没想好，我其实也可以取消的" |
| I8 | 汐音是**大立绘 + 登场动效**，不是角落小徽章 | 用户："像新建任务那样的意外效果…小小一片太小气" |

**非目标**（本计划不做）：

- workspace 数据模型重设计（用户已说"工作空间到时候要稍微设计一下"）；本计划只加"舱 → 目录 → 项目关联"的读写。
- 多份草稿并存（与 `pendingTask` 一致，本计划单草稿）。
- 窄屏左栏抽屉化（沿用现有 mobile Sheet）。
- 用 LLM 取名（v1 用确定性启发式，见 §8；接口留好）。

---

## 2. 现状（要改的东西在哪）

| 文件 | 现状职责 | 本计划动作 |
|---|---|---|
| `packages/web-app/components/cabin/cabin-mode.tsx` | `drafting` 布尔 + `startDraft/cancelDraft`；`openCabin` 时 `setDrafting(false)`（**一走开草稿就丢**） | 拆成 `draft: CabinDraft \| null` + `draftOpen`，加 `updateDraft/closeDraft`，落 localStorage |
| `packages/web-app/components/agent/chat/ChatTab.tsx:730` | `drafting ? <CabinDraftPane/> : …` | 换成 `<CabinCreateHero/>`，bridge 增加 `draft` 与回调 |
| `packages/web-app/components/agent/chat/chat-sidebar.tsx:497` | 作战舱段只有列表 + `＋`，**没有草稿行** | 新增 `pendingCabin` 行（照抄 `:581` 的 `pending-task-item`） |
| `packages/web-app/components/cabin/CabinDraftPane.tsx` | 内联表单容器（标题 + `CabinNewForm`） | 退役（保留一个 release 作为回退） |
| `packages/web-app/components/cabin/CabinNewForm.tsx` | 名称/目录/org/仓库/需求 → `createCabin` → `initCabin` | 拆解：目录对话框抽走，其余逻辑搬到新 hero；组件退役 |
| `packages/web-app/components/cabin/CabinNewHero.tsx` | `/cabin/new` 深链兜底页 | 保留为"打开桌面里的新建页"的跳板 |
| `packages/web-app/lib/cabin-api.ts` | `createCabin/attachCabin/initCabin/listCabins` | 增 `projects[]`、`created` 标记、`path` 可选 |
| `packages/server/src/routes/cabins.ts:137` | `GET /api/cabins`（列表，含 path）、`POST /api/cabins`（`name/path/requirements/org/repos`） | body 扩展 `projects[]`、`path` 可省略；响应加 `created` |
| `packages/server/src/services/cabin/cabin-service.ts:161` | `create()`：`findByPath` 命中就**静默返回已有行**；`workspaceSlug()` 由 path 派生 | 暴露 `findByPath`；自动目录；`projects` → `config.json` 带 group |
| `packages/server/src/services/cabin/cabin-init-service.ts:208,223` | gate 3/4 用**舱级 `row.org`** 克隆所有仓库 | 改成**按条目 org**（`entry.group`），支持跨 org |
| `packages/server/src/services/cabin/cabin-repos.ts:46,85` | `CabinRepoEntry{name,group}`；`ensureRepoCloned(org,name)` | 调用点改为 `ensureRepoCloned(entry.org ?? row.org, name)` |
| `packages/web-app/components/agent/chat/cwd-picker.tsx` | 已有的目录选择（弹层 + Dialog + `browseDirectories`） | 抽出 `DirectoryBrowserDialog` 复用（带 `lockedPaths`） |
| `packages/web-app/components/chat-workbench/task-project-chip.tsx` | 项目多选，**切 org 会清空选择** | 新写 `CabinProjectBinder`（多 org 聚合 + 搜索），不复用它 |
| `packages/web-app/hooks/use-cabins.ts` | 30s 轮询列表 | 复用；新增 `refresh()` 在创建后调用 |
| `packages/web-app/lib/api-client.ts:50,85` | `browseDirectories`、`fetchManifestRepos(org)` | 复用 |

---

## 3. 差距清单

| ID | 差距 | 批次 |
|---|---|---|
| G1 | 壳里没有"舱草稿"行；走开就丢草稿 | P1 |
| G2 | 新建页是表单，不是"大输入框 + 她取名" | P2 |
| G3 | 没有"她取名 + 初始化意见 + 你点头"这一步 | P2 |
| G4 | 没有目录选择窗（只有 `browseDirectories` 弹窗在小表单里） | P2 |
| G5 | 项目只能单 org，且切 org 清空 | P0（服务端）+ P2（UI） |
| G6 | 一个目录已有舱时，服务端静默复用、客户端无提示 | P0 + P2 |
| G7 | 不选目录时无法建（`path` 必填） | P0 |
| G8 | 汐音只有 84px 徽章级存在 | P2 |
| G9 | `/cabin/new` 与桌面内两套入口 | P4 收口 |
| G10 | 无覆盖新流程的测试 | P3 |

---

## 4. P0 · 数据契约（server，可独立合并）

### 4.1 `POST /api/cabins` 扩展

```ts
// createBodySchema
{
  name: string                       // 仍必填；v4 由客户端算好传（见 §8）
  path?: string                      // 新增可选：省略 = 新建工作空间
  requirements?: string              // v4 = 用户那段需求原文
  org?: string | null                // 保留：注册表默认 org / 单 org 兼容
  repos?: string[]                   // 保留：老调用方
  projects?: { org: string; repo: string }[]   // 新增：跨 org 关联
}
```

- **`path` 省略**时服务端生成：

  ```
  ~/.octopus/workspaces/cabin-<MMDD>-<HHmmss>-<rand6>
  ```
  与 dev 库里任务的真实目录 `~/.octopus/workspaces/task-<slug>-<MMDD>-<HHmmss>-<rand>` 同族。
  `workspaceService.create()` 已经会 `mkdir -p` 并把 `projects/ .octopus/ pipeline.yaml` 铺好（`services/workspace.ts:264`），所以不需要额外建目录代码。
  > 顺手清理：`workspaceSlug()`（`cabin-service.ts:124`）会对 `cabin-…` 再前缀一次，产出 `cabin-cabin-…`；在 slug 已以 `cabin-` 开头时不再重复。

- **`projects[]` 优先于 `org+repos`**；两者都给时以 `projects` 为准。写入 `config.json`：
  ```json
  { "name": "…", "repos": [ { "name": "ledger", "group": "XzhiF", "repoName": "ledger" } ] }
  ```
  `CabinRepoEntry.group` 已存在（`cabin-repos.ts:46`），这里只是把它填上。

### 4.2 一个目录一个舱（I3）

`CabinService.create()` 今天命中同路径就**静默返回已有行**（`cabin-service.ts:162`）。保持不报错（不破坏老调用方），但让调用方知道：

- `CabinService` 新增 `findByPath(path): CabinRow | undefined`（DAO 已有）。
- 路由响应加 `created: boolean`：

  ```json
  { "cabin": { … }, "created": false }
  ```

- 客户端：`created === false` → 不发 init，直接 `openCabin(cabin.id)`，并 toast"这个目录已经是「X舱」了"。

> 不改成 409 的理由：`CabinNewForm` 的 `catch → attachCabin` 依赖现有语义；改状态码会把"复用"变成"错误"，牵连 attach 与测试。`created` 标记已足够让 UI 表达硬规则。

### 4.3 跨 org 仓库（gate 3/4）

- `cabin-init-service.ts:208` gate `clone`：
  ```ts
  const entries = readCabinConfig(row.path).repos.filter((r) => r.name)
  if (!entries.length) { item.sub = "无仓库"; return }
  for (const e of entries) ensureRepoCloned(e.group || row.org || "", e.name)
  ```
  去掉 `if (!row.org) throw`，改成"每个条目都要有可解析的 org，否则该条失败"。
- gate `mainline`（`:223`）同样按条目解析 org；worktree 仍落在舱目录 `projects/<repo>` 下，不改路径。
- 单测：`cabin-init-service` 现有用例补一条"两个 org 的仓库同时克隆"（用 `runOrchestratorTurn` 注入 + 临时目录）。

### 4.4 退出标准（P0）

- [ ] `POST /api/cabins` 不带 `path` 能建舱，目录出现在 `~/.octopus/workspaces/cabin-…`。
- [ ] 带 `projects:[{org:'XzhiF',repo:'ledger'},{org:'acme',repo:'billing'}]` 能建，`config.json` 两条 group 正确；init gate 3 两个仓都克隆。
- [ ] 同目录二次 `POST` 返回 `created:false` + 同一个 cabin id；不新增行。
- [ ] 旧调用（`org+repos`、必填 `path`）全部行为不变，现有 server 测试绿。

---

## 5. P1 · 壳：草稿行 + 草稿态

### 5.1 `cabin-mode.tsx`

```ts
export interface CabinDraft {
  name: string            // 她算出来的；空 = 未命名
  path: string | null     // null = 新建工作空间
  projects: { org: string; repo: string }[]
  requirements: string    // 大输入框原文
  updatedAt: number
}
interface CabinModeValue {
  draft: CabinDraft | null
  draftOpen: boolean
  startDraft(): void
  updateDraft(patch: Partial<CabinDraft>): void
  closeDraft(): void      // 走开：保留 draft，只 draftOpen=false
  cancelDraft(): void     // 丢弃
}
```

- `startDraft()`：`draft ??= 空草稿`，`draftOpen = true`，`activeCabinId = null`。
- `openCabin(id)`：只 `draftOpen = false`（**不改 `draft`**）。
- `cancelDraft()`：`draft = null; draftOpen = false`。
- 持久化：`localStorage['octopus.cabinDraft.v1']`，读入时 `updatedAt` 超过 24h 丢弃。
- 现有 `cabin-mode.test.tsx` 的 `drafting` 断言改写为 `draftOpen`；补"走开再回来草稿还在"。

### 5.2 `chat-sidebar.tsx` 草稿行

- 新 prop `pendingCabin?: { name: string } | null`；渲染在 `cabin-section` 首行。
- 结构复用 `pending-task-item`（`:581`）：`ping` 呼吸点 + 名字 + 「草稿中」+ hover `×`。
- 名字：`draft.name || '未命名舱'`。
- `×` → `onCancelDraft()`（不弹确认）。
- 计数 `count + 1`；键盘：`Enter` 打开草稿。
- 单测：`chat-sidebar-cabin.test.tsx` 补草稿行存在/悬停删除/计数。

### 5.3 `ChatTab` 挂载

- `cabinBridge` 增加 `draft`、`onUpdateDraft`、`onCloseDraft`、`onCancelDraft`。
- 渲染：`draftOpen ? <CabinCreateHero …/> : …`。
- 右页头部（tab 条）沿用现有对话区顶栏样式，标题 = `draft.name || '新建作战舱'`，状态 chip = `草稿 / 待确认 / 已创建`。

### 5.4 退出标准（P1）

- [ ] 点「新建作战舱」：左栏出现「未命名舱 · 草稿中」，右页出现新建页（P2 前可用占位）。
- [ ] 点别的舱 → 右页切过去，草稿行仍在；点草稿行 → 回到新建页，状态不丢。
- [ ] `×` → 行消失、计数 −1、零请求。
- [ ] 刷新页面：草稿仍在（24h 内）。

---

## 6. P2 · 新建页 `CabinCreateHero`

新文件：`packages/web-app/components/cabin/CabinCreateHero.tsx` + `cabin-create.css`（或 Tailwind 类 + 少量 keyframes）。

### 6.1 结构与状态

```
<div data-testid="cabin-create-hero">
  <XiyinStage mood={mood} />                      // 286×330 立绘 + 登场 + 说话
  <h1>{bubble}</h1> <p>{subline}</p>
  <BigComposer>                                    // 760 宽、居中
     <textarea data-testid="cabin-req-input" />    // I1：需求唯一必填
     <ConflictBanner />                            // I3
     <DirChip /> <ProjectChip /> <SendButton />
  </BigComposer>
  <ProposalCard />                                 // 提交后
</div>
```

状态机：

```
compose ──(提交，需求非空)──▶ propose ──(就按这个开)──▶ creating ──▶ done ──▶ (进入舱)
   │                              │
   │                              └─(回去改需求)─▶ compose（原文还在）
   └─(选中已有舱目录)─▶ 冲突态：主按钮 = 打开「X舱」，点它直接进舱
```

`mood`: `greet | listen | think | done` → `crew/xiyin-*.png`（**按画面挑，不要用 `moodPortrait`，名字错位见 `design/14` §10**）。

### 6.2 目录控件（G4 + I3 + I4）

- chip 默认文案 **「新建工作空间」**；选中目录后显示 `basename(path)`；tooltip 给全路径。
- 点开弹层（`data-testid="cabin-dir-pop"`）：
  1. `新建工作空间`（默认档，右注「第一次创建时建」）
  2. `已经有的舱`：`useCabins()` 的列表（名字 + path，标「已有舱」）
  3. `最近用过`：`localStorage['octopus.cabinDirRecent.v1']`（最多 4 条，去重已有舱的 path）
  4. `选择目录…` → `DirectoryBrowserDialog`
- `DirectoryBrowserDialog`（从 `cwd-picker.tsx` 的 Dialog 抽成 `components/cabin/DirectoryBrowserDialog.tsx`）：
  - props：`open, initialPath?, lockedPaths: Map<path, cabinName>, onPick(path), onOpenCabin(id), onClose`
  - 复用 `browseDirectories`（上级 / 根 / 列表 / `canSelect`）；`lockedPaths` 命中的目录打标「已是「X舱」」，**主按钮换成「打开「X舱」」**。
- 选中 `lockedPaths` 的目录（含从"已经有的舱"点进来）：
  - 主按钮变「打开「X舱」」，点它 `onOpenCabin(id)`；
  - 输入框上方出现琥珀提示条（文案见 §6.4）；
  - 需求为空时按钮也可点（打开不需要需求）。

### 6.3 项目控件（G5 + I5）

新文件 `components/cabin/CabinProjectBinder.tsx`：

- 数据：`useOrgs()` 拿 org 列表 → 并行 `fetchManifestRepos(org)`，聚合为 `{ org, repo, group }[]`（缓存 60s，避免每次开面板都打）。
- UI：搜索框（自动聚焦，按 repo/org 过滤，命中高亮）→ 已选条（可单独移除）→ 按 org 分组列表（`org + 计数`，勾选）。
- 选择项 key：`${org}/${repo}`；**跨 org 不清空**（这是与 `TaskProjectChip` 的关键差别）。
- chip 摘要：`repo +N`；`data-testid="cabin-project-chip"`。
- 空/失败态：某 org 拉不到 manifest → 该组显示"注册表读取失败，可稍后再绑"，不阻塞创建。

### 6.4 提交与提案

- `BigComposer` 的提交按钮：`data-testid="cabin-create-submit"`，`disabled = !req.trim() && !conflict`。
- `⌘⏎`/`Ctrl+⏎` 等价；`⇧⏎` 换行。
- 提交后 `ProposalCard`（`data-testid="cabin-proposal"`）：
  - 「你说」一段（最多 3 行，超出裁切）
  - 「舱名」`<input data-testid="cabin-name-input" value={name} />` + 一句为什么
  - 「目录 / 项目 / 初始化」三行
  - `[回去改需求]` `[就按这个开]`（`data-testid="cabin-confirm"`）
- 冲突提示文案（统一一处常量，便于文案回归）：
  > 这个目录已经是「{name}」了 —— 一个目录只能有一个舱，不能在这里再建一个。

### 6.5 样式与动效

- 尺寸/间距照原型：立绘 286×330（`≤900` 240×280，`≤640` 196×230）、composer `min(760px,100%)`、卡片 14px 圆角。
- 立绘：`mix-blend-mode:screen` + 椭圆遮罩 + 背后柔光（吃掉黑底方框）。
- 登场：上浮 18px 淡入 750ms、光圈 1.35s、7 颗星屑、台词逐字 26ms。
- `prefers-reduced-motion: reduce` 全关（不动画、逐字直接出全文）。
- 布局铁律：勾选/展开**只向下长**；草稿→提案→完成，按钮纵向位置不变（`min-height` 由容器给定，不给卡片）。

### 6.6 退出标准（P2）

- [ ] 一屏只有：立绘、一句、大输入框、两颗控件、主按钮；没有舱名字段。
- [ ] 需求为空：按钮 disabled；有需求无目录：可直接提交（I4）。
- [ ] 目录弹层四条 + 选择窗可逐层进入；已有舱目录被拦住并只能"打开"。
- [ ] 项目面板可搜、可跨 org、已选条可删。
- [ ] 提交 → 她的名字 + 初始化意见；名字可改，左栏草稿行同步。
- [ ] reduced-motion 下无动画。

---

## 7. P3 · 创建时序

```
[就按这个开]
  ├─ 计算 name（§8）与 requirements（原文）
  ├─ cabin = await createCabin({ name, path: draft.path ?? undefined, requirements, projects })
  ├─ if (!created)  → toast「这个目录已经是「X舱」了」→ openCabin(cabin.id) → 结束
  ├─ await initCabin(cabin.id)                     // 让 gate 在后台跑；失败不阻塞进舱
  ├─ refresh()（useCabins）→ 草稿行替换为正式舱行
  └─ openCabin(cabin.id)
```

- **失败**：`createCabin` 抛错 → 留在提案页，按钮回「就按这个开」，toast 错误；不丢需求。
- **init 失败**：照样进舱，舱内 `CabinInitGateCard` 已经能重试（`retryCabinInit`）。
- **零残留**：`cancelDraft` 只清 localStorage 草稿，不发请求。
- **埋点**（可选）：`cabin_create_started/completed/abandoned`，字段只含 `has_path/has_projects/req_len`。

### 退出标准（P3）

- [ ] 全链路：需求 + 无目录 → create（path 由服务端生成）→ init → 进舱，第一句是门禁 7 的 agent 回合。
- [ ] 已有舱目录：`created:false` → 直接进舱，`POST /:id/init` 计数 0。
- [ ] 取消/关闭页面：`POST /api/cabins` 计数 0。
- [ ] 提案页改名字后创建，舱名与左栏一致。

---

## 8. 取名逻辑（`lib/cabin-draft.ts`）

v1 **不用 LLM**（无延迟、可测、离线可用）：

```ts
export function proposeCabinName(req: string): { name: string; why: string }
// 关键词表：电商/商城/订单/库存→电商舱…；健康/体检→健康舱；对账/账本→账本舱；知识/文档→知识舱…
// 未命中：去掉动词前缀后取前 2–4 字 + 舱；仍空 → 「新舱」
export function whyName(req: string, name: string): string
export function makeAutoDir(now = new Date()): string   // 仅用于前端展示预测；真实路径由服务端返回
export function draftPatchFromText(text: string): Partial<CabinDraft>  // 预留：一句话里带目录/仓库时的抽取
```

- 名字长度限制 16（与原型一致）；服务端 `name.min(1)` 已满足。
- 预留 `proposeCabinNameAsync(req, signal)` 的调用位（下一步接 agent 命名时，只换实现不改 UI）。
- `requirements` 直接存需求原文；init gate 6 会写进 `.cabin/requirements.md`，门禁 7 的 agent 读它提 M1（已实现）。

---

## 9. 测试计划

| 层 | 文件 | 用例 |
|---|---|---|
| server 单测 | `services/cabin/__tests__/cabin-service*.test.ts` | 自动路径生成；`findByPath`；`projects` → config group；`created` 语义 |
| server 单测 | `services/cabin/__tests__/cabin-init-service*.test.ts` | gate 3 两 org 克隆；条目缺 org 时该条失败但不炸整门 |
| web 单测 | `components/cabin/__tests__/cabin-mode.test.tsx` | 草稿保留/丢弃/24h 过期；`openCabin` 不丢草稿 |
| web 单测 | `components/agent/chat/__tests__/chat-sidebar-cabin.test.tsx` | 草稿行渲染/计数/悬停 × |
| web 单测 | `components/cabin/__tests__/CabinCreateHero.test.tsx`（新） | 需求空禁用；提交出提案；改名同步；冲突条 + 按钮文案；`⌘⏎` |
| web 单测 | `components/cabin/__tests__/CabinProjectBinder.test.tsx`（新） | 搜索过滤/高亮/无结果；跨 org 累加；移除；manifest 失败降级 |
| web 单测 | `components/cabin/__tests__/DirectoryBrowserDialog.test.tsx`（新） | 上级/根/进入；`lockedPaths` 打标 + 主按钮换"打开" |
| e2e | `e2e/tests/cabin-create.spec.ts`（新） | 见 §11 验收 1–8（mock 掉慢 init） |

命令：

```bash
npx vitest run --project @octopus/web-app
npx vitest run --project @octopus/server
pnpm lint && pnpm build
OCTOPUS_E2E_WEB_PORT=3011 npx playwright test e2e/tests/cabin-create.spec.ts
```

---

## 10. 批次与工作量

| 批次 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| **P0** | 服务端契约（projects/自动目录/created/跨 org gate） | — | 1.5 天 |
| **P1** | 壳：草稿态 + 左栏草稿行 + 挂载 | P1 内部 | 1 天 |
| **P2** | 新建页：立绘 / 大输入框 / 目录窗 / 项目面板 / 提案 | P0、P1 | 2.5 天 |
| **P3** | 创建时序 + 错误路径 + 进舱 | P0、P2 | 0.5 天 |
| **P4** | 收口：退役 `CabinNewForm/CabinDraftPane`、`/cabin/new` 跳转、文案统一 | P3 | 0.5 天 |
| **P5** | 测试补齐 + 真机走查（1440/900、560/880、reduced-motion） | 全部 | 1 天 |

每个批次单独可合并；`CabinCreateHero` 用常量开关（`CABIN_CREATE_V2`）在 P2 期间与旧表单并存，P4 删开关。

---

## 11. 验收清单（实现完成时逐条勾）

1. 点新建 → 左栏「未命名舱 · 草稿中」+ 右页大输入框；**没有模态**、没有下一步。
2. 需求为空 → 主按钮不可用；填了才亮。
3. 不选目录 → 直接提交：提案写「新建 `~/.octopus/workspaces/cabin-…`」，与任务目录同族。
4. 点目录 chip → 默认档 / 已有舱 / 最近 / 「选择目录…」；选择窗可上级、切根、进入、选当前。
5. 选到已有舱目录 → 琥珀提示 + 主按钮「打开「X舱」」；点它只进舱，`POST /api/cabins` 计数 0。
6. 项目面板：搜索（名称/org）命中高亮、无结果文案、已选条可删、跨 org 累加。
7. 提交 → 她给名字 + 目录/项目/初始化三行；改名同步左栏；「回去改需求」原文不丢。
8. 「就按这个开」→ 建成功 → 左栏变正式舱行 → 进舱第一句是门禁 7 的 M1 提案。
9. 取消（tab × / 草稿行 ×）→ 空态、计数不变、零请求、无确认弹窗。
10. 走开（点别的舱）→ 草稿留着，回来继续。
11. reduced-motion：无动画，逐字台词直接出。
12. 560 宽：立绘 196、输入框整宽、弹层不出界。

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 跨 org 克隆改动碰 init gate | 建舱后 gate 3/4 失败 | 先落 P0 单测（两 org 克隆），再改 UI；gate 失败只影响 init，不影响建舱 |
| `created:false` 语义被其他调用方忽略 | 前端可能重复 init | 客户端统一走 `createCabinWithResult()`，禁止裸调；route 测试断言 `created` 字段 |
| 自动目录与服务端 workspace 规则冲突（名称必须 ASCII） | 建舱失败 | 路径由**服务端**生成，`workspaceSlug` 已清洗；补 `cabin-cabin-` 去重 |
| 项目清单大（>200） | 面板卡 | 前端过滤 + `max-height` 滚动；P0 不改 registry 接口，后续再考虑服务端搜 |
| 立绘资源名与画面错位 | 表情配错 | 用显式 `FACE` 映射（按画面），不调 `moodPortrait`；已在 `design/14` §10 记录 |
| 草稿 localStorage 与舱列表不同步 | 打开草稿后发现目录已是舱 | 打开草稿时用 `useCabins()` 再校验一次，命中则提示并提供"打开" |
| 旧 `CabinNewForm` 仍有入口 | 两套行为 | 常量开关一个 release；P4 全量替换后删文件 |

**回滚**：P2 阶段开关关闭即回旧表单；P0/P3 的服务端改动向后兼容（新字段可选），无需回滚数据。

---

## 13. 文件清单

**新增**

```
packages/web-app/components/cabin/CabinCreateHero.tsx
packages/web-app/components/cabin/CabinCreateHero.css        （或并入 cabin-new.css）
packages/web-app/components/cabin/DirectoryBrowserDialog.tsx
packages/web-app/components/cabin/CabinProjectBinder.tsx
packages/web-app/components/cabin/XiyinStage.tsx
packages/web-app/components/cabin/ProposalCard.tsx
packages/web-app/lib/cabin-draft.ts
packages/web-app/components/cabin/__tests__/CabinCreateHero.test.tsx
packages/web-app/components/cabin/__tests__/CabinProjectBinder.test.tsx
packages/web-app/components/cabin/__tests__/DirectoryBrowserDialog.test.tsx
packages/web-app/e2e/tests/cabin-create.spec.ts
```

**修改**

```
packages/web-app/components/cabin/cabin-mode.tsx
packages/web-app/components/agent/chat/ChatTab.tsx
packages/web-app/components/agent/chat/chat-sidebar.tsx
packages/web-app/components/cabin/CabinNewHero.tsx          （跳转桌面新建页）
packages/web-app/lib/cabin-api.ts
packages/web-app/hooks/use-cabins.ts
packages/server/src/routes/cabins.ts
packages/server/src/services/cabin/cabin-service.ts
packages/server/src/services/cabin/cabin-init-service.ts
packages/server/src/services/cabin/cabin-repos.ts           （仅调用点）
```

**退役（P4）**

```
packages/web-app/components/cabin/CabinNewForm.tsx
packages/web-app/components/cabin/CabinDraftPane.tsx
```

---

## 14. 待定（需要产品拍板，不阻塞 P0/P1）

1. 取名要不要给 **2–3 个候选**？（现稿 1 个 + 可改）
2. 「最近用过」要不要跨设备同步？（现在只能本地）
3. 自动工作空间命名要不要可读（`cabin-dianshang-…`）→ 需要拼音表或模型给 ASCII slug。
4. 项目面板要不要"按最近使用排序"，而不是按 org 分组。
---

## 15. 实现状态（2026-11-15 落地）

> **已被 v5 取代的部分**（`design/19-cabin-new-v5.md`）：提案页与完成页已删除，提交即建、
> 直接进舱；舱名从「她取名你确认」改为「可选输入，不填由初始化取名」。其余（目录 / 项目 /
> 一目录一舱 / 草稿行 / 服务端契约）保持不变。

**结论：P0–P5 全部落地**，原型 `cabin-new-v4.html` 的行为与视觉已进入应用
（`/` 桌面壳内，不新开路由）。验收以真实应用 + Playwright 截图逐屏核对。

### 15.1 落地的文件

**服务端（P0）**

| 文件 | 改动 |
|---|---|
| `services/cabin/cabin-service.ts` | `CreateCabinInput` / `CreateCabinResult`；`createWithResult()`（`path` 可省 → `autoWorkspacePath()`；`projects[]` → config.json group；同目录返回 `created:false`）；`create()` 保留为旧入口；`workspaceSlug()` 去掉 `cabin-cabin-` 重复前缀 |
| `routes/cabins.ts` | `createBodySchema` 的 `path` 可选 + `projects[]`；`POST /api/cabins` 返回 `{cabin, created}` |
| `services/cabin/cabin-init-service.ts` | gate 3/4 按条目 org（`entry.group \|\| row.org`），跨 org 克隆；缺 org 只让该条失败 |
| `services/workspace-git.ts` | `SpecWorktreeEntry.group?`，`writeSpecWorktreeMeta` 保留 group（否则 gate 4 之后跨 org 信息丢失） |

**前端（P1–P4）**

| 文件 | 改动 |
|---|---|
| `lib/cabin-draft.ts`（新） | `CabinDraft`、24h 过期读写、最近目录、目录→项目回显记忆、`proposeCabinName` / `whyCabinName` / `makeAutoDir` |
| `components/cabin/cabin-mode.tsx` | `draft` + `draftOpen` 拆分；`updateDraft` / `closeDraft` / `cancelDraft`；`drafting` 保留为 `draftOpen` 别名 |
| `components/cabin/CabinCreateHero.tsx`（新）+ `.css` | 大 composer、冲突拦截、目录弹层、项目弹层、提案卡、完成卡、tab 头 |
| `components/cabin/XiyinStage.tsx`（新） | 286×330 立绘（screen 混合 + 椭圆遮罩）、登场、星屑、逐字、reduced-motion |
| `components/cabin/CabinProjectBinder.tsx`（新） | 跨 org 聚合、搜索高亮、已选条、分组计数、60s 缓存、失败降级 |
| `components/cabin/DirectoryBrowserDialog.tsx`（新） | 系统式选目录（上级/根/列表/选当前）+ `lockedPaths` 打标 + 「打开「X舱」」 |
| `components/agent/chat/chat-sidebar.tsx` | 作战舱段新增草稿行（呼吸点 + 草稿中 + 悬停 ×）；计数参与搜索 |
| `components/agent/chat/ChatTab.tsx` / `ConversationHome.tsx` | 桥改为 `draft`/`draftOpen`/`onUpdateDraft`/`onCancelDraft`；草稿页渲染 hero；创建后丢弃草稿 + 刷新左栏 |
| `components/cabin/CabinNewHero.tsx` | `/cabin/new` 改为「打开桌面里的新建页」跳板 |
| 删除 | `CabinNewForm.tsx`、`CabinDraftPane.tsx`（P4 退役） |

### 15.2 与计划的差异（都是有意的）

1. **完成态多留 1.4s**：建成功后先显示「已创建」卡（原型的那一拍），再自动进舱；
   期间点「进入作战舱」可立即进。plan §7 的「建完直接进舱」语义不变。
2. **项目回显来自本地记忆**：`octopus.cabinDirProjects.v1` 记住「目录 → 上次绑的项目」。
   真正的 workspace ↔ 项目关联还没有读接口（用户也说过工作空间要再设计），
   所以没有假装从服务端回显。
3. **自动目录路径前端只做预测**：提案里展示 `makeAutoDir()` 的形状，真实路径由服务端生成
   （避免前端拼路径与服务端 workspace 规则漂移）。
4. **`created:false` 不改成 409**（按 §4.2）：路由仍 201，客户端据 `created` 直接打开已有舱。
5. **删除旧表单**而不是保留开关：`/cabin/new` 已无第二套入口，不存在并存期。

### 15.3 验证记录

- `pnpm --filter @octopus/web-app test` → **1511 passed / 192 files**
- `npx vitest run --project @octopus/server src/services/cabin src/routes` → **397 passed**
- 新增测试：`cabin-create-v2.test.ts`（5）、`CabinCreateHero.test.tsx`（8）、
  `CabinProjectBinder.test.tsx`（4）、`cabin-draft.test.ts`（7）；`cabin-mode` / `chat-sidebar-cabin` /
  `conversation-home-cabin` 改写为 v4 语义。
- 真机（1440×900 / 800 / 560）：截图核对 compose / 目录弹层 / 选目录窗 / 项目弹层 /
  提案 / 完成 / 一目录一舱拦截；0 console error。
- 未落 `cabin-create.spec.ts`：仓库的 `playwright.e2e.config.ts` 只跑 `system-models.spec.ts`，
  单独加 spec 也不进 CI；改用脚本化 Playwright 走查（含走开→回来、刷新后草稿仍在、560 窄屏）。
- 真服务端冒烟：`POST /api/cabins` 不带 path → `created:true` + `~/.octopus/workspaces/cabin-…`；
  同 path 再 POST → `created:false` + 同 id；`projects[]` → config.json 两条 group；验证后已删除。
