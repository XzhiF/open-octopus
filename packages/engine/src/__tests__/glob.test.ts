import { describe, it, expect } from "vitest"
import { globMatch } from "../pipeline/glob"

describe("globMatch", () => {
  describe("exact strings", () => {
    it("matches exact string", () => {
      expect(globMatch("hello", "hello")).toBe(true)
    })

    it("does not match different string", () => {
      expect(globMatch("hello", "world")).toBe(false)
    })

    it("does not match partial string", () => {
      expect(globMatch("hello", "hell")).toBe(false)
      expect(globMatch("hell", "hello")).toBe(false)
    })

    it("matches empty pattern and empty string", () => {
      expect(globMatch("", "")).toBe(true)
    })

    it("does not match empty pattern with non-empty string", () => {
      expect(globMatch("", "a")).toBe(false)
    })

    it("does not match non-empty pattern with empty string", () => {
      expect(globMatch("a", "")).toBe(false)
    })
  })

  describe("* wildcard", () => {
    it("matches any string with * at end", () => {
      expect(globMatch("hello*", "hello")).toBe(true)
      expect(globMatch("hello*", "helloworld")).toBe(true)
      expect(globMatch("hello*", "hello world")).toBe(true)
    })

    it("matches any string with * at start", () => {
      expect(globMatch("*world", "world")).toBe(true)
      expect(globMatch("*world", "helloworld")).toBe(true)
      expect(globMatch("*world", "hello world")).toBe(true)
    })

    it("matches any string with * in middle", () => {
      expect(globMatch("hel*ld", "hello world")).toBe(true)
      expect(globMatch("hel*ld", "helld")).toBe(true)
    })

    it("matches any string with single *", () => {
      expect(globMatch("*", "")).toBe(true)
      expect(globMatch("*", "anything")).toBe(true)
    })

    it("matches with multiple * wildcards", () => {
      expect(globMatch("*-*-*", "a-b-c")).toBe(true)
      expect(globMatch("*-*-*", "foo-bar-baz")).toBe(true)
      expect(globMatch("*-*-*", "abc")).toBe(false)
    })
  })

  describe("? wildcard", () => {
    it("matches single character with ?", () => {
      expect(globMatch("hel?o", "hello")).toBe(true)
    })

    it("does not match zero characters with ?", () => {
      expect(globMatch("hel?o", "helo")).toBe(false)
    })

    it("does not match multiple characters with ?", () => {
      expect(globMatch("hel?o", "helllo")).toBe(false)
    })

    it("matches single ? against single char", () => {
      expect(globMatch("?", "a")).toBe(true)
      expect(globMatch("?", "z")).toBe(true)
    })

    it("does not match ? against empty", () => {
      expect(globMatch("?", "")).toBe(false)
    })

    it("matches multiple ? wildcards", () => {
      expect(globMatch("???", "abc")).toBe(true)
      expect(globMatch("???", "ab")).toBe(false)
      expect(globMatch("???", "abcd")).toBe(false)
    })
  })

  describe("no wildcards", () => {
    it("matches literal string exactly", () => {
      expect(globMatch("test-node-1", "test-node-1")).toBe(true)
    })

    it("does not match similar but different strings", () => {
      expect(globMatch("test-node-1", "test-node-2")).toBe(false)
    })
  })

  describe("regex special char escaping", () => {
    it("escapes . as literal", () => {
      expect(globMatch("file.txt", "file.txt")).toBe(true)
      expect(globMatch("file.txt", "fileatxt")).toBe(false)
    })

    it("escapes + as literal", () => {
      expect(globMatch("a+b", "a+b")).toBe(true)
      expect(globMatch("a+b", "aab")).toBe(false)
    })

    it("escapes parentheses as literals", () => {
      expect(globMatch("(test)", "(test)")).toBe(true)
      expect(globMatch("(test)", "test")).toBe(false)
    })

    it("escapes brackets as literals", () => {
      expect(globMatch("[abc]", "[abc]")).toBe(true)
      expect(globMatch("[abc]", "a")).toBe(false)
    })

    it("escapes braces as literals", () => {
      expect(globMatch("{x}", "{x}")).toBe(true)
    })

    it("escapes ^ and $ as literals", () => {
      expect(globMatch("^start$", "^start$")).toBe(true)
      expect(globMatch("^start$", "start")).toBe(false)
    })

    it("escapes | as literal", () => {
      expect(globMatch("a|b", "a|b")).toBe(true)
      expect(globMatch("a|b", "a")).toBe(false)
    })

    it("escapes backslash as literal", () => {
      expect(globMatch("a\\b", "a\\b")).toBe(true)
    })
  })

  describe("combined wildcards and literals", () => {
    it("handles complex patterns", () => {
      expect(globMatch("test-*-node-?", "test-foo-node-1")).toBe(true)
      expect(globMatch("test-*-node-?", "test-bar-node-2")).toBe(true)
      expect(globMatch("test-*-node-?", "test-foo-node-12")).toBe(false)
    })

    it("handles * at multiple positions", () => {
      expect(globMatch("*-deploy-*", "prod-deploy-step")).toBe(true)
      expect(globMatch("*-deploy-*", "staging-deploy-verify")).toBe(true)
    })
  })
})
