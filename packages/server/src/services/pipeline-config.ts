// packages/server/src/services/pipeline-config.ts
import { readFileSync, existsSync, writeFileSync, statSync } from "fs"
import { join } from "path"
import { load as yamlLoad, dump as yamlDump } from "js-yaml"
import {
  PipelineConfig,
  PipelineConfigSchema,
  PipelineConfigV1Schema,
} from "@octopus/shared"
import { createHash } from "crypto"

export class PipelineConfigLoader {
  private config: PipelineConfig | null = null
  private configHash: string = ""
  private lastModified: number = 0

  constructor(private workspacePath: string) {}

  /**
   * 获取 pipeline 配置
   * 自动检测 v1/v2 版本，v1 自动升级为 v2
   */
  getConfig(): PipelineConfig | null {
    const configPath = this.getConfigPath()
    if (!existsSync(configPath)) {
      return null
    }

    // 检查文件是否被修改
    const stats = statSync(configPath)
    if (stats.mtimeMs !== this.lastModified) {
      this.reload()
    }

    return this.config
  }

  /**
   * 获取配置 hash（用于检测变更）
   */
  getConfigHash(): string {
    if (!this.configHash) {
      this.reload()
    }
    return this.configHash
  }

  /**
   * 强制重新加载配置
   */
  reload(): void {
    const configPath = this.getConfigPath()
    if (!existsSync(configPath)) {
      this.config = null
      this.configHash = ""
      this.lastModified = 0
      return
    }

    const content = readFileSync(configPath, "utf-8")
    this.configHash = createHash("sha256").update(content).digest("hex")
    this.lastModified = statSync(configPath).mtimeMs

    const raw = yamlLoad(content) as any

    // 检测版本
    if (raw.apiVersion === "octopus/v1") {
      // v1 自动升级为 v2
      const v1 = PipelineConfigV1Schema.parse(raw)
      this.config = {
        apiVersion: "octopus/v2",
        kind: "Pipeline",
        execution: v1.execution,
        retry: v1.retry,
        fork: v1.fork,
        checkpoint: v1.checkpoint,
      }
    } else {
      // v2 直接解析
      this.config = PipelineConfigSchema.parse(raw)
    }
  }

  /**
   * 保存配置到文件
   */
  save(config: PipelineConfig): void {
    const configPath = this.getConfigPath()
    const yaml = yamlDump(config, { indent: 2 })
    writeFileSync(configPath, yaml, "utf-8")
    this.reload()
  }

  /**
   * 生成默认 v2 配置模板
   */
  generateDefault(): string {
    return `# Octopus Pipeline v2 配置
apiVersion: octopus/v2
kind: Pipeline

# ── 执行链策略 ──
chain:
  auto_execute: true           # 自动按树结构依次执行 pending 节点
  failure_strategy: stop       # stop | continue | retry_leaf — 任一节点失败立即停止链
  on_success: continue         # continue | stop
  config_change_strategy: snapshot  # snapshot | abort

# ── Prompt 注入 ──
prompts:
  global: []
  targeted: []

# ── 全局 Hook ──
hooks: {}

# ── 执行策略 ──
execution:
  failure_strategy: fail_fast
  timeout: 86400
  resume_on_interrupt: auto
  auto_resume_max_attempts: 3
  auto_resume_delay: 10

# ── 重试 ──
retry:
  default:
    max_attempts: 3
    backoff:
      type: exponential
      initial_delay: 5
      multiplier: 2
      max_delay: 300

# ── Fork ──
fork:
  path_strategy: all
  merge_strategy: wait_all
  failure_handling: fail_all

# ── Checkpoint ──
checkpoint:
  enabled: true
  save_on: per-node
`
  }

  private getConfigPath(): string {
    return join(this.workspacePath, "pipeline.yaml")
  }
}
