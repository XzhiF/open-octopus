# P4 票10「投喂泛化」插座现状勘察笔记

- **基线**: eca3b4ce（P3 合入后 main）。探索时工作树 HEAD = 1fda3e4e（票07 修复已在树内），file:line 以此为准。
- **日期**: 2026-10-15 · 探索子代理只读产出，零改仓库。
- **适用票**: 10（任意会话意图路由投喂）/ 08（手动体检同享 `POST /api/knowledge/patrol` 面）。
- 票面原文: `C:/xzf/ai/open-octopus/.scratch/wiki-evolution/issues/10-ingest-intent-routing.md`；spec 锚点: `.scratch/wiki-evolution/spec.md` L49（故事21）/ L94-96（投喂泛化）/ L122（测试层）/ L126。

---

## 1. Orchestrator 意图面

**结论：octo-agent-orchestrator 没有服务端代码实现——它是纯提示词技能；仓库里不存在意图类别的代码枚举。**

- 技能唯一实体 = `packages/core-pack/skills/octo-agent-orchestrator/SKILL.md`。
  - 意图分类 = LLM 照 SKILL.md「Intent Classification Rules」决策树（L17-38）自判，无 classify 函数、无枚举类型。
  - 现有意图类别清单（4 类）：`single_task`（L20）/ `scheduled_task`（L25）/ `info_query`（L30）/ `clone_management`（L35），各类带关键词表 + Action 描述。
- 注入面 = `packages/server/src/services/agent/system-prompt-assembler.ts`：
  - `getSegments()` L195 起 → `buildSkillsSegment(options.include_skills)` L211（技能摘要预加载，模型按需 `Read` 完整 SKILL.md，机制说明在 core segment L250-254）。
  - **P1_NEVER_TRIM = ['orchestrator','memory'] L679**——orchestrator 技能在 2000t 预算裁剪下永不被裁，是「意图面常驻」的保证点。
- 路由分发的另一半（工具化委派）= `packages/server/src/routes/agent/main-agent-route.ts`：
  - `DELEGATION_TOOLS_PROMPT` L40-51：现有 4 个 delegate 目标（workspace/scheduler/**archive**/resource）。
  - 工具名检测 L369-381：`toolName.startsWith('delegate_to_')` → 自动取 cloneName 委派——**新增委派目标不需要改检测代码**。
  - 确定性 @@mention 通道：`body.delegate_to` L211。
- 新类别「知识策展」的注册点（票10 AC1 三选一/组合，均为现状事实）：
  1. SKILL.md 决策树加第 5 分支（命中特征 + 动作=调 ingest API）——纯提示词；注意 core-pack 技能改版须重启 dev 才同步进运行副本（仓库记忆）。
  2. main-agent-route `DELEGATION_TOOLS_PROMPT` 增目标词（archive clone 已是策展人载体，但其现语义=「归档分析」，见 L47）。
  3. web 侧前置规则判定（照 classifyKcFeed 先例，见 §2）。
- LLM/规则混合形态：**orchestrator 面 100% LLM**；代码级规则分类器全仓只有 web 的 feed-protocol（§2）。
- 意图分类测试 fixture 先例：`packages/server/src/__tests__/delegate-mention.test.ts`（mock SessionDAO L17-32 + Hono 挂 `createMainAgentRoute`，钉 delegate_to 行为——S1/S2「命中/误吞/路由后调用面」可套此形）。另有 `packages/server/src/__tests__/chat-route.test.ts`、`clone-chat-capture.test.ts` 同目录群。
- 代码侧 orchestrator 唯一消费者 = `services/agent/evolution-service.ts:275`（进化反思缺省 skill_name）。

## 2. classifyKcFeed 先例（知识中心会话内投喂判定）

- 实现 = `packages/web-app/lib/knowledge-center/feed-protocol.ts:23` `classifyKcFeed(text): KcFeedIntent | null`（**纯前端正则，无 LLM**）：
  - `FEED_VERB_RE` L14 = 8 动词（投喂|编进|入库|收录|抓进|抓取|抓下来|存进）；三形态：粘贴前缀/```paste 围栏 L28-32 → 本地路径 L36-38（先于 URL，防盘符冒号被 URL 正则误咬）→ URL L41-42。
- 误吞防护纪律（票10 点名要继承）：
  - 路径/URL 形态**必须带动词**（L34 无动词早退 null）；
  - 动词在、无可投对象 ⇒ null（L44-45，「上次投喂的那篇讲了啥？」=对话不吞）；
  - 纯贴路径不投喂（L8 注释：防讨论路径误吞）。
  - 同纪律复制件 = `classifyKcRetire` L59-72（票08 故事32，退役动词+页路径，无对象 null）。
- 消费方（唯一一处）= `components/knowledge-center/chat-column.tsx:278` `handleSend`：命中 ⇒ `feed.feed(intent)`（REST 执行面）+ 原文照常发策展人（对话面不劫持）；`/体检|巡检/` L281 ⇒ `findings.patrol()`；retire L283-284。
- **与 orchestrator 意图面的关系 = 两处、互不相干**：classifyKcFeed 只在 /knowledge 对话列前端跑，不进 server、不进 system prompt。票10「知识中心会话内路径零回归」= feed-protocol.ts 本体与 chat-column 该链不动；其 6 例被逐字钉死于 `app/knowledge/__tests__/knowledge-chat.test.tsx:468-473`（含误吞两负例）。

## 3. Ingest API 与策展流程（票10「复用既有 ingest API + 队列」接线板）

- 端点 = `POST /api/knowledge/ingest`：`packages/server/src/routes/ingest.ts:40` `createIngestRoutes(service: RawIngestService, compileTrigger?: CompileTrigger)`；mode 三分流 L53-65；`?compile=true` L66-68 追加 `compileTask:{taskId,status}` 回执。挂载 `server/src/index.ts:588`。
- 抓取→raw 服务 = `services/knowledge/raw.ts:237` `RawIngestService`：`ingestText` L258 / `ingestUrl` L285（async）/ `ingestFile` L329，返回 `IngestResult` L40；错误码集见 ingest.ts 头注释 L12-15。
- 编译队列复用点：
  - `CompileTrigger` 型定义 routes/ingest.ts:36；生产实现 `index.ts:560-571`：`CuratorTaskService({ queue: wikiWriteQueue, run: CuratorCompileService.compileRaw })` + `ingestCompileTrigger = (rawPath)=>curatorTasks.submit(rawPath)`。
  - `services/knowledge/wiki/curator-task.ts:54` `CuratorTaskService.submit(rawPath)` L77；
  - `services/knowledge/wiki/compile-queue.ts:106` `CompileQueue.enqueue(opKind, fn, opts)` L125（接口 `WriteQueue` L69-77，含 `get(id)` ⇒ 位次单源）；**kind 单源 `WRITE_OP_KINDS` 九类 L25-35**：`ingest-compile`/`archive-compile`/`dialog-revise`/`lint-fix`/`finding-fix`/`revert`/`redistill`/`case-archive`/`page-retire`——票10 泛化应落 `ingest-compile`，**零新 kind**（票面负断言「无第二套抓取/编译路径」）。
- P2'/P3 组件名录：`ArchiveIngestService` `services/tasks/archive-ingest-service.ts:259`（`ingestTask(taskId)` L277，归档自动投喂）；`FindingOpsService` `services/knowledge/findings.ts:89`（`adopt` L130 裁决即编译 + Lane A 回执 `index.ts:584`）；`WikiPatrolService` `services/knowledge/patrol.ts:109`（`patrol()` L122；即时触发路由 `routes/findings.ts:118` `POST /patrol`——票08 手动体检同面）。
- **与票10 最相近的既有服务先例 = `BackfillService`** `services/knowledge/backfill.ts:41`：`backfill({text,title?,sessionId?})` L54 → `raw.ingestText(origin:"chat:<session>")` L70-75 → `trigger(res.raw.path)` L76。**sessionId 作为一等参数流入投喂链的现成形状**，且端点 `POST /api/knowledge/backfill`（web 客户端 `lib/knowledge/knowledge-center-api.ts:436`）与知识中心 UI 无耦合——任意会话后端调用无需新端点即可参考。
- web API 客户端全表（纯 fetch、无 KC 专属态）：kcIngest L208 / kcCompileRetry L228 / kcGetCompileTask L260 / kcGetQueueTask L277 / kcRevert L291 / kcGetRetireTask L348 / kcPatrol L423 / kcBackfill L436。

## 4. Lane A 消息块（卡片落会话 + 跨会话投递通道现状）

- 协议单源 = `packages/shared/src/knowledge-center/card-protocol.ts`：
  - fenced 块 ```kc-card + 一行 JSON；`serializeKcCardBlock` L423 / `parseKcCardPayload` L428 / `parseKcCardBlocks` L442（合法剥块、**非法块显形留原文**）；两车道契约注释 L20-36；id 约定 L38-39。
- **服务端 Lane A 写者（回流原会话的现插座）**= `services/knowledge/patrol-job.ts:73` `appendKnowledgeSessionCards(db, header, events)`：
  - 但**当前钉死知识中心会话**：L79-84 `AgentSessionDAO.findByClone("archive")` + 判据 `title==="知识中心" ∨ scope_id==="knowledge"`（常量 L29-31）；写消息 = `dao.insertMessage(role:"assistant")` L88-94 + `updateLastMessageAt` L95。
  - 复用方：夜巡报告（`createKnowledgeSessionReporter` L101）、finding 裁决回执（index.ts:584）、P3 素材包卡链路（index.ts ~1034 注释）。
- web 读侧：`chat-column.tsx:168-181` useMemo `viewMessages`——逐消息 `parseKcCardBlocks`（原 L173）剥块 + `laneAByMsgId`，经 `<ChatArea messageExtras={...}>` 交错渲染（`ChatArea.tsx` props L110/L113、渲染位 L336/L339——**messageExtras/transcriptTail 是 ChatArea 通用 prop，非 KC 专属**）。
- 知识中心拿卡方式：不是轮询卡片——Lane A 卡就在会话消息正文里，走 clone-session 通道（chat-column.tsx:101-106 overrides getSession/chatStream/stopChat/checkRunning；会话选取 `ensureSession` L112-122）。轮询的是 **Lane B 任务态**（`hooks/use-kc-poller.ts` 共享核：先拍后隔/瞬断 catch/卸载清定时器/终态自停，use-kc-feed/use-kc-findings 同形——b1764089 抽核）。
- **跨会话投递到任意 agent 会话 = 空白**：全仓 `insertMessage` 调用者只有 chat-routes.ts:59/248/354、main-agent-route.ts:202/281/459（对话本体自存）与 patrol-job.ts:88（钉死 KC 会话）。不存在「按 sessionId 注入消息」的 REST 端点。通用原语现成 = `AgentSessionDAO.insertMessage + updateLastMessageAt`；票10 故事20 需要的是把 append 的会话判据参数化（或新 helper），**不欠基建、欠入口**。

## 5. 卡片注册表（web）

- 注册表 = `components/knowledge-center/cards/registry.tsx`：
  - `renderers` Map L70；`registerKcCardRenderer(kind, Comp)` L72；分发器 `KcCard` L81-85——未注册 kind 走 `UnknownKcCard` 兜底 L87-98（显形不炸流）。
  - 现有注册 12 类 L101-114（ingest/source-summary/compile-diff/archive-compile/page-mini/guard/finding/backfill/material-pack/case/skill-draft/page-retire）。追加=新卡文件 + 一行注册；**票10 AC 明说零新卡类**，复用 compile-diff/ingest 两类即可。
  - web 垫片 `lib/knowledge-center/card-protocol.ts` re-export shared；卡类枚举单源 `shared card-protocol.ts:44-56` `KC_CARD_KINDS`（11 已知 + 开放 `KcCardKind = … | (string & {})` L60——page-retire 即开放 kind 先例 L113 注释）。
- **渲染上下文适配现状 = 全靠 ctx 注入，渲染器不感知页面**：
  - `KcCardActionCtx` registry.tsx:25-61（openPage/openRaw/revert/retryCompile/sayToCurator/adoptFinding/backfillWiki/recompilePack/retireCase/grantDraft… 全动作面）+ `grantTargets` 数据源 L57-60。
  - **当前唯一 ctx 实现 = ChatColumn `useMemo` L251-274**（普通会话宿主没有第二实现=票10 空白）。普通会话可用项分析：revert/retryCompile/adoptFinding 等本质是 knowledge-center-api 纯 fetch 调用（§3），上下文无关；openPage/sayToCurator 类是 KC 布局动作，普通会话需降级或换语义。
- S4 测试先例（「KC 卡片注册表 38 例」引用处 = `.scratch/archive-assets/spec.md:130`、`.scratch/wiki-evolution/spec.md:123`；当前实测合计 50 例——38 是引用时点数），文件分布：
  - `app/knowledge/__tests__/knowledge-chat.test.tsx`（15 it：Lane A 五类/fenced 剥除/未注册兜底 L226/回滚二次确认 L262-283/重试编译 L387-465/classifyKcFeed 6 例 L468-473）
  - `knowledge-material-pack.test.tsx`（8）、`knowledge-case-card.test.tsx`（5）、`knowledge-skill-draft-card.test.tsx`（9）、`knowledge-findings.test.tsx`（6）、`components/knowledge-center/__tests__/page-retire.test.tsx`（7）。
  - Fixture 形态：mock chat 模块 + `chatBox.messages=[MSG("a1","assistant",serializeKcCardBlock(EV))]` 注入 Lane A 块（material-pack.test.tsx:180 等）——票10 S4 跨会话渲染照抄此形。

## 6. Agent 会话侧（意图分类钩子位 + 会话上下文可得性）

- 普通 agent 会话两条主链（server）：
  1. **Main Agent 统一入口** `routes/agent/main-agent-route.ts:163` `app.post('/chat')`（= POST /api/agent/chat）：body `{message,session_id?,delegate_to?}` L167；用户消息落库 L199-206；LLM 路径 systemPrompt = base + DELEGATION + EVOLUTION + RECORD_DAILY L322；delegate 工具检测 L369-381；助手消息落库 L459。**钩子位**：L211 的确定性 delegate_to 分支旁（规则前置）或 L322 prompt 组装处（类别注册）。
  2. **分身会话** `routes/agent/chat-routes.ts:33` `POST /sessions/:id/chat`：`assembler.assemble({clone_name})` L85-86 → `tryClaudeSDK` L107 → insertMessage L248（头注释 L4 声称的 intent classification 实际已「orchestration now handled by Main Agent route」L106——分身链现无意图分类代码）。
- web 侧：`lib/agent/api.ts:103` `chatStream`——带 delegate_to 走 `/api/agent/chat` 否则 `/sessions/:id/chat`（L106-108）；普通会话宿主 = `components/agent/chat/ChatTab.tsx`（grep 无 kc-card/messageExtras/parseKcCardBlocks 引用 = 卡片渲染空白实证）；CloneDetailView.tsx 是同 override 形态的另一先例（chat-column.tsx:39-40 注释点名）。
- 会话 id / 上下文可得性（路由到策展后回流原会话的前提）：main-agent body.session_id L167 + sessionDao.findSessionById L195（session 行含 clone_name/org）；chat-routes 路径参 :id + L51。**发起会话 id 在两条链的路由点都已在手**，配 §4 的 append 原语即可回流；Lane A 直写 DB 不依赖流式连接存活。

## 7. 非知识中心会话的既有动作钮先例

- 卡钮 → API 链（知识中心现状，票10 要求「同 API 可复用」的实证）：
  - 回滚钮：`cards/compile-diff-card.tsx:81-83` 原地二次确认 → `ctx.revert(commit)`；宿主实现 `hooks/use-kc-feed.ts:218` `revert` → `kcRevert` POST `/api/knowledge/wiki/revert`（knowledge-center-api.ts:291）→ `trackRevert` L193-216 轮询 `/revert/task/:id`+`/queue/task/:id` 回灌 `revertStates[commit]`。
  - 重试编译钮：`cards/ingest-card.tsx:46` `ctx.retryCompile(event.id, d.rawPath)`；宿主 `use-kc-feed.ts:176-190` → `kcCompileRetry` POST `/api/knowledge/wiki/compile`（api.ts:228，**复用 ingest-compile 全局串行队列通道，红线2 禁直写**）→ mirrorToIngest L87 回灌原卡。
  - 其余同构覆盖层先例：finding fix / backfill / pack recompile / case retire / draft grant（chat-column.tsx:183-222 `withCardStates` 合并 Lane A 卡与 Lane B 覆盖层——「终态卡 Lane A + 即时态 Lane B 覆盖层」是全套件的既定形状）。
- 普通会话复用性判定（事实）：API 客户端与 use-kc-feed 都是可独立挂载的 hook/纯函数，无 KC 页面耦合；**缺的只是宿主**——普通会话要显示带钮的 Lane A 卡，需要 (a) ChatTab 接 messageExtras + parseKcCardBlocks，(b) 一个 ctx 实现（动作钮可继续走同一套 REST），(c) Lane B 覆盖层 store（Lane A 沉淀卡本身只含落定态，钮点击即时态必须有活 store 承载，否则钮按下去无回灌——票10 需拍板的开放点）。

---

## 要点摘要（10 行）

1. orchestrator 意图面 = 纯 SKILL.md 提示词（4 类决策树 L17-38），**无任何代码枚举/switch**；注册点=SKILL.md 加分支（改后须重启 dev）+ 可选 main-agent-route DELEGATION_TOOLS_PROMPT L40。
2. `system-prompt-assembler.ts:679` P1_NEVER_TRIM 保 orchestrator 永不被裁；工具委派检测按 `delegate_to_` 前缀自动路由（main-agent-route.ts:369-381），加新目标零代码改。
3. classifyKcFeed 是**前端正则纯函数**（feed-protocol.ts:23），与 orchestrator 是两处独立面；误吞纪律=动词门+无对象不吞；6 例钉死于 knowledge-chat.test.tsx:468-473——票10 零回归即此文件不动。
4. 泛化接线板 = `POST /api/knowledge/ingest?compile=true`（routes/ingest.ts:40，index.ts:588）→ `CuratorTaskService.submit` → `CompileQueue`（唯一写闸，WRITE_OP_KINDS 九类单源 compile-queue.ts:25）。
5. `BackfillService`（backfill.ts:41，含 sessionId→origin=chat:〈session〉）是「带会话上下文投喂链」最近先例；`POST /api/knowledge/patrol`（findings.ts:118）= 票08 手动体检共享面。
6. Lane A = fenced ```kc-card 块协议（shared card-protocol.ts:423/442）；服务端写者 `appendKnowledgeSessionCards`（patrol-job.ts:73）**钉死 archive 分身知识中心会话**（L79-84）。
7. **跨会话投递到任意 agent 会话 = 空白**：无注入端点；通用原语 `AgentSessionDAO.insertMessage` 现成，票10 需参数化目标会话。
8. 渲染空白实证：普通会话宿主 ChatTab.tsx 零 kc-card/messageExtras 引用；ChatArea 的 messageExtras/transcriptTail 是通用 prop（ChatArea.tsx:110/113/336）。
9. 卡片注册表 registry.tsx（12 类注册 L101-114 + 未知 kind 兜底），渲染上下文差异全走 `KcCardActionCtx`（L25-61）注入，唯一实现在 chat-column L251-274；「38 例」= 6 个 web 测试文件合计（现测 50 例），fixture 形 = serializeKcCardBlock 注入 chatBox.messages。
10. 回滚/重试钮链（compile-diff-card.tsx:83 / ingest-card.tsx:46 → use-kc-feed revert/retryCompile → wiki/revert、wiki/compile API）API 层上下文无关可直接复用；开放点=普通会话 Lane B 覆盖层 store 谁承载。
