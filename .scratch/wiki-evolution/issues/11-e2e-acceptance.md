# 11: E2E 全链验收

**What to build:** 一票收全链真跑五链：记账链 / 数值处方链 / 泛化投喂链 / 深回滚链 / 自动退役+恢复链；复跑脚本化 + 反假跑 R1-R8 + 32 故事证据映射表。

**Blocked by:** 02, 03, 04, 05, 06, 07, 08, 09, 10（全链就位）

**Reference:** spec §Testing Decisions E2E 行 · matt-e2e-test-methodology（R1-R8）· kc15-rerun.mjs / aa E2E 复跑先例

**Status:** done (GO · PASS-WITH-NOTES，无产品码改动；PARTIAL=故事26 复合形移交 D-p4-ops-1 修复波)

- [x] dev 实例隔离端口/分支库播种（默认库只读）；真 provider 真跑闸（models/test latency + JSONL turn_usage）；保护端口不碰
- [x] 链① 记账：一条真实执行（as: 节点引用真锚点 + review 节点出 blocker）→ 手动触发解析 → 账目落行 → confidence 变化可见 →（构造低置信）finding 产出
- [x] 链② 数值处方：夜巡真跑 → health score 落健康条 → 膨胀/僵尸/重复至少各构造一例 finding → 裁决即编译 commit
- [x] 链③ 泛化投喂：非知识中心会话说"编进 wiki"+URL → 意图路由 → 卡片回流原会话 → 编译落库
- [x] 链④ 深回滚：回滚一个非 HEAD-adjacent 历史编译 → 状态重建成功、页/INDEX/LOG/FTS/DB 五路一致、git 线性
- [x] 链⑤ 自动退役：构造 90 天零引用+零入链锚点（时钟/账目 fixture 真数据面）→ 夜巡自动退役 + 通知卡 → 对话恢复 → 原号回迁
- [x] INDEX 预算复现靶：P3 三连拒源投喂成功 + 预警 finding 伴随（票 03 现场复证）
- [x] 复跑脚本化（kc15-rerun 模式）全绿可重证；反假跑 R1-R8 逐项；证据包（JSONL 原行/DB 行/API JSON/git 行/卡片数据面）落 e2e-report.md
- [x] 32 故事 → 证据映射表（verification-report 素材）
- [x] 拆机三段式；fixture 前缀可识别、审计面保留声明

## Comments

- **2026-10-15 E2E 执行者（we-11 @ fe4a5a48，零产品码改动，隔离全程）**：总结论 **GO（PASS-WITH-NOTES）**。链①真执行×7（JSONL turn_usage 36k cache 原行）→真 LLM 判道 helpful4/notHelpful4→游标幂等 scanned=0×3→sync 刷页 commit（oct-901→0.400/oct-014→0.000）→低置信 finding 落真页 wf-prd-impl；链②五类数值 finding 在场+**health score 独立手算 70 精确等值**（零 tautology）+adopt 位移+4+重复对合并 commit；链③ main 会话真 LLM 131s 路由 ingest_to_wiki+双拍卡回流**原会话**+新页落库；链④非 HEAD-adjacent 靶状态重建 committed、deep-revert 行逐字、--merges 空、五路一致、raw 零触碰；链⑤ scheduler 作业腿（唯一自动口）auto-retire 恰 1 枚+LOG `·auto` 原行+通知卡零审批钮+恢复原号原行入链**字节级反放**+域外负断言不自动；⑥ INDEX 复现靶恒见 772 放行伴随预警/1335 拒+压缩建议+反证收敛形。R1-R8 逐项，断言自纠×11 全脚本侧、产品面仅两枚正确拒止（RAW_HASH_MISMATCH/WORKTREE_DIRTY）。
- **交付物**：报告 `.scratch/wiki-evolution/e2e-report.md`（六面交叉/82 件证据）· 复跑 `C:/tmp/we11-e2e/we11-rerun.mjs`（存档 `.scratch/wiki-evolution/we11-rerun.mjs`）· 分支库 `octopus-we-11-e2e.db` · 默认库/真盘零直写（真盘 HEAD 基线原行自证）。
- **缺陷账**：**D-p4-ops-1 构造证实锤**（故事 26 复合形：同页矛盾标记+标记外正文活链同指一退役页→单侧降级被 L5_LINK_BROKEN 挡恒 failed；原行 fft-20261015T1534-003；简单形已实证 PASS）→ 交 /code-review 定夺修法（票13 修复波）。观察项非缺陷：curator 按文件名 stem 造链（id≠stem 触 L5，建议入笔记纪律）、一工作区一根执行引擎契约、有机数据薄=两波口径预期。
- **32 故事映射**：31×PASS + 1×PARTIAL（故事26 历史复合形）；spec「机制正确+构造/烟测数据」验收口径满足，confidence 真实收敛随运营增厚（两波节奏）。
