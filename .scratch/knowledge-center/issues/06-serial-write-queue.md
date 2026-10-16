# 06: 全局写串行 — FIFO 编译队列 + wiki 根锁

**What to build:** owner 裁决（2026-10-13）：**wiki 写入不许并发，全局单串行**。一切写操作经全局 FIFO 队列 + wiki 根锁文件，一次只许一个编译在跑；读永不锁；崩溃不卡死。

**Blocked by:** 05（多页编译管线）

**Reference:** spec §Implementation Decisions「全局写串行」· prototype Tab③（全局写串行节：写操作源×6 / 队列 / 锁 / 读不锁 + 四条语义）

**Status:** done

- [x] 六类写操作统一入队：投喂编译 / 归档编译 / 对话修订 / lint 自纠 / finding 修复 / 回滚 revert（+重蒸馏脚本走同一队列）——队列包住唯一写闸
- [x] 进程内全局 FIFO 异步互斥（主控）；后到者排队，任务带位次
- [x] wiki 根锁文件（跨进程保底，防同机双实例双写）：PID+心跳；进程崩溃遗留的 stale 锁自动回收
- [x] 读永不锁：编译进行中，浏览/检索/agent 查阅（INDEX/页 Read/search API）正常
- [x] raw 落盘不入队（新增不可变文件无共享状态）；其触发的编译入队
- [x] 失败语义：单次编译失败 → 自身事务回滚 → 释放锁 → 队列继续（不堵死全队）
- [x] **真并发验收**：两路同时投喂 → git log 线性无 merge commit、LOG 时间线不交错、锚点发号无双花
- [x] 队列可观测：深度 + 每任务位次（#N）API 可查（UI 票 12 消费）
- [x] S1 测试：并发串行 / 锁 stale 回收 / 失败不堵队 / 读不锁 四组（真并发调用，非顺序模拟）

## Comments

**2026-10-13 实现（kc/06-serial-queue @35d4e563 → 并入集成分支 5e09a08c，零冲突）**

- 新 `wiki/compile-queue.ts`（进程内 FIFO + `WRITE_OP_KINDS` 七类单源：ingest-compile/archive-compile/dialog-revise/lint-fix/finding-fix/revert/**redistill**）+ `wiki/wiki-lock.ts`（`.compile.lock` PID+心跳双判据 stale 回收；O_EXCL 建议锁，TOCTOU 微秒窗口如实注记——spec 裁决粒度不需要 OS 级原语）+ `routes/wiki-queue.ts`（GET /queue、/queue/task/:id）
- 接线：curator submit 改走队列（票 05 契约零改）；health `queueDepth` 注实值（票 11 形状冻结兑现）；`ensureWikiGitRepo` 幂等把锁文件写进 `.git/info/exclude`
- 跨实例被占语义（票面未定，本票拍板）：等待至多 5min（覆盖实测 169s 编译）→ `LOCK_HELD` 走失败语义；阈值可注入
- 真并发三断言证据（Promise.all 双路+真 git）：`git log --merges` 空且 rev-list==2 线性 / LOG 恰 2 条完整行不交错先完成者在前 / 锚点 oct-001..004 Set==len 无双花；附加证「第二路 prompt 含第一路页=串行读最新态」「终局 git status 空、ls-files 无锁」
- 测试：S1 14/14 + S2 7/7；并入后 scoped 659 例仅 archive-routes×10 预存红；基线档案其余（clone-file-mgmt×10 / harness-integration×4 / tasks-verify×2 / db-schema×2 / leaderboard×1 抖动位）在 `src/__tests__` 下，单独复证逐名一致零新增
- 接位：已通知并行中的票 07 收口接 `enqueue("redistill")`；票 10=archive-compile；票 12/13=revert/dialog-revise/finding-fix 通道
- 遗留旁路注记：LLM-WIKI 旧轨直调 compileEntry 的路由未回接队列——属审批废除清单随票 09/13 消亡；新增写通道一律 enqueue
