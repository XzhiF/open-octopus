// 防漂移：mcp-catalog 的工具名单必须与两个 tools 源文件里 tool("name", ...)
// 的集合完全一致。加/删/改工具时不更新 catalog → 这里红。
import { readFileSync } from "fs"
import { join } from "path"
import { describe, it, expect } from "vitest"
import { buildMcpCatalog } from "../mcp-catalog"

const SRC_DIR = join(__dirname, "..")

function toolNamesIn(file: string): Set<string> {
  const text = readFileSync(join(SRC_DIR, file), "utf-8")
  const names = new Set<string>()
  const re = /tool\(\s*"([a-z_]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) names.add(m[1])
  return names
}

describe("mcp-catalog ↔ tools 源码 集合一致", () => {
  const catalog = buildMcpCatalog()
  const byServer = new Map(catalog.map((s) => [s.server, s.tools.map((t) => t.name)]))

  it("octopus-workflow 工具集合 = workflow-tools.ts", () => {
    expect([...(byServer.get("octopus-workflow") ?? [])].sort()).toEqual(
      [...toolNamesIn("workflow-tools.ts")].sort(),
    )
  })

  it("octopus-task 工具集合 = task-tools.ts", () => {
    expect([...(byServer.get("octopus-task") ?? [])].sort()).toEqual(
      [...toolNamesIn("task-tools.ts")].sort(),
    )
  })

  it("每个工具都配了非空描述", () => {
    for (const server of catalog) {
      for (const t of server.tools) {
        expect(t.description.length, `${server.server}.${t.name}`).toBeGreaterThan(8)
      }
    }
  })
})
