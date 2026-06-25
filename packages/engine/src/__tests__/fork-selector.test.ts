import { describe, it, expect } from "vitest"
import { ForkPathSelector } from "../pipeline/fork-selector"
import { VarPool } from "@octopus/shared"
import type { ForkConfig } from "@octopus/shared"

describe("ForkPathSelector", () => {
  const pool = new VarPool()

  it("'all' strategy returns all branches", () => {
    const config: ForkConfig = {
      path_strategy: "all",
      merge_strategy: "wait_all",
      failure_handling: "fail_all",
    }
    const selector = new ForkPathSelector(config)
    const branches = ["branch-a", "branch-b", "branch-c"]
    const result = selector.selectPaths("fork-1", branches, pool)
    expect(result).toEqual(["branch-a", "branch-b", "branch-c"])
  })

  it("'primary' strategy filters to marked branches", () => {
    const config: ForkConfig = {
      path_strategy: "primary",
      merge_strategy: "wait_all",
      failure_handling: "fail_all",
    }
    const selector = new ForkPathSelector(config)
    const branches = ["branch-a", "branch-b", "branch-c"]
    const primaryMap = new Map<string, boolean>([
      ["branch-a", false],
      ["branch-b", true],
      ["branch-c", false],
    ])
    const result = selector.selectPaths("fork-1", branches, pool, primaryMap)
    expect(result).toEqual(["branch-b"])
  })

  it("'primary' returns all branches when none are marked", () => {
    const config: ForkConfig = {
      path_strategy: "primary",
      merge_strategy: "wait_all",
      failure_handling: "fail_all",
    }
    const selector = new ForkPathSelector(config)
    const branches = ["branch-a", "branch-b"]
    const primaryMap = new Map<string, boolean>([
      ["branch-a", false],
      ["branch-b", false],
    ])
    const result = selector.selectPaths("fork-1", branches, pool, primaryMap)
    expect(result).toEqual(["branch-a", "branch-b"])
  })

  it("'primary' returns all branches when primaryMap is undefined", () => {
    const config: ForkConfig = {
      path_strategy: "primary",
      merge_strategy: "wait_all",
      failure_handling: "fail_all",
    }
    const selector = new ForkPathSelector(config)
    const branches = ["branch-a", "branch-b"]
    const result = selector.selectPaths("fork-1", branches, pool)
    expect(result).toEqual(["branch-a", "branch-b"])
  })

  it("'primary' returns all branches when primaryMap is empty", () => {
    const config: ForkConfig = {
      path_strategy: "primary",
      merge_strategy: "wait_all",
      failure_handling: "fail_all",
    }
    const selector = new ForkPathSelector(config)
    const branches = ["branch-a", "branch-b"]
    const primaryMap = new Map<string, boolean>()
    const result = selector.selectPaths("fork-1", branches, pool, primaryMap)
    expect(result).toEqual(["branch-a", "branch-b"])
  })

  it("'all' with empty branches returns empty array", () => {
    const config: ForkConfig = {
      path_strategy: "all",
      merge_strategy: "wait_all",
      failure_handling: "fail_all",
    }
    const selector = new ForkPathSelector(config)
    const result = selector.selectPaths("fork-1", [], pool)
    expect(result).toEqual([])
  })

  it("returns a copy, not the original array", () => {
    const config: ForkConfig = {
      path_strategy: "all",
      merge_strategy: "wait_all",
      failure_handling: "fail_all",
    }
    const selector = new ForkPathSelector(config)
    const branches = ["branch-a"]
    const result = selector.selectPaths("fork-1", branches, pool)
    expect(result).not.toBe(branches)
    expect(result).toEqual(branches)
  })
})
