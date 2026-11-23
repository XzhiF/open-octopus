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

  private getConfigPath(): string {
    return join(this.workspacePath, "pipeline.yaml")
  }
}
