import { describe, it, expect } from "vitest"
import { extractWorkflowConfig } from "../workflow-config-extract"

const validConfig = {
  schema_version: "2.0",
  type: "workflow",
  workspace_spec: {
    org: "xzf",
    branch_prefix: "log-cleanup",
    projects: [{ name: "open-octopus", source_path: "", group: "" }],
  },
  workflow_chain: [{ workflow_ref: "test-task-workflow.yaml", input_values: {} }],
  max_retain: 10,
}

describe("T-11: extractWorkflowConfig", () => {
  // AC23: 前端从 AI 消息中提取 fenced code block (```json ... ```)
  it("AC23: 提取 fenced ```json``` block 的内容", () => {
    const content = "好的，这是配置：\n```json\n" + JSON.stringify(validConfig, null, 2) + "\n```\n请预览。"
    const result = extractWorkflowConfig(content)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.workspace_spec.org).toBe("xzf")
      expect(result.config.workspace_spec.branch_prefix).toBe("log-cleanup")
      expect(result.config.workflow_chain).toHaveLength(1)
      expect(result.config.max_retain).toBe(10)
    }
  })

  // AC23 反假跑: 无 fenced block 时 reason='no_block'，非正则兜底
  it("AC23 反假跑: 无 fenced block → reason='no_block'，非 catch 兜底", () => {
    const result = extractWorkflowConfig("这是普通消息，没有 JSON 围栏")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("no_block")
    }
  })

  // AC24 反假跑: Zod parse 真通过（含必填字段）
  it("AC24: 提取的 JSON 通过 workflowConfigSchema.parse() → ok=true", () => {
    const content = "```json\n" + JSON.stringify(validConfig) + "\n```"
    const result = extractWorkflowConfig(content)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.schema_version).toBe("2.0")
      expect(result.config.type).toBe("workflow")
    }
  })

  // AC25: parse 失败 → inline error + retry button
  it("AC25: JSON.parse 失败 → reason='parse_error'", () => {
    const content = "```json\n{ this is not valid json\n```"
    const result = extractWorkflowConfig(content)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("parse_error")
      expect(result.message).toMatch(/JSON/i)
    }
  })

  // AC25 反假跑: 故意构造 schema 不匹配 → reason='schema_error' (非 catch 忽略)
  it("AC25 反假跑: JSON 解析成功但 Zod schema 拒绝 → reason='schema_error'", () => {
    const broken = { ...validConfig, workflow_chain: [] } // min(1) violated
    const content = "```json\n" + JSON.stringify(broken) + "\n```"
    const result = extractWorkflowConfig(content)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("schema_error")
    }
  })

  it("AC25 反假跑: 缺 workspace_spec → reason='schema_error' 而非 ok=true", () => {
    const broken = { schema_version: "2.0", type: "workflow", workflow_chain: [{ workflow_ref: "x.yaml", input_values: {} }], max_retain: 10 }
    const content = "```json\n" + JSON.stringify(broken) + "\n```"
    const result = extractWorkflowConfig(content)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("schema_error")
    }
  })

  // Edge case: only picks the first ```json block when multiple exist
  it("picks first ```json block when multiple exist", () => {
    const content =
      "```json\n" + JSON.stringify(validConfig) + "\n```\n" +
      "```json\n{ \"broken\": true }\n```"
    const result = extractWorkflowConfig(content)
    expect(result.ok).toBe(true)
  })
})
