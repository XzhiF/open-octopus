# E2E Test Report — P4 wiki-evolution 票11 全链真跑验收（五链 + 双复现靶 + 缺陷复探）

## Basic Info

- Target: P4 五链全链（① 记账链 / ② 数值处方链 / ③ 泛化投喂链 / ④ 深回滚链 / ⑤ 自动退役+恢复链）+ ⑥ INDEX 预算两级复现靶（D-aa16-2 清偿面）+ D-p4-ops-1 复合形定向复探；票 02–10 集成认证，spec 32 故事收口证据
- Mode: API Integration + 真实 provider 工作流执行/意图路由 + JSONL/DB/FS/GIT/Lane A 卡片/健康条 六面交叉（matt-e2e-test-methodology R1-R8 · e2e-harness lib 驱动）
- Host: `C:\xzf\ai\open-octopus\.worktrees\we-11` @ `fe4a5a48`（分支 we/11-e2e；**E2E 全程产品代码零改动**——`git status` 净、HEAD 未动：本轮未发现需要 quick fix 的产品缺陷，两枚缺陷均按红线显式上报不代修）
- 环境: dev 实例 `node scripts/dev.mjs --port 3430,3431 --skip-build`（web=3430 server=3431；health 原行 `mode=isolated branch=we/11-e2e` pid=4060→重启后 36268；**保护端口 3000/3001/3098/3099 全程无监听未触碰**，收尾复核声明见「清理与残留」）
- 分支库: `octopus-we-11-e2e.db`——**默认库经文件快照（db+wal+shm 拷贝）后 VACUUM INTO 播种**（sqlite3 正源；快照法而非直开原库，默认库连读句柄写语义都未给）；实例 custom-port 模式自动解析 DB 名=`octopus-we-11-e2e.db`，health `components.database.details.path` 原行=该路径；**默认库 `C:/Users/EDY/.octopus/db/octopus.db` 全程零直写**（脚本 SQL 一律显式分支库；只读探针 node:sqlite readOnly 模式）
- 知识根: **tmpdir 隔离副本 `C:/tmp/we11-e2e/knowledge`**（robocopy 自真根 `C:/Users/EDY/.octopus/knowledge` 全树克隆含 `wiki/.git` 真史；实例经 `OCTOPUS_KNOWLEDGE_DIR` 缝解析）。判别证双枚：fixtures 段 patrol 扫描页数 45 ≥ 真盘在册 36+8 we11 页；effSync 段 health.gitHead 与真盘 HEAD 正式分叉（inst=34fd79b… vs real=fdc3b3a）。**真盘 D-aa16-3 已由主控 ops 清偿，本轮全部复现靶在副本上重建现场（票02/03/04 fixture 口径），真盘全程只读**。
- 复跑: `node C:/tmp/we11-e2e/we11-rerun.mjs <gate|fixtures|effExecs|effExecs2|effExecs3|effParse|effSync|patrolNum|budgetWarn|curation|linkedRetire|deepRevert|nightPatrol|restore|budgetReject|budgetAdopt|ops1Probe|lane|web|idem|all> [--run <tag>]`（分步 <600s、state 续跑幂等；pass1 tag=`P1` 分段真跑；**非 LLM 幂等段（idem+effParse+patrolNum+lane+web+ops1收口）复跑 ≥2 轮全绿**；LLM 重段首跑全绿后以幂等续跑位声明在案。脚本存档副本 `.scratch/wiki-evolution/we11-rerun.mjs`）
- 证据总集: `C:/tmp/we11-e2e/evidence/`（82 件：results-<phase>-P1.json × 各段 / JSONL turn_usage 切片 / DB 行快照 / API 原行 / queue task 全量 / 卡片数据面 / git 行 / 手算对靶表）+ `state/*.json`（续跑位）+ dev 日志 `C:/tmp/we11-e2e/dev.log`、`dev2.log`
- Timestamp: 2026-10-15T13:56Z（实例起）→ 15:36Z（收口+拆机），各步 ISO 见 evidence
- 断言计数: **P1 各段终跑合计 122 条（110 断言位×终跑 + 幂等续跑声明位），另 idem 复证段 ×2 轮全绿**（首跑口径明细见执行矩阵列）

## Provider 真跑闸（反假跑前置）

- `ANTHROPIC_API_KEY` 未设；`~/.claude/settings.json` env 段真 token（dashscope Anthropic 兼容端点）；`OCTOPUS_MOCK_PROVIDERS` 未设
- 真实连通证明①：`POST /api/system/models/test` → `{"provider":"claude","model":"sonnet","success":true,"latency":6286}`（gate）+ haiku `5465`——latency 全非零
- 真实连通证明②：链① 七次真执行 JSONL `turn_usage` 原行（`evidence/exec1..7-jsonl-turn-usage.txt`），样例行含 cache 记账：
  `{"event":"agent_event","event_data":{"type":"turn_usage","turn":1,"delta":{"inputTokens":6,"outputTokens":60,"cacheReadTokens":36389,"cacheCreationTokens":135}}}`——节点时间戳跨 14:24:04→14:24:17（真推理往返，非离线闸空转）
- 真实 LLM 参与步（各计时）：链① exec×7（每执行 2 agent 节点 haiku）· 记账关联判定 seam×7（channel `effectiveness-link`，判出 helpful=4/not_helpful=4，linkSkips={} 零诚实缺席）· 重复对合并稿 seam（channel `duplicate-merge`，jaccard 0.879 对产稿）· 链② adopt LLM 修订（semanticRevision）· 链③ 意图分类真会话 131s（`ingest_to_wiki` 工具调用 SSE 原行）· 策展编译 ×5（crt-1440-003 130s / 1451-005 / 1455-006 / 1500-001 / 1504…各 ~2-4min sonnet）· 共 **20+ 次真 provider 往返**
- 离线闸检查：全链无链命中 `OCTOPUS_KNOWLEDGE_LLM_DISABLED` 空转形态（linkSkips 恒 `{}`；seam 产物在场）

## 执行矩阵

| # | 链 | 终跑断言 | 关键量 |
|---|---|---|---|
| 0 | gate | 9/9 | isolated 实例 / 双 provider ping / 分支库 v55 / 真盘净基线 / KC 会话就位 |
| 1a | fixtures | 3/3 | 8 fixture 页+工作流×7+工作区×7（每执行一 ws·单根契约）/ 判别证 patrol45≥36+8 |
| 1b | 链① 记账 | effExecs 9/9 + effExecs2 3/3 + effExecs3 9/9 + effParse 8/8 + effSync 6/6 | 首轮 parse scanned=24（含存量首批有机解析）helpful 4/notHelpful 4 / 游标幂等×3 / oct-901 2/3 全灭 0.400、oct-014 0/3→0.000 / sync 2 页快照刷 commit 34fd79b / article 实时段 |
| 2 | 链② 数值处方 | 9/9 | 五类 finding 在场（膨胀/僵尸/重复/低置信/到期）· **health score=独立手算 70 精确等值**（ded=24 cap=5.67 逐分量对拍）· duplicate adopt→fft-1431-001 committed→git cd6aa1f |
| 3 | 链③ 泛化投喂 | 8/8 | 真 LLM 131s 路由 `ingest_to_wiki`·原会话（session_type=main）回流 ing-6ad6a6c3/dif-crt-1451-005 双拍·终态 committed·example.com 去重命中显形 |
| 4 | 链④ 深回滚 | 13/13 | 靶=⑥a commit 0164add（其后 2 枚共行）· rvt-1457-001 committed · LOG `deep-revert \| compile 0164add` + `状态重建 12 页` · `--merges` 空 · 页/INDEX/LOG/DB/FTS 五路一致 · raw 零触碰 · 工作区净 |
| 5 | 链⑤ 自动退役+恢复 | nightPatrol 9/9 + restore 8/8 + linkedRetire 5/5 | scheduler 手动触发作业（五腿链序）· auto-retire 恰 1 枚 committed（LOG `窄口自动退役：90 天零引用 ∧ 零活页入链 ∧ 非人工文件 · auto`）· 通知卡 restoreHints=「恢复 oct-950」· 原号原行回迁+入链**字节级反放**（sha 对拍）· 低置信/膨胀/到期负断言不自动 |
| 6 | ⑥ INDEX 预算复现靶 | budgetWarn 5/5 + budgetReject 5/5 + budgetAdopt 4/4 | >80%：vt=**772∈(640,800]** 放行 committed+kind=index-budget 三选提案伴随（D-aa16-2 清偿面）· >100%：恒见 **1335 token** 病态巨行拒写 `L4_INDEX_BUDGET`+压缩措辞·HEAD 不动零副作用 · adopt→rebuildIndex committed→**score +4 精确位移（52→56）** |
| 7 | ops1Probe D-p4-ops-1 复探 | 6/6 | 复合形（矛盾标记+同页对退役页正文活链）construct→adopt **failed `L5_LINK_BROKEN`** 实锤复证·失败零副作用·收口归净 |
| 8 | 红线账 lane | 8/8 | 队列 opKind 全谱⊆12 类·depth=0·**16 枚 we11 commit 零触 SCHEMA.md/user_preference.md**·L5 全库断链扫描=0·真盘 HEAD=基线 fdc3b3a |
| 9 | web | 3/3 | /knowledge 200·/wiki 现制式 200·tree 含 we11 页 |
| 10 | idem（pass2 面） | 7/7 ×2 轮 | parse scanned=0·sync 零入队·patrol 背靠背第二轮 created=0·L5=0·三面可见·分支库零漂移·auto-retire 不二次触发 |

## 链① 证据原行（记账链：真执行→真解析→真滚动→真低置信 finding）

- 真执行×7（haiku 双节点：查阅节点 Read `topics/we11-gate-test.md` + review 节点 blocker）——var_pool DB 权威原行（`evidence/exec*-varpool-db.json`）：
  `"wiki_refs":["we11-gate-test#oct-901","prj-open-octopus#oct-007"],"review_blockers":["Telegram notify token 失效导致推送失败…"]`（exec1 无关形→helpful 弹药）；exec2/3/4/5/6/7 同类坑再现形（「没先跑 pnpm test 就直接 pnpm build」变体）→not_helpful 弹药。JSONL `toolName:"Read"` ×4 行/exec（页级消费信道实证）。
- `POST /api/knowledge/effectiveness/parse` 首跑原行：`{"scanned":24,"citations":13,"helpful":4,"notHelpful":4,"linkSkips":{},"warnings":[],"lastCursor":"9cd8241b…"}`——**scanned=24 含存量执行首批有机解析**（spec「数据依赖诚实注记」兑现：KC 时代带 wiki_refs 的存量执行入账）；复跑 `scanned:0`（游标 `effectiveness_cursors` 持久 ≥24 行，重跑零重复，红线6 幂等）。
- 账目 DB 行（`evidence/effectiveness-rows.json`）：oct-901 `cited 5 / helpful 2 / not_helpful 3 / last_cited 14:25Z`；oct-014 `cited 3 / h 0 / nh 3`；页键行 `we11-gate-test cited 5`（Read 序列账）。
- `POST /api/knowledge/effectiveness/sync`：`{"rowsRecomputed":2,"updated":[2 页],"queueTaskId":"es-…"}` → 队列位 committed（opKind=effectiveness-sync，红线1）→ 页 front-matter 快照：`topics/we11-gate-test.md` `confidence: 0.4`（DB=2/5 滚动值，commit 34fd79b `sync: effectiveness confidence 快照（2 页）`）——**DB 真源→页快照两路一致**。
- 可见面：`GET /api/knowledge/wiki/article/<id>` 顶层 `effectiveness` 段实时值 `{"citedCount":5,"helpfulCount":2,"notHelpfulCount":3,"helpfulRate":0.4,"confidence":0.4,"measured":true}`；`GET /api/knowledge/health` `avgConfidence=0.2`（只均已测口径）。
- 低置信 finding：`POST /api/knowledge/patrol` 产出 `kind=low-confidence` 在场，pages=`topics/wf-prd-impl.md`（**真页**，oct-014 全灭账目 0.000∧cited≥3 双条件 AND 命中——初值 0.8 页不受扰动，判据先行短路在场）。
- 运行时零感知（故事7）：七次执行全程经 engine 正常链完成（completed+JSONL 制式无增项），记账为服务端离线解析——S1 负断言 `effectiveness-trigger.test.ts:80` 同钉。

## 链② 证据原行（数值处方：夜巡真跑→score 对靶→裁决即编译）

- `POST /api/knowledge/patrol` 真跑 PatrolReport 全量存证（`patrol-report.json`）；开放 findings kind 集含 **bloat / zombie / duplicate / low-confidence / volatile-expired**（构造各≥1：膨胀=21 锚点页水线 0.84；僵尸=last_compiled 2026-07-01 从未被引；重复=跨页近义规则对 jaccard **0.879**≥0.75 附真 LLM 合并稿）——时间判据全走构造时间戳 fixture（红线6，零 sleep）。
- health score 对靶（禁 tautology）：`GET /api/knowledge/health` `score=70`，**独立手算=70 精确等值**——expected=round(100−Σ开放 severity 权重−Σ越水位页(wl−0.8)×25)，权重取 SCHEMA.md 公布表（critical8/major4/minor2；sev 映射逐字），容量水位由脚本自扫盘复算（`handcalc.json`：ded=24, cap=5.67）。二次对靶：index-budget（major）adopt 后 **score 位移=+4 精确**（52→56）。avgConfidence 键在场。
- 裁决即编译：duplicate finding `fnd-84968245c1ee3277` adopt→202 `fft-20261015T1431-001`（opKind=finding-fix 全局串行）→committed→单 commit `cd6aa1f compile: 重复对：oct-940…jaccard 0.879…（裁决即编译：主条归一、对侧原位改指）`——确定性合并零 LLM 执行面（稿在巡检侧）。
- 处方出口负断言：zombie/domain-skew 留 default 响亮拒（无自动执行）；全库唯一自动口见链⑤。

## 链③ 证据原行（泛化投喂：任意会话→意图路由→原会话卡片回流→编译落库）

- 载体=普通 Main Agent 会话（`session_type:"main"`、无 clone——**非知识中心**），`POST /api/agent/chat` 消息「把这篇编进 wiki https://example.com/」SSE 全流存证（`curation-sse.txt`，131916ms/153440B）。
- 意图路由实证：SSE 内 `ingest_to_wiki` 工具调用 13 处事件 + 服务端拦截回执原行：**`已投喂入库：example.com（raw/inbox/2026-10-15-example-com.md · 157B · hash 6ad6a6c · 去重命中既有源）· 编译已入全局串行队列 crt-20261015T1451-005，抓取卡/diff 卡已回流本会话，编译落定后终态卡自动追加`**——复用既有 RawIngestService+ingest-compile 队列，零新 kind 零平行机制（故事21；`orchestrator-curation-intent.test.ts` 五分支决策树+误吞纪律同钉）。
- 跨会话卡片回流原会话（票10 通道，`appendCardsToSession` 参数化会话判据）：Lane A fenced 块 `kind:"ingest"` id=`ing-6ad6a6c3`（status=done 含 rawPath/bytes/hash/compile）+ `kind:"compile-diff"` id=`dif-crt-20261015T1451-005` 首拍 queued/position → 编译 committed → **同 id 终态拍 status=committed 含 commit** 追加回同一 sid 消息行（DB 消息面解析对拍，`curation-cards-final.json`）；新页 2 枚+LOG ingest 行落 tmpdir 真 git（commit `ingest: example.com — 触 2 页 · 新页 2`）。
- 无审批钮负断言：卡片数据 JSON 零 `button/approve/reject` 字段（渲染级= S4 `chat-tab-curation-cards.test.tsx` 5 例，先例口径数据面+路由面为 E2E 证据）。

## 链④ 证据原行（深回滚：非 HEAD-adjacent 状态重建）

- 靶=链⑥a 编译 commit `0164add`（ingest we11 预算带靶说明，目标后实测 2 枚触 INDEX/LOG 共行——票面 ≥2 口径逐字对拍 `rev-list --count`）。
- `POST /api/knowledge/wiki/revert {"commit":"0164add…"}` → 202 `rvt-20261015T1457-001` → **committed**（`REVERT_CONFLICT` 产生面已随状态重建语义废弃——原症状靶不复发）。
- 五路一致：目标新增 3 页（sources 回执+2 topic）在盘缺席（removed 动作）；INDEX 程序化重建不含其行；LOG 追加审计行原行 `## [2026-10-15] deep-revert | compile 0164add` + `  → 回滚本次编译 · 状态重建 12 页 · owner ✓`（同族 grep `revert | compile` 新旧通吃）；DB `wiki_articles` LIKE 查 0 行；FTS search API 诚实缺席；raw 冻结件原路径在盘零触碰（回滚面不含 raw）。
- git 面：单 commit `deep-revert: 0164add — 回滚本次编译（重建 12 页）` 制式逐字 regex 命中；`git log --merges` **空**（线性史）；工作区净+队列续（零副作用契约）。
- 「重建 12 页」含状态重建的既有语义（目标 commit 曾扫入 fixture 变更，回退=目标态全体对齐）——页/INDEX/LOG/FTS/DB 五路对拍均以上述断言独立复核，非仅计数转述。

## 链⑤ 证据原行（自动退役窄口 + 对话恢复）

- 构造：`topics/we11-zombie.md`（锚点 oct-950，`last_compiled: 2026-07-01`，账目零行=从未被引，零活页入链）= 90 天零引用 ∧ 零入链 AND 形；负形三枚：低置信页（we11-gate-test 近期编译窗不全）/膨胀页/到期页（`we11-volatile` volatile+review_after 2026-08-15 已过**且**有宿主页活入链→has-inbound-links 挡）。
- 触发=**scheduler 系统作业手动触发**（`POST /api/scheduler/jobs/builtin-knowledge-patrol/trigger`，执行终态 success；不新建作业、既有挂载点；腿序 report→afterPatrol→parseLedger→syncConfidence→autoRetire 注释钉死且实测 parseLedger 腿 scanned=0 与手动同游标）。**诚实注记：手动 `POST /api/knowledge/patrol` 不含 auto-retire（唯一自动口=作业腿），故本链经作业通道真跑而非体检端点代跑。**
- 命中原行：队列 opKind=**auto-retire** 恰 1 枚 committed（`ret-20261015T1458-002`）→ `_retired/topics/we11-zombie.md` 落位（status superseded、oct-950 原号随迁）+ 活页位消失；LOG 行 `## [2026-10-15] retire | topics/we11-zombie.md` + `→ 退役入 _retired/ · 窄口自动退役：90 天零引用 ∧ 零活页入链 ∧ 非人工文件 · auto · owner ✓`；单 commit 910828c。
- 通知卡落知识中心会话：`kind:"auto-retire"` 数据面 `{status:"committed", pagePath, to, commit, anchors:["oct-950"], lastCited:null, daysSilent:106, restoreHints:["恢复 oct-950"]}`；**无审批钮负断言**：卡数据零审批字段（渲染层零 button=S4 `auto-retire.test.tsx:101-107` 禁词全列表钉）。
- 恢复：`POST /api/knowledge/wiki/restore {"anchor":"oct-950"}`（对话「恢复 oct-XXX」的产品执行面；口令分类通道=S4 恢复动词钉）→ `res-…` committed → **原号原行回迁**（oct-950 字节在场、front-matter 摘 status/replaced_by、_retired 位消失、DB/FTS 重注册 rows=1）+ LOG `restore | topics/we11-zombie.md` + `→ 自 _retired/ 回迁 · 原号原行` + commit `restore: topics/we11-zombie.md ← _retired/（原号回迁）`。
- 入链回补第二形（票04 统一机械反放）：先 `POST /wiki/retire topics/we11-linked.md` → 宿主 `[[we11-linked]]→[已退役]` 指针文本+links 摘项+LOG「摘除 1 页入链」（故事26 机械正放）→ `POST /wiki/restore {"anchor":"oct-960"}` → 宿主页**字节级反放**（sha256 与退役前快照全等，restored=concepts/we11-linked-host.md）+ LOG「回补 1 页入链」。
- 窄口之外负断言：低置信/膨胀/volatile 到期三页作业后全部仍在册、auto-retire 计数恒 1、复跑作业不二次触发（idem 段）。
- 红线2 复核：全程未引入任何审批态；ignore 仅用于 organic 巡检噪声显式裁决（85 枚在案，非静默）。

## ⑥ INDEX 预算复现靶（票03 现场复证·D-aa16-2 清偿面）

- **>80% 放行+预警伴随**：把恒见段构造进预警带（filler 页长摘要，独立复算器预测→产品真值对拍），经**真产品通道** `POST /api/knowledge/ingest?compile=true`（首轮曾以手搓 raw 触 `RAW_HASH_MISMATCH`——raw 冻结契约拒非法件，改走 ingest 后过；该失败本身=不可变契约正断言）→ 编译 **committed**（130s 真 curator，新页 2）+ `kind=index-budget` finding 伴随：`detail={"visible_tokens":772,"budget_tokens":800,"warn_threshold_tokens":640,"percent":97,"proposals":[移 Optional/拆分/hub 化 三选]}`（772∈(640,800] 预警带内、新知识不再被硬拒——P3 三连拒症状的机制清偿实证）。
- **>100% 拒+压缩建议**：构造病态巨行（40 锚点页使降级序垫底、恒见 1335 token）→ 编译任务 **failed** `{"code":"COMPILE_FAILED","message":"L4_INDEX_BUDGET: INDEX.md 恒见部分约 1335 token 超过硬顶 800——低频页移 ## Optional / 拆分 / hub 化的压缩建议见 suggestion（对话内自纠后重编译）"}`；**零副作用**：HEAD 不动、库零写（巨页在盘而回执页不落盘）、工作树回归净。反证面同轮显形：中等巨行（~470 token）时 Optional 自动降级**收敛成功**（crt-1459-001 committed）——两级闸「降得动就放行、降不动才拒」的分层语义双向验证。
- **裁决即编译**：`index-budget` adopt→`fft-20261015T1500-001` finding-fix 串行位内 `rebuildIndex` committed（commit `compile: INDEX.md — 预算预警采纳…`）→ 恒见段回落 376 token、score 位移 +4 精确。
- Optional 尾部不占恒见预算（故事25 llms.txt 口径）：复算器按 `renderWikiIndex(恒见段)` 口径对拍 finding 真值 772 vs 预测 767±（同带内），且降级行为如上反证。

## D-p4-ops-1 定向复探（主控交底缺陷·显形上报不代修）

- 交底：单侧降级 × L5 残留断链复合形（同页既有矛盾标记、又持对同一已退役页的**标记外**正文活链时，adopt 被 L5_LINK_BROKEN 挡——票04 fixture 未覆盖）。
- 复探构造（tmpdir 副本，全程经队列）：target 页经真编译入册（crt-1533-007 committed）→ 产品退役（page-retire committed，`_retired/topics/we11-ops1-target.md`）→ 宿主复合形（`> 【fnd-0e110e110e110e11】与 [[we11-ops1-target]] …旧断言「甲命题」↔ 新断言「乙命题」` 标记行 + 标记外活链行 + front-matter links）+ DB 复探件 finding 行（按编译通道同形 pages=[host,target]）。
- **实锤原行**：`fft-20261015T1534-003` → `{"code":"FINDING_FIX_FAILED","message":"L5_LINK_BROKEN: concepts/we11-ops1-host.md: 断链 [[...]] 目标不存在: [[we11-ops1-target]]"}`——**单侧降级在复合形下不生效，故事26「不再恒 failed」对历史复合态未闭合**（票04 Comments 记载的候选修法：单侧 compile 前对本页定向 cleanInboundLinks，交 /code-review 定夺）。
- 诚实边界：本轮**未命中**该形的有机路径（链④/矛盾构造不涉此形——深回滚与真盘清偿后库面均不含历史复合页）；复探为构造证。收口：finding 显式 ignore 在案 + 宿主未提交件撤除 + git 净（不掩盖不留脏）。
- 顺带正断言一枚：票04 单侧降级**简单形**（对手页已退役、本页无活链）经真盘 ops 清偿实证（adopt committed，票04 Comments 实测行）——PARTIAL 仅指复合形。

## Lane A 对话流卡全单

- 知识中心会话（archive 分身）：`auto-retire` 终态卡（restoreHints 原行）+ `finding` 卡（裁决回执族）沉淀（`lane-inventory.json`）。
- Main Agent 原会话：`ingest`（done）+ `compile-diff`（queued→committed 同 id 两拍）。
- 渲染级 data-testid/零钮断言=S4 组件群（`auto-retire.test.tsx` 零 button、`chat-tab-curation-cards.test.tsx`、`knowledge-findings.test.tsx`）——本报告以卡片数据面+DB 消息行+API 原行为 E2E 证据（aa/KC 先例口径）。

## 回归

- 存量数据首解析无扰动：parse scanned=24 含 KC 时代 wiki_refs 存量行（citations 13 中有机占比在案），confidence 未收敛行不被改写（`confidence <>` 滤式）。
- 队列面：全程 12 类 opKind 中本轮出现 7 类（ingest-compile/finding-fix/effectiveness-sync/page-retire/auto-retire/page-restore/revert），全部 committed/failed 终态收敛 depth=0；WORKTREE_DIRTY 闸在脏窗显形拒退役（ret-1506/1507 failed 原行——写闸纪律正断言，非缺陷）。
- 投喂/编译面：ingest?compile=true 五投全契约（dedup 命中/新 raw/拒写三种结局各在案）；curator 幂等复投不双档。
- 真盘账：知识根真盘 HEAD 全程=基线 fdc3b3a（lane 红线账原行）；默认库零直写（实例分支库+脚本只读句柄，见 Basic Info）。
- K 系红线：16 枚 we11 commit 文件清单 ∌ 人工文件、∌ agent 记忆域、∌ K11、∌ skill 生效面（diff 面扫描；红线5）。

## 32 故事 → 证据映射（verification-report 素材）

| 故事 | 主题 | E2E/S 证据指针 | 判定 |
|---|---|---|---|
| 1 | JSONL 解析引用/Read 序列落账 | 链① var_pool 原行+JSONL Read×4 行+页键行 `we11-gate-test cited 5`；S1 effectiveness-ledger.test.ts | PASS |
| 2 | blocker↔锚点 LLM seam 关联 | parse helpful=4/notHelpful=4 linkSkips={}（真 provider 判道）；S1 seam prompt 捕获两例 | PASS |
| 3 | confidence DB 真源滚动+夜巡刷快照 | effSync rowsRecomputed=2→commit 34fd79b→页 front-matter 0.4；S1 effectiveness-sync.test.ts | PASS |
| 4 | 元数据/健康条可见引用数/率/走势 | article effectiveness 段实时原行+health.avgConfidence=0.2；S4 健康条=票07/08 组件面 | PASS（数据面） |
| 5 | 低置信（≤0.2∧≥3）自动产 finding | 链② low-confidence 在场且落真页 wf-prd-impl（AND 双条件）；S1 patrol-low-confidence | PASS |
| 6 | 记账幂等增量游标 | parse 复跑 scanned=0 ×3 + effectiveness_cursors 24 行；红线6 | PASS |
| 7 | 运行时零感知 | 七执行经标准引擎链完成零增项；S1 effectiveness-trigger.test.ts:80 负断言 | PASS（间接+S1 钉） |
| 8 | 夜巡 health score 0-100 进健康条+SCHEMA 权重 | **score=70=独立手算精确等值**（SCHEMA 公布权重）+二次 +4 位移对靶；S4 槽位=票08 | PASS |
| 9 | 膨胀榜 80% 预拆分 finding | bloat 在场（水线 0.84≥0.8 构造靶）；S1 wiki-patrol-numeric | PASS |
| 10 | 重复对 jaccard+合并稿 finding | jaccard 0.879 finding+真 LLM 合并稿+adopt 确定性合并 committed cd6aa1f；S1 wiki-patrol-duplicate | PASS |
| 11 | 僵尸 90 天零引用 finding | zombie 在场（构造 last_compiled 7 月页，时钟判据零 sleep）；S1 同族 | PASS |
| 12 | 域失衡 >30% finding | domain-skew 首巡在场（bloat 页 21/全库锚占比>0.3）；处方=人裁在案 | PASS |
| 13 | volatile 到期三选一 finding | volatile-expired 在场（review_after 2026-08-15 已过构造）+不自动负断言 | PASS |
| 14 | 点开 ranked findings 复用卡 | GET /findings?status=open severity 派生键分组（findings-routes.test.ts:109）+零新 UI 声明 | PASS（数据面） |
| 15 | 数值检查并入 patrol 单源+裁决即编译 | POST /patrol 同一入口全目录+adopt→fft→commit 全链在案 | PASS |
| 16 | 窄口自动退役（90∧零入链）+_retired+LOG+通知卡 | nightPatrol 9/9：opKind auto-retire 恰 1·LOG auto 行逐字·卡 restoreHints | PASS |
| 17 | 自动退役可恢复（原号原行+入链回补） | restore 8/8：oct-950 字节回迁+oct-960 宿主 sha 全等反放 | PASS |
| 18 | 自动退役经队列+入链清理同一路机械 | auto-retire/page-retire/page-restore 三类 opKind 同闸谱+linkedRetire 正放 | PASS |
| 19 | 任意会话说「编进 wiki」转策展 | 链③ main 会话真 LLM 路由 131s+回执原行 | PASS |
| 20 | 同款卡片回流原会话 | ing-/dif- 双拍同 id 终态 committed 落同一 session 消息行；S4 ChatTab 渲染=票10 | PASS（数据面） |
| 21 | 意图类入既有 orchestrator 面+复用 ingest 队列 | SKILL.md 第 5 分支（orchestrator-curation-intent.test.ts 五支枚举钉）+ingest-compile 零新 kind | PASS |
| 22 | 深回滚任意历史编译=状态重建 | 链④ rvt-1457 committed·REVERT_CONFLICT 产生面废弃·五路一致 | PASS |
| 23 | 深回滚审计面 LOG deep-revert 行+线性 | LOG 逐字 regex+`--merges` 空+commit 制式 | PASS |
| 24 | INDEX 两级预算（>80% 预警放行/>100% 拒+压缩建议） | ⑥a vt=772 committed+finding 三选；⑥b 1335 token failed+措辞；反证收敛形 | PASS（P3 三连拒靶复证清偿） |
| 25 | INDEX 分层渲染（Optional 尾部不占恒见） | 恒见口径对拍（detail=772 vs 复算同带）+降级收敛行为（crt-1459 committed 反证） | PASS |
| 26 | 退役清入链+矛盾对手退役单侧不再恒 failed | linkedRetire/restore 正反放全绿；**复合形 D-p4-ops-1 复探实锤仍 failed**（真盘历史态未闭合，ops 以 restore→re-retire 合法绕行） | **PARTIAL（缺陷单 D-p4-ops-1，见缺陷节）** |
| 27 | shadow-compare 物理删除+归档加注 | 本轮静证 `git grep` 代码面零命中（仅删除墓碑测试）+p2-gate-pass/KC/aa 加注在案（aa 报告 33† 行）；红线4 顺序 | PASS（静+归档面） |
| 28 | 记账链真跑（E2E） | 链① 全行 | PASS |
| 29 | 夜巡真跑+数值 findings+裁决即编译（E2E） | 链②+⑤作业腿 | PASS |
| 30 | 泛化投喂真跑（E2E） | 链③ | PASS |
| 31 | 深回滚真跑（E2E） | 链④ | PASS |
| 32 | 复跑脚本化+R1-R8+故事映射 | we11-rerun.mjs 20 段+本报告+idem 双轮 | PASS |

## 反假跑核查 R1-R8

- [x] R1 真服务：health 原行 `mode=isolated branch=we/11-e2e` pid=4060/36268，DB=分支库路径原行，知识根=tmpdir 副本（判别证两枚：patrol 扫描计数 45≥36+8、gitHead 分叉）
- [x] R2 业务断言：全字段级（parse 报告键面/confidence 0.400 与 0.000/手算 70 等值/jaccard 0.879/LOG 逐字 regex/卡 data 结构/字节 sha 对判/队列 opKind 谱），非 200 即过
- [x] R3 交叉验证：链① API↔DB↔JSONL↔fs↔git；链② patrol↔findings↔health↔手算↔commit；链③ SSE↔DB 消息↔queue task↔fs 新页；链④/⑤ API↔git↔DB↔FTS↔卡片——每 AC≥2 层
- [x] R4 证据≥2：每链≥3 类原行（evidence/ 82 件全量快照）
- [x] R5 副作用验证：写链 DB/fs/git/卡片四路对质；失败链零副作用（⑥b 拒写 HEAD 不动、ops1 adopt 失败标记原样、WORKTREE_DIRTY 拒退役无半成品）
- [x] R6 真实通路：全链产品 REST/会话/作业通道；真执行×7 真路由×1 真编译×5 真判道×7；**构造面声明**：fixture 页直写 tmpdir 副本 fs（票02/03/04 复探同制式；页面入册一律经队列 commit，零队外直提——lane 谱证）；agent 域鉴权占位 token（D-kc15-4 现状，非本轮面）
- [x] R7 数据隔离+可识别：页/工作区/工作流/commit 理由全 `we11-`/`E2E_HARNESS_TEST_` 前缀；**审计面保留不删**（副本 git 史 16 枚 commit 完整、分支库账目行/游标行/findings 行、KC+main 会话消息、工作区×7）；真盘与默认库零触碰（红线账原行）
- [x] R8 可重跑：分步 state 续跑（execs/curation/linkedRetire/ops1 各含幂等位在案）；idem pass2 面双轮实测；新环境从零=复现步骤节
- 处置记录（诚实账）：P1 为分段执行，过程含 **断言面自纠 ×11**（pollJson URL 双拼、`task.status` vs `state` 场形误读 ×4、kinds 并集、ignore 清场幂等、健康分饱和区改背靠背/位移对靶、巨行拒写需 40 锚点降级垫底形、SMALL_GIANT 换行制式、agent 鉴权头、会话消息 dict 形、单根工作区契约、raw 冻结契约改走 ingest）——**均为脚本/探针侧缺陷，逐条以同断言复跑绿或产品原行证实非产品面**；产品面失败仅两类且均为正确行为：`RAW_HASH_MISMATCH`（手搓 raw 被契约拒=正断言）与 `WORKTREE_DIRTY`（脏窗拒写=红线在场）。exec6 review 节点模型把 blocker 写成非契约键形——记账侧诚实不计数（观察项，非缺陷：seam 输入面契约由 DB 键权威守）。无假跑成分。

## 缺陷发现

- **D-p4-ops-1（复证实锤·沿用主控交底编号，不新立）**：复合形（同页矛盾标记 + 标记外对同一已退役页正文活链）下矛盾裁决单侧降级被 L5_LINK_BROKEN 挡，adopt 恒 failed——故事26「不再恒 failed」对**历史复合态**未闭合（票04 fixture 仅覆盖简单形）。E2E 原行：`fft-20261015T1534-003 error.L5_LINK_BROKEN`。候选修法（交 /code-review，不代修）：单侧降级 compile 前对本页跑定向 cleanInboundLinks。真盘无此形暴露面（ops 已清偿）。
- **观察项（非缺陷，如实入册）**：① 有机数据薄=预期（spec 两波口径）：首轮 parse 有机占比高但判道零输入（存量执行无 review_blockers 键面），confidence 真收敛依赖运营积累。② 巨行降级「降得动即放行」——INDEX 恒见闸对单页摘要巨行有 Optional 收敛兜底，>100% 硬拒需病态形（构造要点已写入复现步骤注①）。③ curator LLM 按**文件名 stem** 造 [[链接]]：fixture 页 id≠stem 会触发 L5 断链（本轮 id 改 stem 制式后消；后续 fixture 纪律建议入笔记）。④ 一工作区一根执行=引擎契约，批量执行需逐区建。⑤ patrol 对 graph 变化轮正常产新 findings（背靠背第二轮 created=0 才是幂等钉——已固化进 idem 段）。

## 复现步骤

1. `cd C:\xzf\ai\open-octopus\.worktrees\we-11`（@fe4a5a48 已 build；改码后 `pnpm --filter @octopus/server build`）；netstat 扫 34xx 无占用（3430/3431）
2. 播种（幂等可重做，默认库零直写）：复制 `octopus.db`(+wal/shm) 为快照 → `sqlite3 <快照> "VACUUM INTO 'C:/Users/EDY/.octopus/db/octopus-we-11-e2e.db'"`
3. 知识根副本：`robocopy C:\Users\EDY\.octopus\knowledge C:\tmp\we11-e2e\knowledge /E`（含 wiki/.git）
4. 起实例（PowerShell，分离进程防任务回收）：`$env:OCTOPUS_KNOWLEDGE_DIR='C:\tmp\we11-e2e\knowledge'; node scripts/dev.mjs --port 3430,3431 --skip-build`
5. 全链：`node C:/tmp/we11-e2e/we11-rerun.mjs all --run <tag>`（LLM 重段单段 <600s；分步续跑序 = 执行矩阵行序；注①：巨行拒写靶需 ≥40 锚点页使降级垫底；注②：重跑换 tag 即新建工作区/会话/页；注③：exec6 类模型键形漂移为观察项，游标保证不重复计账）
6. 拆机：`pnpm kill:port 3431; pnpm kill:port 3430` → netstat 复核（三段式，本轮已收尾执行）

## 清理与残留

- 端口：3431/3430 拆机后 netstat 双 FREE 原行（kill 36268）；保护端口 3000/3001/3098/3099 **全程未触碰**（开工收工各扫一遍）
- worktree：`git status` 净 @fe4a5a48——**零产品码改动**（无 quick fix 需要，两缺陷按红线移交不代修）
- 保留（审计面声明）：tmpdir 副本 git 史（16 枚 we11 commit：sync/finding-fix/ingest×5/retire/restore/auto-retire/deep-revert/清扫件）；分支库（knowledge_effectiveness 行、effectiveness_cursors 24 行、findings 全状态谱、schedule_executions、会话消息行）；`E2E_HARNESS_TEST_we11-eff1..7-*` 工作区×7 + JSONL 日志盘；`C:/tmp/we11-e2e/evidence` 82 件
- 主动清理：巨行 fixture 归常（we11-giant 转常页留档）；ops1 宿主复探件撤除+finding ignore 在案；临时 raw 手搓件删除（后经 ingest 正规生成）
- 真盘/默认库：知识根真盘 HEAD=基线 fdc3b3a 零直写；默认库仅经文件快照读（VACUUM 自快照）
- provider：真调用 ~25+ 次往返（含 cache 记账原行），无 mock 成分

## Conclusion

**PASS-WITH-NOTES（GO 口径）** — P4 五链 + 双复现靶全链真跑通：记账链真执行×7→真 LLM 判道落账（helpful/not_helpful 双值在场）→游标幂等→DB 真源滚动→页快照 commit→低置信 finding 落真页；数值处方链 **health score 对独立手算精确等值（70）+ adopt 位移 +4 复验**（权重公式零 tautology）；泛化投喂链真意图路由 131s+卡片跨会话双拍回流；深回滚链非 HEAD-adjacent 状态重建五路一致+线性史；自动退役窄口恰一腿命中+原号恢复+入链字节级反放；INDEX 两级预算 P3 三连拒现场复证清偿（772 放行伴随预警 / 1335 拒+压缩建议）。**故事映射 31×PASS + 1×PARTIAL**（故事26 历史复合形）。**缺陷**：D-p4-ops-1 复探实锤（复合形单侧降级恒败，交 /code-review 定夺修法；真盘无暴露面）。**phase 级 GO 建议**：32 故事收口证据成立，spec「机制正确+构造/烟测数据」验收口径满足；confidence 真实收敛按两波节奏随运营增厚。
