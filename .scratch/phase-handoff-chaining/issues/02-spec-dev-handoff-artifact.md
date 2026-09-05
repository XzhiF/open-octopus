# 02 — matt-spec-dev：ship 产 handoff.md + spec-resolve 探测 + 提示词消费

## What to build

`packages/core-pack/workflows/matt-spec-dev.yaml` 三处：

1. **ship-pr 新增产物步**：产/覆写 `$inputs.batch_dir/handoff.md` — 头块（phase 名/slug · 终态轮次 rN · PR 链接 · 批次路径）+ `## Protected Decisions` / `## Confirmed Interfaces` / `## Gap Targets`；纪律=精选短页一屏内、细节引用 round-report.md 不复制、只写 ws（collect 管回流）。
2. **spec-resolve 探测**：inputs 增可选 `prev_handoff_paths`（管理键说明，绑定表单免手填）；bash 逐行探测存在性 → `vars.prev_handoffs`（存在子集）+ `vars.prev_handoff_count`；缺失静默跳过不 fail。**⚠️ R1 第一跳先验证**：bash 节点能否读 home 绝对路径（基线 path-guard 域有红）——不通则按 spec R1 退路（seed 拷入）先停下来向主会话报告，勿擅自动 seed 协议。
3. **消费提示词 ×3**：`spec-review` / `ticket-dag` 普通票模板 / `ship-pr` 各加「先读前序交接：$vars.prev_handoffs（空则无前序）」。

改毕：`octopus setup` 落安装库（sync-builtin 不管 workflows，ADR-0018 §4）。

## Blocked by

None — can start immediately.（键名契约已在 spec/ADR-0019 锁死，与 01 并行安全）

## Status

done

## Exploration

**Analog 研究**：`task-fix.yaml` 的 `feedback_path`（可选注入键 + bash 探测 `$vars.feedback_path` + 提示词消费）为同族先例；`spec-resolve` 自身的 `fix-feedback-rN` 探测块就是新探测代码的形状模板。

**R1 结论 = PASS（bash 节点无路径沙箱）**：
- `packages/engine/src/executors/bash.ts`：`spawn(BASH_PATH, ["-c", script], {cwd})` 直跑主机进程，engine 全包 grep `path.?guard|sandbox|allowedPaths` 零命中。
- 唯一 path-guard 在 `packages/server/src/services/agent/clone-runtime.ts:724 buildPathGuard` —— 只挂 **task-author clone 会话的工具调用层**，且是**写锁**（Write/Edit + Bash 写重定向锁进 task home）；工作流 bash 节点不经过它。R1 说的"基线 path-guard 域有红"即此处，与 spec-resolve 探测无关。
- simulate `--real`/`real_execution` 走同一 BashExecutor（`mock-factory.ts`），验证逻辑等价真机。
- Windows 注意：server 注入值是 `C:\...` 反斜杠路径，MSYS bash `[ -f ]` 直测不稳 → 探测前 `tr '\\' '/'` 归一（同时保证 vars JSON 永无裸反斜杠 = JSON-safe），不依赖 pool→env 合并（Windows env 值含换行有风险），改用占位符守卫模式：`PH_RAW='$inputs.prev_handoff_paths'` + 字面量残留判空（substitute.ts 对未解析引用**原样保留**，已核实）。

**需改文件**：仅 `packages/core-pack/workflows/matt-spec-dev.yaml` + `matt-spec-dev.test.yaml`（已存在，扩展 2 场景）+ 新 sim fixture `.scratch/phase-handoff-chaining/sim/`（repo 相对路径，simulate cwd=repo 根）。

**机制选型**：simulate 断言层无文件断言（assertions.ts 仅 status/vars/node_trace/node_outputs/logs 5 种）→ AC3/AC4 用场景级 `real_execution: [spec-resolve]` 真跑 bash + 真 fixture 路径（存在+ghost+Windows 式虚构混合）断言 vars；**AC1/AC2 是 ship-pr agent 提示词驱动的产物，simulate mock 不落盘——降级为提示词契约静态核对（grep 三段标题/覆写措辞），真 LLM 文件行为按 spec Execution Decision 2（深验 SKIP）口径留给 ticket 03/事后 dogfood**。`octopus setup` 实际落位 = `~/.octopus/resources/installed/workflows/built-in/matt-spec-dev/matt-spec-dev.yaml`（目录/文件布局，票内 Verification 写的扁平路径有误）；全局 `octopus` shim 直链本仓 `packages/cli/dist`，setup 源=本仓 core-pack。

## Acceptance Criteria

- [x] AC1: ship-pr 提示词含产物步：头块（phase/slug · 终态轮次 rN · PR · 批次路径）+ `## Protected Decisions` / `## Confirmed Interfaces` / `## Gap Targets` 三段（yaml ship-pr 步 4，grep 静态核对）。注：simulate 断言层无文件断言（assertions.ts 仅 status/vars/node_trace/node_outputs/logs 5 种）、mock agent 不落盘 —— 真 LLM 文件行为按 spec Execution Decision 2 深验 SKIP 口径由 ticket 03 e2e API↔fs 交叉 / dogfood 承接
- [x] AC2: 同 AC1 口径 —— 提示词明写「每轮整页重写、禁止追加 — 头块轮次 rN 即最新终态」
- [x] AC3: simulate 场景 4 spec-resolve **真执行**（`real_execution`）：真实相对路径 ×2 + ghost + Windows 式反斜杠虚构混合 → `vars.prev_handoffs` 只含存在者（保序、换行 JSON 转义）、`prev_handoff_count: "2"`，缺失静默过滤不 fail
- [x] AC4: simulate 场景 5 真执行无 `prev_handoff_paths` 输入：precheck 照常 OK、`prev_handoffs: ""` / `prev_handoff_count: "0"`（= variables 初始值），路由行为与改前一致
- [x] AC5: 既有 3 场景不回归（全量 5/5 绿）；`octopus setup` 后 installed 副本 = 源（diff 为空；实际路径 `~/.octopus/resources/installed/workflows/built-in/matt-spec-dev/matt-spec-dev.yaml` —— 目录布局，票内 Verification 的扁平路径有误。注意 setup 源 = `packages/cli/dist/core-pack` 构建快照，需先跑 `packages/cli/scripts/copy-core-pack.mjs` 刷新，否则装旧版）

**R1 结论 = PASS，无需 seed 退路**：engine BashExecutor 无任何路径沙箱（全包 grep `path.?guard|sandbox` 零命中；唯一 guard 在 server clone-runtime = task-author 会话**写锁**，与 bash 节点无关）。Windows 适配两点：① 探测前反斜杠→正斜杠归一（`[ -f ]` 可测 + vars JSON 永无裸反斜杠）；② 未注入检测用替换哨兵（substituteVars 原样保留未解析引用）——首版字面量比较两侧同被替换致判空失真，已修正为裸词 `'$inputs'` 拼接哨兵（simulate 场景 4 红→绿闭环验证）。

## Verification Method

**Verification type**: simulate（mock LLM 输出）+ 文件断言

**Verification steps**:
```bash
octopus workflow simulate packages/core-pack/workflows/matt-spec-dev.yaml   # 既有 3 场景绿 + 新增 handoff/prev 场景绿
octopus setup && diff <(cat ~/.octopus/resources/installed/workflows/built-in/matt-spec-dev.yaml) packages/core-pack/workflows/matt-spec-dev.yaml
```
新 fixture：批次目录预置 spec+issues+handoff 输入位；断言 vars 与产物文件（mock agent 输出按 simulate 惯例给 vars_update）。

**Pass criteria**: AC1–AC5 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
