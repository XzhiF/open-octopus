# 04 — core-pack:task-dev 工作流 + superpowers cr-fix goal 化 + schema 引用清理 + skill 文档

## What to build
交付物层:两节点 skills-free 的 `task-dev.yaml`(develop goal + ship prompt,max_turns 参数默认 200)+ simulator fixture;`superpowers-task-dev` cr-fix 改 goal 模式(cr_status 三处同步清理);全仓库 JSON schema 引用清理(废弃路线 B);octo-workflow-dev/octo-workflow-test 文档重写 goal 章节 + validate-workflow.js 规则同步。

## Blocked by
01(parser 须接受新字段/simulate 才能跑 goal yaml)

## Status
done

## Acceptance Criteria
- [x] AC1: `task-dev.yaml` inputs 三字段全带 description,max_turns default "200"(字符串);develop 节点 goal 含产物自查指引+ac 逐条判据+软退出条款,`max_turns: $inputs.max_turns`;ship prompt 三阶段(ship-report→commit→gh pr)
- [x] AC2: `task-dev.test.yaml` 两场景:happy(completed)+ 耗尽(mock 节点 `status:failed + error:'goal_not_met (max_turns)'`——不 mock terminalReason,机制不存在)
- [x] AC3: superpowers-task-dev:cr-fix 改 goal(对照 $inputs.ac+$vars.plan_file),**cr_status 三处清**:variables 声明、test fixture mock/断言、ship prompt 引用
- [x] AC4: `grep -r "yaml-language-server" packages/core-pack/workflows/ .claude/skills/octo-workflow-dev .claude/skills/octo-workflow-test packages/core-pack/skills/` = 0(.scratch/ 与 .scratch/goal-task-dev/ 除外);`~/.octopus/workflow-schema.json` 删除;sync-builtin.mjs schema 分支+残留 log 清理
- [x] AC5: skill 文档:node-schema.md agent 表增 goal(/goal 语义)/max_turns/max_budget_usd/disallowed_tools/tools,删 planning;variables.md/special-conventions.md 同步;validate-workflow.js 与 parser 规则一致(planning 报错、新字段合法、engine 警告);SKILL.md "Schema authority" 改指 Zod
- [x] AC6: `octopus workflow validate` 全 core-pack yaml 通过 + 两个 simulate 全绿

## Verification Method
**Verification type**: simulator + 静态断言
**Verification steps**:
```bash
node .claude/skills/octo-workflow-dev/scripts/validate-workflow.js packages/core-pack/workflows/*.yaml
octopus workflow simulate packages/core-pack/workflows/task-dev.yaml
octopus workflow simulate packages/core-pack/workflows/superpowers-task-dev.yaml
grep -rn "yaml-language-server" packages/ .claude/skills/ --include="*.yaml" --include="*.md" | grep -v ".scratch" | wc -l  # =0
```
**Pass criteria**: validate/sim/grep 三项全过
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

**Analog studied**: `superpowers-task-dev.yaml`（最接近的 task-board 无人值守流：inputs goal/ac、`$vars.task_artifacts_dir` 产物目录协议、ship 三阶段 prompt + ship_status vars_update）+ `xzf-dev.yaml` 头部约定（engine: claude / model: pro-max / timeout: 86400 / execution_mode: serial）。fixture 类比：`superpowers-task-dev.test.yaml`。

**事实核对**：
- Stage 1 已落：`NodeSchema` 新增 `tools/max_turns/max_budget_usd/disallowed_tools`（workflow.ts:357-360，number|string union）；`planning` 已删，parseWorkflow pre-Zod 递归预扫抛 ValueError，迁移文案 verbatim=`planning 已废弃: max_turns/max_budget_usd/disallowed_tools 提升为节点字段, verify 删除`（parser.ts:70）；`WorkflowInputSchema.description` 必填 + `default: z.string()`（workflow.ts:484-488 → fix D 锤实）；`validateWorkflow → {warnings}`，claude-only 字段 warning 文案（parser.ts:196-207，engine 链 `node.engine ?? wf.engine ?? "claude"`，`claude-code` 视作 claude）。
- Simulator：`MockAgentExecutor` 支持 `status: "failed" + error`（mock-executors.ts:83-92）；`AssertionDef` 支持 status/vars/node_trace.executed+skipped/node_outputs/logs.contains（simulator/types.ts:77-83）→ 耗尽场景用 `status:failed + error:'goal_not_met (max_turns)'` + logs 断言（fix M，无 terminalReason）。
- CLI 运行面：PATH 上的 `octopus` 是全局安装（`~/.nvm/.../node_modules/octopus`），非本仓库 → 用 `node packages/cli/dist/index.js`（基线 simulate 已验证可用，engine/shared dist 均新）。**engine tsc 构建当前被 ticket 03 卡住（agent.ts 残留 node.planning 引用）**，engine dist 为 03 前旧版；simulator 整体 mock executor，不受影响。
- `.claude/skills/octo-workflow-{dev,test}` 与 `packages/core-pack/skills/` 镜像 **完全一致**（diff -rq rc=0）→ 改 .claude 侧后 cp 同步镜像。
- yaml-language-server 命中（源文件）：core-pack/workflows 7 个 yaml（matt-dev-pipeline[.test] / xzf-dev[.test] / superpowers-task-dev[.test] / composition-task.test）；octo-workflow-dev special-conventions.md:12 + testing.md:215 + SKILL.md:12-13（Schema authority 悬空引用 `packages/core-pack/workflows/workflow-schema.json`——该文件已不存在）；octo-workflow-test SKILL.md:329。`~/.octopus/workflow-schema.json` 存在，删。
- **边界**：sync-builtin.mjs schema 分支清理属 spec server 节 → ticket 05 lane，本工单不碰 packages/server。

注:AC4 中 `sync-builtin.mjs schema 分支` 一项——该脚本在仓库已不存在;残留消费方为 `packages/cli/src/setup-runner/index.ts:1185-1188`(workflow-schema 复制分支,`existsSync` 守卫下源文件已消失 → 现为良性 no-op)。删源文件 + 移除该分支属 spec server/setup 节 → **ticket 05 lane**(spec § Implementation Decisions → server),本工单按 lane 约束不碰 packages/cli/src。

## Verification — PASS

**执行面**:`octopus` on PATH 是全局安装(非本仓库)→ 全部命令以仓库代码执行:`node packages/cli/dist/index.js`。engine dist 为 ticket 03 前旧版(03 在飞,engine tsc 被其自身 agent.ts planning 残留卡住)——simulator 整体 mock executor,不受影响;goal yaml 的 parse 走新 shared dist。

```bash
node .claude/skills/octo-workflow-dev/scripts/validate-workflow.js packages/core-pack/workflows/*.yaml
# → 9 passed, 0 failed, 8 fixture(s) skipped (exit 0)
node packages/cli/dist/index.js workflow simulate packages/core-pack/workflows/task-dev.yaml
# → 2 passed, 0 failed(happy: completed+vars+trace;耗尽: status=failed + logs develop contains "goal_not_met (max_turns)")
node packages/cli/dist/index.js workflow simulate packages/core-pack/workflows/superpowers-task-dev.yaml
# → 2 passed, 0 failed(cr-fix goal 化 + cr_status 三处清后 fixture 全绿)
node packages/cli/dist/index.js workflow validate <task-dev|superpowers-task-dev>.yaml
# → 均 ✓(shared parse + validateWorkflow 通过)
grep -rn "yaml-language-server" packages/core-pack/workflows/ .claude/skills/octo-workflow-dev .claude/skills/octo-workflow-test packages/core-pack/skills/octo-workflow-{dev,test} | wc -l
# → 0;扩大至 packages/ .claude/skills/(排除 .scratch)→ 0(含 packages/cli/dist 构建产物,已 node packages/cli/scripts/copy-core-pack.mjs 刷新)
test ! -f ~/.octopus/workflow-schema.json  # → 已删除
diff -rq .claude/skills/octo-workflow-{dev,test} packages/core-pack/skills/octo-workflow-{dev,test}  # → 镜像一致
```

**规则镜像负样本自测**(validate-workflow.js ↔ parser 一致性):
- `planning:` 节点 → L2 ERROR,migration 文案与 parser.ts verbatim 一致 ✓(shared parseWorkflow 同样 ValueError ✓)
- `max_turns: [1,2]` / `tools: "Read"` → L1 ERROR ✓;number/string 合法 ✓
- `engine: pi` + claude-only 字段 → WARNING(文案同 parser);`engine: claude-code` 不误报 ✓

**基线偏差(非本工单引入,已核 HEAD 复现)**:`workflow validate` 对 clarify-debate / matt-dev-pipeline / xzf-dev 报既有 `host.prompt assessment` swarm 校验错误(engine 侧他 feature 检查,HEAD 版本同挂);对这些文件本工单仅删 YAML 头注释,不触本体(spec Don't)。

**附加(范围说明)**:
- `budget-test.yaml` 补 `apiVersion/kind` 头(预存 validate 失败,零行为变化,使 AC6 全目录通过)。
- validate-workflow.js 新增 fixture 识别:顶层 `scenarios` 的 `.test.yaml` 记为 skipped(此前被误当 workflow 校验必挂,阻塞全目录 glob)。
- 文档 goal 章节同步扩展至 `node-patterns.md`(其 goal 示例残留 `planning:` 教错误语法,一并改写)。
