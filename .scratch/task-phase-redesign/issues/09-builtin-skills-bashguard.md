# 09 — 内置 matt 技能族 seed + Bash 写锁补齐 + context.md 领域指引

## What to build
① matt 技能族（matt-verified-requirement/spec/tickets/domain-modeling/grilling 等）纳入 `~/.octopus/agent/built-in/task-author/skills/` 安装流程（clone-init seed 列表）；② `buildPathGuard` 扩到 Bash：重定向/写命令目标路径检查（白名单=task home 与 /tmp），拦 `>`/`>>`/`tee`/`sed -i` 类外写；③ `context.md` 注入 per-project 绝对路径 + 惯例 probe 指引（CONTEXT-MAP/CONTEXT.md/docs/adr/.scratch/index.md，缺则标注降级）。

## Blocked by
None — can start immediately.

## Status
done

## Exploration

**Analog studied**:
- ① seed 机制 = `init-service.ts` `copyBuiltinSkills()` + `findCorePackSkillsDir()`（从仓库内资源目录 copy-if-missing 进 `~/.octopus/agent/skills/`，源缺失→非致命跳过）与 `clone-init-service.ts` 的 `name === 'task-author'` workflow-presets 特例段。二者结合：在 `clone-init-service.initSingleClone` 的 task-author 段新增 **matt 技能族目录 seed**——源 = 仓库根 `.claude/skills/`（matt-verified-requirement/spec/tickets、domain-modeling、grilling、wayfinder，均含 SKILL.md + 附属文件），发现路径走 `__dirname` 多级候选 + `process.cwd()` 候选（同 findCorePackSkillsDir 模式），目标 `built-in/task-author/skills/<name>/`，skip-if-exists（persona.md 先例），源缺失静默跳过（打包安装无仓库 .claude 时不炸）。不新增目录约定、不动 core-pack。
- ② `buildPathGuard`（`clone-runtime.ts:708`，未导出→需导出供测试）现只拦 Write/Edit/NotebookEdit；票 06 实证缺口就是 Bash 不在名单。方案：`toolName === 'Bash'` 时解析 `input.command`，按段（`; && || |` 切分 + 引号感知）提取写目标：重定向 `>`/`>>`/`N>`/`&>`/`&>>`（含引号目标、`$`/反引号不可解析目标=保守拦）、`tee`、`sed -i`/`--in-place`、`dd of=`、`cp`/`mv` 末参、`git --git-dir/--work-tree` 值。白名单 = task home + `/tmp`（含 macOS `/private/tmp`）+ `/dev/null|stdout|stderr|fd/*`；相对路径按 cwd=task home 解析（票 06 §1 实证 task-author 会话 cwd 恒为 home）。已知残余：`cd 外部 && 相对写`、解释器内嵌写（python -c open()）——hook 为纵深防御层，rules 仍 advisory。
- ③ context.md = `task-home-service.writeContextFile`（动态态归 context.md、rules 保持静态——prompt-cache 设计）。AC3 措辞=「路径行 + 惯例 probe **结果**」→ server 在写 context.md 时对每个已解析 project 路径 fs.existsSync probe 四件套（CONTEXT-MAP.md / CONTEXT.md / docs/adr / .scratch/index.md），渲染 ✓/— 行 + 「无领域文档 project 降级」标注（US2）+ 简短 probe 指引（agent 直接 Read 这些绝对路径——票 06 §2 读全放行）。probe 措辞放 **context.md**（动态、每次 state 变更重写），不放 rules 文件（静态约束，现有测试锁 rules 无 project 内联态）。

**Files to modify**: `clone-init-service.ts`（seed）、`clone-runtime.ts`（导出 + Bash 分支）、`task-home-service.ts`（writeContextFile probe）+ 测试 `path-guard.test.ts`（新建）、`clone-init-service.test.ts`、`task-home-service.test.ts`。

**Seeded skill list**: matt-verified-requirement · matt-verified-spec · matt-verified-tickets · domain-modeling · grilling · wayfinder（票面五名 + decisions/06 §5 使用协议点名的 wayfinder）。

## Acceptance Criteria
- [x] AC1: 新建 coding 任务的 task-author 会话 plugins 含 built-in/task-author/skills（断言加载列表）
- [x] AC2: `echo x > <home外路径>` 在草稿会话被 hook 拦截，`> /tmp/...` 与 home 内放行（参数化测试 ≥6 例含绕过变体）
- [x] AC3: context.md 含每个所选 project 的路径行与惯例 probe 结果

## Verification Method
**Verification type**: unit test（guard 参数化）+ integration（seed/context）

**Verification steps**:
1. `packages/server/src/services/agent/__tests__/path-guard.test.ts`（Bash 案例表）
2. clone 会话集成断言 plugins 列表 + context.md 内容（tmp org fixture）
3. `pnpm -F @octopus/server test -- path-guard`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
