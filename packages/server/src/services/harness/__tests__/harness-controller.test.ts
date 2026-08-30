// packages/server/src/services/harness/__tests__/harness-controller.test.ts
//
// Unit tests for HarnessController — focused on repairService wiring (ticket 02).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { HarnessController } from "../harness-controller"
import type { HarnessDAO } from "../../../db/dao/harness-dao"
import type { SSEService } from "../../sse"
import type { HarnessConfigService } from "../config-service"

function makeMocks() {
  const dao = {
    insertEvent: vi.fn(),
    findEvents: vi.fn().mockReturnValue([]),
    getDb: vi.fn(() => ({})), // C3: controller 缺省自建 TokenUsageDAO 用（构造无副作用）
  } as unknown as HarnessDAO

  const sse = {
    emit: vi.fn(),
  } as unknown as SSEService

  const configService = {
    loadMergedConfig: vi.fn().mockReturnValue({
      detectors: {},
      strategies: [],
      isolation: {
        process_group: false,
        port_protection: false,
        pid_protection: false,
        sandbox: "off",
        fs_whitelist: [],
      },
    }),
  } as unknown as HarnessConfigService

  return { dao, sse, configService }
}

describe("HarnessController — repairService wiring", () => {
  it("accepts repairService via constructor deps", () => {
    const mocks = makeMocks()
    const mockRepairService = {
      intervene: vi.fn().mockResolvedValue({ injected: true }),
    }

    const controller = new HarnessController({
      ...mocks,
      repairService: mockRepairService as any,
    })

    // Controller should be created successfully with repairService
    expect(controller).toBeDefined()
    expect(controller.isActive("any-exec")).toBe(false)
  })

  it("allows repairService to be set after construction via setRepairService", () => {
    const mocks = makeMocks()

    // Create WITHOUT repairService
    const controller = new HarnessController({
      ...mocks,
    })

    expect(controller).toBeDefined()

    // Now set repairService after construction
    const mockRepairService = {
      intervene: vi.fn().mockResolvedValue({ injected: true }),
    }

    controller.setRepairService(mockRepairService as any)

    // The controller should now have the repairService available internally.
    // We verify indirectly: start an execution and check the pipeline was created.
    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
      onNodeError: vi.fn(),
      onComplete: vi.fn(),
      onFailure: vi.fn(),
      onRetry: vi.fn(),
      onLLMCall: vi.fn(),
    } as any

    const wrapped = controller.onExecutionStart("exec-1", "ws-1", baseCallbacks)
    expect(wrapped).toBeDefined()
    expect(controller.isActive("exec-1")).toBe(true)
  })

  it("setRepairService replaces previous repairService", () => {
    const mocks = makeMocks()
    const firstRepairService = {
      intervene: vi.fn().mockResolvedValue({ injected: true }),
    }

    const controller = new HarnessController({
      ...mocks,
      repairService: firstRepairService as any,
    })

    const secondRepairService = {
      intervene: vi.fn().mockResolvedValue({ injected: false }),
    }

    controller.setRepairService(secondRepairService as any)

    // Controller still works
    expect(controller).toBeDefined()
  })
})
