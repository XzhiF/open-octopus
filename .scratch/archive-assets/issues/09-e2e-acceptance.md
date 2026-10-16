# 09: E2E 全链验收

**What to build:** 一票收全链真跑：归档一个真 task → 素材包+总结+判例+skill 草案全部出现在知识中心对话流 → 对话修改草案 → 授予 operator → 下一次真实执行 JSONL 见 Skill 调用 → 撤销后缺席；清理账复验；复跑脚本化 + 反假跑核查 + 故事证据映射。

**Blocked by:** 02, 03, 04, 05, 06, 07, 08（全链就位）

**Reference:** spec §Testing Decisions E2E 行 · matt-e2e-test-methodology（R1-R8）· kc15-rerun.mjs / e2e13-rerun.mjs 复跑先例

**Status:** done

- [x] dev 实例隔离端口 / 分支库播种（默认库只读或经对账后快照）；真 provider 真跑闸（models/test latency + JSONL turn_usage）；保护端口不碰
- [x] 链① 归档：真 task 走 v4 验收链归档 → 素材包六件+manifest hash 互验 → 总结+编译触页 → 素材包卡清单；对话剔除一件重编译生效
- [x] 链② 判例：含报错→修复序列的归档自动出判例（五段+source 可定位）→ 判例卡；同症状二次归档 → occurrences+1 不双档
- [x] 链③ skill：草案卡 → 对话修改 → 授予 operator（回执卡：版本+预置源）→ 真实执行 JSONL 见 Skill 加载/调用 → 撤销 → 再跑缺席
- [x] 链④ 摘要：任务板搜索命中语义摘要
- [x] 链⑤ 清理复验：pending_review 表不存在 / kc15-* 沉淀页已在 _retired / INDEX 必读路径 agent 可达 / 日期源自纠真跑（karpathy gist 靶）
- [x] 复跑脚本化（kc15-rerun 模式）全绿可重证；反假跑 R1-R8 逐项；证据包（JSONL 原行/DB 行/API JSON/git 行/卡片数据面）落 e2e-report.md
- [x] 35 故事 → 证据映射表（verification-report 素材）
- [x] 拆机三段式；fixture 前缀可识别、审计面保留声明

## Comments

- **2026-10-14 (票09 E2E 执行者)** 判定 **GO（PASS-WITH-FIXES）**。真 provider（~40 往返含 cache 记账）+真 git+真 fs/三账/DB/JSONL 六面交叉；两 pass 142 断言（pass1 tag 20261014P1 105 绿+2 脚本自纠[已修复证]+2 观察声明；pass2 幂等面 33[32 绿+1 观察]）。五链：①3 真 v4 任务全自动归档，素材包七件三向 hash 互验 7/7，arc 编译 406s 触 8 页，剔除→rc1 重编译 210s committed+409 ALREADY_EXCLUDED；②case-archive 4 件 committed、五段+source 对号、并档不变式绿（occurrences 自然+1 未触发=真模型三改写异名 jaccard 按设计不并，机制 S1 钉，如实 PARTIAL）；③a/c 路草案零注造自然触发、revise 真 LLM、grant→1.0.1 发布+预置源三账+top-up、**真实执行 JSONL toolName:"Skill"×4 原行（故事21 核心实证 SDK 原生发现零注入）**、revoke→rolledBackTo=1.0.0+archive+再跑缺席；④semantic_summary 2074B 落库+q=phase 命中+负对照；⑤pending_review 全无+/api/review 404+审计件在盘、kc15 12 页 _retired+本轮再 dogfood 5 页、INDEX ../user_preference.md agent 读行×10、**karpathy gist 第 4 投 committed（D-kc15-1 原症状治愈）**（自纠环未进入=模型自觉日期进 sources 豁免页，probe 激将亦不触，PARTIAL 非 FAIL——S1 已钉机制）。
- **D-aa16-1 已修**（quick fix 特批）：isVersionedClone 读顶层 versioned 而真盘落盘嵌套 config.versioned ⇒ 授予恒不发版——兼容双读+fixture 换真盘形状（原 fixture 与实现互抄=tautological 教训入 commit message），commit `27fe2e08` push 集成分支，13/13+preflight 36 绿。**DEFER 两单**：D-aa16-2 L4 INDEX 预算闸 800 token 硬顶三连拒（新知识沉淀被挡，腾位才过——建议立票：分层渲染生效/预算动态化+容量预警）；D-aa16-3 page-retire 不清活页入链→死链潜伏 L5_LINK_BROKEN 殃及+矛盾 finding 对手页退役后 adopt 恒 failed（建议立票：入链摘除第四路/单侧裁决降级）。
- 报告 `.scratch/archive-assets/e2e-report.md`（票15 形制+35 故事映射+R1-R8）；复跑 `C:/tmp/aa-e2e16/aa16-rerun.mjs`（分步 state 续跑）；证据包 `C:/tmp/aa-e2e16/evidence/` 71 件。拆机三段式净、保护端口全程未碰、默认库零直写、aa16-* 前缀可识别、审计面保留声明在册；flow-a867bc4839 授予已主动 revoke 撤净；三任务留 done（账本一次决定）。
