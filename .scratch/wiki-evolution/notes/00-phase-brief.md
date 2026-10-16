# P4 wiki-evolution · Implementer 作战简报（全票共用，单一真源）

基线：集成分支 `feat-wiki-evolution-20261015`（= main @ eca3b4ce，P3 已合入）。
设计权威 = `C:/xzf/ai/open-octopus/.scratch/wiki-evolution/spec.md`（读你的票面 Reference 指向的节）。
票面 = `C:/xzf/ai/open-octopus/.scratch/wiki-evolution/issues/<NN>-*.md`（票内清单是验收合同；票文件本身由主控维护，你**不要改**）。
探索笔记正典 = `C:/xzf/ai/open-octopus/.scratch/wiki-evolution/notes/`（本文件 + 01/02/03/04 分域笔记；开工先读 00 + 你票面相关的笔记）。
仓内真默认库/知识根（**只读，不得直写**）：`C:/Users/EDY/.octopus/db/octopus.db`、`C:/Users/EDY/.octopus/knowledge`。

## 红线（任一冲突立即停下、在报告里声明，不要自行变通）

1. **wiki 写入全局串行**：一切新写路径必须经 CompileQueue FIFO（WRITE_OP_KINDS 单源扩值，compile-queue.ts:25）；禁止任何直写 wiki 根。新增 opKind 必须同步 `wiki-write-queue.test.ts:89-99` 的逐字枚举断言，否则必红。
2. **审批不复活**：一切数值处方 = finding 事后人裁；自动动作只允许票09 的「90天零引用 AND 零活页入链」一条窄口（且可恢复）。不引入任何新审批态/审核队列。
3. **勿复活旧关键词匹配近似**：blocker 关联判定必须走 LLM seam（knowledge_effectiveness 表边界注的告诫；旧 effectiveness.ts 教训在其 git 史——删档前先看其头注）。
4. **归档先于删除**：票05 删 shadow-compare 前，先给 p2-gate-pass.md 与 KC e2e-report 的证据引用处加注（追加注记不改写原文）。
5. **零触碰面**：agent 记忆域（daily/long-term 摘要）、K11、skill 生效面（ADR-0006 settingSources）——diff 不得出现这些域文件；唯一写闸 + 人工文件写保护不得松动。
6. **时间判据测试**：一律注入时钟或构造时间戳 fixture，禁 sleep 等时间流逝。**记账解析幂等**（游标持久，重跑零重复）。

## 工程纪律

- worktree 已建好且 `pnpm install && pnpm build` 由主控预热；开工先确认 dist 存在（`pnpm build` 重跑幂等，若被别的进程占着等它结束）。
- **测试用 PowerShell 工具跑**（本仓 git+tmpdir 全栈测试在 Git-Bash 下有 gitconfig Permission denied 假红史）：`pnpm --filter @octopus/<pkg> test <name-filter>`（**不带 `--`**）。
- 长测试套件**前台阻塞到终态**再报告；不得后台跑了就走。
- 基线红档案：server 36 红=基线 34+日历 2（web 3、shared 1 基线红）——以「零新增红」为准；先跑 touched-package 相关套件拿你自己的局部基线。
- Windows/Git Bash（仅 git 操作用 Bash 时）：每条命令自带绝对坐标；MSYS 冒号陷阱用 `MSYS2_ARG_CONV_EXCL='*'` 且用完 unset。详见仓内 docs/agents/windows-bash.md。
- 保护端口 3000/3001/3098/3099 不占不杀。S2 若需起 server 用 34xx 段并报告声明已拆机（kill:port+netstat）。
- 测试知识根用 tmpdir 覆盖缝（OCTOPUS_KNOWLEDGE_DIR / rootDir 注入——见笔记 01 §5），绝不打真默认库/真知识根。

## 交付合同（每票）

1. 用 Skill 工具调 `tdd`，红→绿→提交（commit message 中文长注风格随仓内惯例）。
2. 报告 = 票内复选框逐项判定（done/partial/blocked + 一句证据：测试文件+计数/commit 号/对靶真验输出摘录）。
3. 报告前把集成分支最新 tip merge 进自己分支，解决冲突后再跑一遍 touched 套件。
4. 复现靶票（02/03/04）：修复必须对靶真验——票面 Reference 的现场（笔记 04 有复现路径）跑通并贴证据；「单测绿但靶未验」不算完成。
5. 你的工作分支 = `we/<票名>`（worktree `.worktrees/we-<NN>`）；**不要动**集成分支与其他 worktree。
