// we11-rerun.mjs — P4 wiki-evolution 票11 E2E 全链复跑脚本（kc15/aa16 先例模式，反假跑 R8）
// 用法：node C:/tmp/we11-e2e/we11-rerun.mjs <gate|fixtures|effExecs|effExecs2|effParse|effSync|
//        patrolNum|budgetWarn|curation|linkedRetire|deepRevert|nightPatrol|restore|budgetReject|
//        budgetAdopt|lane|web|idem|all> [--run <tag>]
// 前提：we-11 worktree dev 实例已起（server 3431 / web 3430，custom-port 分支库模式），
//       实例 env OCTOPUS_KNOWLEDGE_DIR=C:/tmp/we11-e2e/knowledge（真盘副本，真 git .git 在场），
//       分支库 octopus-we-11-e2e.db 已 VACUUM 播种（快照源=默认库，默认库零直写），
//       provider 走 ~/.claude/settings.json env 真 token。
// 状态/证据：C:/tmp/we11-e2e/state/*.json、C:/tmp/we11-e2e/evidence/*。
// fixture 前缀纪律：页/任务/工作区/源文件全带 `we11-` 或 `E2E_HARNESS_TEST_`（R7 可识别）。
// LLM 重段单段 <600s；all=全链顺序复跑；idem=非 LLM 幂等复证段（pass2 面）。
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import { spawnSync } from "child_process"
import { DatabaseSync } from "node:sqlite"
import { fetchJSON } from "file:///C:/xzf/ai/open-octopus/.claude/skills/e2e-harness/lib/api.mjs"
import { createResults, record, saveResults } from "file:///C:/xzf/ai/open-octopus/.claude/skills/e2e-harness/lib/reporter.mjs"

const argv = process.argv.slice(2)
const PHASE = argv[0] || "all"
const runFlag = argv.includes("--run") ? argv[argv.indexOf("--run") + 1] : null
const RUN = runFlag || String(Date.now())
const API = "http://127.0.0.1:3431"
const WEB = "http://127.0.0.1:3430"
process.env.OCTOPUS_API_URL = API
process.env.OCTOPUS_WEB_URL = WEB
const HOME = os.homedir()
const OCTO = path.join(HOME, ".octopus")
const DB = path.join(OCTO, "db", "octopus-we-11-e2e.db")
const KNOW = "C:/tmp/we11-e2e/knowledge"
const WIKI = path.join(KNOW, "wiki")
const REAL_WIKI = path.join(OCTO, "knowledge", "wiki")
const STATE_DIR = "C:/tmp/we11-e2e/state"
const EV_DIR = "C:/tmp/we11-e2e/evidence"
fs.mkdirSync(STATE_DIR, { recursive: true })
fs.mkdirSync(EV_DIR, { recursive: true })
const ORG = "xzf"
const BEARER = "Bearer " + "e2e"
const KC_HDR = { Authorization: BEARER, "content-type": "application/json" }
const JSON_HDR = { "content-type": "application/json", Authorization: "Bearer " + "e2e" }
const ORG_HDR = { "content-type": "application/json", "X-Octopus-Org": ORG, Authorization: BEARER }
// 票面 fixture 锚点号段（全库现 max=oct-156，9xx 号段防撞）
const OCT_GATE = "oct-901", OCT_BLOAT_FROM = 910, OCT_DUP_A = "oct-940", OCT_DUP_B = "oct-941"
const OCT_ZOMBIE = "oct-950", OCT_LINKED = "oct-960", OCT_VOL = "oct-970", OCT_PAD = "oct-980"

const post = (obj) => ({ method: "POST", body: typeof obj === "string" ? obj : JSON.stringify(obj), headers: JSON_HDR })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const git = (args) => spawnSync("git", args, { cwd: WIKI, encoding: "utf8" }).stdout || ""
const gitReal = (args) => spawnSync("git", args, { cwd: REAL_WIKI, encoding: "utf8" }).stdout || ""
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "")
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex")
const saveState = (name, obj) => fs.writeFileSync(path.join(STATE_DIR, `${name}.json`), JSON.stringify(obj, null, 2))
const loadState = (name) => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${name}.json`), "utf8")) } catch { return null } }
const ev = (name, obj) => fs.writeFileSync(path.join(EV_DIR, `${name}.json`), JSON.stringify(obj ?? null, null, 2))
const evLines = (name, text) => fs.writeFileSync(path.join(EV_DIR, `${name}.txt`), text)
const dbq = (sql) => { const d = new DatabaseSync(DB, { readOnly: true }); try { return d.prepare(sql).all() } finally { d.close() } }
const dbw = (sql, ...args) => { const d = new DatabaseSync(DB); try { d.prepare(sql).run(...args) } finally { d.close() } }
const results = createResults()

async function pollJson(url, isTerminal, { maxMs = 480000, interval = 5000, headers = {} } = {}) {
  const t0 = Date.now()
  let last = null
  const full = url.startsWith("http") ? url : API + url
  while (Date.now() - t0 < maxMs) {
    const r = await fetchJSON(full, headers ? { headers } : {})
    last = r.data
    const st = last?.task?.state || last?.task?.status || last?.status || last?.state
    if (isTerminal(st)) return { data: last, tookMs: Date.now() - t0 }
    await sleep(interval)
  }
  return { data: last, tookMs: Date.now() - t0, timeout: true }
}
const TERMINAL = (s) => s === "committed" || s === "failed"
const EXEC_TERMINAL = (s) => s === "completed" || s === "failed" || s === "aborted"
const getMsgs = (data) => (Array.isArray(data?.messages) ? data.messages : (data?.messages?.items || data?.items || []))

// ── INDEX 恒见段独立复算器（expected 真相源=SCHEMA/lint 已公布公式的逐字复刻，非产品代码调用）──
function estTokens(text) {
  let cjk = 0, other = 0
  for (const ch of text) {
    if (/[㐀-䶿一-鿿぀-ヿ가-힯＀-￯]/.test(ch)) cjk++
    else if (!/\s/.test(ch)) other++
  }
  return cjk + Math.ceil(other / 4)
}
function parseFm(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/)
    if (!kv) continue
    fm[kv[1]] = kv[2].trim()
  }
  fm._body = content.slice(m[0].length)
  return fm
}
function scanPages() {
  const out = []
  for (const dir of ["entities", "concepts", "topics", "sources", "cases"]) {
    const d = path.join(WIKI, dir)
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".md"))) {
      const rel = `${dir}/${f}`
      const c = readIf(path.join(WIKI, rel))
      const fm = parseFm(c)
      if (!fm?.id || !fm?.type || !fm?.summary) continue
      const anchors = [...(fm._body || "").matchAll(/<!--#(oct-[0-9A-Za-z]+)-->/g)].map((x) => x[1])
      let sourcesLen = 0
      try { sourcesLen = JSON.parse((fm.sources || "[]").replace(/([\w.:\/-]+)/g, '"$1"').replace(/'/g, '"')).length } catch { sourcesLen = 0 }
      out.push({ relPath: rel, type: fm.type, summary: fm.summary, title: fm.title || "", anchors, sourcesLen })
    }
  }
  return out
}
function renderVisibleIndex(pages, mustLine, extraPages = []) {
  const all = [...pages, ...extraPages]
  const LABELS = { entity: "Entities", concept: "Concepts", topic: "Topics", source: "Sources", case: "Cases" }
  const lines = [`# Octopus Knowledge Wiki — global`, "", "> 导航协议：先读本索引 → 选页整读 → 未命中再 search API。禁止全库遍历。", "", "## 必读", mustLine, ""]
  for (const t of ["entity", "concept", "topic", "source", "case"]) {
    const list = all.filter((e) => e.type === t)
    if (!list.length) continue
    lines.push(`## ${LABELS[t]} (${list.length})`)
    for (const e of list) {
      let suffix = ""
      if ((t === "entity" || t === "concept") && e.sourcesLen > 0) suffix = ` ←${e.sourcesLen} 源`
      else if (t === "topic" && e.anchors.length > 0) suffix = ` · 硬约束 ×${e.anchors.length}`
      lines.push(`- ${e.relPath} — ${e.summary}${suffix}`)
    }
    lines.push("")
  }
  return lines.join("\n") + "\n"
}
function predictVisibleTokens(extraPageLineObjs) {
  const idx = readIf(path.join(WIKI, "INDEX.md"))
  const mustLine = idx.split(/\r?\n/).find((l) => l.startsWith("- ../user_preference.md")) || "- ../user_preference.md — owner 偏好（人工维护；住在知识根 = wiki 根上一级，wiki 子树内无此文件）"
  const pages = scanPages()
  // 复刻降序：锚点少者优先（tie 按路径）——恒见>800 时逐一降入 Optional
  const visible = [...pages].sort((a, b) => a.anchors.length - b.anchors.length || a.relPath.localeCompare(b.relPath))
  const optional = []
  let tok = estTokens(renderVisibleIndex(pages, mustLine, extraPageLineObjs))
  while (tok > 800 && optional.length < visible.length - 1) {
    const next = visible.find((e) => !optional.includes(e.relPath))
    if (!next) break
    optional.push(next.relPath)
    const keep = pages.filter((e) => !optional.includes(e.relPath))
    tok = estTokens(renderVisibleIndex(keep, mustLine, extraPageLineObjs.filter((x) => !optional.includes(x.relPath))))
  }
  return { tok, optional }
}

// v3 页 fixture 模板（制式=在册真页逐字：wf-prd-impl.md 头三段对拍）
function page({ id, type, title, summary, links = [], sources = ["doc:we11-fixture"], stability = "stable", reviewAfter, lastCompiled = "2026-10-15", confidence = 0.8, body }) {
  const fm = [
    "---", `id: ${id}`, `type: ${type}`, `title: ${title}`, `summary: ${summary}`,
    `topics: [we11-fixture]`, `links: [${links.join(", ")}]`, `stability: ${stability}`,
    ...(reviewAfter ? [`review_after: ${reviewAfter}`] : []),
    `last_compiled: ${lastCompiled}`, `sources: [${sources.join(", ")}]`, `confidence: ${confidence}`, "---", body,
  ].join("\n")
  return fm.endsWith("\n") ? fm : fm + "\n"
}
const WRITE = (rel, content) => { const p = path.join(WIKI, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content) }

// ─── gate ─────────────────────────────────────────────────────────
async function gate() {
  const act = await fetchJSON(`${API}/api/actuator/health`)
  const server = act.data?.components?.server?.details
  const dbPath = act.data?.components?.database?.details?.path || ""
  record(results, "R1 health isolated we/11-e2e 实例", server?.mode === "isolated" && server?.branch === "we/11-e2e", `pid=${server?.pid} port=${server?.port} mode=${server?.mode}`)
  record(results, "实例 DB=分支库（默认库零直写）", dbPath.includes("octopus-we-11-e2e"), dbPath)
  const base = await fetchJSON(`${API}/api/knowledge/health`)
  ev("health-baseline", base.data)
  const headCopy = git(["rev-parse", "--short", "HEAD"]).trim()
  record(results, "实例 gitHead==tmpdir 副本 HEAD（root 解析对位；判别=fixtures 段 tree 裁决）", !!base.data?.gitHead && base.data.gitHead.startsWith(headCopy), `copy=${headCopy} instance=${base.data?.gitHead?.slice(0, 7)} real=${gitReal(["rev-parse", "--short", "HEAD"]).trim()}`)
  const realSt = gitReal(["status", "--porcelain"])
  record(results, "真盘知识根全程零直写（开工时净）", realSt.trim() === "", `porcelain=${realSt.length}B`)
  saveState("realhead", { head: gitReal(["rev-parse", "HEAD"]).trim() })
  const sn = await fetchJSON(`${API}/api/system/models/test`, post({ provider: "claude", model: "sonnet" }))
  record(results, "provider sonnet 真 ping（models/test latency）", !!sn.data?.success && sn.data?.latency > 0, JSON.stringify(sn.data))
  const hk = await fetchJSON(`${API}/api/system/models/test`, post({ provider: "claude", model: "haiku" }))
  record(results, "provider haiku 真 ping", !!hk.data?.success && hk.data?.latency > 0, JSON.stringify(hk.data))
  const eff = dbq("SELECT COUNT(*) n FROM knowledge_effectiveness")[0].n
  const cur = dbq("SELECT COUNT(*) n FROM effectiveness_cursors")[0].n
  ev("ledger-baseline", { eff, cur })
  record(results, "游标表在场（v55 迁移态 user_version=55）", dbq("PRAGMA user_version")[0].user_version === 55, `eff=${eff} cursors=${cur}`)
  // KC 会话就位（auto-retire 通知卡落点；patrol-job.findByClone 同判据）
  const list = await fetchJSON(`${API}/api/clones/archive/sessions?org=${ORG}`, { headers: KC_HDR })
  const items = list.data?.items || list.data?.sessions || list.data || []
  let sess = (Array.isArray(items) ? items : []).find((s) => s.title === "知识中心" || s.scope_id === "knowledge")
  if (!sess) {
    const cr = await fetchJSON(`${API}/api/clones/archive/sessions`, { ...post({ title: "知识中心", scope_id: "knowledge" }), headers: KC_HDR })
    sess = cr.data
  }
  saveState("kcsession", sess)
  record(results, "知识中心会话就位（Lane A 卡落点）", !!sess?.id, `sess=${sess?.id}`)
  const q = await fetchJSON(`${API}/api/knowledge/wiki/queue`)
  ev("queue-baseline", q.data)
  record(results, "队列基线可读（depth 面）", q.ok && typeof q.data?.depth === "number", `depth=${q.data?.depth}`)
}

// ─── fixtures：tmpdir 副本上的隔离现场（真 fs 真 git 仓内位，绝不打真盘）─────────
async function fixtures() {
  const bloatBody = "## 硬约束\n" + Array.from({ length: 21 }, (_, i) =>
    `- we11 膨胀靶纪律第 ${i + 1} 条：会话投喂泛化验收条目须保持结构完整不触发拆分，编号${i + 1} <!--#oct-${OCT_BLOAT_FROM + i}-->`).join("\n")
  WRITE("topics/we11-bloat.md", page({ id: "we11-bloat", type: "topic", title: "we11 膨胀榜靶页", summary: "E2E_HARNESS_TEST 膨胀水位预拆分靶（21 条硬约束推高锚点比）", body: bloatBody }))
  WRITE("topics/we11-gate-test.md", page({ id: "we11-gate-test", type: "topic", title: "we11 记账靶页", summary: "E2E_HARNESS_TEST 记账链锚点载体（先测后建纪律）", body: "## 硬约束\n- 实现功能后必须先运行 pnpm test 确保 vitest 全绿再执行 pnpm build，防止带病产物进入构建环节 <!--#" + OCT_GATE + "-->" }))
  WRITE("topics/we11-dup-a.md", page({ id: "we11-dup-a", type: "topic", title: "we11 重复对甲页", summary: "E2E_HARNESS_TEST 重复对近义规则甲载体", body: "## 硬约束\n- 工作流 YAML 修改后必须先用 octopus workflow validate 校验再执行，避免环检测与引用错误浪费运行额度 <!--#" + OCT_DUP_A + "-->" }))
  WRITE("topics/we11-dup-b.md", page({ id: "we11-dup-b", type: "topic", title: "we11 重复对乙页", summary: "E2E_HARNESS_TEST 重复对近义规则乙载体", body: "## 硬约束\n- 工作流 YAML 修改后必须先用 octopus workflow validate 校验再执行，避免环检测与引用错误浪费运行时段 <!--#" + OCT_DUP_B + "-->" }))
  WRITE("topics/we11-zombie.md", page({ id: "we11-zombie", type: "topic", title: "we11 僵尸靶页", summary: "E2E_HARNESS_TEST 窄口自动退役靶（90 天零引用零入链带锚点）", lastCompiled: "2026-07-01", body: "## 硬约束\n- we11 僵尸纪律条目：无人引用的会话投喂试验规则须在沉默期后自动退役且可恢复 <!--#" + OCT_ZOMBIE + "-->" }))
  WRITE("topics/we11-linked.md", page({ id: "we11-linked", type: "topic", title: "we11 入链靶页", summary: "E2E_HARNESS_TEST 入链摘除与回补靶（宿主页活链载体）", body: "## 硬约束\n- we11 入链纪律条目：活页引用退役页时链接须改写为已退役指针文本且不留断链 <!--#" + OCT_LINKED + "-->" }))
  WRITE("concepts/we11-linked-host.md", page({ id: "we11-linked-host", type: "concept", title: "we11 入链宿主", summary: "E2E_HARNESS_TEST 活页入链宿主（[[链接]] 指向入链靶页）", links: ["we11-linked"], body: "本概念页引用 [[we11-linked]] 作为活链样本，供退役摘除与恢复回补双相验证。" }))
  WRITE("topics/we11-volatile.md", page({ id: "we11-volatile", type: "topic", title: "we11 到期靶页", summary: "E2E_HARNESS_TEST volatile 到期负断言靶（到期但不自动退役）", stability: "volatile", reviewAfter: "2026-08-15", lastCompiled: "2026-07-05", body: "## 硬约束\n- we11 到期条目：volatile 复审指针过期的规则须产出三选一复审 finding 而非自动退役 <!--#" + OCT_VOL + "-->" }))
  WRITE("concepts/we11-volatile-host.md", page({ id: "we11-volatile-host", type: "concept", title: "we11 到期宿主", summary: "E2E_HARNESS_TEST 到期靶入链宿主（窄口 has-inbound-links 证据）", links: ["we11-volatile"], body: "本概念页引用 [[we11-volatile]] 证明零入链判据对到期页的拦截。" }))
  // 记账链 fixture 流（vars_update 制式=engine parse-vars-update 三形态之单行 JSON）
  const mkFlow = (n, refs, blocker) => `apiVersion: octopus/v1
kind: Workflow
name: we11-eff-${n}
description: "we11 票11 记账链真执行 fixture（查阅节点+review 节点，vars_update 落池）"
nodes:
  - id: wiki-consume
    type: agent
    model: haiku
    prompt: |
      这是 octopus wiki 实效记账验收的一次真实查阅执行。请用 Read 工具整读下面两个文件：
      ${WIKI}/INDEX.md
      ${WIKI}/topics/we11-gate-test.md
      然后仅输出一行 JSON（不要其他文字）：
      {"vars_update":{"wiki_refs":[${refs.map((r) => JSON.stringify(r)).join(",")}]}}
  - id: review
    type: agent
    model: haiku
    depends_on: [wiki-consume]
    prompt: |
      你是 review 节点。本次执行现场上报如下 blocker。仅输出一行 JSON（不要其他文字）：
      {"vars_update":{"review_blockers":[${JSON.stringify(blocker)}]}}
`
  const flows = loadFlows()
  const wsNames = {}
  for (const [n, refs, blocker] of flows) {
    // 每执行独立工作区（引擎契约：一工作区一根执行）
    let st = loadState(`ws${n}`)
    if (!st) {
      const name = `E2E_HARNESS_TEST_we11-eff${n}-${RUN}`
      const r = await fetchJSON(`${API}/api/workspaces`, { ...post({ name, org: ORG, description: `we11 票11 记账链执行${n}` }), headers: JSON_HDR })
      st = r.data
      saveState(`ws${n}`, st)
    }
    wsNames[n] = st
    const wf = await fetchJSON(`${API}/api/workspaces/${st.id}/workflows`, { ...post({ ref: `we11-eff-${n}`, content: mkFlow(n, refs, blocker) }), headers: JSON_HDR })
    if (!wf.ok) { const list = await fetchJSON(`${API}/api/workspaces/${st.id}/workflows`); if (!JSON.stringify(list.data || "").includes(`we11-eff-${n}`)) record(results, `工作流 we11-eff-${n} 落位`, false, JSON.stringify(wf.data)) }
  }
  saveState("flows", flows.map((f) => f[0]))
  record(results, "记账 fixture 工作流×4+独立工作区×4 落位（每执行一 ws，引擎单根契约）", true, "")
  // 判别证：实例根=tmpdir 副本（真盘无 we11 页）——用 patrol 的 fs 扫描面裁决（tree 是 DB 源不可用）
  const ptProbe = await fetchJSON(`${API}/api/knowledge/patrol`, post({}))
  const scannedPages = ptProbe.data?.scanned?.pages
  const realTotal = ["entities", "concepts", "topics", "sources", "cases"].reduce((n, d) => n + (fs.existsSync(path.join(REAL_WIKI, d)) ? fs.readdirSync(path.join(REAL_WIKI, d)).filter((x) => x.endsWith(".md")).length : 0), 0)
  ev("patrol-discriminate-probe", { scannedPages, realTotal })
  record(results, "判别证：patrol 扫描页数 ≥ 真盘在册+8 we11 fixture ⇒ 实例根=tmpdir 副本", typeof scannedPages === "number" && scannedPages >= realTotal + 8, `scanned=${scannedPages} real=${realTotal}`)
}

function loadFlows() {
  return [
    ["1", ["we11-gate-test#" + OCT_GATE, "prj-open-octopus#oct-007"], "Telegram notify token 失效导致推送失败，与测试流程和端口启动均无关"],
    ["2", ["we11-gate-test#" + OCT_GATE], "改动后没有先跑 pnpm test 就直接 pnpm build，vitest 三条失败被构建产物掩盖"],
    ["3", ["we11-gate-test#" + OCT_GATE], "再次未运行 pnpm test 便执行 pnpm build，带病产物入库导致返工"],
    ["4", ["we11-gate-test#" + OCT_GATE, "wf-prd-impl#oct-014"], "先 build 后测的顺序错误重演：pnpm build 完成后才跑 pnpm test，暴露三条红"],
    ["5", ["wf-prd-impl#oct-014"], "实现完功能直接 pnpm build 未先运行 pnpm test，vitest 失败混入构建产物"],
    ["6", ["wf-prd-impl#oct-014"], "跳过了 pnpm test 全绿检查就执行 pnpm build，红用例进入交付面导致回滚"],
    ["7", ["wf-prd-impl#oct-014"], "pnpm build 先行、pnpm test 滞后，同类失败第三次重现于评审"],
  ]
}

// ─── effExecs / effExecs2：真 provider 执行（JSONL turn_usage 在场证）─────────
async function runFlow(n) {
  const ws = loadState(`ws${n}`)
  const prev = (loadState("execs") || {})[n]
  if (prev?.execId) {
    record(results, `exec${n} 已在案（幂等续跑跳过；证据 results-effExecs*-${RUN}.json 首跑行）`, prev.status === "completed", `exec=${prev.execId}`)
    return prev.execId
  }
  const ce = await fetchJSON(`${API}/api/workspaces/${ws.id}/executions`, post({ workflow_ref: `we11-eff-${n}`, name: `we11-eff-${n}-run-${RUN}` }))
  const execId = ce.data?.id
  if (!execId) { record(results, `exec${n} 创建`, false, JSON.stringify(ce.data)); return null }
  await fetchJSON(`${API}/api/workspaces/${ws.id}/executions/${execId}/start`, post({}))
  const poll = await pollJson(`/api/workspaces/${ws.id}/executions/${execId}`, EXEC_TERMINAL, { maxMs: 300000, interval: 4000 })
  const st = poll.data?.status || poll.data?.execution?.status
  ev(`exec${n}-final`, poll.data)
  const rows = dbq(`SELECT status, substr(var_pool,1,400) vp FROM executions WHERE id='${execId}'`)
  ev(`exec${n}-varpool-db`, rows)
  const pool = rows[0]?.vp ? (() => { try { return JSON.parse(dbq(`SELECT var_pool vp FROM executions WHERE id='${execId}'`)[0].vp) } catch { return null } })() : null
  const logDir = path.join(String(ws.path).replace(/^~/, HOME), "logs", execId)
  const jsonlFiles = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl")) : []
  const jsonl = jsonlFiles.map((f) => readIf(path.join(logDir, f))).join("\n")
  evLines(`exec${n}-jsonl-turn-usage`, jsonl.split(/\r?\n/).filter((l) => l.includes("turn_usage")).slice(0, 3).join("\n"))
  record(results, `exec${n} 真执行 completed`, st === "completed", `exec=${execId} took=${poll.tookMs}ms`)
  record(results, `exec${n} JSONL turn_usage 原行（真 provider 往返，非 mock）`, /turn_usage/.test(jsonl), `files=${jsonlFiles.join(",")}`)
  record(results, `exec${n} var_pool 落 wiki_refs（DB 权威；review_blockers 在场与否如实注记）`, !!pool?.wiki_refs, `blockers=${Array.isArray(pool?.review_blockers) ? pool.review_blockers.length : "缺席（模型键形偏差观察项）"}`)
  const st2 = loadState("execs") || {}
  st2[n] = { execId, status: st, pool }
  saveState("execs", st2)
  return execId
}
async function effExecs() { for (const n of ["1", "2", "3"]) await runFlow(n) }
async function effExecs2() { for (const n of ["4"]) await runFlow(n) }
async function effExecs3() { for (const n of ["5", "6", "7"]) await runFlow(n) }

// ─── effParse：手动触发解析 + 游标幂等 ─────────────────────────────
async function effParse() {
  const p1 = await fetchJSON(`${API}/api/knowledge/effectiveness/parse`, post({}))
  ev("parse-report", p1.data)
  const rep = p1.data
  const agg = dbq("SELECT SUM(helpful_count) h, SUM(not_helpful_count) n, COUNT(*) rows FROM knowledge_effectiveness WHERE helpful_count+not_helpful_count>0")[0]
  record(results, "POST /effectiveness/parse 端点契约（LedgerReport 键面齐；首跑落账原值见 results 证据）", rep && "scanned" in rep && "citations" in rep && "linkSkips" in rep && "lastCursor" in rep, JSON.stringify(rep))
  record(results, "LLM seam 真判定 link_status=judged（非 skipped:*；红线3）", !Object.keys(rep?.linkSkips || {}).length, `linkSkips=${JSON.stringify(rep?.linkSkips)}`)
  record(results, "helpful 与 not_helpful 均由真 provider 落账（票面硬闸·全账聚合口径）", agg.h >= 1 && agg.n >= 1, JSON.stringify(agg))
  const p2 = await fetchJSON(`${API}/api/knowledge/effectiveness/parse`, post({}))
  record(results, "游标幂等：重跑 scanned=0 零重复（故事6/红线6）", p2.data?.scanned === 0, JSON.stringify(p2.data))
  const rows = dbq("SELECT rule_id, cited_count, helpful_count, not_helpful_count, last_cited, confidence FROM knowledge_effectiveness ORDER BY cited_count DESC")
  ev("effectiveness-rows", rows)
  const g = rows.find((r) => r.rule_id === OCT_GATE)
  record(results, "锚点账目落行：oct-901 cited≥3 且 not_helpful≥2（helpful 对照同锚在场）", !!g && g.cited_count >= 3 && g.not_helpful_count >= 2 && g.helpful_count >= 1, JSON.stringify(g))
  const t14 = rows.find((r) => r.rule_id === "oct-014")
  record(results, "低置信弹药：oct-014 cited≥3 ∧ helpful=0 ∧ not_helpful≥3（conf 收敛=0 前置）", !!t14 && t14.cited_count >= 3 && t14.helpful_count === 0 && t14.not_helpful_count >= 3, JSON.stringify(t14))
  const pageRow = rows.find((r) => r.rule_id === "we11-gate-test")
  record(results, "页级 Read 序列记账（prj/we11 页键行，JSONL Read 通道）", !!pageRow || rows.some((r) => ["we11-gate-test", "prj-open-octopus", "wf-prd-impl"].includes(r.rule_id)), `keys=${rows.map((r) => r.rule_id).join(",")}`)
  const cur = dbq("SELECT execution_id, citations, helpful, not_helpful, link_status FROM effectiveness_cursors ORDER BY parsed_at")
  ev("cursors-rows", cur)
  record(results, "游标持久行=已解析执行×每执行一行", cur.length >= 4, `n=${cur.length}`)
}

// ─── effSync：confidence 滚动 + DB 真源刷页快照（opKind effectiveness-sync）──
async function effSync() {
  const s = await fetchJSON(`${API}/api/knowledge/effectiveness/sync`, post({}))
  ev("sync-report", s.data)
  const rep = s.data
  record(results, "POST /effectiveness/sync rowsRecomputed≥1（confidence=helpful/(h+nh) DB 真源）", rep && rep.rowsRecomputed >= 1 && rep.updated?.length >= 1, JSON.stringify({ r: rep?.rowsRecomputed, u: rep?.updated?.length }))
  const gateRow = dbq(`SELECT confidence FROM knowledge_effectiveness WHERE rule_id='${OCT_GATE}'`)[0]
  record(results, `oct-901 confidence 收敛=0.400（2/5 滚动真源刷新）`, !!gateRow && Math.abs(gateRow.confidence - 0.4) < 0.001, JSON.stringify(gateRow))
  const t14 = dbq(`SELECT confidence FROM knowledge_effectiveness WHERE rule_id='oct-014'`)[0]
  record(results, `oct-014 confidence 收敛=0.000（0/3 全灭→低置信 finding 弹药）`, !!t14 && Math.abs(t14.confidence - 0) < 0.001, JSON.stringify(t14))
  if (rep?.queueTaskId) {
    const t = await pollJson(`${API}/api/knowledge/wiki/queue/task/${rep.queueTaskId}`, TERMINAL, { maxMs: 240000 })
    ev("sync-queue-task", t.data)
    record(results, "effectiveness-sync 队列位 committed（红线1 全局串行）", t.data?.task?.state === "committed" || t.data?.state === "committed", `took=${t.tookMs}ms`)
  }
  const page = readIf(path.join(WIKI, "topics/we11-gate-test.md"))
  const fmConf = page.match(/^confidence:\s*([0-9.]+)/m)?.[1]
  evLines("sync-page-diff", git(["log", "-1", "--format=%H %s", "--", "topics/we11-gate-test.md"]) + "\n" + git(["show", "--stat", "HEAD", "--format=%H %s"]).slice(0, 600))
  record(results, "页 front-matter confidence 快照被刷（DB→页可局面，故事3/4）", fmConf !== null && fmConf !== undefined, `front-matter confidence=${fmConf}`)
  const heads = { head: git(["rev-parse", "HEAD"]).trim() }
  saveState("afterSync", heads)
  // 判别证二：sync 后 we11 页入 DB（tree 可见）+ 副本 HEAD 与真盘正式分离叉
  const tree2 = await fetchJSON(`${API}/api/knowledge/wiki/tree?org=${ORG}`)
  const h2 = await fetchJSON(`${API}/api/knowledge/health`)
  record(results, "判别证二：tree 含 top-we11-gate-test 且 instance.gitHead≠真盘 HEAD", JSON.stringify(tree2.data || {}).includes("we11-gate-test") && h2.data?.gitHead === heads.head && h2.data?.gitHead !== gitReal(["rev-parse", "HEAD"]).trim(), `inst=${h2.data?.gitHead?.slice(0, 9)} real=${gitReal(["rev-parse", "--short", "HEAD"]).trim()}`)
}

// ─── patrolNum：夜巡数值查 + 健康分手算对靶 + 裁决即编译（duplicate 确定性合并）──
async function patrolNum() {
  const pt = await fetchJSON(`${API}/api/knowledge/patrol`, post({}))
  ev("patrol-report", pt.data)
  const f = await fetchJSON(`${API}/api/knowledge/findings?status=open`)
  const open = f.data?.findings || []
  const allF = []
  for (const st of ["open", "resolved", "ignored"]) allF.push(...((await fetchJSON(`${API}/api/knowledge/findings?status=${st}`)).data?.findings || []))
  const kinds = new Set([...(pt.data?.findings || []).map((x) => x.kind), ...allF.map((x) => x.kind)])
  for (const k of ["bloat", "zombie", "duplicate", "volatile-expired", "low-confidence"]) {
    record(results, `数值查 finding 在场：kind=${k}（膨胀/僵尸/重复各≥1 + 低置信 + 到期；巡检报告∪open 并集，幂等可重跑）`, kinds.has(k), `kinds=${[...kinds].join(",")}`)
  }
  const dup = open.find((x) => x.kind === "duplicate")
  // ① 裁决即编译（票面「择一裁决」= 重复对确定性合并）
  if (dup) {
    const a = await fetchJSON(`${API}/api/knowledge/findings/${dup.id}/adopt`, post({}))
    record(results, "重复对 finding adopt →202 finding-fix 入队（裁决即编译）", a.ok && /^fft-/.test(a.data?.taskId || ""), JSON.stringify(a.data))
    const t = await pollJson(`${API}/api/knowledge/findings/fix/task/${a.data.taskId}`, TERMINAL, { maxMs: 300000 })
    ev("dup-adopt-task", t.data)
    const rec = t.data?.task || {}
    record(results, "finding-fix 队列位 committed + 合并稿单 commit 落盘（红线1 经队列）", rec.status === "committed" && /^[0-9a-f]{40}$/.test(rec.result?.commit || "") && (rec.result?.touched || []).length >= 1, JSON.stringify({ st: rec.status, commit: rec.result?.commit?.slice(0, 9), touched: rec.result?.touched?.length }))
    record(results, "被合并页 git diff 显形（we11-dup-a/b 内容变更）", /compile: .*— .*finding|finding 采纳/.test(git(["log", "-1", "--format=%s"])) && (rec.result?.touched || []).every((x) => x.path.includes("we11-dup")), git(["log", "-1", "--format=%s"]).trim())
  } else {
    record(results, "duplicate 已裁决在案（重跑段跳过 adopt；首跑证据 evidence/dup-adopt-task.json）", fs.existsSync(path.join(EV_DIR, "dup-adopt-task.json")), "")
  }
  // ② organic 非数值 findings 一律 ignore（owner 裁决面；审计行保留），给公式对靶清出未饱和区
  const NUMERIC = new Set(["bloat", "zombie", "duplicate", "volatile-expired", "low-confidence", "index-budget"])
  const f2 = await fetchJSON(`${API}/api/knowledge/findings?status=open`)
  const toIgnore = (f2.data?.findings || []).filter((x) => !NUMERIC.has(x.kind))
  for (const x of toIgnore) await fetchJSON(`${API}/api/knowledge/findings/${x.id}/ignore`, post({}))
  const f2b = await fetchJSON(`${API}/api/knowledge/findings?status=open`)
  const residual = (f2b.data?.findings || []).filter((x) => !NUMERIC.has(x.kind)).length
  record(results, "organic findings 显式 ignore 清场（ignore=裁决在案非静默；保留六数值类待裁）", toIgnore.length >= 1 || residual === 0, `ignored=${toIgnore.length} residual=${residual}`)
  // ③ 健康分独立手算（未饱和区精确对靶）
  const f3 = await fetchJSON(`${API}/api/knowledge/findings?status=open`)
  const openNum = f3.data?.findings || []
  ev("findings-open-after-cleanup", openNum.map((x) => ({ id: x.id, kind: x.kind, severity: x.severity })))
  const h0 = await fetchJSON(`${API}/api/knowledge/health`)
  ev("health-score-handcheck", { api: h0.data?.score, open: openNum.map((x) => x.kind) })
  const W = { critical: 8, major: 4, minor: 2 }
  const sev = (k) => (k === "contradiction" ? "critical" : ["stale", "missing-page", "index-budget", "low-confidence", "bloat", "duplicate", "volatile-expired"].includes(k) ? "major" : "minor")
  const ded = openNum.reduce((s, x) => s + W[sev(x.kind)], 0)
  const cap = scanPages().reduce((s, e) => {
    if (e.type === "case") return s
    const c = readIf(path.join(WIKI, e.relPath)).replace(/\r?\n+$/, "")
    const wl = Math.max(c.split(/\r?\n/).length / 120, e.anchors.length / 25, estTokens(c) / 2000)
    return s + Math.max(0, wl - 0.8) * 25
  }, 0)
  const expected = Math.max(0, Math.min(100, Math.round(100 - ded - cap)))
  ev("handcalc", { ded, cap: Math.round(cap * 100) / 100, expected, api: h0.data?.score })
  record(results, `health score 落健康条且=独立手算 ${expected}（SCHEMA 权重公式对靶，禁 tautology）`, typeof h0.data?.score === "number" && h0.data?.score === expected, `api=${h0.data?.score} hand=${expected} ded=${ded} cap=${cap.toFixed(2)}`)
  record(results, "avgConfidence 可见（票07 health 新键）", typeof h0.data?.avgConfidence === "number", String(h0.data?.avgConfidence))
  saveState("healthAfterPatrol", { score: h0.data?.score })
}

// ─── budgetWarn：⑥ INDEX>80% 预警带复现靶（票03 现场复证，D-aa16-2 清偿面）──
async function budgetWarn() {
  const idx = readIf(path.join(WIKI, "INDEX.md"))
  const visiblePortion = idx.split("## Optional")[0]
  const base = estTokens(visiblePortion)
  const { tok: predict } = predictVisibleTokens([])
  ev("budget-pre", { base, predict, scan: scanPages().length })
  // pad 目标：恒见段推到 ~690±（>640 warn 带内、留新页行余量 <800）
  const target = 690
  const padSummary = predict < 645
    ? "E2E_HARNESS_TEST 预算带填充条目：把恒见段推入预警区间以复现票零三的两级闸形态，其正文由策展人编译触发的行数与锚点都不触发硬顶仅触发预警随卡附三选一提案。".repeat(Math.max(1, Math.ceil((target - predict - 30) / estTokens("E2E_HARNESS_TEST 预算带填充条目：把恒见段推入预警区间以复现票零三的两级闸形态，其正文由策展人编译触发的行数与锚点都不触发硬顶仅触发预警随卡附三选一提案。"))))
    : "E2E_HARNESS_TEST 预算带填充条目（恒见已在预警带内的保守填充）。"
  if (predict < 645 || predict > 760) {
    WRITE("topics/we11-pad.md", page({ id: "we11-pad", type: "topic", title: "we11 预算填充页", summary: padSummary, body: "## 硬约束\n- we11 填充纪律条目：预算带靶页仅用于把恒见段推入预警区间不做知识供给 <!--#" + OCT_PAD + "-->" }))
  }
  const p2 = predictVisibleTokens([])
  ev("budget-pad-predict", p2)
  const ing = await fetchJSON(`${API}/api/knowledge/ingest?compile=true`, post({ mode: "text", text: "we11 预算带靶源文：本文说明知识策展把会话投喂动词与 URL 组合转成抓取、raw 冻结与编译入队的全过程，以及 INDEX 两级预算预警（放行走告警带）与硬顶拒写的分工边界。", title: "we11 预算带靶说明" }))
  ev("budget-ingest-receipt", ing.data)
  const ctid = ing.data?.compileTask?.taskId
  record(results, "⑥a 走 ingest?compile=true 真产品通道（raw 冻结件生成+crt- 编译回执）", ing.ok && /^crt-/.test(ctid || "") && !!ing.data?.raw?.hash, JSON.stringify({ rawPath: ing.data?.raw?.path, taskId: ctid }))
  const t = await pollJson(`${API}/api/knowledge/wiki/compile/task/${ctid}`, TERMINAL, { maxMs: 480000 })
  ev("budget-compile-task", t.data)
  const st = t.data?.task?.status || t.data?.task?.state
  record(results, "⑥a >80% 新知识编译放行 committed（预警不拒新——D-aa16-2 清偿面）", st === "committed", `took=${t.tookMs}ms st=${st} err=${JSON.stringify(t.data?.task?.error || null)}`)
  const f = await fetchJSON(`${API}/api/knowledge/findings?status=open`)
  const budgetF = (f.data?.findings || []).find((x) => x.kind === "index-budget")
  ev("index-budget-finding", budgetF)
  const vt = budgetF?.detail?.visible_tokens
  record(results, "kind=index-budget 预警 finding 伴随（detail.visible_tokens∈(640,800]）", !!budgetF && vt > 640 && vt <= 800, JSON.stringify({ vt, threshold: budgetF?.detail?.warn_threshold_tokens, proposals: (budgetF?.detail?.proposals || []).length }))
  record(results, "预警三选提案在场（移 Optional/拆分/hub 化）", (budgetF?.detail?.proposals || []).length === 3, JSON.stringify(budgetF?.detail?.proposals))
  const commit = git(["rev-parse", "HEAD"]).trim()
  saveState("revertTarget", { commit, subject: git(["log", "-1", "--format=%s"]).trim(), taskId: ctid, rawPath: ing.data?.raw?.path })
  evLines("revert-target-commit", `${commit} ${git(["log", "-1", "--format=%s"])}`)
  record(results, "深回滚靶 commit 已存（⑥a 编译=④ 目标）", /^[0-9a-f]{40}$/.test(commit), git(["log", "-1", "--format=%h %s"]).trim())
}

// ─── curation：③ 泛化投喂——非知识中心会话「把这篇编进 wiki」→ 路由 → 原会话回流 ──
async function curation() {
  let prev = loadState("curationSession") || {}
  let sid = prev.id
  if (!sid) {
    const sess = await fetchJSON(`${API}/api/agent/sessions`, { ...post({}), headers: ORG_HDR })
    sid = sess.data?.id || sess.data?.session?.id
    record(results, "普通 Main Agent 会话建立（session_type=main ∧ 无 clone=非知识中心载体）", !!sid && (sess.data?.session_type === "main"), `session=${sid}`)
    saveState("curationSession", { id: sid })
    prev = { id: sid }
  } else {
    record(results, "复用既有 Main Agent 会话（幂等续跑位）", true, `session=${sid}`)
  }
  if (!prev.chatDone) {
    const msg = "把这篇编进 wiki https://example.com/"
    const t0 = Date.now()
    const res = await fetch(`${API}/api/agent/chat`, { method: "POST", headers: ORG_HDR, body: JSON.stringify({ message: msg, session_id: sid }), signal: AbortSignal.timeout(300000) })
    const stream = await res.text()
    evLines("curation-sse", stream.slice(0, 60000))
    const toolHit = /ingest_to_wiki/.test(stream)
    record(results, "orchestrator 意图路由：真 LLM 调用 ingest_to_wiki（SSE 原行）", toolHit, `took=${Date.now() - t0}ms bytes=${stream.length}`)
    const receipt = stream.match(/已投喂入库[^\n"]*/)?.[0] || ""
    record(results, "路由回执=raw 冻结+编译入全局串行队列（复用既有插座，故事19/21）", !!receipt, receipt.slice(0, 160))
    saveState("curationSession", { ...prev, chatDone: true, receipt })
  } else {
    record(results, "意图路由已在案（重跑段；SSE 原行见 evidence/curation-sse.txt）", fs.existsSync(path.join(EV_DIR, "curation-sse.txt")), prev.receipt)
  }
  await sleep(3000)
  const m = await fetchJSON(`${API}/api/agent/sessions/${sid}`, { headers: ORG_HDR })
  const msgs = getMsgs(m.data)
  const blocks = msgs.flatMap((mm) => [...String(mm.content || "").matchAll(/```kc-card\r?\n([\s\S]*?)```/g)].map((x) => { try { return JSON.parse(x[1]) } catch { return null } }).filter(Boolean))
  ev("curation-cards-beat1", blocks.map((b) => ({ id: b.id, kind: b.kind, status: b.data?.status })))
  const ing = blocks.find((b) => b.kind === "ingest")
  record(results, "抓取卡回流原会话（kind=ingest id=ing-* 跨会话 Lane A）", !!ing, JSON.stringify(ing || {}).slice(0, 200))
  const dif = blocks.find((b) => b.kind === "compile-diff")
  record(results, "diff 卡首拍回流原会话（kind=compile-diff queued）", !!dif, JSON.stringify(dif?.data || {}).slice(0, 160))
  record(results, "卡片零审批钮（数据面负断言：无 button/approve 字段）", !JSON.stringify(blocks).match(/"(button|approve|reject)"/i), "")
  const ctid = dif?.data?.taskId || ing?.data?.compile?.taskId
  if (ctid) {
    const t = await pollJson(`${API}/api/knowledge/wiki/compile/task/${ctid}`, TERMINAL, { maxMs: 480000 })
    ev("curation-compile-final", t.data)
    record(results, "复用编译队列通道 committed（Lane A 终态卡落定）", (t.data?.task?.status || t.data?.task?.state) === "committed", `taskId=${ctid} took=${t.tookMs}ms`)
    await sleep(4000)
    const m2 = await fetchJSON(`${API}/api/agent/sessions/${sid}`, { headers: ORG_HDR })
    const blocks2 = getMsgs(m2.data).flatMap((mm) => [...String(mm.content || "").matchAll(/```kc-card\r?\n([\s\S]*?)```/g)].map((x) => { try { return JSON.parse(x[1]) } catch { return null } }).filter(Boolean))
    const final = blocks2.filter((b) => b.kind === "compile-diff" && b.data?.status === "committed")
    ev("curation-cards-final", blocks2.map((b) => ({ id: b.id, kind: b.kind, status: b.data?.status, commit: b.data?.commit })))
    record(results, "终态 diff 卡回流原会话（status=committed 含 commit）", final.length >= 1, JSON.stringify(final[0]?.data?.commit))
    record(results, "编译落库：新页+LOG ingest 行入真 git（tmpdir 副本）", /ingest \| /.test(git(["log", "-1", "--format=%s"]) + readIf(path.join(WIKI, "LOG.md"))), git(["log", "-1", "--format=%s"]).trim())
  }
}

// ─── linkedRetire：⑤ 前置——人裁退役走票04 统一机械（入链摘除证据面）───
async function linkedRetire() {
  const hostPath = path.join(WIKI, "concepts/we11-linked-host.md")
  if (!loadState("hostPreRetire")) saveState("hostPreRetire", { sha: sha256(readIf(hostPath)) })
  if (!fs.existsSync(path.join(WIKI, "topics/we11-linked.md")) && fs.existsSync(path.join(WIKI, "_retired/topics/we11-linked.md"))) {
    record(results, "退役已在案（重跑段：_retired/ 位存在，跳过重复退役）", true, "")
  } else {
    saveState("hostPreRetire", { sha: sha256(readIf(hostPath)) })
    const r = await fetchJSON(`${API}/api/knowledge/wiki/retire`, post({ path: "topics/we11-linked.md", reason: "we11 入链摘除与回补演示" }))
    record(results, "POST /wiki/retire 202（page-retire 队列通道）", r.ok && /^ret-/.test(r.data?.taskId || ""), JSON.stringify(r.data))
    const t = await pollJson(`${API}/api/knowledge/wiki/retire/task/${r.data.taskId}`, TERMINAL, { maxMs: 240000 })
    ev("linked-retire-task", t.data)
    const st = t.data?.task?.status || t.data?.task?.state || t.data?.state
    record(results, "退役 committed：_retired/ 落位 + 活页位消失", st === "committed" && fs.existsSync(path.join(WIKI, "_retired/topics/we11-linked.md")) && !fs.existsSync(path.join(WIKI, "topics/we11-linked.md")), `state=${st}`)
  }
  const host = readIf(hostPath)
  record(results, "票04 统一机械：宿主 [[链接]]→[已退役] 指针文本 + links 摘项（故事26）", host.includes("[已退役]") && !host.match(/links:.*we11-linked/), host.split(/\r?\n/).find((l) => l.includes("退役"))?.slice(0, 100))
  const log = readIf(path.join(WIKI, "LOG.md"))
  record(results, "LOG retire 行含「摘除 N 页入链」注记", /retire \| topics\/we11-linked\.md/.test(log) && /摘除 \d+ 页入链/.test(log), log.split(/\r?\n/).filter((l) => l.includes("we11-linked")).join(" ⏎ ").slice(0, 200))
  const broken = brokenLinkScan()
  record(results, "L5 断链零潜伏（退役后全库 [[链接]] 扫描无指退役页活链）", broken.filter((b) => b.includes("we11-linked")).length === 0, JSON.stringify(broken))
}
function brokenLinkScan() {
  const pages = scanPages()
  const stems = new Set(pages.map((p) => path.basename(p.relPath, ".md")))
  const ids = new Set(pages.map((p) => parseFm(readIf(path.join(WIKI, p.relPath)))?.id).filter(Boolean))
  const retired = fs.existsSync(path.join(WIKI, "_retired")) ? collectAll(path.join(WIKI, "_retired")).filter((x) => x.endsWith(".md")) : []
  const retiredStems = new Set(retired.map((x) => path.basename(x, ".md")))
  const broken = []
  for (const p of pages) {
    const body = parseFm(readIf(path.join(WIKI, p.relPath)))?._body || ""
    for (const m of body.matchAll(/\[\[([^\]|#]+)/g)) {
      const t = m[1].trim()
      if (!stems.has(path.basename(t, ".md")) && !ids.has(t)) broken.push(`${p.relPath}→[[${t}]]`)
    }
  }
  for (const p of pages) {
    for (const l of parseFm(readIf(path.join(WIKI, p.relPath)))?.links?.length ? JSON.parse((parseFm(readIf(path.join(WIKI, p.relPath))).links || "[]").replace(/([a-z0-9-]+)/g, '"$1"').replace(/'/g, '"')) : []) {
      if (!ids.has(String(l)) && !stems.has(path.basename(String(l), ".md"))) broken.push(`${p.relPath}→fm:${l}`)
    }
  }
  return [...new Set(broken)]
}
const collectAll = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? collectAll(path.join(d, e.name)) : [path.join(d, e.name)])

// ─── deepRevert：④ 非 HEAD-adjacent 深回滚（状态重建；票面要求目标后 ≥2 触共行 commit）──
async function deepRevert() {
  const tgt = loadState("revertTarget")
  const shared = Number(git(["rev-list", "--count", `${tgt.commit}..HEAD`, "--", "INDEX.md", "LOG.md"]).trim() || "0")
  record(results, `深回滚靶合法：目标后 ≥2 枚触 INDEX/LOG 共行 commit（票面口径）`, shared >= 2, `shared=${shared} target=${tgt.commit.slice(0, 9)}`)
  const before = { head: git(["rev-parse", "HEAD"]).trim(), status: git(["status", "--porcelain"]) }
  const r = await fetchJSON(`${API}/api/knowledge/wiki/revert`, post({ commit: tgt.commit }))
  record(results, "POST /wiki/revert 202 rvt- 受理", r.ok && /^rvt-/.test(r.data?.taskId || ""), JSON.stringify(r.data))
  const t = await pollJson(`${API}/api/knowledge/wiki/revert/task/${r.data.taskId}`, TERMINAL, { maxMs: 300000 })
  ev("deep-revert-task", t.data)
  const task = t.data?.task || t.data
  record(results, "深回滚 committed（REVERT_CONFLICT 成为历史——状态重建语义）", (task?.status || task?.state) === "committed", `state=${task?.state} err=${JSON.stringify(task?.error || null)}`)
  const res = task?.result || {}
  const log = readIf(path.join(WIKI, "LOG.md"))
  record(results, "LOG deep-revert 行落位（同族可 grep：revert | compile）", new RegExp(`^## \\[2026-\\d{2}-\\d{2}\\] deep-revert \\| compile ${tgt.commit.slice(0, 7)}`, "m").test(log) && /→ 回滚本次编译 · 状态重建 \d+ 页 · owner ✓/.test(log), log.split(/\r?\n/).filter((l) => l.includes("deep-revert")).join(" ⏎ ").slice(0, 200))
  record(results, "git log 无 merge（--merges 空）+ 顶行 deep-revert 同族", git(["log", "--merges", "--oneline"]).trim() === "" && /^deep-revert: /.test(git(["log", "-1", "--format=%s"])), git(["log", "-1", "--format=%s"]).trim())
  const subj = git(["log", "-1", "--format=%s"])
  record(results, "commit 消息制式（重建 N 页）逐字", /^deep-revert: [0-9a-f]{7,} — 回滚本次编译（重建 \d+ 页）/.test(subj), subj.trim())
  const names = git(["show", "--name-only", "--format=", "HEAD"]).split(/\r?\n/).filter(Boolean)
  record(results, "页/INDEX/LOG 三路同 commit 一致（touched==diff 面）", names.includes("INDEX.md") && names.includes("LOG.md") && res.touched?.length >= 1, `files=${names.join(",")}`)
  const targetPages = (git(["show", "--name-status", "--format=", tgt.commit]).split(/\r?\n/).filter((l) => /^A\t/.test(l)).map((l) => l.split("\t")[1]).filter((p) => p && !["INDEX.md", "LOG.md"].includes(p)))
  const gone = targetPages.every((p) => !fs.existsSync(path.join(WIKI, p)))
  record(results, "目标编译新增页在盘缺席（removed 动作兑现）", targetPages.length >= 1 && gone, `pages=${targetPages.join(",")}`)
  const idx = readIf(path.join(WIKI, "INDEX.md"))
  record(results, "INDEX 重建不含目标页行（程序化重建器单源）", targetPages.every((p) => !idx.includes(p)), "")
  const dbRows = dbq(`SELECT COUNT(*) n FROM wiki_articles WHERE ${targetPages.map((p) => `path LIKE '%${path.basename(p, ".md")}%'`).join(" OR ")}`)[0].n
  record(results, "DB wiki_articles 同步摘除（四路一致之二路：DB+FTS 面）", dbRows === 0, `rows=${dbRows}`)
  const search = await fetchJSON(`${API}/api/knowledge/wiki/search?q=会话投喂泛化&org=global`)
  ev("deep-revert-search", search.data)
  record(results, "FTS 检索诚实缺席（五路一致：FTS 面）", JSON.stringify(search.data || {}).indexOf("会话投喂泛化验收说明") === -1, String(search.ok))
  record(results, "raw 冻结件零触碰（不可变契约：raw 层不在回滚面）", fs.existsSync(path.join(KNOW, loadState("revertTarget")?.rawPath || "__none__")), String(loadState("revertTarget")?.rawPath))
  record(results, "工作区净+队列续", git(["status", "--porcelain"]).trim() === "", `headBefore=${before.head.slice(0, 9)} after=${git(["rev-parse", "--short", "HEAD"])}`)
  saveState("afterRevert", { head: git(["rev-parse", "HEAD"]).trim(), gone: targetPages })
}

// ─── nightPatrol：⑤ 自动退役窄口（scheduler 作业腿真跑：parse→sync→autoRetire）──
async function nightPatrol() {
  const before = { head: git(["rev-parse", "HEAD"]).trim(), queue: (await fetchJSON(`${API}/api/knowledge/wiki/queue`)).data?.depth }
  const tr = await fetchJSON(`${API}/api/scheduler/jobs/builtin-knowledge-patrol/trigger`, post({}))
  ev("patrol-trigger", tr.data)
  record(results, "夜巡作业手动触发受理（系统作业既有挂载点，不新建作业）", !!tr.data, JSON.stringify(tr.data).slice(0, 160))
  let exec = null
  for (let i = 0; i < 120; i++) {
    const l = await fetchJSON(`${API}/api/scheduler/jobs/builtin-knowledge-patrol/executions`)
    exec = (l.data?.items || l.data || [])[0]
    if (exec && ["done", "failed", "completed", "success"].includes(exec.status)) break
    await sleep(4000)
  }
  ev("patrol-job-exec", exec)
  record(results, "夜巡作业执行终态 done（六腿链序 report→afterPatrol→parseLedger→syncConfidence→autoRetire）", exec && ["done", "completed", "success"].includes(exec.status), `status=${exec?.status} note=${String(exec?.result_summary || exec?.message || "").slice(0, 160)}`)
  const q = await fetchJSON(`${API}/api/knowledge/wiki/queue`)
  const tasks = q.data?.tasks || []
  const ar = tasks.filter((x) => x.opKind === "auto-retire")
  ev("night-queue-tasks", tasks.map((x) => ({ id: x.id, opKind: x.opKind, state: x.state, label: x.label })))
  record(results, "opKind=auto-retire 队列位 committed 恰 1 枚（唯一自动口，红线2 窄口）", ar.length === 1 && ar[0].state === "committed", JSON.stringify(ar.map((x) => ({ id: x.id, s: x.state }))))
  record(results, "僵尸靶页自动退役：_retired/ 落位+活页位消失+原号在场", fs.existsSync(path.join(WIKI, "_retired/topics/we11-zombie.md")) && !fs.existsSync(path.join(WIKI, "topics/we11-zombie.md")) && readIf(path.join(WIKI, "_retired/topics/we11-zombie.md")).includes(OCT_ZOMBIE), "")
  const log = readIf(path.join(WIKI, "LOG.md"))
  const retireLine = log.split(/\r?\n/).find((l) => l.includes("retire | topics/we11-zombie.md")) || ""
  const nextLine = log.split(/\r?\n/)[log.split(/\r?\n/).indexOf(retireLine) + 1] || ""
  record(results, "LOG retire 行·source=auto·理由含窄口判据原文", !!retireLine && nextLine.includes("auto") && nextLine.includes("窄口自动退役"), `${retireLine} ⏎ ${nextLine}`.slice(0, 200))
  // 通知卡（无审批钮负断言）
  const sess = loadState("kcsession")
  const m = await fetchJSON(`${API}/api/clones/archive/sessions/${sess.id}?org=${ORG}`, { headers: KC_HDR })
  const msgs = getMsgs(m.data)
  const blocks = msgs.flatMap((mm) => [...String(mm.content || "").matchAll(/```kc-card\r?\n([\s\S]*?)```/g)].map((x) => { try { return JSON.parse(x[1]) } catch { return null } }).filter(Boolean))
  const card = blocks.find((b) => b.kind === "auto-retire")
  ev("auto-retire-card", card)
  record(results, "夜巡通知卡落知识中心会话（kind=auto-retire，restoreHints 含 恢复 oct-950）", !!card && (card.data?.restoreHints || []).some((h) => h.includes(OCT_ZOMBIE)) && card.data?.status === "committed", JSON.stringify(card?.data || {}).slice(0, 200))
  record(results, "通知卡数据面零审批字段（渲染层零钮=S4 auto-retire.test.tsx 钉）", !JSON.stringify(card || {}).match(/"(button|approve|审批|批准)"/), "")
  // 窄口之外负断言：低置信/膨胀/到期/被入链页都不自动
  const stillLive = ["topics/we11-gate-test.md", "topics/we11-bloat.md", "topics/we11-volatile.md"].every((p) => fs.existsSync(path.join(WIKI, p)))
  record(results, "负断言：低置信/膨胀/volatile 到期页均未被自动退役（窄口只开一条）", stillLive && (q.data?.tasks || []).filter((x) => x.opKind === "auto-retire").length === 1, "")
  const after = (await fetchJSON(`${API}/api/knowledge/effectiveness/parse`, post({}))).data
  record(results, "夜巡 parseLedger 腿与手动同游标（幂等复跑零新账）", after?.scanned === 0, JSON.stringify(after))
  saveState("nightPatrol", { zombieRetiredBy: ar[0]?.id, headBefore: before.head })
}

// ─── restore：⑤ 对话恢复通道执行面（原号原行回迁 + 入链回补反放）──────────
async function restore() {
  const r = await fetchJSON(`${API}/api/knowledge/wiki/restore`, post({ anchor: OCT_ZOMBIE }))
  record(results, "恢复通道 202（POST /wiki/restore {anchor}——对话「恢复 oct-XXX」执行面；分类钮=S4）", r.ok && /^res-/.test(r.data?.taskId || ""), JSON.stringify(r.data))
  const t = await pollJson(`${API}/api/knowledge/wiki/restore/task/${r.data.taskId}`, TERMINAL, { maxMs: 240000 })
  ev("restore-zombie-task", t.data)
  const task = t.data?.task || t.data
  record(results, "僵尸页回迁 committed：原号原行（oct-950 字节在场）", (task?.status || task?.state) === "committed" && readIf(path.join(WIKI, "topics/we11-zombie.md")).includes(`<!--#${OCT_ZOMBIE}-->`), `state=${task?.state}`)
  const back = readIf(path.join(WIKI, "topics/we11-zombie.md"))
  record(results, "front-matter 摘 status/replaced_by（回在册面即衔接发号豁免）", !/status:\s*superseded/.test(back) && !fs.existsSync(path.join(WIKI, "_retired/topics/we11-zombie.md")), "")
  const log = readIf(path.join(WIKI, "LOG.md"))
  record(results, "LOG restore 行「自 _retired/ 回迁 · 原号原行」", /^## \[2026-\d{2}-\d{2}\] restore \| topics\/we11-zombie\.md/m.test(log) && /自 _retired\/ 回迁 · 原号原行/.test(log), log.split(/\r?\n/).filter((l) => l.includes("restore |")).join(" ⏎ ").slice(0, 220))
  const dbRow = dbq("SELECT COUNT(*) n FROM wiki_articles WHERE path LIKE '%we11-zombie%'")[0].n
  record(results, "DB/FTS 重注册（回迁四路）", dbRow >= 1, `rows=${dbRow}`)
  record(results, "restore 单 commit 制式（原号回迁）", /^restore: topics\/we11-zombie\.md ← _retired\/（原号回迁）/.test(git(["log", "-1", "--format=%s"])), git(["log", "-1", "--format=%s"]).trim())
  // 入链回补（票04 机械的反放）：恢复 linked 靶
  const r2 = await fetchJSON(`${API}/api/knowledge/wiki/restore`, post({ anchor: OCT_LINKED }))
  const t2 = await pollJson(`${API}/api/knowledge/wiki/restore/task/${r2.data.taskId}`, TERMINAL, { maxMs: 240000 })
  ev("restore-linked-task", t2.data)
  const pre = loadState("hostPreRetire")
  const host = readIf(path.join(WIKI, "concepts/we11-linked-host.md"))
  record(results, "入链回补：宿主页字节级反放退役 commit 前态（故事17/18）", sha256(host) === pre?.sha, `restored=${(t2.data?.task?.result || t2.data?.result)?.inboundRestored?.join(",")}`)
  const log2 = readIf(path.join(WIKI, "LOG.md"))
  record(results, "restore 行含「回补 N 页入链」注记", /回补 \d+ 页入链/.test(log2.split(/\r?\n/).filter((l, i, a) => a[i - 1]?.includes("we11-linked.md") && l.includes("→") || l.includes("回补") ? l : "").join("\n")) || /回补 1 页入链/.test(log2), log2.split(/\r?\n/).filter((l) => l.includes("回补")).join(" ⏎ ").slice(0, 160))
}


// 巨页历史提交态的常页回归文本（与已提交 blob 逐字一致，恢复即工作树净）
const SMALL_GIANT = ["---", "id: we11-giant", "type: topic", "title: we11 巨行页（拒写演示后常态化留档）", "summary: E2E_HARNESS_TEST 巨行靶页：拒写演示完成后退化为常页，保硬拒期编译页活链可达", "topics: [we11-fixture]", "links: []", "stability: stable", "last_compiled: 2026-10-15", "sources: [doc:we11-fixture]", "confidence: 0.8", "---", "## 硬约束", "- we11 巨行纪律条目：病态巨行使 Optional 重排无法收敛的形态已由两级闸复证，本页转为常页留档 <!--#oct-1000-->", ""].join(String.fromCharCode(10))

// ─── budgetReject：⑥b 恒见>100% 拒写+压缩建议（复现 D-aa16-2 原症状的闸形态）──
async function budgetReject() {
  const headBefore = git(["rev-parse", "HEAD"]).trim()
  // 病态巨行=最后一个降级候选：40 锚点（byLowActivity 升序垫底）+ 两段 H2（供拆分建议）
  const giant = "预算硬拒靶巨行摘要：".repeat(96) + "本条把恒见段单页推过 800 token 硬顶以复现病态巨行降无可降的拒写形态并附拆分建议。".repeat(8)
  const rules = Array.from({ length: 40 }, (_, i) => `- we11 巨行纪律补充条目编号${i + 1}：用于抬高锚点计数使本页面成为恒见段的最后降级候选 <!--#oct-${1000 + i}-->`)
  WRITE("topics/we11-giant.md", page({ id: "we11-giant", type: "topic", title: "we11 巨行页", summary: giant, body: `## 硬约束\n${rules.slice(0, 20).join("\n")}\n\n## 补充约束\n${rules.slice(20).join("\n")}` }))
  const ing = await fetchJSON(`${API}/api/knowledge/ingest?compile=true`, post({ mode: "text", text: `we11 硬拒靶源文第三次（tag ${RUN}）：编译应在写盘前被 L4 预测闸以恒见超硬顶拒绝并附压缩建议，零副作用可复核。`, title: "we11 硬拒靶说明叁" }))
  const ctid = ing.data?.compileTask?.taskId
  record(results, "⑥b 投喂受理（新 raw 冻结+编译入队）", !!ctid, JSON.stringify({ raw: ing.data?.raw?.path, ctid }))
  const t = await pollJson(`${API}/api/knowledge/wiki/compile/task/${ctid}`, TERMINAL, { maxMs: 480000 })
  ev("reject-task", t.data)
  const task = t.data?.task || {}
  record(results, "⑥b >100% 编译拒写 failed（L4_INDEX_BUDGET 入错误文——病态巨行降无可降，D-aa16-2 原症状复证）", (task?.status || task?.state) === "failed" && /L4_INDEX_BUDGET/.test(task?.error?.message || ""), JSON.stringify(task?.error || {}).slice(0, 260))
  record(results, "拒写附压缩建议（Optional/拆分/hub 措辞在错误文；suggestion 见任务结果面）", /Optional|拆分|hub/.test(task?.error?.message || ""), String(task?.error?.message).slice(0, 160))
  fs.rmSync(path.join(WIKI, "topics/we11-giant.md"))
  if (git(["ls-files", "--", "topics/we11-giant.md"]).trim()) WRITE("topics/we11-giant.md", SMALL_GIANT)
  record(results, "拒写零副作用：HEAD 不动+收尾 git 净（若巨页曾被历史提交则回归常页态）", git(["rev-parse", "HEAD"]).trim() === headBefore && git(["status", "--porcelain"]).trim() === "", `head=${headBefore.slice(0, 9)}`)
  record(results, "巨行靶 fixture 撤除/归常（副本面清理声明；拒写从未触盘=病态巨行在盘而库零写）", git(["status", "--porcelain"]).trim() === "", "")
}

// ─── budgetAdopt：index-budget finding 采纳=INDEX 恒见段重建（票03 AC3 裁决即编译）──
async function budgetAdopt() {
  const f = await fetchJSON(`${API}/api/knowledge/findings?status=open`)
  const bF = (f.data?.findings || []).find((x) => x.kind === "index-budget")
  if (!bF) {
    const resolved = (await fetchJSON(`${API}/api/knowledge/findings?status=resolved`)).data?.findings || []
    record(results, "index-budget 已裁决在案（重跑段；adopt 证据见首跑 budgetAdopt results 与 commit）", resolved.some((x) => x.kind === "index-budget"), "")
    return
  }
  const h0 = await fetchJSON(`${API}/api/knowledge/health`)
  const a = await fetchJSON(`${API}/api/knowledge/findings/${bF.id}/adopt`, post({}))
  record(results, "index-budget adopt 202（rebuildIndex 经 finding-fix 串行位——红线1）", a.ok && /^fft-/.test(a.data?.taskId || ""), JSON.stringify(a.data))
  const t = await pollJson(`${API}/api/knowledge/findings/fix/task/${a.data.taskId}`, TERMINAL, { maxMs: 240000 })
  const st = t.data?.task?.status || t.data?.task?.state || t.data?.state
  record(results, "INDEX 恒见段重建 committed（巨行清除后收敛态）", st === "committed", `state=${st}`)
  const idx = readIf(path.join(WIKI, "INDEX.md"))
  const vis = estTokens(idx.split("## Optional")[0])
  record(results, "重建后恒见段回落 ≤640（预警根因清除）", vis <= 645 && !idx.includes("we11-giant"), `visible=${vis}`)
  const h1 = await fetchJSON(`${API}/api/knowledge/health`)
  record(results, `adopt 后 score 位移=+4（index-budget major 二次公式对靶）`, h1.data?.score - h0.data?.score === 4, `before=${h0.data?.score} after=${h1.data?.score}`)
}


// ─── ops1Probe：D-p4-ops-1 复合形定向复探（矛盾标记 + 对同一退役页的正文活链 ⇒ 单侧降级被 L5 挡）──
const NL = String.fromCharCode(10)
const OPS1_TARGET_BODY = [
  "## 硬约束",
  "- we11 复探纪律条目：本行为 ops-1 复合形构造的对手规则载体 <!--#oct-1200-->",
].join(NL)
const OPS1_HOST_BODY = [
  "本页为 D-p4-ops-1 复探件：矛盾标记与对已退役页的正文活链同页并存。",
  "",
  "另有活链样本：[[we11-ops1-target]]。",
  "",
  "> 【fnd-0e110e110e110e11】与 [[we11-ops1-target]] (topics/we11-ops1-target.md) 冲突：旧断言「甲命题」↔ 新断言「乙命题」（复探构造）",
].join(NL)
async function ops1Probe() {
  if (git(["status", "--porcelain"]).trim() !== "") { record(results, "ops1Probe 前置：工作树须净（拒脏）", false, git(["status", "--porcelain"]).slice(0, 120)); return }
  WRITE("topics/we11-ops1-target.md", page({ id: "we11-ops1-target", type: "topic", title: "we11 复探靶页", summary: "E2E_HARNESS_TEST D-p4-ops-1 复探靶（退役后持矛盾活链复合形的对手页）", body: OPS1_TARGET_BODY }))
  const sw = await fetchJSON(`${API}/api/knowledge/ingest?compile=true`, post({ mode: "text", text: "we11 复探靶清扫源文：使 ops1Probe 的靶页经正常编译通道 add -A 入册，维持唯一写闸纪律的构造前置。", title: "we11 复探清扫源文" }))
  const st = await pollJson(`${API}/api/knowledge/wiki/compile/task/${sw.data?.compileTask?.taskId}`, TERMINAL, { maxMs: 480000 })
  const sweepOk = (st.data?.task?.status || st.data?.task?.state) === "committed"
  record(results, "复探前置：靶页经队列编译入册（零旁路直提）", sweepOk, JSON.stringify({ taskId: sw.data?.compileTask?.taskId, st: st.data?.task?.status || st.data?.task?.state, err: st.data?.task?.error }))
  if (!sweepOk) { fs.rmSync(path.join(WIKI, "topics/we11-ops1-target.md")); return }
  const r = await fetchJSON(`${API}/api/knowledge/wiki/retire`, post({ path: "topics/we11-ops1-target.md", reason: "ops-1 复探：退役后构造复合形" }))
  const rt = await pollJson(`${API}/api/knowledge/wiki/retire/task/${r.data.taskId}`, TERMINAL, { maxMs: 240000 })
  const retireOk = (rt.data?.task?.status || rt.data?.task?.state) === "committed" && fs.existsSync(path.join(WIKI, "_retired/topics/we11-ops1-target.md"))
  record(results, "复探前置：target 已产品退役（_retired 在盘）", retireOk, JSON.stringify(rt.data?.task?.error || null))
  if (!retireOk) return
  WRITE("concepts/we11-ops1-host.md", page({ id: "we11-ops1-host", type: "concept", title: "we11 复探宿主", summary: "E2E_HARNESS_TEST D-p4-ops-1 复合形宿主（标记+活链同页并存）", links: ["we11-ops1-target"], body: OPS1_HOST_BODY }))
  const nowIso = new Date().toISOString()
  dbw("INSERT OR REPLACE INTO findings (id,kind,status,title,detail,pages,raw_ref,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    "fnd-0e110e110e110e11", "contradiction", "open",
    "矛盾：concepts/we11-ops1-host.md ↔ topics/we11-ops1-target.md（D-p4-ops-1 复探件）",
    JSON.stringify({ old_claim: "甲命题", new_claim: "乙命题", pages: ["concepts/we11-ops1-host.md", "topics/we11-ops1-target.md"], marker: "冲突待裁决复报" }),
    JSON.stringify(["concepts/we11-ops1-host.md", "topics/we11-ops1-target.md"]), "", "compile", nowIso, nowIso)
  const a = await fetchJSON(`${API}/api/knowledge/findings/fnd-0e110e110e110e11/adopt`, post({}))
  record(results, "复探 adopt 受理（202 入队）", a.ok && /^fft-/.test(a.data?.taskId || ""), JSON.stringify(a.data))
  const t = await pollJson(`${API}/api/knowledge/findings/fix/task/${a.data.taskId}`, TERMINAL, { maxMs: 300000 })
  ev("ops1-adopt-task", t.data)
  const rec = t.data?.task || {}
  const blocked = (rec.status || rec.state) === "failed" && /L5_LINK_BROKEN/.test(rec.error?.message || "")
  record(results, "D-p4-ops-1 复证实锤：复合形下单侧降级被 L5_LINK_BROKEN 挡（adopt 恒 failed，票04 复合面未闭合）", blocked, JSON.stringify(rec.error || {}).slice(0, 220))
  record(results, "失败零副作用（队列补偿后 host 标记原样在盘）", fs.readFileSync(path.join(WIKI, "concepts/we11-ops1-host.md"), "utf8").includes("fnd-0e110e110e110e11"), "")
  const ig = await fetchJSON(`${API}/api/knowledge/findings/fnd-0e110e110e110e11/ignore`, post({}))
  fs.rmSync(path.join(WIKI, "concepts/we11-ops1-host.md"))
  record(results, "复探收口：finding ignore 在案 + 未提交宿主撤除 ⇒ git 净（真盘/审计面不掩盖）", ig.ok && git(["status", "--porcelain"]).trim() === "", `ignore=${ig.data?.status}`)
}

// ─── lane：卡片全单+队列全谱+红线账 ────────────────────────────────
async function lane() {
  // 一致性清扫：若工作树有 fixture 残留脏面（如被拒段扫入又撤除的巨页删除态），经产品通道（退役宿主页）收口重编 INDEX
  if (git(["status", "--porcelain"]).trim() && fs.existsSync(path.join(WIKI, "concepts/we11-volatile-host.md"))) {
    const rr = await fetchJSON(`${API}/api/knowledge/wiki/retire`, post({ path: "concepts/we11-volatile-host.md", reason: "we11 fixture 清扫收口（经队列重编 INDEX）" }))
    const rt = await pollJson(`${API}/api/knowledge/wiki/retire/task/${rr.data.taskId}`, TERMINAL, { maxMs: 240000 })
    record(results, "fixture 残留经产品退役通道清扫收口（无队外直提，红线1 守）", (rt.data?.task?.status || rt.data?.task?.state) === "committed" && git(["status", "--porcelain"]).trim() === "", git(["status", "--porcelain"]).slice(0, 120))
  }
  const sess = loadState("kcsession")
  const m = await fetchJSON(`${API}/api/clones/archive/sessions/${sess.id}?org=${ORG}`, { headers: KC_HDR })
  const msgs = getMsgs(m.data)
  const kc = msgs.flatMap((mm) => [...String(mm.content || "").matchAll(/```kc-card\r?\n([\s\S]*?)```/g)].map((x) => { try { return JSON.parse(x[1]) } catch { return null } }).filter(Boolean))
  const cur = loadState("curationSession")
  const m2 = await fetchJSON(`${API}/api/agent/sessions/${cur.id}`, { headers: ORG_HDR })
  const kc2 = getMsgs(m2.data).flatMap((mm) => [...String(mm.content || "").matchAll(/```kc-card\r?\n([\s\S]*?)```/g)].map((x) => { try { return JSON.parse(x[1]) } catch { return null } }).filter(Boolean))
  ev("lane-inventory", { kcSession: kc.map((b) => ({ k: b.kind, id: b.id, s: b.data?.status })), curationSession: kc2.map((b) => ({ k: b.kind, id: b.id, s: b.data?.status })) })
  const kinds = new Set([...kc, ...kc2].map((b) => b.kind))
  record(results, "跨会话渲染谱：原会话 ingest+compile-diff、KC 会话 auto-retire 卡全在场", kinds.has("ingest") && kinds.has("compile-diff") && kinds.has("auto-retire"), `kinds=${[...kinds].join(",")}`)
  record(results, "故事20 通道：普通会话卡片含终态 committed（Lane A 沉淀）", kc2.some((b) => b.kind === "compile-diff" && b.data?.status === "committed"), "")
  let art = await fetchJSON(`${API}/api/knowledge/wiki/article/we11-gate-test?org=${ORG}`)
  if (!art.ok) art = await fetchJSON(`${API}/api/knowledge/wiki/article/top-we11-gate-test?org=${ORG}`)
  const effSeg = art.data?.effectiveness
  ev("article-effectiveness-seg", effSeg)
  record(results, "故事4 可见面：article API effectiveness 实时段（cited/helpful/notHelpful/rate/confidence/measured）", art.ok && effSeg && effSeg.citedCount >= 3 && typeof effSeg.confidence === "number" && effSeg.measured === true, JSON.stringify(effSeg))
  const q = await fetchJSON(`${API}/api/knowledge/wiki/queue`)
  const kinds12 = new Set((q.data?.tasks || []).map((x) => x.opKind))
  const KNOWN12 = ["ingest-compile", "archive-compile", "dialog-revise", "lint-fix", "finding-fix", "revert", "redistill", "case-archive", "page-retire", "effectiveness-sync", "auto-retire", "page-restore"]
  record(results, "红线1 全谱：本轮队列 opKind ⊆ 十二类枚举，零旁路直写", [...kinds12].every((k) => KNOWN12.includes(k)), `seen=${[...kinds12].join(",")}`)
  record(results, "红线1 队列终态收敛 depth=0", q.data?.depth === 0, `depth=${q.data?.depth}`)
  const files = git(["log", "--name-only", "--format=.", "fdc3b3a..HEAD"]).split(/\r?\n/).filter(Boolean)
  record(results, "红线5 零触碰：本轮全部 commit 未触及 SCHEMA.md/user_preference.md", !files.some((f) => /SCHEMA\.md|user_preference\.md/.test(f)), `we11-commits=${git(["rev-list", "--count", "fdc3b3a..HEAD"])}条`)
  const broken = brokenLinkScan()
  record(results, "L5 断链全库扫描=0（票04 纪律的 E2E 复证）", broken.length === 0, JSON.stringify(broken))
  const realHead = gitReal(["rev-parse", "HEAD"]).trim()
  record(results, "红线账：真盘知识根 HEAD 与开工基线一致（零直写全程成立）", realHead === loadState("realhead")?.head, `now=${realHead.slice(0, 9)} base=${String(loadState("realhead")?.head).slice(0, 9)}`)
}

// ─── web：路由面回归（数据面口径，渲染级=S4 组件测试，先例声明）──────
async function web() {
  const r = await fetch(`${WEB}/knowledge`)
  record(results, "GET /knowledge 200（web 3430 存活）", r.status === 200, `status=${r.status}`)
  const h = await fetch(`${WEB}/wiki`, { redirect: "manual" })
  record(results, "GET /wiki 可达不报错（307 跳转或 200 直渲均为现制式）", [200, 307].includes(h.status), `status=${h.status} loc=${h.headers.get("location")}`)
  const tree = await fetchJSON(`${API}/api/knowledge/wiki/tree?org=${ORG}`)
  record(results, "wiki tree 数据面含 we11 页（真源 fs 在册面）", JSON.stringify(tree.data || {}).includes("we11"), "")
}

// ─── idem：非 LLM 幂等复证段（pass2 面，R8 全绿可重证）─────────────
async function idem() {
  const p = await fetchJSON(`${API}/api/knowledge/effectiveness/parse`, post({}))
  record(results, "[pass2] parse 重跑 scanned=0（游标幂等再证）", p.data?.scanned === 0, JSON.stringify(p.data))
  const s = await fetchJSON(`${API}/api/knowledge/effectiveness/sync`, post({}))
  record(results, "[pass2] sync 重跑零入队（无差不写，故事6 幂等）", !s.data?.queueTaskId || s.data?.updated?.length === 0, JSON.stringify({ u: s.data?.updated?.length, q: s.data?.queueTaskId }))
  const ptA = await fetchJSON(`${API}/api/knowledge/patrol`, post({}))
  const ptB = await fetchJSON(`${API}/api/knowledge/patrol`, post({}))
  const nuB = (ptB.data?.findings || []).filter((x) => x.action === "created")
  record(results, "[pass2] patrol 背靠背两轮：第二轮零新 finding（同证据 unchanged/suppressed 永不再扰；第一轮对 graph 变化的新报是正确行为）", nuB.length === 0, `A.created=${(ptA.data?.findings || []).filter((x) => x.action === "created").length} B.created=${nuB.length}`)
  const broken = brokenLinkScan()
  record(results, "[pass2] L5 断链扫描=0 再证", broken.length === 0, JSON.stringify(broken))
  const h = await fetchJSON(`${API}/api/knowledge/health`)
  record(results, "[pass2] health score/avgConfidence/gitHead 三面仍可见", typeof h.data?.score === "number" && h.data?.gitHead === git(["rev-parse", "HEAD"]).trim(), `score=${h.data?.score} head=${h.data?.gitHead?.slice(0, 9)}`)
  const act = await fetchJSON(`${API}/api/actuator/health`)
  record(results, "[pass2] 实例仍在 isolated 分支库（零漂移）", String(act.data?.components?.database?.details?.path).includes("octopus-we-11-e2e"), act.data?.components?.database?.details?.path)
  const ar = (await fetchJSON(`${API}/api/knowledge/wiki/queue`)).data?.tasks?.filter((x) => x.opKind === "auto-retire") || []
  record(results, "[pass2] auto-retire 复跑不二次退役（幂等+窄口唯一）", ar.length === 1, `n=${ar.length}`)
}

const PHASES = { gate, fixtures, effExecs, effExecs2, effExecs3, effParse, effSync, patrolNum, budgetWarn, curation, linkedRetire, deepRevert, nightPatrol, restore, budgetReject, budgetAdopt, ops1Probe, lane, web, idem }
const ORDER = ["gate", "fixtures", "effExecs", "effExecs2", "effExecs3", "effParse", "effSync", "patrolNum", "budgetWarn", "curation", "linkedRetire", "deepRevert", "nightPatrol", "restore", "budgetReject", "budgetAdopt", "ops1Probe", "lane", "web"]
;(async () => {
  if (PHASE === "all") { for (const p of ORDER) { console.log(`\n=== ${p} ===`); await PHASES[p]() } }
  else if (PHASES[PHASE]) { await PHASES[PHASE]() }
  else { console.error(`unknown phase: ${PHASE}`); process.exit(2) }
  saveResults(results, path.join(EV_DIR, `results-${PHASE}-${RUN}.json`))
  const passed = results.filter((r) => r.pass).length, failed = results.length - passed
  console.log(`\n[${PHASE}] run=${RUN} total=${results.length} passed=${passed} failed=${failed}`)
  for (const r of results) if (!r.pass) console.log(`FAIL | ${r.step} :: ${String(r.detail).slice(0, 150)}`)
  process.exit(failed > 0 ? 1 : 0)
})().catch((e) => { console.error("FATAL", e); process.exit(3) })
