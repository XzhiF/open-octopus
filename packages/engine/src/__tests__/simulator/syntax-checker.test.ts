import { describe, it, expect } from "vitest"
import { checkSyntax } from "../../simulator/syntax-checker"

describe("checkSyntax", () => {
  describe("bash syntax", () => {
    it("passes for valid bash", () => {
      const result = checkSyntax([
        { id: "bash-1", type: "bash", bash: 'echo "hello"' },
      ])
      expect(result.passed).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("fails for bash syntax error", () => {
      const result = checkSyntax([
        { id: "bash-1", type: "bash", bash: "if [ ; then fi" },
      ])
      expect(result.passed).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].nodeId).toBe("bash-1")
      expect(result.errors[0].nodeType).toBe("bash")
    })

    it("fails for unclosed quote", () => {
      const result = checkSyntax([
        { id: "bash-1", type: "bash", bash: 'echo "unclosed' },
      ])
      expect(result.passed).toBe(false)
    })

    it("passes for empty script", () => {
      const result = checkSyntax([
        { id: "bash-1", type: "bash", bash: "" },
      ])
      expect(result.passed).toBe(true)
    })

    it("passes for multiline bash", () => {
      const result = checkSyntax([
        { id: "bash-1", type: "bash", bash: "for i in 1 2 3; do\necho $i\ndone" },
      ])
      expect(result.passed).toBe(true)
    })
  })

  describe("python syntax", () => {
    it("passes for valid python", () => {
      const result = checkSyntax([
        { id: "py-1", type: "python", python: "x = 1 + 2\nprint(x)" },
      ])
      expect(result.passed).toBe(true)
    })

    it("fails for python syntax error", () => {
      const result = checkSyntax([
        { id: "py-1", type: "python", python: "def foo(\n  pass" },
      ])
      expect(result.passed).toBe(false)
      expect(result.errors[0].nodeType).toBe("python")
    })

    it("fails for python indentation error", () => {
      const result = checkSyntax([
        { id: "py-1", type: "python", python: 'if True:\nprint("bad")' },
      ])
      expect(result.passed).toBe(false)
    })
  })

  describe("loop inner nodes", () => {
    it("checks syntax of inner bash nodes", () => {
      const result = checkSyntax([
        {
          id: "loop-1",
          type: "loop",
          nodes: [
            { id: "inner-bash", type: "bash", bash: "if [ ; then fi" },
          ],
        },
      ])
      expect(result.passed).toBe(false)
      expect(result.errors[0].nodeId).toBe("inner-bash")
    })
  })

  describe("mixed nodes", () => {
    it("skips non-script nodes", () => {
      const result = checkSyntax([
        { id: "agent-1", type: "agent" },
        { id: "cond-1", type: "condition" },
        { id: "bash-1", type: "bash", bash: "echo ok" },
      ])
      expect(result.passed).toBe(true)
    })
  })
})
