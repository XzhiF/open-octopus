import { describe, it, expect } from "vitest"
import type { Checkpoint, SwarmCheckpointData } from "../pipeline/checkpoint-types"
import type { Message, ExpertResult } from "../executors/swarm/swarm-types"

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    from: "reviewer",
    to: "*",
    round: 1,
    content: "test message content",
    timestamp: Date.now(),
    ...overrides,
  }
}

function makeExpertResult(overrides: Partial<ExpertResult> = {}): ExpertResult {
  return {
    role: "reviewer",
    status: "completed",
    output: "review output",
    rounds: 2,
    tools_used: ["read_file"],
    files_changed: ["src/index.ts"],
    source: "predefined",
    attempts: 1,
    ...overrides,
  }
}

function makeSwarmCheckpointData(overrides: Partial<SwarmCheckpointData> = {}): SwarmCheckpointData {
  return {
    nodeId: "swarm-1",
    mode: "review",
    currentRound: 2,
    messages: [
      makeMessage({ from: "reviewer", to: "*", round: 1, content: "first message" }),
      makeMessage({ from: "critic", to: "*", round: 1, content: "second message" }),
      makeMessage({ from: "reviewer", to: "critic", round: 2, content: "third message" }),
    ],
    expertResults: [
      makeExpertResult({ role: "reviewer", status: "completed" }),
      makeExpertResult({ role: "critic", status: "completed" }),
    ],
    consensusScore: 0.85,
    consumedTokens: 5000,
    startTime: Date.now(),
    ...overrides,
  }
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    executionId: "exec-001",
    workflowRef: "test-workflow.yaml",
    timestamp: new Date().toISOString(),
    completedNodes: {
      "swarm-1": { status: "completed", durationMs: 15000, retryCount: 0 },
    },
    poolSnapshot: { $vars_result: "done" },
    branchSessionIds: {},
    resumeAttempts: 0,
    ...overrides,
  }
}

describe("SwarmCheckpointData", () => {
  it("TC-027: creates SwarmCheckpointData with messages and expert results, verifies structure integrity", () => {
    const data = makeSwarmCheckpointData()

    expect(data.nodeId).toBe("swarm-1")
    expect(data.mode).toBe("review")
    expect(data.currentRound).toBe(2)
    expect(data.messages).toHaveLength(3)
    expect(data.expertResults).toHaveLength(2)
    expect(data.consensusScore).toBe(0.85)
    expect(data.consumedTokens).toBe(5000)
    expect(typeof data.startTime).toBe("number")

    // Verify message structure
    expect(data.messages[0].from).toBe("reviewer")
    expect(data.messages[0].to).toBe("*")
    expect(data.messages[0].round).toBe(1)
    expect(typeof data.messages[0].content).toBe("string")
    expect(typeof data.messages[0].timestamp).toBe("number")

    // Verify expert result structure
    expect(data.expertResults[0].role).toBe("reviewer")
    expect(data.expertResults[0].status).toBe("completed")
    expect(data.expertResults[0].output).toBe("review output")
    expect(data.expertResults[0].rounds).toBe(2)
    expect(Array.isArray(data.expertResults[0].tools_used)).toBe(true)
    expect(Array.isArray(data.expertResults[0].files_changed)).toBe(true)
    expect(data.expertResults[0].source).toBe("predefined")
    expect(data.expertResults[0].attempts).toBe(1)
  })

  it("TC-028: checkpoint can be serialized/deserialized (JSON round-trip)", () => {
    const swarmData = makeSwarmCheckpointData()
    const checkpoint = makeCheckpoint({ swarmData })

    // Serialize to JSON and back
    const serialized = JSON.stringify(checkpoint)
    const deserialized: Checkpoint = JSON.parse(serialized)

    // Verify top-level fields
    expect(deserialized.executionId).toBe(checkpoint.executionId)
    expect(deserialized.workflowRef).toBe(checkpoint.workflowRef)
    expect(deserialized.timestamp).toBe(checkpoint.timestamp)
    expect(deserialized.resumeAttempts).toBe(0)

    // Verify swarmData survived round-trip
    expect(deserialized.swarmData).toBeDefined()
    expect(deserialized.swarmData!.nodeId).toBe("swarm-1")
    expect(deserialized.swarmData!.mode).toBe("review")
    expect(deserialized.swarmData!.currentRound).toBe(2)
    expect(deserialized.swarmData!.consensusScore).toBe(0.85)
    expect(deserialized.swarmData!.consumedTokens).toBe(5000)
    expect(deserialized.swarmData!.startTime).toBe(swarmData.startTime)
  })

  it("no sensitive data (API keys) in checkpoint", () => {
    const swarmData = makeSwarmCheckpointData()
    const checkpoint = makeCheckpoint({
      swarmData,
      poolSnapshot: {
        $vars_task: "analyze code",
        $vars_result: "done",
      },
    })

    const serialized = JSON.stringify(checkpoint)

    // Verify no common sensitive patterns exist in the serialized checkpoint
    const sensitivePatterns = [
      /sk-ant-/i,
      /sk-proj-/i,
      /api[_-]?key/i,
      /secret/i,
      /password/i,
      /token.*=.*[a-zA-Z0-9]{20,}/i,
      /ANTHROPIC_API_KEY/i,
      /OPENAI_API_KEY/i,
    ]

    for (const pattern of sensitivePatterns) {
      expect(serialized).not.toMatch(pattern)
    }
  })

  it("messages maintain order after deserialization", () => {
    const messages: Message[] = [
      makeMessage({ from: "reviewer", to: "*", round: 1, content: "msg-1", timestamp: 1000 }),
      makeMessage({ from: "critic", to: "*", round: 1, content: "msg-2", timestamp: 2000 }),
      makeMessage({ from: "reviewer", to: "critic", round: 2, content: "msg-3", timestamp: 3000 }),
      makeMessage({ from: "moderator", to: "*", round: 2, content: "msg-4", timestamp: 4000 }),
      makeMessage({ from: "reviewer", to: "*", round: 3, content: "msg-5", timestamp: 5000 }),
    ]

    const swarmData = makeSwarmCheckpointData({ messages })
    const checkpoint = makeCheckpoint({ swarmData })

    const deserialized: Checkpoint = JSON.parse(JSON.stringify(checkpoint))

    expect(deserialized.swarmData!.messages).toHaveLength(5)
    for (let i = 0; i < messages.length; i++) {
      expect(deserialized.swarmData!.messages[i].from).toBe(messages[i].from)
      expect(deserialized.swarmData!.messages[i].to).toBe(messages[i].to)
      expect(deserialized.swarmData!.messages[i].round).toBe(messages[i].round)
      expect(deserialized.swarmData!.messages[i].content).toBe(messages[i].content)
      expect(deserialized.swarmData!.messages[i].timestamp).toBe(messages[i].timestamp)
    }
  })

  it("ExpertResult status values are preserved after round-trip", () => {
    const expertResults: ExpertResult[] = [
      makeExpertResult({ role: "reviewer", status: "completed" }),
      makeExpertResult({ role: "critic", status: "failed", error: "budget exceeded" }),
      makeExpertResult({ role: "analyst", status: "skipped" }),
      makeExpertResult({ role: "architect", status: "budget_exceeded" }),
    ]

    const swarmData = makeSwarmCheckpointData({ expertResults })
    const checkpoint = makeCheckpoint({ swarmData })

    const deserialized: Checkpoint = JSON.parse(JSON.stringify(checkpoint))

    expect(deserialized.swarmData!.expertResults).toHaveLength(4)
    expect(deserialized.swarmData!.expertResults[0].status).toBe("completed")
    expect(deserialized.swarmData!.expertResults[1].status).toBe("failed")
    expect(deserialized.swarmData!.expertResults[1].error).toBe("budget exceeded")
    expect(deserialized.swarmData!.expertResults[2].status).toBe("skipped")
    expect(deserialized.swarmData!.expertResults[3].status).toBe("budget_exceeded")

    // Verify all status values are valid ExpertResult status values
    const validStatuses = ["completed", "failed", "skipped", "budget_exceeded"]
    for (const expert of deserialized.swarmData!.expertResults) {
      expect(validStatuses).toContain(expert.status)
    }
  })

  it("checkpoint without swarmData has swarmData as undefined", () => {
    const checkpoint = makeCheckpoint()
    const deserialized: Checkpoint = JSON.parse(JSON.stringify(checkpoint))

    // JSON.stringify strips undefined fields, so swarmData won't exist
    expect(deserialized.swarmData).toBeUndefined()
  })

  it("checkpoint with null consensusScore preserves null after round-trip", () => {
    const swarmData = makeSwarmCheckpointData({ consensusScore: null })
    const checkpoint = makeCheckpoint({ swarmData })

    const deserialized: Checkpoint = JSON.parse(JSON.stringify(checkpoint))

    expect(deserialized.swarmData!.consensusScore).toBeNull()
  })
})
