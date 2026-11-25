# 分身任务（clone-dev）设计定稿 v1

> 状态：设计已定稿，原型迭代中，实现未开始
> 日期：2026-11-24
> 原型：`docs/cabin-design/classic-clone-task-v1.html`
> 本文是开发期的**唯一事实来源**；上下文被压缩后以本文为准。

---

## 0. 一句话

新增一种任务 `kind=clone-dev`：用一个内置的「铸分身者」分身，通过**纯 chat** 把用户的一句话需求变成**一个真正能用的分身**（人格 + 技能 + 可选的进程内工具包），在独立 git worktree 里开发与验证，人点一次确认后合入主分支并自动安装。

---

## 1. 目标 / 非目标

### 目标

- 用户从「分身」应用或任务看板发起创建，全程只对话，不填表单。
- 产出的分身可**切换身份**、可**被委托**，与内置分身同等可用。
- 工具是真正可执行的进程内 MCP 工具，可读写 DB、调用服务，不是提示词。
- 分身资产（尤其工具包）是**独立可删的包**：删掉它不影响核心功能。
- 复用现有任务域：状态机、任务主会话、worktree、验收、归档、版本。

### 非目标（v1 不做）

- 不做工作流引擎驱动（不生成 phase，不产生 execution 行）。
- 不做分身模板 / 从现有分身复制。
- 不做真实数据的静态原型联调。
- 不做工具包之间的互相依赖。
- 卸载不进验收闸门。
- 不做“核心改动”自动放行：工具若需要核心配合，必须列清单人工确认。

---

## 2. 现状事实（2026-11-24 实地核对）

| 事实 | 落点 |
|---|---|
| 分身是文件系统定义 + DB 影子行 | `~/.octopus/agent/{built-in,clones}/<name>/{config.json, persona.md, skills/, memory/, CHANGES.jsonl}`；DDL `db/schema.sql:761-772` |
| 内置分身 9 个 | `services/agent/builtin-clones.ts:354-473` |
| persona 是纯 Markdown，技能靠 SDK `plugins` 扫描 `skills/` 原生发现 | `clone-runtime.ts:259-271`，`:441` |
| `config.skills` 不参与运行时过滤 | `clone-runtime.ts:516-590` 是死代码 |
| 分身目录**没有 git** | 全仓 `git init` 只在 workspace 项目仓 |
| 分身与 worktree 无关 | worktree 只属于任务与舱 |
| 分身聊天路径**没有 `mcpServers` 槽** | `clone-runtime.ts:428-462` |
| 进程内工具只在主 chat 装配 | `routes/agent/chat-routes.ts:539-580` → `provider.ts:519-554` |
| 已有单步创建弹窗 | `components/agent/clone/CloneCreateWizard.tsx`（name/display_name/memory_scope） |
| 版本机制已存在 | `agent_versions` 表 + `/api/clones/:name/versions`（发布/列表/详情/diff/回滚/归档）；快照仅 persona + config + 技能**名列表** |
| `config.versioned` 含义 | 仅「启动时自动发 1.0.0」，目前只有 workflow-operator |
| 版本 diff 有既有 bug | 后端返回对象，前端按 string 调 `.trim()` |
| `workflow-dev` 不走引擎 | 主会话推进；`deriveTaskView` 只产出 `ready` / `awaiting_archive`；`finish_workflow_dev` 写 `draft→ready` 并发 `awaiting_archive` |
| 任务看板不区分 kind | 前端没有任何地方读 `task_spec.kind` |
| 右栏真实模块 | 10 个 TaskModule（workflow/run/plan/changes/acceptance/usage/debug/artifacts/archive/subagents）+ 常驻 pane（files/activity）；无模块注册表，新增要改 4 处 |
| 任务 kind 枚举 | `shared/src/types/scheduler-job.ts:382` 仅 `"workflow-dev"` |

---

## 3. 决策清单（编号 = 评审时的 Q 号）

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 产品形态 | 入口在分身应用/桌面 → 落成一条 `clone-dev` 任务；不走工作流 |
| Q2 | phase 划分 | **不拆 phase**，一次开发完 → 验证 → 合入 |
| Q3 | 原型范围 | 先 classic 壳；cockpit 后续接入 |
| Q4 | custom 语义 | 用户自定义分身（区别于内置），产物必须真能用：可切换身份、可被委托 |
| Q5 | 验证判据 | 见 §6，三条硬闸 |
| Q6 | 标准字段 | 复用 `CloneConfig` + 扩展工具/权限/验证字段 |
| Q7 | 执行模型 | `kind=clone-dev`，任务线程 + 独立 worktree |
| Q8 | 包落点 | 开发期 `packages/clone-kits/<slug>/`；合入时装到 `~/.octopus/agent/clones/<name>/kit/` |
| Q9 | 铸分身者边界 | 可改任何分身资产；禁止改 shared/server/engine/web-app 核心 |
| Q10/Q22 | 版本 | 复用 `agent_versions`；初始 1.0.0；每次合入叠加；快照扩到覆盖 kit |
| Q11/Q14 | 交互 | 朴素 chat，无向导；右栏一个「分身」业务弹窗 |
| Q12 | 编辑 | 编辑既有分身也走 worktree → 验证 → 合入 |
| Q13 | 右栏 | 五个固定入口：文件 / 活动 / 调试 / 消耗 / 子代理 + 高亮「分身」按钮 |
| Q15 | 命名 | `kind: "clone-dev"`，`task_spec.mode: "create" \| "edit"` |
| Q17 | 工具形态 | 进程内 MCP 工具（`createSdkMcpServer` + `tool()`），配套 SKILL.md 描述；简单分身可无工具 |
| Q19 | 依赖方向 | kit → 核心 允许；核心 → kit 禁止；kit → kit 禁止 |
| Q20 | 卸载 | 实现 `clone uninstall`，**不进验收闸门**，独立测试覆盖；详情页留入口 |
| Q21 | 看板 | 加 kind 筛选：全部 / 开发 / 工作流 / 分身 |
| Q23 | 状态机 | 对齐 workflow-dev：`draft → awaiting_archive → archiving → done`，无 running/awaiting_review |
| Q24 | 验证三条 | 工具调用成功 / 越权被拦 / 身份切换可用 |
| Q25 | 卸载归属 | 放在 clone-dev 任务内实现，不单独开任务 |
| Q26 | 可改范围 | 什么都能改（工具增删、技能变化、内置分身也可） |
| Q27 | 验证环境 | worktree 内独立实例 + 独立 DB |
| Q28 | 安装时机 | 合入即安装，不做单独 install 步骤 |
| Q29 | 内置分身 | 允许编辑（最终走 merge 生效） |
| Q30 | 无工具分身 | 不生成 kit 包 |
| Q31 | 加载时机 | 会话开始按分身懒加载，合入即生效，无需重启 |
| Q32 | 原型 | 单文件 HTML，沿用 classic 舰桥风 |
| Q33 | 业务弹窗 | 7 tab：分身卡片 / 人格 / 工具 / 技能 / 权限与边界 / 验证清单 / 包与台账 |

---

## 4. 架构设计

### 4.1 数据模型

```ts
// shared/src/types/scheduler-job.ts
kind: z.enum(["workflow-dev", "clone-dev"]).optional()

clone_dev: z.object({
  mode: z.enum(["create", "edit"]),
  clone_name: z.string(),            // slug
  clone_type: z.enum(["built-in", "user"]),
  stage: z.enum(["draft", "verified", "merged"]),
  kit: z.object({
    enabled: z.boolean(),
    package: z.string().optional(),  // packages/clone-kits/<slug>
    tools: z.array(z.string()),
  }),
  verification: z.object({
    tools_called: z.boolean(),
    boundary_blocked: z.boolean(),
    identity_switch: z.boolean(),
    evidence: z.array(z.string()),
    ran_at: z.string().optional(),
  }),
  complete: z.boolean(),
}).optional()
```

任务不新增 DB 列，全部放 `task_spec` JSON。

### 4.2 状态机

```
draft ──finish_clone_dev(三条全绿 + 人确认)──> awaiting_archive
      ──start_archive──> archiving ──merge+install+register 成功──> done
```

- 持久态只在 `finish_clone_dev` 时 `draft → ready`（与 workflow-dev 一致）。
- `deriveTaskView` 对 `clone-dev` 返回 `ready` / `awaiting_archive` / `archiving` / `done`。
- 不产生 execution 行；工具调用与验证证据写 task home。

### 4.3 身份

- 新内置分身 `clone-author`「铸分身者」
  - 资产源：`packages/core-pack/clones/clone-author/{persona.md, skills/}`
  - 技能：`octo-agent-clones`（改写）、`octo-skill-creator`、`octo-wiki`
  - 注册：`builtin-clones.ts` 清单 + `clone-init-service.ts` 资产同步
- 任务线程选择：`task-thread-service.ts:360` 增加 `clone-author` 分支
- 每回合 playbook 说明：问需求 → 反问（一次一个，带推荐）→ 写 kit → 验证 → 汇报 → 等待人确认合入

### 4.4 工具机制

- 定义：`packages/clone-kits/<slug>/index.ts` 导出 `createKitServer(ctx)`，内部用 `tool()` 注册
- 装载：server 侧 `clone-kit-registry.ts` 懒加载 `~/.octopus/agent/clones/<name>/kit/index.js`，按分身名缓存
- 注入：`clone-runtime.ts` 补 `mcpServers` 槽（对齐 `chat-routes.ts:539-580`）
- 依赖约束（可检查）：
  - kit 可 import `@octopus/providers`、`@octopus/shared` 以及 server 服务
  - server 源码中**不得出现** `clone-kits` 的任何 import（CI 检查）
  - kit 之间不得互相 import（CI 检查）
- 无工具分身：`kit.enabled=false`，不建包，不加载

### 4.5 版本

- 发布点：合入成功后自动 `publish(version)`；首个为 `1.0.0`
- 快照扩展：`{ persona, config, skills[], kit: { files: [{path, sha256}], manifest } }`
- 回滚：分身定义直接覆盖；kit 按 hash 从仓库对应 commit 重建
- 已知既有 bug（顺手修）：版本 diff 前后端契约不一致

### 4.6 卸载

- `clone uninstall <name>`：停用会话 → 删 `~/.octopus/agent/clones/<name>` → 注销 `clones` 行
- 不删仓库里的 `packages/clone-kits/<slug>`（那走一次普通合入删除）
- 独立自动化测试：卸载后核心 build / 启动 / 其他分身可用

### 4.7 验证

- 环境：worktree 内起独立 dev（vite + server + `octopus-{branch}.db`），端口按现有 3100–3598 分配
- 三条硬闸由 `clone verify <name>` 脚本执行，结果写入 `task_spec.clone_dev.verification`
- `finish_clone_dev` 在服务端二次校验三条全绿，否则拒绝

---

## 5. 实现阶段（勾选推进）

> 每阶段完成即打勾，并在本行后补 commit hash。
> 分支：`feat/clone-dev-task`（worktree `../open-octopus-clone-dev`）

### P0 · 文档与原型 ✅
- [x] 设计定稿（本文）
- [x] 原型 v2 高保真（对齐真实 UI 截图：近黑底/暗纹、紧凑字号、竖条 dock、浮窗 chrome、看板六列）
- [ ] 用户确认原型（功能已按定稿实现，原型仅作对照）

### P1 · 任务域接入 ✅
- [x] `shared`：kind 枚举扩 `clone-dev`，新增 `cloneDevStateSchema`
- [x] `derive-task-view.ts`：clone-dev 分支
- [x] `task-title.ts`：标题「分身开发任务」
- [x] 路由：`/api/tasks/:id/clone-dev/*`（GET / meta / verify / complete / install）
- [x] `finish` 服务端硬闸（三条全绿才放行）
- [x] 单测：`clone-dev-derive.test.ts`、`clone-dev-service.test.ts`（9 例）

### P2 · 铸分身者身份 ✅
- [x] `core-pack/clones/clone-author/persona.md`
- [x] `builtin-clones.ts` 注册（skills: octo-agent-clones / octo-skill-creator / octo-wiki）
- [x] `clone-init-service.ts` 资产同步（forkOwnedPersona）
- [x] `task-thread-service.ts` 身份分支 + author/收尾 playbook
- [x] `chat-routes.ts` role 选择 `clone-author`
- [x] 任务专用工具：`clone_dev_get_state` / `clone_dev_set_meta` / `clone_dev_verify` / `clone_dev_finish`

### P3 · 工具包机制 ✅
- [x] `packages/clone-kits/`（`_sdk` + `oncall-eng` 示例）
- [x] 构建：`scripts/build-clone-kits.mjs` + `tsconfig.clone-kits.json`，接入根 `build`
- [x] `clone-kit-registry.ts` 懒加载 + 缓存（用户目录优先，仓库 dist 兜底）
- [x] `clone-runtime.ts` 注入 `mcpServers`（会话级）
- [x] 依赖方向测试：`clone-kit-boundary.test.ts`
- [x] 示例 kit 端到端验证通过

### P4 · 验证与合入 ✅（脚本级）
- [x] `clone verify`：三条判据 + 证据落 `artifacts/clone-verify/<name>.json`
- [x] 越权判定复用同一份路径守卫（`clone-paths.ts`，clone-files 改为委托）
- [x] 归档完成点装包：`endArchiving` → `installKit`（失败停在 archiving）
- [x] 安装自检：kit 目录存在 + 下次会话可加载
- [ ] worktree 独立实例验证（REST 已通；独立 server 实例脚本待补，v1 用主实例 + 临时 home 验证）

### P5 · 版本与卸载 ✅
- [x] 快照扩 kit（`KitSnapshotEntry[]` + `kit-manifest.json`）
- [x] 回滚时从仓库 dist 重建 kit
- [x] `POST /api/clones/:name/uninstall` + `CloneDevService.uninstall`
- [x] 卸载独立测试（核心不受影响）
- [ ] 版本 diff 前后端契约 bug（未在本次范围，保持原样）

### P6 · 前端 ✅（待人工走查）
- [x] 分身任务工作台：`CloneDevWindow` 7 tab，注册为 dock「分身」模块
- [x] 分身应用「用对话创建分身」入口
- [x] 分身详情「编辑分身」入口（预置 mode=edit + clone_name）
- [x] 任务看板 kind 筛选（全部/开发/工作流/分身）
- [x] 侧栏新建菜单「新建分身任务」+ 事件 `octopus:new-clone-task`
- [x] 右 dock 可见性：clone-dev 只显示 分身/运行/消耗/归档
- [ ] 浏览器人工走查（未执行）

### P7 · 端到端验收 ⚠️ 部分
- [x] 有工具分身：REST 全流程（verify 三绿 → complete → awaiting_archive → install → uninstall）
- [x] 无工具分身：服务端单测覆盖
- [x] 编辑既有分身：入口 + 预置 spec 已接（UI 走查未做）
- [ ] 工作流任务/看板筛选的浏览器回归（未执行）

### 实测结果（2026-11-25）
- `pnpm build` 通过（含 clone-kits 构建）
- `pnpm vitest run packages/server/src/__tests__/tasks-` → 34 文件 / 506 用例全绿
- `pnpm vitest run packages/server/src/__tests__/clone-` → 12 文件 / 79 用例全绿
- REST 实测（临时 OCTOPUS_HOME，端口 3131）：
  - 负路径：kit 不存在 → `tools_called=false` → complete 被 409 拒绝 ✅
  - 正路径：`oncall-eng` kit → 三条全绿 → complete → `status=ready` + `derived=awaiting_archive` ✅
  - install → `~/.octopus/agent/clones/oncall-eng/kit/` ✅；uninstall → 目录删除 ✅
  - 内置 `clone-author` 自动初始化并出现在 `/api/clones` ✅

---

## 6. 验收判据（v1 定稿）

| # | 判据 | 证据 |
|---|---|---|
| 1 | 每个声明的工具在真实会话中被成功调用 ≥1 次 | 会话 tool 调用记录 |
| 2 | 故意越权被安全层拦住 | 拦截事件日志 |
| 3 | 分身可切换身份并完成一次真实对话 | 会话记录 |

三条全绿才允许合入；主观质量（人格是否符合预期）走人验收，不进机器闸门。

---

## 7. 原型说明

- 文件：`docs/cabin-design/classic-clone-task-v1.html`
- 三视图：分身任务工作台 / 任务看板 / 分身详情
- 视觉基准：`classic-fleet-v6.html`（token、组件、TUI 语法）
- 原型仅用于确认信息架构与交互，不代表最终像素；开发以真实组件实现为准
- 原型中的示例分身：`oncall-eng`「值班工程师」，3 个工具 + 2 个技能

---

## 8. 风险与待定

- **任务必须绑定目标仓库**：kit 代码写在 project worktree 的 `packages/clone-kits/<slug>/`，所以 clone-dev 任务创建时要绑定 open-octopus 仓库；未绑定时空 workspace 里没有可改的源码（服务端不报错，但 Agent 无处落码）。
- 懒加载工具包的安全性：动态 import 用户目录代码，需要限定路径与签名校验（v1 只做路径/名字白名单）。
- 验证环境成本：每次起独立实例较慢，需要可复用的预热方案。
- 内置分身被编辑后与 core-pack 种子同步策略（`.seed-manifest.json` 会覆盖手工改动，需要更新 manifest）。
- 未做：版本 diff 前后端契约 bug；浏览器人工走查；worktree 独立实例验证脚本。
