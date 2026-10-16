# 10: 归档自动投喂

**What to build:** 任务归档零人工沉淀知识：task 进入 archiving 态时自动产出一份完整总结落 `raw/archives/`，异步触发串行编译；编译成败不影响归档完成（K11 语义零触碰）。旧经验提炼/归并管线由本票替代删除。

**Blocked by:** 05（编译管线）, 06（写串行——归档编译必须入队）

**Reference:** spec §Implementation Decisions「注入链与旧库硬废」归档自动投喂段 · prototype Tab③（Ingest 入口 B）

**Status:** done

- [x] archiving 态一次 LLM 调用生成完整总结（验收台账 / 关键决策 / 踩坑 / 产出指针）→ `raw/archives/task-{id}-summary.md`（冻结 + hash，与 02 同契约）
- [x] 异步触发编译（进全局串行队列）；编译失败不阻塞 done、不回滚 K11 归并；任务状态可查
- [x] 旧经验提炼/归并管线删除（三级提炼、experience-merger——归档产物改走 raw 投喂）
- [x] 归档一个真实 task 验收：总结落 raw + 编译产物（触及页/commit）可查 + done 判定语义不变（git 失败仍停 archiving 可重试）
- [x] S1 测试：总结 fixture → raw 落盘 → 编译触发；失败不阻塞断言；K11 回归绿

## Comments

**2026-10-13 实现（kc/10-archive-ingest @781ac9a8 → 并入集成分支 7fb3b66f，零冲突；+1274/−3031）**

- 挂载点=beginArchiving 新钩子（非替换 setArchivingHook、非 onComplete）：`archiving-service.ts` 与 git **diff 零行**——K11 零触碰实锤；done 唯一写者不变；`ingestTask` 永不抛（总结失败跳过投喂=离线闸同款兜底、编译失败走队列失败语义）
- 新 `services/tasks/archive-ingest-service.ts`（四段总结 prompt 契约 + `task-{id}-summary.md` 命名 + `arc-{taskId}` 确定性任务 id）+ `archive-ingest-llm.ts`（OCTOPUS_KNOWLEDGE_LLM_DISABLED/OCTOPUS_ARCHIVE_SUMMARY_MODEL）；票 02 契约扩 `ingestText(fileName,origin)`（wx/同 hash 幂等/异 hash CONFLICT）；编译经 `enqueue("archive-compile")`
- 旧管线删除：archive-analysis-service/experience-merger/context-builder/prompts/skill-discovery/analysis-assembler + 3 测试；archive-preview 端点随删（web lib/archive-api.ts 字符串耦合残留 404=票 09 删旧归档页时收敛）；**experiences 表与数据零动**（票 09 删除面）
- 状态可查最小面=票 06 GET /queue/task/arc-{taskId}（未新建路由/字段；UI 归档卡消费面=票 12 渲染已就位）
- AC4 **真跑**：`scripts/kc-archive-ingest-e2e.ts` 23 断言全 PASS（真 sonnet 总结+真 curator 编译+真锁真 git，wiki commit `ff5426d` 触 5 页、回指 sha256 互验、重归档幂等，122.8s）；生产真任务 acceptance→done 全链留票 15 链③
- 测试：S1 14/14；并入后 tasks 域 237 全绿、knowledge 252 全绿、v4 archiving+acceptance 50/50；routes 域红=档案 archive-routes×10 精确吻合；build+lint 绿
- 基线档案扩充（主控登记）：archive-service×6、config-manager×4、path-guard×6、detector-pipeline×2 为 Windows 既有红；另本票揪出**票 12 集成红**（index.ts:579 顶层 getDb() 崩 7 import 级文件）——修复随票 14 merger 打包执行
- 遗留：总结失败无重试通道（幂等闸只挡成功件；retryArchive 不重投喂）=轻量版口径，四路分流属 P3
