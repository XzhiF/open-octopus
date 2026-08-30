import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

// C4 / ADR-0017 防复活门禁（ledger-revival-gate 的展示层同构）：
// 格式化单源立法后，禁止在组件/页面里复活私有格式化器、裸货币/时长/百分比模板拼接。
// 行内豁免标记 `// fmt-ok:`（或 JSX 内 `{/* fmt-ok: … */}`）——仅限图表轴刻度、
// 数据层协议文本等确不适配 UI 文案格式化的场景，语义对齐 C3 的 `// ledger-ok:`。

const ROOT = join(__dirname, "..", "..")
const SCAN_DIRS = ["app", "components", "hooks", "lib"]
const SELF = join("lib", "format.ts")

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === "__tests__" || entry === "node_modules" || entry === ".next") continue
    const st = statSync(full)
    if (st.isDirectory()) collectSourceFiles(full, acc)
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full)
  }
  return acc
}

interface Violation {
  file: string
  line: number
  rule: string
  text: string
}

const RULES: Array<{ name: string; re: RegExp }> = [
  // 货币模板：`$${expr}` 字符串内插（JSX 文本里的 `$` 前缀拼钱）
  { name: "currency-template", re: /\$\$\{[^}]*\}/ },
  // 私有格式化器副本（formatElapsed/formatTime 等调用方业务 wrapper 不在禁列——
  // 重命名本身即声明"我是 wrapper 不是全站格式化器"）
  { name: "private-formatter", re: /\b(?:function|const)\s+(?:formatCost|formatTokens?\b|formatDuration|formatPercent|formatNumber|formatK\b|formatMs|formatSize|formatFileSize|fmtCost|fmt\b)/ },
  // 时长裸拼接：ms/1000 或秒值 toFixed 后紧跟 s/m 单位
  { name: "duration-template", re: /\)\s*\/\s*1000\)\.toFixed\(\d\)\}[sm]|\btoFixed\(\d\)\}s\b/ },
  // 百分比裸拼接：toFixed 后紧跟 %
  { name: "percent-template", re: /\.toFixed\(\d\)\}%/ },
]

describe("formatter revival gate (C4)", () => {
  const files = SCAN_DIRS.flatMap((d) => collectSourceFiles(join(ROOT, d)))
    .filter((f) => !f.endsWith(SELF))

  it("扫描面覆盖足够大（防目录规则失效）", () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it("无复活的格式化器副本/裸拼接（豁免行需带 fmt-ok 标记）", () => {
    const violations: Violation[] = []
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1)
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        if (line.includes("fmt-ok:")) return
        for (const rule of RULES) {
          if (rule.re.test(line)) {
            violations.push({ file: rel, line: i + 1, rule: rule.name, text: line.trim().slice(0, 110) })
          }
        }
      })
    }
    expect(
      violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`),
      `发现 ${violations.length} 处格式化器复活（见列表）`,
    ).toEqual([])
  })

  it("lib/format.ts 是全站唯一 format* 导出点", () => {
    const exported: string[] = []
    for (const file of files) {
      const src = readFileSync(file, "utf8")
      for (const m of src.matchAll(/export\s+(?:function|const)\s+(format[A-Z]\w*|fmt[A-Z]\w*)/g)) {
        exported.push(`${file.slice(ROOT.length + 1)} → ${m[1]}`)
      }
    }
    expect(exported).toEqual([])
  })
})
