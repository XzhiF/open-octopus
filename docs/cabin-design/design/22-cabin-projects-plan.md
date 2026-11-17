# 22 · 舱籍实现计划：项目关联 / 本地映射 / 不预建工作树 / 项目面

> 日期：2026-11-15 · 状态：**待确认后执行**
> 设计口径：[21-cabin-projects.md](./21-cabin-projects.md) §1.5
> 原型：`../cockpit-v14.html`（座舱 · v14.1）· `../cabin-new-v5.html`（建舱映射）
> 前置设计：[10-workbench-and-cabin.md](./10-workbench-and-cabin.md)（一个舱 = 一个 CWD）

---

## 0. 一句话目标

**全域座舱里能看见当前作战舱关联的项目（ORG + 本地映射），点项目看到的是仓库；
建舱只登记项目与主线，不预建 git worktree。**

### 范围内

1. 项目两类来源：ORG manifest 注册仓库 + 当前工作目录下的本地项目（建舱初始化时映射）。
2. 全域座舱的「舱籍」：HUD 读数 → 浮层 → 舱籍面（项目分列）→ 项目面（仓库全集）。
3. 作业行 / 作业面的项目锚点（有锚点才显示，不猜）。
4. 绑定/解绑项目的入口（两张来源分组）。
5. 初始化门禁：只登记项目与主线，**不建 worktree**；worktree 改为按作业/显式动作开。
6. ORG 主仓**只读门槛**：只允许拉主线（ff-only）；任何编辑必须发生在 worktree。
7. 舱外目录的仓库 = 显式配置登记（`external`），同样是只读引用，不克隆、不搬代码。

### 范围外（后续再议）

- 跨舱的项目聚合视图（同一项目绑多个舱时的合并看板）。
- 项目重命名 / 删除本地目录 / 项目级权限。
- 没有项目锚点的作业强行归属（一律「未归属项目」）。
- 按项目计费结算（先按锚点聚合展示，账本口径不动）。

---

## 1. 现状（代码事实）

| 事实 | 位置 | 影响 |
|---|---|---|
| 建舱把 `projects[]` 写成 `{ group: org, name: repo }` 占位，等 init 克隆 | `packages/server/src/services/cabin/cabin-service.ts:235` | 没有 `source` / `local_path`，本地项目无处落 |
| init gate 3 克隆仓库 | `cabin-init-service.ts:229`（`clone`） | 只处理 ORG 仓库 |
| **init gate 4 给每个仓库建一个 cabin worktree** | `cabin-init-service.ts:247`（`mainline`），`initWorktreeOne` 在 `:267` | 用户明确说这是错的：上来就建工作树 |
| `addRepo` = clone + 立刻建 worktree，并只保留带 worktree 的旧条目 | `cabin-service.ts:672` | 加项目也预建工作树；会丢掉无 worktree 条目 |
| `writeSpecWorktreeMeta` 重写 `config.repos` 时只写 5 个字段 | `workspace-git.ts:238` | 会抹掉 `source` / `local_path` / `mainline_branch` |
| 唤醒自愈只重建带 `branch + worktree_path` 的条目 | `workspace.ts:482`，跳过规则在 `:495` | 新条目（无 worktree）不会被自愈误建，**正好** |
| `/repos` 只在有 `worktree_path` 时做 git 富化 | `routes/cabins.ts:382` | 无 worktree 时拿不到分支/HEAD，项目面没数据 |
| 作业行没有项目字段 | `cabin_jobs` 表；`listJobsView` 在 `cabin-service.ts:796` | 编队行 / 舱籍面无法按项目聚合 |
| 全域座舱没有项目展示位 | `CockpitHud` / `CockpitFleetRail` / `CockpitFace` | v13 把舱与项目当 1:1，掩盖了缺口 |

---

## 2. 领域与数据契约

### 2.1 项目 = 关联，不是复制

- 项目是舱的**关联关系**，写在舱目录的 `config.json.repos[]`。
- ORG 项目：`main_path` 指向 `~/.octopus/orgs/<org>/repos/projects/<group>/<name>` 的共享克隆。
- 本地项目：`main_path` / `local_path` 指向舱目录下的工作副本，**不克隆**。
- 作业的 worktree 是**执行时**产物，不属于绑定本身。

### 2.2 `config.json.repos[]` 扩展

```ts
// packages/server/src/services/cabin/cabin-repos.ts
export type CabinRepoSource = "org" | "local"

export interface CabinRepoEntry {
  name: string                    // 舱内唯一名（见 §2.3 冲突规则）
  source?: CabinRepoSource        // 缺省 = "org"（兼容老数据）
  // ORG 专用
  group?: string                  // manifest 分组（不是 org）
  repoName?: string
  org?: string                    // 新增：跨 org 关联时记录归属 org
  // 路径
  main_path?: string              // 共享克隆 / 本地仓库绝对路径（一律绝对）
  local_path?: string             // 舱内本地项目的相对路径（如 apps/console）；舱外为空
  external?: boolean              // 舱目录之外的来源（显式配置登记），UI 标「外部」
  // 主线（只读展示；不参与 self-heal）
  mainline_branch?: string
  // worktree（只有真的开了才有；self-heal 以这两个字段为开关）
  worktree_path?: string
  branch?: string
}
```

两种条目示例：

```json
{
  "repos": [
    {
      "name": "ledger", "source": "org", "org": "XzhiF", "group": "accounting",
      "repoName": "ledger", "main_path": "/Users/xzf/.octopus/orgs/XzhiF/repos/projects/accounting/ledger",
      "mainline_branch": "main"
    },
    {
      "name": "console", "source": "local", "local_path": "apps/console",
      "main_path": "/Users/xzf/Projects/aurora/apps/console", "mainline_branch": "feat/console"
    }
  ]
}
```

**关键不变量**

- `branch` 保持现有语义 = **worktree 分支**；主线分支一律写 `mainline_branch`。
  不能把主线写进 `branch`，否则 `ensureWorktreesForReuse` 会把它当成待重建的 worktree。
- 任何写 `config.repos` 的函数必须**合并**而不是整表重写（当前 `writeSpecWorktreeMeta`
  会丢字段）。新增 `mergeCabinRepoEntry`。
- 一个项目在舱内 `name` 唯一；作业的 `project_ids` / `repo_group` 以 `name` 对齐。
- **ORG 主仓只读**：`main_path` 指向 `~/.octopus/orgs/<org>/repos/...` 的条目，服务端只
  允许 `fetch` / `pull --ff-only`；任何写操作必须发生在 `worktree_path`。
- **worktree 目录名唯一**：并行实例用 `projects/<name>@<instance>`；`name` 仍是项目名，
  实例后缀不进项目名（否则作业锚点对不上）。

### 2.3 本地项目发现与映射

扫描规则（`scanLocalProjects(root)`）：

| 项 | 规则 |
|---|---|
| 根 | 舱目录的 `realpath`（必须已存在、可读、绝对路径） |
| 深度 | 1：`root/*/.git`；2：`root/*/*/.git`（父目录本身是 repo 时不往下扫，防 monorepo 重复计数） |
| 根自身 | `root/.git` 存在 → 整个舱目录记为**一个**本地项目（`name = basename(root)`，`local_path = "."`） |
| 忽略 | `.git`、`.cabin`、`projects`、`node_modules`、`dist`、`build`、`target`、`vendor`、`.next`、`.worktrees`、隐藏目录 |
| 符号链接 | 一律跳过（防环、防越界） |
| 上限 | 最多 50 个候选；单个 `git` 命令 3s 超时 |
| 产出 | `{ name, local_path, branch, dirty, remote }` |

**默认勾选**：深度 1 的 git 仓库默认选中（用户意图就是「目录下的项目」）；深度 2 的默认不选，
避免把 monorepo 里的 packages 全部绑上。实现前可再确认。

**名称冲突**：`name` 取目录名；与舱内已有项目同名时，用 `"<parent>-<name>"`（如
`apps-console`），仍冲突则加 `-2`。写进 `config.repos[].name`，`local_path` 保留真实相对路径。

### 2.4 作业 → 项目锚点

`cabin_jobs` **不加列**（本轮），由 `listJobsView` 派生：

| 作业类型 | 来源 | 规则 |
|---|---|---|
| `task` | `tasks.repo_group` + `tasks.project_ids`（`taskDAO.getByIdRaw(ref_id)`） | 与舱项目的 `name` 求交；命中多个 → 全部返回（行上显示 `第一个 +N`）；零命中 → `null` |
| `workflow` | `executions.workspace_id` → `workspaces.config` 的 repos | 恰好一个项目才归属；多个/零个 → `null`（不猜） |
| `subagent` | `sessions.cwd` 与项目 `main_path` 的最长前缀 | 命中唯一项目才归属；否则 `null` |

`CabinJobView` 增补：

```ts
export type CabinJobView = CabinJob & {
  status: string
  transport: string
  iteration_code: string | null
  project_keys: string[]     // 新增，empty = 未归属
}
```

UI 规则：`project_keys` 为空 → 不显示项目签；舱籍面底部给一条「未归属项目」说明，不硬塞。

### 2.5 只读门槛与开发路径

| 动作 | ORG 主仓（`main_path`） | worktree（`worktree_path`） | 本地 / 外部仓库 |
|---|---|---|---|
| 读 / 搜索 / 分析 | ✓ | ✓ | ✓ |
| 拉最新主线 | ✓ `fetch` + `pull --ff-only` | — | ✓（同） |
| 改代码 / 建分支 / commit | ✗ **禁止** | ✓ | ✗（要改也开 worktree） |
| 删除 / 重置 | ✗ | ✓（回收动作，独立） | ✗ |

四个强制点：

1. **服务端不写主仓**：`addRepo` / `openRepoWorktree` / init 只写 `config.json` 与 worktree；
   `pullRepo` 只发 `fetch` + `pull --ff-only`，拒绝 `reset --hard` / `checkout -f` 之类。
2. **舱主对话不写业务代码**：`cabin-orchestrator` 人格已规定「不亲自 edit/bash 改业务仓库」
   （`packages/server/src/services/agent/builtin-clones.ts:276` 附近的 `边界` 段）。
3. **舱目录契约**：init 把项目清单写进 `<舱>/CLAUDE.md`（每个项目：来源 / 路径 / 只读 /
   开 worktree 的命令），Agent 起来就能读到，不靠记忆。
4. **旁路（后续，不阻塞本轮）**：`safety-interceptor` 可对 `main_path` 下的写命令告警。

「开 worktree」不是绑定的一部分：绑定只登记项目；worktree 是显式动作或作业产物。

### 2.6 worktree 目录与并行隔离

现状事实：

| 事实 | 位置 |
|---|---|
| `initWorktreeOne` 固定落 `<ws>/projects/<proj.name>` | `workspace-git.ts:194` |
| 目标目录存在时**先 `rmSync(recursive, force)` 再 add** | `workspace-git.ts:201` |
| 任务是 workspace + worktree，不是 clone | `task-lifecycle-service.ts:587` → `ensureWorktreesForProjects` |

同名并行的后果：第二个 worktree 会静默删掉第一个的工作树（数据丢失，且 config 还指着它）。

规则：

- 目录名 `<cabin>/projects/<name>@<instance>`；`instance` 取作业 id 或显式动作的短码。
  单实例仍是 `projects/<name>`（向后兼容老舱）。
- `initWorktreeOne` 加 `{ clobber?: boolean }`（默认 `true`，保持任务路径逐字行为）；
  Cabin 路径传 `false`：目标存在且 `worktreeAlive` → 抛 `worktree_exists` → 409，**不 rm**。
  只有「目录在但不是活 worktree」才清理。
- `config.repos[]` 的 `worktree_path` / `branch` 记**主 worktree**（self-heal 只碰它）；
  并行实例另记 `worktrees?: Array<{ path: string; branch: string; instance: string }>`。
  本轮先做「拒绝覆盖」，`worktrees[]` 列可留到 P4。

---

## 3. 服务端改造

### 3.1 `services/cabin/cabin-repos.ts`

新增：

```ts
export interface LocalProjectCandidate {
  name: string; local_path: string; branch: string | null; dirty: boolean; remote: string | null
}
export function scanLocalProjects(root: string): LocalProjectCandidate[]
export function isPathInside(root: string, target: string): boolean   // realpath 比较
export function projectKey(e: CabinRepoEntry): string                 // org:<org>/<name> | local:<local_path>
export function mergeCabinRepoEntry(cabinPath: string, entry: CabinRepoEntry): void
export function worktreeDirFor(cabinPath: string, name: string, instance?: string): string
export function resolveCabinRepo(e: CabinRepoEntry): { mainPath: string; external: boolean }
```

- `scanLocalProjects` 纯读、无写；失败返回空数组并 `console.error`（不抛，建舱不能因为扫描失败挂掉）。
- `mergeCabinRepoEntry` 按 `name` 合并已有条目，保留未知字段（`source` / `local_path` /
  `mainline_branch` 不会被 worktree 写入抹掉）。

### 3.2 `services/cabin/cabin-init-service.ts`

- `GATE_DEFS`：
  - `clone`：label `克隆 ORG 仓库`，fixHint 保留。
  - `mainline`：label `项目 / 主线登记`，fixHint 改为「登记 main_path / 主线分支；worktree 按作业开」。
  - **key 不改**（`isInitComplete` 兼容已有 `init-state.json`）。
- `clone` 门禁：
  - 只处理 `source !== 'local'` 的条目；
  - 本地条目：校验目录存在且是 git repo，记录 `main_path` / `mainline_branch`；失败 → 该条 `failed`。
  - 汇总语：`N 个仓库就绪 · M 个本地映射`。
- `mainline` 门禁（重写）：
  1. 对 ORG 条目：确保克隆（gate 3 已做则直接复用），记录 `main_path`、`mainline_branch`；
     **不再调用 `initWorktreeOne`**，**不再写 `worktree_path` / `branch`**。
  2. 对本地条目：确认路径仍是 git repo，刷新 `mainline_branch`。
  3. 用 `mergeCabinRepoEntry` 落盘；不调用 `writeSpecWorktreeMeta`。
  4. 汇总语：`N 个项目登记 · 未预建工作树`；失败项进入既有 `failed` 通道。
- 门禁 sub 文案（SSE / 舱内卡片）同步。

### 3.3 `services/cabin/cabin-service.ts`

| 方法 | 改动 |
|---|---|
| `createWithResult` | `projects[]` 支持 `{ source?, org?, repo, localPath? }`：ORG → `{source:'org', org, group: org, name: repo, repoName: repo}`；本地 → `{source:'local', name: repo, local_path, main_path: resolve(...)}`。仍不 clone（init 做） |
| `attach` | 从 `config.json.repos[]` 读项目（manifest 只存 names，保持兼容）；缺 `source` 默认 `org` |
| `listRepos` | 返回 `CabinRepoEntry[]`（含 source/local_path）；新增 `listRepoViews`（带 `key`、`git` 富化）供 route 用 |
| `addRepo` | ORG：`ensureRepoCloned` → 记录 `main_path` + `mainline_branch`，**不建 worktree**；舱内本地：`isPathInside` 校验 → 记录；舱外：必须带 `external: true`（显式登记），只校验存在 + 是 git repo |
| `removeRepo` | 新增：删除条目，不影响磁盘（不删 worktree，也不动主仓）；有活跃作业/任务引用 → 409 |
| `openRepoWorktree` | 新增：显式开工作树（`initWorktreeOne{clobber:false}` + `worktreeDirFor` 唯一路径），用 `mergeCabinRepoEntry` 落 `worktree_path` / `branch`，保留 source/local/external 字段；已存在活 worktree → 409 `worktree_exists` |
| `pullRepo` | target = `worktree_path ?? main_path`；**只 `fetch` + `pull --ff-only`**（主仓只读门槛）；分叉 → 409 报「需要开工作树」 |
| `selfHeal` | 不变；`ensureWorktreesForReuse` 会跳过无 `branch+worktree_path` 的条目（正是新形态） |
| `listJobsView` | 增补 `project_keys`（§2.4），task 作业按 `ref_id` 查 task；查询失败 → `[]` |
| `delete` / `archive` | 不变；只清理存在的 worktree |

### 3.4 `services/workspace-git.ts`

- `writeSpecWorktreeMeta` 不动（其他调用方依赖逐字行为）。
- Cabin 路径改用 `mergeCabinRepoEntry`（`addRepo` / `openRepoWorktree` / init），避免字段丢失。
- `initWorktreeOne` 增 `{ clobber?: boolean }`，默认 `true`（任务路径行为逐字不变）；
  `clobber:false` 时活 worktree 存在即抛错，不再 `rmSync`（见 §2.6）。

### 3.5 路由 `routes/cabins.ts`

| 方法 / 路径 | 变化 |
|---|---|
| `POST /api/cabins` | `projects[]` 允许 `source: 'org' \| 'local'`；本地必带 `localPath` 或 `repo`（相对路径）；ORG 仍要求 `org + repo` |
| `GET /api/cabins/:id/repos` | 返回 `{ repos: CabinRepoDTO[] }`：`key`、`source`、`org`、`group`、`main_path`、`local_path`、`mainline_branch`、`worktree_path`、`branch`、`git`。**git 富化目标 = `worktree_path ?? main_path`**；`?enrich=0` 只返回条目（HUD 计数用） |
| `POST /api/cabins/:id/repos` | body `{ source?, name, localPath?, absolutePath?, external? }`；ORG 克隆 + 登记；舱内本地校验 + 登记；舱外必须 `external: true`；返回新 DTO |
| `DELETE /api/cabins/:id/repos/:name` | 新增；解绑（不动磁盘） |
| `POST /api/cabins/:id/repos/:name/worktree` | 新增；显式开工作树 |
| `POST /api/cabins/:id/repos/:name/pull` | 不变（服务内部已支持无 worktree） |
| `GET /api/cabins/local-projects?path=` | 新增，建舱前扫描：`{ projects: LocalProjectCandidate[] }`；**只扫舱目录内**（见 §3.7）；舱外路径只能经 `POST /repos` 显式登记 |
| `GET /api/cabins/:id/jobs` | 行内加 `project_keys`（DTO 透传） |

`CabinRepoDTO`（wire，snake_case 保持既有习惯）：

```ts
{
  key: string; name: string; source: 'org' | 'local'
  org: string | null; group: string | null; repoName: string | null
  main_path: string | null; local_path: string | null
  mainline_branch: string | null
  worktree_path: string | null; branch: string | null
  git: { branch: string; detached: boolean; commit: string; msg?: string; at?: string; remote?: string | null } | null
}
```

### 3.6 兼容 / 迁移

- **无 DB 迁移**。老 `config.repos[]` 无 `source` → 运行时按 `org` 处理。
- 老舱已有预建 worktree：**保留**，不清；只是新舱/新绑项目不再预建。
  init 已完成的舱不会重跑门禁，`mainline` 新行为只影响新舱 / 手动重试。
- `init-state.json` 的 key 集合不变；旧快照仍算 complete。
- `.cabin/manifest.json` 仍存 `repos: string[]`；项目来源以 `config.json` 为准。
- 老任务/作业没有锚点 → `project_keys: []`，UI 显式「未归属项目」。

### 3.7 安全与边界

- `GET /api/cabins/local-projects?path=`：
  - 解析 `realpath`，必须是绝对路径、存在、是目录；
  - 只读、不跟随符号链接、深度 ≤ 2、候选 ≤ 50、每个 git 命令 ≤ 3s；
  - 不接受 `path` 指向文件 / 设备 / 不存在的路径；错误 400，不回显内部路径之外的探测结果。
- 绑定本地项目分两级：
  - **扫描端点**只接受舱目录内的路径（`isPathInside`），不做任意目录探测；
  - **舱外仓库**必须走 `POST /repos` 并带 `external: true`：只回这个仓库的分支 / HEAD，
    不返回目录清单、不做递归枚举。UI 标「外部」，语义仍是只读引用。
- 解绑不删磁盘；工作树回收是独立动作（后续）。
- 删除舱的 `delete_files` 防呆保持不变。

---

## 4. 前端改造

### 4.1 类型与 API

`packages/web-app/lib/cabin-api.ts`：

```ts
export interface CabinRepoEntry {
  key: string
  name: string
  source: 'org' | 'local'
  org: string | null
  group: string | null
  repoName: string | null
  main_path: string | null
  local_path: string | null
  mainline_branch: string | null
  worktree_path: string | null
  branch: string | null
  git: { branch: string; detached: boolean; commit: string; msg?: string; at?: string; remote?: string | null } | null
}
export async function fetchCabinRepos(id: string, opts?: { enrich?: boolean }): Promise<CabinRepoEntry[]>
export async function addCabinRepo(id: string, input: { source: 'org' | 'local'; name: string; localPath?: string }): Promise<CabinRepoEntry>
export async function removeCabinRepo(id: string, name: string): Promise<void>
export async function createRepoWorktree(id: string, name: string): Promise<{ worktree_path: string; branch: string }>
export async function scanLocalProjects(path: string): Promise<LocalProjectCandidate[]>
```

`lib/cabin-draft.ts`：

```ts
export interface CabinProjectRef {
  source?: 'org'        // 缺省 org，兼容 localStorage 旧草稿
  org?: string          // local 时为空
  repo: string
  localPath?: string
}
export function projectKey(p: CabinProjectRef): string
// local:<localPath> | org:<org>/<repo>
```

`CreateCabinInput.projects` 同步扩展；`rememberDirProjects` 的持久化保持兼容。

### 4.2 建舱流程

| 文件 | 改动 |
|---|---|
| `components/cabin/CabinProjectBinder.tsx` | 两个分组：`ORG 注册项目`（现有 manifest 调用）与 `本地目录 · 建舱时映射`（`scanLocalProjects(draft.path)`）。本地组置顶；搜索同时过滤两组；已选条带来源标。`onChange` 传 `CabinProjectRef[]` 含 source |
| `components/cabin/CabinCreateHero.tsx` | 选择目录后加载本地候选；回显提示改为「N 个 ORG 项目 + M 个本地项目可映射」；创建 payload 带 `source` 与 `localPath` |
| 门禁卡片 | 服务端 `GATE_DEFS` label 改了，前端无需逻辑改动；核对文案测试 |
| `components/cabin/modules/CabinCloneDialog.tsx` | 加项目走 `POST /repos` 的新 body；文案写「克隆 ORG 仓库」 |

### 4.3 全域座舱

| 文件 | 改动 |
|---|---|
| `components/cockpit/state/cockpit-state.ts` | `CockpitRef` 增 `{ kind: 'project'; cabinId; id }`（`id` = `projectKey`） |
| `components/cockpit/entry/cockpit-url.ts` | `?project=<key>`；与 `cabin`、`tab` 规则一致；`COCKPIT_OWNED_PARAMS` 加 `project`。`kind: 'project'` 不参与默认选中 |
| `components/cockpit/entry/cockpit-candidates.ts` / `CockpitUrlSync.tsx` | 项目 ref 的有效性由 `useCabinProjects(cabinId)` 判定；项目不存在 → 回到舱籍面 / 默认选中。不能沿用 `refInRows` |
| `components/cockpit/fleet/fleet-model.ts` | 行模型透传 `project_keys`；`metaLine` 增「舱 / 项目」；新增按项目筛选纯函数 |
| `components/cockpit/shell/CockpitHud.tsx` | 加项目读数按钮：`⧉ <舱名> N 项目 ▾`；0 项目 → `＋ 绑定项目`；当前舱规则见 §4.4 |
| 新增 `components/cockpit/projects/CockpitProjectsPopover.tsx` | 392px 浮层：按来源分组，行内 org/group、分支·HEAD、干净/改动、作业/运行/工作树/¥；点行 → 项目面；「看全」→ 舱籍面；「＋ 绑定项目」→ 绑定面板 |
| 新增 `components/cockpit/projects/CockpitManifestFace.tsx` | 舱籍面：ORG 项目分列（工作树 / 改动 / 作业）+ 本地映射条 + 空态；点列头 → 项目面，点作业 → 作业面 |
| 新增 `components/cockpit/projects/CockpitProjectFace.tsx` | 项目面：来源 / 路径 / 远端 / 分支·HEAD / 最近提交 / 工作树 / 改动 / 该项目的作业与任务；动作：回舱籍、只看它的作业、拉取主线、复制路径、开工作树 |
| 新增 `components/cockpit/projects/CockpitRepoBinder.tsx` | 绑定面板（ORG / 本地两组，勾选保存）；复用 `CabinProjectBinder` 的数据层或直接调 API |
| 新增 `components/cockpit/projects/use-cabin-projects.ts` | 单个舱的项目数据：`/repos?enrich=1` + `/changes` + 编队行聚合；按 cabinId 缓存 30s、in-flight 去重；失败保留上一份并标 stale |
| `components/cockpit/face/CockpitFace.tsx` | 分发 `kind: 'project'` → 项目面；项目/舱籍面与作业面共用 `sceneHost` |
| `components/cockpit/rail/CockpitFleetRail.tsx` | 行第二行「舱 / 项目」；「只看这个项目」筛选胶囊（从项目面按钮写入） |
| `components/cabin/job-face.tsx` | 作业头项目签（`project_keys[0]`，`+N`），点它 → 项目面 |
| `app/cockpit/{base,rail,face}.css` + `app/globals.css` | 新增 `ck12-projects-*` 样式，尺寸读 v14 原型（浮层 392 / 项目面两栏 / 本地条） |

### 4.4 行为规则

1. **当前舱**：左栏舱筛选 → 选中作业所在舱 → 入口舱；舱籍面/项目面打开时以面为准。
2. **点项目 = 项目面（仓库）**；「只看它的作业」是显式按钮，只筛左栏，不换面。
3. **项目面 → 作业**：点作业行进作业面（`kind: 'job'`）。
4. **空态**：舱没有项目 → HUD `＋ 绑定项目`；浮层/舱籍面给空态 + 绑定入口。
   项目没有作业 → 「这个项目上还没有作业」；没有锚点的作业 → 「未归属项目」。
5. **数字纪律**：工作树 0 写「没有工作树」，消耗拿不到就整段省略，不写 `--` / 假进度。
6. **deep link**：`/cabin/:id/cockpit?project=<key>&cabin=<owner>`；项目不存在 → 回舱籍面。

---

## 5. 测试计划

### 服务端

| 测试 | 断言 |
|---|---|
| `cabin-repos.test.ts`（新） | 扫描深度 1/2、忽略目录、符号链接跳过、根自身是 repo、名称冲突、50 上限、非 git 目录；`worktreeDirFor` 单实例 / 带 instance 后缀 |
| `cabin-init-service.test.ts`（扩） | 新 gate label；init 后 `config.repos[]` 有 `main_path` / `mainline_branch`，**没有** `worktree_path` / `branch`；本地条目不克隆；失败通道 |
| `cabin-create-v2.test.ts`（扩） | create payload 含 local → config 条目 source/local_path；缺 source 的旧数据按 org |
| `cabin-service.test.ts`（扩） | `addRepo` 不建 worktree；`openRepoWorktree` 建并保留 source/local；`removeRepo` 409（有活跃作业）；`pullRepo` 无 worktree 走 main_path |
| `cabins-routes.test.ts`（扩） | `GET /repos` 对有/无 worktree 都富化；`?enrich=0`；`POST /local-projects` 路径校验（舱外拒绝）；`POST /repos` 舱外必须 `external`；`DELETE /repos/:name`；`POST /repos/:name/worktree` 重复开 → 409 |
| `workspace-git.test.ts`（扩） | `clobber:false` 下活 worktree 不被删、抛 `worktree_exists`；`clobber:true` 行为不变 |
| `cabins-pull.test.ts`（新） | `pullRepo` 只发 ff-only；分叉 → 409；主仓不被写 |
| `cabin-jobs-project.test.ts`（新） | task 单项目 / 多项目 / 零命中；workflow 唯一项目；subagent 前缀命中；全 null 安全 |
| 全量 | `pnpm --filter @octopus/server test` 保持全绿（注意 `db-schema.test.ts` 不新增表/索引） |

### Web

| 测试 | 断言 |
|---|---|
| `CabinProjectBinder.test.tsx`（扩） | 本地组置顶、来源标、搜索命中、选择回写 `{source:'local', localPath}` |
| `cabin-create-hero.test.tsx`（扩） | 创建 payload 带 source/localPath；回显文案 |
| `cockpit-projects.test.tsx`（新） | HUD 读数跟随当前舱；0 项目空态；浮层来源分组；Esc 关闭 |
| `cockpit-project-face.test.tsx`（新） | 点项目进项目面（不是作业面）；仓库字段；只看它的作业只筛左栏；回舱籍 |
| `cockpit-manifest-face.test.tsx`（新） | ORG 分列 + 本地条；点作业进作业面；空态 |
| `chat-sidebar` / `job-face`（扩） | 作业头项目签；未归属不显示 |
| lint / build | `pnpm lint`、`pnpm --filter @octopus/web-app build` 全绿 |

### 真应用 E2E

`e2e/tests/cockpit-projects.spec.ts`：

1. 建一个带 ORG + 本地项目的舱 → init 完成 → `config.repos` 无 worktree；
2. 全域 → HUD 读数 → 浮层 → 项目面 → 只看它的作业 → 回舱籍；
3. 切舱读数跟随；空舱空态；
4. 明示「开工作树」后才出现 `projects/<name>`；
5. 全程 0 console error；1440 / 1280 无横向溢出。

---

## 6. 实施顺序

### P1 · 服务端地基（先红后绿）

1. `cabin-repos.ts`：类型 + `scanLocalProjects` + `mergeCabinRepoEntry` + `projectKey`。
2. `cabin-init-service.ts`：gate label / clone / mainline 重写（不建 worktree）。
3. `cabin-service.ts`：create / attach / listRepos / addRepo / removeRepo / openRepoWorktree / pullRepo。
4. `routes/cabins.ts`：repos DTO / 富化回退 / 新端点 / 舱外 `external` 校验。
5. `workspace-git` 的 `clobber` 开关 + `worktreeDirFor` 唯一路径；init 写舱 `CLAUDE.md` 项目清单。
6. 所有服务端测试绿。

**验收**：新建一个 ORG+本地舱 → init 完成 → `config.repos` 两条（无 worktree）→
`GET /repos` 两条都有 `git.branch`。手工 `openRepoWorktree` 后新增 `worktree_path` 且 source 不丢。

### P2 · 座舱只读（无绑定）

1. `use-cabin-projects` + 类型/API。
2. HUD 读数 / 浮层 / 舱籍面 / 项目面 / 作业头项目签 / 左栏项目签与筛选。
3. CSS + 单元测试 + E2E 2–3 条。

**验收**：与 `cockpit-v14` 原型对齐（除绑定/解绑与本地扫描入口），0 console error。

### P3 · 建舱映射 + 绑定面板

1. 建舱 `CabinProjectBinder` 本地组 + `scanLocalProjects` 接真端点。
2. 创建 payload / 草稿持久化 / 回显。
3. 座舱绑定面板 + 解绑 + 开工作树动作（重复开 = 明确冲突提示）。
4. 建舱「引入其他目录仓库」输入框（`absolutePath` + `external`）。
5. 测试与 e2e。

**验收**：与 `cabin-new-v5` 原型对齐；本地 / 外部项目只关联不克隆；解绑不动磁盘；
ORG 主仓全程无写入（`git -C <main_path> status --porcelain` 为空）。

### P4 · 作业锚点与聚合（可与 P3 并行）

1. `listJobsView.project_keys`（task / workflow / subagent）。
2. 左栏项目筛选、按项目消耗聚合（拿不到就省略）。
3. 测试。

**验收**：编队行显示「舱 / 项目」；零锚点显示「未归属项目」；不猜。

---

## 7. 风险与开放问题

| 风险 | 处理 |
|---|---|
| 不预建 worktree 后，舱主对话没有可编辑副本 | 主对话可读 `main_path`；要编辑时走显式「开工作树」；任务执行本来就按作业建（`task-lifecycle-service.ts:587`），不受影响 |
| `writeSpecWorktreeMeta` 抹字段 | Cabin 路径一律走 `mergeCabinRepoEntry`；加测试钉住 source/local 不丢 |
| 本地扫描误把临时目录/生成目录当项目 | 忽略列表 + 默认只选深度 1 + 候选上限；绑定后可解绑 |
| 本地目录被移动/删除 | `git: null` → 项目面显示「未检出」，不自动删绑定 |
| 同名项目 | `name` 冲突规则 + 作业锚点按 name 对齐 |
| 项目绑多个舱时的筛选语义 | 「只看项目」先按归属舱；跨舱聚合放后续 |
| 老舱的预建 worktree 与新形态混用 | 保留旧 worktree；新条目无 worktree；self-heal 恰好只重建旧的 |
| 扫描端点被当成目录探测器 | realpath + 绝对路径 + 只读 + 深度/数量上限；不返回非项目信息；舱外只走显式登记 |
| **并行同名 worktree 互删** | `initWorktreeOne` 原逻辑会 `rmSync` 目标；Cabin 路径改 `clobber:false` + `projects/<name>@<instance>`，重复开报 409 |
| ORG 主仓被误写 | 服务端只写 config/worktree；`pullRepo` 仅 ff-only；舱 `CLAUDE.md` 写明只读；后续可加 `safety-interceptor` 告警 |
| 舱外仓库路径失效 | `git: null` → 显示「未检出」；不自动删绑定，不猜 |

### 待确认

1. 本地项目默认勾选深度 1（当前方案）还是全部不勾选、由用户逐个选？
2. 项目名冲突时的展示名（`apps-console`）还是允许用户当场改名？
3. 解绑带活跃作业的项目：409 拦下，还是允许解绑但保留作业的「未归属」？
4. 「开工作树」放在项目面（当前方案）还是绑定面板里也放一个？
5. 按项目消耗的聚合口径：`usage.byJob` 加锚点，还是先不做（本轮可省略）？
6. 并行 worktree 隔离用 `projects/<name>@<instance>` 后缀（当前方案）还是 `projects/<instance>/<name>` 子目录？
7. `worktrees[]` 多实例登记本轮就做，还是先只做「重复开报 409」？

---

## 8. 完成定义（DoD）

- [ ] 新建舱不再预建任何 worktree；`config.repos[]` 只有项目 + 主线登记。
- [ ] ORG 主仓全程只读：只 `pull --ff-only`；改分支一律在 worktree；重复开工作树报冲突不覆盖。
- [ ] 舱外目录仓库可显式登记（`external`），只读引用；解绑不动磁盘。
- [ ] ORG 与本地项目都能在座舱看见，点项目进项目面（仓库），不是作业详情。
- [ ] 作业有锚点才显示项目；零锚点走「未归属」，数字不造假。
- [ ] 绑定/解绑可用；本地项目只在舱目录内，只关联不克隆。
- [ ] `pnpm test`（server + web）、`pnpm lint`、web/server build 全绿。
- [ ] E2E 走查通过，1440 / 1280 无溢出，0 console error。
- [ ] 文档 21/22 与代码一致。
---

## 9. 实现记录（2026-11-15 落地）

### 9.1 拍板

| 问题 | 结论 |
|---|---|
| 并行 worktree 隔离 | **子目录**：主实例 `projects/<name>`（兼容老舱），并行实例 `projects/<instance>/<name>`（instance = 作业 id / `wt-<短码>`） |
| 多实例登记 | **本轮已做**：`config.repos[].worktrees[]` 记录 `{path, branch, instance, created_at}`；主实例仍占 `worktree_path` / `branch`（self-heal 只碰主实例） |
| 项目消耗 | 做：`usage.byJob` 行带 `project_keys`；项目面只显示**已定价**行的合计，拿不到整段省略 |

### 9.2 已落地（文件）

**服务端**

- `services/cabin/cabin-repos.ts`：`CabinRepoEntry` 扩展（source/org/local_path/external/mainline_branch/worktrees）、
  `scanLocalProjects`（深度 1–2、忽略表、符号链接跳过、50 上限、同名消歧）、
  `isPathInside` / `projectKey` / `resolveCabinRepo` / `worktreeDirFor` /
  `mergeCabinRepoEntry`（唯一写口，保留未知字段）/ `removeCabinRepoEntry` / `localRepoEntry` / `orgRepoEntry`。
- `services/cabin/cabin-init-service.ts`：门禁 `克隆 ORG 仓库` / `项目 / 主线登记`；clone 只克隆 ORG、本地只校验；
  mainline 只登记 `main_path` + `mainline_branch`，**不建 worktree**；写舱 `CLAUDE.md`（只读门槛 + 开工作树命令）。
- `services/cabin/cabin-service.ts`：`CreateCabinInput.projects` 三来源；`repoViews`；`addRepo`（不建工作树）；
  `removeRepo`（活跃任务 409，不动磁盘）；`openRepoWorktree`（主实例 / 并行子目录、repeat 409）；
  `pullRepo`（clean-main 镜像同步 / pin 只 ff-only）；`listJobsView.project_keys`（task / workflow / subagent 三类锚点）；
  `usage.byJob.project_keys`。
- `services/workspace-git.ts`：`initWorktreeOne(..., { clobber, worktreePath })`；`clobber:false` 时不删活工作树、报 `worktree_exists`。
- `services/git-ops.ts`：`pullFastForward`（fetch + merge --ff-only）。
- `routes/cabins.ts`：`GET /repos`（key/source/external，富化回落 `worktree_path ?? main_path`，`?enrich=0`）、
  `POST /repos`（三来源）、`DELETE /repos/:name`、`POST /repos/:name/worktree`、`GET /local-projects?path=`、
  `CabinRepoInputError` → 400。

**前端**

- `lib/cabin-api.ts`：`CabinRepoEntry` / `CabinRepoWorktree` / `LocalProjectCandidate`、`fetchCabinRepos` /
  `scanLocalProjects` / `addCabinRepo` / `removeCabinRepo` / `createRepoWorktree`；`CabinJobView.project_keys`。
- `lib/cabin-draft.ts`：`CabinProjectRef` 三来源 + `projectKey` 与 server 同构。
- `components/cabin/CabinProjectBinder.tsx`：本地组置顶、深度 1 默认勾选、来源标、舱外目录显式登记；`autoSelectLocal`。
- `components/cabin/CabinCreateHero.tsx`：目录 → 扫本地、回显文案、payload 透传来源。
- `components/cockpit/projects/*`：`project-model`（key 解析 / 锚点 / 统计）、`use-cabin-projects`（30s 缓存 + in-flight + 失效订阅）、
  `CockpitProjectsPopover`（HUD 读数 + 浮层）、`CockpitManifestFace`（舱籍面）、`CockpitProjectFace`（项目面）、
  `CockpitRepoBinder`（绑定面板，portal）。
- 座舱接线：`CockpitRef` 增 `project`；`?project=<key>`（舱籍面 `__roster__`）；HUD 读数；`CockpitFace` 分发；
  左栏项目筛选胶囊 + 行内项目名；作业头项目签；`app/cockpit/projects.css`。

### 9.3 验证

| 项 | 结果 |
|---|---|
| `pnpm --filter @octopus/server test` | 3625 passed（新增 `cabin-repos` / `cabin-projects` / `cabins-repos-routes` + init 混合舱用例） |
| `pnpm --filter @octopus/web-app exec vitest run` | 1525 passed（新增 `cockpit-projects` 9 例 + binder 本地/外部 3 例） |
| `pnpm lint` | 0 errors（32 条既有 warning） |
| `web-app build` / `server build` | 通过 |
| 真应用走查（隔离 server 3201 + vite 3211） | HUD `⧉ 舱籍验证 2 项目`；浮层 ORG/本地分组；项目面仓库字段；`开工作树` 落 `projects/ledger`、重复开提示不覆盖；解绑后 HUD 立刻变 `＋ 绑定项目`；主仓 `git status` 干净；0 JS error |
| API 走查 | 新建舱 config 只有项目登记、无 `projects/<name>`；`/repos` 无 worktree 也富化；`/pull` 只快进；409 冲突 |

### 9.4 已知限制

- 历史舱的合成 task 行（无 job 账本）没有 `project_keys`，项目筛选下会隐藏 —— 不猜归属。
- 深度 2 的本地项目默认不勾选（建舱时）；绑定面板不自动勾。
- 消耗只合计已定价行；`complete=false` 时 UI 标注「部分行未定价」。
- 老舱已预建的 worktree 保留，不回收（与本轮「不预建」不冲突）。
