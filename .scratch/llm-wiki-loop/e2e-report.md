# E2E Test Report — LLM-WIKI 知识闭环（票13 首跑，P0+P1 集成认证）

## Basic Info

- Target: LLM-WIKI 闭环全链（查阅→引用→可见→影子对照），票 01–12 集成
- Mode: API Integration + 真实 provider 工作流执行 + JSONL/DB/FD 交叉验证（matt-e2e-test-methodology · e2e-harness 复现模式）
- Host: `C:\xzf\ai\open-octopus\.worktrees\integration` @ `eccbd6cb`（已 build，未重建；全程未 commit，收尾 git status 干净）
- 环境: dev 实例 `pnpm dev --port 3410,3411 --skip-build`（web=3410 server=3411；保护端口 3000/3001/3098/3099 未触碰）
- DB: **不写默认库**。`~/.octopus/db/octopus.db`（票05 已灌 19 词条）经 `VACUUM INTO` 快照为 `octopus-feat-llm-wiki-loop-20261012.db`（含 wiki_articles 19 行）供实例使用——同时满足票面「隔离端口/独立 DB」与简报「使用票05数据、不清库」
- org: `xzf-dev`（wiki 根 `~/.octopus/orgs/xzf-dev/knowledge/wiki`，19 词条 + 1 新判例）
- Timestamp: 2026-10-12T13:23Z 起（ISO，见各步骤）

## Provider 真跑闸（反假跑前置）

- `ANTHROPIC_API_KEY` 未设；`~/.claude/settings.json` env 段含 `ANTHROPIC_AUTH_TOKEN`（len 116）+ `ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic`（Anthropic 兼容真端点）。Claude SDK provider 读取顺序 `process.env → ~/.claude/settings.json → global login`（`packages/providers/src/claude/provider.ts:45-66`），本环境走 settings 通道
- 真实连通证明①：`POST /api/system/models/test {"provider":"claude","model":"sonnet"}` → `{"success":true,"latency":5924}`（`OCTOPUS_MOCK_PROVIDERS` 未设，非 mock 分支）
- 真实连通证明②：执行 JSONL 内 SDK 回传真实用量（`wiki-explicit.jsonl` 第17行）：
  `{"event":"agent_event","event_data":{"type":"turn_usage","turn":3,"cumulative":{"inputTokens":18,"outputTokens":1731,"cacheReadTokens":70162,"cacheCreationTokens":36635}}}` —— 含 cache 记账的真实推理流
- 结论：**真 provider 真跑，非模拟**

## 执行矩阵（6 次执行，全部真实）

| # | executionId | workspace | 形态 | 结果 |
|---|---|---|---|---|
| 1 | `1f82ffc0-b47c-4dd9-a405-255cdc55312f` | e2e13-knowledge-loop (`d9624f25`) | 双 agent 节点：`as: workflow-operator` + 缺省节点；均**无** skills 声明（缺省零改动探针） | completed；wiki_refs 2 条落 VarPool+DB |
| 2 | `3cde5298-1236-489c-903c-d578e3101f3d` | e2e13-knowledge-loop-2 (`c3a8baef`) | 同上但双节点 `skills: [octo-wiki]` 声明 | completed；octo-wiki 预置成功、`Skill(octo-wiki)` 工具调用出现；**wiki_refs 未落池（缺陷 D1 实锤）** |
| 3 | `9513829b-0c53-4760-b4d3-cabb5b88cf74` | e2e13-knowledge-loop-3 | D1 修复复测①（改了 core-pack/agent 层源，未中预置源） | completed；wiki_refs 未落（预置源是 `~/.octopus/resources/installed/skills/built-in/`） |
| 4 | `3e8ca8da-674a-4470-9f51-9b6959a0b75b` | e2e13-knowledge-loop-4 (`6faa6b4b`) | D1 修复复测②（预置源同步修正） | completed；**wiki_refs=["case-e2e13-001"] 落 VarPool → fix-verified** |
| 5 | `00825346-9497-4715-b397-0c557bcf3d1d` | e2e13-regression (`cfbcb54c`) | 回归：(a) 无 `as:` 普通 agent 节点 (b) `octopus_agent` 委托 task-doer | completed；见「回归」 |
| 6 | `93635166-e378-4b9d-b4df-fba121f85783` | e2e13_rerun_1791813809721 (`83dcef6f`) | e2e-harness 复跑脚本全程自证 | **9/9 ALL PASS**；wiki_refs 6 条全带真实锚点 |

## 判例（cases 域）入档 —— 经应用唯一写闸

简报要求判例经 curate/compile 通道产生（禁手写旁路）。实况：本集成版**判例类型无 HTTP 入口**——`review.ts approveItem` 分派仅 `wiki-split|wiki-edit|rule→策展`（`packages/server/src/services/knowledge/review.ts:51-79`），`WikiCurateService` createEntry 走 `parseEntryMarkdown`（词条形态，`wiki/curate.ts:463`），spec「本期 Web 只读」（spec.md Web-UI 节），判例队列触发属 P3 归档流。因此以**同一唯一写闸** `WikiCompileService.compileEntry` 直驱（与票04/06 生产代码完全同路径：L5/L1 闸+INDEX 重建+LOG append+wiki_fts 同步+git commit；vitest 一次性驱动脚本，跑毕即删）：

```
E2E13_COMPILE_RESULT={"id":"case-e2e13-001","domain":"cases","path":"cases/2026-10-12-pnpm-lockfile-mismatch.md","anchors":[],"warnings":[],"commit":"dcec4866fd31ed5a5b05a121fc6108750409e2bf","changed":true}
```

- 判例内容 = 本仓真实事故 `commit:82d96372`（pnpm9 读 v10 lockfile → LOCKFILE_CONFIG_MISMATCH），五段齐（现场/诊断/根因/修复/教训），准入「真实+可定位」
- INDEX.md 重建行：`- cases/2026-10-12-pnpm-lockfile-mismatch.md — CI 报 LOCKFILE_CONFIG_MISMATCH｜tags: ci,pnpm,lockfile｜未蒸馏`
- LOG.md：`| 2026-10-12 | case+ | cases/2026-10-12-pnpm-lockfile-mismatch.md | E2E 票13 判例入档 | commit:82d96372 | e2e13 ✓ |`
- git（wiki 独立仓库）：`dcec486 case+: cases/2026-10-12-pnpm-lockfile-mismatch.md — E2E 票13 判例入档`
- search API 命中（FTS 同步生效）：`{"id":"case-e2e13-001","domain":"cases","title":"CI 报 LOCKFILE_CONFIG_MISMATCH",...,"status":"open"}`

## Evidence 1 — JSONL 导航序列（INDEX→词条，非跳 INDEX glob）✓

执行 1（显式 `as:` 节点）`wiki-explicit.jsonl` 原行（截断标注 [...]）：

```
4:{"event":"tool_call","nodeId":"wiki-explicit","toolCallId":"toolu_becee9897a284d95b274ab4e","toolName":"Read","input":"{\"file_path\":\"C:/Users/EDY/.octopus/orgs/xzf-dev/knowledge/wiki/INDEX.md\"}","result":null,"isError":false,"startedAt":"2026-10-12T13:34:43.801Z",...}
6:{"event":"tool_call",...,"toolName":"Read","input":"","result":"{\"type\":\"text\",\"file\":{\"filePath\":\".../wiki/INDEX.md\",\"content\":\"# Octopus Knowledge Wiki — xzf-dev\\n\\n> Agent 导航协议：先读本索引 → 选词条整读 → 未命中再 search API。禁止全库遍历。...","numLines\":35,...}",...}
10:{"event":"tool_call",...,"toolName":"Read","input":"{\"file_path\":\".../wiki/projects/prj-open-octopus.md\"}",...}
12:{"event":"tool_call",...,"toolName":"Read","input":"{\"file_path\":\".../wiki/workflows/wf-prd-impl.md\"}",...}
```

缺省节点（执行 1 `wiki-default.jsonl`）同型：Read INDEX.md → **Read `cases/2026-10-12-pnpm-lockfile-mismatch.md`**（判例检索命中即整读，卡壳走判例的 P1 语义活证）。执行 6 复跑脚本断言同样通过（seq = INDEX → prj-open-octopus → wf-prd-impl）。

技能驱动旁证（执行 2 `wiki-explicit.jsonl`）：`READ {"skill":"octo-wiki"}` —— agent 经 Skill 工具加载 octo-wiki 确认上报格式；`__engine_init__.jsonl`：`Provisioning 1 missing resource(s) from scan: skill:octo-wiki` → `Provisioned ... successfully`（预置链真跑）。

## Evidence 2 — wiki_refs 落 VarPool/DB 且锚点真实存在 ✓

DB `executions.var_pool`（sqlite3 原样）：

```
执行1: "wiki_refs":["wf-prd-impl#oct-008","wf-prd-impl#oct-014"],"note":"case-e2e13-001 为本症状直接命中词条，但未蒸馏、无锚点id，故无法以 <词条id>#<锚点id> 形态收录；引用见正文 [ref: case-e2e13-..."
执行4: wiki_refs":["case-e2e13-001"]}
执行6: wiki_refs":["wf-prd-impl#oct-008","wf-prd-impl#oct-009","wf-prd-impl#oct-011","wf-prd-impl#oct-012","wf-prd-impl#oct-013","prj-open-octopus#oct-007"...]
```

锚点存在性（`wf-prd-impl.md` 编译产物原文）：

```
14:- 修改 shared/ 下任何代码后，必须先 `pnpm build` shared 包，否则 engine/cli/server 等下游包会引用旧的编译产物 <!--#oct-008-->
26:- 实现 PRD 功能后，先运行 `pnpm test` 确保 vitest 全部通过，再运行 `pnpm build` 确保所有包编译无错误 <!--#oct-014-->
```

（执行 6 由脚本对每个 `词条id#锚点` 在盘上断言 `id: <entryId>` + `<!--#anchor-->` 双存在，PASS。）节点产出正文含 `[ref: oct-008]`/`[ref: oct-007]` 等标注（JSONL `text_block` 原行见执行记录），引用纪律完整。

## Evidence 3 — /wiki 可见被引词条 + 元数据非空 ✓（API 面 + 页面 200；未跑浏览器截图，票面允许 API）

`GET /api/knowledge/wiki/article/wf-prd-impl?org=xzf-dev`：

```json
{"id":"wf-prd-impl","domain":"workflows","title":"prd-impl 工作流知识","stability":"stable","confidence":0.8,
 "sources":["doc:knowledge/workflows/prd-impl.md","archive:manual@2026-07-02"],
 "anchors":["oct-008","oct-009","oct-010","oct-011","oct-012","oct-013","oct-014","oct-015"],
 "gitHistory":[{"hash":"169a76d","date":"2026-10-12","message":"compile: workflows/wf-prd-impl.md — 初始编译 workflows/prd-impl.md → +8 条规则（oct-008,...,oct-015）"}]}
```

`GET /api/knowledge/wiki/article/case-e2e13-001?org=xzf-dev` → `case:{symptom:"CI 报 LOCKFILE_CONFIG_MISMATCH",tags:[ci,pnpm,lockfile],severity:blocker,occurrences:1,status:open}, sources:["commit:82d96372..."], gitHistory:1 条`。web 实实例 `http://127.0.0.1:3410/wiki` → HTTP 200 `<title>知识词条 - Octopus</title>`（渲染级验证由票03 组件测试 987 基线覆盖，浏览器截图本轮预算外）。

## Evidence 4 — 影子对照导出真实行（READ-ONLY 四象限）✓

执行 1 `GET /api/workspaces/d9624f25.../executions/1f82ffc0.../shadow-compare`（JSON 原样，截注）：

```json
{"executionId":"1f82ffc0-b47c-4dd9-a405-255cdc55312f",
 "injectSide":{"relevant":["projects/octopus-demo-service-admin-001","...共15条...","prd-impl-8"],"injected":[]},
 "querySide":{"refs":["wf-prd-impl#oct-008","wf-prd-impl#oct-014"],"queried":["wf-prd-impl#oct-008","wf-prd-impl#oct-014"],"stale":[]},
 "quadrants":{"hit":[],"miss":["...relevant 全15条..."],"injectOnly":[],"queryOnly":["wf-prd-impl#oct-008","wf-prd-impl#oct-014"]},
 "metrics":{"injectedCount":0,"queriedCount":2,"hitCount":0,"staleCount":0}}
```

象限符合「where expected」判读：mode=both 下旧注入链照常预计算（relevant=15，haiku 旧口径 id），但 fixture 节点无 `knowledge_scope` 且未走 pipeline prompts ⇒ 实际注入为空（injected=[] 如实），查阅侧独立产出 2 条新格式锚点引用 ⇒ queryOnly 承载全部对照信息。两侧 id 体系不同（旧 `prd-impl-N` vs 新 `entry#oct-NNN`）⇒ hit 恒空属**预期数据面**，正是 P2 决策要的实证。执行 6（修后）querySide.refs 6 条同型 PASS。

## 回归 ✓

- (a) 无 `as:` 流无回归：执行 1/2 缺省节点（无 as）均 completed；执行 5 `plain` 节点输出 `"last_output":"regression-ok"`，DB `node_executions` 状态 completed
- (b) `octopus_agent` 重量级委托保持：执行 5 `delegated`（agent: task-doer, Task Contract brief+constraints）→ `"outputs":{"last_output":"delegated-ok","session_id":"48b57499-cfac-40ed-884d-5c4ab7ad90ca","agent_version":"current","agent_name":"task-doer","task_brief":"..."}` —— 委托会话+结构化返回字段俱在

## 缺陷发现（真缺陷，非纸糊）

**D1（合并票 11×12 接缝，已现场验证修复）— octo-wiki SKILL.md 引用纪律示例与 vars_update 解析器语法不兼容，agent 照抄示例即静默丢引用。**
- 缺陷点：`packages/core-pack/skills/octo-wiki/SKILL.md:29`（`.claude/skills/octo-wiki/SKILL.md:29` 镜像同）示例为 YAML 行式 `- 收尾时 vars_update 写入: wiki_refs: [...]`；解析器只吃 JSON 三形态（`packages/engine/src/executors/parse-vars-update.ts:8-12`），YAML 行式无任何告警丢弃
- 复现：执行 2（agent 真加载 skill 并按示例收尾）→ var_pool 无 wiki_refs、shadow querySide.refs=[]；执行 1（prompt 直给、agent 自发 JSON 形态）则落池
- 修复（本 E2E 已验证，未提交）：SKILL.md:29 改为 `- 收尾时输出单行 JSON：{"vars_update": {"wiki_refs": ["prj-octopus#oct-007", "wf-prd-impl#sop-002"]}}（引擎只解析 JSON 形态，勿用 YAML 行式）`，且需同步三处源：repo core-pack、repo `.claude/skills` 镜像、**运行时预置源 `~/.octopus/resources/installed/skills/built-in/octo-wiki/SKILL.md`**（执行 3 证明改前两处不生效——预置 directCopy 取自 resources/installed）。执行 4/6 全链通过
- 建议增强（未做）：applyVarsUpdate 对含 `wiki_refs` 字样的未解析块发 warn（静默丢是最大隐患）

**D2（缺省身份技能的预置语义与 handoff-12 表述不符）— 无 `skills:` 声明的 agent 节点不会把 octo-wiki 实体化进 workspace，技能不可被 SDK 发现（身份 persona/白名单仍装配）。**
- 实况：执行 1（无声明）`.claude/skills/` 无 octo-wiki（导航靠任务书 prompt 完成，闭环仍通）；执行 2（声明后）engine_init 日志显式 `skill:octo-wiki` 预置 + agent `Skill(octo-wiki)` 调用。预置分析只读 YAML 声明（`packages/engine/src/engine-init.ts:325-379` + `shared/src/resource/resource-preflight.ts:108-115`），identity snapshot.skills 仅进 SDK 白名单（`engine/src/executors/identity-assembly.ts:66-70`），不触发文件物化
- 影响：spec 故事 22「未写 as: 默认装配…零改动获得知识查阅能力」只在「persona+任务书指针」语义下成立；若期待「skill 文件自动在场」则缺省节点断。handoff-12 的「shared-tier octo-wiki provisioned at exec」对缺省节点**不成立**——需裁决：预置器补 identity-skills 联动（改法在 EngineInitPhase 合并 snapshot.skills 进 analyze 集），或接受 prompt/persona 为缺省通道并修订 handoff 表述
- 本 E2E 处置：主流 fixture 显式声明 `skills: [octo-wiki]`（作者路径），缺省形态已由执行 1/5 覆盖回归；不在本轮改引擎（非 quick fix 域）

**环境/杂项（非缺陷，留档）**：同名 workspace 可重复创建（`b1af0788`/`c3a8baef` 同路径双行，已删冗余行）；判例 HTTP 写入口缺位属 P3 计划内；`VACUUM INTO` 快照使默认库全程零写入。

## Story → Evidence 映射（供 matt-verification-report 消费）

| spec 故事簇 | 票 | E2E 证据指针 | 判定 |
|---|---|---|---|
| 1-5,32 /wiki 浏览/元数据/检索/健康 | 03 | Evidence 3 article/search/tree API + 200 页面（渲染细节由组件测试） | PASS |
| 6-16 词条格式/lint/INDEX/LOG/编译闸/初始编译 | 01,02,05 | 判例 compile 全产物（Evidence「判例」节 commit/INDEX/LOG 行）；19 存量词条树（tree API）；INDEX 被 agent 读到的 llms.txt 原文（Evidence 1 行6） | PASS |
| 15-20 cases 域/检索兜底/判例查阅 | 04 | 判例经唯一闸入档 + FTS 命中 + 执行 1/4 wiki-default 按症状读判例、引用 `case-e2e13-001` | PASS |
| 17-19 导航协议/引用纪律/上报 | 11 | Evidence 1（INDEX→词条序列）；Evidence 2（[ref:] + wiki_refs）；D1=引用纪律格式缺陷（已修验证） | PASS-WITH-DEFECT(D1) |
| 21-25 as:/缺省 operator/硬闸/版本 | 08-10 | 执行 1/2 显式+缺省双节点 completed；执行 5 回归；`as:` 过 engine-init L3 闸（未触发拒绝路径=可解析为正证；拒绝路径由票10 测试覆盖） | PASS |
| 26-27 task-author/doer 指针行 | 11 | 本轮 E2E 未走 task-board 通道（指针行由票11 chat test 钉死） | 不在 E2E 面（留档） |
| 29 预置进 .claude/skills | 11 | 执行 2 `__engine_init__.jsonl` Provisioned 行 + Skill(octo-wiki) 调用 | PASS（声明式；缺省联动见 D2） |
| 30-31 双轨影子/对照导出 | 12 | Evidence 4 全 JSON + metrics；`__relevant_rule_ids`/`__injected_rule_ids` 读只证 | PASS |

## 反假跑核查 R1-R8

- [x] R1 真服务：dev 实例真进程（pid 39052/3411，`/api/actuator/health` mode=isolated branch=feat-llm-wiki-loop-20261012）
- [x] R2 业务断言：锚点逐条对词条原文、判例五段、引用计数、Task Contract 字段（非 200 即过）
- [x] R3 交叉验证：JSONL（文件）↔ var_pool（DB）↔ shadow-compare（API）↔ article（盘+git+DB）四方一致
- [x] R4 证据 ≥2：JSONL 原行、DB 原行、API JSON、git/LOG/INDEX 行均贴文
- [x] R5 副作用验证：判例写入 → git commit dcec486 + INDEX/LOG/FTS/DB 行 + search API 命中
- [x] R6 真实通路：无 Bearer 体系可走（路由无鉴权面，`/api/agent/*` 才需），provider 走 settings 真 token 真网络（latency 实测）
- [x] R7 数据隔离+可识别：全部 `e2e13-*`/`E2E13_RERUN_*` 前缀；**故意保留不删**——报告证据指针依赖它们可复核（与 R7「跑后清理」的偏差声明于此；清理动作=删 5 个 fixture workspaces 即得，DB 执行行留审计）
- [x] R8 可重跑：`node C:/tmp/llm-wiki-notes/e2e13/e2e13-rerun.mjs 3411` → **实测 9/9 ALL PASS**（执行 6 即该脚本产物）；fixture YAML 全文存 `C:\tmp\llm-wiki-notes\e2e13\e2e13-knowledge-loop.yaml`

## 复现步骤

1. `cd C:\xzf\ai\open-octopus\.worktrees\integration`（@eccbd6cb，已 build）
2. 种子：`sqlite3 ~/.octopus/db/octopus.db "VACUUM INTO '~/.octopus/db/octopus-feat-llm-wiki-loop-20261012.db'"`
3. `pnpm dev --port 3410,3411 --skip-build`
4. （如判例不在）跑一次性驱动（方法见「判例入档」节，或手工经 compileEntry）——已入档则跳过（幂等重入=changed:false）
5. `node C:/tmp/llm-wiki-notes/e2e13/e2e13-rerun.mjs 3411` → 期望 9/9 ALL PASS
6. 拆机：`pnpm kill:port 3411; pnpm kill:port 3410`，netstat 复核（三段式）

## 清理与残留

- 集成 worktree：`git status` 干净（驱动脚本、SKILL.md 修复均不提交，修复 diff 全文在上 D1）
- 端口：3410/3411 收尾已 kill 并 netstat 复核（见文末状态）
- 保留（审计面）：fixture workspaces×5 + 执行行×6 + wiki 判例 commit dcec486 + 运行时 skill 修复文本（core-pack 源修复应由主线票落地后自然覆盖）
- 默认库 `octopus.db`：全程只读（VACUUM INTO 快照源）

## Conclusion

**PASS-WITH-CAVEATS** — P0+P1 闭环四证据（JSONL 导航序列 / wiki_refs 落池+锚点真实 / /wiki 可见+元数据 / 影子四象限）全部真跑取得，回归 (a)(b) 通过，复跑脚本 9/9。两处缺陷入册：D1（skill 示例格式×解析器，一行修复已现场验证，待主线提交）、D2（缺省身份节点的 skill 物化依赖显式声明，handoff-12 表述过强，需裁决）。无假跑成分。


---

## Fix-Verification Addendum (post code-review)

> 2026-10-12T15:15–15:45Z 复跑 — 针对首跑缺陷 D1/D2 + 评审修复项（L6-wire / precompute-query-gate / loop-mode / review-approve-compat）的**运行时**再验证。
> Host: `.worktrees/integration` @ `65f7f9e2`（含 `39e36618` engine 簇 + `75f567ae` server/web 簇；dist 构建于 23:03，未重建；全程未 commit，收尾 `git status` 干净）
> 环境: `pnpm dev --port 3420,3421 --skip-build`（web=3420 server=3421；保护端口未触碰）。DB 默认库 `octopus.db` 全程只读（VACUUM INTO 源）；实例落分支库 `octopus-feat-llm-wiki-loop-20261012.db`（dev.mjs custom-port 模式固定取分支库名——先 `VACUUM INTO octopus-feat-wiki-verify.db`（任务指定快照件，保持未动），首跑审计库 db/-wal/-shm 三件套整体改名保留为 `...-audit20261012.db*`，再以快照副本起步实例）。
> org=`xzf-dev`。fixture 前缀 `verify_*`；证据总集 `C:/tmp/wiki-verify-fix/`（evidence.json / dev.log / snapshot.json / 脚本）。

### Provider 真跑闸（反假跑前置）— 真

- `POST /api/system/models/test {"provider":"claude","model":"sonnet"}` → `{"success":true,"latency":5656}`；`model:"haiku"` → `{"success":true,"latency":4386}`（`OCTOPUS_MOCK_PROVIDERS` 未设）
- 后续 7 次真实执行（下表）全部真模型跑；L6 judge 的 haiku 调用在 approve 请求内计时可证（11.0s vs 3.6ms，见点 5/6）

### 运行时预置源处置（与首跑的差异，须知）

首跑曾手工改 `~/.octopus/resources/installed/skills/built-in/octo-wiki/SKILL.md`。本轮改走**官方升级原语**：一次性 node 驱动 `ResourceManager.installOrUpgrade({ref:"builtin:octo-wiki", corePackBase=<worktree>/packages/core-pack})`（即 `octopus setup` 所用同一函数，`setup-runner/index.ts:1164`）→ `UPGRADE_RESULT=...status:"installed"`，diff 判定 **IDENTICAL-TO-REPO-FIX**（运行时预置源字节=repo 修复版）。
留档发现：**服务重启不会同步该源的内容**——`registerBuiltins()` 仅自愈 phantom 目录（`resource-manager.ts:964+` existing→skipped）。故 D1 的 SKILL.md 修复要落到运行时，必须走 setup/resource upgrade（主线发版时天然发生；本仓文档未写明，建议入 CODING/部署注记）。旧版运行源已备份 `C:/tmp/wiki-verify-fix/backup/octo-wiki-SKILL.pre-upgrade.md`。

### 逐点判定（7 次真执行 + 2 次真 approve + 复跑脚本）

**1. D1 — corrected SKILL.md example lands refs：PASS**
- 执行 `verify_d1a`（`as: workflow-operator` + `skills:[octo-wiki]`，prompt 只说「按 SKILL.md 引用纪律收尾」不告诉格式）：engine-init `Provisioning 1 missing resource(s) from scan: skill:octo-wiki`→`Provisioned ... successfully`；workspace `.claude/skills/octo-wiki/SKILL.md` **bytes-equal-repo=true**（29-31 行=修复版三行 JSON 示例）；agent 照抄新 JSON 结构 → `executions.var_pool.wiki_refs=["wf-prd-impl#oct-008"]`，shadow `querySide.refs=["wf-prd-impl#oct-008"]` 非空
- 静默丢终结：执行 `verify_d1w`（prompt 强制旧 YAML 行式 `wiki_refs: [...]`、禁 JSON）→ var_pool **无 wiki_refs**、querySide.refs=[]，且 server 日志出现告警（dev.log:126，d1w 节点窗口内全库唯一）：`[vars_update] 输出中提到 vars_update/wiki_refs，但未解析到任何 JSON —— 未写入 VarPool。...YAML 行式无效。`（`parse-vars-update.ts:48-53` warn 真 fire）

**2. D2 — default operator auto-provisions：FAIL（修复代码在场但运行时惰性，数据契约错位）**
- 执行 `verify_d2`（**无** `skills:`、**无** `as:`）与 `verify_d1w`（`as:` 但无声明）：`__engine_init__.jsonl` 均为 `Analyzing resources: 0 skills, 0 agents`——**无** `Identity skills merged into provisioning set` 行；workspace `.claude/skills/` 仅 4 个其他通道技能，**octo-wiki 缺席**（首跑症状原样复现）
- 根因（实测钉死）：D2 合并读 `resolver.resolve(ref).snapshot.skills`（`engine-init.ts:437-448`）。运行时该值=**空**：启动 publish 的 `workflow-operator@1.0.0` 快照实测 `skills:[]`、而 `config.skills:["octo-wiki"]`（branch DB `json_extract` 原值）。`filesToSnapshot`（`agent-version-service.ts`）的 skills 只来自分身目录 `skills/` 子目录 readdir——`~/.octopus/agent/built-in/workflow-operator/` 盘上**无 skills/ 目录**，且产品没有任何代码给它种 skills/（`clone-init-service.ts` 仅 task-author/archive 走 fork 资产 seed；CloneDef.skills 只进 config.json 字段）。单测组用自制 `skills/` 目录过契约（engine-init.test.ts `writeIdentityWithSkills`），故全绿而运行时惰性
- 缓解事实（同一执行实测）：缺省节点仍**功能闭环**——agent 经全局共享层（`~/.octopus/agent/skills/octo-wiki`，ADR-0006 全分身继承）发现并 `Skill({"skill":"octo-wiki"})` 成功、按纪律落 refs（`querySide.refs=["wf-prd-impl#oct-011","oct-012","oct-013"]`）。即票面 AC「文件物化进 workspace .claude/skills」未达成；「零改动获得知识查阅能力」经共享层意外兜底达成
- 修法二选一（下轮）：① initSingleClone 按 CloneDef.skills 给 built-in 目录种 skills/（与其他 clone 同装机路径）；② filesToSnapshot/collectIdentitySkills 兼读 `snapshot.config.skills`（数据已在，改动面最小）

**3. precompute query-gate：PASS（含红线复核）**
- `verify_pq`（唯一 agent 节点 `as: wiki-query-mode`，分身 config.json `{"knowledge":{"mode":"query"}}`）：server 日志**零** `knowledge-precompute` 行（其余 5 流各有一条 `[knowledge-precompute] ... rules=15`）；var_pool 无 `__relevant_rule_ids/__injected_rule_ids/__user_preference_text`（全池仅 `{execution_name,workflow_name,km_probe:"pq-ok"}`）；shadow `injectSide={"relevant":[],"injected":[]}`
- `verify_pb`（`mode:"both"` 分身）：`rules=15` 预计算行在场、injectSide.relevant=15 条——现状不变
- 红线复核：`git diff eccbd6cb..65f7f9e2 -- packages/server/src/services/knowledge/precompute.ts packages/engine/src/prompt-injector.ts packages/engine/src/knowledge-injector.ts` = **空**（闸只在 engine.ts 调用点 + 新增 precompute-gate.ts）

**4. loop knowledgeMode：PASS（DB 逐节点证据）**
- `verify_loop`：loop(`max_iterations:1`) 内嵌两 agent（`as: wiki-inject-mode` / `wiki-both-mode`）。`node_executions.outputs`：loop-inject `vars_update={"inject_probe":"seen"}`（其原始文本含 `wiki_refs:[...]`，键被摘=strip 在循环内生效）；loop-both `vars_update={...,"wiki_refs":["wf-prd-impl#oct-008"]}`（同文本键保留）
- 诚实注记：loop-both 模型回合把上一节点会话里的 JSON 抄进了自己收尾（内嵌节点共享 SDK 会话的表现），内容恰好仍是 oct-008——不影响判定（判定看**键的存摘**，两条 vars_update 差集干净）；executor-factory 对齐性另见 executor-factory.ts:241/257 与 loop.ts:576-594 同构

**5. L6 judge wired：PASS（真告警已捕获；附一条可观测性发现）**
- 生产闸实证（HTTP approve `rule-e2everify-l6a`，scope=wiki + 真词条 `workflows/wf-prd-impl.md` 在盘 → 策展通道）：`{"ok":true,"newStatus":"approved"}` **11.006s**（judge 的 haiku 往返在请求内；无 LLM 的同型 git+db 路径实测 3.6ms，见点 6）；wiki 产物齐：commit `22bc98e compile: ... +oct-139 ...[review:rule-e2everify-l6a]`、LOG.md `| curator ✓ |` 行、词条 `## 策展增补` 新行、INDEX 重建
- 告警本体捕获（同生产构造 `new WikiCurateService({db,org,ruleFormJudge:createProductionRuleFormJudge()})` 一次性驱动，跑毕已删）：`L6_ONLINE_RESULT.warnings` 含 5 条真告警，样本原文：`L6: 规则 'oct-142' 为描述句——建议改写为祈使/事实陈述：「影子报表由周五下午定时任务自动生成；生成结果需人工审阅后才可用于决策。」（不阻塞）`（commit `20ca59d`）
- 离线安全：`OCTOPUS_KNOWLEDGE_LLM_DISABLED=1` → `L6_OFFLINE_RESULT.warnings=[]`、编译照常成功落 commit `33e9105`（+oct-143），零抛错
- 发现（非回归，建议 follow-up）：HTTP approve 面上**告警不可见**——`index.ts:522-524` 未接 `applyApprovedItem` 返回值，route 只回 `{ok,id,newStatus}`（LOG.md/git message 亦无 warn 列）。judge 在生产确实在跑，但「给改写稿」当前只有服务返回值层面成立

**6. review-approve no regression：PASS**
- LEGACY 行（type=rule, `scope='project'`, `target_file='projects/e2everify-legacy-target.md'`，该文件不在 wiki 根盘——isGenuineWikiTarget=false）：approve → `{"ok":true,"newStatus":"approved"}` **3.6ms**、走原纯追加通道：`knowledge/projects/e2everify-legacy-target.md` 写入 `<!-- id:e2everify-legacy-target-20261012-lE32 | ... | maintenance -->`、pending 行 status=approved、**wiki 仓库零新 commit**（未被策展/lint 闸 fail-closed）
- 真词条行同批对照（l6a）仍单闸门经策展（点 5）；user_preference 写权保护本轮未真跑（单元测试在位）

**7. Regression rerun：PASS — 既有脚本 9/9 ALL PASS**
- `node C:/tmp/llm-wiki-notes/e2e13/e2e13-rerun.mjs 3421`（未改动脚本；其硬编码 DB 路径=分支库=实例库，天然对齐）→ `PASS|health`、`PASS|provider real ping`、`PASS|create/upload`、`PASS|execution completed`（exec `27d1f223`）、`PASS|evidence1 INDEX first→entry reads`、`PASS|evidence2 refs+anchors`（6 条全真锚点）、`PASS|evidence4 querySide.refs`、`PASS|evidence3 article`（sources 含本轮 5 条 review:rule-e2everify-l6a..e，git 历史+5）——`Total:9 Passed:9 Failed:0`

### 判定汇总

| 点 | 判定 |
|---|---|
| 1 D1 示例落 refs + 告警 | **PASS** |
| 2 D2 缺省自动预置 | **FAIL**（代码在场、运行时惰性：snapshot.skills 空、octo-wiki 只在 config.skills；见上根因与两种修法） |
| 3 precompute query 闸 | **PASS** |
| 4 loop knowledgeMode | **PASS** |
| 5 L6 judge 接线 | **PASS**（附 HTTP 面告警不可见的 follow-up 发现） |
| 6 legacy approve 回归 | **PASS** |
| 7 复跑脚本 | **PASS 9/9** |

**Overall: PARTIAL — 6/7 项运行时确认修复成立；D2 按其票面 AC（缺省身份技能文件物化进 workspace）仍未达成，属修复的数据契约缺口（非本环境特有：任何 initSingleClone 未种 skills/ 的 built-in 分身同样惰性）。**

### 残留与清理（本轮）

- worktree `git status` 干净（一次性驱动脚本 `verify-tmp-l6.test.ts` 跑毕即删；未 commit 任何文件）
- 端口 3421/3420 收尾 kill:port + netstat 三段式复核（见下）
- 探针分身目录 `~/.octopus/agent/clones/wiki-{query,both,inject}-mode` 本轮结束删除（其证据已在 evidence.json / node_executions 落盘）
- 保留（审计面）：`verify_*` fixture workspaces×7、执行行×8（含复跑）、pending_review 种子行×2（l6a/lgc，approved 态）、wiki compile commits `22bc98e..33e9105`（wf-prd-impl +oct-139..143）、首跑审计 DB（`...-audit20261012.db*`）、任务快照 DB（`octopus-feat-wiki-verify.db`，未动）、octo-wiki 运行源=repo 修复版（经官方 upgrade 原语，含 registry hash 更新）
- 默认库 `octopus.db`：全程只读（VACUUM INTO 源）
