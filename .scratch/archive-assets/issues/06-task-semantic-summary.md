# 06: 语义摘要进任务板

**What to build:** 归档后的 task metadata 带语义摘要（干了什么/关键决策/产出指针），任务板搜索能命中——历史任务不再靠记忆定位。

**Blocked by:** 01（KC 合入）

**Reference:** spec §Implementation Decisions「语义摘要」· 故事 25-26

**Status:** done

- [x] 归档总结的语义摘要（首段或独立字段）写入 task metadata（沿既有 metadata 通道，无新表）
- [x] 任务板搜索命中摘要字段（沿用既有搜索通道——FTS 或 LIKE 现状，零新基建）
- [x] 历史已归档 task 无摘要不报错（宽容读）
- [x] S1（归档 fixture → metadata 断言）+ S4（板上搜索消费面）

## Comments

- **2026-10-14 (票06 implementer)** 分支 `aa-06-semantic-summary`（feature `efc31ec8`）→ 合入集成分支（ff→`2b2081b6`）。spec「沿用既有通道」前提不实（tasks 无 metadata 列/无服务端搜索，勘探笔记 web-grant.md 已录），按主控裁最小新建：`tasks.semantic_summary TEXT`（ensureColumn 幂等加列，ADDITIVE 不 bump 版本）+ `GET /api/tasks?q=`（DAO searchActive LIKE+转义）+ 任务板最小搜索框 `task-search`。归档链在 raw 冻结后纯插入 11 行写整份四段总结；历史 NULL 宽容读；K11/done 唯一写者零触碰（setSemanticSummary 不动 status/version）。
- 测试：semantic-summary 11 绿（先红后绿，tmpdir 文件 DB）+ board-search 2 绿；不回归 8 套件 186 例全绿；build+lint 0 错；`shared/model-alias.test.ts` 1 红=本机真 models.yaml 环境性预存红与本票无关。
- 给票02 merger 的预告：archive-ingest-service.ts 纯插入段在「冻结后 enqueue 前」；票02 若重构该文件，保住总结变量可用或把 setSemanticSummary 挪到总结生成点，行为不变。
