# E2E Test Report — 归档资产化 P3 票09 全链真跑验收

## Basic Info

- Target: P3 五链全链（① 归档素材包 / ② 判例自动提取 / ③ skill 草案→授予→执行→撤销 / ④ 语义摘要搜索 / ⑤ 清理账复验）+ 票 01–08 集成认证
- Mode: API Integration + 真实 provider 工作流执行 + JSONL/DB/FS/GIT/Lane A 卡片 六面交叉验证（matt-e2e-test-methodology R1-R8 · e2e-harness 复现模式）
- Host: `C:\xzf\ai\open-octopus\.worktrees\aa-int` @ `feat-archive-assets-20261014`（tip=c912634e GLOSSARY docs commit 起步；验收中新增修复 commit **27fe2e08**（D-aa16-1，见缺陷节）；`git status` tracked 零未提交改动；未跟踪 `packages/server/dist-scripts/` 为票05/10 既有产物）
- 环境: dev 实例 `pnpm dev --port 3410,3411 --skip-build`（web=3410 server=3411；`mode=isolated branch=feat-archive-assets-20261014`，gate 原行 pid=31848→修复重启后 pid=20124；**保护端口 3000/3001/3098/3099 全程无监听未触碰**）
- 分支库: `octopus-feat-archive-assets-20261014.db` VACUUM 播种自默认库（对账后态，user_version=54、pending_review 已不在表集）；**默认库 `octopus.db` 全程零直写**（实例经 dev.mjs isolated 走分支库；脚本 SQL 显式分支库路径；health `components.database.details.path` 原行为证）
- 知识根: **全局真根 `~/.octopus/knowledge`（真盘真 git）**——E2E 写入即生产沉淀，同 P2' 票15/e2e13 先例口径：`aa16-` 前缀 fixture 可识别、审计面保留声明（见「清理与残留」）
- 复跑: `node C:/tmp/aa-e2e16/aa16-rerun.mjs <gate|seed1|…|web|all> --run <tag>`（分步 <600s、state 续跑；**pass1 tag=`20261014P1` 全链 109 断言 105 绿**（4 红=2 个观察项声明 +2 个脚本自身读形缺陷，见反假跑节逐条处置）；**pass2 tag=`20261014P2` 非 LLM 幂等段 33 断言 32 绿**（1 红=自纠观察项，与 pass1 同）；真跑两遍全 LLM 成本高，按票面出口允许「pass2 只重跑非 LLM 幂等步」如实声明）
- 证据总集: `C:/tmp/aa-e2e16/evidence/`（results-<phase>-<tag>.json / API 原行快照 / JSONL 切片 txt / queue task 全量 / 回执 receipt / hash 对质表）+ dev 日志 `C:/tmp/aa-e2e16-dev.log`、`C:/tmp/aa-e2e16-dev2.log`
- Timestamp: 2026-10-14T12:37Z 起（实例）→ 14:25Z（pass2 完），各步 ISO 见 evidence

## Provider 真跑闸（反假跑前置）

- `ANTHROPIC_API_KEY` 未设（进程 env 探针 `false`）；`~/.claude/settings.json` env 段 `ANTHROPIC_AUTH_TOKEN`（len=116，脱敏）+ `ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic`（Anthropic 兼容真端点）；`OCTOPUS_MOCK_PROVIDERS` 未设
- 真实连通证明①：`POST /api/system/models/test` → `{"provider":"claude","model":"sonnet","success":true,"latency":6383}`（gate pass1）、`{"model":"sonnet","latency":4851}`、`haiku 4534/4864`（pass2 sonnet 6615）——latency 全非零
- 真实连通证明②：链③ 执行 JSONL `turn_usage` 原行（`evidence/run3-jsonl-turn-usage.txt`）：
  `{"event":"agent_event","event_data":{"type":"turn_usage","turn":1,"delta":{"inputTokens":…,"outputTokens":…,"cacheReadTokens":…}}}`——含 cache 记账的真实推理流
- 真实 LLM 参与步（各计时）：归档总结 summarize×3（T1/T2/T3 链内）· compilePack 首编 406s committed · rc1 剔除重编译 210s committed · 判例提取 LLM×3 任务 · 草案 c 路提议×2 + 对话改写（revise 32s dev.log 原行）· run3 执行（Skill 调用轮）· karpathy gist 真编译 4 轮（155s/230s/…）· probe1/probe2 编译 · 共 **20+ 次真 provider 往返**
- 观察：本轮 curator 模型通道（settings env alias→dashscope）对「日期入常青正文」已有纪律自觉（见链⑤自纠观察），与 P2' 票15 日两连败行为不同——同闸不同模，验收入册观察非缺陷。

## 执行矩阵

| # | 链 | pass1(20261014P1) | pass2(20261014P2 幂等段) | 关键量 |
|---|---|---|---|---|
| 0 | gate | 9/9 | 9/9（基线 pages=36） | isolated 实例 / provider ping / 分支库 v54 / 会话就位 |
| 1 | 链① 归档素材包（seed T1/T2/T3→accept→包链） | pack1 10/10 + pack2 6/6 | —（LLM 段不复跑） | 六件+总结 7 件钉序 / hash 三向互验 / arc 406s committed 触 8 页 / 剔除重编译 rc1 210s |
| 2 | 链② 判例自动提取 | case1 3/3 + case2 5/5 + case3 2/3（观察项 1） | — | caw 队列 4 件 committed / 5 判例页 / 归属 source=exec 对号 / 不双档不变式 |
| 3 | 链③ skill 草案→授予→执行→撤销 | draft3 8/9（regex 观察 1）+ run3 5/5 + revoke3 10/10 | — | a 路 flow-* 双 pack 指针 / revise 真 LLM / grant 1.0.1+三账+top-up / JSONL Skill×4 / revoke rolledBackTo=1.0.0 再跑缺席 |
| 4 | 链④ 语义摘要 | sum4 3/3 | 3/3 | semantic_summary 2074B / q=phase 命中 / 负对照 0 |
| 5 | 链⑤ 清理复验 | clean5 9/9 + selffix 2/3（观察项 1） | 9/9 + 2/3 | pending_review 表无+导出件 / kc15 12 页 _retired / INDEX ../ 可达+执行 JSONL 12 行实证 / gist 第 4 投 committed 2e50003 |
| 6 | Lane A 对话流卡 | lane 7/7 | 7/7 | material-pack/case/skill-draft 三类卡沉淀 + granted/revoked 回执 |
| 7 | web 回归 | web 3/3 | 3/3 | /wiki→307 / /knowledge→200（28160B）/ tree 6 域含 case |

## 链① 证据原行（真 task 归档→素材包六件→hash 互验→触页→剔除重编译）

- seed 真任务链（API 全程）：`POST /api/tasks` → 201 `b2d13fc1`（aa16-20261014P1-T1，v4 spec 单 phase，workflowRef=task-home `aa16-demo`）→ `PUT /:id/home-file` 写 `.scratch/aa16-t1/p1/spec.md`+issues 票（200×2；ready 闸 `phase:1:spec-missing`→`issues-missing`→过闸逐轮原行在 evidence/seed-T1-ready.json）→ `POST /ready` 200 → `POST /trigger` 200 → 派生态 `awaiting_review`（derived 原行：exec `edbadc2e` completed/round1，`evidence/seed-T1-view.json`）。**fixture 声明**：workflows/adr/context-notes 三件 home-file 白名单只放 `.scratch/**`，经 fs 直写 task home（`~/.octopus/tasks/{id}/`，ADR-0011 agent 世界的执行器落位同位；R7 `aa16-` 可识别）
- 归档资产链：`POST /acceptance {phase_index:1,round_index:1,decision:"accepted"}` → 200 → task 落 **done**（persisted=done，evidence/acc-T1-task.json；beginArchiving→fireArchiveIngest 全链触发）
- 素材包七件（fs 原行 `raw/archives/task-b2d13fc1…/`）：`01-acceptance-ledger.md` `02-phase-rejections.md`（诚实缺席件——源无打回，payload 说明在件）`03-exec-jsonl-excerpt.md` `04-pr-diff.md` `05-matt-artifacts.md` `06-adr-context-notes.md` `07-archive-summary.md` + `manifest.json`；件名钉序=MATERIAL_FILE_NAMES 契约逐字
- **hash 三向互验**（evidence/pack1-hash-check.json）：manifest items[].sha256 == 件 front-matter `hash:` == 重算 strip-front-matter payload sha256，七件全 OK（`["01…md:OK","02…OK","03…OK","04…OK","05…OK","06…OK","07…OK"]`）
- 总结+编译触页：`GET /wiki/queue/task/arc-{T1}` → `{"state":"committed","opKind":"archive-compile"}`（406s 真 sonnet）；wiki commit 含 `INDEX.md,LOG.md,sources/task-b2d13fc1….md,concepts/con-material-package.md,…,topics/…` 8 页（`git show --name-only HEAD` 原行）；LOG 行 `## [2026-10-14] ingest | 素材包 task-b2d13fc1-…`；回执页 `sources/task-{id}.md` 以包为单元 ✓
- 素材包卡：Lane A 会话消息 fence 块 `{"id":"mdp-b2d13fc1…","kind":"material-pack","data":{items:7 件含 bytes/sha256/excluded}}`（evidence/lane-kc-card-events.json + 断言「件清单=7」）
- **对话剔除一件→重编译生效**：`POST /pack/{T1}/recompile {excludePath:"raw/archives/task-…/03-exec-jsonl-excerpt.md"}` → 202 `{queueTaskId:"arc-…-rc1"}` → committed（210s）；`GET /pack` `items[03].excluded=true` + `recompiles` 审计行 1；rc 编译真落新 commit `04cebef ingest: 素材包 … 触 1 页`；再剔同件 → 409 `ALREADY_EXCLUDED`（账本一次决定面）。**语义边界如实注**：剔除=该件不再作对质源进输入（S1 钉输入面），≠从保留件（总结 07 已转述同事实）的已载知识中抹除——回执页仍可含人话转述。

## 链② 证据原行（判例自动提取+入档+卡+并档判据）

- 提取源实跑：T1 包 `03-exec-jsonl-excerpt` 含 3 行 ` :: ` 渲染关键事件（bash_stderr），`jsonlHasSequences` 命中 → LLM seam 真调用 → caw 入队；`GET /wiki/queue` 原行四件 `caw-{T1}-01`/`caw-{T2}-02/-03`/`caw-{T3}-…` 全 `opKind:"case-archive"` committed（全局串行队列第八类，id=taskId+seq 确定性）
- 判例件（fs 原行）：T1 归并 1 件 `cases/2026-10-14-case-efadbd131b.md`（front-matter `id/domain/symptom/tags/severity:minor/occurrences:1/source:"exec:edbadc2e…"/status:open`）+ 正文五段齐（`## 现场/诊断/根因/修复/教训` 正则断言 PASS）；T2 拆 2 件（019bece39f/bc4e6f911e，source 指向 a7a30c8e）；T3 再 1 件（065b4fdc65→0de82f95）。**source 全部可定位**（`exec:` 前缀 ∈ LOCATABLE_SOURCE_RE + execId ∈ 任务 rounds 归属对号）
- 判例卡 Lane A：会话消息 `"kind":"case"` id=`cse-case-*` 沉淀断言 PASS（**先存后知**：编译 committed 之后发）
- **occurrences+1 不双档（观察项，如实 PARTIAL）**：T2/T3 二次归档未触发并档——三次真 LLM 提取对同一素材输出**改写异名症状**（"探测本机后端…打不通" vs "check/probe 阶段…探针失败"），normalized-jaccard≥0.5 文本判据未命中 = **判据按设计工作**（非语义等价不并）；「同症状不双档」不变式硬断言 PASS（normalized symptom 全库唯一，cases=5 distinct=5）；并档机制本身=S1 `case-extract` 两例钉（命中→occurrences+1 不落新件）。附带收获：T2 判例正文出现「已由既有判例 case-efadbd131b 完整覆盖，不重复入判例（判例准入禁同症状同出处堆叠）」——策展读侧的引用纪律在产物里自然显形。

## 链③ 证据原行（草案三路→对话修改→授予→真实执行 Skill 调用→撤销缺席）

- **草案自然触发（两路）**：① a 路（确定性判据）T2 归档 detectForTask → `flow-a867bc4839`（source=`pack:task-7594fcdd…; pack:task-b2d13fc1…` 排序对指针，origin=`sequence-similar`）；T3 归档再 → `flow-338b716e76`（T2×T3 对）。② c 路（真 LLM 提议）同链产出 `dev-server-probe-restart` + `octo-dev-server-port-recovery`（origin=`curator-proposal`）——**归档 hook 未加任何注造即产 4 草案**（fs `drafts/skills/{name}/SKILL.md`，不进 wiki/INDEX ✓）
- 草案落位负断言：`GET /drafts/:name` content 含全文；`drafts/skills/…` 目录位=知识根非 wiki git（`wiki/` 无该文件 ✓ git status 零 wiki 侧草案痕迹）
- 对话修改：`POST /drafts/flow-338b716e76/revise {instruction:"步骤补：重启前先 netstat 检查 3001 占用"}` → 200 `{status:"draft",updatedAt 前移}`（32s 真 LLM，dev.log 原行）→ 重读正文含「netstat」✓ 且 status 恒 draft/source 逐字留
- **授予机械链（修复后，见缺陷 D-aa16-1）**：`POST /drafts/flow-338b716e76/grant {cloneName:"workflow-operator"}` → 200 回执原行（evidence/draft3-grant-receipt.json）：`{"status":"granted","version":"1.0.1","published":true,"grantedTo":["workflow-operator"],"presetSync":{"ok":true,"installPath":"…resources/installed/skills/built-in/flow-338b716e76","detail":"installOrUpgrade 三账+文件同更"}}`
  - fs/三账/DB 五面对质：live 件 `agent/built-in/workflow-operator/skills/flow-338b716e76/SKILL.md` ✓ · 预置源槽 ✓ · `registry.json` 含 `local:flow-338b716e76` 行 ✓ · `audit.jsonl` 新行 `{"action":"install_or_upgrade",…}` ✓ · **DB `agent_versions` 新行 1.0.1 published**（授予即发版）✓ · 版本目录 top-up `agent/versions/workflow-operator/1.0.1/skills/flow-338b716e76/SKILL.md` 字节在位 ✓
- **真实执行 JSONL 见 Skill 加载/调用**（票面核心，故事 21）：新 workspace（`E2E_HARNESS_TEST_aa16-grant-run-20261014P1`）+ agent 节点**零 skills 声明**（D2 身份合并自动进 provisioning）→ 执行 `4768e17f` **completed** →
  - 物化：`{ws}/.claude/skills/flow-338b716e76/SKILL.md` 在场 ✓（preflight→Provisioner directCopy 预置源槽）
  - JSONL 原行（evidence/run3-jsonl-skill-lines.txt）：`{"timestamp":…,"event":"tool_call","toolCallId":…,"toolName":"Skill","input":{…flow-338b716e76…}}` ×4 行——**SDK 原生发现零 prompt 注入实锤**
  - turn_usage 原行 ×N（真实推理）；同执行 JSONL `user_preference` 读行 ×10（INDEX 必读 `../user_preference.md` agent 可达——链⑤交叉证据）
- 撤销逆链：`POST /revoke {cloneName:"workflow-operator"}` → 200 回执 `{"status":"revoked","grantedTo":[],"version":"1.0.0","rolledBackTo":"1.0.0"}` → live 件移除 ✓ 预置源槽 uninstall ✓ **agent_versions 1.0.1→archived + rollback 1.0.0**（archive+rollback 双件套，'latest' 不再命中授予版——票05 §四.7 运行时复证）→ 新工作区再跑 `aa16-revoke-run` completed → `{ws}/.claude/skills/flow-338b716e76` 缺席 ✓ JSONL 零该技能名行 ✓（**授予可逆完整实证**）
- 回执卡：Lane A `skl-flow-338b716e76` `action:"granted"`（data.receipt 全量原行 evidence/lane-kc-card-events.json）+ `action:"revoked"` 终卡 ✓（故事 23 审计链数据面）

## 链④ 证据原行（语义摘要进任务板）

- DB 行：`SELECT semantic_summary IS NOT NULL, substr(semantic_summary,1,120) FROM tasks WHERE id='b2d13fc1…'` → `has=1`，正文=`## 验收台账` 起的整份四段总结（evidence/pack1-semantic-summary-row.json）；T2/T3 同形
- API↔DB 互验：`GET /api/tasks/:id` DTO `semantic_summary` len=2074（票06 独立字段制式=整份摘要非首段）
- 搜索命中：`GET /api/tasks?q=phase&org=xzf` → 3 hits **含 T1 id**；任务名 `aa16-20261014P1-T1` 不含 "phase" ⇒ 命中必来自摘要字段（LIKE name∨summary 判定对号）；负对照 `q=zznope-…9x` → 0 hits ✓（故事 26）

## 链⑤ 证据原行（清理账复验）

- **pending_review**：分支库 `sqlite_master` 查询 `[]`（表+3 索引全无，gate/clean5 双验）；`PRAGMA user_version=54`；蓝绿导出审计件真盘在位 `~/.octopus/knowledge/_archive/pending-review-2026-10-14T09-52-07-276Z.json`（`{"table":"pending_review","rowCount":0,"schemaVersion":53}`——导出先于删除，红线1 顺序断言的 ops 实证）；运行时死链清理面 `GET /api/review/pending` → **404**（审批路由已删）
- **kc15-* 退役**：`_retired/` 下 12 件 kc15 页全在；live 五目录零 kc15；INDEX 零 kc15 行 ✓（page-retire 通道 ops 退役态复验；本轮又经 aa16 场景 **dogfood 复跑**：`POST /wiki/retire` 5 页全 committed——含 4 fixture 页回收 INDEX 预算 + probe1 回执页）
- **INDEX 必读可达**：行原行 `- ../user_preference.md — owner 偏好（人工维护；住在知识根 = wiki 根上一级，wiki 子树内无此文件）`（D-kc15-2 新值）；`wiki/../user_preference.md` fs 在位；**agent 可达执行实证**=run3 JSONL `user_preference` 读行 ×10（链③真跑顺带验证，票面口径）
- v2 空域：wiki 根 projects/workflows/business/research 不存在、cases 在位（ensure 不再长回）；死码三件 server/src `git grep HEAD` 零代码行（唯一命中=删除说明注释）；shadow-compare 头注定稿措辞在读 + 端点保留（故事 33）
  - **P4 票05 追加注记（2026-10-15 · 红线4「归档先于删除」）**：shadow-compare 端点已于 P4 删除（端点/服务/测试全删），数据面见本文件存档原行（上行「端点保留」判语=归档时点历史状态）。删的是端点不是审计链。本注为追加，未改写原文。
- **日期源自纠真跑（karpathy gist 靶）**——结果两层，如实拆分：
  - 治愈面 ✓：gist 真入队 `POST /wiki/compile {"path":"raw/inbox/2026-10-13-karpathy-llm-wiki-gist.md"}` 第 4 投 **committed** `2e50003`（触 8 页含 sources 回执），P2' 票15 原症状「L5 日期两连败恒失败」不再复现（第 1/2 投败于 L4 预算闸，非 L5——见 D-aa16-2；第 3 投败于 L5_LINK_BROKEN 死链，非 L5_DATES——见 D-aa16-3）
  - 自纠环触发面 = **未进入（PARTIAL）**：probe2 编年体激将源（逐条强保留日期）编译产物 `concepts/con-llm-wiki-chronicle.md` 正文**零日期**，日期全落 sources 豁免页且回执页正文逐字自述「正文常青页零日期、由此回执承接」→ `L5_DATES_IN_BODY` 未触 → `warnings` 无「日期常青自纠一轮」痕迹行。自纠环机制本体=S1 `wiki-dates-selfcorrect` 8 例钉——**E2E 真跑无法在「模型已自觉」的通道上逼出回退分支，判 PARTIAL 非 FAIL（原缺陷症状治愈已实证，回退分支留 S1 兜底）**
  - dedup 快路径复证：gist 回执页 hash 命中后重投 → committed 0s no-op（票05 幂等契约运行时面）

## Lane A 对话流卡全单（票面「全部出现在知识中心对话流」数据面）

会话消息原行解析（evidence/lane-kc-card-events.json）：`material-pack`（mdp-{T1}/{T2}/{T3} 件清单卡）· `case`（cse-case-* 多枚，先存后知）· `skill-draft`（skl-{name} draft→granted→revoked 三态重放同址）——**归档对话流里四类资产（素材包/判例/草案/授予撤销回执）全部可见**；渲染级 data-testid 卡组件=S4 组件测试（票02-05 新卡群）覆盖，本报告以数据面+路由面为 E2E 证据（先例同口径）。

## 回归

- 存量 legacy 归档兼容：`GET /pack/task-dd48c3a5…` legacy 面（旧单文件通道未迁不炸）；`raw/archives/` 新旧形态并存（task-{id}/ 目录件 + dd48 单文件）
- 投喂/编译面：ingest?compile=true（probe1/probe2）正常；openFindings 0→3（T1 编译矛盾上报）→ignore→0（健康条联动真实非恒零）
- 执行链：demo bash 流×3（completed）、grant-run agent 流×1、revoke-run agent 流×1（completed）——engine 侧零回归
- 版本账：workflow-operator 1.0.0 published / 1.0.1 published→archived（授予-撤销全循环）；`applySchema 首建缺 clones.current_version_id` 预存坑未犯（分支库 VACUUM 自稳定态默认库）
- K11/done 语义：三任务 accepted→archiving→done，归档链零干预 status 判定（done 唯一写者）

## 缺陷发现（真缺陷如实入册；quick fix 范围内已现场修的按方法论处置）

**D-aa16-1（QUICK FIX 已修，commit 27fe2e08，已 push feat 分支）——授予版本账判据形状错位：`isVersionedClone` 只读 config.json 顶层 `versioned`，而 clone-init 落盘形为 `{…,config:{versioned:true}}` 嵌套位（publishVersionedBuiltinClones 判据 `def.config.versioned` 同形）。**
真盘 workflow-operator 授予 → 回执 `version:null, published:false`，agent_versions 零新行、版本目录 top-up 缺、回退/钉版链全空——故事 18/19/23 的「授予即发版」运行时未兑现。票05 S1 测试群假 home fixture 写的正是顶层形（**fixture 与实现互抄，expected 非独立真相源**——spec Testing Decisions 警惕的 tautological 形态），36/36 全绿而未检。
- 影响边界（E2E 实证）：执行面**未**殃及——授予件生效走预置源槽（installOrUpgrade ②）+ D2 provisioning，run3 Skill 调用真实发生；破的是回执/版本账/回退审计面。
- 修复=兼容双读（顶层∨嵌套）+ fixture 换真盘形状钉回归；skill-grant 13/13 + resource-preflight 36 + draft 面 83/83 绿；重启实例后二次授予实测 `version=1.0.1 published=true`+top-up+rollback 全对。
- 修复前授出的 `flow-a867bc4839` 已 revoke 撤净（回执 version:null 为历史证据保留）。

**D-aa16-2（DEFER，运营/架构）——L4 INDEX 预算闸在生产知识根已到硬顶，任何新增页的编译必败且无人工收敛路。**
真跑证据三连：gist 第 1/2 投、probe2 首投均败 `L4_INDEX_BUDGET: INDEX.md 约 839/854/806 token 超过预算 800 且 Optional 重排无法收敛`。当前真盘 INDEX 40+ 行（P2'+P3 沉淀自然推高），溢出 6 token 即全拒；报错建议「低频页移 ## Optional 或升 hub」——Optional 重排=自动已试不收敛，升 hub=无 UI/端点入口（INDEX 程序化重建，人工改写被写保护闸拒）。本轮以 page-retire 退役 5 个 fixture 页腾预算后第 4 投才过闸——退役是「删」非「分层」，治标。失败语义本身干净（回滚零副作用/锁释放/队续）。建议立票：INDEX 分层渲染真实生效（Active/Optional 两段制）或预算动态化+巡检容量预警。属渲染架构取舍非 quick fix 形，判 DEFER。

**D-aa16-3（DEFER，生命周期一致性）——page-retire 不清理活页入链 ⇒ 死链潜伏，后续编译触及引用页时 L5_LINK_BROKEN 殃及；且矛盾 finding 对手页退役后 adopt 恒 failed，唯一出路 ignore=裁决信息蒸发。**
真跑证据链：gist 第 3 投败 `L5_LINK_BROKEN: topics/prj-open-octopus.md 断链 [[top-dev-port-and-stale-lock]] 目标不存在`——死链来源=T1 归档编译写入 hub 页的 3 条矛盾标注行（fnd-* 引用被退役页）；`POST /findings/fnd-a6f743a4…/adopt` → 队列 task **failed「涉事页不在盘」** → ignore×3 收场。T1/T2 编译当夜 commit 成功仅因模型未复读死链——**地雷是延迟爆炸型**。建议立票：retire 执行体扩「入链摘除」第四路，或 finding-fix 对 not-on-disk 对手页降级单侧裁决。

**观察项（非缺陷，如实记录）**：① occurrences+1 并档在真 LLM 三路归档未自然触发（同素材三改写异名，jaccard 文本判据按设计不并）——机制=S1 钉；若运营要「语义同症状必并」需提取 prompt 注入既判例清单（运营参数留 P4）。② 日期自纠环未进入（模型自觉零日期入正文，probe2 激将亦不触）——治愈面已证。③ run3 首跑（修复前）授予件即经预置源通道完成物化+调用——D-aa16-1 影响面收窄的执行侧证据。

## 35 故事 → 证据映射（verification-report 素材）

| 故事 | 主题 | E2E 证据指针 | 判定 |
|---|---|---|---|
| 1 | 素材包整体落 raw（目录+manifest 六类） | 链① 七件钉序 fs 原行 + manifest.json | PASS |
| 2 | 每件带来源与 hash（不可变冻结契约） | pack1 hash 三向互验 7/7 OK | PASS |
| 3 | 归档卡列素材清单（件+大小） | lane 素材包卡 items=7 数据面；渲染=S4 | PASS（数据面） |
| 4 | 对话「重点看 X 段」焦点重编译真取段 | focus 面未真跑（剔除件≠focus）；=票02 S1 焦点下钻 | 不在 E2E 面（声明） |
| 5 | 对话剔除某件→重编译生效 | pack2 202→rc1 committed→excluded 显形+409 | PASS |
| 6 | manifest 先行按需下钻 | 编译 406s 触 8 页（包为单元）；预算显形=S1 | PASS（间接） |
| 7 | 摘录纪律（关键事件/stat+指针不膨胀） | 03 件=3 行关键事件形；04 件诚实缺席形 | PASS（件形） |
| 8 | JSONL 报错→修复序列自动产判例五段 | 链② caw committed+五段齐 source=exec | PASS |
| 9 | 打回记录产判例草案 | 本 fixture 无打回（诚实缺席已跑）；rejected 源=票03 | 不在 E2E 面（声明） |
| 10 | 宽松准入+归档卡通知不先问 | cases 自动入档零审批 + cse 卡先存后知 | PASS |
| 11 | 判例卡五段预览/退役/改写 | 卡数据面 sections+source ✓；retire 钮面=票03 S2/S4 | PASS-数据面 |
| 12 | 检索命中率随归档自然增长 | cases 1→5 自然增长；消费面=票03 | PASS（间接） |
| 13 | occurrences≥2 巡检积压 finding | 未自然触发并档（观察①）；=S1 钉 | 不在 E2E 面（声明+观察） |
| 14 | 判例入档经全局串行队列 | caw opKind=case-archive 全 committed 无旁路 | PASS |
| 15 | 三路检测产草案 | a 路×2 + c 路×2 自然触发（零注造）；b 路=巡检未跑 | PASS（两路实证） |
| 16 | 草案卡 SKILL.md 全文预览 | GET /drafts/:name 全文 + skl 卡 | PASS（数据面） |
| 17 | 对话修改草案→再预览 | revise 32s 真 LLM→正文含新指令 | PASS |
| 18 | 一键授予+发布现行版可回退 | grant→agent_versions 1.0.1（修复后）+revoke 实测 | PASS（经 D-aa16-1 修复） |
| 19 | 机械链=目录+upgrade 原语+发版 | live/槽三账/发版/top-up 五面全对 | PASS |
| 20 | 授给所有=共享层 | `*` 路径未真跑；=票05 S3 共享层组钉 | 不在 E2E 面（声明） |
| 21 | 下次执行 SDK 原生发现加载调用 | run3 JSONL toolName:"Skill" ×4 + 物化件 | PASS（核心） |
| 22 | 撤销=回退+目录移除+预置源同步 | rolledBackTo=1.0.0+1.0.1 archived+缺席+再跑零加载 | PASS |
| 23 | 授予/撤销卡片回执 | skl 卡 action=granted（receipt 全量）+revoked 终卡 | PASS |
| 24 | 草案存 drafts 区不入 wiki/INDEX | drafts/skills 四件；wiki git 零草案痕迹 | PASS |
| 25 | 归档后 metadata 带语义摘要 | semantic_summary 2074B（DB+DTO 互验） | PASS |
| 26 | 任务板搜索命中摘要字段 | q=phase 命中 T1（名不含词）+负对照 | PASS |
| 27 | 默认库对账第一动作 | ops 前置（bak-pre-p3-reconcile 备份件为证）；播种前提 | PASS（ops 面） |
| 28 | pending_review 物理 drop（导出先删） | 表/索引全无+_archive 导出件+/api/review 404 | PASS |
| 29 | 死码三件/空 v2 目录清理 | git grep 零代码行+v2 空域 absent+cases 在 | PASS |
| 30 | D-kc15-1 日期自纠治愈 | gist committed 2e50003；自纠环未触（观察②） | PARTIAL |
| 31 | D-kc15-2 INDEX 必读可达 | 新行+../ 件在盘+执行 JSONL 读行 ×10 | PASS |
| 32 | kc15 沉淀经对话退役（dogfood） | _retired 12 页+本轮 aa16 再 retire 5 页 committed | PASS |
| 33 | shadow-compare 冻结只读保留 | 头注定稿+在读+零新消费者（S1 负断言） | PASS（静+读面） |
| 33† | **P4 票05 追加注记（2026-10-15）** | 端点已于 P4 删除，数据面见本文件存档原行（本行为追加注记非验收故事，33 原行未改写） | NOTE |
| 34 | 全链演示 | 链①-③ 全程原行闭环 | PASS |
| 35 | 复跑脚本化+反假跑+故事映射 | aa16-rerun.mjs 两 pass+本报告 | PASS |

## 反假跑核查 R1-R8

- [x] R1 真服务：health 原行 `mode=isolated branch=feat-archive-assets-20261014` pid=31848/20124（重启前后两枚），DB=分支库路径原行
- [x] R2 业务断言：全字段级（hash 三向/commit 行/occurrences/source 对号/五段正则/receipt.version/queue state/toolName），非 200 即过
- [x] R3 交叉验证：链① API↔FS↔DB↔git；链③ API↔FS(三账)↔DB(versions)↔JSONL；链⑤ API↔DB↔FS↔git——每 AC≥2 层
- [x] R4 证据≥2：每链≥3 类原行（evidence/ 全量快照）
- [x] R5 副作用验证：写链全链 DB/fs/git/卡片四路对质；失败链零副作用（L4 三连败 git 净/队续；finding-fix failed 无半成品页）
- [x] R6 真实通路：任务链全程 REST（ready/trigger/acceptance 闸逐轮真过）；Lane 会话产品通道；provider 真 token 真网络；**seed 三件 home fixture fs 直写=白名单限制下与 agent 执行器同位落位，报告声明制**
- [x] R7 数据隔离+可识别：任务/workflow/工作区/页名全 `aa16-` 或 `E2E_HARNESS_TEST_` 前缀；**审计面保留不删**（真 git 真盘=生产沉淀，先例口径偏差声明见清理节）；默认库零直写
- [x] R8 可重跑：分步脚本 state 续跑（seed1/draft3 首轮缺陷已现场修脚本并复跑证明）；pass2 幂等段实测；新环境从零=复现步骤节
- 处置记录（诚实账）：pass1 4 红中 2 红为**脚本自身读形缺陷**（seed1 derived 键名、draft3 regex 窗口）——均已修并以 seed2/seed3 全绿+lane 同断言 PASS+手动解析三重证实；2 红为**观察项声明**（并档/自纠未触发）。无假跑成分。

## 复现步骤

1. `cd C:\xzf\ai\open-octopus\.worktrees\aa-int`（@≥27fe2e08 已 build；改码后 `pnpm --filter @octopus/server build`）；netstat 扫 34xx 僵尸
2. 分支库播种（幂等可重做）：sqlite3 `VACUUM INTO '~/.octopus/db/octopus-feat-archive-assets-20261014.db'`（自默认库，对账后只读源）
3. `node scripts/dev.mjs --port 3410,3411 --skip-build`（后台起；包装器退出≠服务亡——netstat 复核孤儿监听=正常形态）
4. 全链：`node C:/tmp/aa-e2e16/aa16-rerun.mjs all --run <tag>`（LLM 段单段 <600s，超时分步续跑 gate→seed1→acc1→seed2→acc2→pack1→case1→pack2→case2→seed3→acc3→case3→draft3→run3→revoke3→sum4→selffix→clean5→lane→web）
   - 注①：INDEX 若已超 800 token 预算，先 page-retire 若干 fixture 页再跑 selffix（D-aa16-2 运营前置）
   - 注②：任务 seed 幂等位=task-{id} 包目录钉名；重跑换 tag（新任务）即可
   - 注③：occurrences 并档/自纠痕迹两断言为观察项（模型行为面）；其余期望数字=执行矩阵列
5. 拆机：`pnpm kill:port 3411; pnpm kill:port 3410` → netstat 复核（三段式）

## 清理与残留

- 端口：拆机三段式报告收尾执行（见回报）；保护端口全程未触碰
- worktree：tracked 零未提交；修复 commit 27fe2e08 已 push `feat-archive-assets-20261014`（特批权限内，未碰 main）；`dist-scripts/` 未跟踪件=既有产物
- **保留（审计面=生产沉淀声明）**：wiki commits（3×task 归档、rc1、5×page-retire、gist 2e50003、probe 705518c/000239b）；raw 冻结件（3×task 包目录+probe 两件——退役只迁 wiki 页不动 raw 源）；cases 5 件（open 态真实供给）；drafts 4 件（2 revoked 留档+2 draft）；分支库（执行/版本/卡消息行）；workspaces `E2E_HARNESS_TEST_aa16-*`×2 + task ws×3；Lane A 会话消息
- **主动清理**：flow-a867bc4839 已 revoke 撤净；腾预算退役 5 fixture 页；三任务留 done 态（账本一次决定不可逆）
- 默认库 `octopus.db`：全程只读（实例 isolated 走分支库；脚本 SQL 零指向默认库）
- provider 真调用 ~40 次往返，无 mock 成分

## Conclusion

**PASS-WITH-FIXES（GO 口径）** — P3 五链全链真跑通：六类素材包+hash 契约、判例自动入档全局串行、草案三路自然触发→对话改写→授予即发版→**真实执行 JSONL 见 Skill 加载调用**→撤销缺席、语义摘要搜索命中、清理账全复验（+page-retire dogfood 再证）。两 pass 142 断言（pass1 109：105 绿+2 脚本自纠红已修证+2 观察声明；pass2 幂等面 33：32 绿+1 观察），真 provider（cache 记账）、真 git（线性 commit 族）、真 fs/三账齐验。**缺陷**：D-aa16-1（授予版本账形状错位）quick fix 已修+push（27fe2e08，执行面经实证未殃及、审计面已闭环复验）；D-aa16-2（INDEX 预算硬顶无收敛路）、D-aa16-3（retire 入链死链+finding 对端消失 adopt 恒败）DEFER 立票建议。**phase 级 GO 建议**：合入 main 时随 PR 附本报告 + D-aa16-1 修复 commit + 两 DEFER 转后续票。
