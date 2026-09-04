# 13 — core-pack：task-author SKILL.md v2 重写 + task-fix.yaml 修复流

## What to build
SKILL.md：保留 curl/API 骨架；9 字段教学→phases 协议（spec-field field=phases、specPath 约定、拆分确认 gate 流程）；新增四章：领域阅读流程（context.md→project 路径→惯例 probe 降级）、拆 phase 方法论（deliverable 判据、1~1.5h 预算、决策表行稳定纪律 NEW-rN）、matt 族产物协议（Batch 目录、spec.md 冻结+spec-rN 并存、issues 原位增量、fix-feedback 消费）、per-phase 工作流绑定推荐（built-in 目录浏览）。新工作流 `task-fix.yaml`（通用修复流：inputs=phase spec 目录+feedback 文件+task_artifacts_dir → agent 定点修 → 产 fix-report-rN.md 入 slug）+ 配对 test.yaml。

## Blocked by
04（占位符词表）, 09（技能族就位）

## Status
done

## Exploration

**Analog studied**: `task-dev.yaml`（prompt/inputs/vars 惯例 + 「未收敛必须响」）+ `xzf-dev.test.yaml`（scenario 结构：inputs/mocks/assertions.node_trace）+ `matt-verified-requirement/SKILL.md`（写作质量基线）。

**验证入口实证（修正票面假设）**: engine 包内**没有** *.test.yaml 自动拾取 —— `assist-workflows-simulator.test.ts` 硬编码 3 个模板；`xzf-dev.test.yaml` 先例实际经 **CLI `octopus workflow simulate`**（`discoverTestFixture` 自动发现同名 .test.yaml，`packages/cli/src/commands/workflow.ts:327-442`）消费。全局 `octopus` CLI 可用（独立安装的 1.0.0）→ AC1 按票面原文跑；AC2 用仓库内新鲜 dist（`node packages/cli/dist/index.js workflow simulate`，代码与 engine 当前 HEAD 一致）+ 全局 octopus 双跑。`npx vitest run task-fix` 无匹配文件且新增 engine 测试文件越权（file ownership 白名单外）→ 不建。

**Simulator 语义实证**（决定 task-fix 节点形状）:
- mock `update_vars` 进 pool（`resolveMockOutputs`）→ bash precheck mock 可驱动下游 `execute_when` 路由 ✓
- `execute_when` 假 → 节点 `skipped`（`simulator-engine.ts:113-128`）；mock `status: failed` → 节点 failed → 工作流 failed + 后续 `skipped`（:204-218）→ 「缺 feedback 反例」可精确断言 fix 未执行
- bash 真实运行解析 stdout 尾行 `{"vars_update": {...}}`（`parse-vars-update.ts`），`exit≠0` → failed（`bash.ts:91-100`）→ precheck 三态 + fail-fast 双保险在真实路径同语义
- inputs 同时进 pool 与 `$inputs` 命名空间（`engine.ts:221-237`）→ `$vars.phase_spec_dir` 在 prompt/bash 均可解析

**词表/契约对齐**（必读输入）:
- 占位符：`${goal}/${ac}`（v3 遗留，v4 起草不再用）+ v4 `${phase.slug}` `${phase.spec_dir}` `${task.home}` `${task_artifacts_dir}`（`template-resolver.ts:49-65`，仅 per-phase ctx 下可用）
- TaskPhase = `{index,name,slug,specPath,workflowRef,inputValues}`（`shared/src/types/scheduler-job.ts:110-120`）；`task_artifacts_dir`/`task_workflows_dir` 是 dispatch **管理键**、materialize 尾注入覆盖（`scheduler-service.ts:321-340`）→ 绑定表单**不需要**手填 task_artifacts_dir（gate 只认 inputValues 键，故 v4 gate ③ 要求 required input 必须显式绑——task-fix.yaml 的 task_artifacts_dir 因此设 `required: false`）
- Batch 目录：`./.scratch/<YYYYMMDD>/<slug>-<N>/spec.md`（D5/D15/K10；specPath 相对 home 解析 `tasks-service.ts:1016`）
- 端点：`GET /api/workflows/built-in` 返回 `{ref:"group/name",name,inputs,group}`（含 inputs → 目录浏览建表单成立；`builtin-workflow.ts:123-144`）；`spec-field field=phases` 是**票 07 AC5 的契约**（`TaskSpecFieldSchema` 尚无 `phases`，server 落地前该 curl 400——SKILL 按 v4 目标契约教学并显式标注整-spec PUT 等价通道）
- rN 纪律（D14/K8）：spec.md 冻结、spec-rN 并存、决策表行/编号稳定、新增标 `NEW-rN`；修复流不传播
- matt 六技能名（票 09 seed 列表）：matt-verified-requirement · matt-verified-spec · matt-verified-tickets · domain-modeling · grilling · wayfinder

**文件改动面**: 重写 `packages/core-pack/skills/task-author/SKILL.md`（v2.1.0 → 3.0.0）；新建 `packages/core-pack/workflows/task-fix.yaml` + `task-fix.test.yaml`；同步 `.claude/skills/task-author/SKILL.md`（实证：与 core-pack 为**两份独立副本**（inode 不同、内容逐字节同），core-pack 为准 → 覆盖同步）；AC4 另需刷新本机已 seed 副本 `~/.octopus/agent/skills/task-author/SKILL.md`（seed 机制 copy-if-missing 不覆盖存量，clone config `skills:["task-author"]` 实证该路径为现网加载源）。

**不碰**: engine/server/shared/web 源码、workflow-presets、task-dev/superpowers-task-dev 文件。

## Acceptance Criteria
- [x] AC1: `octopus workflow validate packages/core-pack/workflows/task-fix.yaml` 通过
- [x] AC2: task-fix.test.yaml 模拟器 scenario 绿（含 feedback 缺失反例）
- [x] AC3: SKILL.md 经人工 checklist 走查：四新章齐、无 goal/ac/preset 残留词、curl 端点与实际路由一致（对照票 07 端点）
- [x] AC4: 现网 task-author 会话加载到的 SKILL.md 为新版（版本号断言）

## Verification Method
**Verification type**: workflow simulator + manual checklist

**Verification steps**:
1. `pnpm -F @octopus/engine test -- task-fix`（或 CLI `octopus workflow test`）
2. 走查清单：对照 spec.md K15/K9/K10 逐条勾
3. `octopus workflow validate` 输出贴票

**Pass criteria**: validate+simulator 绿；checklist 无缺口（人工验收项，SKIP 需注明）
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Verification Result (2026-09-03)

**AC1 — validate（票面原文命令，全局 CLI）**：
```
$ octopus workflow validate packages/core-pack/workflows/task-fix.yaml
✓ Workflow YAML is valid
  Name: task-fix
  Nodes: 3
```
仓库内 `node packages/cli/dist/index.js workflow validate` 同结果。

**AC2 — 模拟器（入口实证修正）**：`npx vitest run task-fix` 无匹配（engine 无 *.test.yaml 自动拾取，xzf-dev.test.yaml 先例实为 CLI `workflow simulate` 消费，见 Exploration），按票面括注「或 CLI」执行：
```
$ node packages/cli/dist/index.js workflow simulate packages/core-pack/workflows/task-fix.yaml   # strict，自动发现 .test.yaml
✔ Scenario "fix round — feedback present, agent repairs"   — status=completed; executed[precheck,fix]; skipped[fail-fast]; vars fix_round/report_file/fix_status 全中
✔ Scenario "precheck fail — feedback file missing"         — status=failed; executed[precheck,fail-fast]; skipped[fix]（反例：fix agent 绝不执行）
✔ Results: 2 passed, 0 failed (2 scenarios)
```
回归：`npx vitest run src/__tests__/simulator/`（engine）7 files / 69 tests 绿，既有测试零触碰。`workflow test`（strict 直跑）同绿。

**AC3 — SKILL.md v2（3.0.0）人工走查 checklist（自查逐条勾）**：
- [x] 四新章齐：`## 领域阅读流程`（①context.md→project 路径→probe 四件套→缺则标注降级 + 写权边界）｜`## 拆 Phase 方法论`（②deliverable 判据/1h·1.5h 预算/3~5 人天→4~5 phase/Key Decisions 行稳定 NEW-rN）｜`## matt 技能族产物协议`（③Batch 目录、spec.md 冻结+spec-rN 并存、issues 原位增量、fix-feedback-rN 消费、写权单写者表）｜`## 拆分确认 gate 与 per-phase 工作流绑定`（④拆分卡+批准前禁绑、目录浏览 GET /api/workflows/built-in、input_values 表单、task-fix 不预绑说明）
- [x] 无旧教学残留（grep 全文 8 处 goal/ac/preset 命中均为**退役声明/边界标注**：L13 v3 不再起草、L122 spec.json 快照如实呈现、L139 词表标注禁用、L195 不再必填、L219 一律不写、L236 gate 无 goal/ac 检查、L266 preset 已退役、L297 技能组退役；`goal_confirmed`/`ac_confirmed`/`HOW-handoff`/`workflow-presets` 命中数=0）
- [x] curl 端点与实路由一致（routes/tasks.ts 逐一核对：POST / ✓ GET / ✓ GET /:id ✓ PUT /:id(If-Match) ✓ POST /:id/spec-field ✓ /ready ✓ /trigger ✓ /abort ✓；built-in 清单+详情 `%2F` 编码式与 web `encodeURIComponent(ref)` 先例一致；`field=phases` 为票 07 AC5 契约，SKILL 内已加过渡说明（400→整-spec PUT 等价通道））
- [x] 9 字段教学→phases 协议：TaskPhase 六字段与 `taskPhaseSchema` 逐字段一致（index/name/slug/specPath/workflowRef/inputValues，含 slug path-safe 正则与 ≤100 字）；specPath 约定 `./.scratch/<YYYYMMDD>/<slug>/spec.md`（slug=kebab+phase 序号 → 目录字面即 K10 的 `<slug-N>`）
- [x] 占位符词表与票 04 实现一致（`template-resolver.ts:49-65` 五名+`${goal}/${ac}` 退役标注+管理键 required:false 时序坑已写明）
- [x] matt 六技能按技能名引用（matt-verified-requirement/spec/tickets、domain-modeling、grilling、wayfinder = 票 09 seed 列表）
- [x] curl/API 骨架保留：前置条件、spec.json 快照协议、5 端点结构、错误码表（400/404/409/428）沿用 v2.1 形制；自建流 validate+simulate 双硬门槛保留
- [x] frontmatter YAML 可解析（js-yaml 实测通过；version 3.0.0）

**AC4 — 现网断言**：task-author clone `config.json skills:["task-author"]` → 加载源 = `~/.octopus/agent/skills/task-author/SKILL.md`（init-service copy-if-missing 不覆盖存量，故手动刷新该 seed 副本）。断言：`grep version:` → **3.0.0**（task home `skills/` 实测为空、built-in 层无覆盖 → 该路径即唯一加载源，新会话生效）。

**文件源同步（票 C 项）**：`.claude/skills/task-author/SKILL.md` 与 core-pack 为**两份独立副本**（inode 不同、改造前内容逐字节相同、均 git 跟踪）→ 已以 core-pack 为准覆盖同步（diff 干净）。`packages/cli/dist/core-pack/...` 为 gitignored 构建产物（`scripts/copy-core-pack.mjs` 生成），下次 build 自动更新，未手改。

