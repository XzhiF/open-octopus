# Octopus — AI 开发平台

> TypeScript monorepo · 对话桌面 + 作战舱 + 多阶段任务 · v1.0.0
> https://github.com/XzhiF/open-octopus

## 产品形态（先读这一节）

Octopus 已经不是「工作流编辑器」。当前产品：

- **对话桌面** —— 对话是底层；9 个应用以单实例浮动窗口打开（`lib/desktop-windows.tsx`）。
- **作战舱 (Cabin)** —— 一个目录一个舱，长期存活。舱内只有三样：任务、会话、待你决定。
- **任务 (Task)** —— 唯一的工作单位。v4 是多 phase 制：谈规格 → 逐 phase 执行 → 逐轮验收 → 归档。
- **工作流是内部执行引擎**，不是用户主界面。每个 phase 通过 `workflow_ref` 绑定一条工作流；
  用户不手写 YAML，也不以工作流为入口看系统。

代码改动前先判断它属于哪一层：桌面壳 / 舱 / 任务域 / 引擎。不要把引擎能力重新抬成产品入口。

## 源码结构

```
octopus/
├── packages/
│   ├── shared/     ← @octopus/shared (Zod 协议 · 任务/舱/工作流 Schema · VarPool)
│   ├── providers/  ← @octopus/providers (Claude SDK + Pi SDK · token/成本追踪)
│   ├── engine/     ← @octopus/engine (工作流引擎 · 11 执行器 · Swarm · 模拟器)
│   ├── server/     ← @octopus/server (Hono REST + SSE/WS · 任务/舱/知识/调度服务)
│   ├── web-app/    ← @octopus/web-app (Vite SPA · 对话桌面 + 作战舱 + 指挥舱)
│   ├── desktop/    ← @octopus/desktop (Electron 宿主 · Node sidecar)
│   ├── cli/        ← octopus (Commander.js，内部工具)
│   └── core-pack/  ← skills / agents / clones / workflows / presets
├── scripts/        ← dev.mjs · prod.mjs · branch-port.mjs
└── docs/           ← 设计稿 · 原型 · 研究报告
```

包依赖：

```
shared ← providers ← engine ← server
shared ← cli / web-app
core-pack ← server
```

## Web 桌面前端

- 对话是桌面底层；9 个应用（今日 / 任务看板 / Agent / 分身 / 知识中心 / 资源 / 系统调度 /
  系统管理 / 设置）以浮动窗口打开，详情在所属窗口内钻取。
- 全局 URL = 焦点目标的完整路由；切焦点 `replace`，窗口内导航 `push`；深链打开归属窗口。
- 每个窗口 / 桌面层有独立导航作用域；全局快捷键先过 `useIsActiveRoute`，隐藏窗口由 capture 门禁兜底。
- 窗口几何 / 顺序 / 最小化持久化在 `localStorage['octopus.desktop.v1']`；窗口总览实时缩放已挂载窗口 DOM。
- 运行中 agent = `GET /api/agent/sessions/running`（服务端内存流），header 从右往左排列。
- 路由表在 `web-app/lib/routes.tsx`；应用目录在 `web-app/lib/app-catalog.tsx`。

## 任务域（tasks）

- **状态**：`draft → ready → running → awaiting_review → awaiting_archive → archiving → done`；
  `paused` 是派生值（真相在 `executions.status`）。
- **人工闸门只有三处**：入列（draft → ready）、验收（awaiting_review）、归档（awaiting_archive → start_archive）。
  启动 / 触发可自动，不需要人工确认。
- **v4 task_spec**：`format=v4` + `phases[]`。每个 phase 含 `name` / `slug` / `specPath` /
  `workflowRef` / `inputValues` / `experts`。
- **spec 写入**：`POST /api/tasks/:id/spec-field` 逐字段写 + 乐观锁 PUT；`spec_field_update` SSE 同步面板。
- **触发**：`manual` / `once` / `cron` 是任务自己的字段，走 `/api/tasks/:id/trigger`，不经过 scheduler。
- **task home**：`~/.octopus/tasks/{id}/` —— `manifest.json` / `context.md` / `skills/` /
  `artifacts/` / `workflows/` / `.scratch/<date>/<slug>/`（spec + issues + 报告）。
- **每轮证据**：每轮落 diff / 测试 / 报告；变更窗 = commit 区间。脏树会导致空变更，收尾必须落盘。
- **验收**：两层——1–3 条人验收场景（`acceptance-plan-rN.json`）+ 机器证据表；不逐项签。
- **归档**：验收 ≠ 归档。末 phase 通过后停在 `awaiting_archive`（持久态仍是 ready），
  人说「归档」才启动 git / PR / 知识沉淀。`done` 之后不再开写。

## 作战舱与指挥舱

- 一个目录一个舱；任务 / 会话 / 执行只记单一 `cabin_id`，写一次，不跨舱引用。
- 数据表：`cabins` / `cabin_jobs` / `cabin_job_events` / `cabin_delegations`；attention 与 health
  由 `deriveCabinView` 纯派生，不落库。
- attention 的 `stage`：`answer`（待你定）/ `start`（入列 / 触发 / 恢复）/ `review`（待验收）/
  `adjudicate`（待裁决）/ `approval`（待审批）/ `blocked`（受阻）。
- 汐音 = orchestrator 的拟人面，不是独立 agent；她的发言要能回答「谁说的 / 根据什么」。
- 两种壳：`/cabin/:cabinId`（classic 作战舱）与 `/cabin/:cabinId/cockpit`（全域指挥舱），
  共享同一套任务 / 舱 API。
- chat 内容按终端 TUI 语法渲染（`❯ 你` / `✦ 汐音 + meta` / `▸ tool` / 系统行）；
  换皮肤不换内容，所有皮肤同一份消息。

## Workflow Engine（内部）

- **11 种执行器**：bash / python / agent / condition / approval / loop / swarm / interaction /
  sub_workflow / dynamic_sub_workflow / octopus_agent。
- **Swarm 5 模式**：review / debate / dispatch / swarm / moa。
- 变量：`$vars.xxx` / `$node-id.output.xxx` / `$last_output` / `$iteration`。
- 依赖自动推导为 DAG 并行；检查点恢复、Token / 成本预算、生命周期钩子、Harness 三层守护。
- YAML 来源：`core-pack/workflows/` 与 task home 的 `workflows/`。

## Workspace 隔离

| 模式 | Server | Web | DB |
|------|--------|-----|-----|
| dev（主仓库） | 3001 | 3000 | `~/.octopus/db/octopus.db` |
| dev（worktree） | 3100–3598 | +1 | `octopus-{branch}.db` |
| prod | 3000（与 dev 的 Web 同端口，不可同时开） | 3000（同源托管 SPA） | `octopus-prod.db` |

## 开发与测试

```bash
pnpm install          # 安装依赖
pnpm build            # 构建所有包 + 同步内置资源
pnpm dev              # 主仓库开发 (web:3000 server:3001)
pnpm dev --isolated   # 隔离模式
pnpm dev --port 3101,3100    # 指定端口 (web 在前, server 在后)
pnpm prod             # 生产模式（同源，直接跑仓库 dist）
pnpm desktop:dev      # Electron 桌面壳（需先 pnpm dev）
pnpm test             # Vitest
pnpm lint             # eslint（web-app）
pnpm kill:port <n>    # 杀占用端口的进程
```

- worktree 里跑测试同样先 `pnpm build`。Git Bash 陷阱见 `docs/agents/windows-bash.md`。
- 用户级运行数据都在 `~/.octopus/`（db / tasks / workspaces / knowledge / orgs）。

## 命名规范

- Skill 前缀 `octo-`；Agent 用描述性名称；包名 `@octopus/{name}`。
- 单一版本来源：root `package.json` → `shared/src/version.ts`。

## 领域知识与产物

- 任务产物：task home 下 `.scratch/<date>/<slug>/` 的 markdown（spec / issues / 报告）。
- 领域知识以 `~/.octopus/knowledge/wiki` 为准；查阅协议见 `octo-wiki` skill。
- Triage labels：needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix。
- 仓库内不再维护 GLOSSARY / ADR / feature 档案。

## 汇报约定（用户偏好 · 记忆）

- **原型类 / 文档类 / 产物类输出，面向用户汇报时一律给 Windows 绝对全路径**（盘符开头）。
  例：`C:\xzf\ai\open-octopus\docs\cabin-design\cockpit-v22.html`。
- 需要打开时直接用全路径打开（浏览器 / 资源管理器），并在回复里复述该全路径。
- 此约定只约束面向用户的汇报文本；代码内部引用与 git 操作仍可用相对路径。
- 舱系原型（cockpit / cabin / classic）为暗色舰桥科幻风，沿用 `docs/cabin-design/` 既有 token 与
  立绘 `crew/`；用户级 memory 中「白色系原型」一条仅适用于 report-web 后台类方案，不适用于舱系原型。
