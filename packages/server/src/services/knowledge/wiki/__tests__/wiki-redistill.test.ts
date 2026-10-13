import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { FindingsDAO } from "../../../../db/dao/findings-dao"
import { GLOBAL_WIKI_ORG } from "../../global-paths"
import { RawIngestService } from "../../raw"
import { CuratorCompileService } from "../curator"
import { WikiRedistillMigrator, REDISTILL_MAP_REL } from "../redistill"
import { parseH2Sections, TOPIC_CONSTRAINTS_SECTION, resolveWikiLink, WIKILINK_RE } from "../lint"
import { scanWikiEntries, nextRuleAnchor } from "../compile"
import { spawnGit, type GitRunner } from "../wiki-git"

/**
 * 票07 · 重蒸馏迁移 S1 环级测试（wiki-compile.test.ts / wiki-global-move.test.ts 同法）：
 * 真 fs（tmpdir）+ in-memory DB + 真 git。fixture = 从真语料
 * （~/.octopus/orgs/xzf-dev/knowledge/wiki）取像构造的 v2 wiki：projects/workflows 多小节
 * 锚点词条、business Glossary 分片（base+chunk2+chunk3）、非 Glossary business、research
 * （带旧形态 [[链接]]）、判例、旧表格 LOG、旧 INDEX —— 全部内联手搓，绝不读真实家目录。
 * Expected 值来自独立真相源：fixture 文本 + spec §迁移与幂等映射表 + prototype Tab⑥。
 * 断言六组：映射执行 / 单 commit / 幂等 / 锚点随迁对照 / 断链零 / _retired 完整 / LOG 可逆 / DB 守恒。
 */

// 写通道提交须带来源标记（pre-commit 闸）；断言用只读 runner 同款即可。
const git = (cwd: string): GitRunner => spawnGit(cwd)

// ── fixture 语料（取像自 xzf-dev 真词条，锚点编号全局唯一）────────────────

const PRJ_DEMO = `---
id: prj-octopus-demo-service-admin
domain: projects
title: octopus-demo-service-admin 项目知识
summary: 存量迁移 · projects/octopus-demo-service-admin.md
topics: [octopus-demo-service-admin, migrated]
stability: stable
last_compiled: 2026-10-12
sources: [doc:knowledge/projects/octopus-demo-service-admin.md, archive:compact@2026-07-02]
confidence: 0.8
---
## 规则

- 修改 octopus-demo-java-common 后必须先 mvn install 公共库，再用 mvn clean package -DskipTests 验证编译或 mvn verify 跑集成测试，提交前确保 mvn test 全量通过；否则运行时 ClassNotFoundException 或测试失败 <!--#oct-001-->
- Octopus workspace 开发时 worktree 命名为 {org}-octopus-demo-service-admin；多项目联调用 workspace.js init 同时初始化 service-admin + api-admin + web-admin <!--#oct-002-->
- 本服务为 admin 管理后台，端口与 service-user 不同，本地同时启动注意端口冲突，确保与 api-admin 网关路由配置一致 <!--#oct-003-->
- Swarm dispatch 模式下修改 DTO 字段前必须先通知 octopus-demo-web-admin 前端同步更新 API 响应结构 <!--#oct-004-->
- 代码审查使用 Swarm review 模式指定 java-reviewer + security-reviewer，覆盖 Spring Boot 安全配置和 JPA 查询正确性 <!--#oct-005-->
- Octopus E2E 测试选取 service-admin + web-admin 作为微服务全链路验证目标，提交前需确保通过 <!--#oct-006-->
`

const PRJ_OPEN = `---
id: prj-open-octopus
domain: projects
title: open-octopus 项目知识
summary: 存量迁移 · projects/open-octopus.md
topics: [open-octopus, migrated]
stability: stable
last_compiled: 2026-10-12
sources: [doc:knowledge/projects/open-octopus.md, archive:compact@2026-07-21]
confidence: 0.8
---
## 规则

- 开发这个项目启动必须是 pnpm dev --isolated ， 这样port是hash值，不影响3000,3001,3098,3099的开发与生产端口运行 <!--#oct-007-->
`

/** 多小节工作流词条（真 wf-prd-impl 取像）：锚点散布在 5 个 H2 小节。 */
const WF_PRD_IMPL = `---
id: wf-prd-impl
domain: workflows
title: prd-impl 工作流知识
summary: 存量迁移 · workflows/prd-impl.md
topics: [prd-impl, migrated]
stability: stable
last_compiled: 2026-10-12
sources: [doc:knowledge/workflows/prd-impl.md]
confidence: 0.8
---
## 构建规则

- 修改 shared/ 下任何代码后，必须先 \`pnpm build\` shared 包，否则 engine/cli/server 等下游包会引用旧的编译产物 <!--#oct-008-->
- 新建或修改 Zod schema（shared/src/schemas/）后，同步更新对应的 manifest YAML 和工作流定义中的变量引用，避免运行时 schema 校验失败 <!--#oct-009-->
- 添加新包时，必须在 pnpm-workspace.yaml 中注册，并确保 tsconfig.base.json 的 references 和路径映射正确配置 <!--#oct-010-->

## 工作流开发

- 编写 YAML 工作流定义后，先用 \`octopus workflow validate\` 验证语法和节点引用，再用 \`octopus workflow run\` 执行，避免无效执行浪费 token <!--#oct-011-->

## 已知陷阱

- dev 模式与 prod 模式的数据库路径和端口不同（dev 默认 3001/3000，prod 默认 3001/3098），切换模式时注意清理旧进程避免端口冲突，用 \`pnpm port\` 确认分配 <!--#oct-012-->

## 策展增补
- 知识蒸馏节奏通常是每月一次，运行下来发现覆盖度还不错 <!--#oct-139-->
- implement 环节通常耗时约 30 分钟，效果一般都比较稳定 <!--#oct-140-->
`

function glossary(id: string, pkg: string, titleSuffix: string, lines: string): string {
  return `---
id: ${id}
domain: business
title: 术语口径 · ${pkg} 域术语${titleSuffix}
summary: GLOSSARY-MAP 存量收编 · ${pkg}
topics: [glossary, ${pkg}]
stability: stable
last_compiled: 2026-10-12
sources: [doc:GLOSSARY-MAP.md]
confidence: 0.8
---
## ${pkg} 术语

${lines}`
}

const BIZ_ENGINE = glossary("biz-glossary-engine", "engine", "", `\
- **Ticket** — 垂直切片 — 端到端功能单元（test + schema + API + UI），可在单个 context window 内完成。 <!--#oct-016-->
- **Node** — YAML 中的一个执行单元（agent / bash / python / condition / approval / loop / swarm / interaction）。 <!--#oct-017-->
- **VarPool** — 全局变量池 — \`$vars.xxx\` 语法访问。节点通过 \`vars_update\` JSON 写入。 <!--#oct-018-->
`)

const BIZ_ENGINE_2 = glossary("biz-glossary-engine-2", "engine", "（2）", `\
- **Hot Reload** — 工作流执行过程中修改 YAML 定义，后续未执行节点使用新定义。正在执行的节点不受影响。 <!--#oct-019-->
- **SimulatorExecutorFactory** — 模拟执行工厂 — 替代 ExecutorFactory，对副作用节点返回 MockExecutor，对逻辑节点返回真实 Executor。 <!--#oct-020-->
`)

const BIZ_ENGINE_3 = glossary("biz-glossary-engine-3", "engine", "（3）", `\
- **Restore Point** — 工作流中一个已完成节点的时间点标记，包含该时刻的 VarPool 快照和节点结果。用于恢复点重跑。 <!--#oct-021-->
`)

const BIZ_SERVER = glossary("biz-glossary-server", "server", "", `\
- **Curator** — 策展人 — wiki 全局唯一写闸后的编译分身，全权维护五类页。 <!--#oct-022-->
- **Finding** — 巡检发现 — 矛盾/stale/孤儿等健康信号的对话卡载体，只产不裁。 <!--#oct-023-->
`)

const BIZ_SERVER_2 = glossary("biz-glossary-server-2", "server", "（2）", `\
- **Handle Response** — 路由统一响应壳 — \`{error:{code,message}}\` 形状与状态映射。 <!--#oct-024-->
`)

const BIZ_CORE_PACK = glossary("biz-glossary-core-pack", "core-pack", "", `\
- **Skill** — 前缀 \`octo-\` 的能力包 — SKILL.md 主文件 + 按需辅助文件。 <!--#oct-025-->
`)

const BIZ_SHARED = glossary("biz-glossary-shared", "shared", "", `\
- **WikiPageType** — v3 五类页枚举 — entity/concept/topic/source/case。 <!--#oct-026-->
`)

const BIZ_WEB_APP = glossary("biz-glossary-web-app", "web-app", "", `\
- **知识中心** — /knowledge 对话主界面 + 右栏 wiki 视图。 <!--#oct-027-->
`)

const BIZ_PROVIDERS = glossary("biz-glossary-providers", "providers", "", `\
- **Provider** — AI 后端抽象 — Claude SDK 适配层。 <!--#oct-028-->
`)

/** 非 Glossary business 词条：锚点 oct-150 高于全部 topic 侧锚点 ⇒ 台账防复用断言的病灶样本。 */
const BIZ_PRICING = `---
id: biz-pricing
domain: business
title: 计费口径
summary: 订阅计费规则
topics: [pricing]
stability: stable
last_compiled: 2026-10-12
sources: [doc:pricing-note.md]
confidence: 0.7
---
## 规则

- 报价单折扣一律以季付为基线，月付不打折 <!--#oct-150-->
`

/** research 词条：带旧路径/旧 id 形态的 [[链接]]（重蒸馏必须改写为 v3 目标）。 */
const RES_COMPILED_KB = `---
id: res-compiled-kb
domain: research
title: 编译型知识库调研
summary: 调研蒸馏 · Karpathy llm-wiki
topics: [research, wiki]
stability: stable
last_compiled: 2026-10-12
sources: [doc:docs/research/llm-wiki.md]
confidence: 0.75
---
## 要点

编译式知识库把检索重活从查询时挪到维护编译时（[[workflows/wf-prd-impl]] 的构建纪律同样服务于此）。

## 结论

- 三层（raw/wiki/schema）+ 三操作（ingest/query/lint）是主干形态，术语见 [[business/biz-glossary-engine-2]] <!--#oct-060-->
- 规模在数百页内时 INDEX+FTS 足够，不引入 embedding 主检索 <!--#oct-061-->（项目侧纪律见 [[prj-open-octopus]]）
`

const CASE_FILE = `---
id: case-e2e13-001
domain: cases
symptom: CI 报 LOCKFILE_CONFIG_MISMATCH
tags: [ci, pnpm, lockfile]
severity: blocker
occurrences: 1
source: "commit:82d963724e807e4989a0f72faf8e4575581a1d9f"
status: open
---
## 现场

CI 在 pnpm 9 runner 上读取由 pnpm 10 生成的 lockfile，安装直接失败，报 LOCKFILE_CONFIG_MISMATCH。

## 诊断

lockfile 的 overrides 配置段住在 pnpm-workspace.yaml（pnpm 10 格式位置），pnpm 9 读不进该配置，
比对配置哈希必然失配。同一病灶也出现在 Pi 定时闸。

## 根因

lockfile 格式版本与 CLI 大版本错配：配置归属文件随 pnpm 大版本迁移（v9 读不到 v10 的存放位置）。

## 修复

CI 与本地统一升 pnpm 10（commit 82d96372，chore(ci): pnpm 版本 9→10）。

## 教训

工具链大版本升级前，先查配置文件归属位置是否变化；lockfile 与 CLI 版本必须同轨。
`

const LEGACY_INDEX = `# Octopus Knowledge Wiki — global

> Agent 导航协议：先读本索引 → 选词条整读 → 未命中再 search API。禁止全库遍历。

## projects/ （项目知识 · 2 词条 · 7 规则）
- projects/prj-octopus-demo-service-admin.md — 存量迁移 · projects/octopus-demo-service-admin.md｜topics: octopus-demo-service-admin,migrated

## 统计
词条 15 · 案例 1 · 规则 37 · 最近编译 2026-10-12 · 待审核 0 ｜ 变更史见 LOG.md / git log
`

/** v2 表格 LOG（真 LOG.md 取像：表头 + 分隔行 + 数据行，`审核` 列自带 ✓）。 */
const LEGACY_LOG = `# Curation Log（append-only · 编译器自动写 · 详情看 git show <hash>）

| 日期 | 动作 | 词条 | 摘要 | 来源 | 审核 |
|------|------|------|------|------|------|
| 2026-10-12 | compile | projects/prj-octopus-demo-service-admin.md | 初始编译 projects/octopus-demo-service-admin.md → +6 条规则（oct-001,oct-002,oct-003,oct-004,oct-005,oct-006） | migrate:projects/octopus-demo-service-admin.md | curator ✓ |
| 2026-10-12 | compile | projects/prj-open-octopus.md | 初始编译 projects/open-octopus.md → +1 条规则（oct-007） | migrate:projects/open-octopus.md | curator ✓ |
| 2026-10-12 | compile | workflows/wf-prd-impl.md | 初始编译 workflows/prd-impl.md → +5 条规则（oct-008,oct-009,oct-010,oct-011,oct-012） | migrate:workflows/prd-impl.md | curator ✓ |
| 2026-10-12 | compile | business/biz-glossary-engine.md | 初始编译 engine 术语 3 条（biz-glossary-engine） | migrate:GLOSSARY-MAP.md | curator ✓ |
| 2026-10-12 | compile | business/biz-glossary-engine-2.md | 初始编译 engine 术语 2 条（biz-glossary-engine-2） | migrate:GLOSSARY-MAP.md | curator ✓ |
| 2026-10-12 | compile | business/biz-pricing.md | 初始编译 pricing 规则 1 条（biz-pricing） | manual | curator ✓ |
| 2026-10-12 | compile | research/res-compiled-kb.md | 初始编译 调研蒸馏 2 条（res-compiled-kb） | distill:docs/research/llm-wiki.md | curator ✓ |
| 2026-10-12 | case+ | cases/2026-10-12-pnpm-lockfile-mismatch.md | E2E 票13 判例入档 | commit:82d96372 | e2e13 ✓ |
`

interface V2File { rel: string; content: string }

const V2_FILES: V2File[] = [
  { rel: "projects/prj-octopus-demo-service-admin.md", content: PRJ_DEMO },
  { rel: "projects/prj-open-octopus.md", content: PRJ_OPEN },
  { rel: "workflows/wf-prd-impl.md", content: WF_PRD_IMPL },
  { rel: "business/biz-glossary-engine.md", content: BIZ_ENGINE },
  { rel: "business/biz-glossary-engine-2.md", content: BIZ_ENGINE_2 },
  { rel: "business/biz-glossary-engine-3.md", content: BIZ_ENGINE_3 },
  { rel: "business/biz-glossary-server.md", content: BIZ_SERVER },
  { rel: "business/biz-glossary-server-2.md", content: BIZ_SERVER_2 },
  { rel: "business/biz-glossary-core-pack.md", content: BIZ_CORE_PACK },
  { rel: "business/biz-glossary-shared.md", content: BIZ_SHARED },
  { rel: "business/biz-glossary-web-app.md", content: BIZ_WEB_APP },
  { rel: "business/biz-glossary-providers.md", content: BIZ_PROVIDERS },
  { rel: "business/biz-pricing.md", content: BIZ_PRICING },
  { rel: "research/res-compiled-kb.md", content: RES_COMPILED_KB },
  { rel: "cases/2026-10-12-pnpm-lockfile-mismatch.md", content: CASE_FILE },
]

/** 每文件锚点清单（对照断言的独立真相源——从 fixture 文本手算，不 import 被测代码）。 */
const ANCHORS_BY_FILE: Record<string, string[]> = {
  "projects/prj-octopus-demo-service-admin.md": ["oct-001", "oct-002", "oct-003", "oct-004", "oct-005", "oct-006"],
  "projects/prj-open-octopus.md": ["oct-007"],
  "workflows/wf-prd-impl.md": ["oct-008", "oct-009", "oct-010", "oct-011", "oct-012", "oct-139", "oct-140"],
  "business/biz-glossary-engine.md": ["oct-016", "oct-017", "oct-018"],
  "business/biz-glossary-engine-2.md": ["oct-019", "oct-020"],
  "business/biz-glossary-engine-3.md": ["oct-021"],
  "business/biz-glossary-server.md": ["oct-022", "oct-023"],
  "business/biz-glossary-server-2.md": ["oct-024"],
  "business/biz-glossary-core-pack.md": ["oct-025"],
  "business/biz-glossary-shared.md": ["oct-026"],
  "business/biz-glossary-web-app.md": ["oct-027"],
  "business/biz-glossary-providers.md": ["oct-028"],
  "business/biz-pricing.md": ["oct-150"],
  "research/res-compiled-kb.md": ["oct-060", "oct-061"],
}

describe("WikiRedistillMigrator — v2→v3 重蒸馏（票07）", () => {
  let db: Database.Database
  let tmpDir: string
  let knowledgeRoot: string
  let wikiRoot: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-redistill-"))
    knowledgeRoot = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(knowledgeRoot, "wiki")

    // v2 语料落盘 + 独立 git 史（票03 搬家后形态：全局根、org 钉 global）
    git(wikiRoot /* 先不存在，下面手动建仓 */).run(["version"])
    fs.mkdirSync(path.join(wikiRoot, "projects"), { recursive: true })
    for (const f of V2_FILES) {
      const abs = path.join(wikiRoot, f.rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, f.content, "utf-8")
    }
    fs.writeFileSync(path.join(wikiRoot, "INDEX.md"), LEGACY_INDEX, "utf-8")
    fs.writeFileSync(path.join(wikiRoot, "LOG.md"), LEGACY_LOG, "utf-8")

    const g = git(wikiRoot)
    g.run(["init"])
    g.run(["config", "user.email", "kc@test.local"])
    g.run(["config", "user.name", "kc-test"])
    g.run(["config", "core.autocrlf", "false"]) // 字节级断言前提：checkout 不做换行转换
    g.run(["add", "-A"])
    const seed = g.run(["commit", "-m", "seed: v2 wiki fixture"])
    if (seed.status !== 0) throw new Error(`seed commit failed: ${seed.stderr}`)

    // DB：票03 re-key 后的形态——org 钉 global，domain 列还是 v2 域值
    const dao = new WikiArticleDAO(db)
    for (const f of V2_FILES) {
      const m = /^---\r?\n([\s\S]*?)\r?\n---\n?/.exec(f.content)
      if (!m) continue
      const fm = m[1]
      const scalar = (k: string): string => {
        const r = new RegExp(`^${k}: (.*)$`, "m").exec(fm)
        return r ? r[1].trim() : ""
      }
      const id = scalar("id")
      const body = f.content.slice(m[0].length)
      const isCase = f.rel.startsWith("cases/")
      dao.upsert({
        org: GLOBAL_WIKI_ORG,
        id,
        domain: isCase ? "cases" : scalar("domain"),
        title: isCase ? scalar("symptom") : scalar("title"),
        summary: isCase ? scalar("symptom") : scalar("summary"),
        topics: JSON.stringify(f.content.match(/^topics: \[(.*)\]$/m)?.[1]?.split(", ").filter(Boolean) ?? []),
        stability: "stable",
        last_compiled: "2026-10-12",
        sources: JSON.stringify((f.content.match(/^sources: \[(.*)\]$/m)?.[1]?.split(", ") ?? []).map(s => s.trim())),
        confidence: isCase ? 1 : 0.8,
        body,
        path: f.rel,
      })
      const rid = dao.getRowid(GLOBAL_WIKI_ORG, id)!
      dao.insertFts({ rowid: rid, id, domain: isCase ? "cases" : scalar("domain"), title: isCase ? scalar("symptom") : scalar("title"), summary: isCase ? scalar("symptom") : scalar("summary"), topics: "[]", body })
    }
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const commitCount = (): number => Number(git(wikiRoot).run(["rev-list", "--count", "HEAD"]).stdout.trim())
  const porcelain = (): string => git(wikiRoot).run(["status", "--porcelain"]).stdout.trim()

  // ── 组 0：干跑 = 只读列计划，零副作用 ────────────────────────────────
  it("dry-run 列出完整映射计划且零副作用（默认只读，形制同 global-move）", async () => {
    const before = commitCount()
    const report = await new WikiRedistillMigrator({ db, wikiRoot }).run()
    expect(report.dryRun).toBe(true)

    // 映射计划：15 v2 词条 → 3 topic + 8 concept（Glossary 5 片归并 engine/server，其余一对一）
    expect(report.pages.map(p => p.newPath).sort()).toEqual([
      "concepts/biz-glossary-core-pack.md",
      "concepts/biz-glossary-engine.md",
      "concepts/biz-glossary-providers.md",
      "concepts/biz-glossary-server.md",
      "concepts/biz-glossary-shared.md",
      "concepts/biz-glossary-web-app.md",
      "concepts/biz-pricing.md",
      "concepts/res-compiled-kb.md",
      "topics/prj-octopus-demo-service-admin.md",
      "topics/prj-open-octopus.md",
      "topics/wf-prd-impl.md",
    ])
    // id 保号：引用面（wiki_refs 前缀 = 词条 id）不变；归并片记录去向
    const engine = report.pages.find(p => p.newId === "biz-glossary-engine")!
    expect(engine.action).toBe("merged-concept")
    expect(engine.mergedFrom?.sort()).toEqual(["biz-glossary-engine-2", "biz-glossary-engine-3"])
    expect(report.pages.find(p => p.newId === "biz-glossary-engine-2")).toBeUndefined()
    const wf = report.pages.find(p => p.newId === "wf-prd-impl")!
    expect(wf).toMatchObject({ oldId: "wf-prd-impl", oldPath: "workflows/wf-prd-impl.md", action: "topic" })

    // 旧页整迁 _retired/v2/（14 个词条文件；判例不在列——原样保留）
    expect(report.retired.length).toBe(14)
    expect(report.retired.find(r => r.from === "workflows/wf-prd-impl.md")?.to).toBe("_retired/v2/workflows/wf-prd-impl.md")
    expect(report.retired.some(r => r.from.startsWith("cases/"))).toBe(false)

    // 锚点随迁对照表：fixture 全部锚点（独立真相源 = ANCHORS_BY_FILE 手算，共 30 枚）
    const expectedAnchors = Object.values(ANCHORS_BY_FILE).flat()
    expect(report.anchors.length).toBe(expectedAnchors.length)
    expect(new Set(report.anchors.map(a => a.ref)).size).toBe(expectedAnchors.length)
    expect(report.anchors.find(a => a.ref === "wf-prd-impl#oct-008")).toMatchObject({
      anchor: "oct-008", oldPath: "workflows/wf-prd-impl.md", newPath: "topics/wf-prd-impl.md", carried: true,
    })
    // business/research 页按 v3 锚点小节铁律不落锚点注释：carried=false，去向仍记录
    expect(report.anchors.find(a => a.ref === "biz-glossary-engine-2#oct-019")).toMatchObject({
      newPath: "concepts/biz-glossary-engine.md", carried: false,
    })
    expect(report.anchors.find(a => a.ref === "res-compiled-kb#oct-060")?.newPath).toBe("concepts/res-compiled-kb.md")

    // LOG 转换预览（未写入）：表格数据行 8 行
    expect(report.log.tableRows).toBe(8)

    // DB 对账预览：现状 15 行（14 词条 + 1 判例）；锚点对照表覆盖 fixture 全部 31 枚
    expect(report.db.beforeTotal).toBe(15)

    // 零副作用：git 干净、无新 commit、无 v3 目录/对照表产物、LOG/INDEX 原样
    expect(commitCount()).toBe(before)
    expect(porcelain()).toBe("")
    expect(fs.existsSync(path.join(wikiRoot, "topics"))).toBe(false)
    expect(fs.existsSync(path.join(wikiRoot, REDISTILL_MAP_REL))).toBe(false)
    expect(fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")).toBe(LEGACY_LOG)
  })

  // ── 组 1：apply = 单 commit 全套落盘（映射执行 / 旧页整迁 / LOG 换格式 / INDEX 重建）──
  it("apply 一次产出 v3 库：硬约束小节锚点原号随迁、Glossary 归并、链接改写、_retired 完整、单 commit", async () => {
    const report = await new WikiRedistillMigrator({ db, wikiRoot, apply: true }).run()
    expect(report.dryRun).toBe(false)
    expect(report.changed).toBe(true)
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/)
    const read = (rel: string): string => fs.readFileSync(path.join(wikiRoot, rel), "utf-8")

    // 整个重蒸馏 = 一个 git commit（seed 之外史无第二个）
    expect(commitCount()).toBe(2)
    const show = git(wikiRoot).run(["show", "--name-status", "-M", "--format=", "HEAD"]).stdout
    // 14 个 v2 词条 = rename 进 _retired/v2/（不删除）
    for (const f of V2_FILES.filter(f => !f.rel.startsWith("cases/"))) {
      expect(show, f.rel).toMatch(new RegExp(`^R\\d+\\s+${f.rel.replace(/[/.]/g, "\\$&")}\\s+_retired/v2/${f.rel.replace(/[/.]/g, "\\$&")}$`, "m"))
      // 退役文件逐字节原样（可回滚真相面）
      expect(read(`_retired/v2/${f.rel}`)).toBe(f.content)
    }
    // 判例原样保留在 cases/（不迁不写文件）
    expect(read("cases/2026-10-12-pnpm-lockfile-mismatch.md")).toBe(CASE_FILE)
    expect(show).not.toMatch(/_retired\/v2\/cases/)

    // ── topic 页：id 保号、规则行入「硬约束」、锚点原号随迁 ──
    const wf = read("topics/wf-prd-impl.md")
    expect(wf).toContain("id: wf-prd-impl")
    expect(wf).toContain("type: topic")
    const wfParsed = parseH2Sections(wf.slice(wf.indexOf("\n---\n", 4) + 5))
    const hardSec = wfParsed.sections.find(s => s.title === TOPIC_CONSTRAINTS_SECTION)!
    expect(hardSec.anchors).toEqual(["oct-008", "oct-009", "oct-010", "oct-011", "oct-012", "oct-139", "oct-140"])
    // 锚点不泄漏到其它小节/前言（v3 L5 铁律自洽——重蒸馏产物本身就是合规 v3 页）
    expect(wfParsed.preamble.join("\n")).not.toMatch(/#oct-/)
    for (const s of wfParsed.sections) {
      if (s.title === TOPIC_CONSTRAINTS_SECTION) continue
      expect(s.anchors).toEqual([])
    }
    // 规则行文本随迁（原文含反引号与中文说明）
    expect(wf).toContain("- 修改 shared/ 下任何代码后，必须先 `pnpm build` shared 包，否则 engine/cli/server 等下游包会引用旧的编译产物 <!--#oct-008-->")
    // projects 词条同理（prj-* 保号）
    expect(read("topics/prj-open-octopus.md")).toContain("<!--#oct-007-->")

    // ── business Glossary → concepts 归并（base 保号、分片吸收、锚点注释剥落进台账）──
    const eng = read("concepts/biz-glossary-engine.md")
    expect(eng).toContain("type: concept")
    expect(eng).toContain("- **Ticket** — 垂直切片 — 端到端功能单元（test + schema + API + UI），可在单个 context window 内完成。")
    expect(eng).toContain("**Restore Point**")   // chunk-3 的术语并入同一页
    expect(eng).toContain("**Hot Reload**")      // chunk-2 的术语并入同一页
    expect(eng).not.toMatch(/#oct-\d+-->/)       // 非 topic 页不落锚点注释
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "biz-glossary-engine-2.md"))).toBe(false)
    // 非 Glossary business / research → concept 1:1 保号
    expect(read("concepts/biz-pricing.md")).toContain("报价单折扣一律以季付为基线")
    expect(read("concepts/biz-pricing.md")).not.toMatch(/#oct-\d+-->/)

    // ── 断链零：v2 形态 [[链接]] 机械改写到新页 ──
    const res = read("concepts/res-compiled-kb.md")
    expect(res).toContain("[[topics/wf-prd-impl]]")
    expect(res).toContain("[[concepts/biz-glossary-engine]]")
    expect(res).not.toContain("[[business/biz-glossary-engine-2]]")
    expect(res).toContain("[[prj-open-octopus]]")

    // ── INDEX 重建五类分组 ──
    const idx = read("INDEX.md")
    expect(idx).toContain("## Topics (3)")
    expect(idx).toContain("## Concepts (8)")
    expect(idx).toContain("## Cases (1)")
    expect(idx).toContain("- topics/wf-prd-impl.md —")
    expect(idx).not.toContain("待审核")

    // ── LOG：旧表格 8 行机械转换成行格式 + 本次 redistill 行；表体消失 ──
    const log = read("LOG.md")
    expect(log).not.toContain("| 日期 | 动作 |")
    expect(log).toContain("## [2026-10-12] compile | projects/prj-open-octopus.md\n  → 初始编译 projects/open-octopus.md → +1 条规则（oct-007） · migrate:projects/open-octopus.md · curator ✓")
    expect(log).toContain("## [2026-10-12] case+ | cases/2026-10-12-pnpm-lockfile-mismatch.md")
    expect(log.match(/^## \[/gm)).toHaveLength(9) // 8 转换行 + 1 redistill 行
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] compile \| redistill: v2→v3/m)

    // ── 对照表落盘（AC3 硬证据面）──
    const mapJ = JSON.parse(read(REDISTILL_MAP_REL))
    expect(mapJ.pages).toHaveLength(11)
    expect(mapJ.anchors).toHaveLength(Object.values(ANCHORS_BY_FILE).flat().length)
    expect(show).toContain(REDISTILL_MAP_REL)

    // ── DB：type 值切五类 + FTS 重建 + 行数对账 ──
    expect(report.db.afterTotal).toBe(12) // 11 页 + 1 判例行
    expect(report.db.byType).toEqual({ topic: 3, concept: 8, case: 1 })
    expect(report.db.deleted).toEqual([
      { id: "biz-glossary-engine-2", mergedInto: "biz-glossary-engine" },
      { id: "biz-glossary-engine-3", mergedInto: "biz-glossary-engine" },
      { id: "biz-glossary-server-2", mergedInto: "biz-glossary-server" },
    ])
    const dao = new WikiArticleDAO(db)
    expect(dao.get(GLOBAL_WIKI_ORG, "wf-prd-impl")?.domain).toBe("topic")
    expect(dao.get(GLOBAL_WIKI_ORG, "case-e2e13-001")?.domain).toBe("case")
    expect(dao.get(GLOBAL_WIKI_ORG, "biz-glossary-engine-2")).toBeUndefined()
    // FTS 可用（重建非空壳）：术语检索命中归并后的 concept 页
    expect(dao.search(GLOBAL_WIKI_ORG, "Ticket").map(r => r.id)).toContain("biz-glossary-engine")
    const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM wiki_fts").get() as { n: number }).n
    expect(ftsCount).toBe(12)
    // 工作树干净（一切产物已入那一个 commit）
    expect(porcelain()).toBe("")
  })

  // ── 组 2：幂等（重跑 diff 为空）+ 单 commit 可整体 revert ──
  it("幂等：apply 重跑零新 commit / 零树变化 / 报告收敛 no-op；dry-run 同样空计划", async () => {
    const first = await new WikiRedistillMigrator({ db, wikiRoot, apply: true }).run()
    expect(first.changed).toBe(true)
    const commitsAfter = commitCount()
    const tree = git(wikiRoot).run(["rev-parse", "HEAD^{tree}"]).stdout.trim()

    const second = await new WikiRedistillMigrator({ db, wikiRoot, apply: true }).run()
    expect(second.changed).toBe(false)
    expect(second.reason).toBe("already-redistilled")
    expect(second.pages).toEqual([])
    expect(second.retired).toEqual([])
    expect(second.anchors).toEqual([])
    expect(second.commit).toBeNull()
    expect(commitCount()).toBe(commitsAfter)
    expect(git(wikiRoot).run(["rev-parse", "HEAD^{tree}"]).stdout.trim()).toBe(tree) // 重跑 diff 为空
    expect(porcelain()).toBe("")
    // DB 也幂等（行数与五类值不变）
    expect(second.db.afterTotal).toBe(12)
    expect(second.db.deleted).toEqual([])

    const dry = await new WikiRedistillMigrator({ db, wikiRoot }).run()
    expect(dry.pages).toEqual([])
  })

  it("LOG 转换可逆：原表格封在 git 史（redistill commit 的父提交里可查回）", async () => {
    const first = await new WikiRedistillMigrator({ db, wikiRoot, apply: true }).run()
    const prevLog = git(wikiRoot).run(["show", `${first.commit}^:LOG.md`]).stdout
    expect(prevLog).toContain("| 日期 | 动作 | 词条 | 摘要 | 来源 | 审核 |")
    expect(prevLog).toContain("| 2026-10-12 | compile | projects/prj-open-octopus.md |")
    // 转换后的在盘 LOG 已无表格
    expect(fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")).not.toContain("| 日期 |")
  })

  it("整体 revert 一个 commit = 库回到 v2 原貌（页面消失/旧页回归/LOG 表格回归/对照表消失）", async () => {
    const first = await new WikiRedistillMigrator({ db, wikiRoot, apply: true }).run()
    const revert = git(wikiRoot).run(["revert", "--no-edit", first.commit as string])
    expect(revert.status, revert.stderr).toBe(0)
    const read = (rel: string): string => fs.readFileSync(path.join(wikiRoot, rel), "utf-8")
    // v2 词条回到原位且逐字节 = 原 fixture
    for (const f of V2_FILES) {
      expect(read(f.rel), f.rel).toBe(f.content)
    }
    // v3 产物与对照表消失；退役区清空
    expect(fs.existsSync(path.join(wikiRoot, "topics", "wf-prd-impl.md"))).toBe(false)
    expect(fs.existsSync(path.join(wikiRoot, REDISTILL_MAP_REL))).toBe(false)
    expect(read("LOG.md")).toBe(LEGACY_LOG)
    expect(read("INDEX.md")).toBe(LEGACY_INDEX)
  })

  // ── 组 3：锚点随迁对照（AC3 硬证据面——故事 28/34 的可解析断言）──
  it("每条 v2 形态 wiki_refs（旧词条id#锚点）在新库可解析：原号随迁、无双花、剥落号永不复用", async () => {
    await new WikiRedistillMigrator({ db, wikiRoot, apply: true }).run()
    const mapJ = JSON.parse(fs.readFileSync(path.join(wikiRoot, REDISTILL_MAP_REL), "utf-8")) as {
      anchors: Array<{ ref: string; anchor: string; oldPath: string; newPath: string; carried: boolean }>
    }

    // 1) 旧 ref 全覆盖：每条 fixture 旧 id#锚点 都有台账行，目标新页在盘
    for (const [oldPath, anchors] of Object.entries(ANCHORS_BY_FILE)) {
      const oldId = path.basename(oldPath, ".md")
      for (const a of anchors) {
        const row = mapJ.anchors.find(x => x.ref === `${oldId}#${a}`)
        expect(row, `${oldId}#${a} 应有对照行`).toBeDefined()
        const pageAbs = path.join(wikiRoot, row!.newPath)
        expect(fs.existsSync(pageAbs), row!.newPath).toBe(true)
        const pageText = fs.readFileSync(pageAbs, "utf-8")
        if (row!.carried) {
          // 原号随迁：锚点注释逐字在新 topic 页，且栖身「硬约束」小节
          expect(pageText, `${oldId}#${a}`).toContain(`<!--#${a}-->`)
          const secs = parseH2Sections(pageText.slice(pageText.indexOf("\n---\n", 4) + 5))
          expect(secs.sections.find(s => s.title === TOPIC_CONSTRAINTS_SECTION)?.anchors ?? []).toContain(a)
        } else {
          // v3 锚点小节铁律：非 topic 页不落锚点注释（去向由台账承接）
          expect(pageText).not.toContain(`<!--#${a}-->`)
        }
      }
    }

    // 2) 无双花：台账锚点全库唯一；活页锚点集合恰 = 台账 carried 集合
    const ledgerAnchors = mapJ.anchors.map(x => x.anchor)
    expect(new Set(ledgerAnchors).size).toBe(ledgerAnchors.length)
    const liveAnchors = scanWikiEntries(wikiRoot).flatMap(e => e.anchors)
    expect(new Set(liveAnchors).size).toBe(liveAnchors.length)
    expect([...liveAnchors].sort()).toEqual(mapJ.anchors.filter(x => x.carried).map(x => x.anchor).sort())

    // 2b) 断链零（独立真相：直接对活页 [[链接]] 跑 resolveWikiLink，不依赖 compile 未抛）
    const corpus = scanWikiEntries(wikiRoot).map(e => ({ id: e.meta.id, path: e.relPath }))
    const broken: string[] = []
    for (const e of scanWikiEntries(wikiRoot)) {
      const pageText = fs.readFileSync(path.join(wikiRoot, e.relPath), "utf-8")
      const body = pageText.slice(pageText.indexOf("\n---\n", 4) + 5)
      for (const m of body.matchAll(new RegExp(WIKILINK_RE.source, "g"))) {
        if (!resolveWikiLink(m[1].trim(), wikiRoot, corpus)) broken.push(`${e.relPath} → ${m[0]}`)
      }
      for (const link of e.page?.links ?? []) {
        if (!resolveWikiLink(link, wikiRoot, corpus)) broken.push(`${e.relPath} (front-matter) → ${link}`)
      }
    }
    expect(broken, broken.join("; ")).toEqual([])

    // 3) 永不复用：business 侧剥落锚点（oct-150）高于全部活页锚点（max=140）——
    //    发号器必须读台账跳过它，否则历史 ref 将撞进新页（故事 28 的暗坑）
    expect(liveAnchors.map(n => Number(/^oct-(\d+)$/.exec(n)![1])).reduce((a, b) => Math.max(a, b), 0)).toBe(140)
    expect(nextRuleAnchor(wikiRoot)).toBe("oct-151")
  })

  // ── 组 4：票05 矛盾闸对照——v2 旧页被拒；重蒸馏后同一对照场景拒绝消解（AC7）──
  it("CURATOR_CONTRADICTION_TARGET_LEGACY：重蒸馏前拒（v2 形态）、重蒸馏后消解（同一旧断言可对质）", async () => {
    const oldClaim = "修改 shared/ 下任何代码后，必须先 `pnpm build` shared 包"
    const curatorFor = (title: string, text: string, oldPage: string) => {
      const ing = new RawIngestService({ root: knowledgeRoot })
      const pointer = ing.ingestText({ text, title }).raw
      const plan = JSON.stringify({
        pages: [{ op: "create", type: "concept", id: "con-reversal", title: "免重建断言", summary: "shared 变更不再要求先行重建", body: "## 定义\n新调研结论：shared 类型变更无需手动重建。\n" }],
        key_points: ["shared 重建纪律被推翻"],
        contradictions: [{ new_page: "con-reversal", old_page: oldPage, old_claim: oldClaim, new_claim: "shared 类型变更无需手动重建" }],
      })
      return new CuratorCompileService({ db, root: knowledgeRoot, llm: async () => plan, git: spawnGit(wikiRoot) }).compileRaw(pointer)
    }

    // 重蒸馏前：旧页是 v2 词条形态 ⇒ 票05 硬拒（可读错误，写库零触碰）
    const before = await curatorFor("Reversal A", "shared 类型变更无需手动重建。\n", "workflows/wf-prd-impl.md").catch(e => e)
    expect(String(before?.message ?? before)).toMatch(/CURATOR_CONTRADICTION_TARGET_LEGACY/)

    // 重蒸馏后：同一对照场景，old_page 已是 v3 topic 页 ⇒ 拒绝消解，矛盾正常落两页标记
    await new WikiRedistillMigrator({ db, wikiRoot, apply: true }).run()
    const res = await curatorFor("Reversal B", "新的对质证据：构建体系已自动化。\n", "topics/wf-prd-impl.md")
    expect(res.contradictions).toBe(1)
    expect(res.findingIds).toHaveLength(1)
    const wf = fs.readFileSync(path.join(wikiRoot, "topics", "wf-prd-impl.md"), "utf-8")
    expect(wf).toContain("## 冲突待裁决")
    expect(wf).toContain(res.findingIds[0])
    // 不静默覆盖：随迁锚点行原样在盘（矛盾标记不吞历史）
    expect(wf).toContain(`${oldClaim}，否则 engine/cli/server 等下游包会引用旧的编译产物 <!--#oct-008-->`)
    const f = new FindingsDAO(db).getById(res.findingIds[0])!
    expect(f.status).toBe("open")
    expect(JSON.parse(f.pages)).toContain("topics/wf-prd-impl.md")
  })
})
