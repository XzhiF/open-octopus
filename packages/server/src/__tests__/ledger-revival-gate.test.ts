import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as path from "path"

/**
 * C3 防复活门禁（验收③）：账本聚合公式只允许住在两个单源里 ——
 * shared/ledger.ts（JS + LEDGER_SQL 定义）与 server 的 usage-ledger.ts（写侧决策）。
 * server 生产代码一旦再手写第 42 处公式（旧 41 处的复活路径），本测试红。
 *
 * 违禁式：
 *   G1 COALESCE(SUM(...cost...), 0)          —— NULL 焊 0（假 $0 / 假总额）
 *   G2 SUM(a.input_tokens + a.output_tokens) —— 两字段折叠口径（Q2 已废）
 *   G3 WHERE cost_usd IS NOT NULL 聚合过滤    —— 未定价行从分母消失（dashboard 旧病）
 *   G4 `cost(_usd)? ?? 0` 的 JS 求和          —— 需 `// ledger-ok:` 行内豁免标记
 */

const SRC = path.resolve(__dirname, "..")

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "G1 COALESCE(SUM(cost),0)", re: /COALESCE\(\s*SUM\([^)]*cost[^)]*\)\s*,\s*0\s*\)/i },
  { name: "G2 两字段折叠 SUM(input+output)", re: /SUM\(\s*\w*\.?input_tokens\s*\+\s*\w*\.?output_tokens\s*\)/i },
  { name: "G3 聚合过滤未定价行", re: /cost_usd\s+IS\s+NOT\s+NULL/i },
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules" || e.name === "dist") continue
      out.push(...walk(p))
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p)
    }
  }
  return out
}

describe("ledger 防复活门禁 (C3)", () => {
  it("server 生产代码无手写账本聚合式（G1-G3）", () => {
    const violations: string[] = []
    for (const file of walk(SRC)) {
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((line, i) => {
        if (line.includes("ledger-ok:")) return
        for (const { name, re } of FORBIDDEN) {
          if (re.test(line)) violations.push(`${path.relative(SRC, file)}:${i + 1} [${name}] ${line.trim().slice(0, 90)}`)
        }
      })
    }
    expect(violations, `发现 ${violations.length} 处账本公式复活：\n${violations.join("\n")}`).toEqual([])
  })

  it("JS 侧 cost ?? 0 求和必须带 ledger-ok 豁免标记（G4）", () => {
    const violations: string[] = []
    for (const file of walk(SRC)) {
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((line, i) => {
        if (line.includes("ledger-ok:")) return
        if (/cost_?usd[^)\n]*\?\?\s*0/i.test(line) && /(\+=|sum|reduce)/i.test(line)) {
          violations.push(`${path.relative(SRC, file)}:${i + 1} ${line.trim().slice(0, 90)}`)
        }
      })
    }
    expect(violations, `发现未豁免的 cost 焊 0：\n${violations.join("\n")}`).toEqual([])
  })

  it("写侧三 DAO 的 node_token_usages INSERT 只剩 recordNodeUsage 一处", () => {
    const inserters: string[] = []
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf-8")
      if (/INSERT\s+INTO\s+node_token_usages/i.test(text)) inserters.push(path.relative(SRC, file))
    }
    expect(inserters, `node_token_usages 应只有一个写入口，发现：${inserters.join(", ")}`).toEqual([
      path.join("db", "dao", "token-usage-dao.ts"),
    ])
  })
})
