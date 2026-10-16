# 02: 素材包持久化 + 编译读包

**What to build:** 任务归档时素材包整体落 raw（目录 + manifest + hash），总结与编译改为读包；知识中心出现素材包卡（清单 + 剔除重编译）；对话里"重新编译 task-XXX，重点看 phase-2 打回那段"真能从包里取到原始记录——一份素材，多次提炼。

**Blocked by:** 01（KC 合入 + 对账）

**Reference:** spec §Implementation Decisions「素材包」· 故事 1-7 · KC 插座：archiveIngestHook / CompileQueue / 卡片注册表

**Status:** done

- [x] 归档 hook 升级：`raw/archives/task-{id}/` 目录 + manifest（每件 kind/origin/path/bytes/sha256）；六类素材齐——验收台账、phase 打回记录、执行 JSONL 关键事件摘录、PR diff（stat 级+关键 hunk，全量指回 git）、matt 产物指针、ADR/context-notes
- [x] 摘录纪律：JSONL = 关键事件提取（error/tool_error/retry/fix-commit 关联行，带 exec 指针），非全量拷贝
- [x] 总结生成改读包；编译读包 manifest 先行、按需下钻（token 预算面有断言）
- [x] 素材包卡：件清单（名/类/大小）+ 剔除某件 → 重编译钮（经全局串行队列）
- [x] 对话重编译：焦点指令（"重点看 phase-2 打回"）产物体现包内原始素材（引用可解析回 manifest 件）
- [x] 历史单文件总结归档兼容读（旧 task 不迁移不报错）
- [x] 失败语义：素材包落盘/总结/编译任何一步失败不阻塞 done，K11 归并零触碰（回归绿）
- [x] S1（真 fs+tmpdir：包结构/hash/摘录纪律/幂等）+ S2（重编译端点契约）+ S4（素材包卡渲染与剔除流）

## Comments

- **2026-10-14 (票02 implementer)** 分支 `aa-02-material-pack` @ `1ad02363` → ff 合入集成分支。base=tip c6bdd0ef（票01/06/07 已含）。
- 实现：ingestTask=素材包落盘(先)→总结读包→总结为包内第七件→入队编译读包；`raw/archives/task-{id}/`+manifest（kind/origin/path/bytes/sha256 六件，件级冻结复用 raw.ts 单源）；JSONL 关键事件提取（error/tool 失败/重试/fix-commit，≤200 行带 exec 指针，**冻结发生在归档当下**避 worktree 删除坑）；diff=--stat+top3 hunk；`curator.compilePack`=manifest 恒进 prompt+超预算件整件不载入显形+焦点件放宽预算，幂等键=包 digest⊕焦点，回执 `sources/task-{id}.md`。
- 新卡 kind `material-pack` 一行注册+Lane A 生产者 announcePack；剔除→重编译**复用 archive-compile opKind**（WRITE_OP_KINDS 未动，红线2成立），队列 id `arc-{taskId}-rc{N}`；`POST /api/knowledge/wiki/pack/:taskId/recompile {excludePath?,focus?}`。历史单文件兼容读（legacy 视图，不迁移）；失败收敛 skipped/failed 不阻塞 done；总结件不可剔（400 护栏）。
- 测试：新 27 绿（S1 11+4/S2 8/S4 4 先红后绿）+archive-ingest 14/14 语义逐条保留；全量 server 49 红=基线 46+基点复证日历预存 2+并发 flake 1（单跑绿）**零新增红**；web/shared/engine/cli/build/lint 全绿。
- 下游账：票03 用 loadPackForCompile/readPackManifest 取 exec-jsonl-excerpt+phase-rejections，case-archive 扩枚举须同步 wiki-write-queue.test.ts:87 逐字断言；票04/05 抄 announcePack 接线+`mdp-` 卡 id 型；坑=raw.ts 导出正则不含收尾换行（stripRawFrontMatter）、tmpdir 首建仓 30s 假红、日历硬编码断言预存红 2 例（finding-ops/wiki-revert-routes）待立修、重编译暂不刷新 semantic_summary（票06 后续可接）。
