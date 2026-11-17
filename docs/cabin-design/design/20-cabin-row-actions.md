# 20 · 左栏作战舱行：重命名 / 删除（软删除 + 可选删本地文件）

> 日期：2026-11-15 · 需求方口径：见 §0
> 代码：`chat-sidebar.tsx` · `CabinRowDialogs.tsx` · `use-cabin-row-actions.ts` ·
> `CabinChatHost.tsx` / `ChatTab.tsx` / `ConversationHome.tsx` ·
> `routes/cabins.ts` · `services/cabin/cabin-service.ts` · `db/dao/cabin-dao.ts`

---

## 0. 用户原话

> 现在设计删除坐垫仓（作战舱）的功能，如果点击删除的话会有确认弹框，然后默认不勾选同时删除本地文件。
> 如果勾选上的话就要删除本地文件。还有，因为我们这个是要计费的，它跟那个 task 一样都是软删除。
> 然后就是还有的就是重命名的功能，这个跟那个任务一样，在左边菜单里面，如果是鼠标移过去有点点点，
> 然后按击点点点的时候出的菜单。

拆成三条：

1. **删除要有确认弹框**，弹框里一个「同时删除本地文件」勾选框，**默认不勾**；勾上才删本地目录。
2. **删除 = 软删除**（跟任务一样）—— 平台要计费，账不能删。
3. **重命名**：跟任务行一样，左栏行 hover 出「⋯」，点开菜单里有重命名。

---

## 1. 交互

```
左栏「作战舱」
  c1  电商舱   草稿     ← hover：状态字让位给「⋯」
                              │
                     ┌────────┴─────────┐
                     │ ✎ 重命名          │ → 小弹框（输入框 + 保存 / 取消）
                     │ ⧉ 复制名称        │
                     │ 🗑 删除           │ → 确认弹框
                     └──────────────────┘

确认弹框（删除）
  删除作战舱？
  「电商舱」将从左栏消失。平台计费，所以这是软删除：计费、Trace 与验收历史都保留，可追溯。
  /Users/…/.octopus/workspaces/cabin-1115-173301-0d7d90
  ┌──────────────────────────────────────────────┐
  │ ☐ 同时删除本地文件                            │   ← 默认不勾
  │   ⚠ 上面的目录会被整块删除，不可恢复。默认不勾。│
  └──────────────────────────────────────────────┘
                                   [取消] [删除 / 删除舱和文件]
```

- 桌面普通对话与舱内左栏是同一个 `ChatSidebar`：两处都接了回调（桌面经
  `ChatTabCabinBridge`，舱内经 `CabinChatHost`），所以两处行为一致。
- 删的是**当前打开的舱** → 删完立刻离开（桌面壳 `onExitCabin`；深链 `router.push('/')`）。
- 重命名先在服务端取最新 `version` 再乐观锁 `PATCH`（列表里的 version 可能停在 30s 前）。

---

## 2. 服务端：软删除的边界

`DELETE /api/cabins/:id[?delete_files=1]` → `{ ok: true, deleted_files }`

| 对象 | 处理 | 为什么 |
|---|---|---|
| `cabins` 行 | `deleted_at = now`，**保留** | 软删除；列表 / `GET /:id` 从此 404 |
| 任务（`tasks`） | 软删（`deleteTask`） | 跟任务删除同语义：隐藏、不丢 |
| 会话（`sessions`） | 软删（`is_deleted=1`） | 否则舱主会话会漏进「会话」列表 |
| `executions` / `llm_calls` / Trace / 验收 | **一律保留** | **计费与审计的账本，删了就对不上账** |
| `cabin_jobs` / `cabin_job_events` | 保留 | 审计与按作业归集的消耗还要能追 |
| `workspaces` 行 | **保留** | `executions.workspace_id` 有外键指着它；任务也是「删任务留空间」 |
| 磁盘工作树 | 尽力移除（与原来一致） | 临时检出，不是账 |
| 舱目录 `row.path` | 默认不动；`delete_files=1` 才 `rm -rf` | 用户明确勾选才删；带防呆（拒绝 `/`、home、home 的父级、非绝对路径） |

**唯一约束**：`cabins.path` 原来是全表唯一，软删的行还占着 path，同目录就再也建不了新舱。
改成部分唯一索引 `WHERE deleted_at IS NULL`（schema.sql 与 DAO 启动时的 ALTER 都做一遍，
兼容已存在的库），软删后同一目录可以再建。

**attach 复原**：目录里 `.cabin/manifest.json` 还在、DB 行已软删 → 按 manifest 的 id 复原
（`revive`：`deleted_at = NULL` + 覆盖 name/path/status/requirements），不撞主键。

---

## 3. 验证

- 服务端：`pnpm test`（server 全量）**3596 passed**；新增用例
  - 软删：行留墓碑、任务/会话软删、execution 行保留、目录默认不动；
  - `deleteFiles: true` 删目录 + 根/home 防呆；
  - 软删后同目录可再建；attach 从墓碑复原；
  - 路由：默认 `deleted_files:false` 且目录还在；`?delete_files=1` 目录消失。
- web：**1513 passed / 192 files**（新增 5 条：菜单顺序、重命名回写、删除默认不勾、
  勾选传 true、无回调不出「⋯」）。
- 真应用走查（3011 + 3001，Playwright，0 console error）：
  桌面列表重命名 → 删除（默认）→ 行消失 / API 404 / 目录还在；
  再建一个 → 勾选删除 → 目录消失；舱内改名 → 删除当前舱 → 被请出舱回桌面。
- lint 0 error；web / server 构建通过。