import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createProgram } from "../index"
import { repoCmd } from "../commands/repo"
import { Command } from "commander"

describe("repo command group — structure", () => {
  it("repoCmd name is 'repo'", () => {
    expect(repoCmd.name()).toBe("repo")
  })

  it("repoCmd has description", () => {
    expect(repoCmd.description()).toContain("资源仓库")
  })

  it("repoCmd has exactly 12 subcommands", () => {
    const subs = repoCmd.commands.map((c: Command) => c.name())
    expect(subs).toHaveLength(12)
  })

  it("all expected subcommands are registered", () => {
    const subs = repoCmd.commands.map((c: Command) => c.name())
    const expected = [
      "init", "register", "list", "search", "info",
      "install", "uninstall", "deps", "gc", "audit", "doctor", "sync",
    ]
    for (const name of expected) {
      expect(subs).toContain(name)
    }
  })

  it("repo is wired into the main program", () => {
    const program = createProgram()
    const names = program.commands.map((c: Command) => c.name())
    expect(names).toContain("repo")
  })
})

describe("repo init subcommand", () => {
  it("has --repo-dir, --force, --json options", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "init")!
    const optNames = cmd.options.map((o: any) => o.long)
    expect(optNames).toContain("--repo-dir")
    expect(optNames).toContain("--force")
    expect(optNames).toContain("--json")
  })

  it("description mentions initialization", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "init")!
    expect(cmd.description()).toContain("初始化")
  })
})

describe("repo register subcommand", () => {
  it("takes <ref> as required argument", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "register")!
    // Commander's registeredArguments strips angle brackets from .name()
    expect(cmd.registeredArguments).toBeDefined()
    expect(cmd.registeredArguments[0].name()).toBe("ref")
    expect(cmd.registeredArguments[0].required).toBe(true)
  })

  it("has --type as requiredOption", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "register")!
    const typeOpt = cmd.options.find((o: any) => o.long === "--type")
    expect(typeOpt).toBeDefined()
    expect(typeOpt.required).toBe(true)
  })

  it("has --name, --tag, --force, --trust, --repo-dir, --json options", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "register")!
    const optNames = cmd.options.map((o: any) => o.long)
    expect(optNames).toContain("--name")
    expect(optNames).toContain("--tag")
    expect(optNames).toContain("--force")
    expect(optNames).toContain("--trust")
    expect(optNames).toContain("--repo-dir")
    expect(optNames).toContain("--json")
  })
})

describe("repo list subcommand", () => {
  it("has --type, --tag, --repo-dir, --json options", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "list")!
    const optNames = cmd.options.map((o: any) => o.long)
    expect(optNames).toContain("--type")
    expect(optNames).toContain("--tag")
    expect(optNames).toContain("--repo-dir")
    expect(optNames).toContain("--json")
  })
})

describe("repo search subcommand", () => {
  it("takes <query> argument", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "search")!
    expect(cmd.registeredArguments[0].name()).toBe("query")
  })

  it("has --page option with default '1'", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "search")!
    const pageOpt = cmd.options.find((o: any) => o.long === "--page")
    expect(pageOpt).toBeDefined()
    expect(pageOpt.defaultValue).toBe("1")
  })
})

describe("repo install subcommand", () => {
  it("takes <names...> variadic argument", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "install")!
    const arg = cmd.registeredArguments[0]
    expect(arg.name()).toBe("names")
    expect(arg.variadic).toBe(true)
  })

  it("has --dry-run, --force, --yes, --confirmed for install modes", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "install")!
    const optNames = cmd.options.map((o: any) => o.long)
    expect(optNames).toContain("--dry-run")
    expect(optNames).toContain("--force")
    expect(optNames).toContain("--yes")
    expect(optNames).toContain("--confirmed")
  })

  it("--workspace defaults to '.'", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "install")!
    const wsOpt = cmd.options.find((o: any) => o.long === "--workspace")
    expect(wsOpt).toBeDefined()
    expect(wsOpt.defaultValue).toBe(".")
  })
})

describe("repo uninstall subcommand", () => {
  it("takes <name> argument", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "uninstall")!
    expect(cmd.registeredArguments[0].name()).toBe("name")
  })

  it("has --force and --confirmed options", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "uninstall")!
    const optNames = cmd.options.map((o: any) => o.long)
    expect(optNames).toContain("--force")
    expect(optNames).toContain("--confirmed")
  })
})

describe("repo deps subcommand", () => {
  it("takes <name> argument and supports --json", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "deps")!
    expect(cmd.registeredArguments[0].name()).toBe("name")
    const optNames = cmd.options.map((o: any) => o.long)
    expect(optNames).toContain("--json")
    expect(optNames).toContain("--type")
  })
})

describe("repo gc subcommand", () => {
  it("has --dry-run option for preview", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "gc")!
    const optNames = cmd.options.map((o: any) => o.long)
    expect(optNames).toContain("--dry-run")
    expect(optNames).toContain("--json")
  })

  it("description mentions cleanup", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "gc")!
    expect(cmd.description()).toContain("清理")
  })
})

describe("repo audit subcommand", () => {
  it("has --last option with default '20'", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "audit")!
    const lastOpt = cmd.options.find((o: any) => o.long === "--last")
    expect(lastOpt).toBeDefined()
    expect(lastOpt.defaultValue).toBe("20")
  })

  it("has --workspace option", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "audit")!
    const optNames = cmd.options.map((o: any) => o.long)
    expect(optNames).toContain("--workspace")
  })
})

describe("repo doctor subcommand", () => {
  it("description mentions health check", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "doctor")!
    expect(cmd.description()).toContain("自检")
  })

  it("has --json and --repo-dir options", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "doctor")!
    const optNames = cmd.options.map((o: any) => o.long)
    expect(optNames).toContain("--json")
    expect(optNames).toContain("--repo-dir")
  })
})

describe("repo sync subcommand", () => {
  it("description mentions drift detection", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "sync")!
    expect(cmd.description()).toContain("漂移")
  })

  it("--workspace defaults to '.'", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "sync")!
    const wsOpt = cmd.options.find((o: any) => o.long === "--workspace")
    expect(wsOpt).toBeDefined()
    expect(wsOpt.defaultValue).toBe(".")
  })
})

describe("repo command — SEC-06 agent gating options", () => {
  it("install distinguishes --yes (human) from --confirmed (agent)", () => {
    const installCmd = repoCmd.commands.find((c: Command) => c.name() === "install")!
    const yesOpt = installCmd.options.find((o: any) => o.long === "--yes")
    const confirmedOpt = installCmd.options.find((o: any) => o.long === "--confirmed")
    expect(yesOpt).toBeDefined()
    expect(confirmedOpt).toBeDefined()
    // Descriptions clarify audience
    expect(yesOpt.description).toContain("人类")
    expect(confirmedOpt.description).toContain("Agent")
  })

  it("uninstall also has --confirmed for agent gating", () => {
    const cmd = repoCmd.commands.find((c: Command) => c.name() === "uninstall")!
    const confirmedOpt = cmd.options.find((o: any) => o.long === "--confirmed")
    expect(confirmedOpt).toBeDefined()
    expect(confirmedOpt.description).toContain("Agent")
  })
})
