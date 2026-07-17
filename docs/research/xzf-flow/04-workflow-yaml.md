# XZF Development Pipeline — Workflow YAML 设计

> **版本**: v2.1.0-draft
> **日期**: 2026-07-17
> **状态**: 设计中（基于引擎实际能力重写）

## 1. 概述

完整 YAML 路径: `packages/core-pack/workflows/xzf-pipeline.yaml`

### 设计原则

- **显式决策**: 所有 approval 节点无 auto_answers，用户深度参与
- **Workspace 感知**: 多仓库 workspace，跨项目服务链
- **引擎对齐**: 所有节点用法严格匹配 Octopus 引擎实际能力

### 编排原则

- **Prompt = 编排**: workflow 中的 prompt 只负责输入/输出路径和执行顺序
- **Skill = 方法论**: 具体执行方法、输出格式、处理逻辑在 skill 中定义
- **Agent File = 角色**: 专家身份、专业视角、沟通风格在 agent file 中定义
- **Swarm 例外**: swarm 节点不支持 skills，topic 需要同时包含编排和方法论

### 阶段总览

| # | 阶段 | 节点类型 | 退出机制 |
|---|------|---------|---------|
| 0 | 初始化 | agent (skill: octo-xzf-init) | 顺序执行 |
| 1 | Idea + Research | agent (skill: octo-xzf-research) | 顺序执行 |
| 2 | 澄清循环 | loop → swarm(debate) + approval | break_when 检查 approval decision |
| 3 | 故事总汇 | loop → swarm(debate) + approval | break_when 检查 approval decision |
| 4 | Spec 设计 | swarm(debate) + approval | 用户选择 proceed |
| 5 | 任务计划 | loop → swarm(dispatch) | $iteration 计数 + break_when |
| 6 | 任务执行 | loop → agent + verify-fix | $iteration + break_when + 失败中断 |
| 7 | Ship 交付 | agent + bash + approval | 顺序执行 |

### 引擎能力参考

| 节点 | 关键字段 | 说明 |
|------|---------|------|
| **loop** | `break_when`, `while`, `max_iterations`, `nodes` | 无 `items`/`exit_condition`，用 `break_when` 退出 |
| **approval** | `prompt`, `options`, `outputs`, `approval_timeout` | 无 `auto_answers`，输出 `decision` + `comment` |
| **swarm** | `topic`, `mode`, `experts`, `host`, `outputs` | 无 `skills`（需 Phase 1 代码变更） |
| **condition** | `cases: [{when, then}]` | 匹配后 `jumpTo` 目标节点，跳过中间节点 |
| **agent** | `prompt`, `skills`, `context`, `outputs` | 支持 skills，`vars_update` JSON 设变量 |
| **bash** | `command`, `outputs` | 执行 shell 命令 |
| **所有节点** | `execute_when`, `depends_on`, `outputs` | `execute_when` 跳过时不级联下游 |

### Idea 文件格式

用户在运行流水线前，将 Idea 写入 `.octopus/xzf/{branch}/01-idea.md`：

```markdown
# Idea
## 需求描述
{原始需求}
## Research 指引（可选）
{特定研究方向，不填则 agent 自行判断}
```

## 2. 完整 Workflow YAML

```yaml
# ============================================================
# XZF Development Pipeline
# Idea → PR/MR 完整开发流水线
# ============================================================

name: xzf-pipeline
description: |
  从 Idea 到 PR/MR 的端到端开发流水线。
  6 位专家（架构师、产品经理、测试架构师、前端、后端、安全）通过
  swarm debate 进行多轮讨论，故事驱动迭代，验证先行。
version: 1.0.0

# --- 全局配置 ---
engine: claude
model: pro
timeout: 86400          # 全局超时 24h

# --- 变量 ---
variables:
  branch: ""
  workspace_topology: ""
  user_decision: ""
  spec_count: "0"
  current_spec_index: "0"
  task_count: "0"
  current_task_index: "0"
  verify_passed: "false"
  fix_attempts: "0"

# --- 通知 ---
notify:
  on_failure:
    channel: xzf_hermes
    message: "[xzf-pipeline] 执行失败: $failed_node_id — $vars.branch"
  on_complete:
    channel: xzf_hermes
    message: "[xzf-pipeline] 完成: $vars.branch — PR/MR 已提交"

# ============================================================
# Stage 0: 初始化（单 agent 节点）
# ============================================================

nodes:
  - id: init
    type: agent
    context: new
    skills:
      - octo-xzf-init
    prompt: |
      使用 octo-xzf-init skill 初始化工作环境。
      汇报：分支名、remote 类型、workspace 项目数。

# ============================================================
# Stage 1: Idea 处理 + Codebase 研究
# ============================================================

  # --- Stage 1: Idea 处理 + Codebase 研究 ---
  - id: idea
    type: agent
    depends_on: [init]
    context: new
    skills:
      - octo-xzf-research
    prompt: |
      使用 octo-xzf-research skill 处理 Idea 并研究 codebase。

      输入:
      - Idea: .octopus/xzf/$vars.branch/01-idea.md
      - Workspace: .octopus/xzf/$vars.branch/workspace-topology.md

      输出:
      - .octopus/xzf/$vars.branch/02-research/index.md
      - .octopus/xzf/$vars.branch/02-research/{domain}.md

      ⚠️ 如 01-idea.md 包含 Research 指引，优先处理指引中的方向。
      完成后汇报: 研究领域数量和关键发现摘要。

# ============================================================
# Stage 2: 需求澄清循环
# ============================================================

  - id: clarification-loop
    type: loop
    depends_on: [idea]
    max_iterations: 10
    break_when: '$vars.user_decision == "proceed"'
    nodes:

      # --- 2a. 专家团头脑风暴 ---
      - id: brainstorm
        type: swarm
        mode: debate
        rounds: 2
        context_tier: "200k"
        topic: |
          ═══ 需求澄清 — Round $iteration ═══

          输入:
          - Idea: .octopus/xzf/$vars.branch/01-idea.md
          - Research 知识: .octopus/xzf/$vars.branch/02-research/index.md
          - Workspace: .octopus/xzf/$vars.branch/workspace-topology.md

          用户上轮回复:
          $brainstorm-approval.output.comment

          输出: .octopus/xzf/$vars.branch/03-clarification/questions.md

          ⚠️ 根据用户上轮回复更新问题清单（已回答 ✅ / 待澄清 ❓）。
          问题分类：功能 / 环境 / 测试 / 调研。
          每个问题提供 2-3 种方案，第 1 个为推荐。
        experts:
          - role: senior-architect
            agent_file: .claude/agents/octo-xzf-architect.md
          - role: product-manager
            agent_file: .claude/agents/octo-xzf-product-manager.md
          - role: test-architect
            agent_file: .claude/agents/octo-xzf-test-architect.md
          - role: frontend-expert
            agent_file: .claude/agents/octo-xzf-frontend-expert.md
          - role: backend-expert
            agent_file: .claude/agents/octo-xzf-backend-expert.md
          - role: security-expert
            agent_file: .claude/agents/octo-xzf-security-expert.md
        host:
          role: clarify-host
          prompt: |
            综合专家意见。

            输出两部分：
            1. 将完整问题清单写入 questions.md（含已回答 ✅ + 待澄清 ❓）
            2. 在综合输出中仅列出本轮需要用户回答的待澄清问题
               格式：编号 + 问题 + 推荐方案 + 备选方案

      # --- 2b. 用户审批（内联显示待澄清问题） ---
      - id: brainstorm-approval
        type: approval
        depends_on: [brainstorm]
        prompt: |
          ═══ 需求澄清 — Round $iteration ═══

          📁 完整文档: .octopus/xzf/$vars.branch/03-clarification/questions.md

          ─── 本轮需要澄清的问题 ───

          $brainstorm_synthesis

          ─────────────────────────
          请在评论中回答问题。
          如部分问题未回答但选择"进入下一阶段"，将采用专家推荐方案。
        options:
          - label: "回答并继续讨论"
            value: "continue"
          - label: "回答并进入下一阶段"
            value: "proceed"
          - label: "补充新的讨论话题"
            value: "add-topics"
        outputs:
          $vars.user_decision: "$last_output"

# ============================================================
# Stage 3: 故事总汇循环
# ============================================================

  - id: stories-loop
    type: loop
    depends_on: [clarification-loop]
    max_iterations: 5
    break_when: '$vars.user_decision == "proceed"'
    nodes:

      # --- 3a. 生成用户故事 ---
      - id: story-generation
        type: swarm
        mode: debate
        rounds: 2
        context_tier: "200k"
        topic: |
          ═══ 用户故事总汇 — Round $iteration ═══

          输入:
          - Idea: .octopus/xzf/$vars.branch/01-idea.md
          - Research 知识: .octopus/xzf/$vars.branch/02-research/index.md
          - 澄清文档: .octopus/xzf/$vars.branch/03-clarification/questions.md
          - Workspace: .octopus/xzf/$vars.branch/workspace-topology.md

          用户上轮反馈:
          $story-approval.output.comment

          输出:
          - .octopus/xzf/$vars.branch/04-stories/summary.md
          - .octopus/xzf/$vars.branch/04-stories/technical-guide.md

          ⚠️ 每个故事标注 SERVICE_CHAIN。
          格式：角色 / 目标 / 服务链 / 路径 / 完成标准。
        experts:
          - role: senior-architect
            agent_file: .claude/agents/octo-xzf-architect.md
          - role: product-manager
            agent_file: .claude/agents/octo-xzf-product-manager.md
          - role: test-architect
            agent_file: .claude/agents/octo-xzf-test-architect.md
          - role: frontend-expert
            agent_file: .claude/agents/octo-xzf-frontend-expert.md
          - role: backend-expert
            agent_file: .claude/agents/octo-xzf-backend-expert.md
          - role: security-expert
            agent_file: .claude/agents/octo-xzf-security-expert.md
        host:
          role: story-host
          prompt: |
            综合专家意见，生成完整用户故事总汇文档和技术指导文档。
            写入 04-stories/ 目录下两个文件。

            在综合输出里列出故事摘要列表：
            每个故事一行：编号 + 标题 + 角色 + 服务链

      # --- 3b. 用户审批（内联显示故事摘要） ---
      - id: story-approval
        type: approval
        depends_on: [story-generation]
        prompt: |
          ═══ 用户故事总汇 — Round $iteration ═══

          📁 完整文档:
          - .octopus/xzf/$vars.branch/04-stories/summary.md
          - .octopus/xzf/$vars.branch/04-stories/technical-guide.md

          ─── 故事摘要 ───

          $story-generation_synthesis

          ─────────────────
          如满意，进入 Spec 设计阶段。
          如需修改，请在评论中说明。
        options:
          - label: "满意，进入 Spec 设计"
            value: "proceed"
          - label: "需要修改"
            value: "continue"
        outputs:
          $vars.user_decision: "$last_output"

# ============================================================
# Stage 4: Spec 设计
# ============================================================

  # --- 4a. 专家团拆分 Spec ---
  - id: spec-design
    type: swarm
    depends_on: [stories-loop]
    mode: debate
    rounds: 3
    consensus_threshold: 0.7
    context_tier: "200k"
    topic: |
      ═══ Spec 设计 ═══

      输入:
      - Idea: .octopus/xzf/$vars.branch/01-idea.md
      - Research 知识: .octopus/xzf/$vars.branch/02-research/index.md
      - 故事总汇: .octopus/xzf/$vars.branch/04-stories/summary.md
      - 技术指导: .octopus/xzf/$vars.branch/04-stories/technical-guide.md
      - Workspace: .octopus/xzf/$vars.branch/workspace-topology.md

      输出: .octopus/xzf/$vars.branch/05-specs/spec-NNN-{name}.md

      ⚠️ 拆分原则：从简单到复杂、首 Spec 含基础底座、每 Spec 可独立交付、松耦合。
      Spec DSL 格式参见 octo-xzf-spec-designer skill。
    experts:
      - role: senior-architect
        agent_file: .claude/agents/octo-xzf-architect.md
      - role: product-manager
        agent_file: .claude/agents/octo-xzf-product-manager.md
      - role: test-architect
        agent_file: .claude/agents/octo-xzf-test-architect.md
      - role: frontend-expert
        agent_file: .claude/agents/octo-xzf-frontend-expert.md
      - role: backend-expert
        agent_file: .claude/agents/octo-xzf-backend-expert.md
      - role: security-expert
        agent_file: .claude/agents/octo-xzf-security-expert.md
    host:
      role: spec-host
      prompt: |
        综合专家意见，确定 Spec 拆分方案。
        写入各 spec 文件到 05-specs/ 目录。
        最终输出 vars_update JSON 包含 spec_count 和 spec_list。

  # --- 4b. 确认 Spec 设计 ---
  - id: spec-confirm
    type: approval
    depends_on: [spec-design]
    prompt: |
      ═══ Spec 设计完成 ═══

      共 $vars.spec_count 个 Spec:
      $vars.spec_list

      请查看 .octopus/xzf/$vars.branch/05-specs/ 目录下的 Spec 文件。

      确认拆分方案后进入任务计划阶段。
    options:
      - label: "确认，进入任务计划"
        value: "proceed"
      - label: "需要调整 Spec"
        value: "revise"
    outputs:
      $vars.user_decision: "$last_output"
      $vars.spec_feedback: "$comment"

# ============================================================
# Stage 5: 任务计划（per spec 循环）
# ============================================================

  - id: task-planning-loop
    type: loop
    depends_on: [spec-confirm]
    max_iterations: 20    # 最多 20 个 spec
    break_when: '$iteration > $vars.spec_count'
    nodes:

      # --- 5a. 为当前 spec 生成任务计划 ---
      - id: plan-spec
        type: swarm
        mode: dispatch
        context_tier: "200k"
        topic: |
          ═══ 任务计划 — Spec #$iteration ═══

          请读取 Spec 文件:
          .octopus/xzf/$vars.branch/05-specs/ 目录下第 $iteration 个 spec

          Research 知识: 请读取 .octopus/xzf/$vars.branch/02-research/index.md 并根据话题读取对应领域文件
          Workspace 拓扑: 请读取 .octopus/xzf/$vars.branch/workspace-topology.md

          任务: 为这个 Spec 生成完整的任务计划，包含 4 类文档:

          1. **consensus.md** — 总纲领
             - 涉及项目 + 各项目职责
             - DB 变更 (per project)
             - 文件变更 (per project)
             - 共用约定 + 项目间接口契约
             - 并行开发边界

          2. **verify-X-Y.md** — 验证方法
             - 验证目标
             - 验证代码示例（单元/集成/E2E）
             - 通过标准

          3. **task-X-Y-{project}-{role}.md** — 任务分配
             - X = 任务号（相同 X 可并行）
             - Y = 子任务号
             - project = 所属项目
             - role = 角色（backend/frontend/等）
             - 包含: 项目、任务描述、依赖、实现步骤、涉及文件

          4. **spec-test.md** — 完整 E2E 验证路线
             - 前置条件（服务启动、DB 连接、测试数据）
             - 逐步执行步骤 + 预期结果
             - 截图/DB 验证要求

          输出目录:
          .octopus/xzf/$vars.branch/06-plans/spec-{NNN}-{name}/
        experts:
          - role: senior-architect
            agent_file: .claude/agents/octo-xzf-architect.md
            task: "制定技术总纲领 consensus.md，确定文件变更和接口契约"
          - role: test-architect
            agent_file: .claude/agents/octo-xzf-test-architect.md
            task: "设计验证方法 verify-*.md 和 E2E 测试路线 spec-test.md"
            depends_on: [senior-architect]
          - role: frontend-expert
            agent_file: .claude/agents/octo-xzf-frontend-expert.md
            task: "前端任务拆解 task-*-frontend.md"
            depends_on: [senior-architect]
          - role: backend-expert
            agent_file: .claude/agents/octo-xzf-backend-expert.md
            task: "后端任务拆解 task-*-backend.md"
            depends_on: [senior-architect]
          - role: security-expert
            agent_file: .claude/agents/octo-xzf-security-expert.md
            task: "审查安全相关任务，补充安全验证项"
            depends_on: [senior-architect, test-architect]
        host:
          role: plan-host
          prompt: |
            综合各专家输出，确保:
            1. consensus.md 中接口契约一致
            2. verify 和 task 编号对齐
            3. spec-test.md 覆盖完整故事线
            写入 06-plans/ 目录。

# ============================================================
# Stage 6: 任务执行（per spec → per task 循环）
# ============================================================

  - id: execution-loop
    type: loop
    depends_on: [task-planning-loop]
    max_iterations: 20    # 最多 20 个 spec
    break_when: '$iteration > $vars.spec_count'
    nodes:

      # --- 6a. 执行当前 spec 的所有 task ---
      - id: execute-spec-tasks
        type: agent
        context: new
        skills:
          - octo-xzf-executor
        prompt: |
          使用 octo-xzf-executor skill 执行 Spec #$iteration。

          ═══ 执行 Spec #$iteration ═══

          请读取以下文件:
          - Spec: .octopus/xzf/$vars.branch/05-specs/ 目录下第 $iteration 个 spec
          - 任务计划: .octopus/xzf/$vars.branch/06-plans/ 目录下对应 spec 的所有 task 和 verify 文件
          - Workspace 拓扑: .octopus/xzf/$vars.branch/workspace-topology.md

          执行流程:

          ## Phase 1: Task 实现
          对每个 task-X-Y-{project}-{role}.md:
          1. 读取任务文档，理解需求
          2. 读取 consensus.md，遵守共用约定
          3. 在对应项目目录下按步骤编码实现
          4. 确保代码通过 lint 和 type check

          ## Phase 2: Task 验证（verify-fix 循环）
          对每个 verify-X-Y.md:
          - 按文档执行验证
          - 如通过 → 记录结果，继续
          - 如失败 → 分析原因，修复代码，重新验证
          - 最多重试 3 次

          ## Phase 3: Spec E2E 验证
          所有 task 验证通过后:
          - 按 spec-test.md 逐步执行 E2E 验证
          - 如全部通过 → spec 完成
          - 如失败 → 修复并重试，最多 3 次

          ## 验证结果记录
          写入 .octopus/xzf/$vars.branch/07-execution/spec-{NNN}/

          ## 保真要求
          - 不允许跳过验证
          - 不允许伪造通过
          - 必须有真实性证明（测试输出、截图、DB 查询结果）

          完成后输出:
          {"vars_update": {"spec_status": "passed"}}

          如果失败，输出:
          {"vars_update": {"spec_status": "failed", "failure_reason": "..."}}
        outputs:
          $vars.spec_status: "$last_output"

      # --- 6b. 检查执行结果 ---
      - id: check-spec-result
        type: condition
        depends_on: [execute-spec-tasks]
        cases:
          - when: '$vars.spec_status == "failed"'
            then: handle-failure
          - when: "default"
            then: spec-passed

      # --- 6c. 失败处理 ---
      - id: handle-failure
        type: agent
        context: new
        prompt: |
          ═══ Spec #$iteration 执行失败 ═══

          生成失败报告:
          .octopus/xzf/$vars.branch/08-reports/failure-{timestamp}.md

          报告内容:
          - 失败位置 (Spec/Task/Verify)
          - 失败原因详细分析
          - 已尝试的修复 (最多 3 次)
          - 现场保留 (代码 diff、日志、截图)
          - 建议的人工干预方案

          发送通知到 xzf_hermes 群。

      # --- 6d. 等待人工干预 ---
      - id: human-intervention
        type: approval
        depends_on: [handle-failure]
        approval_timeout: 86400    # 24 小时超时
        prompt: |
          ═══ 执行失败 — 等待人工干预 ═══

          Spec #$iteration 执行失败。
          请查看失败报告: .octopus/xzf/$vars.branch/08-reports/

          选择下一步操作:
        options:
          - label: "重试当前 Spec"
            value: "retry"
          - label: "跳过当前 Spec，继续下一个"
            value: "skip"
          - label: "终止流水线"
            value: "abort"
        outputs:
          $vars.user_decision: "$last_output"
          $vars.intervention_feedback: "$comment"

      # --- 6e. 处理用户干预决策 ---
      - id: intervention-router
        type: condition
        depends_on: [human-intervention]
        cases:
          - when: '$vars.user_decision == "abort"'
            then: execution-abort
          - when: '$vars.user_decision == "retry"'
            then: retry-spec
          - when: "default"
            then: spec-passed

      # --- 6f. 重试当前 spec ---
      - id: retry-spec
        type: agent
        context: new
        prompt: |
          ═══ 重试 Spec #$iteration ═══

          用户反馈: $vars.intervention_feedback

          重新执行当前 spec 的所有 task。
          参考之前的失败报告进行修复。
          （重新进入 execute-spec-tasks 的逻辑）

      # --- 6g. Spec 通过 ---
      - id: spec-passed
        type: bash
        command: |
          echo "Spec #$iteration 执行通过"

  # --- 6h. 终止执行标记 ---
  - id: execution-abort
    type: bash
    command: |
      echo "用户选择终止流水线"
      exit 1

# ============================================================
# Stage 7: Ship 交付
# ============================================================

  # --- 7a. 生成 PR/MR Summary ---
  - id: ship-summary
    type: agent
    depends_on: [execution-loop]
    context: new
    skills:
      - octo-xzf-ship
    prompt: |
      使用 octo-xzf-ship skill 生成 PR/MR Summary。

      输入:
      - Idea: .octopus/xzf/$vars.branch/01-idea.md
      - 故事: .octopus/xzf/$vars.branch/04-stories/summary.md
      - Specs: .octopus/xzf/$vars.branch/05-specs/
      - 验证结果: .octopus/xzf/$vars.branch/07-execution/

      输出: .octopus/xzf/$vars.branch/09-ship/summary.md

  # --- 7b. 检测 remote 并提交 ---
  - id: ship-submit
    type: bash
    depends_on: [ship-summary]
    command: |
      REMOTE_TYPE="$vars.remote_type"
      BRANCH="$vars.branch"
      SUMMARY=".octopus/xzf/$BRANCH/09-ship/summary.md"
      TITLE=$(head -1 "$SUMMARY" | sed 's/^# //')

      if [ "$REMOTE_TYPE" = "github" ]; then
        gh pr create --title "$TITLE" --body-file "$SUMMARY" --base main
      elif [ "$REMOTE_TYPE" = "gitlab" ]; then
        glab mr create --title "$TITLE" --description "$(cat "$SUMMARY")" --target-branch main
      else
        echo "Unknown remote type: $REMOTE_TYPE"
        echo "请手动提交 PR/MR，summary 文件位于: $SUMMARY"
      fi
    outputs:
      $vars.pr_url: "$last_output"

  # --- 7c. 确认提交 ---
  - id: ship-confirm
    type: approval
    depends_on: [ship-submit]
    prompt: |
      ═══ Ship 完成 ═══

      PR/MR: $vars.pr_url

      请确认提交结果。
    options:
      - label: "确认完成"
        value: "done"
      - label: "需要修改"
        value: "revise"
```

## 3. 变量系统

### 3.1 内置变量

| 变量 | 来源 | 说明 |
|------|------|------|
| `$iteration` | loop 节点 | 当前迭代次数（1-based） |
| `$last_output` | 所有节点 | 节点最后输出内容 |
| `$comment` | approval 节点 | 用户自由文本输入 |
| `$failed_node_id` | 引擎 | 失败节点 ID |

### 3.2 节点输出引用

| 语法 | 说明 |
|------|------|
| `$nodeId.output.decision` | approval 节点用户选择的 value |
| `$nodeId.output.comment` | approval 节点用户自由文本 |
| `$nodeId_synthesis` | swarm 节点 host 综合输出（自动写入 VarPool） |
| `$nodeId_consensus_score` | swarm 节点共识分数 |
| `$nodeId_expert_outputs` | swarm 节点各专家输出 JSON |

### 3.3 vars_update 机制

agent/swarm 节点通过在输出中包含 JSON 来设置变量:

```json
{"vars_update": {"key1": "value1", "key2": "value2"}}
```

引擎解析后写入 VarPool，后续节点可通过 `$vars.key1` 引用。

### 3.4 outputs 映射

所有节点类型都支持 `outputs` 字段:

```yaml
outputs:
  $vars.target_key: "$last_output"          # 节点输出 → 变量
  $vars.decision: "$nodeId.output.decision" # 其他节点输出 → 变量
  $vars.literal: "some value"                # 字面量
```

## 4. Approval 节点设计

### 4.1 显式决策模式

所有 approval 节点不使用 auto_answers，要求用户深度参与。

标准结构:
```yaml
- id: xxx-approval
  type: approval
  prompt: |
    ═══ 阶段标题 ═══
    [说明当前状态和需要用户做什么]
  options:
    - label: "选项 A 描述"
      value: "option_a"
    - label: "选项 B 描述"
      value: "option_b"
  outputs:
    $vars.user_decision: "$last_output"     # option value → 流程控制
    # comment 自动通过 $nodeId.output.comment 供下游引用
```

### 4.2 双通道数据流

| 通道 | 内容 | 用途 |
|------|------|------|
| `decision` ($last_output) | option value (如 "proceed"/"continue") | 流程控制 (break_when) |
| `comment` ($nodeId.output.comment) | 用户自由文本 | 内容传递 (下轮 swarm 读取) |

### 4.3 超时处理

长时间等待的 approval 节点设置 `approval_timeout`（秒）。超时后自动选择 "timeout"（走 approve 路径，非 reject）。

## 5. Loop 节点设计

### 5.1 循环退出模式

**模式 A: break_when + approval decision（澄清/故事循环）**

```yaml
- id: xxx-loop
  type: loop
  max_iterations: 10
  break_when: '$vars.user_decision == "proceed"'
  nodes:
    - id: do-work
      type: swarm
      # ...
    - id: user-approval
      type: approval
      options:
        - label: "继续"
          value: "continue"
        - label: "进入下一阶段"
          value: "proceed"
      outputs:
        $vars.user_decision: "$last_output"
```

**模式 B: $iteration 计数（遍历 spec/task）**

```yaml
- id: xxx-loop
  type: loop
  max_iterations: 20
  break_when: '$iteration > $vars.item_count'
  nodes:
    - id: process-item
      type: agent
      prompt: "处理第 $iteration 项..."
```

### 5.2 循环内变量持久化

子节点通过 `vars_update` 或 `outputs` 设置的变量跨迭代持久化。下轮 swarm 可通过 `$vars.xxx` 读取上轮结果。

## 6. Swarm 专家配置

### 6.1 Expert Skills（Phase 1 依赖）

**当前限制**: SwarmExecutor 不处理 `skills` 字段。ExpertDef skills 支持需要 Phase 1 代码变更。

代码变更完成前，专家能力通过 `agent_file` 的 body 内容承载。
代码变更完成后，可在 expert 级别配置:

```yaml
experts:
  - role: test-architect
    agent_file: .claude/agents/octo-xzf-test-architect.md
    skills:                    # Phase 1 后可用
      - octo-xzf-spec-designer
      - octo-xzf-executor
```

### 6.2 专家列表（所有 swarm 节点共用）

```yaml
experts:
  - role: senior-architect
    agent_file: .claude/agents/octo-xzf-architect.md
  - role: product-manager
    agent_file: .claude/agents/octo-xzf-product-manager.md
  - role: test-architect
    agent_file: .claude/agents/octo-xzf-test-architect.md
  - role: frontend-expert
    agent_file: .claude/agents/octo-xzf-frontend-expert.md
  - role: backend-expert
    agent_file: .claude/agents/octo-xzf-backend-expert.md
  - role: security-expert
    agent_file: .claude/agents/octo-xzf-security-expert.md
```

### 6.3 Swarm 输出自动变量

每个 swarm 节点自动写入 VarPool:

| 变量 | 说明 |
|------|------|
| `${id}_synthesis` | Host 综合输出文本 |
| `${id}_consensus_score` | 共识分数 (0-1) |
| `${id}_rounds_used` | 实际使用轮数 |
| `${id}_expert_count` | 专家数量 |
| `${id}_expert_outputs` | 各专家输出 JSON |
| `${id}_failed_experts` | 失败的专家列表 |

## 7. 错误处理策略

### 7.1 三级策略

| 级别 | 机制 | 说明 |
|------|------|------|
| **Task 级** | verify-fix 循环 (max 3) | agent 节点内部处理 |
| **Spec 级** | condition 节点 + approval | 失败报告 + 人工干预 |
| **全局** | notify on_failure | hermes 通知 xzf_hermes |

### 7.2 失败处理流程

```
execute-spec-tasks (agent)
  → spec_status == "failed"?
    → YES: handle-failure (生成报告)
           → human-intervention (approval)
             → retry: 重试当前 spec
             → skip: 继续下一个 spec
             → abort: 终止流水线
    → NO: spec-passed → 继续
```

### 7.3 现场保留

失败时写入 `08-reports/failure-{timestamp}.md`:
- 失败位置和原因
- 已尝试的修复
- 代码 diff
- 日志和截图路径
- 人工干预建议

## 8. 依赖图

```
init → idea (Idea 处理 + Codebase 研究)

idea → clarification-loop
  clarification-loop:
    brainstorm → brainstorm-approval
    break_when: user_decision == "proceed"

clarification-loop → stories-loop
  stories-loop:
    story-generation → story-approval
    break_when: user_decision == "proceed"

stories-loop → spec-design → spec-confirm

spec-confirm → task-planning-loop
  task-planning-loop:
    plan-spec
    break_when: $iteration > spec_count

task-planning-loop → execution-loop
  execution-loop:
    execute-spec-tasks → check-spec-result
      → failed: handle-failure → human-intervention → intervention-router
      → passed: spec-passed
    break_when: $iteration > spec_count

execution-loop → ship-summary → ship-submit → ship-confirm
```

## 附录 A: Skills 清单

| Skill | 用途 | 使用节点 |
|-------|------|---------|
| `octo-xzf-init` | 初始化工作环境 | init |
| `octo-xzf-research` | Idea 处理 + Codebase 研究 | idea |
| `octo-xzf-spec-designer` | Spec DSL 格式参考 | spec-design (expert skills, Phase 1) |
| `octo-xzf-executor` | 任务执行 + 验证 | execute-spec-tasks |
| `octo-xzf-ship` | PR/MR Summary 生成 | ship-summary |

## 附录 B: Agent 文件清单

| 文件 | 角色 |
|------|------|
| `.claude/agents/octo-xzf-architect.md` | 资深架构师 |
| `.claude/agents/octo-xzf-product-manager.md` | 产品经理 |
| `.claude/agents/octo-xzf-test-architect.md` | 测试架构师 |
| `.claude/agents/octo-xzf-frontend-expert.md` | 前端专家 |
| `.claude/agents/octo-xzf-backend-expert.md` | 后端专家 |
| `.claude/agents/octo-xzf-security-expert.md` | 安全专家 |

## 附录 C: 输出目录结构

```
.octopus/xzf/{branch}/
├── workspace-topology.md
├── 01-idea.md                        # 用户编写，运行前提交
├── 02-research/                      # idea 节点生成
│   ├── index.md
│   └── {domain}.md
├── 03-clarification/
│   └── questions.md
├── 04-stories/
│   ├── summary.md
│   └── technical-guide.md
├── 05-specs/
│   ├── spec-001-{name}.md
│   └── spec-002-{name}.md
├── 06-plans/
│   └── spec-{NNN}-{name}/
│       ├── consensus.md
│       ├── verify-{X}-{Y}.md
│       ├── task-{X}-{Y}-{project}-{role}.md
│       └── spec-test.md
├── 07-execution/
│   └── spec-{NNN}-{name}/
│       ├── verify-results/
│       └── fix-log.md
├── 08-reports/
│   └── failure-{timestamp}.md
└── 09-ship/
    └── summary.md
```

## 附录 D: CLI 执行命令

```bash
# 执行流水线
octopus workflow run packages/core-pack/workflows/xzf-pipeline.yaml

# 指定模型
octopus workflow run packages/core-pack/workflows/xzf-pipeline.yaml --model pro-max

# 验证 YAML 语法
octopus workflow validate packages/core-pack/workflows/xzf-pipeline.yaml
```
