# 15: E2E 真跑验收（全链证据包）

**What to build:** 一票收全链：真 provider 跑通 投喂→编译→diff 卡→回滚→再投喂、并发串行化、归档自动投喂、agent 查阅 v3 库、stale→finding 闭环五条链，证据包落 e2e-report，复跑脚本化，反假跑核查齐。

**Blocked by:** 09, 10, 12, 13, 14（全链就位）

**Reference:** spec §Testing Decisions E2E 行 · matt-e2e-test-methodology（R1-R8）· llm-wiki-loop/e2e-report.md（先例格式与复跑脚本模式）

**Status:** done

- [x] dev 实例隔离端口 / 独立 DB 快照（默认库只读）；真 provider 真跑闸（models/test 实测 latency + JSONL turn_usage 含 cache 记账）；保护端口 3000/3001/3098/3099 不碰
- [x] 链① 投喂：真文章 → raw 冻结（hash）→ 编译触 ≥3 页 → diff 卡 → **回滚** → 再投喂（git 史线性干净）
- [x] 链② 并发：两路同时投喂 → 串行落库（LOG 不交错、git 无 merge commit、锚点无双花）
- [x] 链③ 归档：真实 task 归档 → 总结自动落 raw/archives → 异步编译 → 归档卡；done 语义不变
- [x] 链④ 消费：跑一条含 as: 节点的工作流 → JSONL 见 INDEX→v3 页 Read 序列 + wiki_refs 新锚点落池 + 产出 [ref:] 标注；存量流（无 as: + octopus_agent）回归
- [x] 链⑤ 反哺：制造 stale 上报 → finding 出现 → 对话裁决 → 修订编译 commit
- [x] 复跑脚本化（e2e13-rerun 模式）全绿可重证；反假跑 R1-R8 逐项核查；证据包（JSONL 原行/DB 行/API JSON/git 行/页面状态）落 e2e-report.md
- [x] verification-report 素材：spec 43 故事 → 证据映射表
- [x] 拆机三段式收尾；fixture 前缀可识别、审计面保留声明

## Comments

**2026-10-13 E2E 真跑（PASS-WITH-DEFECTS / GO）— 全报告 `.scratch/knowledge-center/e2e-report.md`，脚本+证据 `C:/tmp/kc-e2e15/`**

- 五链全 PASS：①真文章 12266B 冻结→编译触 6 页 `bf6928d`→revert 四路重同步→再投喂 dedup+真编译 `e5027f7`，git 线性 ②Promise.all 双路串行（running+queued#1 位次、LOG 完整不交错=完成序、锚点全库唯一）③真实任务 `dd48c3a5` accepted→done，四段总结+hash 互验、`arc-` committed、wiki `73cffb3`、K11 零触碰 ④JSONL INDEX→v3 topics 页整读、wiki_refs 真锚点落 VarPool+DB、[ref:] 原行、injectSide 恒空（agent 真流自发 stale，未注造）⑤patrol 45 findings→adopt→`66a45ff` 修订 commit→resolved+Lane A 回执；health openFindings 0→45→44→43、queueDepth 真联动；/wiki /experience→307
- 复跑两遍全绿（78/78→79/79，链③走「账本一次决定」不变式）；R1-R8 逐项 ✓；保护端口未碰；默认库全程只读；审计面保留声明（分支库+wiki 17 commits+kc15- raw 8 件）
- **缺陷转后续票（DEFER，未越权修）**：D-kc15-1 一手源含日期⇒L5 恒拒且 API 编译面无 lint 自纠/重试通道｜D-kc15-2 INDEX「必读」指 `user_preference.md` 但实体在知识根，agent 整读扑空（票14 语义半兑现）｜D-kc15-3 revert 干净窗仅 HEAD-adjacent（历史深回滚契约报 REVERT_CONFLICT，零副作用实证）｜D-kc15-4 /api/agent/* Bearer 仅验在场占位——生产部署前必接真鉴权
- 拆机三段式收口（含孤儿监听 40352/9152），netstat CLEAN
