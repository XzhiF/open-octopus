import { describe, it, expect } from "vitest"
import { applyFilters } from "../notify/filters"

describe("applyFilters", () => {
  describe("duration filter", () => {
    it("formats milliseconds", () => {
      const result = applyFilters("${dur | duration}", { dur: "500" })
      expect(result).toBe("500ms")
    })

    it("formats seconds", () => {
      const result = applyFilters("${dur | duration}", { dur: "5000" })
      expect(result).toBe("5s")
    })

    it("formats fractional seconds", () => {
      const result = applyFilters("${dur | duration}", { dur: "1500" })
      expect(result).toBe("1.5s")
    })

    it("formats minutes and seconds", () => {
      const result = applyFilters("${dur | duration}", { dur: "125000" })
      expect(result).toBe("2m 5s")
    })

    it("formats exact minutes", () => {
      const result = applyFilters("${dur | duration}", { dur: "120000" })
      expect(result).toBe("2m")
    })

    it("does not output 60 seconds (Math.floor not Math.round)", () => {
      // 119500ms = 1m 59.5s -> should floor to 1m 59s, NOT round to 1m 60s
      const result = applyFilters("${dur | duration}", { dur: "119500" })
      expect(result).toBe("1m 59s")
    })

    it("preserves non-numeric values", () => {
      const result = applyFilters("${dur | duration}", { dur: "abc" })
      expect(result).toBe("abc")
    })
  })

  describe("truncate filter", () => {
    it("truncates long strings with ellipsis", () => {
      const result = applyFilters("${text | truncate:5}", { text: "hello world" })
      expect(result).toBe("hello...")
    })

    it("preserves short strings", () => {
      const result = applyFilters("${text | truncate:20}", { text: "short" })
      expect(result).toBe("short")
    })

    it("uses default max length of 100", () => {
      const long = "a".repeat(150)
      const result = applyFilters("${text | truncate}", { text: long })
      expect(result).toHaveLength(103) // 100 + "..."
    })
  })

  describe("default filter", () => {
    it("returns value when present", () => {
      const result = applyFilters("${name | default:Anonymous}", { name: "Alice" })
      expect(result).toBe("Alice")
    })

    it("returns default when value is empty", () => {
      const result = applyFilters("${name | default:Anonymous}", { name: "" })
      expect(result).toBe("Anonymous")
    })

    it("returns default when variable is missing", () => {
      const result = applyFilters("${missing | default:fallback}", {})
      expect(result).toBe("fallback")
    })

    it("preserves colons in default value (e.g. URLs)", () => {
      const result = applyFilters("${url | default:https://example.com}", { url: "" })
      expect(result).toBe("https://example.com")
    })

    it("recursively resolves nested default expressions", () => {
      const result = applyFilters(
        "${a | default:${b | default:fallback}}",
        { a: "", b: "" }
      )
      expect(result).toBe("fallback")
    })

    it("uses inner variable when outer is empty", () => {
      const result = applyFilters(
        "${a | default:${b | default:fallback}}",
        { a: "", b: "inner-value" }
      )
      expect(result).toBe("inner-value")
    })

    it("uses outer variable when present (ignores inner)", () => {
      const result = applyFilters(
        "${a | default:${b | default:fallback}}",
        { a: "outer-value", b: "inner-value" }
      )
      expect(result).toBe("outer-value")
    })

    it("handles 3-level nested defaults", () => {
      const result = applyFilters(
        "${a | default:${b | default:${c | default:deep}}}",
        { a: "", b: "", c: "c-value" }
      )
      expect(result).toBe("c-value")
    })
  })

  describe("case filters", () => {
    it("converts to uppercase", () => {
      const result = applyFilters("${text | upper}", { text: "hello" })
      expect(result).toBe("HELLO")
    })

    it("converts to lowercase", () => {
      const result = applyFilters("${text | lower}", { text: "HELLO" })
      expect(result).toBe("hello")
    })
  })

  describe("edge cases", () => {
    it("preserves unknown filters", () => {
      const result = applyFilters("${text | unknown_filter}", { text: "hello" })
      expect(result).toBe("${text | unknown_filter}")
    })

    it("handles multiple filters in one string", () => {
      const result = applyFilters("${a | upper} and ${b | lower}", { a: "hello", b: "WORLD" })
      expect(result).toBe("HELLO and world")
    })

    it("handles text without filters", () => {
      const result = applyFilters("no filters here", {})
      expect(result).toBe("no filters here")
    })
  })
})
