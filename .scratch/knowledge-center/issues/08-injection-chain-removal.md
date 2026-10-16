# 08: 注入链硬废（P2 执行）

**What to build:** 引擎回归纯编排（D6② 硬废，过闸文书已生效）：任何 agent 节点的 prompt 里不再有一个字的注入知识——知识只来自 agent 主动查阅。删除后全测试绿、双入口一致、存量流零回归。

**Blocked by:** 01（Ops 前置）, 03（全局根生效，指针行才有正确目标）

**Reference:** spec §Implementation Decisions「注入链与旧库硬废」· p2-gate-pass.md（§5 缓解条件全部生效）· llm-wiki-loop prototype Tab②（12 注入点 D2 裁决清单 #1#8#10#11#12）

**Status:** done

- [x] 物理删除：PromptInjector（pipeline prompts 消费）· KnowledgeInjector · precompute（__relevant_rule_ids / __user_preference_text 预计算）· 透传链 · knowledge.mode 三态配置（回滚靠 git revert + 归档还原，不留运行时开关）
- [x] pi prompt-enhancer 知识段指针化（一行：全局 wiki 根 + 查阅纪律）
- [x] task-author / task-doer 指针行改指全局根（~50 token，零知识正文，语义不变）
- [x] shadow-compare 端点冻结只读：注入侧字段恒空、历史对照数据仍可查（过闸文书证据链审计面）
- [x] 保留注入面零改动断言：Host 安全规则 / goal 执行上下文 / Task Contract / SDK settingSources
- [x] S3 验收：mock provider 捕获——prompt 零注入文本、仅任务书+指针行；precompute 零触发；存量流（无 as: 节点 + octopus_agent 委托）回归全绿；CLI/Server 双入口行为一致
- [x] 回滚预案注记：git revert 本票 commit + _archive 还原 org knowledge 即可恢复注入世界（预案写入票 Comments，供 M2 验收引用）

## Comments

**2026-10-13 实现（kc/08-inject-removal @5602dbda → 并入集成分支 a7059582，53 files +524/−2687）**

- 删除面：engine prompt-injector/knowledge-injector/precompute-gate（**collectAgentIdentityRefs 逐字搬家至 identity-assembly.ts**，D2=770d9fa6 挪用面保住）；server KnowledgeService 整类/precompute/repo-resolver/getEffectiveUserPreference；shared 三态配置与透传类型面（KnowledgeMode 全家+pipeline prompts 字段，WIKI_REFS_KEY/STALE_REF_PREFIX 查阅信道常量保留）；退役测试 engine×7+shared×1+server×3
- 超 AC 专删两处（precompute 零剩余消费者件）：repo-resolver.ts、file-ops.getEffectiveUserPreference——「全量 grep 不留僵尸」口径内
- 指针化：pi prompt-enhancer D2 裁决#12 落位（缺省=pi 兼容）；task-doer-service:411 与 task-author augmenter 改 `resolveGlobalWikiRoot()`（票 03 单源）；shadow-compare 冻结只读注释钉、逻辑零改
- 审批双写 append 轨剔除（approveItem 结案不写旧知识文件；审批队列本体未动=票 09）
- 测试：engine 894✅/8❎（=基线）· injection-removal 10/10 · cli 136/136 · providers 14❎=基线 · shared 1❎=环境红 · web 32/32 · server 对照基线 0961a04e 复跑**逐名一致零新增**（作用域真实基线红=archive-routes×10+clone-file-mgmt×10+harness-integration×4+tasks-verify×2+leaderboard×1，已为主控记录入 merger 基线档案）；build+lint 0 error
- 留账：octo-wf-e2e-tester.test.ts collection error（fixture yaml 早被 8ff09db5 删）=祖先预存，另票清理；GLOSSARY「影子期」废弃标注走 standards retro；octo-wiki/archive persona 的 org 根措辞留票 14

**回滚预案（AC7，供 M2 验收引用）：**

恢复注入世界 = 代码 revert + 数据归位两步，**无运行时开关**：
1. **代码**：删除全在 `890fdc7c`（+5602dbda 测试补口、ed4dbfe5 并入 merge）。已并入后单条 `git revert -m 1 a7059582` 即整体恢复注入链；回滚后 `pnpm build`+全量测试即回到影子双轨态。
2. **数据**：org knowledge 目录与 user_preference 原件本票未删（归档删除属票 09）——revert 即恢复读者。若票 09 已归档，按过闸文书 §5：`_archive/org-knowledge-{date}/` 整目录还原回 `~/.octopus/orgs/{org}/knowledge/`（user_preference 原件随目录归位）。
3. **mode 残键**：分身 config.json 的 `config.knowledge.mode` 未动盘上文件；revert 后 `resolveKnowledgeMode` 自动重新生效（纯回滚态置 `inject`）。
4. **验证**：agent prompt 重现 `Knowledge Rules —/User Preferences` 段、VarPool 重现 `__relevant_rule_ids/__injected_rule_ids`、shadow-compare 注入侧恢复非空。
