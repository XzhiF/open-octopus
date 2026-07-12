import { describe, it, expect } from "vitest"
import { TemplateRenderer, validateTemplateSyntax } from "../notify/template-renderer"
import { VarPool } from "../variables/var-pool"

describe("TemplateRenderer", () => {
  const renderer = new TemplateRenderer()

  describe("render", () => {
    it("renders simple title and body", () => {
      const pool = new VarPool({ name: "test" })
      const msg = renderer.render(
        { severity: "info", title: "Hello $vars.name", body: "Body text" },
        pool
      )
      expect(msg.severity).toBe("info")
      expect(msg.title).toBe("Hello test")
      expect(msg.body).toBe("Body text")
    })

    it("defaults severity to info", () => {
      const pool = new VarPool({})
      const msg = renderer.render({ severity: "info", title: "Test" }, pool)
      expect(msg.severity).toBe("info")
    })

    it("renders empty body when not provided", () => {
      const pool = new VarPool({})
      const msg = renderer.render({ severity: "warn", title: "Alert" }, pool)
      expect(msg.body).toBe("")
    })

    it("substitutes $vars.* variables", () => {
      const pool = new VarPool({ status: "completed", duration: "5000" })
      const msg = renderer.render(
        { severity: "info", title: "Status: $vars.status", body: "Duration: $vars.duration" },
        pool
      )
      expect(msg.title).toBe("Status: completed")
      expect(msg.body).toBe("Duration: 5000")
    })

    it("applies ${var | filter} syntax", () => {
      const pool = new VarPool({ name: "alice" })
      const msg = renderer.render(
        { severity: "info", title: "${name | upper}" },
        pool
      )
      expect(msg.title).toBe("ALICE")
    })

    it("resolves $nodeId.output.* references", () => {
      const pool = new VarPool({})
      const nodeOutputs = { "build": { status: "ok", exitCode: "0" } }
      const msg = renderer.render(
        { severity: "info", title: "Build: $build.output.status" },
        pool,
        nodeOutputs
      )
      expect(msg.title).toBe("Build: ok")
    })
  })

  describe("validate (template syntax)", () => {
    it("returns no errors for valid template", () => {
      const errors = validateTemplateSyntax({
        severity: "info",
        title: "Valid template",
        body: "All good",
      })
      expect(errors).toHaveLength(0)
    })

    it("rejects empty title", () => {
      const errors = validateTemplateSyntax({
        severity: "info",
        title: "",
      })
      expect(errors.some(e => e.includes("title"))).toBe(true)
    })

    it("detects unmatched conditionals", () => {
      const errors = validateTemplateSyntax({
        severity: "info",
        title: "{{#if $vars.x}}missing endif",
      })
      expect(errors.some(e => e.includes("Unmatched conditionals"))).toBe(true)
    })

    it("accepts matched conditionals", () => {
      const errors = validateTemplateSyntax({
        severity: "info",
        title: "{{#if $vars.x}}content{{/if}}",
      })
      expect(errors).toHaveLength(0)
    })
  })

  describe("conditionals rendering", () => {
    it("renders truthy conditional content", () => {
      const pool = new VarPool({ show: "yes" })
      const msg = renderer.render(
        { severity: "info", title: "{{#if $vars.show}}visible{{/if}}" },
        pool
      )
      expect(msg.title).toBe("visible")
    })

    it("hides falsy conditional content", () => {
      const pool = new VarPool({})
      const msg = renderer.render(
        { severity: "info", title: "before{{#if $vars.missing}}hidden{{/if}}after" },
        pool
      )
      expect(msg.title).toBe("beforeafter")
    })

    it("renders $hook.* conditional — truthy", () => {
      const pool = new VarPool({})
      pool.set("hook.final_status", "completed")
      const msg = renderer.render(
        { severity: "info", title: "{{#if $hook.final_status}}🎉{{/if}} done" },
        pool
      )
      expect(msg.title).toBe("🎉 done")
    })

    it("hides $hook.* conditional — falsy (0)", () => {
      const pool = new VarPool({})
      pool.set("hook.failed_count", "0")
      const msg = renderer.render(
        { severity: "info", title: "ok{{#if $hook.failed_count}} / ❌ $hook.failed_count{{/if}}" },
        pool
      )
      expect(msg.title).toBe("ok")
    })

    it("shows $hook.* conditional — truthy (non-zero)", () => {
      const pool = new VarPool({})
      pool.set("hook.failed_count", "3")
      const msg = renderer.render(
        { severity: "info", title: "ok{{#if $hook.failed_count}} / ❌ $hook.failed_count{{/if}}" },
        pool
      )
      expect(msg.title).toBe("ok / ❌ 3")
    })

    it("handles sequential $hook.* conditionals (status emoji pattern)", () => {
      const pool = new VarPool({})
      pool.set("hook.final_status", "completed")
      pool.set("hook.failed_count", "0")
      const msg = renderer.render(
        { severity: "info", title: "{{#if $hook.final_status}}🎉{{/if}}{{#if $hook.failed_count}}😵{{/if}} done" },
        pool
      )
      expect(msg.title).toBe("🎉 done")
    })

    it("handles mixed $vars.* and $hook.* conditionals", () => {
      const pool = new VarPool({ display_name: "test-flow" })
      pool.set("hook.failed_count", "0")
      pool.set("hook.skipped_count", "2")
      const msg = renderer.render(
        {
          severity: "info",
          title: "✅ $vars.display_name",
          body: "✅ $hook.completed_count{{#if $hook.skipped_count}} / ⏭️ $hook.skipped_count{{/if}}{{#if $hook.failed_count}} / ❌ $hook.failed_count{{/if}}"
        },
        pool
      )
      expect(msg.body).toBe("✅ $hook.completed_count / ⏭️ 2")
    })
  })

  describe("nested default filter expressions", () => {
    it("resolves nested defaults when outer var is missing", () => {
      const pool = new VarPool({})
      pool.set("hook.error", "crash")
      const msg = renderer.render(
        { severity: "error", title: "${vars.reason | default:${hook.error | default:unknown}}" },
        pool
      )
      expect(msg.title).toBe("crash")
    })

    it("resolves to innermost fallback when all vars missing", () => {
      const pool = new VarPool({})
      pool.set("hook.error", "")
      const msg = renderer.render(
        { severity: "error", title: "${vars.reason | default:${hook.error | default:未提供}}" },
        pool
      )
      expect(msg.title).toBe("未提供")
    })

    it("uses outer var value when present (ignores fallback chain)", () => {
      const pool = new VarPool({ reason: "E2E failed" })
      pool.set("hook.error", "timeout")
      const msg = renderer.render(
        { severity: "error", title: "${vars.reason | default:${hook.error | default:unknown}}" },
        pool
      )
      expect(msg.title).toBe("E2E failed")
    })

    it("handles 3-level nesting", () => {
      const pool = new VarPool({})
      pool.set("hook.a", "")
      pool.set("hook.b", "")
      pool.set("hook.c", "deep")
      const msg = renderer.render(
        { severity: "info", title: "${hook.a | default:${hook.b | default:${hook.c | default:none}}}" },
        pool
      )
      expect(msg.title).toBe("deep")
    })

    it("preserves colons in default values (URLs)", () => {
      const pool = new VarPool({})
      pool.set("hook.url", "")
      const msg = renderer.render(
        { severity: "info", title: "${hook.url | default:https://example.com}" },
        pool
      )
      expect(msg.title).toBe("https://example.com")
    })

    it("renders full workflow failure template correctly", () => {
      const pool = new VarPool({ display_name: "my-flow", projects: "proj", branch: "feat" })
      pool.set("hook.failed_node_id", "")
      pool.set("hook.total_duration_ms", "18904000")
      pool.set("hook.error", "")
      const msg = renderer.render(
        {
          severity: "error",
          title: "❌ $vars.display_name — 工作流失败",
          body: "🔴 失败节点: ${hook.failed_node_id | default:软失败}\n⏱️ 已运行: ${hook.total_duration_ms | duration}\n💡 原因: ${vars.failed_reason | default:${hook.error | default:未提供}}"
        },
        pool
      )
      expect(msg.title).toBe("❌ my-flow — 工作流失败")
      expect(msg.body).toContain("软失败")
      expect(msg.body).toContain("315m 4s")
      expect(msg.body).toContain("未提供")
    })
  })
})
