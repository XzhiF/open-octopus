# 03: 判例自动提取 + 自动入档

**What to build:** 踩坑自动留档：归档时从素材包的 JSONL 摘录识别 报错→诊断→修复 序列、从打回记录识别流程性教训，LLM 产判例五段草案，经全局串行队列自动编入 cases/（宽松准入），判例卡通知；巡检扩为六查（+判例积压蒸馏提议）。"卡壳按症状查判例"的供给侧从此自动化。

**Blocked by:** 02（判例提取读素材包——workspace 会删，包是持久面）

**Reference:** spec §Implementation Decisions「判例自动提取」· 故事 8-14 · 红线：审批不复活（先存后知+事后纠）

**Status:** done

- [x] 提取源：本次归档任务的 JSONL 关键事件（报错→修复序列）+ 验收台账 rejected 轮次（理由入现场段）；LLM seam 产五段草案（现场/诊断/根因/修复/教训），source 指回 exec/task（可定位准入）
- [x] 入档走全局串行队列：WRITE_OP_KINDS 单源扩第八类（case-archive），唯一写闸编译进 cases/，无旁路（负断言）
- [x] occurrences 合并：同症状判例经归一化+jaccard 近义先例判定，命中既判例则 occurrences+1（仅 status/rule_ref/occurrences 更新面，正文 append-only 不改写）
- [x] 判例卡：五段预览 + source 指针 + 退役钮（superseded 经策展对话）
- [x] 巡检六查：open 且 occurrences≥2 未蒸馏 → finding「判例积压」提议蒸馏（产物进 topics 硬约束、判例↔规则互指、status=distilled）
- [x] 提取失败/无序列可提 → 零落盘零入队（不产假判例）；失败不阻塞 done
- [x] S1（JSONL fixture→草案→入档全链、occurrences 合并、六查 fixture）+ S2 + S4（判例卡）

## Comments

- **2026-10-14 (票03 implementer)** 分支 `aa-03-case-extract` @ `15d2251a`（实现 `ea6a0795`+merge 票08 tip 并集解）→ ff 入集成分支。第八类 opKind `case-archive` 落 compile-queue.ts WRITE_OP_KINDS（merge 后九值并 page-retire）+wiki-write-queue.test.ts:87 逐字断言同步；提取服务 `case-extract-service.ts`（archiveIngest deps 链第⑤步，入队编译后素材包卡前，`caw-{taskId}-{seq}` 判定在队列执行体内竞态安全）；`routes/wiki-case.ts` POST /case/retire（退役 `car-…` 同 opKind）。
- 五段草案=LLM seam JSON 契约形（symptom/severity/tags/source+sections 现场/诊断/根因/修复/教训），source 不可定位服务端兜 task:{id}、缺段整条弃；落 `cases/{date}-case-{sha10}.md` P0 schema 沿用。**「归一化+jaccard 先例」不存在（勘探坑1 证实）**——自建纯函数 `case-symptom.ts`（CJK 二元+ASCII 词，阈值 0.5，13 手算单测），近义命中 ⇒ 同文件 occurrences+1 正文逐字不改、LOG「判例并档」。
- 巡检五查→六查 `case-backlog`（open∧occ≥2∧无 rule_ref，幂等/三态 4 例）；顺修孤儿判据认 rule_ref 边（防蒸馏产物恒孤儿假阳性）。蒸馏=adopt 复用 finding-fix 通道确定性（零 LLM）：topic「## 硬约束」新锚点+[[case]] 互指、case 翻 distilled+rule_ref、scrubDates 净洗。
- 判例卡 kind `case`（KC_CARD_KINDS 十值）一行注册；五段预览+source 指针+退役钮；Lane A 先存后知生产者（committed 后 emit，announce 炸不毁入档）；退役钮 Lane B 覆盖层（use-kc-cases）排队中#N→已提交去钮/失败显码 S4 4 例。
- **主控裁定（留账口径）**：退役双通道（钮直发 POST /case/retire + 对话改写腿）保留——两通道同经 case-archive 唯一写闸、零审批态，票面红线语义成立；「钮只许灌对话」的收法未采（确定性按钮仍是队列，无旁路）。
- 测试：新 S1 37+S2 4+S4 4+枚举 14；merge 后全量零新增红（日历预存 2/单跑 flake 按档案甄别）；root build 全绿。
