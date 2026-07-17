# XZF Development Pipeline — 工作流 YAML 设计文档

> **文档编号**: 04
> **版本**: v1.0.0
> **状态**: 已确认，待执行
> **YAML 路径**: `packages/core-pack/workflows/xzf-pipeline.yaml`

---

## 目录

1. [设计概览](#1-设计概览)
2. [完整工作流 YAML](#2-完整工作流-yaml)
3. [变量系统详解](#3-变量系统详解)
4. [Approval 节点与显式决策](#4-approval-节点与显式决策)
5. [Loop 节点与退出机制](#5-loop-节点与退出条件)
6. [Swarm expert_defaults.skills 传播机制](#6-swarm-expert_defaultsskills-传播机制)
7. [错误处理策略](#7-错误处理策略)
8. [节点依赖图](#8-节点依赖图)

---

## 1. 设计概览

### 9 阶段流水线

| # | 阶段 | 节点类型 | 说明 |
|---|------|---------|------|
| 1 | **init** | bash + agent | 环境检测、分支名获取、输出目录创建、workspace 拓扑扫描 |
| 2 | **idea** | swarm | 6 专家团队理解需求、产出结构化 Idea 文档 |
| 3 | **clarification-loop** | loop → swarm + condition + approval | 循环澄清，agent 信号驱动退出 |
| 4 | **stories-loop** | loop → swarm + condition + approval | 循环生成用户故事，agent 信号驱动退出 |
| 5 | **spec-design** | swarm | 技术规范设计（架构 + API + 数据模型 + 跨项目服务链） |
| 6 | **task-planning** | swarm | 任务拆分 + 按项目分组 + 依赖排序 + 估时 |
| 7 | **execution** | loop → agent + condition + swarm | 逐任务执行（含项目上下文）+ 修复循环（最多 3 次） |
| 8 | **ship** | condition → bash + approval | 检测远程仓库、推送、创建 PR |

### 核心设计原则

- **Agent-First**: 每个节点都由 AI Agent 驱动，bash 仅用于机械操作
- **Swarm 一致**: 所有 swarm 节点共享相同的 6 专家配置
- **Workspace 感知**: 所有 swarm 节点注入 workspace 拓扑上下文，理解多项目关系
- **输出链**: 每个阶段的输出通过 `$node-id.output.*` 传递给下游
- **故障安全**: 每个阶段有独立的 `on_error` 策略，关键阶段触发人工介入
- **显式决策**: 所有 approval 节点提供结构化选项（A/B/C），用户做明确选择

---

## 2. 完整工作流 YAML

```yaml
# ============================================================================
# XZF Development Pipeline
# 路径: packages/core-pack/workflows/xzf-pipeline.yaml
# 版本: v1.0.0
# 描述: 从想法到交付的 9 阶段 AI 驱动开发流水线
# ============================================================================

name: xzf-pipeline
version: "1.0.0"
description: |
  XZF 开发流水线 — 9 阶段从想法到交付的 AI 驱动工作流。
  使用 Octopus workflow engine 原语: bash, approval, loop, swarm, agent, condition。
  所有 swarm 节点共享 6 专家配置（architect, PM, test-architect, frontend, backend, security）。
  包含 workspace 拓扑扫描、agent 信号驱动循环退出、按项目分组任务。

# ----------------------------------------------------------------------------
# 全局变量定义
# ----------------------------------------------------------------------------
variables:
  # 分支名 — 由 init 节点的 bash 命令填充
  branch: ""
  # 输出根目录
  output_base: ".octopus/xzf"
  # 完整输出路径 — init 后变为 .octopus/xzf/{branch}/
  output_dir: ""
  # 用户原始需求描述
  user_idea: ""
  # 澄清后的需求文档路径
  clarified_spec: ""
  # 用户故事列表路径
  stories_file: ""
  # 技术规范路径
  spec_file: ""
  # 任务计划路径
  tasks_file: ""
  # 当前执行的任务索引
  current_task_index: 0
  # 修复重试计数
  fix_retry_count: 0
  # 远程仓库类型 (github | gitlab | none)
  remote_type: "none"
  # 远程仓库 URL
  remote_url: ""
  # PR/MR 创建结果
  pr_url: ""
  # Workspace 拓扑信息
  workspace_topology: ""

# ----------------------------------------------------------------------------
# 全局配置
# ----------------------------------------------------------------------------
config:
  # 默认模型
  default_model: sonnet
  # 默认引擎
  default_engine: claude
  # 超时设置 (秒)
  default_timeout: 600
  # 失败时默认行为
  on_error: notify_and_pause

# ============================================================================
# 阶段 1: INIT — 环境检测与初始化
# ============================================================================
# 目的: 检测当前 git 环境，获取分支名，创建输出目录结构
# 输出: branch 名、output_dir 路径、git remote 信息
# ============================================================================

nodes:

  # --- 1a. 获取当前分支名 ---
  init-branch:
    type: bash
    description: "获取当前 git 分支名"
    command: |
      git branch --show-current
    on_success:
      set:
        branch: "$last_output"
    on_error: fail

  # --- 1b. 检测远程仓库类型 ---
  init-remote:
    type: bash
    description: "检测 git remote 类型 (GitHub/GitLab/none)"
    command: |
      REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
      if [ -z "$REMOTE_URL" ]; then
        echo "none"
      elif echo "$REMOTE_URL" | grep -qE "(github\.com|gh)"; then
        echo "github"
      elif echo "$REMOTE_URL" | grep -qE "(gitlab|gl)"; then
        echo "gitlab"
      else
        echo "none"
      fi
      echo "---URL---"
      echo "$REMOTE_URL"
    on_success:
      set:
        remote_type: "$last_output"
        remote_url: "$last_output"
    on_error:
      set:
        remote_type: "none"
        remote_url: ""

  # --- 1c. 创建输出目录结构 ---
  init-dirs:
    type: bash
    description: "创建 .octopus/xzf/{branch}/ 输出目录结构"
    depends_on: [init-branch]
    command: |
      BRANCH="$vars.branch"
      BASE="$vars.output_base"
      OUT_DIR="${BASE}/${BRANCH}"
      mkdir -p "${OUT_DIR}/idea"
      mkdir -p "${OUT_DIR}/clarification"
      mkdir -p "${OUT_DIR}/stories"
      mkdir -p "${OUT_DIR}/spec"
      mkdir -p "${OUT_DIR}/tasks"
      mkdir -p "${OUT_DIR}/execution"
      mkdir -p "${OUT_DIR}/ship"
      echo "${OUT_DIR}"
    on_success:
      set:
        output_dir: "$last_output"

  # --- 1d. 初始化确认 ---
  init-confirm:
    type: approval
    description: "确认环境初始化结果"
    depends_on: [init-dirs, init-remote, init-workspace]
    prompt: |
      ## 环境初始化完成

      - **分支**: `$vars.branch`
      - **输出目录**: `$vars.output_dir`
      - **远程仓库**: `$vars.remote_type` ($vars.remote_url)
      - **Workspace 拓扑**: `$vars.output_dir/workspace-topology.md`

      请审查初始化结果：
      A) 确认，继续执行
      B) 需要修正（请说明问题）
    on_success:
      message: "初始化完成，进入 Idea 阶段"
    on_error: fail

  # --- 1e. 扫描 Workspace 拓扑 ---
  init-workspace:
    type: agent
    description: "扫描 workspace 项目拓扑"
    depends_on: [init-dirs]
    prompt: |
      扫描当前 workspace 中所有项目：
      - 每个项目的 repo 名称、技术栈、主要模块
      - 项目间依赖关系和通信方式（HTTP/RPC/消息队列/共享库）
      - 每个项目的关键约定（读取各项目 CLAUDE.md 如果存在）

      输出结构化拓扑报告到 $vars.output_dir/workspace-topology.md
    on_success:
      write_file: "$vars.output_dir/workspace-topology.md"
      set:
        workspace_topology: "$last_output"

  # ============================================================================
  # 阶段 2: IDEA — 需求理解与结构化
  # ============================================================================
  # 目的: 6 专家团队共同理解用户原始需求，产出结构化 Idea 文档
  # 模式: swarm (review) — 各专家并行分析，Host 综合
  # 输出: {output_dir}/idea/idea.md
  # ============================================================================

  idea:
    type: swarm
    description: "6 专家团队理解需求、产出结构化 Idea 文档"
    depends_on: [init-workspace]
    mode: review
    timeout: 300

    # --- Swarm 专家默认配置 (传播到所有 expert) ---
    expert_defaults:
      engine: claude
      model: sonnet
      skills:
        - octo-workflow-dev
        - octo-swarm-dev
      context_files:
        - CLAUDE.md

    # --- 6 专家定义 ---
    experts:
      - name: architect
        agent: .claude/agents/octo-xzf-architect.md
        role: "系统架构师 — 评估技术可行性、架构影响、系统边界"
        skills:
          - octo-source-analyzer

      - name: pm
        agent: .claude/agents/octo-xzf-pm.md
        role: "产品经理 — 拆解用户需求、识别核心价值、定义验收标准"
        skills:
          - octo-resource-manager

      - name: test-architect
        agent: .claude/agents/octo-xzf-test-architect.md
        role: "测试架构师 — 评估可测试性、定义测试策略、识别边界用例"

      - name: frontend
        agent: .claude/agents/octo-xzf-frontend.md
        role: "前端工程师 — 评估 UI/UX 影响、组件设计、交互复杂度"

      - name: backend
        agent: .claude/agents/octo-xzf-backend.md
        role: "后端工程师 — 评估 API 设计、数据模型、性能影响"

      - name: security
        agent: .claude/agents/octo-xzf-security.md
        role: "安全专家 — 评估安全风险、合规要求、数据敏感性"

    prompt: |
      ## 任务: 需求分析与结构化

      用户提出了以下需求/想法:

      > $vars.user_idea

      请从你的专业角度分析此需求，产出:
      1. **理解**: 你对需求的理解（用自己的话重述）
      2. **价值**: 核心价值点
      3. **风险**: 潜在风险和不确定性
      4. **范围**: 建议的 MVP 范围
      5. **开放问题**: 需要向用户澄清的问题

      Workspace 拓扑:
      $vars.workspace_topology

      输出目录: $vars.output_dir/idea/

    on_success:
      write_file: "$vars.output_dir/idea/idea.md"
      set:
        user_idea: "$last_output"
    on_error: notify_and_pause

  # --- Idea 确认 ---
  idea-confirm:
    type: approval
    description: "确认 Idea 文档"
    depends_on: [idea]
    prompt: |
      ## Idea 文档已生成

      文件: `$vars.output_dir/idea/idea.md`

      请审查 6 位专家的分析结果：
      A) 满意，进入澄清阶段
      B) 需要补充分析（请说明方向）
      C) 重新生成（请说明原因）
    on_error: notify_and_pause

  # ============================================================================
  # 阶段 3: CLARIFICATION-LOOP — 循环澄清
  # ============================================================================
  # 目的: 通过多轮对话澄清需求细节，直到 agent 判定需求足够清晰
  # 模式: loop → swarm (review) + condition (signal check) + approval
  # 退出条件: agent 输出 ===CLARIFICATION_COMPLETE=== 信号
  # 输出: {output_dir}/clarification/clarified-spec.md
  # ============================================================================

  clarification-loop:
    type: loop
    description: "循环澄清需求，直到 agent 判定完成"
    depends_on: [idea-confirm]
    max_iterations: 20  # 安全上限，防止无限循环
    on_exit:
      message: "需求澄清完成，共 $iteration 轮"

    nodes:

      # --- 3a. Swarm 生成澄清问题 ---
      clarification-swarm:
        type: swarm
        description: "6 专家生成针对性澄清问题"
        mode: review
        timeout: 180

        expert_defaults:
          engine: claude
          model: sonnet
          skills:
            - octo-workflow-dev
            - octo-swarm-dev
          context_files:
            - CLAUDE.md

        experts:
          - name: architect
            agent: .claude/agents/octo-xzf-architect.md
            role: "系统架构师 — 聚焦架构约束和技术栈选择"
            skills:
              - octo-source-analyzer

          - name: pm
            agent: .claude/agents/octo-xzf-pm.md
            role: "产品经理 — 聚焦用户场景和验收标准"
            skills:
              - octo-resource-manager

          - name: test-architect
            agent: .claude/agents/octo-xzf-test-architect.md
            role: "测试架构师 — 聚焦边界条件和测试场景"

          - name: frontend
            agent: .claude/agents/octo-xzf-frontend.md
            role: "前端工程师 — 聚焦交互细节和 UI 规范"

          - name: backend
            agent: .claude/agents/octo-xzf-backend.md
            role: "后端工程师 — 聚焦数据流和接口契约"

          - name: security
            agent: .claude/agents/octo-xzf-security.md
            role: "安全专家 — 聚焦安全需求和合规要求"

        prompt: |
          ## 任务: 需求澄清 (第 $iteration 轮)

          ### 原始需求
          > $vars.user_idea

          ### Idea 分析
          $idea.output.summary

          ### Workspace 拓扑
          $vars.workspace_topology

          用户上轮回复: $last_approval_output

          $vars.clarification_history

          请从你的专业角度提出需要澄清的问题。问题分类:
          - **架构**: 技术栈选择、系统集成、扩展性
          - **功能**: 用户场景、验收标准、MVP 边界
          - **测试**: 边界条件、测试场景、质量要求
          - **UI/UX**: 交互细节、组件设计、响应式需求
          - **API/数据**: 数据模型、接口契约、数据流
          - **安全**: 安全需求、合规要求、数据敏感性
          - **Research**: 哪些 codebase 区域需要重点研究、需要调研什么技术方案、有哪些实现路径需要 POC 验证

          每个问题应:
          - 具体、可回答
          - 标注优先级 (P0/P1/P2)
          - 说明为什么需要澄清

          如果认为需求已经足够清晰，且用户已充分回答，在输出末尾标记:
          ===CLARIFICATION_COMPLETE===

          输出目录: $vars.output_dir/clarification/

        on_success:
          write_file: "$vars.output_dir/clarification/questions-round-$iteration.md"

      # --- 3b. 检查是否完成 ---
      check-complete:
        type: condition
        description: "检查 agent 是否判定澄清完成"
        depends_on: [clarification-swarm]
        if: "$clarification-swarm.output contains '===CLARIFICATION_COMPLETE==='"
        then: break
        else: continue

      # --- 3c. 用户回答澄清问题 ---
      clarification-approval:
        type: approval
        description: "用户回答澄清问题"
        depends_on: [check-complete]
        prompt: |
          ## 澄清问题 (第 $iteration 轮)

          请审查以下问题并回复。

          $clarification-swarm.output.questions

          回复选项：
          A) 逐条回答问题，继续讨论更多细节
          B) 回答问题 + 进入下一阶段（需求已足够清晰）
          C) 补充新的讨论话题或方向

          注意：如选择 B 但部分问题未回答，将采用专家团的推荐方案。
        on_success:
          set:
            clarification_history: |
              $vars.clarification_history

              ---
              ### 第 $iteration 轮

              **问题**: $clarification-swarm.output.questions
              **回答**: $last_output

  # --- 澄清输出: 生成最终澄清文档 ---
  clarification-summary:
    type: swarm
    description: "汇总澄清结果，生成最终需求规格"
    depends_on: [clarification-loop]
    mode: review
    timeout: 300

    expert_defaults:
      engine: claude
      model: sonnet
      skills:
        - octo-workflow-dev
        - octo-swarm-dev
      context_files:
        - CLAUDE.md

    experts:
      - name: architect
        agent: .claude/agents/octo-xzf-architect.md
        role: "系统架构师 — 确认架构约束和技术决策"
        skills:
          - octo-source-analyzer

      - name: pm
        agent: .claude/agents/octo-xzf-pm.md
        role: "产品经理 — 综合所有澄清，产出完整需求规格"
        skills:
          - octo-resource-manager

      - name: test-architect
        agent: .claude/agents/octo-xzf-test-architect.md
        role: "测试架构师 — 确认验收标准和测试边界"

      - name: frontend
        agent: .claude/agents/octo-xzf-frontend.md
        role: "前端工程师 — 确认 UI/UX 规格"

      - name: backend
        agent: .claude/agents/octo-xzf-backend.md
        role: "后端工程师 — 确认数据模型和 API 规格"

      - name: security
        agent: .claude/agents/octo-xzf-security.md
        role: "安全专家 — 确认安全需求和合规规格"

    prompt: |
      ## 任务: 生成最终需求规格

      ### 原始需求
      > $vars.user_idea

      ### Idea 分析
      $idea.output.summary

      ### Workspace 拓扑
      $vars.workspace_topology

      ### 澄清历史 ($iteration 轮)
      $vars.clarification_history

      请综合所有信息，产出最终的需求规格文档。
      文档应包含:
      1. **需求概述** — 一句话描述
      2. **功能需求** — 分 Must/Should/Could，按项目分组
      3. **非功能需求** — 性能、安全、可用性
      4. **约束条件** — 技术栈、时间、资源
      5. **跨项目依赖** — 涉及哪些项目间的服务链和数据流
      6. **验收标准** — 每个功能的验收条件
      7. **Research 项** — 需要进一步调研的技术方案（如有）
      8. **开放问题** — 仍未解决的问题

      输出目录: $vars.output_dir/clarification/

    on_success:
      write_file: "$vars.output_dir/clarification/clarified-spec.md"
      set:
        clarified_spec: "$vars.output_dir/clarification/clarified-spec.md"
    on_error: notify_and_pause

  # ============================================================================
  # 阶段 4: STORIES-LOOP — 用户故事生成与确认
  # ============================================================================
  # 目的: 基于澄清后的需求生成用户故事，循环修订直到 agent 判定完成
  # 模式: loop → swarm (debate) + condition (signal check) + approval
  # 退出条件: agent 输出 ===STORIES_COMPLETE=== 信号
  # 输出: {output_dir}/stories/stories.md
  # ============================================================================

  stories-loop:
    type: loop
    description: "循环生成用户故事，直到 agent 判定完成"
    depends_on: [clarification-summary]
    max_iterations: 10
    on_exit:
      message: "用户故事确认完成，共 $iteration 轮修订"

    nodes:

      # --- 4a. Swarm 生成/修订用户故事 ---
      stories-swarm:
        type: swarm
        description: "6 专家协作生成用户故事"
        mode: debate
        rounds: 2  # 2 轮辩论以达成高质量故事
        consensus_threshold: 0.75
        timeout: 300

        expert_defaults:
          engine: claude
          model: sonnet
          skills:
            - octo-workflow-dev
            - octo-swarm-dev
          context_files:
            - CLAUDE.md

        experts:
          - name: architect
            agent: .claude/agents/octo-xzf-architect.md
            role: "系统架构师 — 确保故事与架构一致，识别技术 spike"
            skills:
              - octo-source-analyzer

          - name: pm
            agent: .claude/agents/octo-xzf-pm.md
            role: "产品经理 — 主导故事编写，确保用户视角完整"
            skills:
              - octo-resource-manager

          - name: test-architect
            agent: .claude/agents/octo-xzf-test-architect.md
            role: "测试架构师 — 为每个故事定义验收测试 (Given-When-Then)"

          - name: frontend
            agent: .claude/agents/octo-xzf-frontend.md
            role: "前端工程师 — 补充 UI 交互细节和组件拆分"

          - name: backend
            agent: .claude/agents/octo-xzf-backend.md
            role: "后端工程师 — 补充 API 端点和数据处理细节"

          - name: security
            agent: .claude/agents/octo-xzf-security.md
            role: "安全专家 — 为涉及敏感数据的故事添加安全验收条件"

        prompt: |
          ## 任务: 用户故事生成 (第 $iteration 轮)

          ### 需求规格
          $clarification-summary.output.summary

          ### Workspace 拓扑
          $vars.workspace_topology

          用户上轮回复: $last_approval_output

          $vars.stories_feedback

          请生成/修订用户故事，每个故事需标注所属项目。格式:

          ```markdown
          ## Story-{ID}: {标题}

          **项目**: {所属项目名}
          **As a** {角色}
          **I want** {功能}
          **So that** {价值}

          **Acceptance Criteria:**
          - [ ] {条件 1}
          - [ ] {条件 2}

          **Technical Notes:**
          - {技术备注}

          **Priority:** {P0/P1/P2}
          **Estimate:** {S/M/L/XL}
          ```

          如果用户已充分确认所有故事，在输出末尾标记:
          ===STORIES_COMPLETE===

          输出目录: $vars.output_dir/stories/

        on_success:
          write_file: "$vars.output_dir/stories/stories-round-$iteration.md"

      # --- 4b. 检查是否完成 ---
      stories-check-complete:
        type: condition
        description: "检查 agent 是否判定故事生成完成"
        depends_on: [stories-swarm]
        if: "$stories-swarm.output contains '===STORIES_COMPLETE==='"
        then: break
        else: continue

      # --- 4c. 用户确认故事 ---
      stories-approval:
        type: approval
        description: "用户确认用户故事"
        depends_on: [stories-check-complete]
        prompt: |
          ## 用户故事 (第 $iteration 轮)

          文件: `$vars.output_dir/stories/stories-round-$iteration.md`

          共 $stories-swarm.output.story_count 个故事。

          请审查用户故事：
          A) 确认所有故事，进入技术规范设计
          B) 部分故事需要修改（请指出具体故事编号和修改意见）
          C) 需要新增故事（请描述需求）

          注意：如选择 A 但有项目维度的故事缺失，将在 task-planning 阶段补充。
        on_success:
          set:
            stories_feedback: "$last_output"
          write_file: "$vars.output_dir/stories/stories.md"
          set:
            stories_file: "$vars.output_dir/stories/stories.md"

  # ============================================================================
  # 阶段 5: SPEC-DESIGN — 技术规范设计
  # ============================================================================
  # 目的: 基于确认的用户故事产出完整技术规范
  # 模式: swarm (dispatch) — DAG 依赖调度，上游完成后下游执行
  # 输出: {output_dir}/spec/ 目录下的多个文档
  # ============================================================================

  spec-design:
    type: swarm
    description: "6 专家 DAG 调度产出完整技术规范"
    depends_on: [stories-loop]
    mode: dispatch
    timeout: 600

    expert_defaults:
      engine: claude
      model: sonnet
      skills:
        - octo-workflow-dev
        - octo-swarm-dev
      context_files:
        - CLAUDE.md

    # DAG 依赖:
    # architect, pm (并行) → test-architect, frontend, backend (并行) → security (审查)
    experts:
      - name: architect
        agent: .claude/agents/octo-xzf-architect.md
        role: "系统架构师 — 产出架构设计文档 (ADR、系统图、模块拆分)"
        skills:
          - octo-source-analyzer
        depends_on: []  # 无依赖，第一批执行

      - name: pm
        agent: .claude/agents/octo-xzf-pm.md
        role: "产品经理 — 产出功能规格文档 (详细功能描述、交互流程)"
        skills:
          - octo-resource-manager
        depends_on: []  # 无依赖，第一批执行

      - name: test-architect
        agent: .claude/agents/octo-xzf-test-architect.md
        role: "测试架构师 — 产出测试策略文档 (测试计划、用例矩阵)"
        depends_on: [architect, pm]  # 等待架构和功能规格

      - name: frontend
        agent: .claude/agents/octo-xzf-frontend.md
        role: "前端工程师 — 产出前端设计文档 (组件树、状态管理、路由)"
        depends_on: [architect, pm]

      - name: backend
        agent: .claude/agents/octo-xzf-backend.md
        role: "后端工程师 — 产出 API 设计文档 (OpenAPI、数据模型、迁移)"
        depends_on: [architect, pm]

      - name: security
        agent: .claude/agents/octo-xzf-security.md
        role: "安全专家 — 审查所有设计文档，产出安全评审报告"
        depends_on: [architect, pm, test-architect, frontend, backend]

    prompt: |
      ## 任务: 技术规范设计

      ### 用户故事
      $clarification-summary.output.summary

      ### 确认的故事列表
      $vars.stories_file (内容)

      ### Workspace 拓扑
      $vars.workspace_topology

      请从你的专业角度产出技术设计文档。
      重点关注跨项目服务链：哪些变更涉及多个项目，接口如何协调。
      所有文档写入: $vars.output_dir/spec/

    on_success:
      write_file: "$vars.output_dir/spec/DESIGN-INDEX.md"
      set:
        spec_file: "$vars.output_dir/spec/DESIGN-INDEX.md"
    on_error: notify_and_pause

  # --- Spec 确认 ---
  spec-confirm:
    type: approval
    description: "确认技术规范"
    depends_on: [spec-design]
    prompt: |
      ## 技术规范已生成

      索引文件: `$vars.spec_file`

      生成的文档:
      - 架构设计: `$vars.output_dir/spec/architecture.md`
      - 功能规格: `$vars.output_dir/spec/functional-spec.md`
      - 测试策略: `$vars.output_dir/spec/test-strategy.md`
      - 前端设计: `$vars.output_dir/spec/frontend-design.md`
      - API 设计: `$vars.output_dir/spec/api-design.md`
      - 安全评审: `$vars.output_dir/spec/security-review.md`
      - 跨项目服务链: `$vars.output_dir/spec/cross-project-chains.md`

      请审查技术规范：
      A) 批准，进入任务拆分
      B) 需要调整（请说明具体问题）
    on_error: notify_and_pause

  # ============================================================================
  # 阶段 6: TASK-PLANNING — 任务拆分与排序
  # ============================================================================
  # 目的: 将技术规范拆分为可执行任务，排序依赖，估算时间
  # 模式: swarm (debate) — 多轮讨论确保任务粒度合理
  # 输出: {output_dir}/tasks/tasks.md
  # ============================================================================

  task-planning:
    type: swarm
    description: "6 专家协作拆分任务、排序依赖"
    depends_on: [spec-confirm]
    mode: debate
    rounds: 3
    consensus_threshold: 0.8
    timeout: 600

    expert_defaults:
      engine: claude
      model: sonnet
      skills:
        - octo-workflow-dev
        - octo-swarm-dev
      context_files:
        - CLAUDE.md

    experts:
      - name: architect
        agent: .claude/agents/octo-xzf-architect.md
        role: "系统架构师 — 识别基础设施任务和技术 spike"
        skills:
          - octo-source-analyzer

      - name: pm
        agent: .claude/agents/octo-xzf-pm.md
        role: "产品经理 — 确保任务覆盖所有用户故事，定义 DoD"
        skills:
          - octo-resource-manager

      - name: test-architect
        agent: .claude/agents/octo-xzf-test-architect.md
        role: "测试架构师 — 为每个任务定义测试任务"

      - name: frontend
        agent: .claude/agents/octo-xzf-frontend.md
        role: "前端工程师 — 拆分前端实现任务"

      - name: backend
        agent: .claude/agents/octo-xzf-backend.md
        role: "后端工程师 — 拆分手端实现任务"

      - name: security
        agent: .claude/agents/octo-xzf-security.md
        role: "安全专家 — 添加安全相关任务 (audit, hardening)"

    prompt: |
      ## 任务: 任务拆分与排序

      ### 技术规范索引
      $spec-design.output.summary

      ### Workspace 拓扑
      $vars.workspace_topology

      请协作产出任务计划。每个任务需标注所属项目，ID 格式为 task-{X}-{Y}-{project}-{role}.md。

      格式:

      ```yaml
      tasks:
        - id: task-1-1-shared-backend
          project: shared
          title: "搭建项目基础结构"
          type: setup
          depends_on: []
          assignee: backend
          estimate: S
          files:
            - src/index.ts
            - tsconfig.json
          acceptance:
            - "项目可以 pnpm build 成功"
            - "所有 lint 检查通过"

        - id: task-1-2-engine-backend
          project: engine
          title: "实现用户认证 API"
          type: feature
          depends_on: [task-1-1-shared-backend]
          assignee: backend
          estimate: L
          files:
            - src/api/auth.ts
          acceptance:
            - "POST /auth/login 返回 JWT"
            - "密码使用 bcrypt 加密"
      ```

      要求:
      - 每个任务应可独立验证
      - 明确标注所属项目
      - 跨项目依赖关系清晰，支持拓扑排序
      - 估算使用 T-shirt sizing (S/M/L/XL)
      - consensus.md 应按项目分组列出变更

      输出目录: $vars.output_dir/tasks/

    on_success:
      write_file: "$vars.output_dir/tasks/tasks.md"
      set:
        tasks_file: "$vars.output_dir/tasks/tasks.md"
    on_error: notify_and_pause

  # --- 任务确认 ---
  task-confirm:
    type: approval
    description: "确认任务计划"
    depends_on: [task-planning]
    prompt: |
      ## 任务计划已生成

      文件: `$vars.tasks_file`

      共 $task-planning.output.task_count 个任务，分布在 $task-planning.output.project_count 个项目中。
      预估总工作量: $task-planning.output.total_estimate

      请审查任务计划：
      A) 批准，开始执行
      B) 需要调整（请说明问题）
    on_error: notify_and_pause

  # ============================================================================
  # 阶段 7: EXECUTION — 逐任务执行
  # ============================================================================
  # 目的: 按任务计划逐个执行，每个任务执行后验证，失败则修复（最多 3 次）
  # 模式: loop → agent (执行) + bash (验证) + condition (通过/失败) + swarm (修复)
  # 退出条件: 所有任务执行完毕
  # 输出: {output_dir}/execution/ 目录下的执行日志
  # ============================================================================

  execution-loop:
    type: loop
    description: "逐任务执行，验证通过则继续，失败则修复"
    depends_on: [task-confirm]
    max_iterations: 50  # 安全上限
    exit_condition: |
      $vars.current_task_index >= $vars.total_tasks
    on_exit:
      message: "所有任务执行完毕"

    nodes:

      # --- 7a. 获取当前任务 ---
      get-current-task:
        type: bash
        description: "获取当前待执行的任务信息"
        command: |
          # 从 tasks.md 中解析第 $vars.current_task_index 个任务
          # 输出任务 ID、标题、依赖、文件列表
          cat "$vars.tasks_file" | python3 -c "
          import sys, yaml
          tasks = yaml.safe_load(sys.stdin)['tasks']
          idx = int('$vars.current_task_index')
          if idx < len(tasks):
              t = tasks[idx]
              print(f\"id: {t['id']}\")
              print(f\"project: {t.get('project', 'unknown')}\")
              print(f\"title: {t['title']}\")
              print(f\"type: {t['type']}\")
              print(f\"depends_on: {t.get('depends_on', [])}\")
              print(f\"files: {t.get('files', [])}\")
              print(f\"acceptance: {t.get('acceptance', [])}\")
          else:
              print('DONE')
          "
        on_success:
          set:
            current_task: "$last_output"

      # --- 7b. Agent 执行任务 ---
      execute-task:
        type: agent
        description: "执行当前任务"
        depends_on: [get-current-task]
        agent: .claude/agents/octo-xzf-implementer.md
        model: sonnet
        engine: claude
        skills:
          - octo-workflow-dev
          - octo-swarm-dev
        context_files:
          - CLAUDE.md
        prompt: |
          ## 执行任务

          ### 当前任务
          $vars.current_task

          ### 所属项目
          此任务属于项目: $vars.current_task.project
          请先切换到该项目目录执行。

          ### Workspace 拓扑
          $vars.workspace_topology

          ### 技术规范
          参见: $vars.spec_file

          ### 已完成任务
          $vars.completed_tasks

          请实现此任务:
          1. 阅读相关设计文档和项目的 CLAUDE.md
          2. 在正确的项目目录中实现代码
          3. 编写测试
          4. 确保所有 acceptance criteria 满足
          5. 如涉及跨项目变更，确保接口一致性

          完成后输出修改的文件列表和简要说明。

        on_success:
          write_file: "$vars.output_dir/execution/task-$vars.current_task_index-log.md"

      # --- 7c. Bash 验证 ---
      verify-task:
        type: bash
        description: "运行构建和测试验证任务"
        depends_on: [execute-task]
        command: |
          echo "=== 构建验证 ==="
          pnpm build 2>&1

          BUILD_EXIT=$?

          echo ""
          echo "=== 测试验证 ==="
          pnpm test 2>&1

          TEST_EXIT=$?

          echo ""
          echo "=== Lint 检查 ==="
          pnpm lint 2>&1

          LINT_EXIT=$?

          echo ""
          echo "---RESULTS---"
          echo "build: $BUILD_EXIT"
          echo "test: $TEST_EXIT"
          echo "lint: $LINT_EXIT"

          if [ $BUILD_EXIT -eq 0 ] && [ $TEST_EXIT -eq 0 ] && [ $LINT_EXIT -eq 0 ]; then
            echo "VERDICT: PASS"
          else
            echo "VERDICT: FAIL"
          fi
        on_success:
          set:
            verify_result: "$last_output"

      # --- 7d. 条件判断: 验证通过/失败 ---
      check-verification:
        type: condition
        description: "判断验证结果"
        depends_on: [verify-task]
        conditions:
          - when: "$vars.verify_result contains 'VERDICT: PASS'"
            goto: task-passed
          - when: "$vars.verify_result contains 'VERDICT: FAIL'"
            goto: task-failed
        default: task-failed

      # --- 7e. 任务通过: 记录并推进 ---
      task-passed:
        type: bash
        description: "记录任务通过，推进到下一个任务"
        depends_on: [check-verification]
        command: |
          echo "Task $vars.current_task_index PASSED"
          # 追加到已完成任务列表
          echo "- task-$vars.current_task_index: $vars.current_task" >> "$vars.output_dir/execution/completed.md"
          echo "NEXT"
        on_success:
          set:
            current_task_index: "$vars.current_task_index + 1"
            fix_retry_count: 0
            completed_tasks: "$vars.completed_tasks\n- task $vars.current_task_index: PASSED"

      # --- 7f. 任务失败: 修复循环 ---
      task-failed:
        type: condition
        description: "判断是否可以重试修复"
        depends_on: [check-verification]
        conditions:
          - when: "$vars.fix_retry_count < 3"
            goto: fix-task
          - when: "$vars.fix_retry_count >= 3"
            goto: fix-exhausted
        default: fix-exhausted

      # --- 7g. Swarm 修复失败的任务 ---
      fix-task:
        type: swarm
        description: "6 专家协作修复失败的任务"
        depends_on: [task-failed]
        mode: review
        timeout: 300

        expert_defaults:
          engine: claude
          model: sonnet
          skills:
            - octo-workflow-dev
            - octo-swarm-dev
          context_files:
            - CLAUDE.md

        experts:
          - name: architect
            agent: .claude/agents/octo-xzf-architect.md
            role: "系统架构师 — 分析失败根因，判断是否需要架构调整"
            skills:
              - octo-source-analyzer

          - name: pm
            agent: .claude/agents/octo-xzf-pm.md
            role: "产品经理 — 评估失败影响，决定修复优先级"
            skills:
              - octo-resource-manager

          - name: test-architect
            agent: .claude/agents/octo-xzf-test-architect.md
            role: "测试架构师 — 分析测试失败原因，补充缺失的测试"

          - name: frontend
            agent: .claude/agents/octo-xzf-frontend.md
            role: "前端工程师 — 修复前端相关错误"

          - name: backend
            agent: .claude/agents/octo-xzf-backend.md
            role: "后端工程师 — 修复后端相关错误"

          - name: security
            agent: .claude/agents/octo-xzf-security.md
            role: "安全专家 — 检查修复是否引入安全问题"

        prompt: |
          ## 任务: 修复失败的任务 (重试 $vars.fix_retry_count / 3)

          ### 失败的任务
          $vars.current_task

          ### 所属项目
          项目: $vars.current_task.project

          ### 验证结果
          $vars.verify_result

          ### 执行日志
          参见: $vars.output_dir/execution/task-$vars.current_task_index-log.md

          ### Workspace 拓扑
          $vars.workspace_topology

          请分析失败原因并修复:
          1. 分析错误日志，定位根因
          2. 修复代码（在正确的项目目录中）
          3. 确保修复不引入新问题
          4. 重新通过所有验证

          输出目录: $vars.output_dir/execution/

        on_success:
          set:
            fix_retry_count: "$vars.fix_retry_count + 1"
          # 修复后重新验证 (回到 verify-task)
          goto: verify-task

      # --- 7h. 修复耗尽: 通知 + 人工介入 ---
      fix-exhausted:
        type: approval
        description: "修复重试耗尽，需要人工介入"
        depends_on: [task-failed]
        prompt: |
          ## ⚠️ 修复重试已耗尽

          **任务**: $vars.current_task
          **项目**: $vars.current_task.project
          **重试次数**: 3/3
          **最后错误**: $vars.verify_result

          此任务经过 3 次修复尝试仍然失败。需要人工介入。

          请选择操作：
          A) 提供修复指导，继续重试
          B) 跳过此任务，继续下一个
          C) 终止整个流水线
        on_success:
          evaluate: |
            if ($last_output contains "skip") {
              set current_task_index = $vars.current_task_index + 1
              set fix_retry_count = 0
              append_to_log "SKIPPED: task $vars.current_task_index"
            } else if ($last_output contains "abort") {
              fail "用户选择终止流水线"
            } else {
              # 用户提供修复指导，重新尝试
              set fix_retry_count = 0
              set fix_guidance = $last_output
              goto: fix-task
            }
        on_error:
          notify:
            channel: xzf_hermes
            message: "XZF Pipeline: 任务执行失败，修复重试耗尽，等待人工介入"

  # ============================================================================
  # 阶段 8: SHIP — 发布与交付
  # ============================================================================
  # 目的: 检测远程仓库，推送代码，创建 PR/MR
  # 模式: condition (检测远程) → bash (推送) → approval (确认 PR)
  # 输出: PR/MR URL 或本地提交记录
  # ============================================================================

  # --- 8a. 检测远程仓库类型 ---
  ship-detect:
    type: condition
    description: "检测远程仓库类型，决定 ship 策略"
    depends_on: [execution-loop]
    conditions:
      - when: "$vars.remote_type == 'github'"
        goto: ship-github
      - when: "$vars.remote_type == 'gitlab'"
        goto: ship-gitlab
    default: ship-local

  # --- 8b. GitHub PR ---
  ship-github:
    type: bash
    description: "推送到 GitHub 并创建 Pull Request"
    depends_on: [ship-detect]
    command: |
      BRANCH="$vars.branch"

      # 确保在正确的分支上
      git checkout "$BRANCH"

      # 提交所有变更
      git add -A
      git diff --cached --quiet && echo "NO_CHANGES" && exit 0

      git commit -m "feat: implement $vars.user_idea

      Generated by XZF Development Pipeline
      Branch: $BRANCH
      Stories: $vars.stories_file
      Spec: $vars.spec_file
      Tasks: $vars.tasks_file"

      # 推送分支
      git push -u origin "$BRANCH" 2>&1

      # 创建 PR
      PR_URL=$(gh pr create \
        --title "feat: $vars.user_idea" \
        --body "## Summary

      Implemented by XZF Development Pipeline.

      ### Artifacts
      - Idea: \`$vars.output_dir/idea/idea.md\`
      - Spec: \`$vars.spec_file\`
      - Stories: \`$vars.stories_file\`
      - Tasks: \`$vars.tasks_file\`

      ### Pipeline Summary
      - Clarification rounds: completed
      - Stories confirmed: yes
      - Tasks executed: all passed

      ---
      _Auto-generated by Octopus XZF Pipeline_" \
        --base main 2>&1)

      echo "$PR_URL"

    on_success:
      set:
        pr_url: "$last_output"
    on_error:
      notify:
        channel: xzf_hermes
        message: "XZF Pipeline: GitHub PR 创建失败，需要人工处理"

  # --- 8c. GitLab MR ---
  ship-gitlab:
    type: bash
    description: "推送到 GitLab 并创建 Merge Request"
    depends_on: [ship-detect]
    command: |
      BRANCH="$vars.branch"

      git checkout "$BRANCH"
      git add -A
      git diff --cached --quiet && echo "NO_CHANGES" && exit 0

      git commit -m "feat: implement $vars.user_idea

      Generated by XZF Development Pipeline
      Branch: $BRANCH"

      git push -u origin "$BRANCH" 2>&1

      # 使用 glab CLI 创建 MR
      MR_URL=$(glab mr create \
        --title "feat: $vars.user_idea" \
        --description "## Summary

      Implemented by XZF Development Pipeline.

      ### Artifacts
      - Idea: \`$vars.output_dir/idea/idea.md\`
      - Spec: \`$vars.spec_file\`
      - Stories: \`$vars.stories_file\`
      - Tasks: \`$vars.tasks_file\`

      ---
      _Auto-generated by Octopus XZF Pipeline_" \
        --target-branch main 2>&1)

      echo "$MR_URL"

    on_success:
      set:
        pr_url: "$last_output"
    on_error:
      notify:
        channel: xzf_hermes
        message: "XZF Pipeline: GitLab MR 创建失败，需要人工处理"

  # --- 8d. 本地模式 (无远程仓库) ---
  ship-local:
    type: bash
    description: "本地提交变更 (无远程仓库)"
    depends_on: [ship-detect]
    command: |
      BRANCH="$vars.branch"

      git add -A
      git diff --cached --quiet && echo "NO_CHANGES" && exit 0

      git commit -m "feat: implement $vars.user_idea

      Generated by XZF Development Pipeline (local mode)
      Branch: $BRANCH"

      echo "LOCAL_COMMIT: $(git rev-parse HEAD)"

    on_success:
      set:
        pr_url: "local-commit:$(git rev-parse HEAD)"

  # --- 8e. Ship 确认 ---
  ship-confirm:
    type: approval
    description: "确认发布结果"
    depends_on: [ship-github, ship-gitlab, ship-local]
    # depends_on 中只有实际执行的节点会触发
    prompt: |
      ## 发布完成

      - **分支**: `$vars.branch`
      - **PR/MR**: $vars.pr_url
      - **产出目录**: `$vars.output_dir`

      所有阶段执行完毕。XZF Pipeline 完成。

      请确认发布结果：
      A) 确认完成
      B) 需要补充操作（请说明）
    on_success:
      message: "XZF Pipeline 完成!"
```

---

## 3. 变量系统详解

### 3.1 变量层级

| 变量语法 | 说明 | 示例 |
|---------|------|------|
| `$vars.xxx` | 全局变量池中的变量 | `$vars.branch` → `"feat-user-auth"` |
| `$node-id.output.xxx` | 特定节点的输出属性 | `$idea.output.summary` |
| `$last_output` | 当前节点的直接输出 | bash 命令的 stdout |
| `$iteration` | loop 节点当前迭代（1-based） | 第 3 轮澄清 → `$iteration` = 3 |

### 3.2 变量生命周期

```
┌─────────────────────────────────────────────────────────────────┐
│ 全局变量池 ($vars.*)                                            │
│                                                                 │
│  variables:          init 阶段         clarification            │
│  ┌──────────┐       ┌──────────┐      ┌──────────────┐        │
│  │ branch:""│──→    │ branch:  │──→   │ clarification│──→ ... │
│  │ user_idea│       │ "feat-x" │      │ _history:... │        │
│  └──────────┘       └──────────┘      └──────────────┘        │
│                                                                 │
│  每个节点通过 on_success.set 写入变量池                            │
│  后续节点通过 $vars.xxx 读取                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 跨节点引用

```yaml
# 在 idea 节点中引用 init 节点的输出
prompt: |
  分支名: $init-branch.output.stdout
  远程仓库: $init-remote.output.stdout

# 在 clarification-swarm 中引用上游 swarm 的输出
prompt: |
  Idea 分析: $idea.output.summary

# 在 loop 内部使用迭代变量
prompt: |
  当前第 $iteration 轮澄清
  历史: $vars.clarification_history
```

### 3.4 变量设置方式

```yaml
# 方式 1: on_success.set — 节点成功后设置变量
on_success:
  set:
    branch: "$last_output"           # 使用节点输出
    output_dir: "$vars.output_base/$vars.branch"  # 使用已有变量
    workspace_topology: "$last_output"  # agent 节点输出

# 方式 2: on_success + write_file — 写入文件同时设置变量
on_success:
  write_file: "$vars.output_dir/spec/architecture.md"
  set:
    spec_file: "$vars.output_dir/spec/DESIGN-INDEX.md"

# 方式 3: bash 输出 + on_success.set
# bash 命令输出到 stdout，通过 $last_output 捕获
```

---

## 4. Approval 节点与显式决策

### 4.1 工作原理

Approval 节点是流水线中的**门控点**（gate），暂停执行等待用户做出明确选择。每个 approval 节点提供结构化的选项（A/B/C），引导用户做出具体决策。

```yaml
approval-node:
  type: approval
  prompt: |
    ## 确认信息
    这里是展示给用户的信息...

    请审查并选择：
    A) 确认，继续执行
    B) 需要修正（请说明问题）
  on_success:
    message: "已确认"
```

### 4.2 设计哲学：显式决策优于自动批准

**不使用 auto_answers**。所有 approval 节点都要求用户做出明确选择，原因：

1. **避免盲目通过**: 自动批准可能跳过需要人工审查的关键节点
2. **用户控制权**: 用户始终可以审查每个阶段的产出
3. **可追溯**: 每次选择都有明确的用户意图记录
4. **安全边界**: 防止在异常情况下自动推进到下一阶段

### 4.3 本流水线的 Approval 策略

| 节点 | 选项 | 理由 |
|------|------|------|
| `init-confirm` | A) 继续 / B) 修正 | 确认环境和拓扑扫描结果 |
| `idea-confirm` | A) 进入澄清 / B) 补充 / C) 重新生成 | 审查 6 专家分析质量 |
| `clarification-approval` | A) 继续讨论 / B) 进入下一阶段 / C) 补充话题 | 用户回答澄清问题 |
| `stories-approval` | A) 确认 / B) 修改 / C) 新增 | 审查用户故事完整性 |
| `spec-confirm` | A) 批准 / B) 调整 | 审查技术规范和跨项目服务链 |
| `task-confirm` | A) 开始执行 / B) 调整 | 审查按项目分组的任务计划 |
| `fix-exhausted` | A) 修复指导 / B) 跳过 / C) 终止 | 修复耗尽时必须人工介入 |
| `ship-confirm` | A) 确认完成 / B) 补充操作 | 确认发布结果 |

### 4.4 Notify 集成

当 approval 节点 `on_error` 触发时，通过 `xzf_hermes` 通道发送通知:

```yaml
on_error:
  notify:
    channel: xzf_hermes
    message: "XZF Pipeline: {stage} 需要人工介入"
```

---

## 5. Loop 节点与退出条件

### 5.1 Loop 结构

```yaml
my-loop:
  type: loop
  max_iterations: 20          # 安全上限，防止无限循环
  on_exit:
    message: "循环结束，共 $iteration 轮"

  nodes:
    # 循环体内的节点（按 depends_on 顺序执行）
    step-swarm:
      type: swarm
      ...
    check-complete:
      type: condition
      depends_on: [step-swarm]
      if: "$step-swarm.output contains '===COMPLETE==='"
      then: break
      else: continue
    step-approval:
      type: approval
      depends_on: [check-complete]
      ...
```

### 5.2 退出机制：Agent 信号 + Condition 节点

循环退出采用 **agent 信号 + condition 节点** 模式，而非 `exit_condition` 表达式：

1. **Swarm/Agent 节点**在判定完成时，在输出末尾插入特定信号标记（如 `===CLARIFICATION_COMPLETE===`）
2. **Condition 节点**检查输出是否包含该信号：
   - 包含信号 → `break`（退出循环）
   - 未包含 → `continue`（继续到 approval 节点，获取用户输入后进入下一轮）
3. **Approval 节点**在 condition 之后，仅在未退出时执行

优势：
- 退出决策由 AI Agent 做出，而非依赖用户输入特定关键词
- 更智能的完成判定（Agent 可以综合多维度判断）
- 用户始终有选择权（approval 节点提供结构化选项）

### 5.3 本流水线的循环设计

#### Clarification Loop (阶段 3)

```
┌──────────────────────────────────────────────────────────┐
│  clarification-loop (max 20 轮)                           │
│                                                           │
│  ┌─────────────────┐    ┌────────────────┐               │
│  │ clarification-  │──→ │ check-complete │               │
│  │ swarm           │    │ (condition)    │               │
│  │ (生成澄清问题)    │    └───────┬────────┘               │
│  │ + 完成信号判定    │         ┌───┴───┐                  │
│  └─────────────────┘    break│       │continue           │
│                              │  ┌────┴─────────────┐     │
│                              │  │ clarification-   │     │
│                              │  │ approval         │     │
│                              │  │ (用户选择 A/B/C)   │     │
│                              │  └──────────────────┘     │
│                              │         → 下一轮           │
└──────────────────────────────┴───────────────────────────┘
```

- **退出信号**: `===CLARIFICATION_COMPLETE===`
- **判定者**: clarification-swarm（agent 综合需求清晰度判断）
- **安全上限**: 20 轮

#### Stories Loop (阶段 4)

```
┌──────────────────────────────────────────────────────────┐
│  stories-loop (max 10 轮)                                 │
│                                                           │
│  ┌─────────────────┐    ┌────────────────┐               │
│  │ stories-swarm   │──→ │ stories-check- │               │
│  │ (debate 2轮)    │    │ complete       │               │
│  │ + 完成信号判定    │    └───────┬────────┘               │
│  └─────────────────┘         ┌───┴───┐                  │
│                          break│       │continue           │
│                              │  ┌────┴─────────────┐     │
│                              │  │ stories-approval │     │
│                              │  │ (用户选择 A/B/C)   │     │
│                              │  └──────────────────┘     │
│                              │         → 下一轮           │
└──────────────────────────────┴───────────────────────────┘
```

- **退出信号**: `===STORIES_COMPLETE===`
- **判定者**: stories-swarm（agent 综合故事完整性和用户确认判断）
- **安全上限**: 10 轮

#### Execution Loop (阶段 7)

```
┌──────────────────────────────────────────────────────────────┐
│  execution-loop (max 50 个任务)                                │
│                                                               │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                 │
│  │ get-task │──→│ execute  │──→│ verify   │                 │
│  │ (+project)│  │ (+project │  │ (build/  │                 │
│  │           │   │  context) │  │  test)   │                 │
│  └──────────┘   └──────────┘   └──────────┘                 │
│                                       │                       │
│                              ┌────────┴────────┐             │
│                              │ check-verification│            │
│                              └────────┬────────┘             │
│                          PASS │         │ FAIL                │
│                     ┌─────────┘    ┌────┴──────┐             │
│                     │ task-passed  │ task-failed│             │
│                     │ index++      └────┬──────┘             │
│                     │              retry<3?                   │
│                     │              ├─ Yes → fix-task (swarm) │
│                     │              │    → goto verify        │
│                     │              └─ No  → fix-exhausted   │
│                     │                       (approval A/B/C) │
└──────────────────────────────────────────────────────────────┘
```

- **退出条件**: `$vars.current_task_index >= $vars.total_tasks`（任务计数器）
- **触发**: 所有任务执行完毕（通过或被跳过）
- **安全上限**: 50 个任务
- **修复循环**: 每个任务最多 3 次修复重试
- **项目上下文**: 每个任务标注所属项目，执行 agent 在正确目录中操作

### 5.4 Loop 内的 `$iteration` 变量

- `$iteration` 是 1-based 的整数
- 仅在 loop 节点的子节点中可用
- 常用于: 文件命名（`questions-round-$iteration.md`）、prompt 注入（`第 $iteration 轮`）

---

## 6. Swarm expert_defaults.skills 传播机制

### 6.1 传播规则

`expert_defaults` 中定义的属性会**自动传播**到所有 `experts`，除非 expert 自身定义了同名属性（覆盖）。

```yaml
expert_defaults:
  engine: claude          # 所有 expert 默认使用 claude 引擎
  model: sonnet           # 所有 expert 默认使用 sonnet 模型
  skills:                 # 所有 expert 默认加载这些 skills
    - octo-workflow-dev
    - octo-swarm-dev
  context_files:          # 所有 expert 默认加载这些上下文文件
    - CLAUDE.md

experts:
  - name: architect
    agent: .claude/agents/octo-xzf-architect.md
    skills:                # 覆盖 expert_defaults.skills
      - octo-source-analyzer  # 仅加载此 skill，不加载默认的
    # model: 未定义 → 继承 expert_defaults.model = sonnet
    # engine: 未定义 → 继承 expert_defaults.engine = claude
    # context_files: 未定义 → 继承 expert_defaults.context_files = [CLAUDE.md]

  - name: pm
    agent: .claude/agents/octo-xzf-pm.md
    skills:
      - octo-resource-manager  # 覆盖默认 skills
    # 其余继承 expert_defaults
```

### 6.2 传播矩阵

| 属性 | expert_defaults 定义 | expert 覆盖 | 最终值 |
|------|---------------------|------------|--------|
| `engine` | claude | — | claude |
| `model` | sonnet | — | sonnet |
| `skills` | [workflow-dev, swarm-dev] | [source-analyzer] | [source-analyzer] |
| `context_files` | [CLAUDE.md] | — | [CLAUDE.md] |

> **注意**: 当前设计中 `skills` 是**覆盖**而非**合并**。如果 expert 定义了 `skills`，则完全替代 `expert_defaults.skills`。
>
> 如果未来需要合并行为（expert 的 skills 追加到 defaults 之上），需要 ExpertDef 的 `skills` 扩展支持 `merge` 策略:
> ```yaml
> expert_defaults:
>   skills:
>     merge: append  # append | replace (default: replace)
>     items:
>       - octo-workflow-dev
>       - octo-swarm-dev
> ```

### 6.3 本流水线的 Skills 分配

| 专家 | expert_defaults.skills | expert.skills (覆盖) | 最终加载 |
|------|----------------------|---------------------|---------|
| architect | workflow-dev, swarm-dev | octo-source-analyzer | source-analyzer |
| PM | workflow-dev, swarm-dev | octo-resource-manager | resource-manager |
| test-architect | workflow-dev, swarm-dev | — | workflow-dev, swarm-dev |
| frontend | workflow-dev, swarm-dev | — | workflow-dev, swarm-dev |
| backend | workflow-dev, swarm-dev | — | workflow-dev, swarm-dev |
| security | workflow-dev, swarm-dev | — | workflow-dev, swarm-dev |

---

## 7. 错误处理策略

### 7.1 错误处理层级

```
Level 1: 节点级 on_error
  └─ 每个节点定义自己的错误处理

Level 2: 阶段级 notify + approval
  └─ 关键阶段失败时通知 xzf_hermes + 等待人工介入

Level 3: 全局 config.on_error
  └─ 未定义 on_error 的节点使用全局策略
```

### 7.2 各阶段错误策略

| 阶段 | on_error | 理由 |
|------|---------|------|
| **init** | `fail` | 初始化失败说明环境有问题，直接终止 |
| **idea** | `notify_and_pause` | 通知 + 人工检查需求是否合理 |
| **clarification** | `notify_and_pause` | 澄清过程异常，需要人工介入 |
| **stories** | `notify_and_pause` | 故事生成异常，需要人工调整需求 |
| **spec-design** | `notify_and_pause` | 技术设计失败，需要架构师介入 |
| **task-planning** | `notify_and_pause` | 任务拆分异常，需要 PM 介入 |
| **execution** | 分级处理 (见下) | 执行阶段的错误处理更精细 |
| **ship** | `notify` | 发布失败通知即可，代码已在本地 |

### 7.3 执行阶段精细错误处理

```
任务执行失败
  │
  ├─ 验证失败 (build/test/lint)
  │   │
  │   ├─ 重试次数 < 3
  │   │   └─ swarm 6 专家分析修复 → 重新验证
  │   │
  │   └─ 重试次数 ≥ 3
  │       └─ approval 人工介入
  │           ├─ 用户提供修复指导 → 重试
  │           ├─ 用户输入 "skip" → 跳过任务
  │           └─ 用户输入 "abort" → 终止流水线
  │
  └─ Notify 通知
      └─ channel: xzf_hermes
         message: "任务执行失败，修复重试耗尽"
```

### 7.4 Notify 通道配置

```yaml
# 在 octopus 配置中定义 xzf_hermes 通道
notify:
  channels:
    xzf_hermes:
      type: webhook  # 或 slack, email, etc.
      url: "${XZF_HERMES_WEBHOOK_URL}"
      template: |
        🔴 XZF Pipeline Alert
        Stage: {stage}
        Node: {node}
        Error: {error}
        Time: {timestamp}
        Action Required: {action}
```

### 7.5 错误恢复

流水线支持从 checkpoint 恢复:

```yaml
# 每个阶段完成后自动保存 checkpoint
config:
  checkpoint:
    enabled: true
    directory: "$vars.output_dir/.checkpoints/"
    strategy: per_stage  # 每个阶段一个 checkpoint

# 恢复执行
# octopus workflow run xzf-pipeline.yaml --resume
```

---

## 8. 节点依赖图

### 8.1 全局依赖链

```
init-branch ──┐
              ├── init-dirs ── init-workspace ──┐
init-remote ──┘                                 ├── init-confirm ──→ idea ──→ idea-confirm
                                                │                              │
                                                │                              ▼
                                                │                    clarification-loop
                                                │                    ├── clarification-swarm
                                                │                    ├── check-complete (break/continue)
                                                │                    └── clarification-approval (loop)
                                                │                              │
                                                │                              ▼
                                                │                    clarification-summary
                                                │                              │
                                                │                              ▼
                                                │                    stories-loop
                                                │                    ├── stories-swarm
                                                │                    ├── stories-check-complete (break/continue)
                                                │                    └── stories-approval (loop)
                                                │                              │
                                                │                              ▼
                                                │                    spec-design ──→ spec-confirm
                                                │                                        │
                                                │                                        ▼
                                                │                    task-planning ──→ task-confirm
                                                │                                         │
                                                │                                         ▼
                                                │                    execution-loop
                                                │                    ├── get-current-task (+project)
                                                │                    ├── execute-task (+project ctx)
                                                │                    ├── verify-task
                                                │                    ├── check-verification
                                                │                    │   ├── task-passed (PASS)
                                                │                    │   └── fix-task → verify (FAIL)
                                                │                    └── fix-exhausted (3x FAIL)
                                                │                              │
                                                │                              ▼
                                                │                    ship-detect
                                                │                    ├── ship-github
                                                │                    ├── ship-gitlab
                                                │                    └── ship-local
                                                │                              │
                                                │                              ▼
                                                └────────────────────── ship-confirm
```

### 8.2 并行节点

以下节点组可以**并行执行**:

- `init-branch` + `init-remote`（无依赖）
- `spec-design` 内部的 DAG:
  - 第一批: `architect` + `pm`（并行）
  - 第二批: `test-architect` + `frontend` + `backend`（并行）
  - 第三批: `security`（等待前两批完成）

### 8.3 条件分支

```
ship-detect (condition)
  ├── github  → ship-github  ──┐
  ├── gitlab  → ship-gitlab  ──┤── ship-confirm
  └── default → ship-local   ──┘

check-verification (condition)
  ├── PASS → task-passed
  └── FAIL → task-failed
              ├── retry < 3 → fix-task → goto verify-task
              └── retry ≥ 3 → fix-exhausted (approval A/B/C)

clarification-loop 内部:
  check-complete (condition)
    ├── break → 退出循环，进入 clarification-summary
    └── continue → clarification-approval → 下一轮

stories-loop 内部:
  stories-check-complete (condition)
    ├── break → 退出循环，进入 spec-design
    └── continue → stories-approval → 下一轮
```

---

## 附录 A: Agent 文件清单

| Agent 文件 | 用途 |
|-----------|------|
| `.claude/agents/octo-xzf-architect.md` | 系统架构师 |
| `.claude/agents/octo-xzf-pm.md` | 产品经理 |
| `.claude/agents/octo-xzf-test-architect.md` | 测试架构师 |
| `.claude/agents/octo-xzf-frontend.md` | 前端工程师 |
| `.claude/agents/octo-xzf-backend.md` | 后端工程师 |
| `.claude/agents/octo-xzf-security.md` | 安全专家 |
| `.claude/agents/octo-xzf-implementer.md` | 任务执行者 (execution 阶段) |

## 附录 B: 输出目录结构

```
.octopus/xzf/{branch}/
├── workspace-topology.md               # Workspace 项目拓扑（init-workspace 产出）
├── idea/
│   └── idea.md                          # 6 专家需求分析
├── clarification/
│   ├── questions-round-1.md             # 第 1 轮澄清问题（含 Research 项）
│   ├── questions-round-2.md             # 第 2 轮澄清问题
│   ├── ...
│   └── clarified-spec.md               # 最终需求规格（按项目分组 + 跨项目依赖）
├── stories/
│   ├── stories-round-1.md              # 第 1 轮用户故事（标注所属项目）
│   ├── stories-round-2.md              # 第 2 轮用户故事
│   └── stories.md                      # 最终确认的用户故事
├── spec/
│   ├── DESIGN-INDEX.md                 # 设计文档索引
│   ├── architecture.md                 # 架构设计
│   ├── functional-spec.md             # 功能规格
│   ├── cross-project-chains.md        # 跨项目服务链
│   ├── test-strategy.md               # 测试策略
│   ├── frontend-design.md             # 前端设计
│   ├── api-design.md                  # API 设计
│   └── security-review.md             # 安全评审
├── tasks/
│   ├── tasks.md                        # 任务计划（按项目分组，ID: task-{X}-{Y}-{project}-{role}）
│   └── consensus.md                    # 专家共识（按项目列出变更）
├── execution/
│   ├── task-1-1-shared-backend-log.md  # 任务执行日志（含项目标识）
│   ├── task-1-2-engine-backend-log.md  # 任务执行日志
│   ├── ...
│   └── completed.md                    # 已完成任务清单
├── ship/
│   └── ship-report.md                  # 发布报告
└── .checkpoints/
    ├── stage-1-init.json
    ├── stage-2-idea.json
    └── ...
```

## 附录 C: 执行命令

```bash
# 完整执行
octopus workflow run packages/core-pack/workflows/xzf-pipeline.yaml \
  --org xzf \
  --set user_idea="实现用户认证模块"

# 从 checkpoint 恢复
octopus workflow run packages/core-pack/workflows/xzf-pipeline.yaml \
  --org xzf \
  --resume

# 验证 YAML 语法
octopus workflow validate packages/core-pack/workflows/xzf-pipeline.yaml

# 只执行到特定阶段
octopus workflow run packages/core-pack/workflows/xzf-pipeline.yaml \
  --org xzf \
  --set user_idea="..." \
  --stop-after task-confirm
```
