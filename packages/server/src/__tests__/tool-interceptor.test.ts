// packages/server/src/__tests__/tool-interceptor.test.ts
//
// Tests for the Tool Interceptor (ticket 09):
// - AC3: Reuses ProcessConflictDetector's dangerous pattern matching
// - AC4: Dangerous command → block + DiagnosisReport
// - AC6: Safe command → pass through
// - AC7: Unit test coverage

import { describe, it, expect, vi, beforeEach } from "vitest"
import { ToolInterceptor } from "../services/harness/tool-interceptor"
import { DangerousPatternMatcher } from "../services/harness/dangerous-pattern-matcher"

describe("ToolInterceptor", () => {
  let interceptor: ToolInterceptor
  const hostPid = "12345"
  const hostPorts = ["3001", "8080"]

  beforeEach(() => {
    const matcher = new DangerousPatternMatcher({ hostPid, hostPorts })
    interceptor = new ToolInterceptor(matcher, {
      executionId: "exec-001",
      nodeId: "agent-node-1",
      nodeType: "agent",
    })
  })

  describe("AC4: dangerous command → block + DiagnosisReport", () => {
    it("blocks kill targeting host PID", () => {
      const result = interceptor.checkToolCall("Bash", { command: `kill ${hostPid}` })
      expect(result).not.toBeNull()
      expect(result!.blocked).toBe(true)
      expect(result!.report).toBeDefined()
      expect(result!.report.detector).toBe("tool_interceptor")
      expect(result!.report.severity).toBe("critical")
      expect(result!.report.pattern).toContain("process_conflict")
    })

    it("blocks kill targeting $OCTOPUS_HOST_PID", () => {
      const result = interceptor.checkToolCall("Bash", { command: "kill $OCTOPUS_HOST_PID" })
      expect(result).not.toBeNull()
      expect(result!.blocked).toBe(true)
    })

    it("blocks pkill targeting host PID", () => {
      const result = interceptor.checkToolCall("Bash", { command: `pkill -f ${hostPid}` })
      expect(result).not.toBeNull()
      expect(result!.blocked).toBe(true)
    })

    it("blocks taskkill targeting host PID", () => {
      const result = interceptor.checkToolCall("Bash", { command: `taskkill /PID ${hostPid}` })
      expect(result).not.toBeNull()
      expect(result!.blocked).toBe(true)
    })

    it("blocks binding to host port", () => {
      const result = interceptor.checkToolCall("Bash", { command: "python -m http.server 3001" })
      expect(result).not.toBeNull()
      expect(result!.blocked).toBe(true)
    })

    it("blocks nc on host port", () => {
      const result = interceptor.checkToolCall("Bash", { command: "nc -l 8080" })
      expect(result).not.toBeNull()
      expect(result!.blocked).toBe(true)
    })

    it("blocks Python os.kill with host PID", () => {
      const result = interceptor.checkToolCall("Bash", { command: `python -c "import os; os.kill(${hostPid}, 9)"` })
      expect(result).not.toBeNull()
      expect(result!.blocked).toBe(true)
    })

    it("blocks indirect PID reference (VAR=$OCTOPUS_HOST_PID then kill $VAR)", () => {
      const result = interceptor.checkToolCall("Bash", {
        command: "HOST_PID=$OCTOPUS_HOST_PID\nkill $HOST_PID",
      })
      expect(result).not.toBeNull()
      expect(result!.blocked).toBe(true)
    })
  })

  describe("AC6: safe command → pass through", () => {
    it("allows echo command", () => {
      const result = interceptor.checkToolCall("Bash", { command: "echo hello" })
      expect(result).toBeNull()
    })

    it("allows ls command", () => {
      const result = interceptor.checkToolCall("Bash", { command: "ls -la" })
      expect(result).toBeNull()
    })

    it("allows npm install", () => {
      const result = interceptor.checkToolCall("Bash", { command: "npm install" })
      expect(result).toBeNull()
    })

    it("allows git operations", () => {
      const result = interceptor.checkToolCall("Bash", { command: "git status" })
      expect(result).toBeNull()
    })

    it("allows curl to external service", () => {
      const result = interceptor.checkToolCall("Bash", { command: "curl https://api.example.com" })
      expect(result).toBeNull()
    })

    it("allows python script execution (safe)", () => {
      const result = interceptor.checkToolCall("Bash", { command: "python script.py" })
      expect(result).toBeNull()
    })
  })

  describe("AC2: hook receives tool name + input", () => {
    it("ignores non-Bash tools", () => {
      const result = interceptor.checkToolCall("Read", { file_path: "/etc/passwd" })
      expect(result).toBeNull()
    })

    it("ignores Write tools", () => {
      const result = interceptor.checkToolCall("Write", { file_path: "/tmp/test", content: "kill 12345" })
      expect(result).toBeNull()
    })

    it("handles missing command in Bash input", () => {
      const result = interceptor.checkToolCall("Bash", {})
      expect(result).toBeNull()
    })

    it("handles empty command string", () => {
      const result = interceptor.checkToolCall("Bash", { command: "" })
      expect(result).toBeNull()
    })
  })

  describe("DiagnosisReport structure", () => {
    it("generates correct report for blocked command", () => {
      const result = interceptor.checkToolCall("Bash", { command: `kill ${hostPid}` })
      expect(result).not.toBeNull()

      const report = result!.report
      expect(report.id).toContain("diagnosis-tool_interceptor")
      expect(report.executionId).toBe("exec-001")
      expect(report.nodeId).toBe("agent-node-1")
      expect(report.nodeType).toBe("agent")
      expect(report.evidence).toHaveLength(1)
      expect(report.evidence[0].errorMessage).toBeDefined()
    })
  })
})

describe("DangerousPatternMatcher", () => {
  it("can be constructed with empty config", () => {
    const matcher = new DangerousPatternMatcher({ hostPid: "", hostPorts: [] })
    expect(matcher).toBeDefined()
  })

  it("returns null for safe commands even with valid config", () => {
    const matcher = new DangerousPatternMatcher({ hostPid: "12345", hostPorts: ["3001"] })
    expect(matcher.match("echo hello")).toBeNull()
  })

  it("returns match info for dangerous commands", () => {
    const matcher = new DangerousPatternMatcher({ hostPid: "12345", hostPorts: ["3001"] })
    const result = matcher.match("kill 12345")
    expect(result).not.toBeNull()
    expect(result!.description).toContain("kill")
  })
})

describe("ToolInterceptor.createHook() — integration callback", () => {
  let interceptor: ToolInterceptor
  const hostPid = "12345"
  const hostPorts = ["3001"]

  beforeEach(() => {
    const matcher = new DangerousPatternMatcher({ hostPid, hostPorts })
    interceptor = new ToolInterceptor(matcher, {
      executionId: "exec-hook-001",
      nodeId: "agent-node-hook",
      nodeType: "agent",
    })
  })

  it("AC1+AC5: returns callback that blocks dangerous commands with guidance", async () => {
    const hook = interceptor.createHook()
    const result = await hook("Bash", { command: `kill ${hostPid}` })
    expect(result).toBeDefined()
    expect(result!.allow).toBe(false)
    expect(result!.reason).toContain("BLOCKED")
    expect(result!.reason).toContain("safe alternatives")
  })

  it("AC6: returns callback that allows safe commands", async () => {
    const hook = interceptor.createHook()
    const result = await hook("Bash", { command: "echo hello" })
    expect(result).toBeDefined()
    expect(result!.allow).toBe(true)
  })

  it("records blocked reports for later inspection", async () => {
    const hook = interceptor.createHook()
    await hook("Bash", { command: `kill ${hostPid}` })
    await hook("Bash", { command: "echo safe" })
    await hook("Bash", { command: `pkill -f ${hostPid}` })

    expect(interceptor.blockedReports).toHaveLength(2)
    expect(interceptor.blockedReports[0].detector).toBe("tool_interceptor")
    expect(interceptor.blockedReports[1].detector).toBe("tool_interceptor")
  })

  it("ignores non-Bash tools via hook", async () => {
    const hook = interceptor.createHook()
    const result = await hook("Read", { file_path: "/etc/passwd" })
    expect(result).toBeDefined()
    expect(result!.allow).toBe(true)
  })
})
