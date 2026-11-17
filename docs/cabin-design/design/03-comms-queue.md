# 03 · 串行收件箱（C4）

> 人面对一个对话，串行处理队列消息。**舱主 transcript 即串行收件箱**——同 Octopus 现状：无独立队列表，chat 卡 + incidents 即收件箱。原型 comms 窗 = attention 收件箱的视图，不另存队列。

## 原则（superagent docs/000）
取最少人类注意力；一次一个结构化问题；person-first 排序；健康态不占空间。

## attention 派生来源矩阵（deriveCabinView）
| 来源 | stage | awaiting |
|------|-------|----------|
| task awaiting_review | review | person |
| task awaiting_archive | archive→review 类 | person |
| execution pending_approval | approval | person |
| runtime_incidents waiting_human | blocked/approval | person |
| pending interaction / ask 卡 | answer | person |
| open findings | adjudicate | person |
| execution running/pending | — | working |
| 无活任务 | — | idle |
| done/ended | — | ended |

排序：`awaiting=person` 优先 + `cabin_jobs.priority` DESC。等谁分级仿 superagent stage.ts（person/working/idle/ended，first-match）。

## 一次一问纪律
- orchestrator 提示强约束「一次只推进一条、提问用对话正文」（现成于 chat-event-bridge:1011）。
- message-filter：仅末条未答 ask 卡激活。
- UI 一次聚焦一条（CabinAttentionQueue 点条目→chat 定位 select-task/卡）。
- 多 wake 并发兜底：attention 派生排序 + UI 聚焦；必要时 orchestrator 合并问题。

## 复用卡
chat-event-bridge 零 LLM 卡（displayType:'event' + activity.actions）、incident-card（waiting_human「等你决定」，决策权 Agent 确认权人）、ask/decision 卡（ChatArea:700）。

## AttentionItem 数据形
`{id, jobId, stage:'review'|'answer'|'adjudicate'|'approval'|'blocked', awaiting:'person'|'working'|'idle'|'ended', title, question?, detail, taskId, repo, wt, deepLink, priority}`。deepLink→chat select-task/select-session 或定位卡。

## 不新建队列表
收件箱 = transcript append-only 卡 + incidents；attention 仅派生视图。串行靠提示+UI，不靠 DB 队列（与 Octopus 现状一致）。