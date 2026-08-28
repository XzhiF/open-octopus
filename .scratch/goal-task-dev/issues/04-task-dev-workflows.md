# 04 — core-pack:task-dev 工作流 + superpowers cr-fix goal 化 + schema 引用清理 + skill 文档

## What to build
交付物层:两节点 skills-free 的 `task-dev.yaml`(develop goal + ship prompt,max_turns 参数默认 200)+ simulator fixture;`superpowers-task-dev` cr-fix 改 goal 模式(cr_status 三处同步清理);全仓库 JSON schema 引用清理(废弃路线 B);octo-workflow-dev/octo-workflow-test 文档重写 goal 章节 + validate-workflow.js 规则同步。

## Blocked by
01(parser 须接受新字段/simulate 才能跑 goal yaml)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `task-dev.yaml` inputs 三字段全带 description,max_turns default "200"(字符串);develop 节点 goal 含产物自查指引+ac 逐条判据+软退出条款,`max_turns: $inputs.max_turns`;ship prompt 三阶段(ship-report→commit→gh pr)
- [ ] AC2: `task-dev.test.yaml` 两场景:happy(completed)+ 耗尽(mock 节点 `status:failed + error:'goal_not_met (max_turns)'`——不 mock terminalReason,机制不存在)
- [ ] AC3: superpowers-task-dev:cr-fix 改 goal(对照 $inputs.ac+$vars.plan_file),**cr_status 三处清**:variables 声明、test fixture mock/断言、ship prompt 引用
- [ ] AC4: `grep -r "yaml-language-server" packages/core-pack/workflows/ .claude/skills/octo-workflow-dev .claude/skills/octo-workflow-test packages/core-pack/skills/` = 0(.scratch/ 与 .scratch/goal-task-dev/ 除外);`~/.octopus/workflow-schema.json` 删除;sync-builtin.mjs schema 分支+残留 log 清理
- [ ] AC5: skill 文档:node-schema.md agent 表增 goal(/goal 语义)/max_turns/max_budget_usd/disallowed_tools/tools,删 planning;variables.md/special-conventions.md 同步;validate-workflow.js 与 parser 规则一致(planning 报错、新字段合法、engine 警告);SKILL.md "Schema authority" 改指 Zod
- [ ] AC6: `octopus workflow validate` 全 core-pack yaml 通过 + 两个 simulate 全绿

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
