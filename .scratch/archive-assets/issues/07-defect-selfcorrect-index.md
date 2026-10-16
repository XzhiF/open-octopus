# 07: 缺陷修复 — 编译自纠 + INDEX 必读路径（D-kc15-1/2）

**What to build:** 两条 KC E2E 入册缺陷的修复：含日期的一手源（最常见的真实素材）不再恒失败——L5 日期类 lint 失败触发服务层一轮自纠后重编译；INDEX 必读节的 user_preference 路径可达——agent 真能读到偏好文件（P2' 只兑现一半的语义补齐）。

**Blocked by:** 01（KC 合入）

**Reference:** spec §Implementation Decisions「清理账」D-kc15-1/2 · KC e2e-report 缺陷节（复现靶已保留：raw 层的 karpathy gist 冻结件，当时两连败于 L5_DATES_IN_BODY）

**Status:** done

- [x] L5_DATES_IN_BODY 类失败 → 服务层一轮自纠（LLM seam：日期表述改写为常青形态，或日期移 sources 页/front-matter）→ 重编译；自纠产物仍全量过 lint 闸（不放松）
- [x] 自纠一轮仍败 → 终态 failed + 自纠痕迹可查（不无限重试）
- [x] 抓取卡带「重试编译」入口（failed 任务可再触发，经队列）
- [x] 复现靶真验：保留的 karpathy gist 失败源投喂 → 自纠成功落库（当时恒失败的真源现在能进）
- [x] INDEX 重建器必读行输出知识根相对路径标注（agent Read 可达，非 wiki 根下假路径）
- [x] octo-wiki skill 必读节措辞同步 + 经官方 resource upgrade 原语同步运行时预置源（教训纪律）
- [x] S1（日期源 fixture 自纠环、一轮上限、重试经队列）+ 既有编译测试零回归

## Comments

- **2026-10-14 (票07 implementer)** 分支 `aa-07-selfcorrect-index`（实现 `a63addd2`，merge tip 后 `c6bdd0ef`）→ 合入集成分支（ff→`c6bdd0ef`）。D-kc15-1：curator.ts 自纠环=catch L5_DATES_IN_BODY→本地同口径 offender 检测（source/case 豁免）→LLM seam 常青改写（三道拒收闸：缺页/丢锚点/混入 oct-NEW）→整批重走同一 compilePages 全量闸；结构一轮上限；终态败 rec.error 带原判闸行+自纠痕迹；重试入口复用 ingest-compile FIFO 通道（零新 opKind 零直写；失败回滚不留回执页⇒重投必真编译，S1 两面钉死）。D-kc15-2：WIKI_INDEX_MUST_READ_LINE 改 `../user_preference.md`+知识根标注；octo-wiki SKILL.md 措辞同步+`.claude/skills` 镜像随 build 钩子一致；预置源同步走 installOrUpgrade（S3 装配断言）；dry-run 实测 `DRIFT skill:octo-wiki` exit 1——真盘 `--apply` 归合入后 ops（主控执行）。
- 测试：S1 新 8 例（先红=复现缺陷原错；复现靶=karpathy gist 冻结件只读复制 tmpdir 自纠链绿——**真源真验 tmpdir 面已证**）+S2 +1 +S3 +1 +S4 +2；基线对照零新增红（日历敏感两例 stash 复证非本票）；build+eslint 绿。
- 真库真 provider 版真跑归票 09 链⑤（spec Testing Decisions E2E 行分工）：入口 `POST /api/knowledge/wiki/compile {"path":"raw/inbox/2026-10-13-karpathy-llm-wiki-gist.md"}` 预期 committed+warnings 自纠痕迹行。卡面小账：痕迹行进 warnings 隐 diff 卡 FTS ✓ 行（同 CURATOR_LLM_JSON 先例病），记后续。
