import { randomUUID } from "crypto"
import fs from "fs"
import path from "path"
import os from "os"
import { WorkspaceDAO } from "../db/dao"
import type { WorkspaceRow } from "../db/types"
import { logError } from "../file-logger"
import { getArchiveService } from "./archive/archive-service"
import { WorkspaceScaffold, DEFAULT_PIPELINE_YAML } from "./workspace-scaffold"
import { WorkspaceGit } from "./workspace-git"

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

export class WorkspaceService {
  private dao: WorkspaceDAO
  private scaffold = new WorkspaceScaffold()
  private git = new WorkspaceGit()

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
    this.scaffold.copyRulesTemplate(rulesDir, input.org)

    // Write config.json (bridge to CLI workspace system)
    this.scaffold.writeConfigJson(resolvedPath, input.name, input.repos ?? [], branchName)
    // Copy octo-dev-copilot skill to workspace for Claude Code
    this.scaffold.copySkill(resolvedPath)
    // Copy core agents (devil-advocate, code-reviewer, vision-analyzer) to workspace
    this.scaffold.copyAgents(resolvedPath)

    this.dao.insert({
      id, name: input.name, org: input.org,
      description: input.description ?? null,
      status: "active", path: input.path,
      created_at: now, updated_at: now,
    })

    // Always write base CLAUDE.md
    this.scaffold.writeBaseClaudeMd(resolvedPath, input.name)

    // Init worktrees - will overwrite CLAUDE.md with full version on success
    let worktreeStatus: { created: number; failed: string[] } | undefined
    if (input.repos && input.repos.length > 0) {
      worktreeStatus = this.git.initWorktreesSync(resolvedPath, input.repos, input.org, input.name, branchName)
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
    this.scaffold.copyRulesTemplate(rulesDir, input.org)

    // Copy skills & agents
    this.scaffold.copySkill(wsDir)
    this.scaffold.copyAgents(wsDir)

    // Copy built-in workflows from ~/.octopus/resources/installed/workflows/
    this.scaffold.copyBuiltInWorkflows(wsDir)

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
    this.scaffold.writeBaseClaudeMd(wsDir, input.name)

    // DB INSERT with source tracking
    this.dao.insert({
      id, name: input.name, org: input.org,
      description: null,
      status: "active", path: wsDir,
      source: 'scheduler', source_schedule_id: input.source_schedule_id,
      created_at: now, updated_at: now,
    })

    // Initialize worktrees from ProjectSpec (uses source_path directly)
    this.git.initWorktreesFromSpec(wsDir, input.projects, input.branch_prefix, input.branch_suffix, input.name)

    return this.getById(id)!
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

    // Two-phase archive before cascade delete
    const archiveSvc = getArchiveService()
    if (archiveSvc) {
      try {
        await archiveSvc.archiveWorkspace(id, this.dao)
      } catch (err) {
        logError("workspace archive during delete failed", err, { workspaceId: id })
        // Don't cascade delete if archive failed — data preservation
        throw err
      }
    }

    // Cascade delete: workspace + all related records (executions, chat, etc.)
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
