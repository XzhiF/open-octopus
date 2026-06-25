import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AgentExecutor } from "../executors/agent"
import { VarPool } from "@octopus/shared"
import type { NodeDef, SubAgentDef } from "@octopus/shared"
import type { AgentRunResult } from "../executors/agent-types"
import fs from "fs"
import path from "path"
import os from "os"

// -- Helpers --

function makeSuccessResult(finalText: string, sessionId?: string): AgentRunResult {
  return {
    finalText,
    sessionId,
    events: [],
    durationMs: 100,
  }
}

const TEST_DIR = path.join(os.tmpdir(), "agent-file-test")

beforeEach(() => {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true })
  }
})

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  }
})

// -- Tests --

describe("AgentExecutor agent_file", () => {
  // 1. agent_file only (no prompt)
  it("reads agent_file and uses body as prompt when no prompt provided", async () => {
    const filePath = path.join(TEST_DIR, "agent1.md")
    fs.writeFileSync(filePath, "# Agent instructions\n\nYou are a helpful reviewer.")

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("review done", "sess1")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      reviewer: {
        description: "Code reviewer agent",
        agent_file: filePath,
      },
    }

    const node: NodeDef = {
      id: "agent-file-1",
      type: "agent",
      prompt: "Main task",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    expect(builtOpts.agents).toBeDefined()
    expect(builtOpts.agents.reviewer).toBeDefined()
    expect(builtOpts.agents.reviewer.prompt).toBe(
      "# Agent instructions\n\nYou are a helpful reviewer."
    )
    expect(builtOpts.agents.reviewer.agent_file).toBeUndefined()
  })

  // 2. agent_file + prompt concatenation
  it("concatenates agent_file and prompt with separator", async () => {
    const filePath = path.join(TEST_DIR, "agent2.md")
    fs.writeFileSync(filePath, "# Base instructions\n\nDo analysis.")

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("analysis done", "sess2")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      analyst: {
        description: "Data analyst agent",
        agent_file: filePath,
        prompt: "Focus on Q4 metrics.",
      },
    }

    const node: NodeDef = {
      id: "agent-file-2",
      type: "agent",
      prompt: "Run analysis",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    expect(builtOpts.agents.analyst.prompt).toBe(
      "# Base instructions\n\nDo analysis.\n\n---\n\nFocus on Q4 metrics."
    )
  })

  // 3. frontmatter stripping
  it("strips YAML frontmatter from agent_file content", async () => {
    const filePath = path.join(TEST_DIR, "agent3.md")
    fs.writeFileSync(
      filePath,
      "---\nname: reviewer\nmodel: claude-4-opus\nskills: [code-review]\n---\n# Body content\n\nThis is the actual prompt."
    )

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("body used", "sess3")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      reviewer: {
        description: "Reviewer with frontmatter",
        agent_file: filePath,
      },
    }

    const node: NodeDef = {
      id: "agent-file-3",
      type: "agent",
      prompt: "Review code",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    expect(builtOpts.agents.reviewer.prompt).toBe(
      "# Body content\n\nThis is the actual prompt."
    )
  })

  // 4. No frontmatter
  it("uses content as-is when no frontmatter present", async () => {
    const filePath = path.join(TEST_DIR, "agent4.md")
    fs.writeFileSync(filePath, "# No frontmatter here\n\nJust plain markdown content.")

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("plain content", "sess4")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      helper: {
        description: "Helper without frontmatter",
        agent_file: filePath,
      },
    }

    const node: NodeDef = {
      id: "agent-file-4",
      type: "agent",
      prompt: "Help me",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    expect(builtOpts.agents.helper.prompt).toBe(
      "# No frontmatter here\n\nJust plain markdown content."
    )
  })

  // 5. Variable substitution in path
  it("substitutes $vars references in agent_file path", async () => {
    const agentsDir = path.join(TEST_DIR, "my-agents")
    fs.mkdirSync(agentsDir, { recursive: true })
    const filePath = path.join(agentsDir, "specialist.md")
    fs.writeFileSync(filePath, "# Specialist agent\n\nYou specialize in debugging.")

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("specialized", "sess5")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      specialist: {
        description: "Specialist agent",
        agent_file: "$vars.agents_dir/specialist.md",
      },
    }

    const node: NodeDef = {
      id: "agent-file-5",
      type: "agent",
      prompt: "Debug this",
      agents,
    }
    const pool = new VarPool({ agents_dir: agentsDir })
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    expect(builtOpts.agents.specialist.prompt).toBe(
      "# Specialist agent\n\nYou specialize in debugging."
    )
  })

  // 6. Missing file error
  it("throws descriptive error when agent_file points to non-existent file", async () => {
    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("should not reach", "sess6")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      ghost: {
        description: "Ghost agent",
        agent_file: "/nonexistent/path/to/agent.md",
      },
    }

    const node: NodeDef = {
      id: "agent-file-6",
      type: "agent",
      prompt: "Do something",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    const result = await executor.execute()
    expect(result.status).toBe("failed")
    expect(result.logLines.join("\n")).toContain("no such file or directory")
  })

  // 7. Neither prompt nor agent_file
  it("throws error when SubAgentDef has neither prompt nor agent_file", async () => {
    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("should not reach", "sess7")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      empty: {
        description: "Empty agent def",
      },
    }

    const node: NodeDef = {
      id: "agent-file-7",
      type: "agent",
      prompt: "Task",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    const result = await executor.execute()
    expect(result.status).toBe("failed")
    expect(result.logLines.join("\n")).toContain('must have either "prompt" or "agent_file"')
    expect(result.logLines.join("\n")).toContain("empty")
  })

  // 8. prompt only (backward compat)
  it("works with prompt only, no agent_file (backward compatibility)", async () => {
    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("legacy ok", "sess8")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      legacy: {
        description: "Legacy agent def",
        prompt: "This is the legacy prompt",
      },
    }

    const node: NodeDef = {
      id: "agent-file-8",
      type: "agent",
      prompt: "Main prompt",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    expect(builtOpts.agents.legacy.prompt).toBe("This is the legacy prompt")
    // agent_file should not be present in resolved agents when not used
    expect(builtOpts.agents.legacy.agent_file).toBeUndefined()
  })

  // 9. ~ expansion
  it("expands ~ in agent_file path to os.homedir()", async () => {
    const homeDir = os.homedir()
    const homeAgentDir = path.join(homeDir, "octopus-test-agents")

    // Create the directory and file in home
    fs.mkdirSync(homeAgentDir, { recursive: true })
    const filePath = path.join(homeAgentDir, "home-agent.md")
    fs.writeFileSync(filePath, "# Home agent\n\nRunning from home directory.")

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("home agent ok", "sess9")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      homeAgent: {
        description: "Home directory agent",
        agent_file: "~/octopus-test-agents/home-agent.md",
      },
    }

    const node: NodeDef = {
      id: "agent-file-9",
      type: "agent",
      prompt: "Execute",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    expect(builtOpts.agents.homeAgent.prompt).toBe(
      "# Home agent\n\nRunning from home directory."
    )

    // Cleanup
    fs.rmSync(homeAgentDir, { recursive: true, force: true })
  })

  // Additional edge cases

  it("handles empty agent_file content", async () => {
    const filePath = path.join(TEST_DIR, "empty-agent.md")
    fs.writeFileSync(filePath, "")

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("empty file handled", "sess10")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      empty: {
        description: "Empty file agent",
        agent_file: filePath,
        prompt: "Supplemental prompt only",
      },
    }

    const node: NodeDef = {
      id: "agent-file-10",
      type: "agent",
      prompt: "Task",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    // Empty file + separator + prompt
    expect(builtOpts.agents.empty.prompt).toContain("\n\n---\n\n")
    expect(builtOpts.agents.empty.prompt).toContain("Supplemental prompt only")
  })

  it("preserves other SubAgentDef properties (tools, model, skills)", async () => {
    const filePath = path.join(TEST_DIR, "full-agent.md")
    fs.writeFileSync(filePath, "# Full agent\n\nBase instructions.")

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("full agent ok", "sess11")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      full: {
        description: "Full featured agent",
        agent_file: filePath,
        tools: ["Bash", "Read"],
        disallowedTools: ["Write"],
        model: "claude-4-opus",
        skills: ["octo-skill-creator"],
        maxTurns: 20,
        effort: "high",
      },
    }

    const node: NodeDef = {
      id: "agent-file-11",
      type: "agent",
      prompt: "Run",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    const resolved = builtOpts.agents.full
    expect(resolved.tools).toEqual(["Bash", "Read"])
    expect(resolved.disallowedTools).toEqual(["Write"])
    expect(resolved.model).toBe("claude-4-opus")
    expect(resolved.skills).toEqual(["octo-skill-creator"])
    expect(resolved.maxTurns).toBe(20)
    expect(resolved.effort).toBe("high")
    expect(resolved.prompt).toContain("Base instructions.")
  })

  it("resolves multiple agents with mixed agent_file and prompt", async () => {
    const filePath = path.join(TEST_DIR, "multi-agent.md")
    fs.writeFileSync(filePath, "# Multi agent\n\nShared base.")

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("multi ok", "sess12")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      fileBased: {
        description: "File-based agent",
        agent_file: filePath,
      },
      promptOnly: {
        description: "Prompt-only agent",
        prompt: "Direct prompt content",
      },
      both: {
        description: "Both file and prompt",
        agent_file: filePath,
        prompt: "Additional instructions",
      },
    }

    const node: NodeDef = {
      id: "agent-file-12",
      type: "agent",
      prompt: "Multi task",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    expect(builtOpts.agents.fileBased.prompt).toBe("# Multi agent\n\nShared base.")
    expect(builtOpts.agents.promptOnly.prompt).toBe("Direct prompt content")
    expect(builtOpts.agents.both.prompt).toContain("# Multi agent\n\nShared base.")
    expect(builtOpts.agents.both.prompt).toContain("Additional instructions")
  })

  it("strips frontmatter with extra whitespace after closing dashes", async () => {
    const filePath = path.join(TEST_DIR, "ws-frontmatter.md")
    fs.writeFileSync(
      filePath,
      "---\nname: test\n---\n\n\n  \n# Body after whitespace"
    )

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("ws ok", "sess13")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      ws: {
        description: "Whitespace frontmatter",
        agent_file: filePath,
      },
    }

    const node: NodeDef = {
      id: "agent-file-13",
      type: "agent",
      prompt: "Test",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    // trimStart() removes leading whitespace
    expect(builtOpts.agents.ws.prompt).toBe("# Body after whitespace")
  })

  it("does not strip when content starts with --- but closing --- is inline text", async () => {
    const filePath = path.join(TEST_DIR, "unclosed-fm.md")
    fs.writeFileSync(
      filePath,
      "---\nname: broken\n# This is not proper frontmatter\n--- is missing"
    )

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("unclosed ok", "sess14")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      broken: {
        description: "Unclosed frontmatter",
        agent_file: filePath,
      },
    }

    const node: NodeDef = {
      id: "agent-file-14",
      type: "agent",
      prompt: "Test",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    // The algorithm finds "---" on the last line, strips up to and including it,
    // then trimStart() removes the leading space -> "is missing"
    expect(builtOpts.agents.broken.prompt).toBe("is missing")
  })

  it("handles relative agent_file path resolved against runner cwd", async () => {
    const subDir = path.join(TEST_DIR, "sub")
    fs.mkdirSync(subDir, { recursive: true })
    const filePath = path.join(subDir, "relative-agent.md")
    fs.writeFileSync(filePath, "# Relative agent\n\nRelative path content.")

    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("relative ok", "sess15")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
      getCwd: vi.fn().mockReturnValue(TEST_DIR),
    } as any

    const agents: Record<string, SubAgentDef> = {
      relative: {
        description: "Relative path agent",
        agent_file: "sub/relative-agent.md",
      },
    }

    const node: NodeDef = {
      id: "agent-file-15",
      type: "agent",
      prompt: "Test",
      agents,
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, mockRunner)

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    expect(builtOpts.agents.relative.prompt).toBe(
      "# Relative agent\n\nRelative path content."
    )
  })
})
