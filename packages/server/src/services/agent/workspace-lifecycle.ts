import fs from 'fs'
import path from 'path'
import os from 'os'

// ── Types ──────────────────────────────────────────────────────────

export interface WorkspaceRules {
  constraints: string[]
  branch_policy?: string
  file_restrictions?: string[]
  custom_rules?: string[]
}

export interface WorkspaceInfo {
  name: string
  path: string
  rules?: WorkspaceRules
  created_at: string
  status: 'active' | 'completed' | 'failed' | 'archived'
}

export type LifecycleAction = 'keep' | 'cleanup' | 'archive'

// ── WorkspaceLifecycleService ──────────────────────────────────────

/**
 * Manages workspace CLAUDE.md injection and workspace lifecycle.
 * Maps to PRD Stories B4 (workspace_rules injection) and B5 (lifecycle management).
 */
export class WorkspaceLifecycleService {
  private org: string
  private orgDir: string

  constructor(org: string) {
    this.org = org
    this.orgDir = path.join(os.homedir(), '.octopus', 'orgs', org)
  }

  /**
   * Inject workspace_rules into a workspace's CLAUDE.md.
   * Idempotent: if workspace_rules section already exists, it is replaced.
   */
  injectWorkspaceRules(workspacePath: string, rules: WorkspaceRules): boolean {
    const claudeMdPath = path.join(workspacePath, 'CLAUDE.md')
    const rulesBlock = this.formatRulesBlock(rules)

    try {
      let content = ''
      if (fs.existsSync(claudeMdPath)) {
        content = fs.readFileSync(claudeMdPath, 'utf-8')
      }

      // Check if workspace_rules section already exists (idempotent)
      const rulesRegex = /<!-- workspace_rules:begin -->[\s\S]*?<!-- workspace_rules:end -->/
      if (rulesRegex.test(content)) {
        // Replace existing rules block
        content = content.replace(rulesRegex, rulesBlock)
      } else {
        // Append rules block
        content = content.trimEnd() + '\n\n' + rulesBlock + '\n'
      }

      fs.writeFileSync(claudeMdPath, content, 'utf-8')
      return true
    } catch {
      return false
    }
  }

  /**
   * Format workspace rules as a CLAUDE.md block with markers.
   */
  private formatRulesBlock(rules: WorkspaceRules): string {
    const lines: string[] = [
      '<!-- workspace_rules:begin -->',
      '',
      '## Workspace Rules (Auto-injected by Agent)',
      '',
    ]

    if (rules.constraints.length > 0) {
      lines.push('### Constraints')
      for (const c of rules.constraints) {
        lines.push(`- ${c}`)
      }
      lines.push('')
    }

    if (rules.branch_policy) {
      lines.push(`### Branch Policy`)
      lines.push(`- ${rules.branch_policy}`)
      lines.push('')
    }

    if (rules.file_restrictions && rules.file_restrictions.length > 0) {
      lines.push('### File Restrictions')
      for (const f of rules.file_restrictions) {
        lines.push(`- ${f}`)
      }
      lines.push('')
    }

    if (rules.custom_rules && rules.custom_rules.length > 0) {
      lines.push('### Custom Rules')
      for (const r of rules.custom_rules) {
        lines.push(`- ${r}`)
      }
      lines.push('')
    }

    lines.push('<!-- workspace_rules:end -->')
    return lines.join('\n')
  }

  /**
   * Remove workspace_rules from CLAUDE.md.
   */
  removeWorkspaceRules(workspacePath: string): boolean {
    const claudeMdPath = path.join(workspacePath, 'CLAUDE.md')
    if (!fs.existsSync(claudeMdPath)) return false

    try {
      let content = fs.readFileSync(claudeMdPath, 'utf-8')
      const rulesRegex = /\n*<!-- workspace_rules:begin -->[\s\S]*?<!-- workspace_rules:end -->\n*/
      content = content.replace(rulesRegex, '\n')
      fs.writeFileSync(claudeMdPath, content, 'utf-8')
      return true
    } catch {
      return false
    }
  }

  /**
   * Build workspace rules from workflow context and repo knowledge.
   */
  buildRulesFromContext(workflowName: string, targetRepo?: string): WorkspaceRules {
    const constraints: string[] = [
      'Do not modify workspace configuration files without explicit approval',
      'All changes must be committed to the current branch',
      'Do not force push or modify remote branches directly',
    ]

    const fileRestrictions: string[] = [
      'Do not modify .env files',
      'Do not modify credentials or secret files',
    ]

    if (targetRepo) {
      constraints.push(`Target repository: ${targetRepo}`)
    }

    return {
      constraints,
      branch_policy: 'Commit to current branch, create PR for review',
      file_restrictions: fileRestrictions,
      custom_rules: [`Workflow: ${workflowName}`],
    }
  }

  /**
   * Handle workspace lifecycle after task completion.
   * Maps to PRD Story B5.
   */
  handleLifecycle(
    workspacePath: string,
    taskStatus: 'success' | 'failure' | 'cancelled',
    prMerged?: boolean,
  ): LifecycleAction {
    // Success + PR merged → suggest cleanup
    if (taskStatus === 'success' && prMerged) {
      return 'cleanup'
    }

    // Failure or cancelled → keep for investigation
    if (taskStatus === 'failure' || taskStatus === 'cancelled') {
      return 'keep'
    }

    // Success but no PR → keep
    return 'keep'
  }

  /**
   * Clean up a workspace (remove worktree, keep main repo branch).
   */
  cleanupWorkspace(workspacePath: string): { cleaned: boolean; error?: string } {
    try {
      // Remove workspace_rules from CLAUDE.md before cleanup
      this.removeWorkspaceRules(workspacePath)

      // Mark workspace as completed in metadata
      const metaPath = path.join(workspacePath, '.octopus-workspace-meta.json')
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        meta.status = 'completed'
        meta.completed_at = new Date().toISOString()
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
      }

      return { cleaned: true }
    } catch (err: unknown) {
      return {
        cleaned: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * List active workspaces for this org.
   */
  listWorkspaces(): WorkspaceInfo[] {
    const workspacesDir = path.join(this.orgDir, 'workspaces')
    if (!fs.existsSync(workspacesDir)) return []

    const results: WorkspaceInfo[] = []

    try {
      const entries = fs.readdirSync(workspacesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const wsPath = path.join(workspacesDir, entry.name)
          const metaPath = path.join(wsPath, '.octopus-workspace-meta.json')

          let status: WorkspaceInfo['status'] = 'active'
          let createdAt = new Date(fs.statSync(wsPath).birthtimeMs).toISOString()

          if (fs.existsSync(metaPath)) {
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
              status = meta.status ?? 'active'
              createdAt = meta.created_at ?? createdAt
            } catch {
              // Use defaults on parse failure
            }
          }

          results.push({
            name: entry.name,
            path: wsPath,
            created_at: createdAt,
            status,
          })
        }
      }
    } catch {
      // List failure is non-fatal
    }

    return results
  }
}

// ── Singleton ───────────────────────────────────────────────────────

const instances = new Map<string, WorkspaceLifecycleService>()

export function getWorkspaceLifecycleService(org: string): WorkspaceLifecycleService {
  let instance = instances.get(org)
  if (!instance) {
    instance = new WorkspaceLifecycleService(org)
    instances.set(org, instance)
  }
  return instance
}
