import { describe, it, expect, afterEach, afterAll } from "vitest"
import { validateSkill, parseFrontmatter } from "../manifest/validator"
import { writeFileSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function createSkillMd(dir: string, content: string) {
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8")
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "octopus-skill-test-"))
}

describe("parseFrontmatter", () => {
  it("parses YAML frontmatter", () => {
    const content =
      "---\nname: my-skill\ncategory: coding-assistant\n---\n## Steps\nDo things"
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter.name).toBe("my-skill")
    expect(frontmatter.category).toBe("coding-assistant")
    expect(body).toContain("## Steps")
  })

  it("returns empty frontmatter when no markers", () => {
    const { frontmatter, body } = parseFrontmatter("Just body content")
    expect(frontmatter).toEqual({})
    expect(body).toBe("Just body content")
  })

  it("returns empty frontmatter when end marker missing", () => {
    const { frontmatter, body } = parseFrontmatter("---\nname: test\nno end")
    expect(frontmatter).toEqual({})
    expect(body).toBe("---\nname: test\nno end")
  })

  it("handles YAML parse error gracefully", () => {
    const content = "---\n: invalid yaml [[\n---\n## Body"
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toEqual({})
    expect(body).toContain("## Body")
  })
})

describe("validateSkill", () => {
  let testDir: string

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it("returns 0/6 when SKILL.md not found", () => {
    const emptyDir = makeTmpDir()
    const result = validateSkill(emptyDir)
    expect(result.passed).toBe(false)
    expect(result.score).toBe("0/6")
    expect(result.issues[0]).toBe("SKILL.md not found")
    rmSync(emptyDir, { recursive: true, force: true })
  })

  it("passes valid core skill", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: octo-skill-creator
category: coding-assistant
description: Create skills
tags: [skill, creation]
---
## Steps
1. Analyze requirements
`
    )
    const result = validateSkill(testDir, "my-", true)
    expect(result.passed).toBe(true)
    expect(result.score).toBe("6/6")
  })

  it("passes valid org-prefixed skill", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-deploy-tool
category: devops
description: Deploy tool
tags: [deploy]
---
## Usage
Deploy steps here
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.passed).toBe(true)
    expect(result.score).toBe("6/6")
  })

  it("detects wrong prefix", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: wrong-name
category: coding-assistant
description: Test
tags: [test]
---
## Steps
Do stuff
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("missing 'my-' prefix"))).toBe(true)
  })

  it("detects core skill missing octo- prefix", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Steps
Do stuff
`
    )
    const result = validateSkill(testDir, "my-", true)
    expect(result.issues.some((i) => i.includes("must have 'octo-' prefix"))).toBe(true)
  })

  it("detects invalid category", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: invalid-cat
description: Test
tags: [test]
---
## Steps
Do stuff
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("not valid"))).toBe(true)
  })

  it("detects description too long", () => {
    testDir = makeTmpDir()
    const longDesc = "x".repeat(1025)
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: ${longDesc}
tags: [test]
---
## Steps
Do stuff
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("exceeds 1024"))).toBe(true)
  })

  it("detects invalid tags", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: []
---
## Steps
Do stuff
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("tags count invalid"))).toBe(true)
  })

  it("detects [REQUIRED] markers", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Steps
[REQUIRED] Fill this in
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("[REQUIRED]"))).toBe(true)
  })

  it("detects [OPTIONAL] markers", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Steps
[OPTIONAL] Extra info
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("[OPTIONAL]"))).toBe(true)
  })

  it("detects old ~/.octopus/env/ paths", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Steps
Reference ~/.octopus/env/ for env info
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("old ~/.octopus/"))).toBe(true)
  })

  it("detects old ~/.octopus/mcp.yaml paths", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Steps
Config at ~/.octopus/mcp.yaml
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("old ~/.octopus/"))).toBe(true)
  })

  it("accepts org-level ~/.octopus/{org}/ paths", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Steps
Reference ~/.octopus/xzf/env/ for env info
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("old ~/.octopus/"))).toBe(false)
  })

  it("detects project-level .octopus/ references", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Steps
See .octopus/config.json for settings
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(
      result.issues.some((i) => i.includes("self-contained"))
    ).toBe(true)
  })

  it("allows scripts/ and references/ local paths", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Steps
Run scripts/deploy.sh
See references/config-template.yaml
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.passed).toBe(true)
  })

  it("detects missing approval_required in prod profile", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Profiles
- prod-profile: auto-deploy
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("approval_required"))).toBe(true)
  })

  it("passes prod profile with approval_required=true", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Profiles
prod-profile with approval_required=true
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("approval_required"))).toBe(false)
  })

  it("detects insufficient sections", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
Just some text without headers
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(
      result.issues.some((i) => i.includes("insufficient sections"))
    ).toBe(true)
  })

  it("detects MCP reference without YAML path", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## MCP 参考
Some MCP info without yaml path
octopus-mcp-cli order-service query_order '{}' --org xzf
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(
      result.issues.some((i) => i.includes("no ~/.octopus/{org}/mcp/*.yaml"))
    ).toBe(true)
  })

  it("detects MCP reference with invalid YAML path", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## MCP 参考
注册表: ~/.octopus/mcp.yaml
octopus-mcp-cli order-service query_order '{}' --org xzf
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.issues.some((i) => i.includes("invalid path format"))).toBe(true)
  })

  it("detects MCP reference without --org parameter", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## MCP 参考
注册表: ~/.octopus/xzf/mcp/mcp_prod.yaml
octopus-mcp-cli order-service query_order '{}'
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(
      result.issues.some((i) => i.includes("missing --org"))
    ).toBe(true)
  })

  it("detects MCP reference without octopus-mcp-cli call", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## MCP 参考
注册表: ~/.octopus/xzf/mcp/mcp_prod.yaml
No call example here
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(
      result.issues.some((i) => i.includes("no octopus-mcp-cli"))
    ).toBe(true)
  })

  it("passes valid MCP reference section", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## MCP 参考
注册表: ~/.octopus/xzf/mcp/mcp_prod.yaml
调用: octopus-mcp-cli order-service query_order '{"order_id": "12345"}' --org xzf
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.passed).toBe(true)
  })

  it("skips MCP validation when no MCP section", () => {
    testDir = makeTmpDir()
    createSkillMd(
      testDir,
      `---
name: my-skill
category: coding-assistant
description: Test
tags: [test]
---
## Steps
No MCP here
`
    )
    const result = validateSkill(testDir, "my-", false)
    expect(result.details[5]).toContain("not present (OK")
  })
})