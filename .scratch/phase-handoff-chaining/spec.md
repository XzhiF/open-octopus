# Spec: v4 阶段衔接环 — handoff.md 产物 + prev_handoff_paths 自动注入

## Problem Statement

v4 多 phase 任务里，phase i accepted 后 phase i+1 的执行会话**裸跑开轮**：phase i 的已定决策、已确认接口、遗留缺口、PR、修订后 spec 终态，对 i+1 的执行侧运行时不可见。跨 phase 唯一信道 = 起草时人工转述进 spec 文本——这正是「衔接不顺」的根因。

`matt-spec-dev` 内部 handoff 方法论是半截活：`requires.skills` 已列 `mattpocock-skills/handoff`、`ship-pr` 提示词写了「使用 handoff skill 方法论记录本轮交接」，但**没有任何 handoff 文件产物被定义、放位、消费**——每轮实际只产 `round-report.md`（受众=验收人，非下游执行会话）。

## Solution

phase 级衔接产物环，全自动零起草负担：

1. **产物**：`ship-pr` 每轮末产/覆写批次目录 `handoff.md`（头块 + 三段式：Protected Decisions / Confirmed Interfaces / Gap Targets），ws→collect 自然回流 home。
2. **信道**：accepted→下一 phase 开轮时，server 把全部已 accepted 前序的 `handoff.md` home 绝对路径作为内置输入键 `prev_handoff_paths` 自动注入（与 `feedback`/`task_artifacts_dir` 注入同族）。
3. **消费**：`matt-spec-dev` 的 `spec-resolve` 探测路径存在性 → vars → DAG 票 / ship 提示词「先读前序交接」。
4. **可见**：验收弹窗 accept 确认前一行提示「N 个前序交接将自动进入下一 phase」。
5. **纪律**：task-author SKILL 反向锁死「人工转述」：后继 spec 不抄前序接口细节，声明依赖经衔接信道。

## Projects Involved

- [x] packages/server（注入管道，tasks-service.ts）
- [x] packages/core-pack（matt-spec-dev.yaml + task-author SKILL.md）
- [x] packages/web-app（acceptance-modal.tsx 一行提示）
- [ ] shared / engine / providers / cli（零改动——信封不动、词表不动）

## Feature Scope

**Do:**
- ship-pr 产 handoff.md（每轮覆写，三段式 + 头块，一屏内，引用不复制）
- server 在 `acceptance()` accepted→`dispatchPhaseRound(i+1,1)` 与手动推进两处注入 `prev_handoff_paths`（仅存在性过滤后的路径列表，换行连接；空则不注入键）
- spec-resolve 探测 + ticket-dag/spec-review/ship 提示词消费
- task-author SKILL：衔接信道事实节 + 起草纪律 + 入队前 slug 引用自查
- 验收弹窗提示行（存在下一 phase 时显示）
- ADR-0019 + CONTEXT-MAP 术语

**Don't:**
- 草稿会话（task-author clone）跨 phase 续聊——产物信道取代会话信道（K1）
- `template-resolver.ts` 词表扩展（`${prev.*}` 等）——注入走内置键，占位符词表原样（K3）
- phases[] 信封加字段（K16 冻结红线）
- 「依赖前序」列结构化机器校验（SKILL 自查覆盖）
- round-report.md 结构改动（handoff 是精选短页，非替代）
- 同 phase 打回 rerun 注入前序（已有 feedback/fix-feedback 信道）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|----------|-----------|--------|
| K1 | 范围四叉取舍 | A 执行环 + B SKILL 纪律 + D UI 提示；C 草稿会话续聊出局 | 会话记忆的本质价值 = handoff 要产物化的东西；文件是更好的记忆（可审/可 diff/永久留档） |
| K2 | handoff.md 生产者/时机 | ship-pr 每轮末产/覆写，落本批次目录 | ship 时刻上下文最全、零额外调度；覆写语义 ⇒ accepted 那刻天然=终态交接；失败轮交接不丢（打回人可对照） |
| K3 | 衔接信道 | server 自动注入 `prev_handoff_paths`（全部已 accepted 前序，home 绝对路径，只注路径不注内容） | 各 phase 可绑不同 ws ⇒ sibling 枚举先天残缺；accepted 前序 home 已终态不变 ⇒ 直读无漂移（task-fix `feedback_path` 先例）；自动注入 = 零起草负担零静默失效 |
| K4 | 内容契约 | iteration-handoff 三段式沿用 + 头块（phase·轮次·PR·批次路径） | 与 matt-dev-pipeline 同词表，agent 零学习成本；验收结论 DB+UI 已有，不双真相源；「只写增量、引用不复制、一屏内」 |
| K5 | 起草侧纪律重量 | SKILL 文本档（事实节+纪律+自查），不动信封不加校验通道 | 防「引用不存在 phase」在拆分确认 gate 人眼+SKILL 自查已覆盖；动信封不值（ADR-0018 §6 同线） |
| K6 | UI 面 | 验收弹窗一行提示；批次清单靠 home-file LIST 自动可见，不加组件 | 衔接要在**决策点**可见（accepted 那一下）；fs 有新产物 + API 有新注入 ⇒ UI 全盲违反四方交叉口径 |

## Execution Decisions

| # | Decision | Choice | Reason |
|---|----------|--------|--------|
| 1 | Story Walk-Through | skipped (user decision) | 用户裁：机制已由 grilling 逐跳核实，穿线不另跑 |
| 2 | E2E Verification (pipeline Phase 4) | run（**真 LLM 深验 SKIP**） | 断言层 = API↔DB↔fs 交叉 + playwright + simulate（mock LLM 输出）；不建真 LLM 全链任务，成本口径由用户锁定 |
| 3 | Ticket Execution Mode | sub-agent-concurrent | 5 票跨 3 包，01/02/04 同 stage 并行 |

## User Stories

1. **作为 phase i+1 的执行 agent**，我在 round 开跑时自动拿到全部已 accepted 前序的 `handoff.md` 路径且被提示词要求先读，**以便** 不回退前序已定决策、直接复用已确认接口、对遗留缺口有数——无需任何人工转述。
2. **作为 phase 验收人**，我在验收弹窗 accept 确认前看到「N 个前序交接将自动进入下一 phase」，**以便** 在决策点确认衔接确实发生。
3. **作为打回场景的裁决人/修订执行者**，phase 被打回后上一轮 `handoff.md` 仍在批次目录且随每轮 ship 更新，**以便** fix/rerun 决策有上轮交接对照。
4. **作为 task-author（起草人）**，SKILL 告诉我衔接信道的事实与边界（仅 spec-dev 同族流成立），并要求后继 spec 用「依赖 phase i Confirmed Interfaces」引用替代抄写，**以便** 拆分表「依赖前序」列有真实信道支撑。

## Implementation Decisions

### server — `packages/server/src/services/tasks/tasks-service.ts`

- 新 helper（模块级或私有方法）：`collectPrevHandoffPaths(spec, targetPhaseIndex): string[]`
  - 前序判定：`index < targetPhaseIndex` 且该 phase 最新 round 已 accepted（复用 `acceptance()`/`deriveTaskView` 同域的既有判定源，不新造状态）。
  - 每个前序取 `resolvePhaseSpecDir(...)`（已 import）→ `join(specDir, 'handoff.md')`，`fs.existsSync` 过滤。
- 注入点 ×2：`acceptance()` accepted→`dispatchPhaseRound(nextPhaseIndex, 1)`（~:2173）与手动推进 `dispatchPhaseRound(target.index, 1)`（~:2356）。
- 注入位：`dispatchPhaseRound` 内构造 resolved input_values 处，与 `feedback`/恢复 stamps **同段 append**（`...(paths.length ? { prev_handoff_paths: paths.join("\n") } : {})`）。签名扩展走 opts 参数或既有 routing 对象——实现侧择一，不改既有调用语义。
- 值形态：平台原生绝对路径（Windows `C:\...`），换行连接。**只注路径不注内容**。
- 无 DB schema 变更；信封 phases[] 零触碰（K16）。

### core-pack — `packages/core-pack/workflows/matt-spec-dev.yaml`

- `inputs` 增可选 `prev_handoff_paths` 描述（管理键，绑定表单无需手填）。
- `spec-resolve`（bash）：逐行探测 `$inputs.prev_handoff_paths` 存在性 → `vars.prev_handoffs`（存在的换行子集）+ `vars.prev_handoff_count`；缺失路径静默跳过不 fail。
- 消费提示词三处：`spec-review`、`ticket-dag` 普通票模板、`ship-pr`——各加一句「先读前序交接：$vars.prev_handoffs（若空则本 phase 无前序）」。
- `ship-pr` 执行步新增第 4 步（现 1-3 之后）：**产/覆写 `$inputs.batch_dir/handoff.md`**：
  - 头块：phase 名与 slug · 终态轮次 · PR 链接 · 批次路径
  - `## Protected Decisions`（本 phase 定死、下游不得回退；对照 spec Key Decisions 表）
  - `## Confirmed Interfaces`（下游可直接复用的接口/表/组件/命令，给路径不给描述）
  - `## Gap Targets`（如实遗留：skip 票、noted 风险、未竟事项）
  - 纪律：精选短页目标一屏；细节引用 `round-report.md` 不复制；只写 ws，collect 管回流。
- 改后 `node scripts/sync-builtin.mjs` 不适用 workflows——**`octopus setup` 落安装库**（ADR-0018 §4 注记）。

### core-pack — `packages/core-pack/skills/task-author/SKILL.md`

- 新节「phase 衔接信道」：事实段（ship 产 handoff.md / accepted 自动注入 prev_handoff_paths / 仅 matt-spec-dev 或遵循同契约的流消费——绑自定义流信道**静默失效**须提醒）+ v4 占位符词表节旁登记 `prev_handoff_paths` 为内置注入键（非占位符）。
- 起草纪律：后继 phase spec 正文**不抄**前序接口/决策细节，写「依赖 phase <i> 的 Confirmed Interfaces（运行时衔接信道读取）」。
- 入队 gate 前自查：拆分表「依赖前序」列引用的 batch slug 全部存在。
- 改后 `node scripts/sync-builtin.mjs`（skills 域适用）。

### web-app — `packages/web-app/components/tasks/acceptance-modal.tsx`

- decision=accepted ∧ 存在下一 phase 时，确认按钮上方一行提示：「本 phase 的 handoff.md 连同已 accepted 共 N 个前序交接，将自动进入下一 phase 执行会话」（N = accepted 前序数 + 1；数据源 = 弹窗已持有的 task phases 状态，无新 API）。
- 单测（acceptance-modal.test.tsx 家族）+ playwright（task-phase-acceptance.spec.ts 家族）。

### 接口/契约不变量

- 无新端点；`POST /:id/acceptance` 请求/响应 shape 不变（提示行数据来自既有 task view）。
- round 详情/派生执行视图不显示 prev_handoff_paths 实值（K6 已裁 B 出局）。

## Data Model Changes

无表结构变更。`workflow_chain[0]` 的 materialized input_values 新增可选键 `prev_handoff_paths`（string，换行连接；既有列）。

## API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| POST | /api/tasks/:id/acceptance | 不变 | 不变 | 不变 | 副作用扩展：accepted→下 phase 开轮注入新键 |

## Verification Strategy

### Verification Environment

| Item | Value |
|------|-------|
| Environment | local dev: `pnpm dev`（server :3001 / web :3000，health=`/api/actuator/health`） |
| API prefix | `/api/` |
| Database | SQLite: `~/.octopus/db/octopus.db` |
| Admin UI | `http://localhost:3000` |

### Test Users & Data

| Item | Value |
|------|-------|
| 测试账号 | 本机 dev 无鉴权面（沿用既有 e2e 惯例） |
| 数据前缀 | `E2E_TD_PHASEHANDOFF_` |
| Seed | 编程式构造双 phase v4 草稿：POST draft → 写 phases（各绑 matt-spec-dev + `${phase.batch_rel}`）→ 入队；phase1 批次目录预置 handoff.md（模拟 ship 已产） |
| Cleanup | 测后删除任务 + home 批次目录 |

### AC to Verification Method Mapping

| US# | AC | Verification Level | Verification Method |
|-----|-----|-------------------|---------------------|
| US1 | accept phase1 后新 round 的 chain input_values 含 `prev_handoff_paths`=phase1 `{specDir}/handoff.md` 绝对路径 | integration（server） | vitest 真 DB + 临时 home fs 四方断言；手测路径 API↔DB 交叉 |
| US1 | handoff.md 不存在的前序被静默过滤 | unit | vitest 存在性过滤用例 |
| US1 | 打回 rerun **不**注入；accepted→i+1 与手动推进两处都注入 | integration | vitest 三用例（rerun/accept/manual-trigger） |
| US2 | 验收弹窗 accept 态且有下一 phase ⇒ 提示行含正确 N；末 phase accepted 不显示 | unit + browser E2E | acceptance-modal.test.tsx + playwright task-phase-acceptance 家族 |
| US3 | simulate 轮后批次目录存在 handoff.md 且含三段标题；重跑轮覆写更新 | contract/simulate | `octopus workflow simulate matt-spec-dev` 新增用例（基线 3/3 不回归） |
| US4 | SKILL 含衔接信道事实节 + 纪律 + 自查条目 | manual checklist | 文案 review 三项对照本 spec §Implementation |
| E2E | 真链路：双 phase 任务 accept1 → 下轮执行输入可见 phase1 handoff（深验需真 LLM，环境挡死如实 SKIP） | browser E2E + API | playwright + DB 断言 + fs 证据落 e2e-data/ |

### Verification Methods Detail

#### Unit / Integration Tests
`pnpm --filter @octopus/server test`（新用例族挂既有 task 域测试文件旁）；`pnpm --filter @octopus/web-app test`。基线红 server 43 / web 3 files **不得增加**。

#### Simulate
`octopus workflow simulate packages/core-pack/workflows/matt-spec-dev.yaml` 新增 fixture：批次含 handoff.md + prev_handoff_paths 输入，断言 spec-resolve vars 与 ship 产物。

#### Browser E2E
`cd packages/web-app && npx playwright test e2e/task-phase-acceptance.spec.ts`（扩展提示行断言）。

#### 真机深验（用户已裁 SKIP）
不跑真 LLM 全链路。替代成本口径：simulate mock LLM 输出（`workflow simulate` fixture）+ API↔DB↔fs 编程式断言。真机样本（「全局token计费」重绑 matt-spec-dev）仅作事后 dogfood，不进门禁。

### Anti-Fake-Run Standards (R1-R8)

全部适用；重点：R3 交叉 = API response ↔ executions.chain ↔ home fs 三方；R4 证据 = 断言快照 + e2e-data/ 落盘；R8 = 测试自建数据零手工前置。

### Prerequisites

- [ ] `octopus setup` 已跑（matt-spec-dev 落安装库）——真机深验前置，单测/simulate 前置
- [ ] pnpm dev 在跑（浏览器 E2E 前置）
- [ ] 基线红记录（server 43 / web 3 files）比对

## Risks & Notes

- **R1（本线最大）**：`spec-resolve` bash 节点能否读 **home 绝对路径**（ws 外位）。task-fix `feedback_path` 先例证明 agent 级可行，但 bash 节点 + 基线 path-guard 域有红——实现第一跳先小样验证；若被挡，退路 = server seed 时顺带拷前序 handoff.md 进本批次 ws 位（动 seed 协议，mtime 纪律须保住）。
- **R2**：ship 崩溃 ⇒ 该 phase 无 handoff.md，accepted 后信道对下 phase 静默缺一角——存在性过滤吞掉。缓解：验收人批次清单可见 handoff 缺失（D 面 LIST 天然覆盖）。
- **R3**：存量任务（本特性前 accepted 的 phase）无 handoff.md = 现状不回归，不迁移。
- **R4**：`matt-dev-pipeline` 等自定义流不消费 `prev_handoff_paths`——注入无害、信道静默失效，SKILL 已负责提醒（K5）。
- **R5**：dogfood 遗留「全局token计费」假完成草稿可作真机样本（重新绑 matt-spec-dev），但非本 spec 验收必需。
- **R6（术语张力澄清）**：CONTEXT-MAP 反模式「Document Handoff」禁的是**票不自含需求、下游靠重读他文档重建规格**。handoff.md 不承载 i+1 的需求（其 spec+issues 仍自含），只提供增量上下文（不得回退项/可复用接口/遗留）——是增强非替代，不违例。

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| **阶段衔接信道 (Phase Handoff Channel)** | accepted→下一 phase 时 `prev_handoff_paths` 自动注入 + spec-dev 探测消费构成的跨 phase 上下文信道；与 spec 文本信道（起草期人工转述）相对 |
| **handoff.md** | 批次目录新家族成员：ship 每轮末产的**面向下游执行会话**的精选交接短页（头块+三段式）；与 round-report.md（面向验收人全量轮报）受众不同 |
| **prev_handoff_paths** | 内置注入键（非占位符）：全部已 accepted 前序 phase 的 handoff.md home 绝对路径，换行连接，dispatch 时 server 注入 |

## Appendix: Core User Stories（闭环验证）

### Story 1: 双 phase 任务的零转述衔接
1. [UI] task-author 起草 phase1+phase2 批次（spec+issues 冻结、拆分确认、[入队]）
2. [Exec] phase1 round1：matt-spec-dev 跑完 → [Data] ws 批次含 round-report.md + **handoff.md** → collect 回流 home
3. [UI] 验收人打开弹窗 → [UI] 提示行「1 个前序交接…」→ accept(autoAdvance)
4. [API] `acceptance()` → [Exec] `dispatchPhaseRound(2,1)` 注入 `prev_handoff_paths` → [Data] chain input_values 持久化
5. [Exec] phase2 round1 spec-resolve → [Data] vars.prev_handoffs → [Exec] 票 agent 读 phase1 handoff → 不回退 Protected Decisions、复用 Confirmed Interfaces
（断点检查：步骤 4→5 的 home 绝对路径可读性 = R1；步骤 2 handoff 缺失 = R2 静默降级）

### Story 2: 打回轮交接不丢
1. [UI] phase1 round1 验收 rejected(next_flow=fix) → [API] fix-feedback-r1.md 产物化 + override task-fix
2. [Data] 批次目录 handoff.md（round1 版）仍在 → 修复/再审会话可对照
3. [Exec] rerun round2 ship → handoff.md 覆写为 r2 终态 → collect 回流
（断点检查：覆写非追加——轮次语义=最近一轮终态，头块标 rN）
