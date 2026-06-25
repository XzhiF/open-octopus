// packages/server/src/__tests__/pipeline-config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { PipelineConfigLoader } from "../services/pipeline-config"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"

describe("PipelineConfigLoader", () => {
  const testDir = join(__dirname, "test-workspace")

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it("returns null when pipeline.yaml does not exist", () => {
    const loader = new PipelineConfigLoader(testDir)
    expect(loader.getConfig()).toBeNull()
  })

  it("loads v1 config and upgrades to v2", () => {
    const v1Config = `
apiVersion: octopus/v1
kind: Pipeline
execution:
  failure_strategy: continue
`
    writeFileSync(join(testDir, "pipeline.yaml"), v1Config)
    const loader = new PipelineConfigLoader(testDir)
    const config = loader.getConfig()
    expect(config).not.toBeNull()
    expect(config!.apiVersion).toBe("octopus/v2")
    expect(config!.execution?.failure_strategy).toBe("continue")
  })

  it("loads v2 config with chain settings", () => {
    const v2Config = `
apiVersion: octopus/v2
kind: Pipeline
chain:
  auto_execute: true
  failure_strategy: retry_leaf
prompts:
  global:
    - "Follow best practices"
`
    writeFileSync(join(testDir, "pipeline.yaml"), v2Config)
    const loader = new PipelineConfigLoader(testDir)
    const config = loader.getConfig()
    expect(config!.chain?.auto_execute).toBe(true)
    expect(config!.chain?.failure_strategy).toBe("retry_leaf")
    expect(config!.prompts?.global).toEqual(["Follow best practices"])
  })

  it("calculates config hash", () => {
    const config = `
apiVersion: octopus/v2
kind: Pipeline
`
    writeFileSync(join(testDir, "pipeline.yaml"), config)
    const loader = new PipelineConfigLoader(testDir)
    loader.getConfig()
    const hash = loader.getConfigHash()
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("reloads when file is modified", async () => {
    writeFileSync(join(testDir, "pipeline.yaml"), `
apiVersion: octopus/v2
kind: Pipeline
chain:
  auto_execute: false
`)
    const loader = new PipelineConfigLoader(testDir)
    expect(loader.getConfig()!.chain?.auto_execute).toBe(false)

    // 修改文件
    await new Promise(resolve => setTimeout(resolve, 100))
    writeFileSync(join(testDir, "pipeline.yaml"), `
apiVersion: octopus/v2
kind: Pipeline
chain:
  auto_execute: true
`)

    expect(loader.getConfig()!.chain?.auto_execute).toBe(true)
  })
})
