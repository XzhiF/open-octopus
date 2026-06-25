import { describe, it, expect } from "vitest"
import { RetryPolicyResolver } from "../pipeline/retry-resolver"
import type { RetryConfig, RetryPolicy } from "@octopus/shared"

function makeDefaultPolicy(): RetryPolicy {
  return {
    max_attempts: 1,
    backoff: {
      type: "exponential",
      initial_delay: 5,
      multiplier: 2,
      increment: 5,
      max_delay: 300,
    },
    max_total_duration: 0,
    retry_on: ["exit_code_nonzero", "timeout", "agent_stream_error", "transient_error"],
    never_retry_on: ["approval_rejected", "user_cancelled", "config_error"],
  }
}

describe("RetryPolicyResolver", () => {
  describe("default policy with no overrides", () => {
    it("returns default policy for any node ID", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {},
      }

      const resolver = new RetryPolicyResolver(config)

      expect(resolver.resolve("node-1")).toEqual(config.default)
      expect(resolver.resolve("some-random-node")).toEqual(config.default)
      expect(resolver.resolve("deploy-step")).toEqual(config.default)
    })
  })

  describe("exact match", () => {
    it("returns exact match merged with default", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "deploy-prod": {
            max_attempts: 5,
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("deploy-prod")

      expect(result.max_attempts).toBe(5)
      // Other fields come from default
      expect(result.backoff).toEqual(config.default.backoff)
      expect(result.retry_on).toEqual(config.default.retry_on)
      expect(result.never_retry_on).toEqual(config.default.never_retry_on)
    })

    it("does not match similar but different node IDs", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "deploy-prod": {
            max_attempts: 5,
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("deploy-staging")

      expect(result.max_attempts).toBe(1) // default
    })
  })

  describe("glob match", () => {
    it("matches glob patterns", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "deploy-*": {
            max_attempts: 3,
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)

      expect(resolver.resolve("deploy-prod").max_attempts).toBe(3)
      expect(resolver.resolve("deploy-staging").max_attempts).toBe(3)
      expect(resolver.resolve("deploy-uat").max_attempts).toBe(3)
    })

    it("does not match non-matching patterns", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "deploy-*": {
            max_attempts: 3,
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)

      expect(resolver.resolve("test-prod").max_attempts).toBe(1) // default
    })
  })

  describe("priority: exact > glob", () => {
    it("exact match takes priority over glob match", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "deploy-*": {
            max_attempts: 3,
          },
          "deploy-prod": {
            max_attempts: 5,
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)

      expect(resolver.resolve("deploy-prod").max_attempts).toBe(5)
      expect(resolver.resolve("deploy-staging").max_attempts).toBe(3)
    })
  })

  describe("most specific glob wins", () => {
    it("selects the glob with most non-wildcard characters", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "*": {
            max_attempts: 2,
          },
          "deploy-*": {
            max_attempts: 3,
          },
          "deploy-prod-*": {
            max_attempts: 5,
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)

      // "deploy-prod-step" matches all three, most specific wins
      expect(resolver.resolve("deploy-prod-step").max_attempts).toBe(5)
      // "deploy-staging" matches "*" and "deploy-*", more specific wins
      expect(resolver.resolve("deploy-staging").max_attempts).toBe(3)
      // "test-node" only matches "*"
      expect(resolver.resolve("test-node").max_attempts).toBe(2)
    })
  })

  describe("fallback to default", () => {
    it("returns default when no patterns match", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "deploy-*": {
            max_attempts: 3,
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("test-unit")

      expect(result).toEqual(config.default)
    })
  })

  describe("merge behavior", () => {
    it("override retry_on replaces default retry_on", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "flaky-node": {
            retry_on: ["exit_code_nonzero"],
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("flaky-node")

      expect(result.retry_on).toEqual(["exit_code_nonzero"])
    })

    it("never_retry_on from default is preserved when not overridden", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "custom-node": {
            max_attempts: 10,
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("custom-node")

      expect(result.never_retry_on).toEqual(config.default.never_retry_on)
      expect(result.max_attempts).toBe(10)
    })

    it("overrides backoff entirely when specified", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "fast-retry": {
            backoff: {
              type: "fixed",
              initial_delay: 1,
              multiplier: 1,
              increment: 0,
              max_delay: 10,
            },
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("fast-retry")

      expect(result.backoff).toEqual({
        type: "fixed",
        initial_delay: 1,
        multiplier: 1,
        increment: 0,
        max_delay: 10,
      })
    })
  })

  describe("append syntax with + prefix", () => {
    it("appends to retry_on when + prefix is used", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "flaky-node": {
            retry_on: ["+agent_partial_completion"],
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("flaky-node")

      // Should contain defaults plus the appended item
      expect(result.retry_on).toContain("exit_code_nonzero")
      expect(result.retry_on).toContain("timeout")
      expect(result.retry_on).toContain("agent_partial_completion")
      expect(result.retry_on.length).toBe(5) // 4 defaults + 1 appended
    })

    it("appends multiple items with + prefix", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "test-node": {
            retry_on: ["+agent_partial_completion", "+config_error"],
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("test-node")

      expect(result.retry_on).toContain("agent_partial_completion")
      expect(result.retry_on).toContain("config_error")
      expect(result.retry_on.length).toBe(6) // 4 defaults + 2 appended
    })

    it("does not duplicate when appending existing item", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "node-with-existing": {
            retry_on: ["+timeout"], // timeout already in defaults
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("node-with-existing")

      // Should still have 4 items (no duplicate)
      expect(result.retry_on.length).toBe(4)
      expect(result.retry_on).toContain("timeout")
    })

    it("appends to never_retry_on with + prefix", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "safe-node": {
            never_retry_on: ["+agent_partial_completion"],
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("safe-node")

      expect(result.never_retry_on).toContain("approval_rejected")
      expect(result.never_retry_on).toContain("agent_partial_completion")
      expect(result.never_retry_on.length).toBe(4) // 3 defaults + 1 appended
    })

    it("replaces entirely when no + prefix", () => {
      const config: RetryConfig = {
        default: makeDefaultPolicy(),
        overrides: {
          "strict-node": {
            retry_on: ["timeout"], // No + prefix, replaces entirely
          },
        },
      }

      const resolver = new RetryPolicyResolver(config)
      const result = resolver.resolve("strict-node")

      // Should only have the specified item
      expect(result.retry_on).toEqual(["timeout"])
      expect(result.retry_on.length).toBe(1)
    })
  })
})
