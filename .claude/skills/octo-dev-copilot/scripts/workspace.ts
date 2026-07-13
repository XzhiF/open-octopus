#!/usr/bin/env node
/**
 * workspace.ts — octopus 多仓库工作空间管理脚本 (git worktree 版)
 *
 * 工作空间通过 git worktree 管理，每个 repo 在 workspace 目录内创建独立 worktree，
 * 主仓库保持干净，所有开发操作在 worktree 上进行。
 *
 * 用法:
 *   node workspace.js init <ws-name> <repo1> <repo2> ... --org <org>   初始化工作空间(创建worktree)
 *   node workspace.js add <ws-name> <repo> --org <org>                  向工作空间添加一个repo的worktree
 *   node workspace.js remove <ws-name> <repo> --org <org>               从工作空间移除一个repo的worktree
 *   node workspace.js destroy <ws-name> --org <org>                     删除工作空间及所有worktree
 *   node workspace.js status <ws-name> --org <org>                      查询各worktree状态
 *   node workspace.js branch <ws-name> <branch-name> --org <org>        在worktree上创建/切换分支
 *   node workspace.js list --org <org>                                  列出所有工作空间
 *   node workspace.js diff <ws-name> --org <org>                        查看未提交变更摘要
 *
 * --org 参数可通过以下方式指定:
 *   1. 命令行 --org <org> 参数
 *   2. OCTOPUS_ORG 环境变量
 *   3. ~/.octopus/config.json 中 default_org 字段
 */

import { execFileSync } from "child_process";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Helpers ───────────────────────────────────────────────────────────────

const DOC = `workspace.ts — octopus 多仓库工作空间管理脚本 (git worktree 版)

用法:
  node workspace.js init <ws-name> <repo1> <repo2> ... --org <org>
  node workspace.js add <ws-name> <repo> --org <org>
  node workspace.js remove <ws-name> <repo> --org <org>
  node workspace.js destroy <ws-name> --org <org>
  node workspace.js status <ws-name> --org <org>
  node workspace.js branch <ws-name> <branch-name> --org <org>
  node workspace.js list --org <org>
  node workspace.js diff <ws-name> --org <org>

--org 参数可通过以下方式指定:
  1. 命令行 --org <org> 参数
  2. OCTOPUS_ORG 环境变量
  3. ~/.octopus/config.json 中 default_org 字段`;

interface RepoEntry {
  name: string;
  group: string;
  main_path: string | null;
  worktree_path: string;
}

interface RepoInfo {
  group: string;
  name: string;
  main_path: string | null;
  git_url: string | null;
  default_branch: string | null;
}

interface ConfigData {
  name: string;
  repos: RepoEntry[];
  created: string;
  branch?: string;
  init_branch_name?: string;
}

function getPaths(org: string): { workspaceRoot: string; reposIndex: string } {
  const base = path.join(os.homedir(), ".octopus", "orgs", org);
  return {
    workspaceRoot: path.join(base, "workspaces"),
    reposIndex: path.join(base, "repos", "index.md"),
  };
}

function parseOrgArg(): { org: string; remaining: string[] } {
  let org: string | null = null;
  const remaining: string[] = [];
  const argv = process.argv.slice(2);
  let i = 0;

  while (i < argv.length) {
    if (argv[i] === "--org" && i + 1 < argv.length) {
      org = argv[i + 1];
      i += 2;
    } else if (argv[i].startsWith("--org=")) {
      org = argv[i].slice(6);
      i += 1;
    } else if (argv[i] === "--server-url" && i + 1 < argv.length) {
      i += 2; // skip --server-url and its value; parsed separately
    } else if (argv[i].startsWith("--server-url=")) {
      i += 1; // skip --server-url=value; parsed separately
    } else {
      remaining.push(argv[i]);
      i += 1;
    }
  }

  if (org === null) {
    org = process.env.OCTOPUS_ORG || null;
  }

  if (org === null) {
    const configPath = path.join(os.homedir(), ".octopus", "config.json");
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        org = config.default_org || null;
      } catch {
        // ignore parse errors
      }
    }
  }

  if (org === null) {
    console.error("ERROR: 需要指定 org (--org 参数, OCTOPUS_ORG 环境变量, 或 ~/.octopus/config.json default_org)");
    process.exit(1);
  }

  return { org, remaining };
}

function parseServerUrl(): string | undefined {
  const argv = process.argv.slice(2);
  let i = 0;

  while (i < argv.length) {
    if (argv[i] === "--server-url" && i + 1 < argv.length) {
      return argv[i + 1];
    } else if (argv[i].startsWith("--server-url=")) {
      return argv[i].slice(13);
    }
    i += 1;
  }

  return undefined;
}

function parseBranchName(): string | undefined {
  const argv = process.argv.slice(2);
  let i = 0;

  while (i < argv.length) {
    if (argv[i] === "--branch" && i + 1 < argv.length) {
      return argv[i + 1];
    } else if (argv[i].startsWith("--branch=")) {
      return argv[i].slice(9);
    }
    i += 1;
  }

  return undefined;
}

function syncToServer(serverUrl: string, method: string, apiPath: string, body?: object): void {
  const url = `${serverUrl}${apiPath}`;
  const postData = body ? JSON.stringify(body) : undefined;
  const isHttps = url.startsWith("https");
  const requestModule = isHttps ? https : http;

  const options: http.RequestOptions = {
    method,
    headers: { "Content-Type": "application/json" },
  };

  const req = requestModule.request(url, options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      if (res.statusCode! >= 400) {
        console.error(`  ⚠ Server sync failed: ${res.statusCode} ${data}`);
      } else {
        console.log(`  ✓ Synced to server`);
      }
    });
  });

  req.on("error", (e) => console.error(`  ⚠ Server sync error: ${e.message}`));
  if (postData) req.write(postData);
  req.end();
}

function runGit(repoPath: string, args: string[]): { stdout: string; ok: boolean } {
  try {
    const stdout = execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), ok: true };
  } catch (e: any) {
    return { stdout: (e.stdout || "").toString().trim(), ok: false };
  }
}

function runGitCapture(repoPath: string, args: string[]): { stdout: string; stderr: string; ok: boolean } {
  try {
    const result = execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout: result.trim(), stderr: "", ok: true };
  } catch (e: any) {
    return {
      stdout: (e.stdout || "").toString().trim(),
      stderr: (e.stderr || "").toString().trim(),
      ok: false,
    };
  }
}

function getRepoInfo(repoName: string, reposIndex: string): RepoInfo | null {
  if (!fs.existsSync(reposIndex)) {
    return null;
  }

  let targetGroup: string | null = null;
  let name: string = repoName;
  if (repoName.includes("/")) {
    const parts = repoName.split("/");
    targetGroup = parts[0];
    name = parts[1];
  }

  const content = fs.readFileSync(reposIndex, "utf-8");
  const lines = content.split("\n");

  const allMatches: RepoInfo[] = [];
  let currentGroupName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("## ")) {
      const groupFull = line.slice(3).trim();
      currentGroupName = groupFull.includes("(")
        ? groupFull.split("(")[0].trim()
        : groupFull;
    } else if (line.startsWith("### ")) {
      const repoNameInLine = line.slice(4).trim();
      let matched = false;

      if (targetGroup !== null) {
        matched = currentGroupName === targetGroup && repoNameInLine === name;
      } else {
        matched = repoNameInLine === name;
      }

      if (matched && currentGroupName) {
        let localPath: string | null = null;
        let gitUrl: string | null = null;
        let defaultBranch: string | null = null;

        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const subLine = lines[j];
          if (subLine.startsWith("- local:")) {
            let pathStr = subLine.slice(8).trim();
            pathStr = pathStr
              .replace(" ✓ cloned", "")
              .replace(" — not cloned", "")
              .replace(" ? cloned", "");
            let resolvedPath = pathStr;
            if (pathStr.startsWith("$HOME/") || pathStr.startsWith("~/")) {
              resolvedPath = path.join(
                os.homedir(),
                pathStr.replace(/^\$HOME\/|^~\//, "")
              );
            }
            if (fs.existsSync(resolvedPath)) {
              localPath = path.resolve(resolvedPath);
            }
          } else if (subLine.startsWith("- git:")) {
            gitUrl = subLine.slice(6).trim();
          } else if (subLine.startsWith("- branch:")) {
            defaultBranch = subLine.slice(9).trim();
          } else if (subLine.startsWith("---") || subLine.startsWith("# ") || subLine.startsWith("## ")) {
            break;
          }
        }

        const entry: RepoInfo = {
          group: currentGroupName,
          name: repoNameInLine,
          main_path: localPath,
          git_url: gitUrl,
          default_branch: defaultBranch,
        };

        if (targetGroup !== null) {
          return entry;
        }
        allMatches.push(entry);
      }
    }
  }

  if (allMatches.length === 0) {
    return null;
  }

  for (const m of allMatches) {
    if (m.main_path && fs.existsSync(m.main_path)) {
      return m;
    }
  }

  return allMatches[0];
}

function parseRepos(configFile: string): RepoEntry[] {
  if (!fs.existsSync(configFile)) {
    return [];
  }
  try {
    const data: ConfigData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    return data.repos || [];
  } catch {
    return [];
  }
}

function worktreeDirName(group: string, name: string): string {
  return `${group}-${name}`;
}

function createWorktree(
  mainPath: string,
  worktreePath: string
): { result: string | null; error: string | null } {
  if (!mainPath || !fs.existsSync(mainPath)) {
    return { result: null, error: "main repo path not found" };
  }

  if (fs.existsSync(worktreePath)) {
    return { result: null, error: `worktree directory already exists: ${worktreePath}` };
  }

  const parent = path.dirname(worktreePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  // Prune stale worktree registrations before adding
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: mainPath, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  } catch { /* ok */ }

  const { stdout, stderr, ok } = runGitCapture(mainPath, [
    "worktree",
    "add",
    "-f",
    worktreePath,
    "--detach",
  ]);

  if (ok) {
    return { result: worktreePath, error: null };
  }
  return { result: null, error: stderr || stdout || "git worktree add failed" };
}

function removeWorktree(
  mainPath: string | null,
  worktreePath: string
): { ok: boolean; error: string | null } {
  if (!mainPath || !fs.existsSync(mainPath)) {
    return { ok: false, error: "main repo path not found" };
  }

  if (!fs.existsSync(worktreePath)) {
    return { ok: true, error: "worktree directory not found, skipping" };
  }

  const { stdout, stderr, ok } = runGitCapture(mainPath, [
    "worktree",
    "remove",
    worktreePath,
    "--force",
  ]);

  if (ok) {
    return { ok: true, error: null };
  }
  return { ok: false, error: stderr || stdout || "git worktree remove failed" };
}

function initCodeDevCopilotRules(wsDir: string, org: string): void {
  const rulesDir = path.join(wsDir, ".octopus", "code-dev-copilot-rules");
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }

  // Copy *.md rules from multiple sources into workspace's .octopus/code-dev-copilot-rules/
  const sources = [
    // 1. Project-level: current project's .octopus/code-dev-copilot-rules/
    path.join(process.cwd(), ".octopus", "code-dev-copilot-rules"),
    // 2. Org-level: ~/.octopus/{org}/code-dev-copilot-rules/
    path.join(os.homedir(), ".octopus", "orgs", org, "code-dev-copilot-rules"),
  ];
  for (const srcDir of sources) {
    if (!fs.existsSync(srcDir)) continue;
    try {
      const files = fs.readdirSync(srcDir);
      for (const file of files) {
        if (file.endsWith(".md")) {
          const srcPath = path.join(srcDir, file);
          const destPath = path.join(rulesDir, file);
          if (fs.statSync(srcPath).isFile() && !fs.existsSync(destPath)) {
            fs.copyFileSync(srcPath, destPath);
            console.log(`  📋 已复制规则: ${file}`);
          }
        }
      }
    } catch { /* source read optional */ }
  }
}

function copySkills(wsDir: string): void {
  const corePackDir = findCorePackSkillsRoot();
  if (!corePackDir) return;
  const skillsDir = path.join(wsDir, ".claude", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  const coreSkills = ["octo-dev-copilot", "octo-workflow-dev", "octo-swarm-dev", "octo-browser-debug", "octo-browser-vision", "octo-e2e-assurance"];
  for (const skillName of coreSkills) {
    const dest = path.join(skillsDir, skillName);
    const src = path.join(corePackDir, skillName);
    if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
    fs.mkdirSync(dest, { recursive: true });
    // Only copy SKILL.md + scripts/ (excluding .ts source and node_modules)
    // Merge: only copy files that don't exist in dest (preserve user edits)
    const srcSkillMd = path.join(src, "SKILL.md");
    const destSkillMd = path.join(dest, "SKILL.md");
    if (!fs.existsSync(destSkillMd)) {
      fs.copyFileSync(srcSkillMd, destSkillMd);
    }
    const scriptsDir = path.join(src, "scripts");
    if (fs.existsSync(scriptsDir)) {
      const destScriptsDir = path.join(dest, "scripts");
      fs.mkdirSync(destScriptsDir, { recursive: true });
      for (const f of fs.readdirSync(scriptsDir)) {
        // Copy .bundle.js, .js (skip .ts source), and .py scripts
        if (f.endsWith(".bundle.js") || (f.endsWith(".js") && !f.endsWith(".ts.js")) || f.endsWith(".py")) {
          const srcScript = path.join(scriptsDir, f);
          const destScript = path.join(destScriptsDir, f);
          if (!fs.existsSync(destScript)) {
            fs.copyFileSync(srcScript, destScript);
          }
        }
      }
    }
    console.log(`  📋 已同步技能: ${skillName}`);
  }
}

function findCorePackSkillsRoot(): string | null {
  const candidates = [
    path.join(process.cwd(), "..", "core-pack", "skills"),
    path.join(process.cwd(), "packages", "core-pack", "skills"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findCorePackAgentsRoot(): string | null {
  const candidates = [
    path.join(process.cwd(), "..", "core-pack", "agents"),
    path.join(process.cwd(), "packages", "core-pack", "agents"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function copyAgents(wsDir: string): void {
  const corePackAgentsDir = findCorePackAgentsRoot();
  if (!corePackAgentsDir) return;

  const agentsDir = path.join(wsDir, ".claude", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  // Copy all .md files (not .md.tpl templates) from core-pack/agents/
  const coreAgents = ["devil-advocate.md", "architecture-explorer.md", "vision-analyzer.md"];
  for (const agentFile of coreAgents) {
    const dest = path.join(agentsDir, agentFile);
    if (fs.existsSync(dest)) continue;
    const src = path.join(corePackAgentsDir, agentFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`  😈 已同步代理: ${agentFile}`);
    }
  }
}

/**
 * 生成工作空间通用引导内容 — 目录结构、执行状态、依赖安装、视觉规则。
 * 所有 CLAUDE.md 生成点共用此函数。
 */
function workspaceGuide(): string[] {
  return [
    "",
    "## 目录结构",
    "",
    "```",
    "<workspace>/",
    "├── CLAUDE.md           ← 工作空间指令（本文件）",
    "├── config.json         ← 工作空间配置（名称、关联仓库、创建时间、初始分支）",
    "├── .claude/skills/     ← 已安装的 Claude Code Skills（从 core-pack 复制）",
    "├── projects/           ← 项目代码（每个子目录是一个 git worktree）",
    "├── workflows/          ← 工作流 YAML 定义（octopus workflow run 的执行目标）",
    "├── state/              ← 执行状态记录",
    "│   ├── executions.json   ← 执行索引（所有执行的注册表）",
    "│   ├── {uuid}.json       ← 单次执行结果快照（含每个节点的 status/duration/outputs）",
    "│   └── {uuid}-{name}.yaml ← 工作流 YAML 快照",
    "├── logs/               ← 执行日志",
    "│   └── {uuid}/           ← 每次执行的日志目录",
    "│       ├── {node-id}.jsonl ← 按节点 ID 命名的 JSONL 日志",
    "│       └── final-summary.jsonl",
    "└── dependencies/       ← 外部依赖（如 agency-agents-zh 克隆）",
    "```",
    "",
    "## 执行状态与日志",
    "",
    "### state/executions.json — 执行索引",
    "顶层注册表，记录每次执行的:",
    "- `execution_id` — UUID，关联 logs/ 目录和 {uuid}.json 结果文件",
    "- `parent_id` — 父执行 ID（`\"0\"` 表示无父级，否则指向重试/续跑的源执行）",
    "- `status` — completed / failed / running",
    "- `workflow_ref` — 执行的工作流 YAML 文件名",
    "- `workflow_name` — 工作流名称",
    "- `start_commit_id` / `end_commit_id` — 各项目执行前后的 Git commit SHA",
    "",
    "### state/{uuid}.json — 执行结果",
    "包含每个节点的执行详情:",
    "- `nodes[node-id].status` — completed / failed / skipped",
    "- `nodes[node-id].durationMs` — 节点执行耗时（毫秒）",
    "- `nodes[node-id].lastOutput` — bash 节点的 stdout 输出",
    "- `nodes[node-id].exitCode` — bash 节点的退出码",
    "- `poolSnapshot` — 执行结束时的完整变量池快照（所有 $vars.* 的最终值）",
    "",
    "### 查找执行链: executions.json → {uuid}.json → logs/",
    "1. 在 `state/executions.json` 中按 `workflow_name` 或 `status` 找到目标执行",
    "2. 用 `execution_id` 打开对应的 `state/{uuid}.json` 查看节点级结果",
    "3. 用 `execution_id` 进入 `logs/{uuid}/` 目录查看节点级详细日志",
    "",
    "### logs/{uuid}/{node-id}.jsonl — 节点日志",
    "每个节点一个 JSONL 文件，包含时间戳事件:",
    "- `start` / `end` — 节点生命周期",
    "- `agent_event` — agent 节点的 thinking/text_delta/tool_call/status 事件",
    "- `bash_log` — bash 节点的 stdout 输出行",
    "",
    "## 依赖安装",
    "",
    "### superpowers-zh（Claude Code 技能框架）",
    "20 个技能（brainstorming/writing-plans/TDD/verification 等），在工作流 setup 阶段自动安装:",
    "```bash",
    "npx superpowers-zh@latest --tool claude --force",
    "```",
    "安装到 `.claude/skills/` 目录。工作流 YAML 中通过 `skills:` 字段引用。",
    "",
    "### agency-agents-zh（对抗式多智能体角色库）",
    "215 个预定义代理角色（engineering/testing/design/marketing 等 18 个部门），",
    "增强版工作流在 setup 阶段按需克隆并精选复制到 `.claude/agents/`:",
    "```bash",
    "git clone --depth 1 https://github.com/jnMetaCode/agency-agents-zh.git dependencies/agency-agents-zh",
    "# 精选复制到 .claude/agents/（仅需要的部门和文件）",
    "```",
    "工作流 YAML 中通过 `agent_file:` 字段引用 `.claude/agents/` 下的 .md 文件，",
    "引擎运行时读取文件内容 + `prompt` 拼接后传给 Claude Agent SDK。",
    "",
    "## 视觉分析规则（重要）",
    "",
    "**图片数据永远不能进入主 Agent 的 session 上下文。**",
    "",
    "- 需要分析截图/图片时，必须使用 SDK 子代理（`agents` 参数定义 `vision-analyzer`）或外部工具（`python vision_analyze.py`）",
    "- 禁止父代理直接处理图片，否则会污染 session 上下文，导致后续非视觉模型节点 400 报错",
    "- 子代理有独立上下文，执行完毕后只有文本结果返回父代理",
  ];
}

function writeClaudeMd(wsDir: string, wsName: string, repos: RepoEntry[]): void {
  const claudeMdPath = path.join(wsDir, "CLAUDE.md");
  const lines: string[] = [
    `# 工作空间: ${wsName}`,
    "",
    "## 涉及项目 (git worktree)",
    "",
    "各项目通过 git worktree 链接到主仓库，在此目录内编码，不影响主仓库分支。",
    "",
  ];

  for (const r of repos) {
    const wtName = worktreeDirName(r.group, r.name);
    lines.push(`- **${wtName}**: \`${r.worktree_path}\``);
    lines.push(`  - 主仓库: \`${r.main_path}\``);
  }

  lines.push(
    "",
    "## 说明",
    "- 使用 `octo-dev-copilot` skill 管理此工作空间",
    "- 使用 `octo-workflow-dev` skill 开发与校验工作流",
    "- 修改代码时直接操作各 worktree 目录",
    "- 主仓库保持干净，开发分支仅在 worktree 中",
    "- 使用 `branch` 命令在 worktree 上创建开发分支",
    "- 使用 `destroy` 命令清理整个工作空间"
  );

  // 追加通用工作空间引导（目录结构、执行状态、依赖安装、视觉规则）
  lines.push(...workspaceGuide());

  let branchInfo = "";
  try {
    const data: ConfigData = JSON.parse(
      fs.readFileSync(path.join(wsDir, "config.json"), "utf-8")
    );
    branchInfo = data.branch || "";
  } catch {
    // ignore
  }
  if (branchInfo) {
    lines.push("", `## 开发分支: ${branchInfo}`);
  }

  fs.writeFileSync(claudeMdPath, lines.join("\n"), "utf-8");
}

// ─── Commands ──────────────────────────────────────────────────────────────

function cmdInit(wsName: string, repos: string[], org: string, serverUrl?: string, overrideBranch?: string): void {
  const { workspaceRoot, reposIndex } = getPaths(org);

  if (!wsName) {
    console.error("ERROR: 需要指定工作空间名称");
    process.exit(1);
  }
  if (repos.length === 0) {
    console.error("ERROR: 需要指定至少一个 repo");
    process.exit(1);
  }

  const branchName = overrideBranch || wsName;

  const wsDir = path.join(workspaceRoot, wsName);
  const configFile = path.join(wsDir, "config.json");
  const dirExisted = fs.existsSync(wsDir);

  if (dirExisted) {
    // Directory exists — check if it was already initialized
    if (fs.existsSync(configFile)) {
      console.error(`ERROR: 工作空间 ${wsName} 已初始化: ${wsDir}`);
      console.error("如需重建，先 destroy 旧工作空间");
      process.exit(1);
    }
    // Directory exists but no config.json (e.g. web-app skeleton) — allow init to proceed
    console.log(`  目录 ${wsDir} 已存在，继续初始化...`);
  } else {
    fs.mkdirSync(wsDir, { recursive: true });
  }

  const entries: RepoEntry[] = [];
  for (const repo of repos) {
    const info = getRepoInfo(repo, reposIndex);
    if (info === null) {
      console.log(`WARN: repo ${repo} 未在 index.md 中找到，跳过`);
      continue;
    }
    if (info.main_path === null || !fs.existsSync(info.main_path)) {
      console.log(`WARN: repo ${info.group}/${info.name} 本地路径不可达，跳过`);
      continue;
    }

    const wtName = worktreeDirName(info.group, info.name);
    const wtPath = path.join(wsDir, "projects", wtName);

    const { result, error } = createWorktree(info.main_path, wtPath);
    if (result === null) {
      console.log(`WARN: repo ${info.group}/${info.name} worktree 创建失败: ${error}`);
      continue;
    }

    entries.push({
      name: info.name,
      group: info.group,
      main_path: info.main_path,
      worktree_path: wtPath,
    });

    // Checkout to branch (worktree was created in detached HEAD)
    try {
      execFileSync("git", ["checkout", "-b", branchName], { cwd: wtPath, encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // Branch may already exist, try switching
      try {
        execFileSync("git", ["checkout", branchName], { cwd: wtPath, encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
      } catch { /* ignore */ }
    }

    console.log(`  ✅ ${wtName} → ${wtPath} [${branchName}]`);
  }

  if (entries.length === 0) {
    console.error("ERROR: 没有成功创建任何 worktree，无法完成初始化");
    // Clean up: only remove the directory if we created it; otherwise just clean projects/
    if (!dirExisted) {
      fs.rmSync(wsDir, { recursive: true, force: true });
    } else {
      const projectsDir = path.join(wsDir, "projects");
      if (fs.existsSync(projectsDir)) {
        fs.rmSync(projectsDir, { recursive: true, force: true });
      }
    }
    process.exit(1);
  }

  const configData: ConfigData = {
    name: wsName,
    repos: entries,
    created: new Date().toISOString(),
    init_branch_name: branchName,
  };
  fs.writeFileSync(
    configFile,
    JSON.stringify(configData, null, 2),
    "utf-8"
  );

  writeClaudeMd(wsDir, wsName, entries);

  copySkills(wsDir);
  copyAgents(wsDir);
  initCodeDevCopilotRules(wsDir, org);

  console.log(`\n✅ 工作空间 ${wsName} 初始化完成`);
  console.log(`   目录: ${wsDir}`);
  console.log(`   项目数: ${entries.length}`);
  console.log(`   分支: ${branchName}`);

  if (serverUrl) {
    syncToServer(serverUrl, "POST", "/api/workspaces/sync", {
      name: wsName,
      org,
      path: wsDir,
      repos: entries,
      branch: branchName,
    });
  }
}

function cmdAdd(wsName: string, repo: string, org: string, serverUrl?: string): void {
  const { workspaceRoot, reposIndex } = getPaths(org);

  if (!wsName || !repo) {
    console.error("ERROR: 需要指定工作空间名称和 repo");
    process.exit(1);
  }

  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: 工作空间 ${wsName} 不存在`);
    process.exit(1);
  }

  const configFile = path.join(wsDir, "config.json");
  const data: ConfigData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const existingRepos = data.repos;

  const existingNames = existingRepos.map((r) => r.name);
  const info = getRepoInfo(repo, reposIndex);
  if (info === null) {
    console.error(`ERROR: repo ${repo} 未在 index.md 中找到`);
    process.exit(1);
  }
  if (existingNames.includes(info.name)) {
    console.error(`ERROR: repo ${info.group}/${info.name} 已在工作空间中`);
    process.exit(1);
  }
  if (info.main_path === null || !fs.existsSync(info.main_path)) {
    console.error(`ERROR: repo ${info.group}/${info.name} 本地路径不可达`);
    process.exit(1);
  }

  const wtName = worktreeDirName(info.group, info.name);
  const wtPath = path.join(wsDir, "projects", wtName);

  const { result, error } = createWorktree(info.main_path, wtPath);
  if (result === null) {
    console.error(`ERROR: worktree 创建失败: ${error}`);
    process.exit(1);
  }

  const newEntry: RepoEntry = {
    name: info.name,
    group: info.group,
    main_path: info.main_path,
    worktree_path: wtPath,
  };

  const updatedRepos = [...existingRepos, newEntry];
  const updatedData: ConfigData = { ...data, repos: updatedRepos };
  fs.writeFileSync(
    configFile,
    JSON.stringify(updatedData, null, 2),
    "utf-8"
  );

  writeClaudeMd(wsDir, wsName, updatedRepos);

  console.log(`✅ 已添加 ${wtName} 到工作空间 ${wsName}`);
  console.log(`   worktree: ${wtPath}`);

  if (serverUrl) {
    syncToServer(serverUrl, "POST", "/api/workspaces/sync", {
      name: wsName,
      org,
      path: wsDir,
      repos: updatedRepos,
    });
  }
}

function cmdRemove(wsName: string, repo: string, org: string, serverUrl?: string): void {
  const { workspaceRoot } = getPaths(org);

  if (!wsName || !repo) {
    console.error("ERROR: 需要指定工作空间名称和 repo");
    process.exit(1);
  }

  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: 工作空间 ${wsName} 不存在`);
    process.exit(1);
  }

  const configFile = path.join(wsDir, "config.json");
  const data: ConfigData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const existingRepos = data.repos;

  const target = existingRepos.find(
    (r) => r.name === repo || `${r.group}/${r.name}` === repo
  );

  if (target === undefined) {
    console.error(`ERROR: repo ${repo} 不在工作空间中`);
    process.exit(1);
  }

  const wtName = worktreeDirName(target.group, target.name);
  const { ok, error } = removeWorktree(target.main_path, target.worktree_path);
  if (!ok) {
    console.error(`ERROR: worktree 移除失败: ${error}`);
    process.exit(1);
  }

  const updatedRepos = existingRepos.filter((r) => r !== target);
  const updatedData: ConfigData = { ...data, repos: updatedRepos };
  fs.writeFileSync(
    configFile,
    JSON.stringify(updatedData, null, 2),
    "utf-8"
  );

  writeClaudeMd(wsDir, wsName, updatedRepos);

  console.log(`✅ 已移除 ${wtName} 从工作空间 ${wsName}`);

  if (serverUrl) {
    syncToServer(serverUrl, "POST", "/api/workspaces/sync", {
      name: wsName,
      org,
      path: wsDir,
      repos: updatedRepos,
    });
  }
}

function cmdDestroy(wsName: string, org: string, serverUrl?: string): void {
  const { workspaceRoot } = getPaths(org);

  if (!wsName) {
    console.error("ERROR: 需要指定工作空间名称");
    process.exit(1);
  }

  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: 工作空间 ${wsName} 不存在`);
    process.exit(1);
  }

  const configFile = path.join(wsDir, "config.json");
  if (!fs.existsSync(configFile)) {
    fs.rmSync(wsDir, { recursive: true, force: true });
    console.log(`✅ 已删除工作空间目录 ${wsDir}`);
    return;
  }

  const data: ConfigData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const repos = data.repos || [];

  for (const r of repos) {
    const wtName = worktreeDirName(r.group, r.name);
    const { ok, error } = removeWorktree(r.main_path, r.worktree_path);
    if (ok) {
      console.log(`  ✅ 已移除 worktree: ${wtName}`);
    } else {
      console.log(`  ⚠ worktree 移除失败: ${wtName} — ${error}`);
    }
  }

  fs.rmSync(wsDir, { recursive: true, force: true });

  console.log(`\n✅ 工作空间 ${wsName} 已销毁`);

  if (serverUrl) {
    syncToServer(serverUrl, "DELETE", `/api/workspaces/${wsName}`);
  }
}

function cmdStatus(wsName: string, org: string): void {
  const { workspaceRoot } = getPaths(org);

  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: 工作空间 ${wsName} 不存在`);
    process.exit(1);
  }

  console.log(`=== 工作空间: ${wsName} ===`);

  const repos = parseRepos(path.join(wsDir, "config.json"));
  for (const r of repos) {
    const wtPath = r.worktree_path || (r as any).path || "";
    const wtName = worktreeDirName(r.group, r.name);

    if (!fs.existsSync(wtPath)) {
      console.log(`  ${wtName} — worktree 路径不可达`);
      continue;
    }

    let branch = runGit(wtPath, ["branch", "--show-current"]).stdout;
    if (!branch) {
      branch = runGit(wtPath, ["rev-parse", "--short", "HEAD"]).stdout;
      if (branch) {
        branch = `DETACHED ${branch}`;
      } else {
        branch = "unknown";
      }
    }

    const statusOut = runGit(wtPath, ["status", "--short"]).stdout;
    const changes = statusOut ? statusOut.split("\n").length : 0;

    const logOut = runGit(wtPath, ["log", "--oneline", "@{upstream}..HEAD"]).stdout;
    const ahead = logOut ? logOut.split("\n").length : 0;

    let lastCommit = runGit(wtPath, ["log", "-1", "--format=%h %s"]).stdout;
    if (!lastCommit) {
      lastCommit = "none";
    }

    console.log(`  ${wtName}`);
    console.log(`    分支: ${branch} | 变更: ${changes} 个文件 | ahead: ${ahead} commits`);
    console.log(`    最近: ${lastCommit}`);
  }

  console.log();
}

function cmdBranch(wsName: string, branchName: string, org: string, serverUrl?: string): void {
  const { workspaceRoot } = getPaths(org);

  if (!branchName) {
    console.error("ERROR: 需要指定分支名称");
    process.exit(1);
  }

  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: 工作空间 ${wsName} 不存在`);
    process.exit(1);
  }

  console.log(`=== 为工作空间 ${wsName} 在 worktree 上创建分支 ${branchName} ===`);

  const repos = parseRepos(path.join(wsDir, "config.json"));
  for (const r of repos) {
    const wtPath = r.worktree_path || (r as any).path || "";
    const wtName = worktreeDirName(r.group, r.name);

    if (!fs.existsSync(wtPath)) {
      console.log(`  ${wtName} — worktree 路径不可达，跳过`);
      continue;
    }

    const { stdout: current, ok: currentOk } = runGit(wtPath, ["branch", "--show-current"]);
    if (!currentOk) {
      console.log(`  ${wtName} — git 操作失败，跳过`);
      continue;
    }

    if (current === branchName) {
      console.log(`  ${wtName} — 已在分支 ${branchName}`);
      continue;
    }

    const { ok: showOk } = runGit(wtPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ]);

    if (showOk) {
      const { ok: checkoutOk } = runGit(wtPath, ["checkout", branchName]);
      if (checkoutOk) {
        console.log(`  ${wtName} — 切换到已有分支 ${branchName}`);
      } else {
        console.log(`  ${wtName} — 切换失败`);
      }
    } else {
      const { ok: checkoutOk } = runGit(wtPath, ["checkout", "-b", branchName]);
      if (checkoutOk) {
        console.log(`  ${wtName} — 创建新分支 ${branchName}`);
      } else {
        console.log(`  ${wtName} — 创建分支失败`);
      }
    }
  }

  const configFile = path.join(wsDir, "config.json");
  const data: ConfigData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const updatedData: ConfigData = { ...data, branch: branchName };
  fs.writeFileSync(
    configFile,
    JSON.stringify(updatedData, null, 2),
    "utf-8"
  );

  const reposList = updatedData.repos;
  writeClaudeMd(wsDir, wsName, reposList);

  console.log();
  console.log("✅ 分支操作完成 (仅在 worktree 上，不影响主仓库)");

  if (serverUrl) {
    syncToServer(serverUrl, "POST", "/api/workspaces/sync", {
      name: wsName,
      org,
      path: wsDir,
      repos: reposList,
      branch: branchName,
    });
  }
}

function cmdList(org: string): void {
  const { workspaceRoot } = getPaths(org);

  if (!fs.existsSync(workspaceRoot)) {
    console.log("无工作空间");
    return;
  }

  console.log(`=== 所有工作空间 (org: ${org}) ===`);

  const entries = fs.readdirSync(workspaceRoot).sort();
  for (const wsName of entries) {
    const wsDir = path.join(workspaceRoot, wsName);
    const configFile = path.join(wsDir, "config.json");
    if (!fs.existsSync(configFile)) {
      continue;
    }
    try {
      const data: ConfigData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      const repos = data.repos || [];
      const created = data.created || "unknown";
      const branch = data.branch || "";
      const repoCount = repos.length;
      const wtNames = repos.map((r) => worktreeDirName(r.group, r.name));
      const branchSuffix = branch ? ` [${branch}]` : "";
      console.log(`  ${wsName} — ${repoCount} 个项目${branchSuffix} — 创建于 ${created}`);
      for (const wn of wtNames) {
        console.log(`    - ${wn}`);
      }
    } catch {
      console.log(`  ${wsName} — 配置解析失败`);
    }
  }
}

function cmdDiff(wsName: string, org: string): void {
  const { workspaceRoot } = getPaths(org);

  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: 工作空间 ${wsName} 不存在`);
    process.exit(1);
  }

  console.log(`=== 工作空间 ${wsName} — 变更摘要 ===`);

  const repos = parseRepos(path.join(wsDir, "config.json"));
  for (const r of repos) {
    const wtPath = r.worktree_path || (r as any).path || "";
    const wtName = worktreeDirName(r.group, r.name);

    if (!fs.existsSync(wtPath)) {
      continue;
    }

    const statusOut = runGit(wtPath, ["status", "--short"]).stdout;
    if (!statusOut) {
      console.log(`  ${wtName} — 无变更`);
    } else {
      const fileLines = statusOut.split("\n");
      console.log(`  ${wtName}:`);
      for (const fl of fileLines.slice(0, 20)) {
        console.log(`    ${fl}`);
      }
      if (fileLines.length > 20) {
        console.log(`    ... (共 ${fileLines.length} 个文件变更)`);
      }
    }
    console.log();
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

function main(): void {
  const { org, remaining } = parseOrgArg();
  const serverUrl = parseServerUrl();
  const branchName = parseBranchName();

  if (remaining.length === 0) {
    console.log(DOC);
    return;
  }

  const command = remaining[0];

  if (command === "init") {
    const wsName = remaining[1] || "";
    const repos = remaining.slice(2);
    cmdInit(wsName, repos, org, serverUrl, branchName);
  } else if (command === "add") {
    const wsName = remaining[1] || "";
    const repo = remaining[2] || "";
    cmdAdd(wsName, repo, org, serverUrl);
  } else if (command === "remove") {
    const wsName = remaining[1] || "";
    const repo = remaining[2] || "";
    cmdRemove(wsName, repo, org, serverUrl);
  } else if (command === "destroy") {
    const wsName = remaining[1] || "";
    cmdDestroy(wsName, org, serverUrl);
  } else if (command === "status") {
    const wsName = remaining[1] || "";
    cmdStatus(wsName, org);
  } else if (command === "branch") {
    const wsName = remaining[1] || "";
    const branchName = remaining[2] || "";
    cmdBranch(wsName, branchName, org, serverUrl);
  } else if (command === "list") {
    cmdList(org);
  } else if (command === "diff") {
    const wsName = remaining[1] || "";
    cmdDiff(wsName, org);
  } else {
    console.log(DOC);
  }
}

main();