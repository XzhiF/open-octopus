import path from "path"
import { randomUUID } from "crypto"
import { LLM_CALL_SOURCE } from "@octopus/shared"
import { captureAuxCall, collectResultUsage, type ResultUsageSink } from "../agent/aux-usage-capture"
import type { StepEmitter } from "./step-emitter"
import { getProvider } from "@octopus/providers"
import {
  getKnowledgeDir,
  getProjectKnowledgeDir,
  getWorkflowKnowledgeDir,
  readKnowledgeFile,
  writeKnowledgeFile,
} from "../knowledge/file-ops"

interface ExperienceAction {
  id: string
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
    const mergeTrace = `merge:${org}:${randomUUID()}`
    let added = 0
    let updated = 0
    let deleted = 0

    for (const group of groups) {
      await emitter.log(`Loading ${group.filePath}...`)

      const currentContent = readKnowledgeFile(group.filePath)
      const mergePrompt = this.buildMergePrompt(group, currentContent)
      const mergedContent = await this.callMergeAgent(mergePrompt, org, mergeTrace, group.filePath)

      if (mergedContent) {
        writeKnowledgeFile(group.filePath, mergedContent)
        await emitter.log(`✓ ${path.basename(group.filePath)} updated`)
      } else {
        await emitter.log(`✗ ${path.basename(group.filePath)} merge failed, skipping`)
        continue
      }

      for (const exp of group.experiences) {
        if (exp.action === "add") added++
        else if (exp.action === "update") updated++
        else if (exp.action === "delete") deleted++
      }
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
        filePath = path.join(getKnowledgeDir(org), "index.md")
      }

      if (!map.has(key)) {
        map.set(key, { scope, target, filePath, experiences: [] })
      }
      map.get(key)!.experiences.push(exp)
    }

    return Array.from(map.values())
  }

  private buildMergePrompt(group: MergeGroup, currentContent: string): string {
    const changes = group.experiences
      .map((exp, i) => {
        const actionLabel = exp.action.toUpperCase()
        const replaces = exp.replaces_text
          ? `\n   Replaces: "${exp.replaces_text}"`
          : ""
        return `${i + 1}. [${actionLabel}] "${exp.text}"${replaces}`
      })
      .join("\n\n")

    return `You are a knowledge management agent. Merge the following experience changes into the existing knowledge document.

FILE: ${group.scope}/${group.target}.md
CURRENT CONTENT:
---
${currentContent || "(empty file)"}
---

CHANGES TO APPLY:
${changes}

OUTPUT: Return the complete updated file content. Preserve the document structure and formatting. Only apply the specified changes. For ADD operations, append new entries as bullet points. For UPDATE operations, find and replace the matching text. For DELETE operations, remove the matching entry entirely.`
  }

  private async callMergeAgent(prompt: string, org: string, traceId: string, spanId: string): Promise<string | null> {
    try {
      const provider = getProvider("claude")
      const chunks: string[] = []
      const callStart = Date.now()
      const usageSink: ResultUsageSink = {}
      const stream = provider.sendQuery(prompt, process.cwd(), undefined, {
        systemPrompt:
          "You are a precise document merge agent. Return only the complete file content, no explanations.",
      })
      for await (const chunk of stream) {
        if (chunk.type === "text_delta") chunks.push(chunk.content)
        else if (chunk.type === "result") collectResultUsage(chunk, usageSink)
      }
      // 票04: 经验合并（记忆提炼）→ aux_memory；org 归因（无 workspace 宿主）
      const { getDb } = await import("../../db")
      captureAuxCall(getDb(), {
        source: LLM_CALL_SOURCE.aux_memory,
        // KD6：trace_id 保持运行根（mergeTrace），每次调用用 spanId 判别 —— 之前拼
        // `:${randomUUID()}` 进 trace 把运行→调用链拆断了。
        traceId,
        spanId,
        usage: usageSink.usage ?? null,
        modelUsages: usageSink.modelUsages ?? null,
        costUsd: usageSink.costUsd ?? null,
        org,
        timestamp: callStart,
        durationMs: Date.now() - callStart,
      })
      const raw = chunks.join("").trim()
      return raw.replace(/^```(?:markdown|md)?\n?/, "").replace(/\n?```$/, "").trim() || null
    } catch {
      return null
    }
  }
}
