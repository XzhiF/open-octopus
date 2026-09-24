# ADR-0023: 测试实例注册表 —— 验收拉起的常驻进程从"内存会话"升级为"落盘记账 + 自动回收 + 一键关闭"

日期:2026-09-24 · 状态:Accepted · 关联:ADR-0022(验收剧本与活预览)+ `scripts/dev.mjs` 端口/宿主协议(`~/.octopus/ports/`、`host-pids.json`)

## 上下文

ADR-0022 的 live preview 把"起不起、停不停"管得规矩,但管住的只有**本 server 进程内存里的那次会话**。三类进程在体系外漂着:

1. **detached/launcher 型 up**(compose -d、nohup、`pnpm dev &` 式探针拉起):up 秒退,会话 ready 后 server 的进程树杀够不着真身;
2. **server 重启**:会话 Map 是内存态,重启后连"这里有过一个实例"的事实都丢了,残留 listener 无人认领(实况:任务 worktree 的 web :3888 + server :3889 测试结束后挂了数小时,只能手动 netstat+taskkill);
3. **用户手动 `pnpm dev`**:worktree 起的 dev 树与平台无关,端口登记文件(`~/.octopus/ports/{safe}.json`)里有它但没人显示"它在跑",更没有安全的关闭入口。

abort 路径另有实现与文案不符的缺口:`POST /:id/abort` 一直宣称"预览会被一并 SIGTERM",实际 `stopPreviewQuiet` 只挂在验收决策路径上。

## 决策

1. **注册表 = 文件协议,不入 SQLite**:`~/.octopus/instances/{taskId}.json`(每任务一文件,原子写 tmp+rename,损坏降级为空不连坐)。与 ports/host-pids 同族:跨重启存活、可人工审计、零 migration。字段含 `source(preview-up|probe-launcher)`、`ports[]/pids[]/urls[]`、`shell_pid`、`down` 快照(命令+绝对 cwd)、`status(alive|stale|stopped)`。
2. **端口反查为权威,spawn PID 为兜底**:登记时机是"ready 翻绿/launcher 返回"这类**确实有东西在听**的时刻,PID 由 `findPidOnPort` 现场反查;`BashExecutor` 新增 `onSpawn(pid)` 只透出 shell 根,用于前台长驻型兜底树杀。reconcile 在读时做(无后台定时器):端口重查 → alive/stale 落回文件。
3. **回收(reclaim)与停止(stopPreview)分离两种语义**:stop 即响(fireDown 不 await);reclaim 要收敛 —— down **await** → `waitForPort(3s)` → 仍占端口的 `killProcessTree`(SIGTERM→5s→SIGKILL)→ 复核 → stopped 落账,全停删文件。stop/abort/决策路径在既有收尾后**异步追跑** reclaim(skipDown),专收 detached 逃树的孙进程。
4. **startup 只标记、shutdown 不回收**:启动扫注册表 reconcile + 日志报"发现 N 个存活测试实例",不自动杀 —— 开机即杀会误伤"用户故意留着继续验"的现场;跨重启残留交给 UI 一键回收闭环。
5. **close-dev 三重安全闸(全服务端重算,不信任前端)**:① 端口白名单(注册表 ∪ runbook views ∪ 该任务 branch 的 ports 文件)否则 403;② 宿主端口黑名单(`PORT`/`OCTOPUS_HOST_PORTS`/host-pids.json ports)否则 400;③ listener PID 及其**父链祖先** ∩ 宿主 PID 集(env ∪ 自身祖先链)否则 409。③ 独立于 host-pids.json 时效:server 的父亲就是 dev.mjs,文件过期也杀不掉自己。
6. **API 三面挂 tasks 路由组**:`GET /:id/instances`(entries + external 候选)、`POST /:id/instances/reclaim`(可选 entry_ids)、`POST /:id/instances/close-dev`({port})。`POST /:id/abort` 补 `stopPreviewQuiet + abortVerify`(容错不阻塞),让 abort 文案变成真话。
7. **UI**:验货台 PreviewBar 下新增 InstancesPanel(自取数据):entry 行 = 来源徽标/端口/PID/cwd/alive-stale 着色 + 关闭;external 行 = 黄警"外部 dev 实例"+ 关闭(ConfirmDialog 明说"终止整个进程树含 pnpm/dev.mjs 父进程");有存活实例时 4s 轻轮询等异步 reclaim 收敛,清零自停。

## 后果

- 验收拉起的常驻进程第一次有了**跨重启的户口**:测试结束不手杀,面板一键收尸;`pnpm dev` 起的 worktree 实例可被看见并被安全关闭。
- 已知残余:`pnpm dev &` 型无 URL 形状的 nohup 拉起扫不到端口,entry 诚实显示"端口未知";before/after 端口差分扫描留作后续增强(代码注释已钉)。
- `processAncestry` 在 Windows 单次 ~4s(PowerShell/CIM),只出现在 close-dev/启动清扫这类管理动作路径,reclaim 热路径不受影响;结果 memoize(env 进程内稳定)。
- 内存会话(previewSessions)保留不删:注册表管"OS 层的它在不在",会话管"这次起的日志/状态机",两本账各管一段。
- e2e/测试纪律:注册表与端口目录构造器注入,测试全程指 tmp,绝不写真实 `~/.octopus`。

## 文件

- 新:`packages/server/src/services/tasks/test-instance-registry.ts`、`host-guard.ts`、`packages/web-app/components/tasks/acceptance/instances-panel.tsx`、`__tests__/{test-instance-registry,tasks-instances,port-utils-ancestry,bash-onspawn}.test.ts`
- 改:`packages/engine/src/executors/{bash.ts,executor-config.ts,index.ts}`(onSpawn + 导出树杀原语)、`packages/server/src/{port-utils.ts,index.ts}`、`round-evidence-service.ts`、`routes/tasks.ts`、`packages/web-app/lib/tasks-api.ts`、`acceptance-surface.tsx`
