# 13: finding 面 — 语义巡检 + 裁决即编译 + 回填

**What to build:** 库自己会体检：夜巡与手动"体检一下"产出语义 findings（矛盾/stale/孤儿/概念缺页/缺交叉引用）报进对话，finding 卡上裁决即编译；策展人的好答案可一键回填成新页（探索复利）；agent 的 stale 上报真正闭环成 finding。

**Blocked by:** 12（对话主界面 + 卡片协议）

**Reference:** spec §Implementation Decisions「审批废除与写入闸门」质控⑤ + User Stories 12-14/29/42 · prototype Tab③（Lint 双层 + Query 回填）Tab④（finding 卡/回填卡）

**Status:** done

- [x] 语义巡检五查：页间矛盾 / stale 断言（被新源推翻）/ 孤儿页（零入链）/ 被提及但缺页的概念 / 缺失交叉引用；触发 = scheduler 夜巡系统作业 + 对话内「体检一下」即时触发
- [x] finding 卡三钮：[采纳修订]（策展人生成修订稿 → 编译入串行队列 → diff 卡跟随）/ [忽略]（记录在案，证据不变不再扰）/ [讨论]（对话继续）
- [x] wiki_refs 的 stale 上报接入 finding 管道（消费侧反哺生产侧闭环）
- [x] 回填卡：策展人对话中的有价值合成答案 → [编进 wiki] → 新页（sources=chat:session，对话摘录存 raw）；**执行中 agent 的产出不自动回填**（窄口纪律）
- [x] findings 状态持久（open/resolved/ignored）；健康条「开放 findings」口径真实联动
- [x] S1：五查 fixture 断言（构造矛盾/孤儿/缺页样本）；S2：findings 列表/裁决 API 契约；S4：finding 卡三钮行为 + 回填卡

## Comments

**2026-10-13 实现（kc/13-findings-patrol @baf89029 → 并入集成分支 c90cbf1f；26 文件 +3521/−280，零冲突）**

- 五查全确定性遍历（内容寻址 id 禁 LLM 漂移）：①页间矛盾=「## 冲突待裁决」标记行与 findings 表对址复报 ②stale=var_pool `stale:<ref>` 按页/锚归属转 finding 多执行并条 ③孤儿页=内容页零入链（sources 回执不算入链方）④概念缺页=L5 同款 resolveWikiLink 单源判据 ⑤缺互链=同 type 共 topic 双向无链给建议对
- 夜巡=BUILTIN_CODE_JOBS `builtin-knowledge-patrol`（cron 17 3 * * * Asia/Shanghai，组合根注入 handler、服务层直驱可测、未接线响亮占位）；**报对话=Lane A** finding 卡 fenced 块 append 进「知识中心」会话（无会话诚实注明不擅自建）；即时=`POST /api/knowledge/patrol` + 对话取号器 /体检|巡检/（不劫持）
- 三钮后端：adopt→202 经 `enqueue("finding-fix")` 单 commit（确定性编辑；矛盾/stale 走 LLM seam+锚点守门 FINDING_ANCHOR_LOST 失败库零动）→resolved+diff 卡回执；ignore 持久 suppressed；讨论=零端点零状态。回填=摘录落 raw 冻结 origin=chat:<session>→编译新页；窄口负断言齐（普通 wiki_refs 零 finding 零落 raw）
- openFindings 注真值（键集恒等测试钉，票 11 契约兑现）；shared `knowledge-center/card-protocol.ts` 协议上移单源，web 变 re-export 垫片（票 12 消费者零改动）
- 并入后：票 13 六域 58/58 绿、web app/knowledge 38/38、全量三组对档案恒等（server 46 位逐名/engine 894/8/web +3=见档案追认段）；build+lint 绿；自撞自修顶层 getDb() 崩溃（按票 14 代修先例惰性化）
- 裁定与留账（主控）：① 巡检不写 LOG 行（原型样例有「夜巡 N findings」，写 LOG=占锁入队语义重——fs/git 零触碰留裁决，倾向维持）；② 策展人自发 finding/backfill 卡属分身行为面（persona 未教），留 E2E/后续；③ 回填 sources 按「raw 路径+origin 链可达 chat:session」实现；④ orphan 采纳无宿主=FINDING_FIX_NO_RELATED 响亮失败走讨论；⑤ web 档案追认：harness-floating×3（Events 文案断旧，疑票 11 改名遗留——review 修复轴已挂号）+acceptance-surface 抖动位
