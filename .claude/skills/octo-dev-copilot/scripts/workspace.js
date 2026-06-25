#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// skills/octo-dev-copilot/scripts/workspace.ts
var import_child_process = require("child_process");
var http = __toESM(require("http"));
var https = __toESM(require("https"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var os = __toESM(require("os"));
var DOC = `workspace.ts \u2014 octopus \u591A\u4ED3\u5E93\u5DE5\u4F5C\u7A7A\u95F4\u7BA1\u7406\u811A\u672C (git worktree \u7248)

\u7528\u6CD5:
  node workspace.js init <ws-name> <repo1> <repo2> ... --org <org>
  node workspace.js add <ws-name> <repo> --org <org>
  node workspace.js remove <ws-name> <repo> --org <org>
  node workspace.js destroy <ws-name> --org <org>
  node workspace.js status <ws-name> --org <org>
  node workspace.js branch <ws-name> <branch-name> --org <org>
  node workspace.js list --org <org>
  node workspace.js diff <ws-name> --org <org>

--org \u53C2\u6570\u53EF\u901A\u8FC7\u4EE5\u4E0B\u65B9\u5F0F\u6307\u5B9A:
  1. \u547D\u4EE4\u884C --org <org> \u53C2\u6570
  2. OCTOPUS_ORG \u73AF\u5883\u53D8\u91CF
  3. ~/.octopus/config.json \u4E2D default_org \u5B57\u6BB5`;
function getPaths(org) {
  const base = path.join(os.homedir(), ".octopus", org);
  return {
    workspaceRoot: path.join(base, "workspaces"),
    reposIndex: path.join(base, "repos", "index.md")
  };
}
function parseOrgArg() {
  let org = null;
  const remaining = [];
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
      i += 2;
    } else if (argv[i].startsWith("--server-url=")) {
      i += 1;
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
      }
    }
  }
  if (org === null) {
    console.error("ERROR: \u9700\u8981\u6307\u5B9A org (--org \u53C2\u6570, OCTOPUS_ORG \u73AF\u5883\u53D8\u91CF, \u6216 ~/.octopus/config.json default_org)");
    process.exit(1);
  }
  return { org, remaining };
}
function parseServerUrl() {
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
  return void 0;
}
function parseBranchName() {
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
  return void 0;
}
function syncToServer(serverUrl, method, apiPath, body) {
  const url = `${serverUrl}${apiPath}`;
  const postData = body ? JSON.stringify(body) : void 0;
  const isHttps = url.startsWith("https");
  const requestModule = isHttps ? https : http;
  const options = {
    method,
    headers: { "Content-Type": "application/json" }
  };
  const req = requestModule.request(url, options, (res) => {
    let data = "";
    res.on("data", (chunk) => data += chunk);
    res.on("end", () => {
      if (res.statusCode >= 400) {
        console.error(`  \u26A0 Server sync failed: ${res.statusCode} ${data}`);
      } else {
        console.log(`  \u2713 Synced to server`);
      }
    });
  });
  req.on("error", (e) => console.error(`  \u26A0 Server sync error: ${e.message}`));
  if (postData) req.write(postData);
  req.end();
}
function runGit(repoPath, args) {
  try {
    const stdout = (0, import_child_process.execFileSync)("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 3e4,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { stdout: stdout.trim(), ok: true };
  } catch (e) {
    return { stdout: (e.stdout || "").toString().trim(), ok: false };
  }
}
function runGitCapture(repoPath, args) {
  try {
    const result = (0, import_child_process.execFileSync)("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 6e4,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { stdout: result.trim(), stderr: "", ok: true };
  } catch (e) {
    return {
      stdout: (e.stdout || "").toString().trim(),
      stderr: (e.stderr || "").toString().trim(),
      ok: false
    };
  }
}
function getRepoInfo(repoName, reposIndex) {
  if (!fs.existsSync(reposIndex)) {
    return null;
  }
  let targetGroup = null;
  let name = repoName;
  if (repoName.includes("/")) {
    const parts = repoName.split("/");
    targetGroup = parts[0];
    name = parts[1];
  }
  const content = fs.readFileSync(reposIndex, "utf-8");
  const lines = content.split("\n");
  const allMatches = [];
  let currentGroupName = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      const groupFull = line.slice(3).trim();
      currentGroupName = groupFull.includes("(") ? groupFull.split("(")[0].trim() : groupFull;
    } else if (line.startsWith("### ")) {
      const repoNameInLine = line.slice(4).trim();
      let matched = false;
      if (targetGroup !== null) {
        matched = currentGroupName === targetGroup && repoNameInLine === name;
      } else {
        matched = repoNameInLine === name;
      }
      if (matched && currentGroupName) {
        let localPath = null;
        let gitUrl = null;
        let defaultBranch = null;
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const subLine = lines[j];
          if (subLine.startsWith("- local:")) {
            let pathStr = subLine.slice(8).trim();
            pathStr = pathStr.replace(" \u2713 cloned", "").replace(" \u2014 not cloned", "").replace(" ? cloned", "");
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
        const entry = {
          group: currentGroupName,
          name: repoNameInLine,
          main_path: localPath,
          git_url: gitUrl,
          default_branch: defaultBranch
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
function parseRepos(configFile) {
  if (!fs.existsSync(configFile)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    return data.repos || [];
  } catch {
    return [];
  }
}
function worktreeDirName(group, name) {
  return `${group}-${name}`;
}
function createWorktree(mainPath, worktreePath) {
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
  try {
    (0, import_child_process.execFileSync)("git", ["worktree", "prune"], { cwd: mainPath, encoding: "utf-8", timeout: 1e4, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
  }
  const { stdout, stderr, ok } = runGitCapture(mainPath, [
    "worktree",
    "add",
    "-f",
    worktreePath,
    "--detach"
  ]);
  if (ok) {
    return { result: worktreePath, error: null };
  }
  return { result: null, error: stderr || stdout || "git worktree add failed" };
}
function removeWorktree(mainPath, worktreePath) {
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
    "--force"
  ]);
  if (ok) {
    return { ok: true, error: null };
  }
  return { ok: false, error: stderr || stdout || "git worktree remove failed" };
}
function initCodeDevCopilotRules(wsDir, org) {
  const rulesDir = path.join(wsDir, ".octopus", "code-dev-copilot-rules");
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
  const sources = [
    // 1. Project-level: current project's .octopus/code-dev-copilot-rules/
    path.join(process.cwd(), ".octopus", "code-dev-copilot-rules"),
    // 2. Org-level: ~/.octopus/{org}/code-dev-copilot-rules/
    path.join(os.homedir(), ".octopus", org, "code-dev-copilot-rules")
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
            console.log(`  \u{1F4CB} \u5DF2\u590D\u5236\u89C4\u5219: ${file}`);
          }
        }
      }
    } catch {
    }
  }
}
function copySkills(wsDir) {
  const corePackDir = findCorePackSkillsRoot();
  if (!corePackDir) return;
  const skillsDir = path.join(wsDir, ".claude", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  const coreSkills = ["octo-dev-copilot", "octo-workflow-dev", "octo-swarm-dev"];
  for (const skillName of coreSkills) {
    const dest = path.join(skillsDir, skillName);
    if (fs.existsSync(dest)) continue;
    const src = path.join(corePackDir, skillName);
    if (fs.existsSync(path.join(src, "SKILL.md"))) {
      fs.cpSync(src, dest, { recursive: true });
      console.log(`  \u{1F4CB} \u5DF2\u590D\u5236\u6280\u80FD: ${skillName}`);
    }
  }
}
function findCorePackSkillsRoot() {
  const candidates = [
    path.join(process.cwd(), "..", "core-pack", "skills"),
    path.join(process.cwd(), "packages", "core-pack", "skills")
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
function writeClaudeMd(wsDir, wsName, repos) {
  const claudeMdPath = path.join(wsDir, "CLAUDE.md");
  const lines = [
    `# \u5DE5\u4F5C\u7A7A\u95F4: ${wsName}`,
    "",
    "## \u6D89\u53CA\u9879\u76EE (git worktree)",
    "",
    "\u5404\u9879\u76EE\u901A\u8FC7 git worktree \u94FE\u63A5\u5230\u4E3B\u4ED3\u5E93\uFF0C\u5728\u6B64\u76EE\u5F55\u5185\u7F16\u7801\uFF0C\u4E0D\u5F71\u54CD\u4E3B\u4ED3\u5E93\u5206\u652F\u3002",
    ""
  ];
  for (const r of repos) {
    const wtName = worktreeDirName(r.group, r.name);
    lines.push(`- **${wtName}**: \`${r.worktree_path}\``);
    lines.push(`  - \u4E3B\u4ED3\u5E93: \`${r.main_path}\``);
  }
  lines.push(
    "",
    "## \u8BF4\u660E",
    "- \u4FEE\u6539\u4EE3\u7801\u65F6\u76F4\u63A5\u64CD\u4F5C\u5404 worktree \u76EE\u5F55",
    "- \u4E3B\u4ED3\u5E93\u4FDD\u6301\u5E72\u51C0\uFF0C\u5F00\u53D1\u5206\u652F\u4EC5\u5728 worktree \u4E2D",
    "- \u4F7F\u7528 `branch` \u547D\u4EE4\u5728 worktree \u4E0A\u521B\u5EFA\u5F00\u53D1\u5206\u652F",
    "- \u4F7F\u7528 `destroy` \u547D\u4EE4\u6E05\u7406\u6574\u4E2A\u5DE5\u4F5C\u7A7A\u95F4"
  );
  let branchInfo = "";
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(wsDir, "config.json"), "utf-8")
    );
    branchInfo = data.branch || "";
  } catch {
  }
  if (branchInfo) {
    lines.push("", `## \u5F00\u53D1\u5206\u652F: ${branchInfo}`);
  }
  fs.writeFileSync(claudeMdPath, lines.join("\n"), "utf-8");
}
function cmdInit(wsName, repos, org, serverUrl, overrideBranch) {
  const { workspaceRoot, reposIndex } = getPaths(org);
  if (!wsName) {
    console.error("ERROR: \u9700\u8981\u6307\u5B9A\u5DE5\u4F5C\u7A7A\u95F4\u540D\u79F0");
    process.exit(1);
  }
  if (repos.length === 0) {
    console.error("ERROR: \u9700\u8981\u6307\u5B9A\u81F3\u5C11\u4E00\u4E2A repo");
    process.exit(1);
  }
  const branchName = overrideBranch || wsName;
  const wsDir = path.join(workspaceRoot, wsName);
  const configFile = path.join(wsDir, "config.json");
  const dirExisted = fs.existsSync(wsDir);
  if (dirExisted) {
    if (fs.existsSync(configFile)) {
      console.error(`ERROR: \u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u5DF2\u521D\u59CB\u5316: ${wsDir}`);
      console.error("\u5982\u9700\u91CD\u5EFA\uFF0C\u5148 destroy \u65E7\u5DE5\u4F5C\u7A7A\u95F4");
      process.exit(1);
    }
    console.log(`  \u76EE\u5F55 ${wsDir} \u5DF2\u5B58\u5728\uFF0C\u7EE7\u7EED\u521D\u59CB\u5316...`);
  } else {
    fs.mkdirSync(wsDir, { recursive: true });
  }
  const entries = [];
  for (const repo of repos) {
    const info = getRepoInfo(repo, reposIndex);
    if (info === null) {
      console.log(`WARN: repo ${repo} \u672A\u5728 index.md \u4E2D\u627E\u5230\uFF0C\u8DF3\u8FC7`);
      continue;
    }
    if (info.main_path === null || !fs.existsSync(info.main_path)) {
      console.log(`WARN: repo ${info.group}/${info.name} \u672C\u5730\u8DEF\u5F84\u4E0D\u53EF\u8FBE\uFF0C\u8DF3\u8FC7`);
      continue;
    }
    const wtName = worktreeDirName(info.group, info.name);
    const wtPath = path.join(wsDir, "projects", wtName);
    const { result, error } = createWorktree(info.main_path, wtPath);
    if (result === null) {
      console.log(`WARN: repo ${info.group}/${info.name} worktree \u521B\u5EFA\u5931\u8D25: ${error}`);
      continue;
    }
    entries.push({
      name: info.name,
      group: info.group,
      main_path: info.main_path,
      worktree_path: wtPath
    });
    try {
      (0, import_child_process.execFileSync)("git", ["checkout", "-b", branchName], { cwd: wtPath, encoding: "utf-8", timeout: 3e4, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      try {
        (0, import_child_process.execFileSync)("git", ["checkout", branchName], { cwd: wtPath, encoding: "utf-8", timeout: 3e4, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
      }
    }
    console.log(`  \u2705 ${wtName} \u2192 ${wtPath} [${branchName}]`);
  }
  if (entries.length === 0) {
    console.error("ERROR: \u6CA1\u6709\u6210\u529F\u521B\u5EFA\u4EFB\u4F55 worktree\uFF0C\u65E0\u6CD5\u5B8C\u6210\u521D\u59CB\u5316");
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
  const configData = {
    name: wsName,
    repos: entries,
    created: (/* @__PURE__ */ new Date()).toISOString(),
    init_branch_name: branchName
  };
  fs.writeFileSync(
    configFile,
    JSON.stringify(configData, null, 2),
    "utf-8"
  );
  writeClaudeMd(wsDir, wsName, entries);
  copySkills(wsDir);
  initCodeDevCopilotRules(wsDir, org);
  console.log(`
\u2705 \u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u521D\u59CB\u5316\u5B8C\u6210`);
  console.log(`   \u76EE\u5F55: ${wsDir}`);
  console.log(`   \u9879\u76EE\u6570: ${entries.length}`);
  console.log(`   \u5206\u652F: ${branchName}`);
  if (serverUrl) {
    syncToServer(serverUrl, "POST", "/api/workspaces/sync", {
      name: wsName,
      org,
      path: wsDir,
      repos: entries,
      branch: branchName
    });
  }
}
function cmdAdd(wsName, repo, org, serverUrl) {
  const { workspaceRoot, reposIndex } = getPaths(org);
  if (!wsName || !repo) {
    console.error("ERROR: \u9700\u8981\u6307\u5B9A\u5DE5\u4F5C\u7A7A\u95F4\u540D\u79F0\u548C repo");
    process.exit(1);
  }
  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: \u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u4E0D\u5B58\u5728`);
    process.exit(1);
  }
  const configFile = path.join(wsDir, "config.json");
  const data = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const existingRepos = data.repos;
  const existingNames = existingRepos.map((r) => r.name);
  const info = getRepoInfo(repo, reposIndex);
  if (info === null) {
    console.error(`ERROR: repo ${repo} \u672A\u5728 index.md \u4E2D\u627E\u5230`);
    process.exit(1);
  }
  if (existingNames.includes(info.name)) {
    console.error(`ERROR: repo ${info.group}/${info.name} \u5DF2\u5728\u5DE5\u4F5C\u7A7A\u95F4\u4E2D`);
    process.exit(1);
  }
  if (info.main_path === null || !fs.existsSync(info.main_path)) {
    console.error(`ERROR: repo ${info.group}/${info.name} \u672C\u5730\u8DEF\u5F84\u4E0D\u53EF\u8FBE`);
    process.exit(1);
  }
  const wtName = worktreeDirName(info.group, info.name);
  const wtPath = path.join(wsDir, "projects", wtName);
  const { result, error } = createWorktree(info.main_path, wtPath);
  if (result === null) {
    console.error(`ERROR: worktree \u521B\u5EFA\u5931\u8D25: ${error}`);
    process.exit(1);
  }
  const newEntry = {
    name: info.name,
    group: info.group,
    main_path: info.main_path,
    worktree_path: wtPath
  };
  const updatedRepos = [...existingRepos, newEntry];
  const updatedData = { ...data, repos: updatedRepos };
  fs.writeFileSync(
    configFile,
    JSON.stringify(updatedData, null, 2),
    "utf-8"
  );
  writeClaudeMd(wsDir, wsName, updatedRepos);
  console.log(`\u2705 \u5DF2\u6DFB\u52A0 ${wtName} \u5230\u5DE5\u4F5C\u7A7A\u95F4 ${wsName}`);
  console.log(`   worktree: ${wtPath}`);
  if (serverUrl) {
    syncToServer(serverUrl, "POST", "/api/workspaces/sync", {
      name: wsName,
      org,
      path: wsDir,
      repos: updatedRepos
    });
  }
}
function cmdRemove(wsName, repo, org, serverUrl) {
  const { workspaceRoot } = getPaths(org);
  if (!wsName || !repo) {
    console.error("ERROR: \u9700\u8981\u6307\u5B9A\u5DE5\u4F5C\u7A7A\u95F4\u540D\u79F0\u548C repo");
    process.exit(1);
  }
  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: \u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u4E0D\u5B58\u5728`);
    process.exit(1);
  }
  const configFile = path.join(wsDir, "config.json");
  const data = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const existingRepos = data.repos;
  const target = existingRepos.find(
    (r) => r.name === repo || `${r.group}/${r.name}` === repo
  );
  if (target === void 0) {
    console.error(`ERROR: repo ${repo} \u4E0D\u5728\u5DE5\u4F5C\u7A7A\u95F4\u4E2D`);
    process.exit(1);
  }
  const wtName = worktreeDirName(target.group, target.name);
  const { ok, error } = removeWorktree(target.main_path, target.worktree_path);
  if (!ok) {
    console.error(`ERROR: worktree \u79FB\u9664\u5931\u8D25: ${error}`);
    process.exit(1);
  }
  const updatedRepos = existingRepos.filter((r) => r !== target);
  const updatedData = { ...data, repos: updatedRepos };
  fs.writeFileSync(
    configFile,
    JSON.stringify(updatedData, null, 2),
    "utf-8"
  );
  writeClaudeMd(wsDir, wsName, updatedRepos);
  console.log(`\u2705 \u5DF2\u79FB\u9664 ${wtName} \u4ECE\u5DE5\u4F5C\u7A7A\u95F4 ${wsName}`);
  if (serverUrl) {
    syncToServer(serverUrl, "POST", "/api/workspaces/sync", {
      name: wsName,
      org,
      path: wsDir,
      repos: updatedRepos
    });
  }
}
function cmdDestroy(wsName, org, serverUrl) {
  const { workspaceRoot } = getPaths(org);
  if (!wsName) {
    console.error("ERROR: \u9700\u8981\u6307\u5B9A\u5DE5\u4F5C\u7A7A\u95F4\u540D\u79F0");
    process.exit(1);
  }
  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: \u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u4E0D\u5B58\u5728`);
    process.exit(1);
  }
  const configFile = path.join(wsDir, "config.json");
  if (!fs.existsSync(configFile)) {
    fs.rmSync(wsDir, { recursive: true, force: true });
    console.log(`\u2705 \u5DF2\u5220\u9664\u5DE5\u4F5C\u7A7A\u95F4\u76EE\u5F55 ${wsDir}`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const repos = data.repos || [];
  for (const r of repos) {
    const wtName = worktreeDirName(r.group, r.name);
    const { ok, error } = removeWorktree(r.main_path, r.worktree_path);
    if (ok) {
      console.log(`  \u2705 \u5DF2\u79FB\u9664 worktree: ${wtName}`);
    } else {
      console.log(`  \u26A0 worktree \u79FB\u9664\u5931\u8D25: ${wtName} \u2014 ${error}`);
    }
  }
  fs.rmSync(wsDir, { recursive: true, force: true });
  console.log(`
\u2705 \u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u5DF2\u9500\u6BC1`);
  if (serverUrl) {
    syncToServer(serverUrl, "DELETE", `/api/workspaces/${wsName}`);
  }
}
function cmdStatus(wsName, org) {
  const { workspaceRoot } = getPaths(org);
  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: \u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u4E0D\u5B58\u5728`);
    process.exit(1);
  }
  console.log(`=== \u5DE5\u4F5C\u7A7A\u95F4: ${wsName} ===`);
  const repos = parseRepos(path.join(wsDir, "config.json"));
  for (const r of repos) {
    const wtPath = r.worktree_path || r.path || "";
    const wtName = worktreeDirName(r.group, r.name);
    if (!fs.existsSync(wtPath)) {
      console.log(`  ${wtName} \u2014 worktree \u8DEF\u5F84\u4E0D\u53EF\u8FBE`);
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
    console.log(`    \u5206\u652F: ${branch} | \u53D8\u66F4: ${changes} \u4E2A\u6587\u4EF6 | ahead: ${ahead} commits`);
    console.log(`    \u6700\u8FD1: ${lastCommit}`);
  }
  console.log();
}
function cmdBranch(wsName, branchName, org, serverUrl) {
  const { workspaceRoot } = getPaths(org);
  if (!branchName) {
    console.error("ERROR: \u9700\u8981\u6307\u5B9A\u5206\u652F\u540D\u79F0");
    process.exit(1);
  }
  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: \u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u4E0D\u5B58\u5728`);
    process.exit(1);
  }
  console.log(`=== \u4E3A\u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u5728 worktree \u4E0A\u521B\u5EFA\u5206\u652F ${branchName} ===`);
  const repos = parseRepos(path.join(wsDir, "config.json"));
  for (const r of repos) {
    const wtPath = r.worktree_path || r.path || "";
    const wtName = worktreeDirName(r.group, r.name);
    if (!fs.existsSync(wtPath)) {
      console.log(`  ${wtName} \u2014 worktree \u8DEF\u5F84\u4E0D\u53EF\u8FBE\uFF0C\u8DF3\u8FC7`);
      continue;
    }
    const { stdout: current, ok: currentOk } = runGit(wtPath, ["branch", "--show-current"]);
    if (!currentOk) {
      console.log(`  ${wtName} \u2014 git \u64CD\u4F5C\u5931\u8D25\uFF0C\u8DF3\u8FC7`);
      continue;
    }
    if (current === branchName) {
      console.log(`  ${wtName} \u2014 \u5DF2\u5728\u5206\u652F ${branchName}`);
      continue;
    }
    const { ok: showOk } = runGit(wtPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`
    ]);
    if (showOk) {
      const { ok: checkoutOk } = runGit(wtPath, ["checkout", branchName]);
      if (checkoutOk) {
        console.log(`  ${wtName} \u2014 \u5207\u6362\u5230\u5DF2\u6709\u5206\u652F ${branchName}`);
      } else {
        console.log(`  ${wtName} \u2014 \u5207\u6362\u5931\u8D25`);
      }
    } else {
      const { ok: checkoutOk } = runGit(wtPath, ["checkout", "-b", branchName]);
      if (checkoutOk) {
        console.log(`  ${wtName} \u2014 \u521B\u5EFA\u65B0\u5206\u652F ${branchName}`);
      } else {
        console.log(`  ${wtName} \u2014 \u521B\u5EFA\u5206\u652F\u5931\u8D25`);
      }
    }
  }
  const configFile = path.join(wsDir, "config.json");
  const data = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const updatedData = { ...data, branch: branchName };
  fs.writeFileSync(
    configFile,
    JSON.stringify(updatedData, null, 2),
    "utf-8"
  );
  const reposList = updatedData.repos;
  writeClaudeMd(wsDir, wsName, reposList);
  console.log();
  console.log("\u2705 \u5206\u652F\u64CD\u4F5C\u5B8C\u6210 (\u4EC5\u5728 worktree \u4E0A\uFF0C\u4E0D\u5F71\u54CD\u4E3B\u4ED3\u5E93)");
  if (serverUrl) {
    syncToServer(serverUrl, "POST", "/api/workspaces/sync", {
      name: wsName,
      org,
      path: wsDir,
      repos: reposList,
      branch: branchName
    });
  }
}
function cmdList(org) {
  const { workspaceRoot } = getPaths(org);
  if (!fs.existsSync(workspaceRoot)) {
    console.log("\u65E0\u5DE5\u4F5C\u7A7A\u95F4");
    return;
  }
  console.log(`=== \u6240\u6709\u5DE5\u4F5C\u7A7A\u95F4 (org: ${org}) ===`);
  const entries = fs.readdirSync(workspaceRoot).sort();
  for (const wsName of entries) {
    const wsDir = path.join(workspaceRoot, wsName);
    const configFile = path.join(wsDir, "config.json");
    if (!fs.existsSync(configFile)) {
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      const repos = data.repos || [];
      const created = data.created || "unknown";
      const branch = data.branch || "";
      const repoCount = repos.length;
      const wtNames = repos.map((r) => worktreeDirName(r.group, r.name));
      const branchSuffix = branch ? ` [${branch}]` : "";
      console.log(`  ${wsName} \u2014 ${repoCount} \u4E2A\u9879\u76EE${branchSuffix} \u2014 \u521B\u5EFA\u4E8E ${created}`);
      for (const wn of wtNames) {
        console.log(`    - ${wn}`);
      }
    } catch {
      console.log(`  ${wsName} \u2014 \u914D\u7F6E\u89E3\u6790\u5931\u8D25`);
    }
  }
}
function cmdDiff(wsName, org) {
  const { workspaceRoot } = getPaths(org);
  const wsDir = path.join(workspaceRoot, wsName);
  if (!fs.existsSync(wsDir)) {
    console.error(`ERROR: \u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u4E0D\u5B58\u5728`);
    process.exit(1);
  }
  console.log(`=== \u5DE5\u4F5C\u7A7A\u95F4 ${wsName} \u2014 \u53D8\u66F4\u6458\u8981 ===`);
  const repos = parseRepos(path.join(wsDir, "config.json"));
  for (const r of repos) {
    const wtPath = r.worktree_path || r.path || "";
    const wtName = worktreeDirName(r.group, r.name);
    if (!fs.existsSync(wtPath)) {
      continue;
    }
    const statusOut = runGit(wtPath, ["status", "--short"]).stdout;
    if (!statusOut) {
      console.log(`  ${wtName} \u2014 \u65E0\u53D8\u66F4`);
    } else {
      const fileLines = statusOut.split("\n");
      console.log(`  ${wtName}:`);
      for (const fl of fileLines.slice(0, 20)) {
        console.log(`    ${fl}`);
      }
      if (fileLines.length > 20) {
        console.log(`    ... (\u5171 ${fileLines.length} \u4E2A\u6587\u4EF6\u53D8\u66F4)`);
      }
    }
    console.log();
  }
}
function main() {
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
    const branchName2 = remaining[2] || "";
    cmdBranch(wsName, branchName2, org, serverUrl);
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
