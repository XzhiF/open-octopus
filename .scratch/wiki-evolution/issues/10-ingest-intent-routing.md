# 10: 投喂泛化 — 任意会话意图路由

**What to build:** 投喂不再要求先进知识中心：任何 agent 对话里说"把这篇编进 wiki"+ URL/长文本，orchestrator 意图路由识别 → 转策展流程（抓取→raw→编译，全走既有队列与写闸）→ 抓取卡/diff 卡经 Lane A 消息块回流**原会话**。

**Blocked by:** 01（P3 合入）

**Reference:** spec §Implementation Decisions「投喂泛化」· 故事 19-21

**Status:** done (merged → integration `e081748e`，经重收敛 47c3b7b7)

- [x] orchestrator 意图面新增「知识策展」类：命中特征（"编进 wiki/入库/沉淀这篇"等表述 + URL/长文本伴随）→ 路由策展流程；误吞防护（无投喂动词不路由，classifyKcFeed 先例纪律）
- [x] 路由后复用既有 ingest API + 编译队列 + 写闸——**零平行机制**（负断言：无第二套抓取/编译路径）
- [x] 卡片回流原会话：抓取卡/diff 卡经 Lane A 消息块（跨会话/跨设备正典形态）落进发起会话；卡上动作钮（回滚/重试）走同一套 API
- [x] 非知识中心会话的卡片渲染复用注册表渲染器（零新卡类；渲染上下文适配）
- [x] 知识中心会话内的投喂路径零回归（既有 classifyKcFeed 通道不动）
- [x] S1/S2（意图分类 fixture：命中/误吞防护/路由后 ingest 调用面）+ S4（跨会话卡片渲染）

## Comments

- **2026-10-15 implementer（we/10-ingest-intent @ 6ef652f2，6 切片 commits）**：orchestrator SKILL.md 决策树第 5 支 `knowledge_curation`（投喂动词**且**伴随 URL/长文本/路径，缺一不路由；误吞纪律逐字继承 classifyKcFeed）+ main-agent-route `CURATION_TOOLS_PROMPT` 仅接线时注入；`SessionCurationService.curate()` 穿打**同一** RawIngestService 实例+`curatorTasks.submit`（ingest-compile opKind，WRITE_OP_KINDS 零改）——spy 负断言钉「恰一次入队」；text 形 origin=chat:〈session〉逐字继承 Backfill。**Lane A 空白插座补齐**：泛化原语 `appendCardsToSession`（目标会话参数化），appendKnowledgeSessionCards 保留知识中心判据转调（夜巡零改）；两拍回流=链首抓取卡 `ing-<hash8>`+diff 卡 `dif-<taskId>`、终态同 id 重发（判例终态卡先例），sessionId 服务端解析模型不可伪造。ChatTab 接 messageExtras/transcriptTail 剥块走 registry 分发（零新卡类，UnknownKcCard 兜底例在）。S1 5+10/S2 6/S4 5，知识中心 50 例逐字零回归；全量 37 红=基线档案（含票04 冻结日期一例双重复现归位），零新增。
- **开放点裁定**：①Lane B store=useKcFeed 直挂 ChatTab（restore 镜像回灌，零新基建）；②ctx 布局动作在普通会话宿主 no-op（回流三类卡钮面不依赖），不造第二 ctx 词表；③编译终态卡经 Lane A 沉淀、宿主当前 view 重进可见（跨设备正典形态同律）。真 provider 会话链留票11 链③。
- **merger 账（47c3b7b7→e081748e）**：重收敛与票06 双触面核验——index.ts import 单 hunk 双并；patrol-job.ts 自动合并后双语义在场（parseLedger L160/186 × appendCardsToSession L77/109）；RawIngestService 单例=ingest 路由与 curation 共享（第二实例系基线前 ArchiveIngestService 自有，越界不动）。we-10 182 绿/we-int 复验 49 绿，build 双侧全绿。
- **票11 前置提醒（implementer 带回）**：SKILL.md 运行副本已随 build sync 落盘，但 **dev 运行中进程须重启才吃到新意图面**（core-pack 改版同步纪律）——票11 真跑前重启。
