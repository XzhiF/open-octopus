// packages/server/src/services/workspace-scaffold.ts
//
// Workspace scaffolding — template copying and file generation for new workspaces.
// Extracted from WorkspaceService to reduce god class size.
//
import fs from "fs"
import path from "path"
import os from "os"

/**
 * Default pipeline.yaml template — auto-generated for new workspaces.
 */
export const DEFAULT_PIPELINE_YAML = `# Octopus Pipeline v2 配置
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

# ── 重试策略 ──────────────────────────────────────────────
retry:
  default:
    max_attempts: 3             # 每个节点默认最多重试 3 次
    delay_ms: 5000              # 重试间隔 5 秒
    backoff_multiplier: 2       # 指数退避: 5s → 10s → 20s
  by_type:
    agent:
      max_attempts: 2           # Agent 节点重试 2 次（LLM 调用昂贵）
      delay_ms: 3000
    bash:
      max_attempts: 3           # Bash 节点 3 次
      delay_ms: 2000

# ── Checkpoint 中断恢复 ───────────────────────────────────
checkpoint:
  enabled: true
  save_on: per-node             # per-node | per-batch | manual — 何时保存检查点
  restore_on: restart           # restart | manual — 何时自动恢复
  dir: .octopus/checkpoints     # 检查点存储目录

# ── 并发控制 ──────────────────────────────────────────────
concurrency:
  max_concurrent: 0             # 0 = 不限制, N = 最多 N 个节点并行

# ── 超时 ─────────────────────────────────────────────────
timeout:
  node_default_ms: 600000       # 单节点默认超时 10 分钟
  execution_default_ms: 3600000 # 单次执行默认超时 1 小时
`

/** Workspace guide content for CLAUDE.md files. */
export function workspaceGuide(): string[] {
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
  ]
}

export class WorkspaceScaffold {
  /** Copy built-in workflow YAML files from ~/.octopus/workflows/ to workspace. */
  copyBuiltInWorkflows(workspacePath: string): void {
    const srcDir = path.join(os.homedir(), ".octopus", "workflows")
    const destDir = path.join(workspacePath, "workflows")
    if (!fs.existsSync(srcDir)) return

    const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    for (const file of files) {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file))
    }
  }

  /** Write base CLAUDE.md with workspace name and usage guide. */
  writeBaseClaudeMd(workspacePath: string, wsName: string): void {
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

  /** Write config.json with workspace name, repos, and optional branch. */
  writeConfigJson(workspacePath: string, name: string, repos: string[], branch?: string): void {
    const configPath = path.join(workspacePath, "config.json")
    if (fs.existsSync(configPath)) return
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

  /** Copy core-pack skills to workspace .claude/skills/. */
  copySkill(workspacePath: string): void {
    const corePackRoot = this.findCorePackSkillsRoot()
    if (!corePackRoot) return
    const skillsDir = path.join(workspacePath, ".claude", "skills")
    fs.mkdirSync(skillsDir, { recursive: true })
    const coreSkills = ["octo-dev-copilot", "octo-workflow-dev", "octo-swarm-dev", "octo-resource-manager", "octo-source-analyzer"]
    for (const skillName of coreSkills) {
      const dest = path.join(skillsDir, skillName)
      if (fs.existsSync(dest)) continue
      const src = path.join(corePackRoot, skillName)
      if (fs.existsSync(path.join(src, "SKILL.md"))) {
        fs.cpSync(src, dest, { recursive: true })
        console.log(`[WorkspaceScaffold] copied skill: ${skillName}`)
      }
    }
  }

  /** Copy core-pack agents to workspace .claude/agents/. */
  copyAgents(workspacePath: string): void {
    const corePackAgentsRoot = this.findCorePackAgentsRoot()
    if (!corePackAgentsRoot) return

    const agentsDir = path.join(workspacePath, ".claude", "agents")
    fs.mkdirSync(agentsDir, { recursive: true })

    const coreAgents = ["devil-advocate.md", "architecture-explorer.md", "vision-analyzer.md"]
    for (const agentFile of coreAgents) {
      const dest = path.join(agentsDir, agentFile)
      if (fs.existsSync(dest)) continue
      const src = path.join(corePackAgentsRoot, agentFile)
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest)
        console.log(`[WorkspaceScaffold] copied agent: ${agentFile}`)
      }
    }
  }

  /** Copy rules templates from multiple sources to workspace rules directory. */
  copyRulesTemplate(rulesDir: string, org: string): void {
    const sources = [
      path.join(process.cwd(), ".octopus", "code-dev-copilot-rules"),
      path.join(os.homedir(), ".octopus", "orgs", org, "code-dev-copilot-rules"),
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

  private getCorePackRulesCandidates(): string[] {
    return [
      path.join(process.cwd(), "..", "core-pack", "skills", "octo-dev-copilot", "rules"),
      path.join(process.cwd(), "packages", "core-pack", "skills", "octo-dev-copilot", "rules"),
      path.join(process.cwd(), "node_modules", "@octopus", "core-pack", "skills", "octo-dev-copilot", "rules"),
    ]
  }
}
