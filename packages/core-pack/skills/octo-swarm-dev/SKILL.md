---
name: octo-swarm-dev
description: Swarm 专家团开发助手 — 5 种协作模式 (review/debate/dispatch/swarm/moa)、ExpertDef 定义、Host/Aggregator 综合、动态路由、上下文分级、DAG 调度、共识评估、Per-Expert Engine、SSE 事件
category: coding-assistant
tags: [octopus, swarm, workflow, expert, debate, dispatch, review, moa, host, aggregator, dynamic, consensus, DAG, multi-agent, per-expert-engine]
---

# Swarm 专家团开发助手

`type: swarm` 是 Octopus 工作流的第 7 种节点类型，实现多专家协作编排：N 个 LLM "专家" 以不同角色/视角围绕同一主题协同工作，由 Host Agent 综合最终输出。

> 本文档专注 swarm 节点开发。通用工作流语法（变量、表达式、depends_on、hooks）参见 `octo-workflow-dev` skill。

---

## 0. 资源发现 — 选择专家前先查询

Swarm 节点的专家应优先使用**本机已安装的 agents 资源**，不要凭记忆硬编码角色名。

**查询已安装 agents：**

```bash
node -e "
const d=JSON.parse(require('fs').readFileSync(
  require('os').homedir()+'/.octopus/resources/registry.json','utf8'));
d.resources.filter(r=>r.installed&&r.type==='agent')
  .forEach(r=>console.log(r.group+'/'+r.name+' → '+r.installPath+'/'+r.name+'.md'))
"
```

**按 group 分类：**

| Group | 说明 | 适合场景 |
|-------|------|---------|
| `agency-agents-zh` | 215+ 中文角色卡 | review/debate/dispatch 各类型专家 |
| `gstack` | YC 工程团队角色 | CEO 审查、安全、QA 等 |
| `built-in` | Octopus 内置 | devil-advocate、vision-analyzer 等 |

**角色匹配策略：**

1. **review 模式** — 按审查维度选专家（security-engineer / performance-engineer / code-reviewer）
2. **debate 模式** — 按利益相关方选专家（product-manager / backend-engineer / sre-engineer）
3. **dispatch 模式** — 按任务分工选专家（api-designer / frontend-dev / qa-engineer）
4. **swarm (dynamic) 模式** — Router 自动从角色库选择，无需手动指定

---

## 0.1 何时使用 Swarm

| 场景 | 推荐模式 | 原因 |
|------|---------|------|
| 代码审查、安全审计 | **review** | 多视角并行审查，1 轮即可 |
| 技术选型、架构决策 | **debate** | 需要多轮讨论收敛分歧 |
| 全栈功能开发、多步骤任务 | **dispatch** | 任务有依赖关系，需要 DAG 调度 |
| 开放式问题、故障诊断 | **swarm** | Router 自动选择模式和专家 |
| 多模型综合分析、跨 Provider | **moa** | Fan-out + Aggregator，可混合不同 AI 引擎 |

**不要用 swarm 的场景**：

- 单专家就能完成的任务 → 用 `type: agent`
- 确定性脚本 → 用 `type: bash` / `type: python`
- 需要人工审批 → 用 `type: approval`

---

## 1. 五种模式

### 1.1 Review — 并行审查

所有专家同时执行 1 轮，Host 综合为最终报告。无轮次循环，无共识检查。

```yaml
- id: audit
  type: swarm
  topic: "审查以下 API 端点的安全性: $vars.api_spec"
  mode: review
  output_format: structured
  experts:
    - role: security-engineer
      perspective: "专注于注入漏洞和认证绕过"
      prompt: "逐行审查代码中的安全隐患"
    - role: performance-engineer
      perspective: "专注于 N+1 查询和内存泄漏"
      prompt: "审查性能影响"
```

**适用**：代码审查、文档校对、安全扫描、合规检查。

### 1.2 Debate — 多轮辩论

多轮讨论，每轮结束后 Host 评估共识分数。达到阈值或 Host 判断无需继续时提前终止。

```yaml
- id: decision
  type: swarm
  topic: "数据库迁移策略: Vitess vs Citus vs 应用层分库分表"
  mode: debate
  rounds: 5
  consensus_threshold: 0.85
  experts:
    - role: dba-architect
      perspective: "数据一致性和分片策略"
      prompt: "评估三个方案的分片键设计和迁移方案"
    - role: backend-engineer
      perspective: "应用层改动量和团队学习成本"
      prompt: "评估 ORM 兼容性和团队上手时间"
    - role: sre-engineer
      perspective: "运维复杂度和故障恢复能力"
      prompt: "评估 K8s Operator 成熟度和监控集成"
```

**共识评估机制**：

```
每轮结束 → Host 评估 consensus_score (0.0-1.0) + should_continue
  score >= threshold → 提前终止
  should_continue = false → 提前终止
  否则 → 下一轮（专家能看到所有前轮发言）
```

**适用**：技术选型、架构决策、方案对比、需求优先级排序。

### 1.3 Dispatch — DAG 调度执行

专家按依赖关系组成 DAG，按层级顺序执行，层内并行。上游产出注入下游 prompt。

```yaml
- id: implement
  type: swarm
  topic: "实现用户仪表盘功能: $vars.feature_spec"
  mode: dispatch
  failure_policy: fail_fast
  experts:
    - role: backend-architect
      task: "设计并实现 API 层"
      tools: [Read, Write, Edit, Bash, Grep]
    - role: frontend-developer
      task: "实现前端组件"
      depends_on: [backend-architect]
      tools: [Read, Write, Edit, Grep]
    - role: code-reviewer
      task: "审查所有变更"
      depends_on: [backend-architect, frontend-developer]
```

**DAG 执行**：

```
Level 0: [backend-architect]           ← 无依赖，先执行
Level 1: [frontend-developer]          ← 等 L0 完成
Level 2: [code-reviewer]              ← 等 L0+L1 完成
```

**上下文传递**：

- 直接依赖 (depends_on): 结构化摘要 + 前 N 字详情
- 间接上游: 仅结构化摘要
- 每个专家输出末尾需附带 ````summary` JSON 块供下游消费

**适用**：全栈开发、多步骤文档生成、流水线任务。

### 1.4 Swarm (动态) — Router 自动编排

Router 从**已安装的 agents 资源库**中自动选择专家和模式。适合开放式问题。

```yaml
- id: investigate
  type: swarm
  topic: "生产环境 P0 故障诊断: $vars.incident_context"
  mode: swarm
  dynamic: true
  max_experts: 5
  budget: 200000
  expert_defaults:
    model: se
```

**Router 2 阶段选择**：

1. 关键词预筛: topic 分词 → 匹配已安装 agents 的 name/description → top 30 候选
2. LLM 选择: se 模型从候选中选 2-5 专家 + 决定模式

### 1.5 MOA — Mixture of Agents

多专家并行 Fan-out，由专门的 **Aggregator** 聚合所有输出。支持 Per-Expert Engine（跨 Provider），适合需要多模型交叉验证的场景。

```yaml
- id: cross-model-analysis
  type: swarm
  topic: "评估微服务拆分方案: $vars.architecture_spec"
  mode: moa
  rounds: 2                              # 0-5 轮，0 = 仅 Fan-out + Aggregator
  timeout: 300
  experts:
    - role: architect
      engine: claude                     # Claude 引擎
      model: pro-max
      prompt: "从系统架构角度评估拆分方案"
    - role: cost-analyst
      engine: pi                         # Pi 引擎 (Qwen/GLM)
      model: pro-max
      prompt: "从成本与 ROI 角度评估"
    - role: devops
      engine: claude
      model: pro
      prompt: "从运维与部署复杂度评估"
  aggregator:
    role: moa-aggregator
    model: pro-max
    prompt: |
      综合以上多位专家的分析，生成一份统一评估报告。
      标注各专家共识点和分歧点，给出最终建议。
```

**MOA 执行流程**：

```
Fan-out: 所有专家并行执行（可跨 Provider）
  ↓
Aggregator: 收集所有专家输出，综合为统一报告
  ↓
(可选) 多轮: rounds > 0 时，专家可看到 Aggregator 反馈后再次执行
```

**与 review 模式区别**：

| 对比项 | review | moa |
|--------|--------|-----|
| 综合者 | Host（内置） | Aggregator（显式定义） |
| 跨 Provider | ❌ | ✅ Per-Expert Engine |
| 轮次 | 固定 1 轮 | 0-5 轮 |
| 适用 | 同模型多视角 | 多模型交叉验证 |

**约束**：`mode: moa` 必须提供 `aggregator` 字段，`experts` ≥ 2，`rounds` 范围 0-5。

---

## 2. ExpertDef — 专家定义

```yaml
experts:
  - role: expert-name              # 必需 — 角色标识
    agent_file: "~/.octopus/resources/installed/agents/{group}/{name}/{name}.md"  # 已安装资源路径（可选）
    prompt: "内联指令"              # 内联 prompt（可选，与 agent_file 至少有一个）
    perspective: "视角角度"          # 注入 prompt 的视角描述
    task: "具体任务"                # [dispatch] 任务描述
    depends_on: [other-expert]      # [dispatch] 依赖的其他专家 role
    tools: [Read, Write, Bash]      # 允许的工具
    disallowed_tools: [Edit]        # 禁止的工具
    model: pro                    # 模型覆盖
    engine: claude                # AI provider 引擎（可选，优先级：expert > node > workflow > "claude"）

# [moa] 专用 — Aggregator 定义（与 experts 同级）
aggregator:
  role: moa-aggregator          # Aggregator 角色标识
  model: pro-max                # 聚合器推荐用强模型
  prompt: "综合所有专家输出..."   # 聚合指令
  engine: claude                # 聚合器引擎
```

**Expert 优先级**：expert 字段 > expert_defaults > 引擎默认值。

### 复用已安装资源

```yaml
experts:
  - role: product-manager
    agent_file: "~/.octopus/resources/installed/agents/agency-agents-zh/product-manager/product-manager.md"
    perspective: "关注用户留存和付费转化"
  - role: devil-advocate
    agent_file: "~/.octopus/resources/installed/agents/built-in/devil-advocate/devil-advocate.md"
    perspective: "质疑所有假设"
```

> `agent_file` 路径 = `{installPath}/{name}.md`。通过 §0 资源发现查询获取。

### 跨 Provider 专家（Per-Expert Engine）

每个专家可以指定不同的 AI provider，实现跨 provider MOA：

```yaml
experts:
  - role: architect
    engine: claude        # 使用 Claude Opus
    model: pro-max
    prompt: "系统架构分析"
  - role: cost-analyst
    engine: pi            # 使用 Pi provider (Qwen/GLM)
    model: pro-max
    prompt: "成本与 ROI 分析"
  - role: devops
    engine: claude        # 可以混用
    model: pro
    prompt: "运维与部署评估"
```

**Engine 优先级**：`expert.engine` → `node.engine` → `workflow.engine` → `"claude"`。

---

## 3. Host — 综合者

Host 是 swarm 内置的综合角色，在所有专家完成后生成最终报告。

```yaml
host:
  role: host-moderator
  model: pro                           # 默认 pro-max
  prompt: |                            # 自定义综合指令（替换内置 prompt）
    你是产品设计讨论主持人。
    提炼各方观点中的交集和分歧，
    最终综合为一份功能清单。
  perspective: "平衡技术可行性与商业价值"
```

**降级链**：`host.model ?? pro-max → pro → 拼接兜底 (degraded: true)`

**不声明 host** → 引擎用内置默认 prompt：
- review: "Provide a comprehensive synthesis"
- debate: "Assess consensus (score 0-1) + should_continue"
- dispatch: "Integrate all expert outputs"
- moa: 使用 `aggregator.prompt`（aggregator 替代 host 做综合）

**自定义 host.prompt** 完全替换内置指令，适合需要特定综合风格的场景。

---

## 4. 上下文管理

### 4.1 Context Tier — 按模型能力分级

```yaml
context_tier: "200k"    # 默认 — 标准模型
context_tier: "1m"      # 大上下文模型 — 参数 4× 缩放
```

| 参数 | 200k | 1m |
|------|------|------|
| 讨论 token 预算 | 60K | 240K |
| 压缩输入上限 | 20K chars | 80K chars |
| 上游详情上限 | 3K chars | 12K chars |
| head+tail 触发 | 2.5K chars | 10K chars |

### 4.2 滑动窗口 + 渐进压缩 (debate 模式)

```yaml
context_window_rounds: 2      # 保留最近 2 轮全文（默认）
context_token_budget: 60000   # 上下文 token 预算（默认，按 tier 缩放）
```

- 最近 N 轮: 全文保留
- 更早轮次: LLM (se) 压缩为摘要
- 超预算: 紧急截断，仅保留最近 1 轮 + 所有摘要

---

## 5. 自动输出 (VarPool)

Swarm 执行完毕后自动写入以下变量（`{id}` = 节点 id）：

| 变量 | 类型 | 说明 |
|------|------|------|
| `{id}_synthesis` | string | Host 综合报告 |
| `{id}_consensus_score` | number/null | 共识分数 (debate) |
| `{id}_rounds_used` | number | 实际使用轮次 |
| `{id}_expert_count` | number | 参与的专家数 |
| `{id}_experts` | string(JSON) | 专家角色 JSON 数组 |
| `{id}_history` | string(JSON) | 完整消息历史 |
| `{id}_task_breakdown` | string(JSON) | 任务分解 (dispatch/swarm) |
| `{id}_budget_exhausted` | boolean | 预算是否耗尽 |
| `{id}_timeout_exceeded` | boolean | 是否超时 |

引用方式：

```yaml
- id: report
  type: bash
  depends_on: [audit]
  bash: |
    echo "综合: $vars.audit_synthesis"
    echo "共识: $vars.audit_consensus_score"
```

---

## 6. 完整示例

### 6.1 Review — 代码安全审计

```yaml
apiVersion: octopus/v1
kind: Workflow
name: "security-audit"

variables:
  code_changes: |
    POST /api/orders — 见 docs/api-spec.md

nodes:
  - id: audit
    type: swarm
    topic: "审查以下代码变更的安全性:\n$vars.code_changes"
    mode: review
    output_format: structured
    expert_defaults:
      model: se
    experts:
      - role: sql-injection-hunter
        perspective: "专注于 SQL 注入漏洞"
        prompt: "逐行审查数据库查询，标注注入风险"
      - role: auth-reviewer
        perspective: "专注于认证和授权"
        prompt: "审查 token 验证和越权风险"
      - role: input-validator
        perspective: "专注于输入验证"
        prompt: "审查字段类型检查和边界值"

  - id: report
    type: bash
    depends_on: [audit]
    bash: |
      echo "审计完成: $vars.audit_expert_count 位专家"
      cat << 'SWARM_EOF'
      $vars.audit_synthesis
      SWARM_EOF
```

### 6.2 Debate — 技术决策（自定义 Host）

```yaml
- id: tech-decision
  type: swarm
  topic: "前端框架选型: React vs Vue vs Svelte"
  mode: debate
  rounds: 3
  consensus_threshold: 0.75
  host:
    role: host-moderator
    model: pro
    prompt: |
      你是技术选型讨论主持人。
      每轮结束后提炼各方核心论点和分歧点，
      指出哪些论点有数据支撑、哪些是主观偏好。
      最终给出一份对比表格和推荐方案。
    perspective: "关注团队现有技能和长期维护成本"
  experts:
    - role: frontend-lead
      perspective: "开发效率和生态成熟度"
      prompt: "评估三个框架的学习曲线和社区生态"
    - role: performance-engineer
      perspective: "运行时性能和包体积"
      prompt: "对比三个框架的性能基准测试数据"
    - role: hiring-manager
      perspective: "人才招聘难度"
      prompt: "评估市场上三个框架的开发者供给"
```

### 6.3 Dispatch — 全栈开发

```yaml
- id: build-feature
  type: swarm
  topic: "实现用户通知功能: $vars.feature_spec"
  mode: dispatch
  failure_policy: continue_partial
  context_tier: "1m"
  experts:
    - role: api-designer
      task: "设计 REST API 端点和数据模型"
      tools: [Read, Write, Bash]
    - role: backend-dev
      task: "实现 API 和数据库迁移"
      depends_on: [api-designer]
      tools: [Read, Write, Edit, Bash, Grep]
    - role: frontend-dev
      task: "实现通知 UI 组件"
      depends_on: [api-designer]
      tools: [Read, Write, Edit, Grep]
    - role: qa-engineer
      task: "编写 E2E 测试"
      depends_on: [backend-dev, frontend-dev]
      tools: [Read, Write, Bash]
```

### 6.4 Swarm — 动态故障诊断

```yaml
- id: diagnose
  type: swarm
  topic: "生产故障诊断:\n$vars.incident_report"
  mode: swarm
  dynamic: true
  max_experts: 5
  budget: 200000
  timeout: 600
  expert_defaults:
    model: se
```

### 6.5 MOA — 跨 Provider 多模型分析

```yaml
apiVersion: octopus/v1
kind: Workflow
name: "cross-provider-review"

variables:
  proposal: |
    见 docs/migration-proposal.md

nodes:
  - id: moa-review
    type: swarm
    topic: "评审数据库迁移方案:\n$vars.proposal"
    mode: moa
    rounds: 1
    timeout: 300
    experts:
      - role: claude-architect
        engine: claude
        model: pro-max
        prompt: "从架构可扩展性角度评审方案"
      - role: qwen-analyst
        engine: pi
        model: pro-max
        prompt: "从成本效益和风险评估方案"
      - role: glm-reviewer
        engine: pi
        model: pro
        prompt: "从运维可行性和团队能力匹配度评审"
    aggregator:
      role: synthesis-lead
      model: pro-max
      prompt: |
        你收到三位来自不同 AI 引擎的专家评审意见。
        请综合为一份统一评审报告：
        1. 共识点（≥2 位专家同意）
        2. 分歧点（各引擎视角差异）
        3. 最终建议（Go / No-Go / Conditional）

  - id: report
    type: bash
    depends_on: [moa-review]
    bash: |
      echo "MOA 完成: $vars.moa-review_expert_count 位专家, $vars.moa-review_rounds_used 轮"
      cat << 'SWARM_EOF'
      $vars.moa-review_synthesis
      SWARM_EOF
```

---

## 7. 最佳实践

### ✅ 推荐

- **Review 模式用 se** — 审查任务不需要强推理，se 足够且成本低
- **Debate 模式用高 consensus_threshold** — 0.75-0.85 确保充分讨论
- **Dispatch 模式明确 depends_on** — DAG 调度依赖显式声明
- **给 Host 写自定义 prompt** — 指导综合风格和输出格式
- **大模型用 context_tier: 1m** — 充分利用大上下文窗口
- **动态模式设 budget** — 防止 Router 选太多专家导致 token 爆炸
- **bash 报告节点用 heredoc** — `cat << 'EOF'` 安全输出大段合成内容

### ❌ 避免

- **不要在 bash 里 echo `$vars.xxx_synthesis`** — 变量内容含 shell 特殊字符会崩溃
- **不要给 review 模式设 rounds** — 固定 1 轮，rounds 被忽略
- **不要在 dispatch 模式漏掉 depends_on** — 没有依赖关系的专家全部并行，可能不符合预期
- **不要让专家输出过长** — dispatch 模式下上游详情会被截断，要求专家附 ````summary` 块
- **不要在 debate 模式设过低 consensus_threshold** — < 0.5 等于不讨论

---

## 7.5 Swarm 生命周期 Hooks

Swarm 节点有独立的生命周期事件，可在 workflow `hooks` 中监听：

| 事件 | 触发时机 | Hook 上下文变量 |
|------|---------|----------------|
| `on_swarm_start` | Swarm 节点开始执行 | `$hook.node_id`, `$hook.mode`, `$hook.expert_count`, `$hook.topic` |
| `on_expert_spawn` | 专家实例启动 | `$hook.node_id`, `$hook.expert_role` |
| `on_expert_complete` | 专家执行完成 | `$hook.node_id`, `$hook.expert_role`, `$hook.status`, `$hook.duration_ms` |
| `on_swarm_round_end` | debate 一轮结束 | `$hook.node_id`, `$hook.round`, `$hook.expert_count` |
| `on_swarm_consensus` | 共识评估完成 | `$hook.node_id`, `$hook.consensus_score`, `$hook.should_continue` |
| `on_swarm_complete` | Swarm 全部完成 | `$hook.node_id`, `$hook.status`, `$hook.synthesis_preview`, `$hook.rounds_used` |

```yaml
hooks:
  on_swarm_complete:
    - id: notify-swarm-done
      type: notify
      channel: default
      template:
        severity: info
        title: "🐙 Swarm 完成"
        body: |
          模式: $hook.mode
          轮次: $hook.rounds_used
          摘要: $hook.synthesis_preview
```

---

## 8. Schema 参考

完整字段定义见 `workflow-schema.json` 中的 `ExpertDef` 和 `Node` 定义。

```bash
# 校验工作流
octopus workflow validate ./my-swarm.yaml
```

| 字段 | review | debate | dispatch | swarm | moa |
|------|--------|--------|----------|-------|-----|
| `topic` | ✅ 必需 | ✅ 必需 | ✅ 必需 | ✅ 必需 | ✅ 必需 |
| `mode` | ✅ 必需 | ✅ 必需 | ✅ 必需 | ✅ 必需 | ✅ 必需 |
| `experts` | ≥1 | ≥2 | ≥1 | 可选 (dynamic) | ≥2 |
| `aggregator` | 忽略 | 忽略 | 忽略 | 忽略 | ✅ 必需 |
| `rounds` | 忽略 | ✅ (≥1) | 忽略 | 忽略 | ✅ (0-5) |
| `consensus_threshold` | 忽略 | ✅ | 忽略 | 忽略 | 忽略 |
| `depends_on` (专家级) | 忽略 | 忽略 | ✅ | 按 Router 决定 | 忽略 |
| `dynamic` | 可选 | 可选 | 可选 | ✅ 推荐 | 可选 |
| `max_experts` | dynamic 时必需 | dynamic 时必需 | dynamic 时必需 | dynamic 时必需 | dynamic 时必需 |
| `failure_policy` 默认 | continue_partial | continue_partial | fail_fast | 按 Router 决定 | continue_partial |
| Per-Expert `engine` | 可选 | 可选 | 可选 | 可选 | ✅ 推荐 |
