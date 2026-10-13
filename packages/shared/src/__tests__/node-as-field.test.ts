// packages/shared/src/__tests__/node-as-field.test.ts
//
// LLM-WIKI P1 ticket 10 — L1 structural schema for the `as:` execution-identity
// field on workflow nodes. NodeDef gains optional `as` (clone English code,
// /^[a-z0-9-]+$/ with optional @<version> pin — story 25). Expected values
// quoted from the prototype YAML (Tab② "as: workflow-operator") — an
// independent source of truth, not derived from the implementation.

import { describe, it, expect } from "vitest"
import { parseWorkflow } from "../yaml/parser"
import { NodeSchema } from "../types/workflow"

function parseAgentNode(yamlNode: string): Record<string, unknown> {
  const yaml = `apiVersion: octopus/v1
kind: Workflow
name: as-field-fixture
nodes:
${yamlNode}
`
  const wf = parseWorkflow(yaml)
  return wf.nodes[0] as unknown as Record<string, unknown>
}

describe("NodeDef `as:` field — L1 schema (ticket 10)", () => {
  it("parses an agent node carrying `as: workflow-operator` (prototype Tab② verbatim)", () => {
    const node = parseAgentNode(`  - id: implement
    type: agent
    as: workflow-operator
    prompt: 实现需求...`)
    expect(node.type).toBe("agent")
    expect(node.as).toBe("workflow-operator")
    expect(node.prompt).toBe("实现需求...")
  })

  it("keeps `as` optional: agent node without it parses unchanged", () => {
    const node = parseAgentNode(`  - id: legacy
    type: agent
    prompt: hello`)
    expect(node.as).toBeUndefined()
  })

  it("accepts clone-code shapes matching /^[a-z0-9-]+$/ (hyphens, digits, lowercase)", () => {
    const node = parseAgentNode(`  - id: a1
    type: agent
    as: feat-branch-2
    prompt: x`)
    expect(node.as).toBe("feat-branch-2")
  })

  it("rejects uppercase, spaces and empty `as` values via the regex", () => {
    for (const bad of ["Workflow-Operator", "bad name", "", "中文代号"]) {
      expect(
        NodeSchema.safeParse({ id: "n", type: "agent", prompt: "x", as: bad }),
        `expected rejection for as: "${bad}"`,
      ).toMatchObject({ success: false })
    }
  })

  it("accepts an optional @version pin inside `as:` (story 25 — 工作流可钉住身份版本)", () => {
    // IdentityResolver.parseIdentityRef 早已支持 name@version；L1 正则不得再把
    // 合法的钉版本 ref 拦在门外（review fix #5）。Maven 式 stage 后缀同样放行。
    for (const ok of [
      "security-auditor@3",
      "workflow-operator@1.2.0",
      "task-doer@1.0.0-rc1",
      "archive@latest",
    ]) {
      expect(
        NodeSchema.safeParse({ id: "n", type: "agent", prompt: "x", as: ok }).success,
        `expected acceptance for as: "${ok}"`,
      ).toBe(true)
    }
  })

  it("still rejects malformed pins (@ 悬空、双 @、非法字符、大写)", () => {
    for (const bad of ["security-auditor@", "@3", "foo@bar@baz", "Foo@1", "foo@1.2.0!", "foo@1.2 space"]) {
      expect(
        NodeSchema.safeParse({ id: "n", type: "agent", prompt: "x", as: bad }).success,
        `expected rejection for as: "${bad}"`,
      ).toBe(false)
    }
  })

  it("rejects a non-string `as` value", () => {
    expect(NodeSchema.safeParse({ id: "n", type: "agent", prompt: "x", as: 42 }).success).toBe(false)
  })
})
