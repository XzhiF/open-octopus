import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import fs from "fs"
import path from "path"
import os from "os"
import { WorkspaceDAO } from "../db/dao"
import type { WorkspaceRow } from "../db/types"

/**
 * Default pipeline.yaml template — auto-generated for new workspaces.
 * Contains production-ready defaults with inline documentation.
 * See pipeline-guide.md for detailed reference.
 */
const DEFAULT_PIPELINE_YAML = `# Octopus Pipeline v2 配置
# 详细说明: 参见 docs/octopus/pipeline-guide.md
#
# 没有此文件时，引擎使用 fail_fast + 无重试的默认行为。
# 修改后下次执行自动生效，无需重启服务。

apiVersion: octopus/v2
kind: Pipeline

# ── 执行链策略 ────────────────────────────────────────────
chain:
  auto_execute: true            # 自动按树结构依次执行 pending 节点
  failure_strategy: stop        # stop | continue | retry_leaf — 任一节点失败立即停止链
  on_success: continue          # continue | stop
  config_change_strategy: snapshot  # snapshot | abort — 执行中配置变更策略

# ── Prompt 注入 ───────────────────────────────────────────
prompts:
  global: []                    # 注入到所有 agent 节点的全局 prompt
  targeted: []                  # 按 workflow + node 精确注入
  # 示例:
  # targeted:
  #   - workflow: "hermes-dev-flow"
  #     node: "e2e-test"
  #     prompt: "使用 Playwright 执行 E2E 测试"

# ── 全局 Hook ─────────────────────────────────────────────
# 优先级: workflow hooks > pipeline hooks（按事件类型独立判断）
# 空数组 [] 表示显式覆盖（不执行任何 hook）
hooks: {}
  # 示例:
  # on_node_success:
  #   - id: notify-success
  #     type: bash
  #     bash: hermes send -t "$vars.notify_target" "✅ $hook.node_id 完成"
  # on_workflow_failure:
  #   - id: notify-fail
  #     type: bash
  #     bash: hermes send -t "$vars.notify_target" "❌ 工作流失败"

# ── 执行策略 ──────────────────────────────────────────────
execution:
  failure_strategy: fail_fast   # fail_fast | continue | skip
  timeout: 86400                # 工作流总超时（秒），0 = 不限
  resume_on_interrupt: auto     # manual | auto — 服务重启后是否自动恢复
  auto_resume_max_attempts: 3   # auto 模式最大恢复次数
  auto_resume_delay: 10         # 恢复前延迟（秒）

# ── 自动重试 ──────────────────────────────────────────────
retry:
  default:
    max_attempts: 3             # 节点失败自动重试（首次 + 重试次数）
    backoff:
      type: exponential         # fixed | exponential | linear
      initial_delay: 5          # 首次重试延迟（秒）
      multiplier: 2             # exponential 模式的倍数
      max_delay: 300            # 最大延迟上限（秒）
    retry_on:                   # 哪些错误类型触发重试
      - exit_code_nonzero
      - timeout
      - agent_stream_error
      - transient_error
    never_retry_on:             # 哪些错误类型永不重试
      - approval_rejected
      - user_cancelled
      - config_error
  # 按节点 ID 覆盖
  overrides: {}

# ── Fork 分支控制 ─────────────────────────────────────────
fork:
  path_strategy: all            # all | primary
  merge_strategy: wait_all      # wait_all | wait_any | first_complete
  failure_handling: fail_all    # fail_all | best_effort

# ── Checkpoint 中断恢复 ──────────────────────────────────
checkpoint:
  enabled: true
  save_on: per-node             # per-node | per-level | per-batch
  max_checkpoints: 10
  ttl: 86400                    # 有效期（秒）
  max_size_bytes: 1048576       # 单检查点大小上限（字节）
`

/**
 * Pipeline Guide — detailed reference for pipeline.yaml configuration.
 * Auto-generated as pipeline-guide.md in workspace root.
 */
const PIPELINE_GUIDE_MD = `# Pipeline v2 配置指南

## 快速开始

\`pipeline.yaml\` 位于工作空间根目录，控制工作流的执行行为。
没有此文件时，引擎使用 **fail_fast + 无重试** 的默认行为。

修改后下次执行自动生效，**无需重启服务**。

## 七大功能模块

### 1. 执行链（chain）

控制多个 execution 节点的自动编排。

| 配置 | 选项 | 说明 |
|------|------|------|
| \`auto_execute\` | \`true\`/\`false\` | 自动按树结构依次执行 pending 节点 |
| \`failure_strategy\` | \`stop\` | 任一节点失败立即停止链 |
| | \`continue\` | 标记失败，继续执行后续节点 |
| | \`retry_leaf\` | 叶子节点失败时自动重试 |
| \`on_success\` | \`continue\` | 成功后继续执行子节点 |
| | \`stop\` | 成功后停止 |
| \`config_change_strategy\` | \`snapshot\` | 执行中使用启动时的配置快照 |
| | \`abort\` | 配置变更时中止执行 |

**执行顺序**：由 execution 树结构决定（非静态列表），支持运行中动态增删节点。

### 2. Prompt 注入（prompts）

为 agent 节点注入额外的系统级指令。

| 配置 | 说明 |
|------|------|
| \`global\` | 字符串数组，注入到所有 agent 节点 |
| \`targeted\` | 按 workflow + node 精确匹配注入 |

\`\`\`yaml
prompts:
  global:
    - "所有代码修改必须通过 code-reviewer 审查"
  targeted:
    - workflow: "hermes-dev-flow"
      node: "e2e-test"
      prompt: "使用 Playwright 执行 E2E 测试"
    - workflow: "*"
      node: "*"
      prompt: "禁止执行 pkill 或 killall 命令"
\`\`\`

总长度限制 5000 字符，超出时按优先级截断。

### 3. 全局 Hook（hooks）

在 workflow 级别未定义 hook 时，pipeline 级 hook 作为 fallback。

**优先级规则**：按事件类型独立判断（非整体替换）
- workflow 定义了该事件（包括 \`[]\`）→ 使用 workflow hooks
- workflow 未定义该事件 → 使用 pipeline hooks

支持事件：\`on_node_success\`、\`on_node_failure\`、\`on_workflow_failure\`、\`on_cancel\`、\`on_interrupt\`、\`on_retry\`、\`on_success\`、\`on_complete\`

\`\`\`yaml
hooks:
  on_workflow_failure:
    - id: notify-fail
      type: bash
      bash: hermes send -t "$vars.notify_target" "❌ 失败"
  on_node_success:
    - id: log-success
      type: bash
      bash: echo "✅ $hook.node_id 完成 ($hook.duration_ms ms)"
\`\`\`

### 4. 失败策略（execution.failure_strategy）

| 策略 | 行为 | 适用场景 |
|------|------|---------|
| \`fail_fast\` | 任一节点失败，立即中止 | 关键路径、部署流程 |
| \`continue\` | 标记失败节点，继续后续 | 非关键节点可容忍失败 |
| \`skip\` | 失败节点 + 级联跳过下游 | 下游依赖失败节点无意义 |

**终态说明：**
- \`completed\` — 所有节点成功
- \`completed_with_failures\` — 部分失败但执行完毕
- \`failed\` — 因失败中止

### 5. 自动重试（retry）

#### 退避策略

| 类型 | 公式 | 示例（initial=5s） |
|------|------|-------------------|
| \`fixed\` | 恒定 | 5s, 5s, 5s, ... |
| \`exponential\` | initial × multiplier^(n-1) | 5s, 10s, 20s, 40s, ... |
| \`linear\` | initial + increment × (n-1) | 5s, 10s, 15s, 20s, ... |

#### 错误分类

| 条件 | 默认重试？ |
|------|-----------|
| \`exit_code_nonzero\` | ✅ |
| \`timeout\` | ✅ |
| \`agent_stream_error\` | ✅ |
| \`transient_error\` | ✅ |
| \`approval_rejected\` | ❌ |
| \`user_cancelled\` | ❌ |
| \`config_error\` | ❌ |

#### 节点级覆盖

\`\`\`yaml
retry:
  overrides:
    deploy-prod:
      max_attempts: 1        # 部署不重试
    "test-*":
      max_attempts: 5        # glob 匹配
\`\`\`

### 6. Fork 分支控制（fork）

| 配置 | 选项 | 说明 |
|------|------|------|
| \`path_strategy\` | \`all\` / \`primary\` | 执行所有/仅 primary 分支 |
| \`merge_strategy\` | \`wait_all\` / \`wait_any\` / \`first_complete\` | 合并策略 |
| \`failure_handling\` | \`fail_all\` / \`best_effort\` | 失败处理 |

### 7. Checkpoint 中断恢复（checkpoint）

**存储位置：** \`.octopus/checkpoints/{executionId}/\`

| 配置 | 默认值 | 说明 |
|------|--------|------|
| \`enabled\` | \`true\` | 是否启用 |
| \`save_on\` | \`per-node\` | 保存时机 |
| \`max_checkpoints\` | \`10\` | 最多保留数 |
| \`ttl\` | \`86400\` | 有效期（秒） |
| \`max_size_bytes\` | \`1048576\` | 大小上限（1MB） |

**中断恢复流程：**
1. 服务重启 → 检测 \`running\` 状态的执行
2. 设置 \`pending_resume\`（\`resume_on_interrupt: auto\` 时）
3. 从最近 checkpoint 恢复
4. 最多恢复 \`auto_resume_max_attempts\` 次

## 完整示例

\`\`\`yaml
apiVersion: octopus/v2
kind: Pipeline

chain:
  auto_execute: true
  failure_strategy: continue
  on_success: continue
  config_change_strategy: snapshot

prompts:
  global:
    - "所有代码修改必须通过审查"
  targeted:
    - workflow: "hermes-dev-flow"
      node: "e2e-test"
      prompt: "使用 Playwright"

hooks:
  on_workflow_failure:
    - id: notify-fail
      type: bash
      bash: hermes send -t "$vars.notify_target" "❌ 失败"

execution:
  failure_strategy: continue
  resume_on_interrupt: auto
  auto_resume_max_attempts: 3
  auto_resume_delay: 10

retry:
  default:
    max_attempts: 3
    backoff:
      type: exponential
      initial_delay: 10
      max_delay: 120
  overrides:
    deploy:
      max_attempts: 1

fork:
  path_strategy: all
  merge_strategy: wait_all
  failure_handling: fail_all

checkpoint:
  enabled: true
  save_on: per-node
\`\`\`

## 向后兼容

- 无 \`pipeline.yaml\` → 行为与旧版本完全一致
- \`chain\` 未指定 → 不自动执行（需手动触发）
- \`failure_strategy\` 未指定 → 默认 \`fail_fast\`
- \`retry.default.max_attempts\` 未指定 → 默认 \`3\`
- \`checkpoint.enabled\` 未指定 → 默认 \`true\`
- v1 格式自动升级到 v2
`


/**
 * 生成工作空间通用引导内容 — 目录结构、执行状态、依赖安装、视觉规则。
 * 所有 CLAUDE.md 生成点（writeBaseClaudeMd / initWorktreesSync）共用此函数。
 */
function workspaceGuide(): string[] {
  return [
    "",
    "## 目录结构",
    "",
    "```",
    "<workspace>/",
    "├── CLAUDE.md             ← 工作空间指令（本文件）",
    "├── config.json           ← 工作空间配置（名称、关联仓库、创建时间、初始分支）",
    "├── pipeline.yaml         ← Pipeline 配置（失败策略/重试/Checkpoint，详见 docs/octopus/pipeline-guide.md）",
    "├── .claude/skills/       ← 已安装的 Claude Code Skills（从 core-pack 复制）",
    "├── .octopus/             ← Octopus 运行时数据",
    "│   ├── checkpoints/        ← Checkpoint 中断恢复（每 execution 一个子目录）",
    "│   └── code-dev-copilot-rules/ ← 代码规范模板",
    "├── docs/                 ← 文档",
    "│   └── octopus/            ← Octopus 文档",
    "│       └── pipeline-guide.md   ← Pipeline 配置完整参考文档",
    "├── projects/             ← 项目代码（每个子目录是一个 git worktree）",
    "├── workflows/          ← 工作流 YAML 定义（octopus workflow run 的执行目标）",
    "├── state/              ← 执行状态记录",
    "│   ├── executions.json   ← 执行索引（所有执行的注册表）",
    "│   ├── {uuid}.json       ← 单次执行结果快照（含每个节点的 status/duration/outputs）",
    "│   └── {uuid}-{name}.yaml ← 工作流 YAML 快照",
    "├── logs/               ← 执行日志",
    "│   └── {uuid}/           ← 每次执行的日志目录",
    "│       ├── {node-id}.jsonl ← 按节点 ID 命名的 JSONL 日志",
    "│       └── final-summary.jsonl",
    "└── dependencies/       ← 外部依赖（如 agency-agents-zh 克隆）",
    "```",
    "",
    "## 执行状态与日志",
    "",
    "### state/executions.json — 执行索引",
    "顶层注册表，记录每次执行的:",
    "- `execution_id` — UUID，关联 logs/ 目录和 {uuid}.json 结果文件",
    "- `parent_id` — 父执行 ID（`\"0\"` 表示无父级，否则指向重试/续跑的源执行）",
    "- `status` — completed / failed / running",
    "- `workflow_ref` — 执行的工作流 YAML 文件名",
    "- `workflow_name` — 工作流名称",
    "- `start_commit_id` / `end_commit_id` — 各项目执行前后的 Git commit SHA",
    "",
    "### state/{uuid}.json — 执行结果",
    "包含每个节点的执行详情:",
    "- `nodes[node-id].status` — completed / failed / skipped",
    "- `nodes[node-id].durationMs` — 节点执行耗时（毫秒）",
    "- `nodes[node-id].lastOutput` — bash 节点的 stdout 输出",
    "- `nodes[node-id].exitCode` — bash 节点的退出码",
    "- `poolSnapshot` — 执行结束时的完整变量池快照（所有 $vars.* 的最终值）",
    "",
    "### 查找执行链: executions.json → {uuid}.json → logs/",
    "1. 在 `state/executions.json` 中按 `workflow_name` 或 `status` 找到目标执行",
    "2. 用 `execution_id` 打开对应的 `state/{uuid}.json` 查看节点级结果",
    "3. 用 `execution_id` 进入 `logs/{uuid}/` 目录查看节点级详细日志",
    "",
    "### logs/{uuid}/{node-id}.jsonl — 节点日志",
    "每个节点一个 JSONL 文件，包含时间戳事件:",
    "- `start` / `end` — 节点生命周期",
    "- `agent_event` — agent 节点的 thinking/text_delta/tool_call/status 事件",
    "- `bash_log` — bash 节点的 stdout 输出行",
    "",
    "## Pipeline 配置",
    "",
    "工作空间根目录的 `pipeline.yaml` 控制生产级行为（失败策略、自动重试、Checkpoint 恢复）。",
    "详细说明参见 `docs/octopus/pipeline-guide.md`。",
    "",
    "### 四大模块",
    "| 模块 | 作用 | 关键字段 |",
    "|------|------|---------|",
    "| execution | 失败策略 | `failure_strategy`: fail_fast / continue / skip |",
    "| retry | 自动重试 | `default.max_attempts`, `backoff.type`, `overrides` |",
    "| fork | 分支控制 | `path_strategy`: all / primary |",
    "| checkpoint | 中断恢复 | `enabled`, `save_on`, `max_size_bytes` |",
    "",
    "### Checkpoint 存储",
    "- 位置: `.octopus/checkpoints/{executionId}/`",
    "- 格式: `{timestamp}-{uuid}.json` + `latest.json` 指针",
    "- 内容: 已完成节点摘要 + 完整变量池快照 + Agent 会话 ID",
    "- 清理: 按 `max_checkpoints` 裁剪 + `ttl` 过期删除",
    "",
    "## 依赖安装",
    "",
    "### superpowers-zh（Claude Code 技能框架）",
    "20 个技能（brainstorming/writing-plans/TDD/verification 等），在工作流 setup 阶段自动安装:",
    "```bash",
    "npx superpowers-zh@latest --tool claude --force",
    "```",
    "安装到 `.claude/skills/` 目录。工作流 YAML 中通过 `skills:` 字段引用。",
    "",
    "### agency-agents-zh（对抗式多智能体角色库）",
    "215 个预定义代理角色（engineering/testing/design/marketing 等 18 个部门），",
    "增强版工作流在 setup 阶段按需克隆并精选复制到 `.claude/agents/`:",
    "```bash",
    "git clone --depth 1 https://github.com/jnMetaCode/agency-agents-zh.git dependencies/agency-agents-zh",
    "# 精选复制到 .claude/agents/（仅需要的部门和文件）",
    "```",
    "工作流 YAML 中通过 `agent_file:` 字段引用 `.claude/agents/` 下的 .md 文件，",
    "引擎运行时读取文件内容 + `prompt` 拼接后传给 Claude Agent SDK。",
    "",
    "## 视觉分析规则（重要）",
    "",
    "**图片数据永远不能进入主 Agent 的 session 上下文。**",
    "",
    "- 需要分析截图/图片时，必须使用 SDK 子代理（`agents` 参数定义 `vision-analyzer`）或外部工具（`python vision_analyze.py`）",
    "- 禁止父代理直接处理图片，否则会污染 session 上下文，导致后续非视觉模型节点 400 报错",
    "- 子代理有独立上下文，执行完毕后只有文本结果返回父代理",
  ]
}

export class WorkspaceService {
  private dao: WorkspaceDAO

  constructor(dao?: WorkspaceDAO) {
    this.dao = dao!
  }

  create(input: { name: string; org: string; description?: string; path: string; repos?: string[]; branch?: string }): WorkspaceRow & { worktreeStatus?: { created: number; failed: string[] } } {
    const id = randomUUID()
    const now = new Date().toISOString()
    const resolvedPath = input.path.replace(/^~/, os.homedir())
    const branchName = input.branch || input.name
    if (!fs.existsSync(resolvedPath)) {
      fs.mkdirSync(resolvedPath, { recursive: true })
    }

    const subdirs = ["projects", "workflows", "logs", "state"]
    for (const dir of subdirs) {
      const dirPath = path.join(resolvedPath, dir)
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
      }
    }

    // Create .octopus directory structure (checkpoints, rules, etc.)
    const octopusDir = path.join(resolvedPath, ".octopus")
    if (!fs.existsSync(octopusDir)) {
      fs.mkdirSync(octopusDir, { recursive: true })
    }
    const checkpointsDir = path.join(octopusDir, "checkpoints")
    if (!fs.existsSync(checkpointsDir)) {
      fs.mkdirSync(checkpointsDir, { recursive: true })
    }

    // Auto-generate pipeline.yaml with production-ready defaults
    const pipelinePath = path.join(resolvedPath, "pipeline.yaml")
    if (!fs.existsSync(pipelinePath)) {
      fs.writeFileSync(pipelinePath, DEFAULT_PIPELINE_YAML, "utf-8")
    }

    // Auto-generate pipeline-guide.md — detailed reference for pipeline.yaml
    const docsDir = path.join(resolvedPath, "docs", "octopus")
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true })
    }
    const guidePath = path.join(docsDir, "pipeline-guide.md")
    if (!fs.existsSync(guidePath)) {
      fs.writeFileSync(guidePath, PIPELINE_GUIDE_MD, "utf-8")
    }

    // Create .octopus/code-dev-copilot-rules directory and copy template rules
    const rulesDir = path.join(resolvedPath, ".octopus", "code-dev-copilot-rules")
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true })
    }
    this.copyRulesTemplate(rulesDir, input.org)

    // Write config.json (bridge to CLI workspace system)
    this.writeConfigJson(resolvedPath, input.name, input.repos ?? [], branchName)
    // Copy octo-dev-copilot skill to workspace for Claude Code
    this.copySkill(resolvedPath)
    // Copy core agents (devil-advocate, code-reviewer, vision-analyzer) to workspace
    this.copyAgents(resolvedPath)

    this.dao.insert({
      id, name: input.name, org: input.org,
      description: input.description ?? null,
      status: "active", path: input.path,
      created_at: now, updated_at: now,
    })

    // Always write base CLAUDE.md
    this.writeBaseClaudeMd(resolvedPath, input.name)

    // Init worktrees - will overwrite CLAUDE.md with full version on success
    let worktreeStatus: { created: number; failed: string[] } | undefined
    if (input.repos && input.repos.length > 0) {
      worktreeStatus = this.initWorktreesSync(resolvedPath, input.repos, input.org, input.name, branchName)
    }

    const workspace = this.getById(id)!
    return { ...workspace, worktreeStatus }
  }

  /**
   * Create a workspace from a scheduler spec.
   * Each scheduler execution creates a fresh workspace with new worktrees.
   */
  createFromSpec(input: {
    org: string
    name: string
    projects: Array<{ name: string; source_path: string }>
    branch_prefix: string
    branch_suffix: string
    source: 'scheduler'
    source_schedule_id: string
    workflow_chain: Array<{ workflow_ref: string; input_values: Record<string, string> }>
  }): WorkspaceRow {
    const id = randomUUID()
    const now = new Date().toISOString()

    // Resolve workspace path: ~/.octopus/{org}/workspaces/{name}
    const wsDir = path.join(os.homedir(), ".octopus", "orgs", input.org, "workspaces", input.name)
    if (fs.existsSync(wsDir)) {
      fs.rmSync(wsDir, { recursive: true, force: true })
    }
    fs.mkdirSync(wsDir, { recursive: true })

    // Create subdirectories
    for (const dir of ["projects", "workflows", "logs", "state"]) {
      fs.mkdirSync(path.join(wsDir, dir), { recursive: true })
    }

    // Create .octopus directory structure
    fs.mkdirSync(path.join(wsDir, ".octopus", "checkpoints"), { recursive: true })

    // Auto-generate pipeline.yaml
    const pipelinePath = path.join(wsDir, "pipeline.yaml")
    fs.writeFileSync(pipelinePath, DEFAULT_PIPELINE_YAML, "utf-8")

    // Copy rules templates
    const rulesDir = path.join(wsDir, ".octopus", "code-dev-copilot-rules")
    fs.mkdirSync(rulesDir, { recursive: true })
    this.copyRulesTemplate(rulesDir, input.org)

    // Copy skills & agents
    this.copySkill(wsDir)
    this.copyAgents(wsDir)

    // Copy built-in workflows from ~/.octopus/workflows/
    this.copyBuiltInWorkflows(wsDir)

    // Write config.json with scheduler-specific fields
    const configData: Record<string, unknown> = {
      name: input.name,
      org: input.org,
      source: input.source,
      source_schedule_id: input.source_schedule_id,
      workflow_chain: input.workflow_chain.slice(1), // remaining chain (root is triggered immediately)
      repos: [],
      created: now,
    }
    fs.writeFileSync(path.join(wsDir, "config.json"), JSON.stringify(configData, null, 2), "utf-8")

    // Write base CLAUDE.md
    this.writeBaseClaudeMd(wsDir, input.name)

    // DB INSERT with source tracking
    this.dao.insert({
      id, name: input.name, org: input.org,
      description: null,
      status: "active", path: wsDir,
      source: 'scheduler', source_schedule_id: input.source_schedule_id,
      created_at: now, updated_at: now,
    })

    // Initialize worktrees from ProjectSpec (uses source_path directly)
    this.initWorktreesFromSpec(wsDir, input.projects, input.branch_prefix, input.branch_suffix, input.name)

    return this.getById(id)!
  }

  private copyBuiltInWorkflows(workspacePath: string): void {
    const srcDir = path.join(os.homedir(), ".octopus", "workflows")
    const destDir = path.join(workspacePath, "workflows")
    if (!fs.existsSync(srcDir)) return

    const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    for (const file of files) {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file))
    }
  }

  private initWorktreesFromSpec(
    workspacePath: string,
    projects: Array<{ name: string; source_path: string }>,
    branchPrefix: string,
    branchSuffix: string,
    wsName: string,
  ): void {
    const { spawnSync } = require("child_process") as typeof import("child_process")
    const projectsDir = path.join(workspacePath, "projects")
    const entries: { name: string; main_path: string; worktree_path: string; branch: string }[] = []

    for (const proj of projects) {
      const sourcePath = proj.source_path.replace(/^~/, os.homedir())
      const branchName = `${branchPrefix}-${branchSuffix}`
      const wtDir = path.join(projectsDir, proj.name)

      if (!fs.existsSync(sourcePath) || !fs.existsSync(path.join(sourcePath, ".git"))) {
        console.log(`[WorkspaceService] source path unreachable: ${sourcePath}`)
        continue
      }

      try {
        spawnSync("git", ["worktree", "prune"], { cwd: sourcePath, timeout: 10000 })
        if (fs.existsSync(wtDir)) fs.rmSync(wtDir, { recursive: true, force: true })

        const result = spawnSync("git", ["worktree", "add", "-f", wtDir, "--detach"], {
          cwd: sourcePath, timeout: 60000,
        })
        if (result.status !== 0) {
          console.error(`[WorkspaceService] worktree add failed for ${proj.name}: ${result.stderr.toString().trim()}`)
          continue
        }

        const coResult = spawnSync("git", ["checkout", "-b", branchName], { cwd: wtDir, timeout: 30000 })
        if (coResult.status !== 0) {
          const switchResult = spawnSync("git", ["checkout", branchName], { cwd: wtDir, timeout: 30000 })
          if (switchResult.status !== 0) {
            console.error(`[WorkspaceService] branch checkout failed for ${proj.name}`)
            continue
          }
        }

        entries.push({ name: proj.name, main_path: sourcePath, worktree_path: wtDir, branch: branchName })
      } catch (e: any) {
        console.error(`[WorkspaceService] worktree failed for ${proj.name}:`, e.message)
      }
    }

    if (entries.length > 0) {
      // Update config.json with repo entries
      const configPath = path.join(workspacePath, "config.json")
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      config.repos = entries.map(e => ({
        name: e.name,
        main_path: e.main_path,
        worktree_path: e.worktree_path,
        branch: e.branch,
      }))
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")

      // Update CLAUDE.md with project listing
      const claudeLines = [
        `# 工作空间: ${wsName}`,
        "",
        "## 涉及项目 (git worktree)",
        "",
      ]
      for (const e of entries) {
        claudeLines.push(`- **${e.name}**: \`${e.worktree_path}\` [${e.branch}]`)
        claudeLines.push(`  - 主仓库: \`${e.main_path}\``)
      }
      claudeLines.push("", "## 说明", "- 此工作空间由调度器自动创建")
      fs.writeFileSync(path.join(workspacePath, "CLAUDE.md"), claudeLines.join("\n"), "utf-8")
    }
  }

  private writeBaseClaudeMd(workspacePath: string, wsName: string): void {
    const claudePath = path.join(workspacePath, "CLAUDE.md")
    if (fs.existsSync(claudePath)) return
    const lines = [
      `# 工作空间: ${wsName}`,
      "",
      "## 说明",
      "- 使用 `octo-dev-copilot` skill 管理此工作空间",
      "- 使用 `octo-workflow-dev` skill 开发与校验工作流",
      "- 使用 `octo-swarm-dev` skill 开发 Swarm 多专家协作节点",
      ...workspaceGuide(),
    ]
    fs.writeFileSync(claudePath, lines.join("\n"), "utf-8")
  }

  private writeConfigJson(workspacePath: string, name: string, repos: string[], branch?: string): void {
    const configPath = path.join(workspacePath, "config.json")
    if (fs.existsSync(configPath)) return // Don't overwrite existing
    const config: Record<string, unknown> = {
      name,
      repos: repos.map(r => {
        const parts = r.includes("/") ? r.split("/") : ["", r]
        return { group: parts[0], name: parts[1], repoName: parts[1] }
      }),
      created: new Date().toISOString(),
    }
    if (branch) config.init_branch_name = branch
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
  }

  private copySkill(workspacePath: string): void {
    const corePackRoot = this.findCorePackSkillsRoot()
    if (!corePackRoot) return
    const skillsDir = path.join(workspacePath, ".claude", "skills")
    fs.mkdirSync(skillsDir, { recursive: true })
    // Copy all core skills to workspace
    const coreSkills = ["octo-dev-copilot", "octo-workflow-dev", "octo-swarm-dev", "octo-browser-debug", "octo-browser-vision", "octo-e2e-tester"]
    for (const skillName of coreSkills) {
      const dest = path.join(skillsDir, skillName)
      if (fs.existsSync(dest)) continue
      const src = path.join(corePackRoot, skillName)
      if (fs.existsSync(path.join(src, "SKILL.md"))) {
        fs.cpSync(src, dest, { recursive: true })
        console.log(`[WorkspaceService] copied skill: ${skillName}`)
      }
    }
  }

  private findCorePackSkillsRoot(): string | null {
    const candidates = [
      path.join(process.cwd(), "..", "core-pack", "skills"),
      path.join(process.cwd(), "packages", "core-pack", "skills"),
      path.join(process.cwd(), "node_modules", "@octopus", "core-pack", "skills"),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
    return null
  }

  private copyAgents(workspacePath: string): void {
    const corePackAgentsRoot = this.findCorePackAgentsRoot()
    if (!corePackAgentsRoot) return

    const agentsDir = path.join(workspacePath, ".claude", "agents")
    fs.mkdirSync(agentsDir, { recursive: true })

    // Copy all .md files (not .md.tpl templates) from core-pack/agents/
    const coreAgents = ["devil-advocate.md", "architecture-explorer.md", "vision-analyzer.md", "testing-qa-engineer.md"]
    for (const agentFile of coreAgents) {
      const dest = path.join(agentsDir, agentFile)
      if (fs.existsSync(dest)) continue
      const src = path.join(corePackAgentsRoot, agentFile)
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest)
        console.log(`[WorkspaceService] copied agent: ${agentFile}`)
      }
    }
  }

  private findCorePackAgentsRoot(): string | null {
    const candidates = [
      path.join(process.cwd(), "..", "core-pack", "agents"),
      path.join(process.cwd(), "packages", "core-pack", "agents"),
      path.join(process.cwd(), "node_modules", "@octopus", "core-pack", "agents"),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
    return null
  }

  private copyRulesTemplate(rulesDir: string, org: string): void {
    // Copy *.md rules from multiple sources into workspace's .octopus/code-dev-copilot-rules/
    const sources = [
      // 1. Project-level: current project's .octopus/code-dev-copilot-rules/
      path.join(process.cwd(), ".octopus", "code-dev-copilot-rules"),
      // 2. Org-level: ~/.octopus/orgs/{org}/code-dev-copilot-rules/
      path.join(os.homedir(), ".octopus", "orgs", org, "code-dev-copilot-rules"),
      // 3. Core-pack skill template: packages/core-pack/skills/octo-dev-copilot/rules/
      ...this.getCorePackRulesCandidates(),
    ]
    for (const srcDir of sources) {
      if (!fs.existsSync(srcDir)) continue
      try {
        const files = fs.readdirSync(srcDir)
        for (const file of files) {
          if (file.endsWith(".md")) {
            const srcPath = path.join(srcDir, file)
            const destPath = path.join(rulesDir, file)
            if (fs.statSync(srcPath).isFile() && !fs.existsSync(destPath)) {
              fs.copyFileSync(srcPath, destPath)
            }
          }
        }
      } catch { /* source read optional */ }
    }
  }

  private getCorePackRulesCandidates(): string[] {
    return [
      path.join(process.cwd(), "..", "core-pack", "skills", "octo-dev-copilot", "rules"),
      path.join(process.cwd(), "packages", "core-pack", "skills", "octo-dev-copilot", "rules"),
      path.join(process.cwd(), "node_modules", "@octopus", "core-pack", "skills", "octo-dev-copilot", "rules"),
    ]
  }

  private initWorktreesSync(workspacePath: string, repoSpecs: string[], org: string, wsName: string, branch?: string): { created: number; failed: string[] } {
    const failed: string[] = []
    const indexPath = path.join(os.homedir(), ".octopus", "orgs", org, "repos", "index.md")
    if (!fs.existsSync(indexPath)) {
      console.log("[WorkspaceService] index.md not found, skipping worktree init")
      return { created: 0, failed: repoSpecs.map(spec => `${spec}: index.md not found`) }
    }

    const { spawnSync } = require("child_process") as typeof import("child_process")

    const projectsDir = path.join(workspacePath, "projects")
    const entries: { name: string; group: string; main_path: string; worktree_path: string }[] = []

    const indexContent = fs.readFileSync(indexPath, "utf-8").replace(/\r\n/g, "\n")

    for (const spec of repoSpecs) {
      const parts = spec.includes("/") ? spec.split("/") : [org, spec]
      const [group, name] = parts
      const wtDir = path.join(projectsDir, `${group}-${name}`)

      const localMatch = new RegExp(`### ${name}\\n[^#]*?- local: (.+?)(?: ✓| —|$)`, "s").exec(indexContent)
      if (!localMatch) {
        const reason = `${spec}: not found in index.md`
        console.log(`[WorkspaceService] ${reason}`)
        failed.push(reason)
        continue
      }

      let localPath = localMatch[1].trim()
      if (localPath.startsWith("~")) localPath = localPath.replace(/^~/, os.homedir())

      if (!fs.existsSync(localPath) || !fs.existsSync(path.join(localPath, ".git"))) {
        const reason = `${spec}: local path unreachable: ${localPath}`
        console.log(`[WorkspaceService] ${reason}`)
        failed.push(reason)
        continue
      }

      try {
        spawnSync("git", ["worktree", "prune"], { cwd: localPath, timeout: 10000 })
        if (fs.existsSync(wtDir)) fs.rmSync(wtDir, { recursive: true, force: true })
        const result = spawnSync("git", ["worktree", "add", "-f", wtDir, "--detach"], { cwd: localPath, timeout: 60000 })
        if (result.status !== 0) {
          const reason = `${spec}: worktree add failed: ${result.stderr.toString().trim()}`
          console.error(`[WorkspaceService] ${reason}`)
          failed.push(reason)
          continue
        }
        if (branch) {
          const coResult = spawnSync("git", ["checkout", "-b", branch], { cwd: wtDir, timeout: 30000 })
          if (coResult.status !== 0) {
            // branch may already exist, try switching
            const switchResult = spawnSync("git", ["checkout", branch], { cwd: wtDir, timeout: 30000 })
            if (switchResult.status !== 0) {
              const reason = `${spec}: branch checkout failed: ${switchResult.stderr.toString().trim()}`
              console.error(`[WorkspaceService] ${reason}`)
              failed.push(reason)
              // clean up failed worktree
              spawnSync("git", ["worktree", "remove", "-f", wtDir], { cwd: localPath, timeout: 10000 })
              continue
            }
          }
        }
        entries.push({ name, group, main_path: localPath, worktree_path: wtDir })
        console.log(`[WorkspaceService] worktree created: ${group}-${name} → ${wtDir}${branch ? ` [${branch}]` : ''}`)
      } catch (e: any) {
        const reason = `${spec}: ${e.message}`
        console.error(`[WorkspaceService] worktree failed for ${group}/${name}:`, e.message)
        failed.push(reason)
      }
    }

    if (entries.length > 0) {
      const configPath = path.join(workspacePath, "config.json")
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      config.repos = entries.map(e => ({ name: e.name, group: e.group, main_path: e.main_path, worktree_path: e.worktree_path }))
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")

      const claudeLines = [
        `# 工作空间: ${wsName}`,
        "",
        "## 涉及项目 (git worktree)",
        "",
        "各项目通过 git worktree 链接到主仓库，在此目录内编码，不影响主仓库分支。",
        "",
      ]
      for (const e of entries) {
        claudeLines.push(`- **${e.group}-${e.name}**: \`${e.worktree_path}\``)
        claudeLines.push(`  - 主仓库: \`${e.main_path}\``)
      }
      claudeLines.push("", "## 说明", "- 使用 `octo-dev-copilot` skill 管理此工作空间", "- 使用 `octo-workflow-dev` skill 开发与校验工作流", "- 使用 `octo-swarm-dev` skill 开发 Swarm 多专家协作节点", "- 修改代码时直接操作各 worktree 目录", "- 主仓库保持干净，开发分支仅在 worktree 中")
      claudeLines.push(...workspaceGuide())
      fs.writeFileSync(path.join(workspacePath, "CLAUDE.md"), claudeLines.join("\n"), "utf-8")
    } else {
      console.log("[WorkspaceService] no worktrees created — repos may not be cloned locally")
    }

    return { created: entries.length, failed }
  }

  list(org?: string, source?: 'user' | 'scheduler' | 'all'): WorkspaceRow[] {
    return this.dao.findAll(org, source)
  }

  getById(id: string): WorkspaceRow | undefined {
    return this.dao.findById(id) ?? undefined
  }

  update(id: string, input: { name?: string; org?: string; description?: string; status?: string }): WorkspaceRow | undefined {
    const existing = this.getById(id)
    if (!existing) return undefined

    const fields: Record<string, unknown> = {}
    if (input.name !== undefined) fields.name = input.name
    if (input.org !== undefined) fields.org = input.org
    if (input.description !== undefined) fields.description = input.description
    if (input.status !== undefined) fields.status = input.status

    if (Object.keys(fields).length === 0) return existing

    this.dao.update(id, fields)
    return this.getById(id)!
  }

  async delete(id: string): Promise<boolean> {
    const ws = this.getById(id)
    if (!ws) return false

    // P1.5: Two-stage delete — archive first, then cascade
    const { getArchiveService } = require("./archive/archive-registry")
    const archiveService = getArchiveService()

    if (archiveService) {
      try {
        archiveService.archiveWorkspace(id)
      } catch (err) {
        // Archive failed — don't delete, preserve data
        console.error(`[workspace] Archive failed for ${id}, skipping delete:`, err)
        return false
      }
    }

    this.dao.cascadeDeleteByWorkspace(id)

    // ── 文件系统异步删除（不阻塞事件循环） ──
    const resolvedPath = ws.path.replace(/^~/, os.homedir())
    if (fs.existsSync(resolvedPath)) {
      fs.promises
        .rm(resolvedPath, { recursive: true, force: true })
        .catch((err) => {
          // 后台删除失败不影响 API 响应，仅记录日志
          console.error(`[workspace] Failed to delete directory ${resolvedPath}:`, err)
        })
    }

    return true
  }
}
