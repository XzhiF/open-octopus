// packages/engine/src/prompt-injector.ts
import type { PromptsConfig } from "@octopus/shared"

export class PromptInjector {
  private readonly MAX_LENGTH = 5000
  private experienceContext: string = ''

  constructor(private config: PromptsConfig | undefined) {}

  /**
   * Set experience context to be appended after all other injected prompts.
   * Called by ExperienceInjector with formatted experience context.
   */
  setExperienceContext(context: string): void {
    this.experienceContext = context
  }

  /**
   * 获取注入的 prompt 列表
   * 优先级: global → targeted (精确匹配) → targeted (通配符) → experience
   * 总长度限制: 5000 字符
   */
  getInjectedPrompts(workflowName: string, nodeId: string): string[] {
    if (!this.config && !this.experienceContext) {
      return []
    }

    const prompts: string[] = []

    if (this.config) {
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
    }

    // 4. 检查总长度，截断
    const totalLength = prompts.reduce((sum, p) => sum + p.length, 0)
    if (totalLength > this.MAX_LENGTH) {
      console.warn(`Injected prompts exceed ${this.MAX_LENGTH} chars (${totalLength}), truncating`)
      return this.truncatePrompts(prompts, this.MAX_LENGTH)
    }

    // 5. Append experience context at the end (after truncation check)
    if (this.experienceContext) {
      const newTotal = totalLength + this.experienceContext.length
      if (newTotal > this.MAX_LENGTH) {
        // Truncate experience context to fit within budget
        const available = this.MAX_LENGTH - totalLength
        if (available > 100) {
          prompts.push(this.experienceContext.slice(0, available) + '\n...(truncated)')
        }
      } else {
        prompts.push(this.experienceContext)
      }
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
