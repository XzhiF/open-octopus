// packages/server/src/services/knowledge/generate.ts

export interface GenerateResult {
  content: string
  suggestedPath: string
}

/**
 * Generate initial knowledge content for a project or workflow.
 * Returns a template with placeholder rules for the user to edit.
 */
export function generateInitialKnowledge(
  _org: string,
  type: "project" | "workflow",
  name: string,
): GenerateResult {
  const suggestedPath = `${type === "project" ? "projects" : "workflows"}/${name}.md`
  return { content: buildTemplate(type, name), suggestedPath }
}

function buildTemplate(type: "project" | "workflow", name: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const typeLabel = type === "project" ? "项目" : "工作流"

  if (type === "project") {
    return `# ${typeLabel}经验: ${name}

## 构建规则
- 在此添加构建相关的经验
<!-- id:${name}-001 | ${date} | manual -->

## 测试
- 在此添加测试相关的经验
<!-- id:${name}-002 | ${date} | manual -->

## 已知陷阱
- 在此添加常见陷阱
<!-- id:${name}-003 | ${date} | manual -->
`
  }

  return `# ${typeLabel}经验: ${name}

## 执行要点
- 在此添加执行相关的经验
<!-- id:${name}-001 | ${date} | manual -->

## 常见问题
- 在此添加常见问题
<!-- id:${name}-002 | ${date} | manual -->
`
}
