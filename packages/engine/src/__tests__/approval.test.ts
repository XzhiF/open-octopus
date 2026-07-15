import { describe, it, expect } from "vitest"
import { ApprovalExecutor } from "../executors/approval"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"

describe("ApprovalExecutor", () => {
  it("returns completed when userChoice is provided", async () => {
    const node: NodeDef = {
      id: "ap1",
      type: "approval",
      options: [
        { label: "Approve", value: "approve" },
        { label: "Reject", value: "reject" },
      ],
    }
    const pool = new VarPool()
    const executor = new ApprovalExecutor(node, pool, { userChoice: "approve", userComment: "looks good" })
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.decision).toBe("approve")
    expect(result.comment).toBe("looks good")
    expect(result.outputs.decision).toBe("approve")
  })

  it("returns pending_approval when no userChoice", async () => {
    const node: NodeDef = {
      id: "ap2",
      type: "approval",
      options: [
        { label: "Approve", value: "approve" },
      ],
    }
    const pool = new VarPool()
    const executor = new ApprovalExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("pending_approval")
  })

  it("includes timeout info with pending_approval status", async () => {
    const node: NodeDef = {
      id: "ap2b",
      type: "approval",
      approval_timeout: 300,
      options: [
        { label: "Approve", value: "approve" },
      ],
    }
    const pool = new VarPool()
    const executor = new ApprovalExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("pending_approval")
    expect(result.logLines).toContain("Approval timeout: 300s")
  })

  it("returns completed with reject decision", async () => {
    const node: NodeDef = {
      id: "ap3",
      type: "approval",
      options: [
        { label: "Approve", value: "approve" },
        { label: "Reject", value: "reject" },
      ],
    }
    const pool = new VarPool()
    const executor = new ApprovalExecutor(node, pool, { userChoice: "reject" })
    const result = await executor.execute()

    expect(result.status).toBe("rejected")
    expect(result.decision).toBe("reject")
  })
})