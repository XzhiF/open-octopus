import { describe, it, expect, vi } from "vitest"
import {
  parseManifest,
  writeManifest,
  findManifestEntry,
  findManifestGroup,
  type ManifestEntry,
} from "../repo-ops/manifest"
import {
  parseIndex,
  generateIndex,
  parseIndexLocalPaths,
  parseIndexBranches,
  type IndexEntry,
  type ProjectInfo,
  type KnowledgeInfoForIndex,
} from "../repo-ops/index-file"
import { inferAutoTags, AUTO_TAG_MAP } from "../repo-ops/tags"
import {
  detectKnowledge,
  createKnowledgeInfo,
  extractRepowikiDesc,
  extractAgentMdDesc,
  extractDescFromMdContent,
} from "../repo-ops/knowledge"
import { resolveReposConfig, type ReposConfig } from "../repo-ops/repos-config"
import { cloneProject, pullProject, isDirtyWorkingTree, getCurrentBranch, type GitResult } from "../repo-ops/git"
import { findLocalRepo, scanExternalDirs, cloneMissingProjects } from "../repo-ops/scan"
import { buildProjectInfos, applyAiDesc, type ProjectInfoFull } from "../repo-ops/project-info"
import { writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "octopus-repo-ops-test-"))
}

// ---------------------------------------------------------------------------
// Manifest tests
// ---------------------------------------------------------------------------

describe("parseManifest", () => {
  it("parses simple manifest with groups and entries", () => {
    const content = `## xzf
- project-a [master] {java/spring}
- project-b [develop] {前端/react}
`
    const result = parseManifest(content)
    expect(result["xzf"].length).toBe(2)
    expect(result["xzf"][0].name).toBe("project-a")
    expect(result["xzf"][0].branch).toBe("master")
    expect(result["xzf"][0].manual_tags).toContain("java")
    expect(result["xzf"][0].manual_tags).toContain("spring")
    expect(result["xzf"][1].name).toBe("project-b")
    expect(result["xzf"][1].branch).toBe("develop")
    expect(result["xzf"][1].manual_tags).toContain("前端")
  })

  it("parses group header with label", () => {
    const content = `## xzf (旧架构)
- project-a [master]
`
    const result = parseManifest(content)
    expect(result["xzf"].length).toBe(1)
    expect(result["xzf"][0].name).toBe("project-a")
  })

  it("parses git URL from entry", () => {
    const content = `## xzf
- project-a [master] https://git.example.com/group/project-a.git
`
    const result = parseManifest(content)
    expect(result["xzf"][0].git_url).toBe(
      "https://git.example.com/group/project-a.git"
    )
    expect(result["xzf"][0].name).toBe("project-a")
  })

  it("parses SSH git URL from entry", () => {
    const content = `## github
- octopus [main] git@github.com:XzhiF/octopus.git
`
    const result = parseManifest(content)
    expect(result["github"][0].git_url).toBe(
      "git@github.com:XzhiF/octopus.git"
    )
    expect(result["github"][0].name).toBe("octopus")
  })

  it("parses entry without branch or tags", () => {
    const content = `## xzf
- project-a
`
    const result = parseManifest(content)
    expect(result["xzf"][0].name).toBe("project-a")
    expect(result["xzf"][0].branch).toBe("master")
    expect(result["xzf"][0].manual_tags).toEqual([])
    expect(result["xzf"][0].git_url).toBe("")
  })

  it("parses comma-separated tags", () => {
    const content = `## xzf
- project-a [master] {java,spring,boot}
`
    const result = parseManifest(content)
    expect(result["xzf"][0].manual_tags).toEqual(["java", "spring", "boot"])
  })

  it("handles empty manifest", () => {
    const result = parseManifest("")
    expect(Object.keys(result).length).toBe(0)
  })

  it("skips comments and blank lines", () => {
    const content = `> This is a comment
# Some header

## xzf
- project-a [master]
`
    const result = parseManifest(content)
    expect(result["xzf"].length).toBe(1)
  })

  it("handles multiple groups", () => {
    const content = `## xzf
- project-a [master]

## xzf3.0
- project-b [develop]
`
    const result = parseManifest(content)
    expect(Object.keys(result).length).toBe(2)
    expect(result["xzf"].length).toBe(1)
    expect(result["xzf3.0"].length).toBe(1)
  })
})

describe("writeManifest", () => {
  it("writes manifest entries back to string", () => {
    const entries: Record<string, ManifestEntry[]> = {
      xzf: [
        {
          name: "project-a",
          git_url: "https://git.example.com/a.git",
          branch: "master",
          manual_tags: ["java", "spring"],
          group: "xzf",
        },
      ],
    }
    const result = writeManifest(entries, { xzf: "旧架构" })
    expect(result).toContain("## xzf (旧架构)")
    expect(result).toContain("- project-a [master] {java/spring}")
    expect(result).toContain("https://git.example.com/a.git")
  })
})

describe("findManifestEntry", () => {
  it("finds entry by project name", () => {
    const manifest: Record<string, ManifestEntry[]> = {
      xzf: [
        { name: "project-a", git_url: "", branch: "master", manual_tags: [], group: "xzf" },
      ],
      xzf3: [
        { name: "project-b", git_url: "", branch: "develop", manual_tags: [], group: "xzf3" },
      ],
    }
    const result = findManifestEntry(manifest, "project-b")
    expect(result?.name).toBe("project-b")
    expect(result?.group).toBe("xzf3")
  })

  it("returns undefined for unknown project", () => {
    const manifest: Record<string, ManifestEntry[]> = {
      xzf: [
        { name: "project-a", git_url: "", branch: "master", manual_tags: [], group: "xzf" },
      ],
    }
    expect(findManifestEntry(manifest, "unknown")).toBeUndefined()
  })
})

describe("findManifestGroup", () => {
  it("finds group by project name", () => {
    const manifest: Record<string, ManifestEntry[]> = {
      xzf: [
        { name: "project-a", git_url: "", branch: "master", manual_tags: [], group: "xzf" },
      ],
    }
    expect(findManifestGroup(manifest, "project-a")).toBe("xzf")
  })

  it("returns undefined for unknown project", () => {
    const manifest: Record<string, ManifestEntry[]> = {}
    expect(findManifestGroup(manifest, "unknown")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tags tests
// ---------------------------------------------------------------------------

describe("inferAutoTags", () => {
  it("infers tags from project name containing keywords", () => {
    expect(inferAutoTags("order-service")).toContain("订单")
    expect(inferAutoTags("order-service")).toContain("order")
  })

  it("infers multiple keyword matches", () => {
    const tags = inferAutoTags("user-gateway-service")
    expect(tags).toContain("用户")
    expect(tags).toContain("网关")
  })

  it("returns empty array for unknown names", () => {
    expect(inferAutoTags("random-project")).toEqual([])
  })

  it("handles Chinese keywords", () => {
    expect(inferAutoTags("wechat-mini")).toContain("微信")
  })

  it("is case-insensitive", () => {
    expect(inferAutoTags("ORDER-SERVICE")).toContain("订单")
  })

  it("replaces hyphens with underscores for matching", () => {
    expect(inferAutoTags("risk-control")).toContain("风控")
  })
})

describe("AUTO_TAG_MAP", () => {
  it("contains expected keywords", () => {
    expect(AUTO_TAG_MAP).toHaveProperty("order")
    expect(AUTO_TAG_MAP).toHaveProperty("user")
    expect(AUTO_TAG_MAP).toHaveProperty("gateway")
    expect(AUTO_TAG_MAP).toHaveProperty("wechat")
  })

  it("has both Chinese and English tags", () => {
    expect(AUTO_TAG_MAP["order"]).toContain("订单")
    expect(AUTO_TAG_MAP["order"]).toContain("order")
  })
})

// ---------------------------------------------------------------------------
// Index tests
// ---------------------------------------------------------------------------

describe("parseIndex", () => {
  it("parses index entries from generated format", () => {
    const content = `# GitRepo Index

> Auto-generated from manifest + local scan.

## xzf (旧架构)

### project-a
- git: https://git.example.com/a.git
- branch: master
- keywords: [java, spring] ← tags:manual
- desc: 订单处理微服务 (from repowiki)
- local: /path/to/a ✓ cloned
- knowledge: repowiki:yes

### project-b
- git: https://git.example.com/b.git
- branch: develop
- desc: —
- local: — not cloned
- knowledge: index-only

---
*Generated by octopus repos — 2 projects from 1 groups*
`
    const result = parseIndex(content)
    expect(result.length).toBe(2)
    expect(result[0].name).toBe("project-a")
    expect(result[0].git_url).toBe("https://git.example.com/a.git")
    expect(result[0].branch).toBe("master")
    expect(result[0].tags).toEqual(["java", "spring"])
    expect(result[0].tag_source).toBe("manual")
    expect(result[0].description).toBe("订单处理微服务")
    expect(result[0].desc_source).toBe("repowiki")
    expect(result[0].local_path).toBe("/path/to/a")
    expect(result[1].name).toBe("project-b")
    expect(result[1].local_path).toBeNull()
  })

  it("parses desc without source attribution", () => {
    const content = `### project-x
- git: https://git.example.com/x.git
- branch: master
- desc: Some description
- local: — not cloned
- knowledge: index-only
`
    const result = parseIndex(content)
    expect(result[0].description).toBe("Some description")
  })

  it("handles empty content", () => {
    expect(parseIndex("").length).toBe(0)
  })
})

describe("parseIndexLocalPaths", () => {
  it("extracts local paths for cloned projects", () => {
    const content = `### project-a
- git: https://git.example.com/a.git
- local: /path/to/a ✓ cloned

### project-b
- git: https://git.example.com/b.git
- local: — not cloned
`
    const result = parseIndexLocalPaths(content)
    expect(result["project-a"]).toBe("/path/to/a")
    expect(result["project-b"]).toBeUndefined()
  })
})

describe("parseIndexBranches", () => {
  it("extracts branch info", () => {
    const content = `### project-a
- git: https://git.example.com/a.git
- branch: master

### project-b
- git: https://git.example.com/b.git
- branch: develop
`
    const result = parseIndexBranches(content)
    expect(result["project-a"]).toBe("master")
    expect(result["project-b"]).toBe("develop")
  })
})

describe("generateIndex", () => {
  it("generates index from ProjectInfo", () => {
    function makeKnowledge(
      isCloned: boolean,
      wikiExists: boolean,
      wikiStale: boolean
    ): KnowledgeInfoForIndex {
      return {
        is_cloned: isCloned,
        repowiki_exists: wikiExists,
        repowiki_stale: wikiStale,
        formatLine() {
          if (!this.is_cloned) return "index-only"
          if (this.repowiki_exists && this.repowiki_stale) return "repowiki:yes(stale)"
          if (this.repowiki_exists) return "repowiki:yes"
          return "repowiki:no"
        },
      }
    }

    const infos: Record<string, ProjectInfo[]> = {
      xzf: [
        {
          name: "project-a",
          group: "xzf",
          branch: "master",
          git_url: "https://git.example.com/a.git",
          tags: ["java", "spring"],
          tag_source: "manual",
          description: "订单处理微服务",
          desc_source: "repowiki",
          local_path: "/path/to/a",
          knowledge: makeKnowledge(true, true, false),
        },
      ],
    }

    const result = generateIndex(infos)
    expect(result).toContain("## xzf (xzf)")
    expect(result).toContain("### project-a")
    expect(result).toContain("- git: https://git.example.com/a.git")
    expect(result).toContain("- keywords: [java, spring] ← tags:manual")
    expect(result).toContain("- desc: 订单处理微服务 (from repowiki)")
    expect(result).toContain("- local: /path/to/a ✓ cloned")
    expect(result).toContain("- knowledge: repowiki:yes")
    expect(result).toContain("1 projects from 1 groups")
  })

  it("handles no desc entries", () => {
    function makeKnowledge(
      isCloned: boolean,
      wikiExists: boolean,
      wikiStale: boolean
    ): KnowledgeInfoForIndex {
      return {
        is_cloned: isCloned,
        repowiki_exists: wikiExists,
        repowiki_stale: wikiStale,
        formatLine() {
          if (!this.is_cloned) return "index-only"
          if (this.repowiki_exists) return "repowiki:yes"
          return "repowiki:no"
        },
      }
    }

    const infos: Record<string, ProjectInfo[]> = {
      xzf: [
        {
          name: "project-b",
          group: "xzf",
          branch: "develop",
          git_url: "https://git.example.com/b.git",
          tags: [],
          tag_source: "auto",
          description: "",
          desc_source: "none",
          local_path: null,
          knowledge: makeKnowledge(false, false, false),
        },
      ],
    }

    const result = generateIndex(infos)
    expect(result).toContain("- desc: —")
    expect(result).toContain("- local: — not cloned")
    expect(result).toContain("- knowledge: index-only")
  })
})

// ---------------------------------------------------------------------------
// Knowledge tests
// ---------------------------------------------------------------------------

describe("createKnowledgeInfo", () => {
  it("creates default knowledge info", () => {
    const info = createKnowledgeInfo()
    expect(info.is_cloned).toBe(false)
    expect(info.repowiki_exists).toBe(false)
    expect(info.repowiki_stale).toBe(false)
    expect(info.formatLine()).toBe("index-only")
  })

  it("creates cloned info with repowiki", () => {
    const info = createKnowledgeInfo({ is_cloned: true, repowiki_exists: true })
    expect(info.formatLine()).toBe("repowiki:yes")
  })

  it("creates cloned info without repowiki", () => {
    const info = createKnowledgeInfo({ is_cloned: true, repowiki_exists: false })
    expect(info.formatLine()).toBe("repowiki:no")
  })

  it("creates cloned info with stale repowiki", () => {
    const info = createKnowledgeInfo({
      is_cloned: true,
      repowiki_exists: true,
      repowiki_stale: true,
    })
    expect(info.formatLine()).toBe("repowiki:yes(stale)")
  })
})

describe("detectKnowledge", () => {
  it("returns default for non-existent path", () => {
    const info = detectKnowledge("/nonexistent/path")
    expect(info.is_cloned).toBe(false)
    expect(info.repowiki_exists).toBe(false)
  })

  it("detects cloned directory without repowiki", () => {
    const tmpDir = makeTmpDir()
    const info = detectKnowledge(tmpDir)
    expect(info.is_cloned).toBe(true)
    expect(info.repowiki_exists).toBe(false)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("detects repowiki content", () => {
    const tmpDir = makeTmpDir()
    const wikiDir = join(tmpDir, ".qoder", "repowiki", "zh", "content")
    mkdirSync(wikiDir, { recursive: true })
    writeFileSync(join(wikiDir, "项目概述.md"), "# 项目概述\n## 简介\n这是一个测试项目描述内容。\n")

    const info = detectKnowledge(tmpDir)
    expect(info.is_cloned).toBe(true)
    expect(info.repowiki_exists).toBe(true)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe("extractRepowikiDesc", () => {
  it("extracts desc from repowiki overview", () => {
    const tmpDir = makeTmpDir()
    const wikiDir = join(tmpDir, ".qoder", "repowiki", "zh", "content")
    mkdirSync(wikiDir, { recursive: true })
    writeFileSync(
      join(wikiDir, "项目概述.md"),
      "# 项目概述\n## 简介\n这是一个订单处理微服务，负责核心业务逻辑。\n## 其他\n\n"
    )

    const desc = extractRepowikiDesc(tmpDir)
    expect(desc).toContain("订单处理微服务")
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns empty for non-existent repowiki", () => {
    const tmpDir = makeTmpDir()
    expect(extractRepowikiDesc(tmpDir)).toBe("")
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("skips short lines", () => {
    const tmpDir = makeTmpDir()
    const wikiDir = join(tmpDir, ".qoder", "repowiki", "zh", "content")
    mkdirSync(wikiDir, { recursive: true })
    writeFileSync(
      join(wikiDir, "项目概述.md"),
      "# 项目概述\n## 简介\n短文本\n足够长的描述内容在这里出现了。\n\n"
    )

    const desc = extractRepowikiDesc(tmpDir)
    expect(desc).toContain("足够长的描述内容")
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe("extractDescFromMdContent", () => {
  it("extracts desc from Chinese heading", () => {
    const content =
      "## 项目简介\n这是一个订单处理微服务，负责核心业务流程。\n\n## 其他\n更多内容"
    const desc = extractDescFromMdContent(content)
    expect(desc).toBe("这是一个订单处理微服务，负责核心业务流程。")
  })

  it("extracts desc from English heading", () => {
    const content =
      "## Project Overview\nThis is an order processing service for core business logic.\n\n## Other\nMore"
    const desc = extractDescFromMdContent(content)
    expect(desc).toContain("order processing service")
  })

  it("skips code blocks", () => {
    const content =
      "## 项目简介\n```python\nprint('hello')\n```\n这是真正的项目描述内容，足够长了。\n\n## Other"
    const desc = extractDescFromMdContent(content)
    expect(desc).toContain("真正的项目描述")
  })

  it("skips list items and tables", () => {
    const content =
      "## 项目简介\n- 这是列表项\n| 表头 | 内容 |\n这是正常的项目描述内容，长度足够。\n\n## Other"
    const desc = extractDescFromMdContent(content)
    expect(desc).toContain("正常的项目描述内容")
  })

  it("truncates long descriptions to 200 chars", () => {
    const longDesc = "A".repeat(250)
    const content = `## 项目简介\n${longDesc}\n\n## Other`
    const desc = extractDescFromMdContent(content)
    expect(desc.length).toBe(200)
  })

  it("returns empty when no matching heading", () => {
    const content = "## Deployment\nSome deployment info.\n\n## API\nAPI docs."
    expect(extractDescFromMdContent(content)).toBe("")
  })

  it("returns empty for short descriptions", () => {
    const content = "## 项目简介\n太短了\n\n## Other\nMore"
    expect(extractDescFromMdContent(content)).toBe("")
  })
})

describe("extractAgentMdDesc", () => {
  it("extracts from CLAUDE.md", () => {
    const tmpDir = makeTmpDir()
    writeFileSync(
      join(tmpDir, "CLAUDE.md"),
      "## 项目简介\n这是一个测试项目的核心描述内容，包含业务逻辑。\n\n## Other\nMore",
      "utf-8"
    )
    const desc = extractAgentMdDesc(tmpDir)
    expect(desc).toContain("测试项目的核心描述内容")
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("falls back to AGENT.md when CLAUDE.md missing", () => {
    const tmpDir = makeTmpDir()
    writeFileSync(
      join(tmpDir, "AGENT.md"),
      "## Project Overview\nThis is a project overview description with enough length.\n\n## Other",
      "utf-8"
    )
    const desc = extractAgentMdDesc(tmpDir)
    expect(desc).toContain("project overview description")
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns empty when both files missing", () => {
    const tmpDir = makeTmpDir()
    expect(extractAgentMdDesc(tmpDir)).toBe("")
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// ReposConfig tests
// ---------------------------------------------------------------------------

describe("resolveReposConfig", () => {
  it("resolves config from org config", () => {
    const tmpDir = makeTmpDir()
    const orgDir = join(tmpDir, "orgs", "testorg")
    mkdirSync(join(orgDir, "repos"), { recursive: true })
    writeFileSync(join(orgDir, "config.yaml"), `name: testorg\nprefix: test-\ngroups: xzf,xzf3.0\nclone_base: ${tmpDir}/projects\n`, "utf-8")

    const origHome = process.env.HOME
    const origUser = process.env.USERPROFILE
    const origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir

    const config = resolveReposConfig("testorg")
    expect(config.groups).toEqual(["xzf", "xzf3.0"])
    expect(config.cloneBase).toBe(`${tmpDir}/projects`)
    // Falls back to manifest.md when manifest.json doesn't exist
    expect(config.manifestPath).toBe(join(orgDir, "repos", "manifest.md"))
    // Default output is now index.json
    expect(config.outputPath).toBe(join(orgDir, "repos", "index.json"))

    process.env.OCTOPUS_HOME = origOctopus ?? ""
    if (origHome) process.env.HOME = origHome
    if (origUser) process.env.USERPROFILE = origUser

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("uses overrides when provided", () => {
    const tmpDir = makeTmpDir()
    const orgDir = join(tmpDir, "orgs", "overrideorg")
    mkdirSync(join(orgDir, "repos"), { recursive: true })
    writeFileSync(join(orgDir, "config.yaml"), `name: overrideorg\nprefix: ov-\ngroups: groupA\n`, "utf-8")

    const origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir

    const config = resolveReposConfig("overrideorg", {
      groupsOverride: "groupB,groupC",
      cloneBaseOverride: "/custom/clone",
      manifestOverride: "/custom/manifest.md",
      outputOverride: "/custom/index.md",
    })
    expect(config.groups).toEqual(["groupB", "groupC"])
    expect(config.cloneBase).toBe("/custom/clone")
    expect(config.manifestPath).toBe("/custom/manifest.md")
    expect(config.outputPath).toBe("/custom/index.md")

    process.env.OCTOPUS_HOME = origOctopus ?? ""
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("falls back to default clone_base when not in org config", () => {
    const tmpDir = makeTmpDir()
    const orgDir = join(tmpDir, "orgs", "defaultorg")
    mkdirSync(join(orgDir, "repos"), { recursive: true })
    writeFileSync(join(orgDir, "config.yaml"), `name: defaultorg\nprefix: df-\n`, "utf-8")

    const origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir

    const config = resolveReposConfig("defaultorg")
    expect(config.cloneBase).toBe(join(orgDir, "repos", "projects"))

    process.env.OCTOPUS_HOME = origOctopus ?? ""
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Git operations tests (mock child_process)
// ---------------------------------------------------------------------------

describe("isDirtyWorkingTree", () => {
  it("returns true on spawnSync error", () => {
    const result = isDirtyWorkingTree("/nonexistent/path")
    expect(result).toBe(true)
  })
})

describe("getCurrentBranch", () => {
  it("returns null on spawnSync error", () => {
    const result = getCurrentBranch("/nonexistent/path")
    expect(result).toBeNull()
  })
})

describe("cloneProject", () => {
  it("returns failure when destination exists", () => {
    const tmpDir = makeTmpDir()
    mkdirSync(join(tmpDir, "mygroup", "myproject"), { recursive: true })

    const result = cloneProject("https://example.com/repo.git", "mygroup", "myproject", "master", tmpDir)
    expect(result.success).toBe(false)
    expect(result.message).toContain("目标目录已存在")

    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe("pullProject", () => {
  it("returns failure when path does not exist", () => {
    const result = pullProject("/nonexistent/path", "master")
    expect(result.success).toBe(false)
    expect(result.message).toContain("目录不存在")
  })
})

// ---------------------------------------------------------------------------
// findLocalRepo tests
// ---------------------------------------------------------------------------

describe("findLocalRepo", () => {
  it("finds repo at cloneBase/group/name", () => {
    const tmpDir = makeTmpDir()
    const projectDir = join(tmpDir, "mygroup", "myproject")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(join(projectDir, ".git"), { recursive: true })

    const result = findLocalRepo("mygroup", "myproject", tmpDir)
    expect(result).toBe(projectDir)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("finds repo at cloneBase/name (flat)", () => {
    const tmpDir = makeTmpDir()
    const projectDir = join(tmpDir, "myproject")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(join(projectDir, ".git"), { recursive: true })

    const result = findLocalRepo("mygroup", "myproject", tmpDir)
    expect(result).toBe(projectDir)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns null when not found", () => {
    const tmpDir = makeTmpDir()
    const result = findLocalRepo("mygroup", "nonexistent", tmpDir)
    expect(result).toBeNull()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns null when directory exists but no .git", () => {
    const tmpDir = makeTmpDir()
    const projectDir = join(tmpDir, "mygroup", "myproject")
    mkdirSync(projectDir, { recursive: true })

    const result = findLocalRepo("mygroup", "myproject", tmpDir)
    expect(result).toBeNull()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// scanExternalDirs tests
// ---------------------------------------------------------------------------

describe("scanExternalDirs", () => {
  it("matches subdirs against manifest names", () => {
    const tmpDir = makeTmpDir()
    mkdirSync(join(tmpDir, "project-a"), { recursive: true })
    mkdirSync(join(tmpDir, "project-b"), { recursive: true })
    mkdirSync(join(tmpDir, "unmatched"), { recursive: true })

    const manifest: Record<string, ManifestEntry[]> = {
      xzf: [
        { name: "project-a", git_url: "", branch: "master", manual_tags: [], group: "xzf" },
        { name: "project-b", git_url: "", branch: "develop", manual_tags: [], group: "xzf" },
      ],
    }

    const result = scanExternalDirs([tmpDir], manifest)
    expect(result["project-a"]).toBe(join(tmpDir, "project-a"))
    expect(result["project-b"]).toBe(join(tmpDir, "project-b"))
    expect(result["unmatched"]).toBeUndefined()

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns empty for nonexistent directory", () => {
    const manifest: Record<string, ManifestEntry[]> = {
      xzf: [{ name: "project-a", git_url: "", branch: "master", manual_tags: [], group: "xzf" }],
    }
    const result = scanExternalDirs(["/nonexistent/dir"], manifest)
    expect(Object.keys(result).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// buildProjectInfos tests
// ---------------------------------------------------------------------------

describe("buildProjectInfos", () => {
  it("builds project infos from manifest", () => {
    const tmpDir = makeTmpDir()
    const projectDir = join(tmpDir, "xzf", "order-service")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(join(projectDir, ".git"), { recursive: true })

    const manifest: Record<string, ManifestEntry[]> = {
      xzf: [
        { name: "order-service", git_url: "https://git.example.com/order.git", branch: "master", manual_tags: ["java", "订单"], group: "xzf" },
      ],
    }

    const result = buildProjectInfos(manifest, tmpDir)
    expect(result["xzf"].length).toBe(1)
    const info = result["xzf"][0]
    expect(info.name).toBe("order-service")
    expect(info.group).toBe("xzf")
    expect(info.git_url).toBe("https://git.example.com/order.git")
    expect(info.branch).toBe("master")
    expect(info.tags).toEqual(["java", "订单"])
    expect(info.tag_source).toBe("manual")
    expect(info.local_path).toBe(projectDir)
    expect(info.desc_source).toBe("none")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("uses auto tags when no manual tags", () => {
    const tmpDir = makeTmpDir()
    const manifest: Record<string, ManifestEntry[]> = {
      xzf: [
        { name: "order-service", git_url: "", branch: "master", manual_tags: [], group: "xzf" },
      ],
    }

    const result = buildProjectInfos(manifest, tmpDir)
    expect(result["xzf"][0].tag_source).toBe("auto")
    expect(result["xzf"][0].tags).toContain("订单")
    expect(result["xzf"][0].tags).toContain("order")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("uses external paths when provided", () => {
    const tmpDir = makeTmpDir()
    const extDir = join(tmpDir, "ext-order")
    mkdirSync(extDir, { recursive: true })

    const manifest: Record<string, ManifestEntry[]> = {
      xzf: [
        { name: "order-service", git_url: "", branch: "master", manual_tags: [], group: "xzf" },
      ],
    }

    const externalPaths: Record<string, string> = {
      "order-service": extDir,
    }

    const result = buildProjectInfos(manifest, tmpDir, externalPaths)
    expect(result["xzf"][0].local_path).toBe(extDir)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("skips local scan when includeLocalScan is false", () => {
    const tmpDir = makeTmpDir()
    const manifest: Record<string, ManifestEntry[]> = {
      xzf: [
        { name: "order-service", git_url: "", branch: "master", manual_tags: [], group: "xzf" },
      ],
    }

    const result = buildProjectInfos(manifest, tmpDir, undefined, false)
    expect(result["xzf"][0].local_path).toBeNull()
    expect(result["xzf"][0].knowledge.is_cloned).toBe(false)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("extracts repowiki desc when available", () => {
    const tmpDir = makeTmpDir()
    const projectDir = join(tmpDir, "xzf", "project-x")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(join(projectDir, ".git"), { recursive: true })
    const wikiDir = join(projectDir, ".qoder", "repowiki", "zh", "content")
    mkdirSync(wikiDir, { recursive: true })
    writeFileSync(join(wikiDir, "项目概述.md"), "# 项目概述\n## 简介\n这是一个订单处理微服务系统。\n\n", "utf-8")

    const manifest: Record<string, ManifestEntry[]> = {
      xzf: [{ name: "project-x", git_url: "", branch: "master", manual_tags: [], group: "xzf" }],
    }

    const result = buildProjectInfos(manifest, tmpDir)
    expect(result["xzf"][0].desc_source).toBe("repowiki")
    expect(result["xzf"][0].description).toContain("订单处理微服务")

    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// applyAiDesc tests (stub)
// ---------------------------------------------------------------------------

describe("applyAiDesc", () => {
  it("does not throw and logs warning", () => {
    const infos: Record<string, ProjectInfoFull[]> = {
      xzf: [{
        name: "project-a",
        group: "xzf",
        branch: "master",
        git_url: "",
        tags: [],
        tag_source: "auto",
        description: "",
        desc_source: "none",
        local_path: null,
        knowledge: createKnowledgeInfo(),
      }],
    }
    expect(() => applyAiDesc(infos, "claude")).not.toThrow()
  })
})