# 14: 消费面 v3 切换

**What to build:** 所有查阅者（工作流 agent、task-author/doer）切到 v3 五类页与全局根：skill 教的阅读面换代、指针行改址、检索参数钉全局——引用纪律与导航协议一字不变。

**Blocked by:** 07（v3 库就位）, 08（注入已删，查阅是唯一知识通道）

**Reference:** spec §Implementation Decisions「消费链」· prototype Tab⑤（保留/改造清单 + 执行时序）

**Status:** done

- [x] octo-wiki skill「何时查阅」切五类页：项目/服务/工具→entities · SOP/工作流→topics · 术语/概念→concepts · 溯源→sources · 卡壳按症状→cases；导航协议/引用纪律/stale 上报/禁止事项原文保留
- [x] INDEX 必读节承接 user_preference「全文必读」语义
- [x] 指针行全改全局根：task-author / task-doer / 引擎身份装配（~50 token 零知识正文纪律不变）
- [x] search API 调用面 org=global
- [x] 资源预置链回归：运行时预置源同步为新 skill 文本——**必须走官方 resource upgrade 原语**（E2E 报告 addendum 教训：服务重启不同步预置源内容）
- [x] S3 装配断言：provider 捕获 skill 文本/指针行新形态；S1：skill 绑定测试更新（task-author/doer/archive/operator 四分身）

## Comments

**2026-10-13 实现（kc/14-consumption-v3 @0b24d9a4 → 并入集成分支 a0c22ee3，零冲突；+311/−589）**

- octo-wiki SKILL.md（+task-author/.claude 镜像/builtin-clones）：「何时查阅」四域→五类映射；导航协议第 1 跳=全局根 INDEX+必读节；第 3 跳 curl `org=global`+FTS5/LIKE 措辞（embedding 句删，spec Out-of-Scope 无开关不留）；stale 尾注改「巡检/策展人消费成 finding」（Tab⑤ 反哺时序）。**逐字节保留面由 S3 测试钉死**：节名/按跳计费/禁全库遍历/整篇消费/引用纪律三条目（含 D1 JSON 示例原文/[ref:]/stale 上报动作）/禁止事项整行
- 指针行：archive persona 改全局根+写闸句同步票 05 实态（唯一写闸·全局串行队列）+锚点句补「topics 硬约束小节」；doer/author 票 08 已全局根断言原样绿（task-doer-chat 15/15）；workflow-operator 零路径合规
- grep 清零：orgs/ 与旧四域词在知识面全零（task-author 的 repos/index.md 多仓域**有意保留**并被测试专门钉不误伤）
- 预置链：`scripts/sync-preset-skills.mjs`（官方 installOrUpgrade 原语，dry-run 报漂移/有漂移退码 1 零写入）；**主控 ops**：集成分支 build 后 `node scripts/sync-preset-skills.mjs --apply`，重启 server 即 persona 落位（版本化 seed 矩阵自动）
- 清账：僵尸 octopus-wf-e2e-tester.test.ts（fixture 早删的 collection error）整文件退役（−542 行）
- 测试：S3 装配链 4/4（installOrUpgrade→Provisioner→真物化全链）、S1 绑定四分身、并入后 engine 894/8=基线逐位、shared 917/1、providers 158/14、server 档案内、web /wiki 钉 org 后 13/13 不伤
- merger 代修入账（`9e5253fa`）：index.ts:579 顶层 getDb() 崩 7 import 级文件 → RevertTaskService 惰性化 +9/−2；崩溃 7 文件复跑 88 例全绿清零
- 遗留裁定（主控认可①-④）：persona 旧「审核队列 approve」句一并清（教已废通道且与 curate skill 矛盾，纯文本零行为）；/wiki 页钉 org 随票 09 删除面自然消亡

**真数据 ops 已执行（2026-10-13 主控）**：`node scripts/sync-preset-skills.mjs` dry-run 报 2 漂移（octo-wiki/task-author 预置源≠core-pack）→ `--apply` 官方 upgrade 原语双 APPLIED status=installed。persona/curate clone-tier 随下次 server 启动版本化 seed 矩阵落位（E2E 实例即新起）。
