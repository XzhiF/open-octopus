import { describe, it, expect, vi } from "vitest"
import {
  parsePipelineConfig,
  isOctopusPipeline,
  validatePipelineConfig,
  ValueError,
} from "../yaml/pipeline-parser"

describe("parsePipelineConfig", () => {
  const minimalYaml = `
apiVersion: octopus/v1
kind: Pipeline
`

  it("parses valid YAML string", () => {
    const result = parsePipelineConfig(minimalYaml)
    expect(result.apiVersion).toBe("octopus/v1")
    expect(result.kind).toBe("Pipeline")
  })

  it("parses valid dict input", () => {
    const result = parsePipelineConfig({
      apiVersion: "octopus/v1",
      kind: "Pipeline",
    })
    expect(result.apiVersion).toBe("octopus/v1")
    expect(result.kind).toBe("Pipeline")
  })

  it("applies defaults for empty config sections", () => {
    const result = parsePipelineConfig(minimalYaml)
    expect(result.execution.failure_strategy).toBe("fail_fast")
    expect(result.execution.timeout).toBe(86400)
    expect(result.retry.default.max_attempts).toBe(1)
    expect(result.fork.path_strategy).toBe("all")
    expect(result.checkpoint.enabled).toBe(true)
  })

  it("parses YAML with execution config", () => {
    const yaml = `
apiVersion: octopus/v1
kind: Pipeline
execution:
  failure_strategy: continue
  timeout: 3600
  max_concurrent: 4
`
    const result = parsePipelineConfig(yaml)
    expect(result.execution.failure_strategy).toBe("continue")
    expect(result.execution.timeout).toBe(3600)
    expect(result.execution.max_concurrent).toBe(4)
  })

  it("parses YAML with retry overrides", () => {
    const yaml = `
apiVersion: octopus/v1
kind: Pipeline
retry:
  default:
    max_attempts: 3
  overrides:
    build-*:
      max_attempts: 5
`
    const result = parsePipelineConfig(yaml)
    expect(result.retry.default.max_attempts).toBe(3)
    expect(result.retry.overrides["build-*"]?.max_attempts).toBe(5)
  })

  it("throws ValueError on invalid YAML syntax", () => {
    expect(() => parsePipelineConfig("{{invalid yaml:::")).toThrow(ValueError)
    expect(() => parsePipelineConfig("{{invalid yaml:::")).toThrow(/YAML parse error/)
  })

  it("throws ValueError on wrong kind", () => {
    expect(() => parsePipelineConfig({
      apiVersion: "octopus/v1",
      kind: "Workflow",
    })).toThrow(ValueError)
    expect(() => parsePipelineConfig({
      apiVersion: "octopus/v1",
      kind: "Workflow",
    })).toThrow(/validation error/)
  })

  it("throws ValueError on missing apiVersion", () => {
    expect(() => parsePipelineConfig({
      kind: "Pipeline",
    })).toThrow(ValueError)
  })

  it("throws ValueError on invalid apiVersion format", () => {
    expect(() => parsePipelineConfig({
      apiVersion: "v1",
      kind: "Pipeline",
    })).toThrow(ValueError)
  })

  it("throws ValueError on missing kind", () => {
    expect(() => parsePipelineConfig({
      apiVersion: "octopus/v1",
    })).toThrow(ValueError)
  })

  it("parses full YAML string with all sections", () => {
    const yaml = `
apiVersion: octopus/v2
kind: Pipeline
description: Full test pipeline
execution:
  failure_strategy: skip
  timeout: 7200
  max_concurrent: 8
  resume_on_interrupt: auto
  auto_resume_max_attempts: 5
  auto_resume_delay: 30
  pending_resume_timeout: 1200
retry:
  default:
    max_attempts: 3
    backoff:
      type: linear
      initial_delay: 10
      increment: 15
    max_total_duration: 3600
  overrides:
    test-*:
      max_attempts: 1
      retry_on:
        - timeout
fork:
  path_strategy: all
  merge_strategy: first_complete
  failure_handling: best_effort
checkpoint:
  enabled: true
  save_on: per-level
  max_checkpoints: 20
  ttl: 7200
  max_size_bytes: 2097152
`
    const result = parsePipelineConfig(yaml)
    expect(result.apiVersion).toBe("octopus/v2")
    expect(result.description).toBe("Full test pipeline")
    expect(result.execution.failure_strategy).toBe("skip")
    expect(result.retry.default.backoff.type).toBe("linear")
    expect(result.fork.merge_strategy).toBe("first_complete")
    expect(result.checkpoint.max_checkpoints).toBe(20)
  })
})

describe("isOctopusPipeline", () => {
  it("returns true for valid pipeline YAML string", () => {
    expect(isOctopusPipeline(`
apiVersion: octopus/v1
kind: Pipeline
`)).toBe(true)
  })

  it("returns true for valid pipeline dict", () => {
    expect(isOctopusPipeline({
      apiVersion: "octopus/v1",
      kind: "Pipeline",
    })).toBe(true)
  })

  it("returns true for v2 apiVersion", () => {
    expect(isOctopusPipeline({
      apiVersion: "octopus/v2",
      kind: "Pipeline",
    })).toBe(true)
  })

  it("returns false for Workflow kind", () => {
    expect(isOctopusPipeline({
      apiVersion: "octopus/v1",
      kind: "Workflow",
    })).toBe(false)
  })

  it("returns false for non-octopus apiVersion", () => {
    expect(isOctopusPipeline({
      apiVersion: "kubernetes/v1",
      kind: "Pipeline",
    })).toBe(false)
  })

  it("returns false for null", () => {
    expect(isOctopusPipeline(null)).toBe(false)
  })

  it("returns false for non-object", () => {
    expect(isOctopusPipeline(42)).toBe(false)
    expect(isOctopusPipeline("just a string")).toBe(false)
  })

  it("returns false for invalid YAML string", () => {
    expect(isOctopusPipeline("{{invalid yaml:::")).toBe(false)
  })

  it("returns false for missing kind", () => {
    expect(isOctopusPipeline({
      apiVersion: "octopus/v1",
    })).toBe(false)
  })

  it("returns false for missing apiVersion", () => {
    expect(isOctopusPipeline({
      kind: "Pipeline",
    })).toBe(false)
  })
})

describe("validatePipelineConfig", () => {
  it("does not warn when agent_partial_completion is not in retry_on", () => {
    const config = parsePipelineConfig({
      apiVersion: "octopus/v1",
      kind: "Pipeline",
    })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    validatePipelineConfig(config)
    expect(stderrSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })

  it("warns when agent_partial_completion is in retry_on", () => {
    const config = parsePipelineConfig({
      apiVersion: "octopus/v1",
      kind: "Pipeline",
      retry: {
        default: {
          retry_on: ["agent_partial_completion", "timeout"],
        },
      },
    })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    validatePipelineConfig(config)
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("agent_partial_completion")
    )
    stderrSpy.mockRestore()
  })
})

describe("ValueError", () => {
  it("has correct name", () => {
    const err = new ValueError("test")
    expect(err.name).toBe("ValueError")
    expect(err.message).toBe("test")
    expect(err instanceof Error).toBe(true)
  })
})
