import { describe, it, expect } from "vitest"
import {
  BackoffSchema,
  BackoffTypeSchema,
  RetryOnConditionSchema,
  RetryPolicySchema,
  RetryConfigSchema,
  ExecutionConfigSchema,
  ForkConfigSchema,
  CheckpointConfigSchema,
  PipelineConfigSchema,
  FailureStrategySchema,
  ForkPathStrategySchema,
  ForkMergeStrategySchema,
  ForkFailureHandlingSchema,
  CheckpointSaveOnSchema,
  ResumeOnInterruptSchema,
} from "../types/pipeline"

describe("BackoffTypeSchema", () => {
  it("accepts valid types", () => {
    expect(BackoffTypeSchema.parse("fixed")).toBe("fixed")
    expect(BackoffTypeSchema.parse("exponential")).toBe("exponential")
    expect(BackoffTypeSchema.parse("linear")).toBe("linear")
  })

  it("rejects invalid type", () => {
    expect(() => BackoffTypeSchema.parse("random")).toThrow()
  })
})

describe("BackoffSchema", () => {
  it("applies defaults", () => {
    const result = BackoffSchema.parse({})
    expect(result.type).toBe("exponential")
    expect(result.initial_delay).toBe(5)
    expect(result.multiplier).toBe(2)
    expect(result.increment).toBe(5)
    expect(result.max_delay).toBe(300)
  })

  it("accepts valid custom values", () => {
    const result = BackoffSchema.parse({
      type: "linear",
      initial_delay: 10,
      multiplier: 1.5,
      increment: 15,
      max_delay: 600,
    })
    expect(result.type).toBe("linear")
    expect(result.initial_delay).toBe(10)
    expect(result.multiplier).toBe(1.5)
    expect(result.increment).toBe(15)
    expect(result.max_delay).toBe(600)
  })

  it("rejects negative initial_delay", () => {
    expect(() => BackoffSchema.parse({ initial_delay: -1 })).toThrow()
  })

  it("rejects multiplier less than 1", () => {
    expect(() => BackoffSchema.parse({ multiplier: 0.5 })).toThrow()
  })

  it("rejects non-integer initial_delay", () => {
    expect(() => BackoffSchema.parse({ initial_delay: 1.5 })).toThrow()
  })
})

describe("RetryOnConditionSchema", () => {
  it("accepts all valid conditions", () => {
    const valid = [
      "exit_code_nonzero",
      "timeout",
      "agent_stream_error",
      "transient_error",
      "agent_partial_completion",
      "approval_rejected",
      "user_cancelled",
      "config_error",
    ]
    for (const v of valid) {
      expect(RetryOnConditionSchema.parse(v)).toBe(v)
    }
  })

  it("rejects invalid condition", () => {
    expect(() => RetryOnConditionSchema.parse("unknown_error")).toThrow()
  })
})

describe("RetryPolicySchema", () => {
  it("applies defaults", () => {
    const result = RetryPolicySchema.parse({})
    expect(result.max_attempts).toBe(1)
    expect(result.backoff.type).toBe("exponential")
    expect(result.max_total_duration).toBe(0)
    expect(result.retry_on).toEqual([
      "exit_code_nonzero",
      "timeout",
      "agent_stream_error",
      "transient_error",
    ])
    expect(result.never_retry_on).toEqual([
      "approval_rejected",
      "user_cancelled",
      "config_error",
    ])
  })

  it("accepts custom values", () => {
    const result = RetryPolicySchema.parse({
      max_attempts: 5,
      max_total_duration: 3600,
      retry_on: ["timeout"],
      never_retry_on: ["config_error"],
    })
    expect(result.max_attempts).toBe(5)
    expect(result.max_total_duration).toBe(3600)
    expect(result.retry_on).toEqual(["timeout"])
    expect(result.never_retry_on).toEqual(["config_error"])
  })

  it("rejects max_attempts less than 1", () => {
    expect(() => RetryPolicySchema.parse({ max_attempts: 0 })).toThrow()
  })

  it("rejects negative max_total_duration", () => {
    expect(() => RetryPolicySchema.parse({ max_total_duration: -1 })).toThrow()
  })

  it("rejects invalid retry_on condition", () => {
    expect(() => RetryPolicySchema.parse({ retry_on: ["bogus"] })).toThrow()
  })
})

describe("RetryConfigSchema", () => {
  it("applies defaults", () => {
    const result = RetryConfigSchema.parse({})
    expect(result.default.max_attempts).toBe(1)
    expect(result.overrides).toEqual({})
  })

  it("accepts overrides with partial policy", () => {
    const result = RetryConfigSchema.parse({
      overrides: {
        "build-*": { max_attempts: 3 },
        "test-*": { max_attempts: 2, retry_on: ["timeout"] },
      },
    })
    expect(result.overrides["build-*"]?.max_attempts).toBe(3)
    expect(result.overrides["test-*"]?.retry_on).toEqual(["timeout"])
  })

  it("accepts empty overrides", () => {
    const result = RetryConfigSchema.parse({ overrides: {} })
    expect(result.overrides).toEqual({})
  })
})

describe("FailureStrategySchema", () => {
  it("accepts valid strategies", () => {
    expect(FailureStrategySchema.parse("fail_fast")).toBe("fail_fast")
    expect(FailureStrategySchema.parse("continue")).toBe("continue")
    expect(FailureStrategySchema.parse("skip")).toBe("skip")
  })

  it("rejects invalid strategy", () => {
    expect(() => FailureStrategySchema.parse("ignore")).toThrow()
  })
})

describe("ResumeOnInterruptSchema", () => {
  it("accepts valid values", () => {
    expect(ResumeOnInterruptSchema.parse("manual")).toBe("manual")
    expect(ResumeOnInterruptSchema.parse("auto")).toBe("auto")
  })

  it("rejects invalid value", () => {
    expect(() => ResumeOnInterruptSchema.parse("never")).toThrow()
  })
})

describe("ExecutionConfigSchema", () => {
  it("applies defaults", () => {
    const result = ExecutionConfigSchema.parse({})
    expect(result.failure_strategy).toBe("fail_fast")
    expect(result.timeout).toBe(86400)
    expect(result.max_concurrent).toBe(0)
    expect(result.resume_on_interrupt).toBe("manual")
    expect(result.auto_resume_max_attempts).toBe(3)
    expect(result.auto_resume_delay).toBe(10)
    expect(result.pending_resume_timeout).toBe(600)
  })

  it("accepts custom values", () => {
    const result = ExecutionConfigSchema.parse({
      failure_strategy: "continue",
      timeout: 7200,
      max_concurrent: 4,
      resume_on_interrupt: "auto",
      auto_resume_max_attempts: 5,
      auto_resume_delay: 30,
      pending_resume_timeout: 1200,
    })
    expect(result.failure_strategy).toBe("continue")
    expect(result.timeout).toBe(7200)
    expect(result.max_concurrent).toBe(4)
  })

  it("rejects negative timeout", () => {
    expect(() => ExecutionConfigSchema.parse({ timeout: -1 })).toThrow()
  })

  it("rejects negative max_concurrent", () => {
    expect(() => ExecutionConfigSchema.parse({ max_concurrent: -1 })).toThrow()
  })

  it("rejects auto_resume_max_attempts less than 1", () => {
    expect(() => ExecutionConfigSchema.parse({ auto_resume_max_attempts: 0 })).toThrow()
  })
})

describe("ForkPathStrategySchema", () => {
  it("accepts valid values", () => {
    expect(ForkPathStrategySchema.parse("all")).toBe("all")
    expect(ForkPathStrategySchema.parse("primary")).toBe("primary")
  })

  it("rejects invalid value", () => {
    expect(() => ForkPathStrategySchema.parse("random")).toThrow()
  })
})

describe("ForkMergeStrategySchema", () => {
  it("accepts valid values", () => {
    expect(ForkMergeStrategySchema.parse("wait_all")).toBe("wait_all")
    expect(ForkMergeStrategySchema.parse("wait_any")).toBe("wait_any")
    expect(ForkMergeStrategySchema.parse("first_complete")).toBe("first_complete")
  })

  it("rejects invalid value", () => {
    expect(() => ForkMergeStrategySchema.parse("merge_last")).toThrow()
  })
})

describe("ForkFailureHandlingSchema", () => {
  it("accepts valid values", () => {
    expect(ForkFailureHandlingSchema.parse("fail_all")).toBe("fail_all")
    expect(ForkFailureHandlingSchema.parse("best_effort")).toBe("best_effort")
  })

  it("rejects invalid value", () => {
    expect(() => ForkFailureHandlingSchema.parse("ignore_all")).toThrow()
  })
})

describe("ForkConfigSchema", () => {
  it("applies defaults", () => {
    const result = ForkConfigSchema.parse({})
    expect(result.path_strategy).toBe("all")
    expect(result.merge_strategy).toBe("wait_all")
    expect(result.failure_handling).toBe("fail_all")
  })

  it("accepts custom values", () => {
    const result = ForkConfigSchema.parse({
      path_strategy: "primary",
      merge_strategy: "first_complete",
      failure_handling: "best_effort",
    })
    expect(result.path_strategy).toBe("primary")
    expect(result.merge_strategy).toBe("first_complete")
    expect(result.failure_handling).toBe("best_effort")
  })
})

describe("CheckpointSaveOnSchema", () => {
  it("accepts valid values", () => {
    expect(CheckpointSaveOnSchema.parse("per-node")).toBe("per-node")
    expect(CheckpointSaveOnSchema.parse("per-level")).toBe("per-level")
    expect(CheckpointSaveOnSchema.parse("per-batch")).toBe("per-batch")
  })

  it("rejects invalid value", () => {
    expect(() => CheckpointSaveOnSchema.parse("per-hour")).toThrow()
  })
})

describe("CheckpointConfigSchema", () => {
  it("applies defaults", () => {
    const result = CheckpointConfigSchema.parse({})
    expect(result.enabled).toBe(true)
    expect(result.save_on).toBe("per-node")
    expect(result.max_checkpoints).toBe(10)
    expect(result.ttl).toBe(86400)
    expect(result.max_size_bytes).toBe(1048576)
  })

  it("accepts custom values", () => {
    const result = CheckpointConfigSchema.parse({
      enabled: false,
      save_on: "per-level",
      max_checkpoints: 50,
      ttl: 3600,
      max_size_bytes: 2097152,
    })
    expect(result.enabled).toBe(false)
    expect(result.save_on).toBe("per-level")
    expect(result.max_checkpoints).toBe(50)
  })

  it("rejects max_checkpoints less than 1", () => {
    expect(() => CheckpointConfigSchema.parse({ max_checkpoints: 0 })).toThrow()
  })

  it("rejects negative ttl", () => {
    expect(() => CheckpointConfigSchema.parse({ ttl: -1 })).toThrow()
  })

  it("rejects negative max_size_bytes", () => {
    expect(() => CheckpointConfigSchema.parse({ max_size_bytes: -1 })).toThrow()
  })
})

describe("PipelineConfigSchema", () => {
  const minimalPipeline = {
    apiVersion: "octopus/v1",
    kind: "Pipeline" as const,
  }

  it("validates minimal config with defaults", () => {
    const result = PipelineConfigSchema.parse(minimalPipeline)
    expect(result.apiVersion).toBe("octopus/v1")
    expect(result.kind).toBe("Pipeline")
    expect(result.description).toBeUndefined()
    expect(result.execution.failure_strategy).toBe("fail_fast")
    expect(result.retry.default.max_attempts).toBe(1)
    expect(result.fork.path_strategy).toBe("all")
    expect(result.checkpoint.enabled).toBe(true)
  })

  it("accepts description", () => {
    const result = PipelineConfigSchema.parse({
      ...minimalPipeline,
      description: "My CI/CD pipeline",
    })
    expect(result.description).toBe("My CI/CD pipeline")
  })

  it("accepts apiVersion v2", () => {
    const result = PipelineConfigSchema.parse({
      apiVersion: "octopus/v2",
      kind: "Pipeline",
    })
    expect(result.apiVersion).toBe("octopus/v2")
  })

  it("rejects invalid apiVersion format", () => {
    expect(() => PipelineConfigSchema.parse({
      apiVersion: "v1",
      kind: "Pipeline",
    })).toThrow()
  })

  it("rejects wrong kind", () => {
    expect(() => PipelineConfigSchema.parse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
    })).toThrow()
  })

  it("rejects missing apiVersion", () => {
    expect(() => PipelineConfigSchema.parse({
      kind: "Pipeline",
    })).toThrow()
  })

  it("rejects missing kind", () => {
    expect(() => PipelineConfigSchema.parse({
      apiVersion: "octopus/v1",
    })).toThrow()
  })

  it("applies nested execution config", () => {
    const result = PipelineConfigSchema.parse({
      ...minimalPipeline,
      execution: {
        failure_strategy: "continue",
        timeout: 3600,
      },
    })
    expect(result.execution.failure_strategy).toBe("continue")
    expect(result.execution.timeout).toBe(3600)
    // Defaults still applied for unspecified fields
    expect(result.execution.max_concurrent).toBe(0)
  })

  it("applies nested retry config with overrides", () => {
    const result = PipelineConfigSchema.parse({
      ...minimalPipeline,
      retry: {
        default: { max_attempts: 3 },
        overrides: {
          "build-*": { max_attempts: 5 },
        },
      },
    })
    expect(result.retry.default.max_attempts).toBe(3)
    expect(result.retry.overrides["build-*"]?.max_attempts).toBe(5)
  })

  it("applies nested fork config", () => {
    const result = PipelineConfigSchema.parse({
      ...minimalPipeline,
      fork: {
        path_strategy: "primary",
        merge_strategy: "wait_any",
      },
    })
    expect(result.fork.path_strategy).toBe("primary")
    expect(result.fork.merge_strategy).toBe("wait_any")
    expect(result.fork.failure_handling).toBe("fail_all") // default
  })

  it("applies nested checkpoint config", () => {
    const result = PipelineConfigSchema.parse({
      ...minimalPipeline,
      checkpoint: {
        enabled: false,
        save_on: "per-batch",
      },
    })
    expect(result.checkpoint.enabled).toBe(false)
    expect(result.checkpoint.save_on).toBe("per-batch")
    expect(result.checkpoint.max_checkpoints).toBe(10) // default
  })

  it("accepts full config", () => {
    const result = PipelineConfigSchema.parse({
      apiVersion: "octopus/v1",
      kind: "Pipeline",
      description: "Full pipeline",
      execution: {
        failure_strategy: "skip",
        timeout: 7200,
        max_concurrent: 8,
        resume_on_interrupt: "auto",
        auto_resume_max_attempts: 5,
        auto_resume_delay: 30,
        pending_resume_timeout: 1200,
      },
      retry: {
        default: {
          max_attempts: 3,
          backoff: { type: "linear", initial_delay: 10, increment: 15 },
          max_total_duration: 3600,
        },
        overrides: {
          "test-*": { max_attempts: 1, retry_on: ["timeout"] },
        },
      },
      fork: {
        path_strategy: "all",
        merge_strategy: "first_complete",
        failure_handling: "best_effort",
      },
      checkpoint: {
        enabled: true,
        save_on: "per-level",
        max_checkpoints: 20,
        ttl: 7200,
        max_size_bytes: 2097152,
      },
    })
    expect(result.execution.failure_strategy).toBe("skip")
    expect(result.retry.default.backoff.type).toBe("linear")
    expect(result.fork.merge_strategy).toBe("first_complete")
    expect(result.checkpoint.max_checkpoints).toBe(20)
  })
})
