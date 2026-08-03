# Requirement Brief

## Overview
为 Octopus 工作流引擎引入 `system_agent` 节点类型，使工作流能引用 Main Agent 或 Clone（分身），并赋予系统级 Agent **有度量、有验证、能学习的**5 维度自主进化能力。

**Phase 1（基础设施层）**：system_agent 节点 + 进化管道 + 对抗审查 + overlay + 熔断 + UI
**Phase 2（进化智能层）**：执行反馈通道 + eval harness（沙箱 + LLM Judge） + 纵向指标 + 跨维度一致性 + 策略学习
**Phase 3（版本控制层）**：5 状态版本生命周期（draft → canary → stable → archived / rejected） + @ 标签版本钉选 + canary 灰度流量 + 自动升版

基于 chapter 8 的 hermes-self-evolution + prompt-auto-optimization + self-evolution-eval + trajectory-verifier 模式。

## Projects Involved
- [x] @octopus/shared (Schema + Types — system_agent 节点类型、进化类型、eval cases、反馈、指标)
- [x] @octopus/engine (Executor — SystemAgentExecutor，通过 Context 注入获取 system prompt)
- [x] @octopus/server (进化 API + EvolutionService 扩展 + eval harness + 反馈聚合 + 指标计算)
- [x] @octopus/web-app (进化面板 + 反馈 UI + 指标仪表板 + 工作流编辑器 + SSE)
- [x] @octopus/providers (进化审查、eval harness、LLM Judge 的 provider 调用)

## Feature Scope

### Phase 1 — 基础设施层

**Do:**
- 新增 `system_agent` 节点类型（flat NodeDef 扩展，`role: main | clone`）
- 5 维度进化：persona、skills、prompt（overlay 模式）、system_prompt（外化配置表）、memory
- 合并到现有 `EvolutionService`，复用 changelog/experience 表 + 文件锁
- 对抗审查：专用 `evolution-reviewer` 内置分身验证补丁
- 4 种触发方式：失败阈值（滑动窗口）、工作流编排、定时、手动
- 熔断机制：3次/小时上限、连续2次失败禁用、进化上下文防递归
- DB 锁 + 乐观并发控制防并发进化
- SSE 进化生命周期事件推送
- Web UI 进化面板（历史、diff、审查、触发、回滚）
- 工作流编辑器支持 system_agent 节点
- auto + manual eval case 管理

### Phase 2 — 进化智能层

**Do:**
- 执行反馈通道：用户 👍/👎 + 系统自动标记，合并为 feedback_score
- Eval harness：进化后在隔离环境跑 retention/boundary set，沙箱执行 + LLM Judge 评分
- 纵向评估指标：transfer accuracy、recovery speed、negative transfer rate、resource cost
- 跨维度一致性检查：多维度进化后 LLM 检查各维度间是否矛盾
- 进化策略学习：从历史中提取有效改动模式，作为 hint 提供给后续进化的 generator

### Phase 3 — 版本控制层

**Do:**
- 5 状态版本生命周期：draft → canary → stable → archived / rejected
- `clone@tag` 版本钉选语法：`scheduler`（默认 stable）、`scheduler@v2.3`、`scheduler@canary`、`scheduler@draft:abc123`
- 每个进化维度独立版本：persona 可以是 v3.1，skills 可以是 v1.5
- 进化始终生成新 draft 版本，不修改现有 stable/canary
- canary 灰度流量（traffic_ratio）+ 最小天数（min_days）+ 无回归自动升 stable
- 版本比较：任意两个版本间的 diff 查看
- UI 版本浏览器：查看历史版本、比较、升版、降版、钉选

**Don't:**
- 不做跨 Clone 进化（一个 clone 从另一个 clone 的经验学习）
- 不做多模型进化（只用当前 clone 配置的模型）
- 不进化工作流 YAML 结构本身（prompt 进化用 overlay，不改写 YAML）
- 不做进化进度流式详情（仅生命周期状态变更推送 SSE）
- 不做 A/B 盲评（成本过高，沙箱 + LLM Judge 已足够）

## Key Decisions

### Phase 1 决策

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 01 | Node YAML 设计 | `type: system_agent` + `role: main \| clone` | 单一节点类型减少 schema 复杂度 |
| 02 | 进化范围 | 全 5 维度 | 部分进化留下盲区 |
| 03 | 执行 Runtime | 合并到现有 EvolutionService | 避免两套进化系统冲突 |
| 04 | Review Gate | 对抗审查（专用 evolution-reviewer 分身） | 自审不可靠，专用分身有独立审查 persona |
| 05 | 触发方式 | 全部 4 种 | 不同场景需要不同触发 |
| 06 | 数据存储 | DB + 文件双层 | DB 可查询，文件提供内容和回滚 |
| 07 | 前端 | 完整进化 UI + SSE | 进化需要可见性和可干预性 |
| 08 | 验证 | 全层测试 | 进化修改持久状态，各层都需要捕获回归 |
| 09 | 测试数据 | 专用测试分身 | 不污染真实分身 |
| 10 | 交付节奏 | 一次性全量 | 用户偏好 |
| 11 | YAML 变更 | Overlay 模式（DB 存 override） | 用户 YAML 不应被系统修改 |
| 12 | system_prompt 进化 | 外化配置表 | Assembler 硬编码不可进化 |
| 13 | engine/server 边界 | **SystemAgentContext 接口**（6 个回调函数注入） | engine 不依赖 server，但需要 server 能力 |
| 14 | 熔断 | 3次/h + 连续2次禁用 + 上下文防递归 | 防无限循环和递归 |
| 15 | 失败计数 | 滑动窗口24h + 成功重置 | 精确控制触发时机 |
| 16 | 并发控制 | DB 行锁 + 乐观并发 | 防并发进化冲突 |
| 17 | eval sets | 自动 + 手动填充 | 减少人工维护 |

### Phase 2 决策

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 18 | 反馈通道 | 用户 👍/👎 + 系统标记，加权合并 | 用户信号精准但稀疏，系统信号粗糙但全面 |
| 19 | Eval Harness | 沙箱执行 + LLM Judge | 确定性规则太浅，A/B 盲评成本太高 |
| 20 | 纵向指标 | 全部 4 个：transfer accuracy, recovery speed, negative transfer rate, resource cost | 全面衡量进化效果 |
| 21 | 跨维度一致性 | LLM 一致性审查 | 规则约束需手工定义，LLM 审查更灵活 |
| 22 | 策略学习 | 模式提取 + Hint | 进化应从历史中学习，而非每次从零开始 |

### Phase 3 决策

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 23 | 版本模型 | 5 状态：draft/canary/stable/archived/rejected | 灰度验证后才升 stable，最安全 |
| 24 | 钉选语法 | `clone@tag`（@标签语法） | 简洁，类 Docker/npm 约定 |
| 25 | Canary 升版 | 灰度比例 + 最小天数 + 无回归自动升 | 灰度验证 + 时间窗口双重保险 |

### Story Gap Fixes

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 26 | engine/server 桥接 | `SystemAgentContext` 接口，6 个回调函数由 server 注入 engine | engine 包不可直接访问 server 的 DB/服务 |
| 27 | feedback 版本维度 | `evolution_feedback` 表新增 `version_tag` 字段 | canary 灰度期间需按版本聚合反馈 |
| 28 | Generator 诊断输入 | 结构化 `DiagnosisReport` 格式（失败模式 + feedback 趋势 + patterns） | 原始数据无法直接使用，需结构化 |
| 29 | Patch 输出格式 | Generator 统一输出**完整内容**，diff 由系统计算 | evolution_versions 存完整内容 |
| 30 | Eval 沙箱构造 | `EvalCloneRuntime`：基于真实 clone 替换 draft 维度内容，隔离执行 | Eval harness 需要构造测试 clone |
| 31 | Canary 监控 | `CanaryMonitor` 定时服务（每小时检查所有 canary） | auto-promote/rollback 需要触发者 |
| 32 | SSE execution_id | 所有 agent 执行 SSE 事件新增 `execution_id` 字段 | 前端反馈按钮需要关联执行记录 |

## Data Model Changes

### Phase 1 新增表

| Table | Operation | Details |
|-------|-----------|---------|
| `evolution_patches` | CREATE | id, clone_name, dimension, target_file, old_content, new_content, diff_content, status, review_feedback, reviewer_verdict, base_version, created_at, applied_at |
| `evolution_logs` | CREATE | id, clone_name, trigger_type, dimensions[], outcome, patches_count, duration_ms, created_at |
| `evolution_failures` | CREATE | id, clone_name, node_id, workflow_name, error_message, failed_at |
| `evolution_eval_cases` | CREATE | id, clone_name, case_type, input, expected_output, source, created_at, is_active |
| `system_prompt_config` | CREATE | id, org, segment_priorities (JSON), budget_overrides (JSON), content_rules (JSON), updated_at |
| `evolution_prompt_overrides` | CREATE | id, workflow_name, node_id, original_prompt, evolved_prompt, evolution_id, created_at, is_active |
| `evolution_locks` | CREATE | clone_name (PK), locked_by, locked_at, base_version |

### Phase 2 新增表

| Table | Operation | Details |
|-------|-----------|---------|
| `evolution_feedback` | CREATE | id, clone_name, execution_id, node_id, workflow_name, **version_tag**, user_rating (1/-1/null), user_comment, system_score (0-1), feedback_score (合并), created_at |
| `evolution_metrics` | CREATE | id, clone_name, evolution_id, metric_type (transfer_accuracy/recovery_speed/negative_transfer_rate/resource_cost), value (float), sample_size, measured_at |
| `evolution_patterns` | CREATE | id, clone_name, dimension, pattern_type (e.g. "add_example", "simplify_persona"), success_rate, avg_improvement, occurrences, last_seen_at |
| `evolution_coherence_checks` | CREATE | id, evolution_id, clone_name, dimensions_checked[], is_coherent (bool), conflicts (JSON), created_at |

### Phase 3 新增表

| Table | Operation | Details |
|-------|-----------|---------|
| `evolution_versions` | CREATE | id, clone_name, dimension, version_tag (v1.0, v1.1...), status (draft/canary/stable/archived/rejected), content (完整内容), content_hash, parent_version_id, evolution_id, canary_traffic_ratio, canary_min_days, canary_started_at, promoted_at, rejected_reason, created_at |

### 复用现有表
- `evolution_changelog` — 复用存储进化事件
- `evolution_experiences` — 复用存储进化经验

### Schema Changes (packages/shared)

```typescript
// === Phase 1: 节点类型扩展 ===

// NodeDef 新增字段（flat union 模式）
interface NodeDef {
  // ... 现有字段 ...
  role?: SystemAgentRole
  clone?: string
  evolution?: EvolutionDef
}

const NodeTypeSchema = z.enum([
  "bash", "python", "agent", "condition", "approval",
  "loop", "swarm", "interaction", "sub_workflow",
  "dynamic_sub_workflow", "system_agent"  // 🆕
])

type SystemAgentRole = 'main' | 'clone'

// === Phase 1: 进化配置 ===

interface EvolutionDef {
  mode: 'audit' | 'evolve' | 'verify'
  scope: EvolutionDimension[]
  strategy?: EvolutionStrategy
  review_gate?: 'adversarial' | 'manual'
  max_patches?: number              // 默认 3
  rollback_on_regression?: boolean  // 默认 true
  trigger?: EvolutionTrigger
  // Phase 2 新增
  eval_harness?: EvalHarnessDef     // 沙箱验证配置
  coherence_check?: boolean         // 跨维度一致性检查，默认 true
  canary?: CanaryConfig             // Phase 3: canary 升版配置
}

type EvolutionDimension = 'persona' | 'skills' | 'prompt' | 'system_prompt' | 'memory'

type EvolutionStrategy =
  | 'patch'     // 最小 diff（old_str → new_str），默认
  | 'distill'   // 压缩提炼，用于 memory 和 system_prompt
  | 'rewrite'   // 全量重写，当前内容根本性缺陷时

interface EvolutionTrigger {
  type: 'failure_threshold' | 'schedule' | 'manual' | 'workflow'
  threshold?: number
  cron?: string
}

// === Phase 1: 进化结果 ===

interface EvolutionPatch {
  id: string
  clone_name: string
  dimension: EvolutionDimension
  target_file: string
  old_content: string
  new_content: string
  status: 'candidate' | 'applied' | 'rejected' | 'rolled_back'
  review_feedback?: string
  reviewer_verdict?: 'accept' | 'reject'
  base_version: string
  created_at: string
  applied_at?: string
}

interface AuditReport {
  clone_name: string
  dimensions: EvolutionDimension[]
  recommendations: Array<{
    dimension: EvolutionDimension
    current: string
    suggested: string
    rationale: string
    confidence: number
  }>
  generated_at: string
}

interface VerifyReport {
  clone_name: string
  retention_set: { total: number; passed: number; failed: number }
  boundary_set: { total: number; passed: number; failed: number }
  failures: Array<{
    case_id: string
    case_type: 'retention' | 'boundary'
    input: string
    expected_output: string
    actual_output: string
  }>
  verified_at: string
}

// === Phase 3: 版本管理 ===

type VersionStatus = 'draft' | 'canary' | 'stable' | 'archived' | 'rejected'

interface EvolutionVersion {
  id: string
  clone_name: string
  dimension: EvolutionDimension
  version_tag: string              // e.g. "v1.0", "v1.1", "v2.0"
  status: VersionStatus
  content: string                  // 该版本的完整内容
  content_hash: string             // SHA-256，用于去重和完整性校验
  parent_version_id?: string       // 上一版本（进化来源）
  evolution_id?: string            // 生成该版本的进化事件
  // Canary 配置
  canary_traffic_ratio?: number     // 0-1，灰度流量比例
  canary_min_days?: number         // 最少运行天数
  canary_started_at?: string       // canary 开始时间
  // 状态变迁
  promoted_at?: string             // 升为当前状态的时间
  rejected_reason?: string         // 被拒绝的原因
  created_at: string
}

// 版本解析结果
interface ResolvedVersion {
  clone_name: string               // 不含 @tag 的纯 clone 名
  tag: string                      // 请求的 tag（默认 "stable"）
  version: EvolutionVersion        // 解析到的版本对象
  is_pinned: boolean               // 是否钉选（非 stable 即钉选）
}

// @ tag 语法解析规则：
// "scheduler"          → clone=scheduler, tag=stable
// "scheduler@stable"   → clone=scheduler, tag=stable
// "scheduler@canary"   → clone=scheduler, tag=canary（最新 canary）
// "scheduler@v2.3"     → clone=scheduler, tag=v2.3（精确版本）
// "scheduler@draft:abc123" → clone=scheduler, tag=draft:abc123（特定 draft）

// Canary 升版配置
interface CanaryConfig {
  traffic_ratio: number            // 0-1，灰度流量比例，默认 0.2
  min_days: number                 // 最少运行天数，默认 3
  auto_promote: boolean            // 无回归自动升 stable，默认 true
  regression_threshold: number     // 回归率阈值，超过则回滚，默认 0.05
}

// 版本比较
interface VersionDiff {
  clone_name: string
  dimension: EvolutionDimension
  from_version: string             // 版本 tag
  to_version: string               // 版本 tag
  from_content: string
  to_content: string
  diff: string                     // unified diff 格式
  changes_summary: string          // LLM 生成的变更摘要
}

// === Phase 2: 反馈系统 ===

interface EvolutionFeedback {
  id: string
  clone_name: string
  execution_id: string
  node_id: string
  workflow_name: string
  version_tag: string              // 🆕 关联到具体版本（canary 灰度按版本聚合）
  user_rating: 1 | -1 | null
  user_comment?: string
  system_score: number
  feedback_score: number
  created_at: string
}

// === Phase 2: Eval Harness ===

interface EvalHarnessDef {
  retention_set?: string[]         // eval case IDs，空则自动选取
  boundary_set?: string[]          // eval case IDs，空则自动选取
  timeout_ms?: number              // 单个用例执行超时，默认 30000
  judge_model?: string             // LLM Judge 使用的模型，默认同 clone 模型
  pass_threshold?: number          // 通过阈值 0-1，默认 0.7
}

interface EvalResult {
  case_id: string
  case_type: 'retention' | 'boundary'
  input: string
  expected_output: string
  actual_output: string
  judge_score: number              // 0-1，LLM Judge 评分
  judge_reason: string             // Judge 的评分理由
  rule_checks: Array<{             // 确定性规则检查
    rule: string
    passed: boolean
    detail: string
  }>
  passed: boolean                  // judge_score >= pass_threshold && all rule_checks passed
}

interface EvalReport {
  evolution_id: string
  clone_name: string
  results: EvalResult[]
  summary: {
    retention_passed: number
    retention_total: number
    retention_rate: number
    boundary_passed: number
    boundary_total: number
    boundary_rate: number
    regression_detected: boolean   // retention_rate < 1.0 → 有回归
    improvement_detected: boolean  // boundary_rate > 进化前的 boundary_rate
  }
  evaluated_at: string
}

// === Phase 2: 纵向指标 ===

type EvolutionMetricType =
  | 'transfer_accuracy'     // 新场景表现：未见过用例上的通过率提升
  | 'recovery_speed'        // 恢复速度：规则变更后到恢复正确行为的进化次数
  | 'negative_transfer_rate'// 负迁移率：因过去经验导致失败的比例
  | 'resource_cost'         // 资源成本：token消耗 + 时间 + 存储

interface EvolutionMetric {
  id: string
  clone_name: string
  evolution_id: string
  metric_type: EvolutionMetricType
  value: number               // 0-1（除 resource_cost 外）
  sample_size: number         // 测量样本数
  measured_at: string
}

// === Phase 2: 跨维度一致性 ===

interface CoherenceCheck {
  id: string
  evolution_id: string
  clone_name: string
  dimensions_checked: EvolutionDimension[]
  is_coherent: boolean
  conflicts: Array<{
    dimension_a: EvolutionDimension
    dimension_b: EvolutionDimension
    description: string         // 矛盾描述
    severity: 'warning' | 'blocking'
    suggestion: string          // 修复建议
  }>
  created_at: string
}

// === Phase 2: 进化策略模式 ===

interface EvolutionPattern {
  id: string
  clone_name: string
  dimension: EvolutionDimension
  pattern_type: string          // e.g. "add_example", "simplify_persona", "expand_constraints"
  description: string           // 模式描述
  success_rate: number          // 0-1，使用该模式后通过 eval 的比例
  avg_improvement: number       // 平均提升幅度（feedback_score delta）
  occurrences: number           // 使用次数
  last_seen_at: string
}

// === Phase 2: 其他类型 ===

interface EvolutionFailure {
  id: string
  clone_name: string
  node_id: string
  workflow_name: string
  error_message: string
  failed_at: string
}

interface EvolutionEvalCase {
  id: string
  clone_name: string
  case_type: 'retention' | 'boundary'
  input: string
  expected_output: string
  source: 'auto' | 'manual'
  is_active: boolean
  created_at: string
}

interface SystemPromptConfig {
  org: string
  segment_priorities: Record<string, number>
  budget_overrides: Record<string, number>
  content_rules: Record<string, string>
  updated_at: string
}

interface EvolutionPromptOverride {
  id: string
  workflow_name: string
  node_id: string
  original_prompt: string
  evolved_prompt: string
  evolution_id: string
  is_active: boolean
  created_at: string
}

// === Story Gap Fix #26: SystemAgentContext（engine/server 桥接） ===

// server 在启动引擎前构造此对象，注入到 ExecutorFactoryContext
// engine 通过回调访问 server 层能力，无需直接依赖 server 包
interface SystemAgentContext {
  // 版本解析：解析 clone@tag 语法，返回具体版本内容
  resolveVersion: (clone: string, tag: string) => Promise<ResolvedVersion>

  // Prompt override：查询工作流节点的进化后 prompt
  resolvePromptOverride: (workflow: string, nodeId: string) => Promise<string | null>

  // Skills 加载：获取指定 clone+版本的 skills 列表和路径
  loadSkills: (clone: string, versionTag: string) => Promise<SkillEntry[]>

  // 失败记录：system_agent 节点执行失败时记录
  recordFailure: (clone: string, nodeId: string, workflow: string, error: string, versionTag: string) => Promise<void>

  // 反馈记录：执行完成后记录系统评分（用户评分由前端 API 提交）
  recordSystemFeedback: (executionId: string, clone: string, versionTag: string, score: number) => Promise<void>

  // Clone provider：获取 CloneRuntime 实例用于实际执行
  getCloneRuntime: (clone: string, versionTag: string) => Promise<CloneRuntimeLike>
}

// === Story Gap Fix #28: DiagnosisReport（Generator 结构化输入） ===

// EvolutionService 在诊断阶段构造此报告，作为 Generator agent 的 prompt 输入
interface DiagnosisReport {
  clone_name: string
  dimension: EvolutionDimension
  current_version: {
    tag: string
    content: string               // 当前 stable 版本的完整内容
  }
  failure_analysis: {
    total_failures_24h: number
    failure_patterns: Array<{
      pattern: string             // e.g. "timeout on recurring task creation"
      occurrences: number
      sample_errors: string[]     // 最多 3 条示例
    }>
  }
  feedback_trend: {
    recent_avg_score: number      // 最近 20 条 feedback 的均分
    trend: 'improving' | 'stable' | 'declining'
    low_score_samples: Array<{    // 最低分的 3 条反馈
      score: number
      comment?: string
      prompt: string
    }>
  }
  evolution_history: {
    recent_patches: Array<{       // 最近 5 次进化记录
      version_from: string
      version_to: string
      outcome: string
      eval_boundary_rate: number
    }>
  }
  learned_patterns: Array<{       // 来自 evolution_patterns 的有效模式
    pattern_type: string
    description: string
    success_rate: number
  }>
}

// Generator 的输出（Story Gap Fix #29: 统一完整内容输出）
interface GeneratorOutput {
  new_content: string             // 完整的新版本内容（非 diff）
  rationale: string               // 为什么这样改
  addressed_failures: string[]    // 解决了哪些失败模式
  expected_improvement: string    // 预期改进
}

// === Story Gap Fix #30: EvalCloneRuntime（eval 沙箱构造） ===

// 基于真实 clone 配置但替换指定维度为 draft 版本
// 隔离执行，结果不写入真实 memory
interface EvalCloneRuntime {
  clone_name: string
  base_version_tags: Record<EvolutionDimension, string>  // 各维度的 stable 版本
  draft_overrides: Partial<Record<EvolutionDimension, string>>  // draft 版本覆盖

  // 构造隔离的运行时：
  // persona = draft_overrides.persona ?? base persona
  // skills = draft_overrides.skills ?? base skills
  // memory = shared read-only（不写入）
  execute: (prompt: string) => Promise<{ output: string; execution_id: string }>
}

// === Story Gap Fix #31: CanaryMonitor ===

interface CanaryCheck {
  clone_name: string
  dimension: EvolutionDimension
  version_tag: string
  canary_started_at: string
  days_running: number
  min_days_required: number
  traffic_ratio: number
  feedback_by_version: {
    canary_avg_score: number
    stable_avg_score: number
    sample_count: number
  }
  regression_rate: number          // (stable_avg - canary_avg) / stable_avg
  decision: 'continue' | 'promote' | 'rollback'
  reason: string
}

// === Story Gap Fix #L: Dashboard API 响应 ===

interface EvolutionDashboard {
  clone_name: string
  version_status: Record<EvolutionDimension, {
    current_tag: string
    current_status: VersionStatus
    canary?: { tag: string; traffic_ratio: number; days_running: number }
  }>
  metrics: {
    transfer_accuracy: { current: number; trend: number[] }
    recovery_speed: { current: number; trend: number[] }
    negative_transfer_rate: { current: number; trend: number[] }
    resource_cost: { current: number; trend: number[] }
  }
  feedback: {
    avg_score_7d: number
    avg_score_30d: number
    trend: number[]                // 每日均分，最近 30 天
  }
  recent_evolutions: Array<{
    id: string
    dimensions: EvolutionDimension[]
    outcome: string
    created_at: string
  }>
}
```

## API Contracts

### Phase 1 API

| Method | Path | Params | Response | Notes |
|--------|------|--------|----------|-------|
| POST | /api/evolution/trigger | `{ clone, dimensions?, trigger_type }` | `{ evolution_id, status }` | 手动触发 |
| GET | /api/evolution/history | `?clone=&limit=&offset=` | `{ items, total }` | 历史查询 |
| GET | /api/evolution/patches/:evolution_id | — | `{ patches[] }` | 获取补丁 |
| GET | /api/evolution/patches/:patch_id/diff | — | `{ old, new, diff }` | 补丁 diff |
| POST | /api/evolution/patches/:patch_id/rollback | — | `{ status }` | 回滚 |
| GET | /api/evolution/stats/:clone | — | `{ total_patches, success_rate, last_evolution }` | 统计 |
| GET | /api/evolution/stream/:evolution_id | — | SSE stream | 事件流 |
| POST | /api/evolution/eval-cases | `{ clone, case_type, input, expected_output }` | `{ id }` | 添加 case |
| GET | /api/evolution/eval-cases/:clone | `?case_type=` | `{ items[] }` | 查询 cases |
| GET | /api/evolution/system-prompt-config/:org | — | `SystemPromptConfig` | 获取配置 |
| PUT | /api/evolution/system-prompt-config/:org | `SystemPromptConfig` | `{ updated }` | 更新配置 |
| GET | /api/evolution/prompt-overrides/:workflow | — | `{ items[] }` | 查询 overrides |

### Phase 2 API

| Method | Path | Params | Response | Notes |
|--------|------|--------|----------|-------|
| POST | /api/evolution/feedback | `{ execution_id, user_rating, user_comment? }` | `{ id, feedback_score }` | 提交反馈 |
| GET | /api/evolution/feedback/:clone | `?limit=&offset=` | `{ items[], avg_score }` | 查询反馈 |
| GET | /api/evolution/metrics/:clone | `?metric_type=&from=&to=` | `{ items[], trends }` | 指标趋势 |
| GET | /api/evolution/patterns/:clone | `?dimension=` | `{ items[] }` | 学习到的模式 |
| GET | /api/evolution/eval-report/:evolution_id | — | `EvalReport` | eval harness 报告 |
| GET | /api/evolution/coherence/:evolution_id | — | `CoherenceCheck` | 一致性检查结果 |
| GET | /api/evolution/dashboard/:clone | — | `EvolutionDashboard` | 进化仪表板 |

### Phase 3 API

| Method | Path | Params | Response | Notes |
|--------|------|--------|----------|-------|
| GET | /api/evolution/versions/:clone | `?dimension=&status=` | `{ items: EvolutionVersion[] }` | 版本列表 |
| GET | /api/evolution/versions/:clone/:dimension/:tag | — | `EvolutionVersion` | 获取特定版本 |
| POST | /api/evolution/versions/:version_id/promote | `{ target_status: 'canary' \| 'stable' }` | `{ version }` | 升版 |
| POST | /api/evolution/versions/:version_id/reject | `{ reason }` | `{ version }` | 拒绝 draft |
| GET | /api/evolution/versions/:clone/:dimension/diff | `?from=v1.0&to=v2.0` | `VersionDiff` | 版本比较 |
| POST | /api/evolution/versions/:version_id/rollback | — | `{ version }` | 回滚到指定版本 |

### SSE 事件类型

```typescript
type EvolutionSSEEvent =
  // Phase 1
  | { type: 'evolution_started'; evolution_id: string; clone: string }
  | { type: 'evolution_audit_completed'; evolution_id: string; report: AuditReport }
  | { type: 'evolution_patch_generated'; evolution_id: string; patch_id: string; dimension: string }
  | { type: 'evolution_review_started'; evolution_id: string; patch_id: string }
  | { type: 'evolution_review_completed'; evolution_id: string; patch_id: string; verdict: 'accept' | 'reject' }
  | { type: 'evolution_applied'; evolution_id: string; patch_id: string }
  | { type: 'evolution_rolled_back'; evolution_id: string; patch_id: string; reason: string }
  | { type: 'evolution_completed'; evolution_id: string; outcome: 'success' | 'partial' }
  | { type: 'evolution_failed'; evolution_id: string; error: { code: string; message: string } }
  // Phase 2
  | { type: 'evolution_eval_started'; evolution_id: string }
  | { type: 'evolution_eval_completed'; evolution_id: string; report: EvalReport }
  | { type: 'evolution_coherence_check'; evolution_id: string; is_coherent: boolean; conflicts: number }
  | { type: 'evolution_metrics_updated'; clone: string; metrics: Array<{ type: string; value: number }> }
  // Phase 3
  | { type: 'evolution_version_created'; clone: string; dimension: string; version_tag: string; status: 'draft' }
  | { type: 'evolution_version_promoted'; clone: string; dimension: string; version_tag: string; from: string; to: string }
  | { type: 'evolution_version_rejected'; clone: string; dimension: string; version_tag: string; reason: string }
  | { type: 'evolution_canary_started'; clone: string; dimension: string; version_tag: string; traffic_ratio: number }
  | { type: 'evolution_canary_completed'; clone: string; dimension: string; version_tag: string; outcome: 'promote' | 'rollback' }
```

### API 错误响应

```typescript
interface EvolutionAPIError {
  error: {
    code:
      | 'CLONE_NOT_FOUND'
      | 'EVOLUTION_IN_PROGRESS'
      | 'EVOLUTION_DISABLED'
      | 'PATCH_NOT_APPLIED'
      | 'PROVIDER_UNAVAILABLE'
      | 'EVOLUTION_TIMEOUT'
      | 'INVALID_DIMENSION'
      | 'BASE_VERSION_MISMATCH'
      | 'EXECUTION_NOT_FOUND'    // Phase 2: feedback for unknown execution
    message: string
  }
}
```

## Architecture: Execution Flow (SystemAgentContext 桥接)

```
┌──────────────────────────────────────────────────────────────────┐
│                        Server Layer                               │
│                                                                   │
│  构建 SystemAgentContext（6 个回调函数）:                          │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ resolveVersion()        ← VersionResolver + evolution_versions│ │
│  │ resolvePromptOverride() ← evolution_prompt_overrides 表      │  │
│  │ loadSkills()            ← CloneRuntime plugin discovery      │  │
│  │ recordFailure()         ← evolution_failures 表              │  │
│  │ recordSystemFeedback()  ← evolution_feedback 表              │  │
│  │ getCloneRuntime()       ← CloneRuntime 实例                  │  │
│  └──────────────────────────────────┬──────────────────────────┘  │
│                                     │ 注入 ExecutorFactoryContext │
└─────────────────────────────────────┼────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                        Workflow Engine                            │
│                                                                   │
│  ┌─────────────────┐     ┌──────────────────────────────────┐    │
│  │ ExecutorFactory │────▶│ SystemAgentExecutor               │    │
│  └─────────────────┘     │                                   │    │
│                          │ 1. ctx.resolveVersion(clone, tag)  │    │
│                          │    → 获取版本内容 + version_tag    │    │
│                          │ 2. ctx.resolvePromptOverride()     │    │
│                          │    → 覆盖原始 prompt               │    │
│                          │ 3. ctx.loadSkills(clone, tag)      │    │
│                          │    → 获取 skills 列表              │    │
│                          │ 4. ctx.getCloneRuntime(clone, tag) │    │
│                          │    → 获取执行器实例                │    │
│                          │ 5. 执行 + 流式返回                 │    │
│                          │ 6. 成功: ctx.recordSystemFeedback() │    │
│                          │    失败: ctx.recordFailure()        │    │
│                          └──────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

## Architecture: Phase 3 Version Management

```
                    ┌─────────────────────────────────────────────┐
                    │         Version Lifecycle per Dimension      │
                    │                                             │
  进化生成          │   ┌───────┐   ┌────────┐   ┌────────┐     │
  (generator)──────▶│   │ draft │──▶│ canary │──▶│ stable │     │
                    │   └───┬───┘   └───┬────┘   └───┬────┘     │
                    │       │           │            │            │
                    │       │ reject    │ regression │ 新版本升stable│
                    │       ▼           ▼            ▼            │
                    │   ┌──────────┐  rollback   ┌──────────┐   │
                    │   │ rejected │            │ archived │   │
                    │   └──────────┘            └──────────┘   │
                    │                                             │
                    │  persona:  v1.0 → v1.1(draft) → v1.1(canary)│
                    │  skills:   v2.0 → v2.1(draft) → v2.1(stable)│
                    │  memory:   v1.0 → v1.1(draft) → rejected    │
                    │                                             │
                    │  每个维度独立版本化，互不影响                  │
                    └─────────────────────────────────────────────┘
```

### Version Resolution（版本解析）

```
YAML:  clone: scheduler@v2.3
          │
          ▼
  ┌───────────────────┐
  │ VersionResolver   │
  │                   │
  │ parse("scheduler@v2.3")
  │   → clone = "scheduler"
  │   → tag = "v2.3"
  │                   │
  │ resolve(clone, tag)│
  │   → SELECT FROM    │
  │     evolution_versions│
  │     WHERE clone = ? │
  │     AND version_tag = ?│
  │     AND status IN   │
  │       ('canary',    │
  │        'stable')    │
  │                   │
  │   → EvolutionVersion│
  └────────┬──────────┘
           │
           ▼
  加载该版本的 content 作为
  persona / skills / etc.
```

### Canary Traffic Routing

```
  请求到达 SystemAgentExecutor
          │
          ▼
  ┌───────────────────────┐
  │ hash(request_id) % 100│
  │   < traffic_ratio*100 │
  │                       │
  │  YES → 使用 canary 版本│
  │  NO  → 使用 stable 版本│
  └───────────────────────┘

  例如 traffic_ratio = 0.2:
    20% 请求 → canary (v2.1)
    80% 请求 → stable (v2.0)

  canary 运行 min_days 天后:
    regression_rate < threshold → promote to stable
    regression_rate > threshold → rollback to stable
```

## Architecture: Phase 2 Evolution Intelligence

```
                    ┌─────────────────────────────────────────────┐
                    │              Feedback Channel                │
                    │                                             │
                    │  User 👍/👎 ──┐                             │
                    │               ├─▶ feedback_score            │
                    │  System ──────┘   (0.7*user + 0.3*system)   │
                    │  execution_result                           │
                    │  output_validation                          │
                    └──────────────────┬──────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      EvolutionService (扩展)                             │
│                                                                          │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐             │
│  │1. Read   │──▶│2. Diagnose│──▶│3. Patch  │──▶│4. Review │             │
│  │          │   │           │   │          │   │(reviewer)│             │
│  │          │   │ 使用:      │   │ 使用:     │   │          │             │
│  │          │   │ feedback   │   │ evolution │   │          │             │
│  │          │   │ _score 趋势│   │ _patterns │   │          │             │
│  │          │   │ 作为诊断信号│   │ 作为 hint  │   │          │             │
│  └──────────┘   └──────────┘   └──────────┘   └────┬─────┘             │
│                                                     │                    │
│                    ┌────────────────────────────────▼──────────┐        │
│                    │ 5. Eval Harness (沙箱验证)                  │        │
│                    │                                            │        │
│                    │  retention set ──▶ 沙箱执行 ──▶ LLM Judge  │        │
│                    │  boundary set ──▶ 沙箱执行 ──▶ LLM Judge  │        │
│                    │                                            │        │
│                    │  确定性规则检查 + Judge 评分 → EvalReport   │        │
│                    └──────────────────────┬─────────────────────┘        │
│                                           │                              │
│                    ┌──────────────────────▼─────────────────────┐        │
│                    │ 6. Coherence Check (跨维度一致性)           │        │
│                    │                                            │        │
│                    │  persona + skills + prompt + sysprompt +   │        │
│                    │  memory → LLM 检查矛盾 → CoherenceCheck   │        │
│                    └──────────────────────┬─────────────────────┘        │
│                                           │                              │
│                    ┌──────────────────────▼─────────────────────┐        │
│                    │ 7. Apply + Measure                         │        │
│                    │                                            │        │
│                    │  应用补丁 → 更新纵向指标 → 提取模式         │        │
│                    │  transfer_accuracy / recovery_speed /       │        │
│                    │  negative_transfer_rate / resource_cost     │        │
│                    └────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────┘
```

### 进化信号闭环

```
执行 agent 任务
    │
    ▼
收集反馈（👍/👎 + 系统评分）
    │
    ▼
feedback_score 低于阈值 / 失败累计
    │
    ▼
触发进化
    │
    ▼
诊断（基于 feedback 趋势 + failure 轨迹）
    │
    ▼
生成 patch（参考 evolution_patterns 中的有效模式）
    │
    ▼
对抗审查（evolution-reviewer）
    │
    ▼
Eval Harness 沙箱验证（retention + boundary sets）
    │
    ▼
跨维度一致性检查
    │
    ▼
Apply / Rollback
    │
    ▼
测量纵向指标（transfer_accuracy, recovery_speed...）
    │
    ▼
提取模式 → evolution_patterns 表
    │
    ▼
下次进化时 patterns 作为 hint ──┐
    │                            │
    └────────────────────────────┘  ← 闭环
```

## Acceptance Criteria

### Phase 1 ACs (AC-01 ~ AC-24)

| # | User Story | AC | Verification |
|---|-----------|----|-------------|
| AC-01 | 引用 Main Agent | `role: main` 使用 server 注入的 7 段 system prompt | Integration |
| AC-02 | 引用 Clone | `role: clone` 使用 clone 的 persona/memory/skills | Integration |
| AC-03 | persona 进化 | 读取 persona.md → patch → reviewer → 写入（含备份） | Integration |
| AC-04 | skills 进化 | 修改/新增 SKILL.md，reviewer 验证 | Integration |
| AC-05 | prompt 进化 | 进化结果存入 overlay 表，引擎执行时覆盖 | Integration |
| AC-06 | system_prompt 进化 | 修改 system_prompt_config，Assembler 读取生效 | Integration |
| AC-07 | memory 进化 | distill 策略合并重复经验 | Integration |
| AC-08 | 对抗审查 | reviewer 的 verdict 和 feedback 被记录 | Unit + Integration |
| AC-09 | 失败阈值触发 | 24h 内 5 次失败 → 自动触发 | Integration |
| AC-10 | 手动触发 | POST trigger 返回 evolution_id | Integration |
| AC-11 | 定时触发 | cron 配置后定时触发 | Integration |
| AC-12 | 进化历史 UI | 面板展示时间线 | Playwright E2E |
| AC-13 | diff UI | old vs new 对比 | Playwright E2E |
| AC-14 | 回滚 UI | 回滚 → 文件恢复 + DB 更新 | Playwright E2E |
| AC-15 | 编辑器 system_agent | 拖放 + 配置 | Playwright E2E |
| AC-16 | 自动回滚 | rollback_on_regression 验证 | Integration |
| AC-17 | 熔断 | 3次/h 拒绝 + 连续2次禁用 | Integration |
| AC-18 | 递归防护 | evolution_context 标记 | Integration |
| AC-19 | 并发防护 | 锁 + base_version | Integration |
| AC-20 | SSE 事件 | 生命周期事件推送 | Integration |
| AC-21 | audit mode | 返回 AuditReport | Integration |
| AC-22 | verify mode | 返回 VerifyReport | Integration |
| AC-23 | eval case 管理 | auto + manual | Integration |
| AC-24 | prompt overlay | 引擎查询覆盖 | Integration |

### Phase 2 ACs (AC-25 ~ AC-36)

| # | User Story | AC | Verification |
|---|-----------|----|-------------|
| AC-25 | 用户反馈 | agent 输出旁有 👍/👎 按钮，点击后 feedback_score 更新 | Playwright E2E |
| AC-26 | 系统评分 | agent 执行后自动计算 system_score（success=1, error=0, timeout=0.3） | Unit |
| AC-27 | 反馈聚合 | feedback_score = 0.7*user + 0.3*system，无 user 时 = system | Unit |
| AC-28 | 反馈驱动触发 | feedback_score 连续低于阈值也能触发进化（补充 failure threshold） | Integration |
| AC-29 | 沙箱 eval | 进化后自动跑 retention + boundary set，输出 EvalReport | Integration |
| AC-30 | LLM Judge | 每个 eval case 的 actual_output 由 LLM 评分 0-1 + 理由 | Unit + Integration |
| AC-31 | 回归检测 | retention_rate < 1.0 时标记 regression_detected，触发 rollback | Integration |
| AC-32 | 改进检测 | boundary_rate > 进化前时标记 improvement_detected | Integration |
| AC-33 | 纵向指标 | 每次进化后计算 4 个指标并存入 evolution_metrics | Integration |
| AC-34 | 指标趋势 UI | 仪表板展示指标随时间的变化曲线 | Playwright E2E |
| AC-35 | 跨维度一致性 | 多维度进化后 LLM 检查矛盾，conflict 为 blocking 时阻止 apply | Integration |
| AC-36 | 策略学习 | 成功 patch 的模式被提取到 evolution_patterns，下次进化作为 hint | Integration |

### Phase 3 ACs (AC-37 ~ AC-48)

| # | User Story | AC | Verification |
|---|-----------|----|-------------|
| AC-37 | 版本钉选 | `clone: scheduler@v2.3` 节点使用 v2.3 版本的 persona/skills | Integration |
| AC-38 | 默认 stable | `clone: scheduler`（无 tag）解析为最新 stable 版本 | Integration |
| AC-39 | 进化生成 draft | 进化产生的新版本状态为 draft，不影响当前 stable | Integration |
| AC-40 | Draft → Canary | 通过 adversarial review + eval 的 draft 可升为 canary | Integration |
| AC-41 | Canary 灰度 | canary 版本按 traffic_ratio 对部分流量生效 | Integration |
| AC-42 | 自动升版 | canary 运行 min_days 天且回归率 < threshold → 自动升为 stable | Integration |
| AC-43 | 自动回滚 | canary 回归率 > threshold → 自动回滚到上一 stable | Integration |
| AC-44 | 版本历史 UI | 版本浏览器展示所有版本（按维度筛选），含状态和时间 | Playwright E2E |
| AC-45 | 版本比较 UI | 选择两个版本展示 diff + LLM 变更摘要 | Playwright E2E |
| AC-46 | 手动升/降版 | UI 中可手动 promote/reject/rollback 版本 | Playwright E2E |
| AC-47 | 维度独立版本 | persona v3.1 + skills v1.5 可并存，各维度独立版本化 | Integration |
| AC-48 | 版本解析错误 | `scheduler@v99.0`（不存在）返回清晰的版本不存在错误 | Integration |

### Story Gap Fix ACs (AC-49 ~ AC-58)

| # | User Story | AC | Verification |
|---|-----------|----|-------------|
| AC-49 | SystemAgentContext 注入 | server 启动引擎时注入 6 个回调，SystemAgentExecutor 通过回调完成版本解析、prompt override、skills 加载、失败记录、反馈记录 | Integration |
| AC-50 | 版本解析回调 | `resolveVersion("scheduler", "v2.3")` 返回 v2.3 版本的完整内容 | Unit + Integration |
| AC-51 | 反馈关联版本 | system_agent 执行时已知当前 version_tag，feedback 记录携带此 tag | Integration |
| AC-52 | Canary 版本反馈聚合 | canary 期间 feedback_score 按 version_tag 分组统计，canary vs stable 各自独立 | Integration |
| AC-53 | 结构化诊断 | EvolutionService 在诊断阶段生成 DiagnosisReport，包含失败模式、feedback 趋势、patterns | Unit |
| AC-54 | Generator 完整输出 | Generator 输出 GeneratorOutput（完整内容 + rationale），diff 由系统计算 | Unit |
| AC-55 | EvalCloneRuntime 构造 | eval harness 用 EvalCloneRuntime 构造测试 clone，替换 draft 维度，隔离执行 | Integration |
| AC-56 | CanaryMonitor 定时检查 | 每小时扫描所有 canary 版本，输出 CanaryCheck，触发 promote 或 rollback | Integration |
| AC-57 | SSE execution_id | agent 执行的 SSE 事件（text_delta, tool_call, done）携带 execution_id | Integration |
| AC-58 | Dashboard API | `GET /api/evolution/dashboard/:clone` 返回 EvolutionDashboard 聚合数据 | Integration |

## Verification Strategy

### Global Config
- Environment: local dev
- Test user: API key 认证
- Data prefix: `EVO_TEST_`
- Test clone: `test-scheduler`
- Reviewer clone: `evolution-reviewer`

### Per-layer Methods

#### Unit Tests
- Schema Zod 验证（所有新增类型）
- feedback_score 计算（有 user / 无 user / 边界值）
- Circuit breaker 逻辑
- Sliding window 失败计数
- LLM Judge prompt 构造和解析
- 纵向指标计算公式
- Coherence check prompt 构造
- Pattern 提取逻辑

#### Integration Tests
- Phase 1 全部（AC-01 ~ AC-24）
- 反馈收集 + 聚合 + 存储
- Eval harness 全流程：沙箱执行 + Judge + EvalReport
- 回归检测 → 自动 rollback
- 纵向指标计算和存储
- 跨维度一致性检查（coherent + incoherent 两种场景）
- Pattern 提取 + hint 注入下次进化

#### Browser E2E
- 反馈按钮交互（👍/👎 点击 + 视觉反馈）
- 指标仪表板（趋势图渲染）
- Eval report 展示
- Coherence check 结果展示
- 进化面板全流程（触发 → SSE 更新 → 查看 eval report → 查看指标变化）

#### Contract Tests
- 所有新增类型与 DB 表一致性
- API response 与 TypeScript 接口一致性

#### Manual Checklist
- [ ] 进化确实提升了 agent 在 boundary set 上的表现
- [ ] LLM Judge 评分与人工判断基本一致（抽样 10 case，偏差 < 0.2）
- [ ] evolution_patterns 中提取的模式对人类可理解
- [ ] 跨维度一致性检查能捕获明显的 persona/skill 矛盾

### Prerequisites
- [ ] 全部包构建成功
- [ ] evolution-reviewer 分身已创建
- [ ] test-scheduler 测试分身已创建
- [ ] system_prompt_config 初始化默认值
- [ ] eval harness 沙箱环境可执行

## Risks & Notes

### Phase 1 Risks
- R1: 进化循环导致漂移 — adversarial review + rollback + 熔断器
- R2: system_prompt 进化破坏核心功能 — core_identity 段 fixed
- R3: 进化耗时 — max_patches + 5 分钟超时
- R4: token 消耗 — reviewer 用轻量模型 + 缓存
- R5: prompt overlay 查询开销 — 内存缓存
- R6: EvolutionService 扩展影响现有功能 — 新方法不修改旧签名

### Phase 2 Risks
- R7: LLM Judge 评分不稳定 — 温度设为 0 + 多次评分取均值 + 确定性规则兜底
- R8: 反馈稀疏（用户不标记） — system_score 兜底 + 低反馈 clone 自动增加 eval 频率
- R9: 纵向指标需要足够历史数据 — 新 clone 前 10 次进化标记为 "calibrating"，不计算指标
- R10: evolution_patterns 过拟合 — 模式需要至少 5 次成功才纳入 hint，定期衰减权重
- R11: 跨维度一致性检查增加延迟 — 仅多维度进化时触发，单维度跳过

### Phase 3 Risks
- R12: 版本数量膨胀 — archived 版本超过 90 天自动清理（保留里程碑版本）
- R13: canary 流量路由增加引擎复杂度 — VersionResolver 缓存解析结果，工作流级 TTL
- R14: 多版本共存时 persona 与 skills 版本不匹配 — canary 升版时触发跨维度一致性检查
- R15: 版本钉选导致工作流使用过时版本 — 钉选版本超过 N 天时 UI 显示升级提示

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| **system_agent** | 工作流节点类型，引用 Main Agent 或 Clone 执行任务 |
| **EvolutionService (扩展)** | 现有进化服务，新增 5 维度宏观进化 + eval harness + 策略学习 |
| **evolution dimension** | 可进化的 5 个维度：persona、skills、prompt、system_prompt、memory |
| **evolution patch** | 最小化修改（old → new diff），可被 review、eval、apply、rollback |
| **adversarial review** | 专用 evolution-reviewer 分身的对立视角审查 |
| **evolution-reviewer** | 专用内置分身，独立审查 persona，不参与自身进化 |
| **retention set** | 必须保持通过的案例集（回归保护） |
| **boundary set** | 当前失败、需要改进的案例集 |
| **circuit breaker** | 熔断器：3次/h上限 + 连续2次禁用 |
| **evolution context** | 防递归标记 |
| **prompt overlay** | prompt 进化的非破坏性模式（DB 存 override） |
| **system_prompt_config** | 外化的 Assembler 配置表 |
| **base_version** | 乐观并发控制的文件 hash |
| **feedback_score** | 合并反馈分数 = 0.7*user_rating + 0.3*system_score |
| **eval harness** | 进化后的沙箱验证系统，跑 retention/boundary set |
| **LLM Judge** | eval harness 中用 LLM 评分 actual_output 的组件 |
| **EvalReport** | eval harness 输出，含逐 case 结果和汇总 |
| **transfer accuracy** | 纵向指标：新场景上的表现提升 |
| **recovery speed** | 纵向指标：规则变更后恢复到正确行为的速度 |
| **negative transfer rate** | 纵向指标：过去经验导致失败的比例 |
| **resource cost** | 纵向指标：进化的 token/时间/存储消耗 |
| **coherence check** | 跨维度一致性审查 |
| **evolution pattern** | 从历史中提取的有效改动模式，作为 hint 指导后续进化 |
| **strategy: patch** | 最小 diff 策略（默认） |
| **strategy: distill** | 压缩提炼策略（memory/system_prompt） |
| **strategy: rewrite** | 全量重写策略（根本性缺陷时） |
| **version status** | 版本状态：draft（候选）→ canary（灰度）→ stable（生产）→ archived（归档）/ rejected（拒绝） |
| **version pinning** | 通过 `clone@tag` 语法锁定特定版本，如 `scheduler@v2.3` |
| **canary** | 灰度版本：对部分流量生效，运行指定天数无回归后自动升为 stable |
| **canary traffic_ratio** | canary 版本接收的流量比例（0-1），默认 0.2 |
| **VersionResolver** | 解析 `clone@tag` 语法并从 evolution_versions 表查询对应版本的组件 |
| **SystemAgentContext** | server 注入 engine 的 6 个回调函数接口，桥接 engine/server 包边界 |
| **DiagnosisReport** | 结构化诊断报告，作为 Generator agent 的输入（含失败模式、feedback 趋势、patterns） |
| **GeneratorOutput** | Generator 的输出格式：完整内容 + rationale + 解决的失败模式 |
| **EvalCloneRuntime** | eval harness 使用的隔离运行时，基于真实 clone 替换 draft 维度内容 |
| **CanaryMonitor** | 定时服务（每小时），检查所有 canary 版本的 min_days 和 regression_rate |
| **EvolutionDashboard** | 仪表板聚合数据类型：版本状态 + 指标趋势 + 反馈趋势 + 进化历史 |

## Appendix: Core User Stories（闭环验证）

以下 3 个故事追踪完整用户旅程，验证 UI → API → 数据 → 执行的每一步都连通。

### Story 1: 开发者创建 system_agent 工作流并执行

```
开发者打开 Web UI → 工作流编辑器
  │
  ├─[UI] Palette 中有 system_agent 节点类型
  ├─[UI] 拖放到画布 → 配置面板出现
  │     ├─ role 下拉: main / clone
  │     ├─ clone 下拉: 从 GET /api/clones 获取列表
  │     └─ 版本选择: stable(默认) / canary / 具体版本号
  │
  ├─[UI] 填写 prompt → 保存
  │     └─ POST /api/workflows (已有)
  │
  ├─[UI] 点击运行
  │     └─ POST /api/workflows/:id/run (已有)
  │
  ├─[Backend] Engine 创建 SystemAgentExecutor
  │     ├─ ctx.resolveVersion("scheduler", "stable")
  │     │     → 查询 evolution_versions WHERE status=stable
  │     │     → 返回 persona v3.1 完整内容
  │     ├─ ctx.resolvePromptOverride(workflow, nodeId)
  │     │     → 查询 evolution_prompt_overrides
  │     │     → 返回 evolved_prompt 或 null
  │     ├─ ctx.loadSkills("scheduler", "v3.1")
  │     │     → 返回 skills 列表和路径
  │     ├─ ctx.getCloneRuntime("scheduler", "v3.1")
  │     │     → 返回配置了 v3.1 persona 的 CloneRuntime
  │     └─ 执行 → 流式返回结果
  │
  ├─[Backend] 执行成功
  │     └─ ctx.recordSystemFeedback(execId, "scheduler", "v3.1", 1.0)
  │           → 写入 evolution_feedback (含 version_tag)
  │
  └─[Frontend] 展示 agent 输出
        ├─ SSE 事件携带 execution_id
        └─ <FeedbackButtons> 组件: [👍] [👎] [📝]
              └─ POST /api/evolution/feedback
                    { execution_id, user_rating: 1, version_tag: "v3.1" }
```

### Story 2: Agent 失败 → 进化 → canary 部署 → 自动升版

```
scheduler clone 连续执行失败
  │
  ├─[Backend] 每次失败: ctx.recordFailure()
  │     → evolution_failures 表写入
  │
  ├─[Backend] 24h 内 5 次失败 → 触发进化
  │     ├─ 检查熔断器: < 3次/h ✅
  │     ├─ 获取进化锁: evolution_locks
  │     └─ 启动进化流程
  │
  ├─[Evolution] Step 1: Read
  │     ├─ 当前 stable persona v3.0 内容
  │     ├─ 最近 20 条 feedback (按 version_tag 分组)
  │     ├─ 最近 10 条失败轨迹
  │     └─ evolution_patterns (历史有效模式)
  │
  ├─[Evolution] Step 2: Diagnose
  │     └─ 构造 DiagnosisReport:
  │           ├─ failure_patterns: [{pattern, occurrences, samples}]
  │           ├─ feedback_trend: {avg, trend, low_score_samples}
  │           ├─ evolution_history: [{from, to, outcome, eval_rate}]
  │           └─ learned_patterns: [{type, description, success_rate}]
  │
  ├─[Evolution] Step 3: Generate
  │     └─ Generator agent 输入 DiagnosisReport
  │           → 输出 GeneratorOutput:
  │               ├─ new_content: "完整的新 persona 内容"
  │               ├─ rationale: "增强错误处理指引..."
  │               ├─ addressed_failures: ["timeout handling"]
  │               └─ expected_improvement: "减少超时错误 30%"
  │           → 系统计算 diff = computeDiff(v3.0.content, new_content)
  │           → 创建 evolution_versions 记录:
  │               persona v3.1, status=draft, parent=v3.0
  │           → SSE: evolution_version_created
  │
  ├─[Evolution] Step 4: Review
  │     └─ evolution-reviewer 分身审查:
  │           输入: draft v3.1 + DiagnosisReport + diff
  │           输出: accept + "改进方向合理，增加了超时处理指引"
  │           → SSE: evolution_review_completed (verdict=accept)
  │
  ├─[Evolution] Step 5: Eval Harness
  │     ├─ 构造 EvalCloneRuntime:
  │     │     persona = v3.1 (draft)
  │     │     skills = v2.0 (stable, 未变)
  │     │     memory = shared read-only
  │     ├─ 跑 retention set (10 cases):
  │     │     每个: execute(prompt) → LLM Judge 评分
  │     │     结果: 10/10 passed ✅
  │     ├─ 跑 boundary set (5 cases):
  │     │     结果: 3/5 passed (之前 0/5) ✅ 有改进
  │     └─ EvalReport: regression=false, improvement=true
  │           → SSE: evolution_eval_completed
  │
  ├─[Evolution] Step 6: Promote to Canary
  │     ├─ draft v3.1 → canary v3.1
  │     ├─ canary_traffic_ratio = 0.2
  │     ├─ canary_started_at = now()
  │     └─ SSE: evolution_canary_started
  │
  ├─[Runtime] Canary 运行期 (3 天)
  │     ├─ 每个请求: hash(req_id) % 100 < 20?
  │     │     YES → 使用 persona v3.1
  │     │     NO  → 使用 persona v3.0 (stable)
  │     ├─ 每次执行后: recordSystemFeedback(含 version_tag)
  │     └─ feedback 按 version_tag 聚合:
  │           v3.1 avg: 0.82
  │           v3.0 avg: 0.65
  │
  ├─[CanaryMonitor] 每小时检查
  │     ├─ canary v3.1: days_running=3, min_days=3 ✅
  │     ├─ regression_rate = (0.65-0.82)/0.65 = -0.26 (负=改进) ✅
  │     ├─ decision: promote
  │     ├─ canary v3.1 → stable v3.1
  │     ├─ 旧 stable v3.0 → archived
  │     └─ SSE: evolution_canary_completed (outcome=promote)
  │           + evolution_version_promoted
  │
  └─[Post] 后续执行自动使用 stable v3.1
```

### Story 3: 管理员查看仪表板 + 手动干预

```
管理员打开 Web UI → 导航栏 → "进化" 菜单
  │
  ├─[API] GET /api/evolution/dashboard/scheduler
  │     → EvolutionDashboard:
  │         version_status: { persona: v3.1(stable), skills: v2.0(stable) }
  │         metrics: { transfer_accuracy: {current: 0.78, trend: [...]} }
  │         feedback: { avg_score_7d: 0.82, trend: [...] }
  │         recent_evolutions: [{id, dims, outcome, time}]
  │
  ├─[UI] 仪表板渲染:
  │     ├─ 版本状态卡片（各维度当前版本 + 状态标签）
  │     ├─ 指标趋势折线图（4 条线）
  │     ├─ 反馈趋势折线图（7d vs 30d 均分）
  │     └─ 最近进化时间线
  │
  ├─[UI] 点击 "persona v3.1" → 版本详情页
  │     ├─ GET /api/evolution/versions/scheduler/persona/v3.1
  │     ├─ 显示: 内容预览 + eval 结果 + review 意见
  │     └─ 按钮: [与 v3.0 比较] [回滚到此版本]
  │
  ├─[UI] 点击 "与 v3.0 比较"
  │     ├─ GET /api/evolution/versions/scheduler/persona/diff?from=v3.0&to=v3.1
  │     └─ 显示: unified diff + AI 变更摘要
  │
  ├─[UI] 点击 [手动触发进化]
  │     ├─ POST /api/evolution/trigger { clone: "scheduler" }
  │     ├─ SSE: evolution_started
  │     └─ UI 显示进度条（监听 SSE 事件更新）
  │
  └─[UI] 进化完成后
        ├─ SSE: evolution_completed
        ├─ 仪表板自动刷新
        └─ 新的 draft 版本出现在版本列表中
```
