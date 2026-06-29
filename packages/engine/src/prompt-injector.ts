// packages/engine/src/prompt-injector.ts
import type { PromptsConfig } from "@octopus/shared"

export class PromptInjector {
  private readonly MAX_LENGTH = 5000

  constructor(private config: PromptsConfig | undefined) {}

  /**
   * 获取注入的 prompt 列表
   * 优先级: global → targeted (精确匹配) → targeted (通配符)
   * 总长度限制: 5000 字符
   */
  getInjectedPrompts(workflowName: string, nodeId: string): string[] {
    if (!this.config) {
      return []
    }

    const prompts: string[] = []

    // 1. 添加 global prompts
    prompts.push(...(this.config.global || []))

    // 2. 添加 targeted prompts（精确匹配优先）
    const exactMatches = (this.config.targeted || []).filter(
      t => this.matchWorkflow(t.workflow, workflowName) &&
           this.matchNode(t.node, nodeId) &&
           t.node !== "*"
    )
    prompts.push(...exactMatches.map(t => t.prompt))

    // 3. 添加 targeted prompts（通配符匹配）
    const wildcardMatches = (this.config.targeted || []).filter(
      t => this.matchWorkflow(t.workflow, workflowName) && t.node === "*"
    )
    prompts.push(...wildcardMatches.map(t => t.prompt))

    // 4. 检查总长度，截断
    const totalLength = prompts.reduce((sum, p) => sum + p.length, 0)
    if (totalLength > this.MAX_LENGTH) {
      console.warn(`Injected prompts exceed ${this.MAX_LENGTH} chars (${totalLength}), truncating`)
      return this.truncatePrompts(prompts, this.MAX_LENGTH)
    }

    return prompts
  }

  private matchWorkflow(pattern: string, name: string): boolean {
    return pattern === name || pattern === "*"
  }

  private matchNode(pattern: string, nodeId: string): boolean {
    return pattern === nodeId || pattern === "*"
  }

  private truncatePrompts(prompts: string[], maxLength: number): string[] {
    const result: string[] = []
    let currentLength = 0
    for (const prompt of prompts) {
      if (currentLength + prompt.length > maxLength) {
        break
      }
      result.push(prompt)
      currentLength += prompt.length
    }
    return result
  }
}
