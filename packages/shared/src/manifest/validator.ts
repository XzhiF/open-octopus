import { existsSync, readFileSync } from "fs"
import { join } from "path"
import yaml from "js-yaml"

const VALID_CATEGORIES = [
  "troubleshooting",
  "knowledge",
  "coding-assistant",
  "devops",
  "business",
  "other",
] as const

export interface ValidationResult {
  passed: boolean
  score: string
  issues: string[]
  details: string[]
}

export function validateSkill(
  skillDir: string,
  orgPrefix: string = "",
  isCore: boolean = false
): ValidationResult {
  const issues: string[] = []
  const details: string[] = []
  const skillMdPath = join(skillDir, "SKILL.md")

  if (!existsSync(skillMdPath)) {
    return { passed: false, score: "0/6", issues: ["SKILL.md not found"], details: [] }
  }

  const content = readFileSync(skillMdPath, "utf-8")
  const { frontmatter, body } = parseFrontmatter(content)

  const name = (frontmatter.name ?? "") as string
  if (isCore) {
    if (!name.startsWith("octo-"))
      issues.push(`core Skill name '${name}' must have 'octo-' prefix`)
  } else if (orgPrefix) {
    if (!name.startsWith(orgPrefix))
      issues.push(`name '${name}' missing '${orgPrefix}' prefix`)
  } else {
    if (!name.includes("-"))
      issues.push(`name '${name}' should have a prefix`)
  }

  const category = (frontmatter.category ?? "") as string
  if (!VALID_CATEGORIES.includes(category as any)) {
    issues.push(
      `category '${category}' not valid (valid: ${VALID_CATEGORIES.join(", ")})`
    )
  }

  const description = (frontmatter.description ?? "") as string
  if (description.length > 1024) {
    issues.push(`description exceeds 1024 chars (${description.length})`)
  }

  const tags = frontmatter.tags ?? []
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 10) {
    issues.push(`tags count invalid (${Array.isArray(tags) ? tags.length : "not list"})`)
  }

  details.push(
    `1. YAML frontmatter — name=${name}, category=${category}, tags=${Array.isArray(tags) ? tags.length : "invalid"}`
  )

  const hasMarkers = body.includes("[REQUIRED]") || body.includes("[OPTIONAL]")
  if (hasMarkers) issues.push("leftover [REQUIRED]/[OPTIONAL] markers found")
  details.push(`2. Structural completeness — ${hasMarkers ? "has markers" : "no markers"}`)

  const hasProd = body
    .split("\n")
    .some((line) => line.includes("prod-"))
  const hasApproval = body.includes("approval_required=true")
  if (hasProd && !hasApproval) {
    issues.push("prod profile missing approval_required=true")
  }
  details.push(
    `3. Production safety — ${hasApproval || !hasProd ? "OK" : "missing approval_required"}`
  )

  const sections = body
    .split("\n")
    .filter((line) => line.startsWith("## ") && line !== "## Overview")
  if (sections.length < 1)
    issues.push(
      `insufficient sections (${sections.length} found, need at least 1)`
    )
  details.push(`4. Content coverage — ${sections.length} sections`)

  const oldPathRefs = body.split("\n").filter(
    (line) =>
      (line.includes("~/.octopus/env/") &&
        !/~\/.octopus\/\w+\/env\//.test(line)) ||
      line.includes("~/.octopus/mcp.yaml") ||
      line.includes("~/.octopus/mcp_uat01.yaml") ||
      line.includes("~/.octopus/mcp_local.yaml")
  )
  const projectOctopusRefs = body.split("\n").filter(
    (line) =>
      line.includes(".octopus/") && !line.includes("~/.octopus/")
  )
  if (projectOctopusRefs.length > 0) {
    issues.push(
      "SKILL.md references .octopus/ — target Skill must be self-contained"
    )
  }
  if (oldPathRefs.length > 0) {
    issues.push(
      "SKILL.md references old ~/.octopus/ paths — must use ~/.octopus/{org}/ paths"
    )
  }
  details.push(
    `5. Self-contained — ${oldPathRefs.length > 0 || projectOctopusRefs.length > 0 ? "issues found" : "OK"}`
  )

  const mcpRefSection = body.split("\n").filter(
    (line) =>
      line.trim().startsWith("## MCP") || line.trim() === "## MCP 参考"
  )
  if (mcpRefSection.length > 0) {
    const yamlRefs = body.split("\n").filter(
      (line) =>
        line.includes("~/.octopus/") &&
        line.includes("mcp") &&
        line.includes(".yaml")
    )
    if (yamlRefs.length === 0) {
      issues.push(
        "## MCP reference section present but no ~/.octopus/{org}/mcp/*.yaml path reference found"
      )
    } else {
      const validMcpPaths = yamlRefs.filter((line) =>
        /~\/.octopus\/\w+\/mcp\/mcp_\w+\.yaml/.test(line)
      )
      const invalidMcpPaths = yamlRefs.filter(
        (line) => !validMcpPaths.includes(line)
      )
      if (invalidMcpPaths.length > 0) {
        issues.push(
          `MCP reference has invalid path format: ${invalidMcpPaths[0].trim()}`
        )
      }
    }

    const hasOrgInCall = body
      .split("\n")
      .some((line) => line.includes("--org"))
    const hasCallExample = body
      .split("\n")
      .some((line) => line.includes("octopus-mcp-cli"))
    if (hasCallExample && !hasOrgInCall) {
      issues.push("MCP reference octopus-mcp-cli call missing --org parameter")
    } else if (!hasCallExample) {
      issues.push(
        "## MCP reference section present but no octopus-mcp-cli call example found"
      )
    }
    details.push(
      `6. MCP reference — ${issues.some((i) => i.includes("MCP")) ? "issues found" : "valid"}`
    )
  } else {
    details.push("6. MCP reference — not present (OK for non-MCP Skills)")
  }

  const score = 6 - issues.length
  const passed = issues.length === 0
  return { passed, score: `${score}/6`, issues, details }
}

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>
  body: string
} {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content }
  const endMarker = content.indexOf("---", 3)
  if (endMarker === -1) return { frontmatter: {}, body: content }
  const frontmatterStr = content.slice(3, endMarker).trim()
  const body = content.slice(endMarker + 3).trim()
  try {
    return {
      frontmatter:
        (yaml.load(frontmatterStr, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>) ?? {},
      body,
    }
  } catch {
    return { frontmatter: {}, body }
  }
}