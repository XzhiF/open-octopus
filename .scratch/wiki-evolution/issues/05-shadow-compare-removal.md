# 05: shadow-compare 物理删除

**What to build:** 无消费者的死账清零：shadow-compare 端点、服务、测试、类型全删；过闸文书与 KC E2E 报告中的证据引用加注归档位置（删的是端点不是审计链）。

**Blocked by:** 01（P3 合入）

**Reference:** spec 故事 27 · KC 分支边界注（ab36d987「清理前勿新增消费者」——本票即该清理）· p2-gate-pass.md §2（证据指针）

**Status:** done (merged → integration `f76ef0cd`)

- [x] 端点（executions 路由下 shadow-compare）+ 服务模块 + 相关测试 + shared 类型/键常量（SHADOW_* 单源）全删；grep 全仓零僵尸引用
- [x] VarPool 影子键文档注记清理（__relevant_rule_ids/__injected_rule_ids 生产端已随票 08 删除，读取面本票收口）
- [x] p2-gate-pass.md 与 KC e2e-report.md 的证据引用处加注：「端点已于 P4 删除，数据面见本文件存档原行」（追加注记不改写原文）
- [x] 全测试套件绿 + lint 绿
- [x] S2：旧端点 404 断言（路由消失的契约面）

## Comments

- **2026-10-15 implementer（we/05-shadow-removal @ f76ef0cd，diff 9 文件 +93/−501 全在票面射程）**：shadow-compare.ts 整删（SHADOW_* 实测在 server 非 shared，按实况）；execution.ts 路由块 :275-300 摘除；shared knowledge.ts 边界注去 shadow 措辞（WIKI_REFS_KEY/STALE_REF_PREFIX 存活信道本体保留）。engine wiki-refs-persistence 两处只清影子消费、wiki_refs 落池契约未删伤（2/2 绿）；injection-removal :128-130 负断言=保留资产。代码面 grep 僵尸命中恰 1=404 契约测试自身。历史治理文（GLOSSARY-MAP:35/ADR-0030:20）与 .scratch/research 存档按 E4 §9 不删不改。
- **红线4 时序合规**：主仓三证据文书五处追加归档（p2-gate-pass §2 / KC e2e :78/:169 / aa e2e :79/故事33†）先于 git rm 落盘，追加式零改写。
- **S2 404 契约**：新 shadow-compare-removal.test.ts 三例，TDD 红（删前 expected 200→404）→绿（删后 3/3）。
- **主控核验注**：全量 65 红经逐文件根因复证归为基线（server34+engine8+web3+shared1）+日历字面判据3+subsystem cwd假红+providers14环境既有，与本票删除 diff 无因果路径；lint 0 err。诚实注记：断点重启吞掉「先跑局部基线」，以根因复证替代——留 /code-review 双轴终审兜底。
- **ff 入集成**：merge-base --is-ancestor 确认集成分支 tip(eca3b4ce) 为父，fast-forward 至 f76ef0cd，push origin。
