# 12: 知识中心对话主界面 + 卡片协议（写面）

**What to build:** 对话即管理立起来：在知识中心与策展人（archive 分身）对话完成投喂/修订/回滚，每次操作以结构化卡片沉淀在对话流里，右栏 wiki 视图实时跟随——owner 从此不需要任何"管理页面"，管理就是说话。

**Blocked by:** 05（编译管线）, 06（队列状态）, 11（读面骨架）

**Reference:** spec §Implementation Decisions「知识中心 UI」· prototype Tab④（主界面 mockup + 卡片目录 + 交互纪律五条）

**Status:** done

- [x] 对话流复用既有 agent chat 通道（archive 分身会话，scope=knowledge），**零自建聊天基建**；流式渲染沿用既有 TUI transcript 形制
- [x] 卡片协议首批五类：抓取卡 / 来源摘要卡 / 编译 diff 卡（触及页明细+冲突数+commit）/ 归档编译卡 / 词条迷你卡——结构化事件→卡片渲染协议可扩展（票 13 追加）
- [x] 对话内投喂（URL/粘贴/路径）→ 抓取卡 → 摘要卡 → diff 卡；异步编译卡带流式状态（排队中 #N → 编译中 → 已提交 hash，吃票 06 队列 API）
- [x] ~~右栏跟随对话渲染卡片/正文提到的页；可钉住（停跟随）；浏览模式 ↔ 对话模式切换~~ ——**⚠️ 本 AC 整体废除（ADR-0033，2026-10-16）：跟随/钉住/双模式换芯为「wiki 主场恒定 + 策展人抽屉 + 引用药丸（显式跳转，永不自动）」。配套：knowledge-chat.test.tsx AC4 系改写负断言。勿按本条修回。**
- [x] 回滚按钮（diff 卡）：二次确认 → 服务端 git revert 单 commit + INDEX/LOG/FTS 重同步 + LOG 追加 revert 行
- [x] 写保护意图（触 user_preference/SCHEMA 修改）→ 写保护卡：建议文本 + 人工确认步骤，零自动落盘
- [x] 端到端可演示：对话投喂真 URL → 卡片流完整 → 右栏见新页 → 回滚生效 → git 史干净
- [x] S4：五类卡渲染 + 队列状态流转 + 回滚钮行为（mock）；S2：revert API 契约（revert 后 INDEX/FTS 一致性断言）

## Comments

**2026-10-13 实现（kc/12-chat-cards @2fb9314c → 并入集成分支 f8f101cd，零冲突，+2471/−32）**

- 对话列实装：复用 clone-session chat（archive 分身，零自建）+ TUI 形制；`chat-column.tsx` + 七卡组件 + `card-protocol.ts` 注册表（`registerKcCardRenderer(kind, Comp)` 开放 kind，未注册走兜底卡——票 13 一行接位）；`use-kc-feed.ts` 编排态 store（幂等合并、sessionId 侧挂 localStorage、Lane A 优先）
- **卡片持久两车道**：Lane A=消息正文 fenced ` ```kc-card ` JSON 块（策展人/票 13 裁决回执走此，随会话持久）；Lane B=前端任务态卡（id 锚定 dif-/sum-<taskId>、ing-<runId>）
- revert 面：`POST /api/knowledge/wiki/revert`（经票 06 队列 opKind=revert：git revert --no-commit→INDEX 程序化重建→LOG `revert` 行→DB/FTS 逐页重同步→单 commit）+ GET task 状态；错误码 INVALID_PARAM/NOT_FOUND/REVERT_CONFLICT/LOCK_HELD/WORKTREE_DIRTY；位次复用 GET /queue/task/:id
- 右栏跟随/钉住/模式切换齐（钉住后手动钮仍可达）【随 ADR-0033 废除——见 AC4 注】；写保护卡=建议文本+人工确认，零自动落盘（S4 零 POST 断言；服务端写保护=review 修复后「服务层主闸 MANUAL_FILE_WRITE + pre-commit 纵深」，wiki-write-gate.test.ts 已钉，guard-card.tsx 引用已改指新套件；user_preference 概念已退役，写保护面只剩 SCHEMA.md）
- 测试：revert 邻域 scoped 293 全绿；web app/knowledge 32/32（票11 19+票12 13）；build+turbopack 绿；lint 0 error；基线红精确复现零新增
- 裁定注记（主控）：① 投喂执行面=前端直连 REST，消息原文同步发策展人（paste 发摘要句省 token）——**agent 工具化投喂留票 13/14 收口**；② curator-task 面「队列失败 registry 滞留 queued」缺口仅 revert 侧封上，curator 面记遗留（票 15 后如复现另票）；③ Lane B 服务进程重启丢任务态=票 05 既有语义（git LOG 为审计真相）；④ AC7「端到端可演示」测试面达成，真浏览器演示=票 15 链①
