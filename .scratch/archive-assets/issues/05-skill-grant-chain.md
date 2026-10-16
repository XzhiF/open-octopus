# 05: 授予/撤销机械链 + 运行时生效

**What to build:** 最初需求 #5 的兑现票：草案一键授予分身——落分身技能目录、经**官方 resource upgrade 原语**同步运行时预置源、agent_versions 即时发版（可回退）、回执卡审计；撤销走逆链。授予后的 skill 在下次真实执行中被 SDK 原生发现并可调用（ADR-0006，零 prompt 注入）。

**Blocked by:** 04（草案存在才有可授予物）

**Reference:** spec §Implementation Decisions「skill 草案管线」授予机械链 · 故事 18-23 · P0/P1 教训（E2E addendum：直接改文件服务重启不生效，必须走 upgrade 原语）

**Status:** done

- [x] 授予单分身（默认窄口，分身层——ADR-0005）：草案 → 目标分身技能目录 → 官方 resource upgrade 原语同步运行时预置源 → agent_versions 发布现行版 → 回执卡（分身名/版本号/预置源同步结果/草案 status→granted）
- [x] 「授给所有分身」= 落共享技能层，全分身可发现（同机械链，目录不同）
- [x] 撤销 = 逆链：技能目录移除 + 预置源同步 + 版本回退 + 回执卡（status→revoked）；agent_versions 历史可查
- [x] 授予不经 wiki 写队列（非 wiki 写，边界断言）但发布走 agent_versions 既有事务；授予/撤销幂等（重复授予同版不重复发布）
- [x] S3 装配断言：授予后 preflight 预置产物含该 skill、SDK settingSources 可发现、**零 prompt 文本注入负断言**；resource-preflight 既有测试扩展（票11 先例）
- [x] 演示级验收：授予 workflow-operator 一个真实 skill → 跑一条真实工作流 → JSONL 见 Skill 加载/调用事件 → 撤销 → 再跑确认缺席

## Comments

- **2026-10-14 (票05 implementer)** 分支 `aa-05-grant-chain` @ `0c64ceeb` → ff 入集成分支。机械链五步落位：①`SkillGrantService.grant` 窄口=分身层 getCloneSkillsDir / `'*'`=共享层，先 rm 再写（copyDirOverwrite 不清残留对偶）；②**官方 installOrUpgrade**+新增 `sourceDir` 可选参（草案件不在 core-pack、`local:{path}` ref 撞 SAFE_NAME_RE/allowlist——原语无源可取文；additive、HTTP 面不扩攻击面、全管道三账+emit 保留；registerBuiltins 未用）；③`AgentVersionService.publish` 发现行版，仅 config.versioned 分身走版本账（其余回执如实 null）；④草案翻面 setDraftGrantState（票04 制式原地翻行）；⑤回执卡 Lane A 同址重发（SkillGrantReceipt shared 单源）。撤销=逆链：目录显式删→预置源逆同步（uninstall 官方逆原语）→**含该件发布行 archive+rollback**（实锤：引擎 latest 按版本号解析、current_version_id 业务工作流域无消费者——只 rollback 不 archive 撤销在工作流域不生效；previous_version null 桩不采信，回执自算）。
- **快照保真=ADR 不触发（主控复核认可 notes §二）**：publish 后调用方 top-up 拷授予件入 versions/{name}/{ver}/skills/，零数据契约变更；逐消费者核过 D2 读 DB 快照 JSON/物化读预置源槽/versions 正文消费面=回退展开。分身层授予不镜像落共享层（ADR-0005 两层窄口，S1/S3 双钉共享层零写）。改 snapshotToFiles 源序之彻底方案留主控后续 ADR，与 top-up 兼容可替换。
- 幂等/边界：重复授予同版零写零账零发版零重发卡；「grant 链零 queue.enqueue」代码面扫描+运行面 wiki 零 .git/INDEX 双面钉；撞 builtin 槽名拒 GRANT_NAME_CLASH（真 registerBuiltins 在场钉）；revoked 终态拒再授予。S3：resource-preflight +3/36 绿（EngineFactory 同款 VersionResolver→IdentityResolver→merged manifest→provision→.claude/skills 字节对拍+版本目录保真+撤销缺席面）；零 prompt 注入负断言沿用 task-doer-service:407-415 判法。S4 卡面：分身选择器（GET /api/clones 复用+「所有分身」固定项）+授予/撤销钮 union+版本回执即时显形。
- 演示级真跑入口=notes-aa-05.md §七（真 provider 真工作流 JSONL `toolName:"Skill"` 归票 09 链③）。
- **报主控新坑（立修复票候选）**：applySchema 首建库缺 clones.current_version_id（ensureColumns 跑在建表前），新库首启窗口 rollback 炸/publish 指针静默丢、重启自愈；本票未越权改 schema，测试按生产稳态补列钉注释。
- 测试闸：新 33+扩 4；全量 server 36=基线 34+日历 2 **零新增红**、web/shared 基线；build/lint 0 errors。merge 后主控复跑：重建 dist+grant/preflight/draft 三群 85/85 绿。
