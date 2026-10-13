# ADR-0031: wiki 全局写串行 — 进程内 FIFO 队列 + wiki 根锁两级互斥

Date: 2026-10-13
Status: Accepted
Related: ADR-0030（唯一写闸本体——本篇是其外层互斥）；`.scratch/knowledge-center/spec.md` §全局写串行（owner 裁决 2026-10-13「wiki 写入不许并发」）；落码 = 知识中心票 06（`compile-queue.ts` / `wiki-lock.ts` / `curator-task.ts` 整包）

## Context

一次编译 = 触 N 页 + INDEX.md 程序化重建 + LOG.md append + FTS/DB 同步 + git commit。并发两路编译必互踩：git index 冲突、INDEX 竞态（读-改-写跨任务交错）、锚点发号双花（全库 max+1 无串行化时天然有竞态）。投喂入口不止一路——知识中心对话、任务归档自动投喂、finding 裁决即编译、回滚、lint 自纠、重蒸馏脚本，任何一路都能独立触发编译。

## Decision

**全局单串行，两级机制**：

1. **进程内全局 FIFO 编译队列**（`CompileQueue`，`WRITE_OP_KINDS` 单源枚举）：投喂编译/归档编译/对话修订/lint 自纠/finding 修复/回滚 revert/重蒸馏七类写操作共队互斥；同刻至多一个任务在跑，后到者排队、位次 #N 可查（UI 卡「排队中 #N → 编译中 → 已提交」）。**任何写通道不得绕过本队列直写 wiki**。
2. **wiki 根锁文件**（`.compile.lock`，跨进程保底）：防同机双实例双写；PID + 心跳判 stale，进程崩溃后锁自动回收，一次崩溃不卡死全局。锁文件写进 `.git/info/exclude`，永不入仓史。

语义边界：**读永不锁**（浏览/检索/agent 查阅零参与）；**raw 落盘不入队**（新增不可变文件无共享状态），其触发的编译才入队；单任务失败 ⇒ 自身事务回滚（编译服务内建原子性）→ 释放锁 → 队列继续，不堵死全队；锚点发号在串行化后竞态天然消失。可观测面：队列深度进健康条。

## Considered Options

- **只靠编译服务内部事务（DB/文件级锁）** — 被否：服务事务保护单次编译的原子性，保护不了**两次编译之间**的 git/INDEX/锚点共享态；git 操作在 shell 子进程，事务够不着。
- **只用锁文件（无进程内队列）** — 被否：拿不到锁即失败需要重试层；位次/深度这些 UI 契约（「排队中 #N」）必须有显式队列承载。
- **按页/按目录细粒度并行** — 被否（owner 裁决）：INDEX/LOG/git 史是全局共享写点，细粒度并行换来的吞吐抵不上交错污染的审计成本；库规模（数百页）下串行延迟可接受。

## Consequences

- server：`compile-queue.ts`（FIFO + 任务表 Map，容量逐出）、`wiki-lock.ts`（stale 回收用假 PID 可测）、`curator-task.ts` 的 `start()` 整包进队列（registry 与路由契约零改动）；`index.ts` 装配全局单例队列（锁指向 `resolveGlobalWikiRoot()`）——curator/backfill/finding-fix/revert/redistill 各写通道共用一队。
- 任务表为进程内：重启丢任务史，真相面 = git commit + LOG 行（队列侧 failed 与任务 registry 读时对账）；持久任务表不在本期（后续清理）。
- 测试面：并发双投喂**真并发**断言 git log 线性（无 merge commit）、LOG 时间线不交错、锚点无双花（spec Testing Decisions「并发断言必须真并发」）。
- 与 ADR-0030 的写闸关系：队列+锁是「外层互斥」，编译服务是「内层唯一落盘口」，pre-commit 是「git 层纵深」——三层各钉各的（wiki-write-queue.test.ts / wiki-write-gate.test.ts）。
