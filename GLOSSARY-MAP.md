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
| **分身 (Clone)** | 拥有独立记忆/技能/人格的 Agent 实例。不是角色换皮，是完整的 Agent 身份。内置分身见下条。 | server, shared |
| **task-doer（任务执行者）** | 承接任务执行/验收期对话的内置分身（谈=task-author，做=task-doer）：快速修改、人工接管、修复轮追加指令皆出其口；工作区代码写权来自 workspace 语义而非 task-home，唯批次计划文件（spec/票）仅经计划回写通道可写、大改先预览后执行（ADR-0025，ADR-0026）。 | server, core-pack, web-app |
| **workflow-operator（工作流工程师）** | 工作流 agent 节点的缺省执行身份内置分身（LLM-WIKI P1，spec §执行身份）：persona 写死四条行为准则——动手前经 octo-wiki 查阅并写 wiki_refs、遵守 cwd 的 CLAUDE.md、安全规则 > 任务书 > 知识参考、知识与现场代码冲突以现场为准并上报 stale。config 声明 `skills: [octo-wiki]` 仅为治理语义 + preflight 依据（ADR-0006：运行时技能发现走共享层，不走 CloneDef.skills）；`config.versioned` 触发启动时初始 agent_versions 发布，工作流可经快照机制解析/钉住身份版本。 | server, shared, engine |
| **内置分身 (Built-in Clone)** | 系统预定义的 8 个分身（workspace / scheduler / archive / resource / harness-agent / task-author / task-doer / workflow-operator），存储于 `~/.octopus`/agent/built-in/`{name}`/。不可删除。数量随 server `builtin-clones.ts` 注册表演进（task-doer 由 ADR-0025 引入；workflow-operator 由 LLM-WIKI P1 票 09 引入，名字常量 `WORKFLOW_OPERATOR_CLONE_NAME` 在 shared，供引擎侧缺省装配引用）。 | server |
| **执行身份 (Execution Identity)** | 工作流 agent 节点 `as: <分身英文代号>` 字段的数据语义：经 IdentityResolver 单一解析链（已发布 agent_versions 快照 → built-in → clones 目录）取分身快照，装配为 persona→systemPrompt、snapshot.skills→SDK skills 白名单；cwd 永不是身份输入（cwd=工作现场 ⊥ identity ⊥ wiki 三分离，ADR-0029）。缺省身份 workflow-operator（不写 `as:` 亦装配）；显式目标不可解析在 engine-init（server）/执行前（CLI）硬闸拒绝，缺省目标缺失则优雅降级。引擎自身无人格——身份是节点数据，不是引擎属性。_Avoid_: 称引擎"有人格"；把身份装配叫"知识注入"。 | engine, shared, server |
| **导航协议 (Navigation Protocol)** | octo-wiki skill 定义的 wiki 查阅路线（票03 起全局唯一根）：`~/.octopus/knowledge/wiki/INDEX.md` 第一跳 → 目标页整读第二跳（五类页：项目/服务/工具→entities，SOP/工作流→topics，术语/概念→concepts，溯源→sources，卡壳按症状→cases）→ `GET /api/knowledge/wiki/search` 兜底；按跳计费，禁全库遍历/跳过 INDEX glob。指针 ≠ 注入（任务上下文只给一行 wiki 根指针+查阅纪律，正文由 agent 自读；注入链已随知识中心票08 物理删除）。 | core-pack, server |
| **影子期 (Shadow Mode)** | **已废弃、进入历史**（注入链随知识中心票08 物理删除，ADR-0030；shadow-compare 端点冻结只读为 p2-gate-pass 证据链审计面，读面清理划入后续处理）：LLM-WIKI P1 的双轨运行态（spec §执行身份/影子双轨，故事 30-31）：分身配置 `knowledge.mode: inject | query | both`（缺省 **both** = 注入链原样运行 + `wiki_refs` 查阅记录开启，默认路径与现状逐字节一致）。注入仍跑的同时记录"Agent 实际查阅了什么"（wiki_refs 经既有 vars_update→VarPool 通道落 JSONL/executions.var_pool，`stale:` 前缀条目单独可筛）；对照导出 `GET /api/workspaces/:id/executions/:executionId/shadow-compare` 按执行并排注入侧（`__relevant_rule_ids`/`__injected_rule_ids`，只读）与查阅侧，输出 命中/未命中(miss=判相关却没进 prompt)/仅注入/仅查阅 四象限。它是 P2「删除注入链」单向门的决策数据来源，**也是回滚开关**：mode 回 inject 即恢复现状（只加开关不删代码，红线：P2 不在 P1 射程内）。_Avoid_: 把影子期当作"已删注入"（注入照跑）；把四象限导出说成效果评价（它是 P2 决策输入，不替 P2 下结论）。 | engine, shared, server |
| **CloneRuntime** | 所有分身共享的基础设施层 — 上下文组装（persona + memory + skills append）、Provider 调用封装（resume + append）、错误恢复。替代原 OrchestratorService。 | server |
| **双路径架构 (Dual-Path)** | 统一入口（CLI/API → Main Agent tool-calling 委托分身）+ 直接入口（Web UI 页面直连对应分身，零路由延迟）。 | server, web-app |
| **Main Agent** | 统一入口的"主分身"，通过 LLM tool-calling 自行决定委托哪个分身处理。仅在 CLI/API 统一入口时使用。 | server, cli |
| **记忆读共享/写隔离** | 分身能读取全局记忆（long-term + daily，只读），但写入自己独立的记忆空间（built-in/{name}/memory/）。Archive 分身负责定期提炼。 | server |
| **技能叠加** | 分身继承全局 skills + 自己专属 skills（built-in/{name}/skills/），按优先级排序。 | server |
| **人格替换** | 分身用自己的 persona.md，完全替换主 Agent 的 persona。每个分身有独立人格。 | server |
| **provider_session_id** | Claude Code SDK 的 resume 会话 ID。统一后所有分身都使用 resume 省 token。存储在 SessionRow 上。 | server, providers |
| **TokenUsage（用量记录）** | 全站唯一的 token 用量规范形状 `{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}`，四字段**纯值**（input 不含 cache）。`total` 不是字段，需具名函数显式选口径。snake↔camel 只在 3 个 seam（SDK 入口 / DB 行 / wire 出口）转换。定义于 `shared/types/usage.ts`（Zod 派生）。见 ADR-0014。 | shared, providers, engine, server, web-app |
| **UsageLedger（用量台账）** | 跨执行聚合的唯一真相：总 tokens=四字段和（`totalTokens()`）、费用=`LedgerCost{usd,complete}` 三态、命中率=`cacheRead/(input+cacheRead+cacheCreation)`∈0–1（分母含缓存写，ADR-0027）。公式单源 `shared/ledger.ts`（JS + LEDGER_SQL 金表对验）；node_token_usages 为账本、llm_calls 为明细；写入口唯一 `TokenUsageDAO.recordNodeUsage`。见 ADR-0016 + ADR-0027。 | shared, server, web-app |
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
| **Phase（阶段）** | coding task 的第一级推进单元与**叙事单元**——**一个 phase = 一个完整用户故事**，叠加在 MVP 之上：phase1 = MVP 薄切片（切穿需求最高风险段），其后每 phase = 一个讲得完的故事 + 一份独立 spec（故事+票+验收方式）+ 一个 workflow_ref 绑定 + ≥1 次执行。下界 = 功能票 ≥3（E2E 票不计；摊得起一次人工 gate；MVP 豁免）；上界 = 成果内聚、一次坐得下验收，**phase 层不设时间硬顶**——≤1h 是 Ticket 层容量纪律，借给 phase 是「phase≈issue」的历史根因。phase 间以人工验收衔接直至完整需求完成。ADR-0020。 | server, shared, web-app, core-pack |
| **叙事分层（Phase ≠ User Story ≠ Ticket）** | 三层各司一职：Phase = 交付/叙事单元（一个完整用户故事，一 phase 一道 gate）；User Story = phase spec 内的穷尽清单条目（一条故事可拆多票）；Ticket = 实现单元（垂直切片，≤1h、装进一个 context window）。时间预算只在票层有效；词层混用即粒度失控的根源。 | core-pack, shared |
| **Round（轮次）** | Phase 内的一次执行尝试——round 1 = phase spec 的正式执行（绑定工作流）；验收打回 → 新 round 一律为**修复轮**（task-fix），不重跑绑定流；绑定流的再执行只发生在草稿态改 spec 后重新入队。每 round 一条独立执行记录，共享同一 workspace/分支。 | server, web-app |
| **修复轮 (Fix Round)** | 打回产生的新 round：按打回反馈开发/修复/回归/补产物后即回到待验收。承担原「修订重跑」的全部出口职责；并担计划回写职责——反馈指向规格即改 spec 并经回写通道留痕，大范围收束 = 开票留档 + 建议转 doer 对话（ADR-0026）。 | server, core-pack |
| **快速修改 (Quick-Edit)** | 待验收态下由对话直接修改执行工作空间代码的行为——不开 Round、不算引擎产物、不入打回路径；与轮次产物在验收台账中分列。 | server, web-app |
| **人工接管 (Manual Takeover)** | 执行中终止绑定执行、由人经对话驱动 agent 逐步完成当前 Round 的终局动作；产出仍需过验收 Gate。UI 简称"接管"。_Avoid_: 与 harness 的自动接管（agent_takeover）混用。 | server, web-app, engine |
| **验收台账 (Acceptance Ledger)** | 每轮验收的决策与证据链账本：实物变更、自动复检、跑起来看、人工走查、人工干预、快速修改，分列来源。_Avoid_: 与用量台账（UsageLedger）混称"台账"。 | server, web-app |
| **验收 Gate (Acceptance)** | phase round 执行完成后的人工卡点——通过 → 放行下一 phase（末 phase 通过触发归档合并）；打回 → 本 phase 新 round（修复轮）。任务的 done 由人按出，不由引擎跑出。 | server, web-app |
| **Batch 目录** | 产物日期批次分组——`.scratch/<YYYYMMDD>/<phase-slug>/`，同一需求拆出的多个 phase 产物共享日期目录前缀，标识同批次。 | core-pack |
| **home-file 读白名单** | task home 文件读端点（`GET /api/tasks/:id/home-file`）只放行 `.scratch/**` 相对路径（resolveWithinRoot 防穿越）；home 下 `workflows/`（自建流正文）等域不在读端点内——要取流正文走 built-in/workflow 解析通路，别指望 home-file。 | server |
| **归并回写 (Sync-back)** | 末 phase 验收通过后的归档动作——任务空间积累的 phase 产物（.scratch）、ADR、GLOSSARY.md 变更合并回各 involved project 仓库。合并机制待定。 | core-pack, server |
| **计划回写 (Plan Writeback)** | 任务执行/验收期由 task-doer 与修复轮回写 Batch 目录批次 spec 与票的行为——经 plan-before-code 确认闸与唯一任务级 REST 通道，含后续 phase 批次；变更记录由 server 机械落痕（谁·哪轮·为何·何文件），信封 phases[] 结构层不在写权内、结构变更落范围变更票。_Avoid_: 与「归并回写 (Sync-back)」混称"回写"——那是末 phase 把产物并回 project 仓库的归档动作，此为执行期把计划改回计划自身的活计划动作。ADR-0026。 | server, core-pack, web-app |
| **范围变更票 (Scope-Change Ticket)** | 计划回写产生的溢出票：变更牵连任务结构（加/减 phase、换绑定流）时执行侧代理只开票留档不执行——`Status: ready-for-human`、带 Origin 行，载体为当前批次 issues/，处理归 authoring 侧（task-author 改信封重入队）。ADR-0026。 | core-pack, server |
| **阶段衔接信道 (Phase Handoff Channel)** | accepted→下一 phase 开轮时 `prev_handoff_paths` 自动注入 + matt-spec-dev 探测消费构成的跨 phase 上下文信道；与 spec 文本信道（起草期人工转述）相对。ADR-0019。 | server, core-pack, web-app |
| **handoff.md** | 批次目录 spec 家族成员：ship 每轮末产/覆写的**面向下游执行会话**精选交接短页（头块 + Protected Decisions / Confirmed Interfaces / Gap Targets 三段，一屏内引用不复制）；与 round-report.md（面向验收人全量轮报）受众不同。ADR-0019。 | core-pack |
| **prev_handoff_paths** | 内置注入键（非占位符）：全部已 accepted 前序 phase 的 handoff.md home 绝对路径（存在性过滤、换行连接），accepted→下 phase / 手动推进时 server 注入 materialized input_values；与 feedback/task_artifacts_dir 注入同族。ADR-0019。 | server |
| **页 (Page)（原「词条 (Entry)」）** | wiki 编译单元——一 md 文件一主题，住五类目录之一（front-matter `type`: entity/concept/topic/source/case）：元数据继承 v2 的 id/title/summary/topics/stability/last_compiled/sources/confidence（stability=volatile 必带 review_after），v3 新增 `links`（[[wikilink]]，编译期断链校验）与 entity 的 `aliases/entity_kind`；正文零日期；规则锚点 `<!--#oct-NNN-->` **只存在于 topics 页硬约束小节**（全库唯一、永不复用、重蒸馏原号随迁）。「词条」是 v2 旧称（domain 四域+cases 编译单元）：旧词条兼容可读，重蒸馏（票07）后旧页整体迁 `_retired/v2/`——新文案勿再写"词条"。常青零日期——日期/溯源/审核由 front-matter sources、LOG.md、git history 三处分工承接。schema 定义 `shared/types/wiki.ts`。 | shared, server |
| **五类页 (Five Page Types)** | 层2 页网络按 `type` 分的五类目录（prototype Tab② 目录契约）：**实体页** entities/（entity_kind + aliases，项目/服务/工具/人/组织）；**概念页** concepts/（术语/概念辨析）；**主题页** topics/（SOP 与硬约束小节——全库唯一锚点位）；**来源页** sources/（编译回执页：要点清单 + 触及页清单 + `raw:` 路径与 `sha256:` 回指不可变源，溯源对质凭据）；**判例页** cases/（见「判例 (Case)」，已有独立词条）。INDEX.md 按五类分组程序化重建。 | shared, server |
| **判例 (Case)** | cases/ 域的历史问题记录（CBR 案例库，票04）——一事故一文件 `{YYYY-MM-DD}-{slug}.md`：front-matter(id/symptom/tags/severity/occurrences/rule_ref/source/status: open|distilled|superseded) + 正文五段（现场/诊断/根因/修复/教训）。准入是词条的例外（D5）：只校验"真实 + source 可定位（task-/exec-/commit 指针）"，豁免半衰期三问；lint 豁免 L1 容量闸与正文禁日期（历史事件天然时间绑定）。入库即历史：正文 append-only 不改写，仅 status/rule_ref/occurrences 三字段可经编译通道更新，改写尝试被拒并留 LOG `case-rej` 证据行；LOG 动作为 `case+`（新判例）/`revise`（字段更新）。卡壳按 symptom/tags 加权检索（症状＞标签＞正文顺带提及），沿 rule_ref 顺藤读规则。schema 定义 `shared/types/wiki.ts`（WikiCaseFrontmatterSchema）。_Avoid_: 给判例做 stability/半衰期管理；改写已入库的判例正文。 | shared, server, web-app |
| **INDEX/LOG 导航层** | INDEX.md = llms.txt 风格导航层，由编译器从五类页 front-matter **程序化重建**（H1 + 导航协议 blockquote + 必读节（user_preference.md 固定行）+ 五类分组节 + Optional 降级节，≤800 token 第一跳成本恒定）；LOG.md = 编译时间线，append-only 行格式 `## [date] ingest|compile|query|lint|revert | title → 结果`（行首前缀可 grep，票07 机械换行、旧表格行封 git 史）。两者永不经 LLM/人手写，零漂移；写入与页同在编译事务内（失败原子回滚）。 | server |
| **策展人 (Curator)** | wiki 唯一写者 = archive 分身演进（persona 自称知识策展人）。审批废除后职责（知识中心票09/ADR-0030）：**输入即审批**——raw 投喂（知识中心对话/API/任务归档自动总结）即触发编译，无审批队列；一切写操作经全局 FIFO 队列+wiki 根锁（见「编译队列」，ADR-0031）→ 唯一写闸编译服务（一次编译触 N 页 + sources 回执页 + INDEX/LOG/FTS/git 单 commit，失败原子回滚）；发现矛盾两页标记 + 报 finding 进对话（**不静默覆盖、不自行裁决**，裁决权在人）；结构 lint 拒绝对话内自纠重编译；人工文件（user_preference.md/SCHEMA.md）只出写保护卡（建议文本+人工确认步骤，零自动落盘；服务层主闸路径级拒写 MANUAL_FILE_WRITE，pre-commit 纵深）。写侧技能 octo-wiki-curate 仅落分身层 clone-tier（ADR-0005/0006，共享层=写权泄漏）；技术强制 = 提交来源标记 `OCTOPUS_WIKI_COMMIT_SOURCE`（curate=服务通道 / manual=人工）。_Avoid_: 复活 approve→curate 审批链；给策展人自动改人工文件的权限。 | server, core-pack |
| **raw 层 (Raw Layer)** | 三层架构层1 不可变源：`~/.octopus/knowledge/raw/{inbox,archives,research}`——对话投喂文章/粘贴/本地文件、任务归档完整总结、调研原文、回填对话摘录；落盘即 hash 冻结（front-matter hash ↔ 文件头 ↔ 实算 payload 三方对质），策展人与一切自动流程**只读**，编译可重跑、矛盾可对质（sources 页回指此处）。raw 落盘不入写队，其触发的编译才入队（ADR-0031）。_Avoid_: 改写/删除既有 raw 文件；跳过 raw 直写页。 | server |
| **SCHEMA.md** | 层3 人机共演约定文档，住知识根 `~/.octopus/knowledge/SCHEMA.md`（首版吸收 octo-wiki-curate 编译纪律，skill 本体瘦身为指针+编译 API 用法）；策展人每次编译前与 INDEX.md 同必读。**人工文件**：只经 `ensureSchemaDoc` 缺席时幂等 seed，任何存在体永不改写；自动通道对其写路径被服务层主闸拒绝（`wiki/manual-files.ts`，MANUAL_FILE_WRITE），pre-commit 为纵深防御（ADR-0030 质控⑥；行为测试 wiki-write-gate.test.ts 三层钉死）。 | server |
| **编译队列 (Compile Queue)** | 唯一写闸的外层互斥（ADR-0031）：进程内全局 FIFO（compile-queue.ts）+ wiki 根锁文件（`.compile.lock`，PID+心跳判 stale、崩溃自动回收，跨进程保底）两级；七类写操作共队、kind 单源 `WRITE_OP_KINDS`（ingest-compile/archive-compile/dialog-revise/lint-fix/finding-fix/revert/redistill）。语义：同刻至多一编译在跑；**读永不锁**；单任务失败自回滚不堵队；位次 #N/深度进 UI 卡与健康条。_Avoid_: 写通道绕过队列直写 wiki。 | server, web-app |
| **finding** | 巡检/编译产出的待裁决发现（五查 kind：contradiction/stale/orphan/missing-page/missing-xref；findings 表；source 列分 compile/patrol/消费侧 stale 上报）。finding 卡三钮 [采纳修订/忽略/讨论]＝**裁决即编译**：采纳=服务端生成修订稿（LLM seam/确定性图编辑）经 finding-fix 入全局队列过唯一写闸，锚点守门、成功即 resolved + Lane A diff 卡跟随；忽略=记录在案巡检不再重报；讨论=零服务端动作（纯对话）。质控⑤出口——发现面是「系统报人」不是「人盯队列」。 | server, web-app |
| **回填 (Backfill)** | 探索复利通道（spec 故事 14）：策展人对话中有价值的合成答案 → 回填卡 [编进 wiki] → 对话摘录落 `raw/inbox/`（origin=`chat:<session>`，票02 冻结契约原样）→ 异步入队编译、diff 卡跟随。**窄口纪律**：执行中 agent 的产出**不自动回填**——BackfillService 是回填唯一入口，只由知识中心对话/显式 API 触发。 | server, web-app |
| **知识中心 (Knowledge Center)** | `/knowledge` 页——对话驱动的界面知识管理主界面：策展人（archive 分身）对话流（复用既有 agent chat 通道，scope=knowledge，不自建聊天基建）+ 右栏 wiki 视图（跟随对话渲染/可钉住/浏览模式全宽）+ 顶部健康条（页数按类/raw 源数/本周 ingest/开放 findings/队列深度/最近编译/git HEAD——**没有"待审核"计数**，概念已废除，spec 故事 10）+ Ctrl+K 检索。八类卡片沉淀每次操作（抓取/来源摘要/编译 diff/归档编译/finding/回填/词条迷你/写保护）。旧路由 /wiki 与 /experience 已整页删除。 | web-app, server |
| **审核队列 (Review Queue)** | **已废弃**（知识中心票09 物理删除，ADR-0030）：事前审批的 wiki 通道——rule/wiki-edit/wiki-split 策展分发、approve→curate 链、拆分提案入队语义、auto_approve 概念、审核 UI 组件整体废除（输入即审批，质控改事后六道）。pending_review **表本体保留**：skill 草案等非 wiki 用途仍在其中结案流转（schema.sql 有边界注；物理清理属 P3）。_Avoid_: 复活任何 approve→自动写库 形态；UI 上报"待审核"计数。 | server |
| **工作经验页 (/experience)** | **已废弃**（owner 裁决「删除干净一点」，知识中心票09）：/experience 整页删除，含经验库、知识管理 tab、审核组件、助手面板、偏好编辑器（user_preference 只留浏览模式只读渲染，改文件=人工直接编辑）；experiences 数据导出归档 `_archive/` 后 drop 表（含 FTS）；经验三级提炼/experience-merger 随归档自动投喂替代而删除。旧链接 404 或重定向 /knowledge。_Avoid_: 重建经验库或偏好编辑 UI；把 agent 记忆系统（另一域）牵进删除面。 | web-app, server |

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
| shared  | `packages/shared/GLOSSARY.md` | Cross-cutting types, schemas, config |
| providers | `packages/providers/GLOSSARY.md` | AI provider abstraction |
| cli | `packages/cli/GLOSSARY.md` | CLI commands and user interaction |
| engine | `packages/engine/GLOSSARY.md` | Workflow execution engine |
| server | `packages/server/GLOSSARY.md` | REST API + SSE + WebSocket |
| web-app | `packages/web-app/GLOSSARY.md` | Next.js frontend |
| core-pack | `packages/core-pack/GLOSSARY.md` | Bundled skills, agents, workflows |

> 注（知识中心 code-review S4 登记）：上表所列**各包 GLOSSARY.md 尚未建立**（预存治理欠账，
> 非本 phase 引入）；补齐前包级词条一律以本 map 为准，勿在包内另立词表。

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
- [0020-phase-story-granularity.md](docs/adr/0020-phase-story-granularity.md) — 拆 Phase 故事判据：phase = 完整用户故事叠加 MVP，票 ≥3 下限，时间锚降回票层
- [0030-karpathy-3layer-compiled-wiki-abolish-approval.md](docs/adr/0030-karpathy-3layer-compiled-wiki-abolish-approval.md) — Karpathy 三层编译型知识库 + 审批废除（amends ADR-0029 org 级 wiki 定位；收编写入单一闸门前案）
- [0031-wiki-global-write-serialization.md](docs/adr/0031-wiki-global-write-serialization.md) — wiki 全局写串行：进程内 FIFO 编译队列 + wiki 根锁两级互斥，读永不锁

（注：本索引非穷举——0021～0029 未列，补齐留治理整理票；新增 ADR 请顺手在此挂行。）
