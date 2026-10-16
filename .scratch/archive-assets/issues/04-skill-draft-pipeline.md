# 04: skill 草案产出 + 草案卡

**What to build:** 可复用操作流程自动变成待授予资产：三路检测（跨 task 重复操作序列 / 判例蒸馏的流程型标记 / 策展人编译时主动提议）产出 SKILL.md 草案，落知识根 drafts 区；知识中心对话里草案卡可预览、可对话修改。**只出草案，零自动授予**——授予是下一票的人裁动作。

**Blocked by:** 02（素材包为检测供料）, 03（判例流程型标记是检测源之一）

**Reference:** spec §Implementation Decisions「skill 草案管线」· 故事 15-17/24

**Status:** done

- [x] drafts 区契约：知识根 `drafts/skills/{name}/SKILL.md`（不在 wiki git 仓、不是知识页、不进 INDEX）；front-matter 记来源指针（素材包/exec/判例）+ status: draft
- [x] 检测三路接线：跨 task 工具序列相似（JSONL 面，阈值宽进严出——宁少勿滥，产出都过人裁）、判例蒸馏 finding 标「流程型」转草案、策展人编译素材包时主动提议；触发点 = 归档 hook + 巡检
- [x] skill 草案卡：SKILL.md 完整渲染（name/description/触发条件/步骤/纪律）+ 来源指针可点
- [x] 对话修改草案：owner 说改哪里 → 策展人改写 → 卡片刷新再预览（status 仍 draft）
- [x] 零自动授予负断言：草案产出不触碰任何分身目录/版本表
- [x] S1（检测 fixture：序列相似/流程型标记/提议三路各出草案；drafts 结构断言）+ S2（草案 CRUD 端点）+ S4（草案卡渲染与修改流）

## Comments

- **2026-10-14 (票04 implementer)** 分支 `aa-04-skill-draft` @ `196a3376`（基点=tip 无 merge）→ ff 入集成分支。drafts 区契约：`drafts/skills/{name}/SKILL.md`（非 wiki 仓/不进 INDEX，纯 fs 零入队——队列不适用此区，名闸+路径收敛闸防越界人工文件）；front-matter 来源指针（pack:/task:/exec:/case:）+ status 三值无 pending。幂等自决：同来源活跃⇒DUPLICATE_SOURCE 拒；同名异来源⇒后缀不静默覆盖；revoked 留档不挡再提议；改写=显式人裁通道才覆盖本体。
- 检测三路：a 跨 task 失败工具序列相似（skill-seq.ts 自建 LCS 保序判据，阈值 0.6/下限 3 钉值，语料=素材包 exec 件≤12 包）；b 判例蒸馏「流程型」判据（票03 产物无现成字段，在 rule_ref 读面自建词表判据只读）；c 策展提议 LLM seam（prompt 契约进 S1、≤3 防洪、source 不可定位兜底）。触发=ingestTask 第⑤步后新 dep `detectSkillDrafts`（链序 extract→detect→announce-pack 钉测、失败吞、deduped 不重检）+ patrol `afterPatrol` 钩。
- 草案卡 kind `skill-draft`（KC_CARD_KINDS 十一值）：SKILL.md 全文渲染+来源可点+「对策展人说（改写）」；**卡上零授予钮零分身选择器（S4 负断言）**。对话改写 `POST /drafts/:name/revise`（seam 回全稿、缺 `## 步骤` 拒不落半成品、status 恒 draft、source 逐字留、卡 action=revised 重发）。S2 CRUD 四端点+「零 grant 路由」负断言。
- 零自动授予负断言（S1+S3）：三路跑满+改写+退役+路由后假 OCTOPUS_HOME 整树 sha 快照 before===after、install 事件恒 0、agent_versions COUNT=0、队列零任务、granted 态对本票服务只读拒写 409。
- **附带修票03缺陷**：`parseCaseSections` 懒匹配 `$`（m 标志）⇒ 标准制式五段全空（卡面预览红而不显）；改行切分制，case-extract 17/17 复证无恙（主控 merge 后重建 dist 复跑 52/52 绿——workspace 假红教训同 windows-bash 档案）。另补 octo-wiki-curate P3 API 表（运行副本需重启刷新，票09 实例自然覆盖）。
- 测试：新 57 绿（S1 45/S2 6/S4 6）+回归六群；全量零新增红（36=基线 34+日历 2 名单甄别）；build/lint 绿。
