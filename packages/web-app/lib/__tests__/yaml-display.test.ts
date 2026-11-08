import { describe, expect, it } from "vitest"
import {
  applyMatchHighlights,
  blockScalarFlags,
  countYamlLines,
  diffLineNumbers,
  extractYamlNodes,
  findYamlMatches,
  highlightYamlLine,
  splitYamlLines,
} from "@/lib/yaml-display"

const kinds = (line: string, inBlock = false) =>
  highlightYamlLine(line, inBlock).map((token) => [token.kind, token.text] as const)

describe("highlightYamlLine", () => {
  it("key + 字符串值 + 注释", () => {
    expect(kinds('name: "ticket-dag" # 名字')).toEqual([
      ["key", "name"],
      ["punct", ":"],
      ["plain", " "],
      ["str", '"ticket-dag"'],
      ["plain", " "],
      ["comment", "# 名字"],
    ])
  })

  it("列表项、数字、布尔、块标量头", () => {
    expect(kinds("  - id: ticket-01")).toEqual([
      ["plain", "  "],
      ["punct", "- "],
      ["key", "id"],
      ["punct", ":"],
      ["plain", " "],
      ["plain", "ticket-01"],
    ])
    expect(kinds("timeout: 120").at(-1)).toEqual(["num", "120"])
    expect(kinds("required: true").at(-1)).toEqual(["bool", "true"])
    expect(kinds("bash: |").at(-1)).toEqual(["punct", "|"])
  })

  it("$ 变量标紫", () => {
    expect(kinds("condition: $vars.has_e2e == \"true\"")).toContainEqual([
      "mark",
      "$vars.has_e2e == \"true\"",
    ])
  })

  it("块标量正文整体 plain，但保留 shell 注释色", () => {
    expect(kinds("  BATCH=\"$inputs.batch_dir\"", true)).toEqual([
      ["plain", "  BATCH=\"$inputs.batch_dir\""],
    ])
    expect(kinds("  # 跳过 done", true)).toEqual([
      ["plain", "  "],
      ["comment", "# 跳过 done"],
    ])
  })

  it("token 的 start 偏移与原文对齐（搜索切段依赖它）", () => {
    const tokens = highlightYamlLine('  name: "x" # c', false)
    for (const token of tokens) {
      expect('  name: "x" # c'.slice(token.start, token.start + token.text.length)).toBe(token.text)
    }
  })
})

describe("blockScalarFlags", () => {
  it("| / > 正文行标记为 true，缩进退回到同级后结束", () => {
    const lines = [
      "  - id: a",
      "    bash: |",
      "      echo hi",
      "",
      "      # comment",
      "    timeout: 10",
      "  - id: b",
    ]
    expect(blockScalarFlags(lines)).toEqual([false, false, true, true, true, false, false])
  })
})

describe("extractYamlNodes", () => {
  it("按行提取 id/type，嵌套节点也算", () => {
    const lines = [
      "nodes:",
      "  - id: a",
      "    type: bash",
      "    bash: |",
      "      echo 1",
      "  - id: b",
      "    type: dynamic_sub_workflow",
      "  - id: c",
    ]
    expect(extractYamlNodes(lines)).toEqual([
      { id: "a", type: "bash", line: 2 },
      { id: "b", type: "dynamic_sub_workflow", line: 6 },
      { id: "c", type: "", line: 8 },
    ])
  })
})

describe("findYamlMatches / applyMatchHighlights", () => {
  const lines = ["name: ticket-dag", "prompt: Ticket DAG", "nodes: []"]

  it("大小写不敏感，一行多次命中", () => {
    expect(findYamlMatches(lines, "ticket")).toEqual([
      { line: 0, start: 6, end: 12, index: 0 },
      { line: 1, start: 8, end: 14, index: 1 },
    ])
    expect(findYamlMatches(lines, "")).toEqual([])
  })

  it("命中区间切段并标记 current", () => {
    const tokens = highlightYamlLine(lines[0], false)
    const matches = findYamlMatches(lines, "ticket")
    const display = applyMatchHighlights(tokens, matches, 0)
    expect(display.map((token) => token.text).join("")).toBe(lines[0])
    expect(display.some((token) => token.hit && token.current && token.text === "ticket")).toBe(true)
  })
})

describe("diffLineNumbers", () => {
  it("逐行比对，行数变化也算差异", () => {
    expect(diffLineNumbers("a\nb\nc", "a\nx\nc")).toEqual(new Set([2]))
    expect(diffLineNumbers("a", "a\nb")).toEqual(new Set([2]))
  })
})

describe("splitYamlLines / countYamlLines", () => {
  it("统一 CRLF，并保留末尾空行", () => {
    expect(splitYamlLines("a\r\nb")).toEqual(["a", "b"])
    expect(splitYamlLines("a\n")).toEqual(["a", ""])
    expect(countYamlLines("a\nb")).toBe(2)
    expect(countYamlLines(null)).toBe(0)
  })
})
