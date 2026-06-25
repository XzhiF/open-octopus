import { AutoAnswer } from "../types/workflow"

export function compileAutoAnswers(
  globalAnswers: AutoAnswer[],
  nodeAnswers: AutoAnswer[],
): string {
  const allAnswers = [...globalAnswers, ...nodeAnswers]
  if (allAnswers.length === 0) return ""

  const lines = [
    "## 自动应答规则（无人值守模式）",
    "",
    "你正在无人值守的工作流中执行。当技能向你提问时，按以下规则自动选择：",
    "",
  ]

  allAnswers.forEach((answer, i) => {
    if (answer.pattern === "*") {
      lines.push(`${i + 1}. 任何其他问题 → 选择 "${answer.answer}"（优先选择标注了"推荐"的选项）`)
    } else {
      lines.push(`${i + 1}. 匹配 "${answer.pattern}" → 选择 "${answer.answer}"`)
    }
  })

  lines.push("", "不要停下来等待用户回复。直接根据上述规则做出选择并继续执行。")

  return lines.join("\n")
}