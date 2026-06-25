#!/usr/bin/env node
/**
 * export-swarm-schema.js — Export SwarmNodeDef schema to JSON Schema
 *
 * Usage: node scripts/export-swarm-schema.js [output-path]
 * Default output: ./swarm-schema.json
 *
 * TC-P1-001: IDE Schema 补全 — swarm 节点字段自动补全
 */
import { writeFileSync } from "fs"
import { resolve } from "path"

const outputPath = process.argv[2] || "swarm-schema.json"

// ponytail: manual JSON Schema since zod-to-json-schema isn't installed
// and Zod 3.x doesn't have built-in toJSONSchema
const expertDefSchema = {
  type: "object",
  required: ["role"],
  properties: {
    role: { type: "string", description: "角色名称" },
    agent_file: { type: "string", description: ".md 文件路径" },
    prompt: { type: "string", description: "专家 prompt" },
    perspective: { type: "string", description: "专家视角" },
    task: { type: "string", description: "专家任务" },
    depends_on: { type: "array", items: { type: "string" }, description: "依赖的上游角色" },
    tools: { type: "array", items: { type: "string" }, description: "允许的工具" },
    disallowed_tools: { type: "array", items: { type: "string" }, description: "禁止的工具" },
    model: { type: "string", description: "模型 (sonnet/opus/haiku)" },
  },
  anyOf: [
    { required: ["agent_file"] },
    { required: ["prompt"] },
  ],
}

const swarmNodeDefSchema = {
  type: "object",
  required: ["type", "topic", "mode"],
  properties: {
    type: { const: "swarm", description: "节点类型" },
    topic: { type: "string", description: "讨论主题" },
    mode: { enum: ["review", "debate", "dispatch", "swarm"], description: "执行模式" },
    experts: { type: "array", items: expertDefSchema, description: "专家列表" },
    dynamic: { type: "boolean", description: "是否启用动态路由 (Router 自动选专家)" },
    max_experts: { type: "integer", minimum: 1, description: "最大专家数 (dynamic 模式截断)" },
    rounds: { type: "integer", minimum: 1, description: "讨论轮次 (debate 模式)" },
    consensus_threshold: { type: "number", minimum: 0, maximum: 1, description: "共识阈值 (debate 提前终止)" },
    budget: { type: "integer", minimum: 1, description: "Token 预算上限" },
    timeout: { type: "integer", minimum: 1, description: "超时秒数" },
    host: { type: "string", description: "Host 模型" },
    host_retries: { type: "integer", minimum: 0, description: "Host LLM 重试次数" },
    failure_policy: { enum: ["fail_fast", "continue_partial", "retry_failed"], description: "失败策略" },
    output_format: { enum: ["summary", "full", "structured"], description: "输出格式" },
    outputs: { type: "object", additionalProperties: { type: "string" }, description: "输出映射" },
    expert_defaults: {
      type: "object",
      properties: {
        model: { type: "string" },
        tools: { type: "array", items: { type: "string" } },
        disallowed_tools: { type: "array", items: { type: "string" } },
      },
      description: "所有专家的默认配置",
    },
  },
}

const output = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Octopus Swarm Node Schema",
  description: "JSON Schema for swarm-type workflow node configuration",
  definitions: {
    SwarmNodeDef: swarmNodeDefSchema,
    ExpertDef: expertDefSchema,
  },
  if: {
    properties: { type: { const: "swarm" } },
    required: ["type"],
  },
  then: swarmNodeDefSchema,
}

const resolved = resolve(outputPath)
writeFileSync(resolved, JSON.stringify(output, null, 2), "utf-8")
console.log(`Schema exported to ${resolved}`)
console.log(`- SwarmNodeDef: ${Object.keys(swarmNodeDefSchema.properties).length} properties`)
console.log(`- ExpertDef: ${Object.keys(expertDefSchema.properties).length} properties`)
