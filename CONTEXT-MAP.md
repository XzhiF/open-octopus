# Context Map — Octopus Workflow Platform

## System-wide Glossary

| Term | Definition | Primary Package |
|------|-----------|----------------|
| **Ticket** | 垂直切片 — 端到端功能单元（test + schema + API + UI），可在单个 context window 内完成。 | engine, core-pack |
| **Spec** | 实现契约 — 单一连贯文档，含问题、方案、用户故事、测试决策、Seam 约定、Out of Scope。 | core-pack |
| **Seam** | 可测试的公共边界 — 测试和调用者走同一个接口。数量越少越好，理想为 1。 | core-pack |
| **Grilling** | 逐问决策拷问 — 一次一个问题，带推荐答案。决策归人，事实归环境。 | core-pack |
| **Vertical Slice** | Ticket 的结构约束 — 切片穿越所有层（schema → API → UI → test）。 | core-pack |
| **Blocking Edge** | Ticket 间依赖声明 — 引擎通过 `depends_on` 实现拓扑排序。 | engine |
| **Tracer Bullet** | Ticket 的执行模式 — 从测试到实现到验证的完整路径。 | core-pack |
| **Node** | YAML 中的一个执行单元（agent / bash / python / condition / approval / loop / swarm / interaction）。 | engine |
| **VarPool** | 全局变量池 — `$vars.xxx` 语法访问。节点通过 `vars_update` JSON 写入。 | engine, shared |
| **context: new** | agent 节点属性 — 在全新 context window 中执行，不继承父 agent 上下文。 | engine |
| **Two-Axis Review** | 两轴并行审查 — Standards 和 Spec 作为独立 sub-agent 并行执行，报告不合并不重排。 | engine, core-pack |
| **Standards Axis** | Code review 的代码质量轴 — 12-smell baseline + 项目约定。独立 sub-agent。 | engine |
| **Spec Axis** | Code review 的需求覆盖轴 — 检查实现与 Spec 的对齐。独立 sub-agent。 | engine |
| **RED** | TDD 循环第一步 — 写一个失败测试。 | core-pack |
| **GREEN** | TDD 循环第二步 — 最小实现让测试通过。 | core-pack |
| **Tautological Test** | 自证测试 — expected value 从被测代码推导。禁止。Expected 必须来自独立真相源。 | core-pack |
| **Restore Point** | 工作流中一个已完成节点的时间点标记，包含该时刻的 VarPool 快照和节点结果。用于恢复点重跑。 | engine, server |
| **Intervention** | 向正在运行的节点注入额外的指导消息，引导 agent 改变行为方向。 | engine, server |
| **Hot Reload** | 工作流执行过程中修改 YAML 定义，后续未执行节点使用新定义。正在执行的节点不受影响。 | engine, server |
| **False Completion** | Agent 节点返回 completed 状态但实际工作未完成。通过诊断发现，通过节点重置修复。 | server |
| **Diagnose Report** | 对执行现场的结构化分析，包含节点状态、异常识别（stuck/exhausted/false_completion/infinite_retry）、修复建议。 | server |
| **Output Injection** | 人工提供节点的输出数据，替代自动执行的结果。用于跳过故障节点继续执行。 | server |
| **分身 (Clone)** | 拥有独立记忆/技能/人格的 Agent 实例。不是角色换皮，是完整的 Agent 身份。4 个内置：workspace / scheduler / archive / resource。 | server, shared |
| **内置分身 (Built-in Clone)** | 系统预定义的 4 个分身，存储于 `~/.octopus/agent/built-in/{name}/`。不可删除。 | server |
| **CloneRuntime** | 所有分身共享的基础设施层 — 上下文组装（persona + memory + skills append）、Provider 调用封装（resume + append）、错误恢复。替代原 OrchestratorService。 | server |
| **双路径架构 (Dual-Path)** | 统一入口（CLI/API → Main Agent tool-calling 委托分身）+ 直接入口（Web UI 页面直连对应分身，零路由延迟）。 | server, web-app |
| **Main Agent** | 统一入口的"主分身"，通过 LLM tool-calling 自行决定委托哪个分身处理。仅在 CLI/API 统一入口时使用。 | server, cli |
| **记忆读共享/写隔离** | 分身能读取全局记忆（long-term + daily，只读），但写入自己独立的记忆空间（built-in/{name}/memory/）。Archive 分身负责定期提炼。 | server |
| **技能叠加** | 分身继承全局 skills + 自己专属 skills（built-in/{name}/skills/），按优先级排序。 | server |
| **人格替换** | 分身用自己的 persona.md，完全替换主 Agent 的 persona。每个分身有独立人格。 | server |
| **provider_session_id** | Claude Code SDK 的 resume 会话 ID。统一后所有分身都使用 resume 省 token。存储在 SessionRow 上。 | server, providers |
| **TokenUsage（用量记录）** | 全站唯一的 token 用量规范形状 `{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}`，四字段**纯值**（input 不含 cache）。`total` 不是字段，需具名函数显式选口径。snake↔camel 只在 3 个 seam（SDK 入口 / DB 行 / wire 出口）转换。定义于 `shared/types/usage.ts`（Zod 派生）。见 ADR-0014。 | shared, providers, engine, server, web-app |
| **UsageLedger（用量台账）** | 跨执行聚合的唯一真相：总 tokens=四字段和（`totalTokens()`）、费用=`LedgerCost{usd,complete}` 三态、命中率=`cacheRead/(input+cacheRead)`∈0–1。公式单源 `shared/ledger.ts`（JS + LEDGER_SQL 金表对验）；node_token_usages 为账本、llm_calls 为明细；写入口唯一 `TokenUsageDAO.recordNodeUsage`。见 ADR-0016。 | shared, server, web-app |
| **Pricing（价表）** | 全站唯一计价模块 `shared/src/pricing.ts`，单位 **USD/MTok**，**无 default 兜底**。`priceFor()` 两阶段匹配（lowercase 精确 → 剥尾部 `[..]` 变体段）。补价通道 = models.yaml：`custom_providers.*.models[].cost` + 顶层 `model_presets` 预设层（id 可裸名或 `provider/model`；为 custom 条目供给缺省字段、为裸名定价终审；跨商异价裸键丢弃不选边）。`estimateCost()` 产出的一切都是**估算**——系统内不存在账单实测。见 ADR-0015。 | shared, providers, server |
| **未定价（Unpriced）** | cost 的诚实第三态：`costUsd = NULL/undefined` = 查无价，≠ 免费（0 在三个 seam 一律归一为未定价），≠ 已计。UI 走 `costComplete`/未定价语义。0 价假象（SDK 未知模型 / pi 注册表 0 档）是它的前身伪装。 | shared, providers, server, web-app |
| **PresentationFormatter（格式化器）** | web 展示层数字→文案的唯一出口 `lib/format.ts` 五函数：`formatCost`（消费 LedgerCost 三态：`—/≈$/$` + 自适应 2/4 位）、`formatTokenCount`（十进制）、`formatDuration`（**毫秒入参**四档）、`formatPercent`（入参 0–1）、`formatBytes`（1024）。豁免须 `// fmt-ok:`（轴刻度/协议文本），门禁测试防复活。见 ADR-0017。 | web-app |
| **@@mention** | 用户在聊天中输入 `@@分身代号` 触发委托调用的语法。前端拦截解析，后端通过 `delegate_to` 字段直接调 CloneRuntime。 | server, web-app |
| **委托 (Delegation)** | 当前聊天 Agent 将消息转发给指定分身处理。前端解析 @@mention → POST `{ delegate_to }` → 后端调 CloneRuntime → 分身回复内联显示。 | server, web-app |
| **分身文件白名单** | 分身文件管理 API 允许读写的路径列表（persona.md / config.json / memory/*），防止目录穿越攻击。 | server |
| **英文代号 (name)** | 分身唯一标识，`/^[a-z0-9-]+$/`，用于文件路径和 API 路由。与 display_name 分离。 | shared |
| **显示名称 (display_name)** | 分身在 UI 和 @@补全中展示的名称，支持中文。存储在 config.json 中。 | server, web-app |
| **SimulatorExecutorFactory** | 模拟执行工厂 — 替代 ExecutorFactory，对副作用节点（agent/swarm/bash/python/approval）返回 MockExecutor，对逻辑节点（condition/loop）返回真实 Executor。VarPool 操作始终真实。 | engine |
| **MockDef** | 模拟定义 — 测试 fixture 中描述节点在模拟模式下行为的配置：status、output、outputs、update_vars、error。 | engine, shared |
| **TestScenario** | 测试场景 — 一个完整的测试用例：inputs + mocks + assertions，验证工作流的一条执行路径。 | engine |
| **TestFixture** | 测试 fixture — `.test.yaml` 文件，包含一个或多个 TestScenario，与 workflow.yaml 配对。 | engine |
| **Syntax Pre-check** | 语法预检查 — 在模拟执行前对所有 bash/python 节点运行 `bash -n` / `python compile()` 检查语法错误，不执行脚本。 | engine |
| **Per-iteration Mock** | 按迭代 mock — loop 内部节点的 mock 数据以数组形式定义，索引对应迭代次数。对象值则所有迭代复用。 | engine |
| **Interaction Node** | 多轮人机交互节点 — 基于 Chatbot UI 的 `interaction` 类型工作流节点，替代 loop+approval+agent 三件套。Agent 驱动动态提问，支持结构化问题和自由文本。 | engine, server |
| **Chat Bridge** | 聊天桥接 — Server 层组件，连接 WorkflowEngine 执行上下文与 ChatService session，管理交互 session 的创建、监控和完成信号检测。 | server |
| **complete_interaction** | 交互完成工具 — 注册给 interaction 节点的 Agent 的特殊工具，Agent 认为信息充足时主动调用以结束节点。携带 summary 和 vars_update。 | engine |
| **Interaction Session** | 交互会话 — 与工作流执行关联的 chat session（有 linked_execution_id + linked_node_id），生命周期由 interaction 节点管理。 | server |
| **Traceability Matrix** | Bidirectional link: requirement ↔ code ↔ test, proving implementation completeness. | core-pack |
| **Assertion Density** | Assertions per line of test code (≥ 0.22 is healthy, < 0.15 is suspicious). | core-pack |
| **Confidence Score** | Weighted composite of verification dimensions, producing GO/NO-GO/REVIEW decision. | core-pack |
| **Mutation Spot Check** | Targeted code mutation on critical paths to verify tests can detect real bugs. | core-pack |
| **Orphan Test** | Test with no traceable requirement (gold-plating detection). | core-pack |
| **Verification Report** | Evidence-based audit of implementation truth, distinct from pipeline-report.md (which is a claim). | core-pack |
| **Pipeline Loop** | Verification-driven iteration orchestrator — reads verification-report, generates gap brief, re-runs pipeline until confidence ≥ 85. | core-pack |
| **Gap Brief** | 聚焦上一次验证失败的 brief — 不包含已工作的部分，只包含需要修复的 gaps。每轮迭代生成一个。 | core-pack |
| **Loop State** | JSON 文件跟踪循环中所有迭代的分数、门禁结果和 gap 历史。存储于 root feature 目录下。 | core-pack |
| **Convergence** | 循环终止条件 — 置信度分数达到 ≥ 85 (GO) 阈值。 | core-pack |
| **Stall Detection** | 连续 2 轮迭代分数提升 < 5 分 → 检测为停滞，循环退出避免无限循环。 | core-pack |
| **Sub-workflow Node** | 引用并执行同工作空间下另一个工作流的节点类型（`type: sub_workflow`）。通过名称引用，变量通过 I/O mapping 传递。 | engine, shared |
| **Execution Mode (inline/linked)** | sub_workflow 节点的执行策略。inline 在父执行上下文内运行（共享执行记录）；linked 创建独立子执行（新 execution_id + parent_execution_id 关联）。 | engine, server |
| **Input Mapping** | 子工作流启动前，将父工作流 VarPool 中的变量映射到子工作流独立 VarPool 的配置。格式：`{ child_var: "$vars.parent_var" }`。 | engine |
| **Output Mapping** | 子工作流完成后，将子工作流 VarPool 中的变量映射回父工作流 VarPool 的配置。格式：`{ parent_var: "child_var_name" }`。 | engine |
| **Sub-workflow Container** | UI 流程图中用于展示子工作流内部节点的容器框（`SubWorkflowContainerNode`），视觉风格类似 LoopContainerNode。 | web-app |
| **Dynamic Sub-Workflow** | 运行时由 Agent 动态生成的 DAG 子工作流（`type: dynamic_sub_workflow`）。Agent 根据上游数据生成 nodes JSON，通过三层验证 Harness 后执行。 | engine, shared |
| **Validation Harness** | 三层验证 + 自动纠错循环 — L1 结构（JSON/字段）→ L2 图（循环/引用）→ L3 语义（type/skills）。最多 3 轮纠错。 | engine |
| **Generated Workflow** | 引擎执行 dynamic_sub_workflow 节点后生成的 YAML 文件 + meta.json，存储在 workspace/workflows/ 目录。 | engine, server |
| **Input Hash** | 上游输入数据的哈希值，用于重跑时检测上下文是否变化（hash 相同复用已有 DAG，不同则重新生成）。 | engine |
| **E2E Harness** | 混合 Skill — 预写好的可复用 lib/ 模块 + patterns/ 指南 + recipes/ 模板，解决 E2E 脚本重复和脆弱性问题。 | skills |
| **STABLE Module** | 经过 self-test 验证的 E2E Harness lib/ 模块，标记为只读。matt-e2e-tester 默认 import STABLE 版本。 | skills |
| **DRAFT Module** | 正在调试中的 lib/ 模块副本（`_draft` 后缀）。self-test 通过后，交付报告中询问用户是否替换 STABLE。 | skills |
| **Self-Test** | 每个 lib/ 模块配套的验证脚本（`.self-test.mjs`），验证模块核心功能正常。 | skills |
| **Pattern Guide** | `patterns/` 目录下的 Markdown 指南，描述特定 E2E 场景（弹窗交互、Tab 切换等）的最佳实践和代码模板。 | skills |
| **Recipe** | `recipes/` 目录下的完整可执行脚本模板，组合多个 lib/ 模块。可直接运行或作为新脚本的起点。 | skills |
| **向导流程编排器** | SKILL.md 的分步引导结构 — AI agent 按 Step 1→N 顺序执行，每步有明确产出和 reference 引用。替代大文档堆砌。 | skills |
| **快速路径 (Quick Path)** | Skill 向导的简短路 — 复杂度 ≤3 简单节点时自动触发，跳过需求深挖直接生成+验证。 | skills |
| **L1 结构验证** | Schema 验证第一层 — YAML 可解析、必填字段存在、类型正确。 | skills |
| **L2 交叉约束** | Schema 验证第二层 — 字段间逻辑约束（互斥、依赖、拓扑完整性）。 | skills |
| **L3 语义检查** | Schema 验证第三层 — 引用完整性（depends_on 目标存在、变量语法合法、表达式可解析）。 | skills |
| **requires** | Workflow 顶层资源依赖声明 — `requires.skills` + `requires.agent_files`，显式声明工作流需要的资源。`_engine_init_` 优先 provision 声明的资源，扫描作为兜底。 | shared, engine |
| **effort** | LLM 推理深度控制参数 — 值域 `low/medium/high/xhigh/max`。NodeDef 顶层和 SubAgentDef 都支持，通过 provider 层传递到 Claude SDK (`Options.effort`) 和 Pi SDK (`setThinkingLevel`)。 | shared, providers |
| **Skill Filter（运行时过滤）** | 节点级 `skills: string[]` 在运行时作为白名单过滤 workspace 已安装的 skills。与 `requires.skills`（依赖声明/provision）不同。Pi SDK 显式 filter，Claude SDK 直接传递。 | providers, engine |
| **agent_files** | `.claude/agents/*.md` 文件的资源级引用名称（不含扩展名）。在 `requires.agent_files` 中声明，`_engine_init_` 负责 provision。 | shared, engine |
| **Activation (激活)** | 将已安装资源从 registry 复制到运行时目标目录的操作。仅适用于 rule / command / clone 三种新类型。 | shared, server |
| **Deactivation (停用)** | 从运行时目标目录移除已激活资源的操作。资源回到 installed 但未激活状态。 | shared, server |
| **Rule (规则资源)** | Claude Code `.claude/rules/*.md` 文件 — 模块化、路径范围的指令文件。资源模块可安装/激活/卸载。 | shared, server |
| **Command (命令资源)** | Claude Code `.claude/commands/*.md` 文件 — 自定义斜杠命令定义。资源模块可安装/激活/卸载。 | shared, server |
| **Clone Resource (分身资源)** | 用户创建的 Agent 分身定义包（persona + config + skills + memory），通过资源模块安装/激活。区别于内置分身。 | shared, server |
| **activated** | ResourceEntry 上的布尔字段 — 标识资源是否已激活到运行时目录。与 status（文件完整性）分离。 | shared |
| **Resource Backup (资源备份)** | 卸载分身时可选保留的备份，存储于 `~/.octopus/resources/backups/{type}/{name}-{timestamp}/`。 | shared |
| **Skill 组 (Skill Group)** | 按资源 registry `group` 聚合的技能套件（如 open-spec / mattpocock-skills）。任务创建时选定（可多选，创建后锁定），物化为 per-task plugin 目录。区别于 tasks.skills（执行技能）。 | server, web-app |
| **Per-task Plugin 目录** | `~/.octopus/tasks/{task-id}/skills/` — 所选 Skill 组的 skills 从 resources/installed symlink 进来，作为第三个 plugin 传给 task-author 会话，获得 SDK 原生渐进式披露。ADR-0010。 | server |
| **任务家目录 (Task Home)** | `~/.octopus/tasks/{task-id}/` — 由 task id 推出的约定目录（不加 DB 字段），含 skills/（plugin 目录）+ artifacts/（产物 + artifacts.json 索引）。draft 删除时整体 reap。ADR-0011。 | server |
| **登记不搬迁 (Register, don't relocate)** | 产物收集策略 — octopus 原生 skill 产物写统一 artifacts/ 目录；第三方 skill 产物留原生位置，登记进 artifacts.json 索引。UI/调度器只读索引。ADR-0011。 | server |
| **辅助工作流 (Assist Workflow)** | 编写期可触发的内置工作流（moa-requirements-review / spec-review-swarm / clarify-debate）。建议权给 agent，执行权留用户；结构化产出（ac 候选/方案建议/风险）勾选采纳进 spec。 | server, core-pack |
| **HOW-handoff** | task-author 对话收尾步骤 — 入队前枚举可复用工作流 → 推荐 + 用户确认 → 复用 or 自建（validate + 模拟器必过）→ 绑定 workflow_ref。ADR-0013。 | core-pack |
| **workflow 解析集 (Resolution Set)** | 任务 workflow_ref 的有效来源集合 = 已安装内置工作流 ∨ task home `workflows/`。全局 `~/.octopus/workflows/` 明确排除。绑定预检 / ready-gate / 查看器三处共用。ADR-0013。 | server |
| **Task Home workflows/** | `~/.octopus/tasks/{task-id}/workflows/` — 自建工作流落位目录；dispatch 时经 `input_values.task_workflows_dir` 注入、拷进执行 ws `workflows/`（S2a 拷贝，非引擎直查）。ADR-0013。 | server |
| **Phase（阶段）** | coding task 的第一级推进单元，大于 ticket——一个 Phase = 一份独立 spec（本次范围 + 票 + 验收方式）+ 一个 workflow_ref 绑定（各 phase 可同可不同）+ 一次以上执行。时间预算 ≈1h/phase（含复杂 E2E ≤1.5h），phase 间以人工验收衔接直至完整需求完成。 | server, shared, web-app, core-pack |
| **Round（轮次）** | Phase 内的一次执行尝试——round 1 = phase spec 的正式执行；验收打回 → 经 task chat 反馈产生新 round（跑通用修复工作流，或先产 round-2 spec 再执行）。每 round 一条独立执行记录，共享同一 workspace/分支。 | server, web-app |
| **验收 Gate (Acceptance)** | phase round 执行完成后的人工卡点——通过 → 放行下一 phase（末 phase 通过触发归档合并）；打回 → 本 phase 新 round。任务的 done 由人按出，不由引擎跑出。 | server, web-app |
| **Batch 目录** | 产物日期批次分组——`.scratch/<YYYYMMDD>/<phase-slug>/`，同一需求拆出的多个 phase 产物共享日期目录前缀，标识同批次。 | core-pack |
| **归并回写 (Sync-back)** | 末 phase 验收通过后的归档动作——任务空间积累的 phase 产物（.scratch）、ADR、CONTEXT.md 变更合并回各 involved project 仓库。合并机制待定。 | core-pack, server |
| **阶段衔接信道 (Phase Handoff Channel)** | accepted→下一 phase 开轮时 `prev_handoff_paths` 自动注入 + matt-spec-dev 探测消费构成的跨 phase 上下文信道；与 spec 文本信道（起草期人工转述）相对。ADR-0019。 | server, core-pack, web-app |
| **handoff.md** | 批次目录 spec 家族成员：ship 每轮末产/覆写的**面向下游执行会话**精选交接短页（头块 + Protected Decisions / Confirmed Interfaces / Gap Targets 三段，一屏内引用不复制）；与 round-report.md（面向验收人全量轮报）受众不同。ADR-0019。 | core-pack |
| **prev_handoff_paths** | 内置注入键（非占位符）：全部已 accepted 前序 phase 的 handoff.md home 绝对路径（存在性过滤、换行连接），accepted→下 phase / 手动推进时 server 注入 materialized input_values；与 feedback/task_artifacts_dir 注入同族。ADR-0019。 | server |

## Anti-Patterns（禁止）

| Pattern | Why Banned |
|---------|-----------|
| **Horizontal Slicing** | 按层拆任务导致层间依赖雪崩。必须垂直切片。 |
| **Monolithic Implement** | 单 agent 节点吃所有 phases 导致上下文饱和。必须 Ticket 级隔离。 |
| **Optional TDD** | TDD 可选 → TODO/空实现可存活。TDD 必须强制。 |
| **Document Handoff** | 上游产出文档 → 下游重新读取解释 → 推理链断裂。Ticket 必须自带完整 spec 片段。 |
| **TODO as Delivery** | TODO/FIXME/placeholder 作为交付物。grep 硬门禁自动检测。 |

## Package Contexts

| Package | Context File | Domain |
|---------|-------------|--------|
| shared  | `packages/shared/CONTEXT.md` | Cross-cutting types, schemas, config |
| providers | `packages/providers/CONTEXT.md` | AI provider abstraction |
| cli | `packages/cli/CONTEXT.md` | CLI commands and user interaction |
| engine | `packages/engine/CONTEXT.md` | Workflow execution engine |
| server | `packages/server/CONTEXT.md` | REST API + SSE + WebSocket |
| web-app | `packages/web-app/CONTEXT.md` | Next.js frontend |
| core-pack | `packages/core-pack/CONTEXT.md` | Bundled skills, agents, workflows |

## Cross-Package Relationships

```
shared ← (无依赖，所有包依赖它)
providers ← shared
cli ← shared + engine + core-pack
engine ← shared + providers
server ← shared + engine + core-pack + providers
web-app ← shared
core-pack ← (纯数据资源)
```

## System-wide ADRs

- [0001-mattpocock-dev-single-workflow.md](docs/adr/0001-mattpocock-dev-single-workflow.md) — 单一工作流 vs 拆分
- [0010-per-task-plugin-dir.md](docs/adr/0010-per-task-plugin-dir.md) — Skill 组经 per-task plugin 目录获 SDK 原生加载
- [0011-task-home-register-dont-relocate.md](docs/adr/0011-task-home-register-dont-relocate.md) — 任务家目录约定 + 登记不搬迁
- [0012-skill-group-lock-at-creation.md](docs/adr/0012-skill-group-lock-at-creation.md) — Skill 组创建时锁定（两阶段编写流）
- [0013-workflow-ref-authoring-provisioning.md](docs/adr/0013-workflow-ref-authoring-provisioning.md) — workflow_ref 归属 authoring agent；自建 flow 落 task home + 分发拷贝（amends ADR-0008）
- [0014-token-usage-canonical-shape.md](docs/adr/0014-token-usage-canonical-shape.md) — 全站规范 TokenUsage 形状，snake↔camel 只在 3 个 seam 转换
- [0015-pricing-single-table-no-default.md](docs/adr/0015-pricing-single-table-no-default.md) — 单一价表（USD/MTok）、无 default 兜底、未定价=NULL、models.yaml 补价通道
- [0016-usage-ledger-single-truth.md](docs/adr/0016-usage-ledger-single-truth.md) — 总量唯一账本（ntu）、三态费用、公式单源（写 9→1 / 读 41→1 / web 14→0）
- [0017-presentation-formatter-single-source.md](docs/adr/0017-presentation-formatter-single-source.md) — 展示层格式化器单源（五函数收 113 处 toFixed、拆秒/毫秒同名雷、fmt-ok 豁免）
- [0018-ws-authoritative-spec-and-reject-routing.md](docs/adr/0018-ws-authoritative-spec-and-reject-routing.md) — ws 权威 spec 环 + spec 家族文件名约定 + 打回二分路由（K16 不破）
- [0019-phase-handoff-channel.md](docs/adr/0019-phase-handoff-channel.md) — phase 衔接信道：ship 产 handoff.md + accepted 时自动注入 prev_handoff_paths
