import path from "path"
import type { StepEmitter } from "./step-emitter"
import {
  appendToKnowledgeFile,
  generateRuleId,
  getKnowledgeDir,
  getProjectKnowledgeDir,
  getWorkflowKnowledgeDir,
  markRuleRetired,
  parseKnowledgeFile,
} from "../knowledge/file-ops"

export interface ExperienceAction {
  id?: string
  text: string
  action: "add" | "update" | "delete"
  scope?: string
  target?: string
  replaces_text?: string
  confidence: number
  category: string
}

interface MergeGroup {
  scope: string
  target: string
  filePath: string
  experiences: ExperienceAction[]
}

const SOURCE = "archive"

/**
 * 经验合并器 —— append-only（B 止血）。
 *
 * 旧实现：把整个知识文件交给 LLM 重写并全量覆盖。两个致命点：
 *   1. 读侧 parseKnowledgeFile 只认 `<!-- id:... -->` 注释行，LLM 重写时丢掉
 *      注释 → 全部经验对注入器蒸发；
 *   2. LLM 返回空时只 log 后 continue —— 条目已被消费却不落盘 = 静默丢失。
 *
 * 新实现不依赖 LLM：add = appendToKnowledgeFile（保留调用方 id，缺则生成）；
 * update/delete = markRuleRetired 退休旧条目（update 再追加新条目），历史永不被
 * 整文件覆写。任何写盘失败直接抛出，由调用方（archiveWorkspace Step 4）决定
 * 中止归档 —— 不再吞。
 *
 * org 级经验落 `<knowledge>/experiences/org.md`：
 *   - 不能写根 index.md —— rebuildIndex() 每次全量重写该文件，归档经验必被销毁；
 *   - listAllRules/rebuildIndex 已扩展扫描 experiences/，scope 报 "global"
 *     （engine 注入器只认 global/project/workflow，org 语义 = 该 org 的全局）。
 */
export class ExperienceMerger {
  async merge(
    org: string,
    selectedExperiences: ExperienceAction[],
    emitter: StepEmitter,
  ): Promise<{ added: number; updated: number; deleted: number }> {
    if (selectedExperiences.length === 0) {
      return { added: 0, updated: 0, deleted: 0 }
    }

    const groups = this.groupByTarget(selectedExperiences, org)
    let added = 0
    let updated = 0
    let deleted = 0

    for (const group of groups) {
      await emitter.log(`Appending ${group.experiences.length} entries → ${path.basename(group.filePath)} (append-only)...`)

      for (const exp of group.experiences) {
        switch (exp.action) {
          case "add":
            this.appendEntry(group.filePath, exp.id, exp.text)
            added++
            break
          case "update": {
            const exists = this.hasEntry(group.filePath, exp.id)
            if (exists) {
              // 退休旧条目（保留历史与 id 审计链），新文本以新 id 追加
              markRuleRetired(group.filePath, exp.id!.trim())
              this.appendEntry(group.filePath, undefined, exp.text)
              updated++
            } else {
              // 目标不在文件里 —— 不静默丢，按 add 落盘
              this.appendEntry(group.filePath, exp.id, exp.text)
              added++
            }
            break
          }
          case "delete":
            if (exp.id && this.hasEntry(group.filePath, exp.id)) {
              markRuleRetired(group.filePath, exp.id.trim())
            }
            // id 不在文件里 = 已不存在，delete 幂等成功
            deleted++
            break
        }
      }

      await emitter.log(`✓ ${path.basename(group.filePath)}: ${group.experiences.length} entries applied`)
    }

    return { added, updated, deleted }
  }

  private groupByTarget(experiences: ExperienceAction[], org: string): MergeGroup[] {
    const map = new Map<string, MergeGroup>()

    for (const exp of experiences) {
      const scope = exp.scope ?? "org"
      const target = exp.target ?? "all"
      const key = `${scope}:${target}`

      let filePath: string
      if (scope === "workflow") {
        filePath = path.join(getWorkflowKnowledgeDir(org), `${target}.md`)
      } else if (scope === "project") {
        filePath = path.join(getProjectKnowledgeDir(org), `${target}.md`)
      } else {
        // org 级：专用 experiences/ 目录（根 index.md 归 rebuildIndex 所有，不可写）
        filePath = path.join(getKnowledgeDir(org), "experiences", "org.md")
      }

      if (!map.has(key)) {
        map.set(key, { scope, target, filePath, experiences: [] })
      }
      map.get(key)!.experiences.push(exp)
    }

    return Array.from(map.values())
  }

  private hasEntry(filePath: string, id?: string): boolean {
    if (!id || !id.trim()) return false
    return parseKnowledgeFile(filePath).some(r => r.id === id.trim())
  }

  /** append 一条带 id 注释的经验；id 非法/缺失则生成，读侧永远能解析。 */
  private appendEntry(filePath: string, id: string | undefined, text: string): void {
    const finalId = this.sanitizeId(id) ?? generateRuleId(path.basename(filePath, ".md"))
    appendToKnowledgeFile(filePath, text, finalId, SOURCE)
  }

  /** id 会进 `<!-- id:{id} | ... -->`，注释体不允许空白与竖线（metaRegex 是 \S+）。 */
  private sanitizeId(raw: string | undefined): string | null {
    if (!raw) return null
    const cleaned = raw.trim().replace(/[\s|>]/g, "-").replace(/<!--/g, "").trim()
    return cleaned || null
  }
}
