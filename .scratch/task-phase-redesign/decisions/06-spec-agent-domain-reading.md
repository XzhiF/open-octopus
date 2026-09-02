# 06 — 升级版 spec agent 领域阅读能力（research）

Type: research
Status: resolved

## Question

升级 spec agent 要"站在 task 空间读各 involved project 的 CONTEXT.md/ADR/.scratch 做领域决策，再在本地产出 .scratch/adr/context.md"。摸清现有设施：

1. task-author clone 会话的 cwd 与文件可见性（能否直读 project 仓库路径？安全边界/safe mode）
2. task_spec.projects / resources / authoring_resources 字段现在的语义与注入链（augmenter prompt-inject vs ws 期 resources[]）
3. octopus repos index（rebuild-index 产物格式）与 octo-dev-copilot 的跨项目搜索能力——可否作为 agent 读 project 的通道
4. 现有 .scratch/index.md、CONTEXT-MAP.md 惯例在 project 仓库的落地样例
5. 拆 phase 规则（deliverable 定义、1~1.5h 预算、3~5 人天→N phase）写进 skill 的可行位置与现有 skill 结构（task-author SKILL.md 9 字段流程需改成什么）

## Answer

### 结论先行

**「读 project 领域模型」今天是『已经能做』**——会话 cwd、绝对路径、读权限、project 路径发现通道四要素全部就位，缺的只是**引导文本与产物落位约定**（skill/rules 层，零代码）。「写本地 matt 产物」机制就绪但缺 schema 承载（票 02 的 phases 字段）。「归并回写各 project」在草稿会话被硬护栏禁止（这是正确设计，回写必须走 workspace/PR，票 07/08 的领域）。

### 1. 会话运行环境与安全边界（读 ✅ / 写 ⛔ 精确到位）

- **cwd = task home**：task-author 发送路径 `routes/clone/index.ts:409-412`（`const cwd = taskHomePath || defaultCwd`），默认 cwd 是 clone 目录（`clone-runtime.ts:219-224`），task-author 被覆盖为 `~/.octopus/tasks/{id}/`。**推论：matt 技能的相对路径 `<artifacts.dir>` 天然解析进 task home**——Batch 目录 `.scratch/<YYYYMMDD>/<slug-N>/` 直接写 `./.scratch/...` 即可，零适配。
- **读全部放行**：provider 层 `canUseTool` 末路 default-allow（`providers/src/claude/provider.ts:289-322`），且 `allowDangerouslySkipPermissions: true`（:333，注释说明刻意不设 bypassPermissions 以保 canUseTool 生效）。PreToolUse hook（:75-122）只拦 AskUserQuestion/complete_interaction。
- **写被硬锁在 task home**：`buildPathGuard`（`clone-runtime.ts:697-755`）只拦 `Write/Edit/NotebookEdit`，注释明示 **"Read-only tools (Read, Glob, Grep, LS, etc.) are always allowed"**。⚠️ 两个缺口：① Bash **不在拦截名单**——`echo x > /tmp/...` 可绕开写锁（现依赖 rules 文本自觉；红线场景需补 Bash 重定向检查或 SDK disallowedTools）；② 拦截在 clone-runtime 调用点生效（taskHomePath 存在才挂），与 safe-mode 开关无关。
- 双重防御：`task-home-service.ts:272-295` 注入的 `.claude/rules/task-context.md`（advisory，"强制：所有文件必须写入工作目录内"+ 外部资源须 `artifacts.json` 登记 `external:true` 才可被产物 API 读）+ 上述 hook（mandatory）。
- 技能加载：`getPlugins(taskHomePath)`（`clone-runtime.ts:243-259`）三层 plugin——`~/.octopus/agent/`（全局 octo-*）+ `~/.octopus/agent/built-in/task-author/`（clone 专属）+ task home。

### 2. project 定位链（全通，零缺口）

```
TemplatePicker ProjectSelector（存 name）
  → onCreate → createTask preset.projects → project_ids（tasks-service.ts:436,458）
  → resolveProjectRefs（tasks-service.ts:400-411；clone 路由同款 :70-86）
  → WorkspaceGit.resolveRepoPath(org,name)（workspace-git.ts:27-66）
     读 ~/.octopus/orgs/{org}/repos/index.md 正则提取 `- local: <绝对路径>`
  → context.md 渲染 `- project: {name} → {path}`（task-home-service.ts:170-182）
  → agent 按需 Read context.md（rules 指路；@@context_updated 通知重读，:292）
```

- repos index.md 是 CLI `octopus repos rebuild-index` 的产物（`shared/src/repo-ops/mod.ts`，路径约定 `repos-config.ts:35-44`），每条目自带 `- git: - branch: - desc: - keywords: - knowledge: - local:` 六行——**发现成本为零，agent 拿 path 即可 Glob/Read 项目内 CONTEXT-MAP.md / packages/*/CONTEXT.md / docs/adr/ / .scratch/index.md**。
- `authoring_resources` 是另一条链：draft-scope skill 全文 prompt-inject 进 systemPrompt.append（`task-author-session-augmenter.ts:52-79`，仅 skill 类型），与 project 读取无关；`resources[]` 是 workspace-scope → 物化进 workflow.requires（dispatch 期）——升级版若仍要"按 phase 带技能"，后者通道不变。
- ⚠️ project 解析是**创建期快照**进 context.md，project 后来换路径不自动跟随（低频，可接受）。

### 3. octo-dev-copilot 复用度：低（定位不同）

`core-pack/skills/octo-dev-copilot/SKILL.md`（299 行）是 **octopus 自身微服务生态**的编码助手：目录速查（:26-60）、跨项目搜索、接口契约发现、影响分析——搜索路径假设 octopus repos 拓扑，**不是**任意 org 的 project 领域阅读器，不建议作为升级版基座（可借它的"影响分析"提问清单做拆 phase 参考）。真正可复用的是底下的 index.md 通道（第 2 节），与 skill 无关。

### 4. project 侧惯例落地现状

- 本仓库 = 完整范例：根 `CONTEXT-MAP.md`（58+ 术语表，含 Package Contexts 索引）、`packages/*/CONTEXT.md`、`docs/adr/`（0010-0017 活跃）、`.scratch/<feature>/`（task-authoring-v3 等历史 feature）。CLAUDE.md:96 明确 `.scratch` 即 `<artifacts.dir>`。
- **缺口**：org 内其他 project 是否都按 matt 惯例（有 CONTEXT-MAP/.scratch）无系统校验——升级版 skill 的领域阅读第一步应 probe（`ls {path}/CONTEXT-MAP.md {path}/.scratch/index.md`），缺则按「无领域文档 project」降级并在产物里标注；未来可提供 octo-* 资源安装惯例（不在本设计范围）。

### 5. task-author SKILL.md 改造评估（275 行，保留骨架换心脏）

| 段落 | 行号 | 处置 |
|---|---|---|
| 前置条件（API 基址/index.md 说明） | :22-26 | 保留 |
| 9 字段 schema 教学 | :28-48 | **重写** → task_spec + `phases[]`（schema 等票 02） |
| spec.json 快照读取协议 | :50-65 | 保留 + 扩展 phases 视图 |
| API 端点 1-5（curl 骨架） | :67-136 | 保留骨架；spec-field 字段表 :94-104 换字段；**新增** phases 读写端点 + per-phase spec-field |
| 资源加载两 scope | :138-143 | 简化（技能组退场后 authoring_resources 存在感下降） |
| 物化 A 简单 / B 复合 | :144-176 | 改「phase 物化」；B 复合保留（out of scope） |
| HOW-handoff（枚举+preset 过滤+自建 validate） | :177-258 | **重写**：preset 过滤退役 → 工作流目录浏览（`GET /api/workflows/built-in`，09 建议），**每 phase 一次绑定** |
| 交互风格/错误码 | :260-275 | 保留 |

**全新章节**（现文件无对应）：① 领域阅读流程（context.md → project 路径 → probe 惯例文件 → 术语进 brief.md）；② 拆 phase 方法论（deliverable 定义：phase 末可运行可验收；1~1.5h agent 预算；3~5 人天 → 4~5 phase；依赖排序、phase 间验收锚点）；③ 内置 matt 技能族的使用协议（grilling/wayfinder → 每 phase 产 `spec.md + issues/` 进 `.scratch/<YYYYMMDD>/<slug-N>/` → 登记 artifacts.json）；④ 拆分确认 gate（多 phase 时枚举拆分表请用户确认后才绑 workflow）。配套代码动作只有两个：matt 族 skills 拷进 `~/.octopus/agent/built-in/task-author/skills/`（目录已存在，plugin 扫描零代码）+ 若红线 Bash 绕写锁则补 guard（独立小票，建议入票 07）。

### 6. 其他三票的直接输入

- **票 02**：agent 已把 `{home}/spec.json` 当权威快照读——phases 进 spec.json 视图（server 重写）比逼 agent curl 更符合现有协议。
- **票 07**：Batch 目录直接复用 task home 相对路径约定（rules 的 `docs/superpowers/specs/... → 工作目录` 解析规则 :281-284 已为此设计）；artifacts.json `external:true` 登记是现成的"跨目录产物暴露"通道，workspace 侧产物回看可走同机制。
- **票 01**：领域阅读/拆 phase 都发生在 ready 之前——状态机不需要为它加态；升级 agent 的产物就绪标志可作为 gate 项之一（"每 phase 有 spec.md"）。
