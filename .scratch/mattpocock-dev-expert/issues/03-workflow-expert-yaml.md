# 03 — Workflow: mattpocock-dev-expert.yaml 完整实现

**What to build:** 创建完整的 `mattpocock-dev-expert.yaml` workflow 文件，包含 expert grill 阶段（classify → loop[swarm debate] → approval → synthesize）+ 下游管线（spec → tickets → tdd-loop → architecture-review → ship → done）。grill 阶段的 5 个节点按 spec 设计实现。下游管线从现有 mattpocock-dev.yaml 适配（相同结构和 skills，独立声明）。workflow 能通过 `octopus workflow validate` 验证。

**Blocked by:** 01 — Engine swarm-in-loop（grill-batch 需要 loop 内 swarm 支持）, 02 — product-manager agent（swarm 核心专家）

**Status:** done

- [x] 创建 `packages/core-pack/workflows/mattpocock-dev-expert.yaml`
- [x] grill-classify 节点: agent 类型，生成问题 + 依赖分析 + 分批 + context 模式检测
- [x] grill-loop 节点: loop 类型，max_iterations: 10, break_when 所有 batch 完成
- [x] grill-batch 节点: swarm 类型（在 loop 内），mode: debate, rounds: 3, 3 核心 + 可选专家
- [x] grill-approval 节点: approval 类型，execute_when 条件控制（仅 interactive 模式）
- [x] grill-synthesize 节点: agent 类型，综合 decisions → brief.md + domain-modeling → CONTEXT.md
- [x] 下游管线: spec, tickets, tdd-loop(含工程师路由), architecture-review, ship, done — 从 mattpocock-dev 适配
- [x] 所有 skills 引用正确（grilling, domain-modeling, to-spec, codebase-design, to-tickets, implement, tdd, code-review, diagnosing-bugs, improve-codebase-architecture）
- [x] 所有 agent_file 引用带 .md 扩展名
- [x] vars_update 格式正确（scratch_dir, brief_file, context_file, accumulated_decisions 等）
- [x] 跨 batch 上下文传递: 每个 grill-batch prompt 注入 $vars.accumulated_decisions
- [x] octopus workflow validate 通过
- [x] auto_answers 默认配置（无人值守模式）
