# ADR-0029: 纯引擎 + 执行身份 — 引擎无人格，身份是节点数据

Date: 2026-10-12
Status: Accepted
Related: ADR-0005 (swarm/agent 执行器抽象), ADR-0006 (技能经 SDK 原生发现，禁 prompt 装载), LLM-WIKI spec §执行身份 / 架构决策 D1, 票 08–10; 后续票 11 (octo-wiki 预置) / 12 (影子双轨)

## Context

LLM-WIKI P1 要把知识的消费方式从「引擎注入」翻转为「Agent 主动查阅」。查阅能力（octo-wiki skill）与查阅纪律（动手前先查、引用写 wiki_refs、安全规则 > 任务书 > 知识参考）需要一个承载体；同时存量工作流必须**零改动**获得这一变化。

此前三个关注点是绞在一起的：

- **工作现场（cwd）**：workspace 隔离语义，执行器从 `ctx.cwd` 取，从未变过。
- **执行者是谁**：普通 agent 节点只有一个 `agent: 全栈工程师` 式的角色名后缀（无真身份）；octopus_agent 有分身快照，但语义是重量级委托（Task Contract + 结构化返回）。
- **知道什么**：引擎替 Agent 把知识注入 prompt（PromptInjector / KnowledgeInjector / precompute），引擎因此"携带"知识——正是要退役的方向。

蓝图（原型 Tab②/④）已拍板：翻转到 Agent Query 的前提，是引擎彻底放下"知识"这一面，同时给节点一个身份。这决定了一个难逆转的架构边界，故记录于此。

## Decision

1. **引擎无人格（纯编排）**。WorkflowEngine / 执行器不包含任何 persona、知识内容；引擎只做**身份解析与装配**这一件与身份有关的事。"分身特性属于节点数据，不属于引擎属性。"

2. **身份是节点数据：`as: <分身英文代号>`**。shared `NodeDef`/`NodeSchema` 增可选 `as`，L1 正则 `/^[a-z0-9-]+$/`（代号即名字，版本钉住不进此字段——那是 octopus_agent `agent:`/`version` 的语义）。装配语义固定为两条映射 + 一条不变式：
   - `snapshot.persona → systemPrompt`：合并进 `claude_code` preset 的 append（host-safety 段在前，persona 段在后），**绝不整体替换** preset、绝不丢安全段；
   - `snapshot.skills → SDK skills 白名单`：与节点自声明 skills **取并集**；快照 skills 为空则不施加白名单（ADR-0006：运行时技能发现走共享层 `.claude/skills/` + settingSources，白名单只是过滤器，**永远不是内容注入通道**）；
   - **cwd 永不是身份输入**：装配函数签名里没有 cwd，workspace 隔离语义零改动。

3. **三分离（D1）**：`cwd = 工作现场 ⊥ identity = 我是谁（clone 快照 persona+skills+config） ⊥ wiki = 我知道什么（org 词条，经 skill 查阅）`。三者正交；允许恒定跨维的只有一行**指针**（wiki 根路径 + 查阅纪律，~50 token，不含知识内容）——指针 ≠ 注入。

4. **缺省身份 workflow-operator，失败语义分档**。未写 `as:` 的 agent 节点装配第 8 个内置分身 `workflow-operator`（名字常量 `WORKFLOW_OPERATOR_CLONE_NAME` 住 shared，引擎不得 import server 的 `BUILTIN_CLONES`）：存量工作流零改动获得查阅纪律。两档失败：
   - **显式 `as:` 目标不可解析 ⇒ 硬闸拒绝**：server 在 engine-init（Step 0.5，模型照 `requires.clones` 存在性闸）、CLI 在执行前跑同一个 `checkAsRefs`——不带病执行；
   - **缺省目标不可解析 ⇒ 优雅降级为无身份装配**（票前行为）：老流程绝不因某台机器缺 built-in 目录而崩。

5. **单一解析链（CLI == Server）**：普通节点的轻量装配与 octopus_agent 的重量级委托共用同一个 `IdentityResolver`（agent_versions 已发布快照优先 → `~/.octopus/agent/built-in/{name}` → `~/.octopus/agent/clones/{name}` → 含候选路径的可读错误）。`versionResolver` 为**可选依赖**：server 注入 DB 行表（快照优先），CLI fs-only 兜底——双入口都解析自同一条链，身份语义全站一致。loop / sub_workflow / dynamic_sub_workflow 子引擎经 config 透传同一 resolver 继承装配语义（swarm 的专家不是 NodeDef agent 节点，不在 `as:` 语义域内）。

## Consequences

- **shared**：`NodeDef.as?: string` + `NodeSchema` L1 正则校验（`node-as-field.test.ts`）。
- **engine**：`identity-resolver.ts` 的 `IdentityResolverDeps.versionResolver` 改可选（票 08 交接缺口关闭）；新 `identity-assembly.ts`（纯函数装配缝）；`ExecutorFactoryContext.identityResolver` 注入位 + 工厂自建缺省；`WorkflowEngine.setIdentityResolver` / `getVersionResolver`；`LoopConfig` / `SubWorkflowConfig` / `DynamicSubWorkflowConfig` 增 `identityResolver` 透传；`engine-init` 增 Step 0.5 as-gate 与 `EngineInitResult.identityErrors`。
- **server**：`ExecutionLifecycle` 给 engine-init 传链入已发布快照的 gate resolver；SSE `error` 事件载荷附 `identityErrors`。
- **cli**：`workflow run` 在 preflight 后、引擎构造前执行同一 `checkAsRefs` 闸，不可解析 ⇒ 退出码 1。
- **octopus_agent 语义不变**：Task Contract + 结构化返回 + `version`/`min_stage` 钉版本照旧（重量级委托回归测试原样绿）。
- **注入链本票零改动**：PromptInjector / KnowledgeInjector / precompute / agent.ts 注入块 diff 为空；缺省身份装配落地后注入链在影子期（票 12）共存，P2 才退役——单向门前置是分流数据采齐。
- **风险与张力**：缺省装配给所有 agent 节点新增 persona 段 = 存量行为的温和变化（persona 是行为准则而非知识，且不动 skills 发现层）；若某身份目录 `skills/` 非空，白名单将真正限制 SDK skills——票 11 给 workspace 预置 octo-wiki 时须与 ADR-0006 共享发现对齐（workflow-operator 当前目录不 seed skills，白名单不施加）。

## Alternatives considered

- **(A) 引擎级缺省 persona**（engine 配一个全局身份）：违背"身份是节点数据"，多节点异身份无从表达，引擎重新开始有人格。否决。
- **(B) persona/skills 以 prompt 文本注入装配**：走的恰是 P2 要拆除的注入通道，且把"身份"降级成"文案"。否决——systemPrompt 与 SDK `skills` 过滤器才是身份的本位落点（ADR-0006 红线：技能装载禁走 prompt 文本）。
- **(C) 缺省 = 无身份（写 `as:` 才装配）**：与故事 22"存量零改动获得执行身份"直接冲突；且缺省不可解析已有优雅降级，(C) 换来的保守是多余的。否决。
- **(D) `as:` 允许 `name@version` 钉版本**：一个 schema 出现两套版本解析入口（与 octopus_agent `version` 字段重叠）；L1 正则锁代号，钉版语义单点归属。否决。
