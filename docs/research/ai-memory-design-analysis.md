# ai-memory 设计原则深度分析报告

> **研究日期**: 2026-08-17
> **研究对象**: [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory) — AI 编程 Agent 的长期记忆系统
> **研究目的**: 提炼 ai-memory 的核心设计原则，分析其对 Octopus 平台的启发与可迁移模式

---

## 执行摘要 (Executive Summary)

ai-memory 是一个用 Rust 编写的单二进制文件，为 AI 编程 Agent（Claude Code、Codex、Cursor、Gemini CLI 等 20+ 客户端）提供跨会话、跨 Agent 的长期记忆能力。其核心哲学源自 Andrej Karpathy 的 "LLM Wiki" 模式：**知识在摄入时编译，而非在查询时重新合成**。

通过对 README、ARCHITECTURE.md、design-decisions.md、research 文档、作者博客和 prior-art 分析报告的全面研究，本报告提炼出 ai-memory 的 **四项核心设计原则**（四项设计），并逐项分析其问题域、实现方式和权衡取舍，最后探讨对 Octopus 平台的具体启发。

---

## 1. 项目概述 (Project Overview)

### 1.1 解决什么问题

AI 编程 Agent 在会话结束时丢失所有上下文。当你关闭 Claude Code、打开 Codex 继续同一项目时，新 Agent 对项目架构、失败尝试、已做决策一无所知——用户被迫反复解释。

> "LLM coding agents lose context when a session ends. ai-memory gives them a shared, persistent wiki compiled from sanitized lifecycle observations."
> — [README.md](https://github.com/akitaonrails/ai-memory)

### 1.2 技术栈

| 层 | 选型 | 来源 |
|---|---|---|
| 语言 | Rust 1.95, edition 2024 | `rust-toolchain.toml` |
| 异步运行时 | tokio (full) | `AGENTS.md` |
| HTTP/MCP | axum 0.8 + rmcp 1.7 | `AGENTS.md` |
| 存储 | SQLite (WAL mode, bundled) + FTS5 | `docs/design-decisions.md §4` |
| Wiki | Markdown + git2 (vendored libgit2) | `docs/design-decisions.md §3` |
| 文件监听 | notify-debouncer-full | `AGENTS.md` |

### 1.3 架构概览

```
<data_dir>/
├── wiki/      # Markdown 真实来源，git 版本化
├── raw/       # 不可变的 sanitized 管理型工作流 JSONL 片段
├── db/        # SQLite 索引 (FTS5, entities, embeddings)
├── models/    # 预留本地嵌入模型目录
└── logs/      # rolling tracing 日志
```
— 来源: `docs/ARCHITECTURE.md`, README Architecture 节

9 个 crate 各司其职，无循环依赖:
```
ai-memory-core/         领域类型，无 IO
ai-memory-store/        SQLite + writer actor + reader pool + decay 数学
ai-memory-wiki/         原子 Markdown 写入 + file watcher + git
ai-memory-mcp/          rmcp 传输 + tool router
ai-memory-hooks/        事件 schema + sanitizer + /hook 入口
ai-memory-llm/          Provider auth 边界 + LlmProvider/Embedder trait
ai-memory-consolidate/  Karpathy ingest/lint/sweep/auto-improve 管道
ai-memory-workstream/   只读 native transcript + launch adapter
ai-memory-cli/          二进制入口 + thin HTTP 子命令
```
— 来源: `docs/ARCHITECTURE.md` Crate layout

---

## 2. 四项设计原则 (The Four Design Principles)

通过对项目所有文档的综合分析，ai-memory 的核心设计可归纳为 **四项设计原则**：

| # | 设计原则 | 一句话描述 |
|---|---|---|
| **D1** | **Markdown-in-git 为真实来源，SQLite 为派生索引** | 知识存储在人类可读、可 grep、可 Obsidian 打开的 Markdown 文件中，SQLite 仅加速检索 |
| **D2** | **自动 fire-and-forget 捕获，永不 `write_note`** | 生命周期 Hook 异步发射已消毒的有界观察，Agent 热路径永不阻塞 |
| **D3** | **编译而非检索 (Compile, not retrieve)** | Karpathy 模式：知识在摄入时编译为结构化 Wiki 页面，不在查询时从原始日志重新合成 |
| **D4** | **跨 Agent 交接作为一等协议** | 退出 Claude Code，打开 Codex，新 Agent 在第一个 prompt 前就看到 "where you left off" |

以下逐项深度分析。

---

## 3. 逐项深度分析

### 3.1 D1: Markdown-in-git 为真实来源，SQLite 为派生索引

#### 解决的问题

传统记忆系统将数据存在不透明的向量数据库或专有存储中，人类无法直接检查、编辑或版本化。ai-memory 需要同时满足：
- Agent 可以高效检索
- 人类可以用 Obsidian/vim 打开、用 `grep` 搜索、用 `git diff` 审查
- 备份/迁移只需 `git clone` 或 `rsync`

#### 三个备选方案及选择

| 方案 | 真实来源 | DB 用途 | 优势 | 劣势 |
|---|---|---|---|---|
| A. DB-primary | SQLite | 一切 | 单事务，快搜索 | 对人类不透明 |
| **B. Markdown-in-git** | **文件** | **派生索引** | **可 diff、可 grep、可移植** | **需要 watcher 协调** |
| C. DB-primary + 导出 | SQLite | 一切 | 两全其美 | 两种格式要保持一致 |

> **Decision: Option B — markdown in a git repo is source of truth, SQLite is derived index.**
> — `docs/design-decisions.md §3`

#### 代码实现

1. **Wiki 写入路径**: 所有写入经过 `Wiki::write_page` 或 `Wiki::apply_batch`，确保 sanitize、admission、attribution、rollback 和 store 更新同步完成
2. **原子文件写入**: tmp + rename + fsync，watcher 通过文件名前缀忽略自身写入
3. **git2 自动提交**: 每次 consolidation pass 和 session-end 都产生 git commit
4. **快速同步检查**: DB 存储 `(path, mtime, size, sha256, indexed_at)` 每个页面，启动时只重新解析变更文件
5. **一致性合约**: "markdown is primary and SQLite is derived. There is no real cross-resource transaction between the filesystem and SQLite."

— 来源: `docs/design-decisions.md §3`, `docs/ARCHITECTURE.md` Cross-cutting invariants #10

#### 如何避免 basic-memory 的 watcher 痛苦

- Watcher 有 heartbeat + 30s 全量 reconciliation pass
- 自有写入通过 MCP server 的 `wiki_write` 路径，watcher 只是外部编辑的安全网
- Inode-locking advisory + psutil-style live-process check
— 来源: `docs/design-decisions.md §3`

#### 权衡

- **优势**: 备份极其简单（`git push` wiki 目录 + `rsync` 数据目录），DB 可从文件重建，跨工具兼容（任何读取 markdown 的 Agent 都能工作）
- **劣势**: 需要处理文件系统与 DB 的一致性协调；watcher 实现复杂度高

---

### 3.2 D2: 自动 fire-and-forget 捕获，永不 `write_note`

#### 解决的问题

现有系统要么需要用户手动调用 `write_note`（basic-memory），要么 Hook 阻塞 Agent 会话启动（agentmemory #221）。ai-memory 的目标是：**开发者永远不需要记得保存上下文**。

#### 三个捕获层（按优先级）

1. **生命周期 Hook/Extension** — 自动、结构化、快速
2. **管理型工作流 transcript 导入** — opt-in 通过 `ai-memory run`
3. **手动 MCP tool** (`memory_write_page`) — 仅在用户明确要求 "记住这个" 时使用

— 来源: `docs/design-decisions.md §6`

#### 代码实现

**Hook 的 fire-and-forget 合约**:
```
Agent CLI → shell hook (curl POST, ≤200ms hard timeout)
         → Server /hook endpoint → 202 Accepted (or 429 when saturated)
```

- Hook 脚本硬超时 ≤200ms；server 立即返回 202 或在饱和时返回 429
- 原生 `ai-memory hook` 命令使用本地 spool + 稳定幂等键，不阻塞 Agent
- **隐私消毒在 Hook 边界执行**: `Sanitized<NewObservation>` 只有一个构造函数 `sanitize()`，之后无法绕过
- 内容限制: user prompts ≤16 KiB, tool excerpts ≤2 KB, 每个 sanitized body 有 16 KiB 硬上限

— 来源: `docs/ARCHITECTURE.md` Cross-cutting invariants #5 & #6, `docs/design-decisions.md §6`

**从 agentmemory 的教训**:
- Hooks 必须 fire-and-forget (#221)，不能 `await fetch()` 阻塞会话启动
- 隐私消毒在 hook 边界而非之后 (#stripPrivateData)
- 亚秒级超时 + server 排队 → 202 立即返回

— 来源: `docs/design-decisions.md §6`, `docs/research-agentmemory.md`

#### Capture Policy 边界

`.ai-memory.toml` 标记文件的 `[capture] ignore_paths` 在客户端 spool 之前丢弃匹配的文件工具事件——这是一个严格的词法边界，不是通用内容过滤器。
— 来源: `docs/design-decisions.md §6`, `docs/marker-file.md`

#### 权衡

- **优势**: 零用户摩擦，Agent 热路径无阻塞，隐私在入口消毒
- **劣势**: 不是完整的 native transcript（这是有意为之的设计约束）

---

### 3.3 D3: 编译而非检索 (Compile, not retrieve)

#### 解决的问题

> "Most people's experience with LLMs and documents looks like RAG: you upload a collection of files, the LLM retrieves relevant chunks at query time, and generates an answer. This works, but the LLM is rediscovering knowledge from scratch on every question. There's no accumulation."
> — Andrej Karpathy, `llm-wiki.md` gist (引用于 `docs/research-karpathy-llm-wiki.md §1`)

传统 RAG 在每次查询时从原始文档重新合成答案。Karpathy 的 LLM Wiki 模式主张：**在摄入时编译知识为结构化 wiki，查询时直接读取已编译的页面**。

#### 核心机制

1. **Ingest (摄入)**: 一个观察通常触及 **10-15 个 wiki 页面** — 更新实体页面、概念页面、决策日志、gotchas 页面
2. **Query (查询)**: FTS5 + 词法实体匹配 + 图邻居 RRF + 可选向量 RRF，之后进行有界的 authority 调整
3. **Lint (审查)**: 定期扫描矛盾、孤儿页面、断裂链接、过期声明

— 来源: `docs/research-karpathy-llm-wiki.md §2`, `docs/design-decisions.md §8`

#### 记忆分层模型 (Temporal Memory)

| 层级 | 含义 | 生命周期 | 衰减 |
|---|---|---|---|
| Working | 当前会话的最后 N 个观察 | 会话结束即丢弃 | 硬删除 |
| Episodic | 会话摘要 + 概念标签 | 30d 热 → 180d 冷 → 驱逐 | `salience · exp(−λΔt) + σ · log(1+access_count) · exp(−μ · days_since_access)` |
| Semantic | 蒸馏的事实/偏好/架构笔记 | 无限期，可被 supersession 替代 | 版本化替代 |
| Procedural | 从 episodic 集群提取的重复模式 | 无限期 | 频率衰减 |

— 来源: `docs/design-decisions.md §7`, `crates/ai-memory-store/src/decay.rs`

**衰减公式实现** (来自 `decay.rs`):
```rust
pub fn retention_score(params: &DecayParams, age_days: f64, ...) -> f64 {
    // salience · exp(−λ · age) + σ · log(1 + access_count) · exp(−μ · days_since_access)
}
```
默认参数: `lambda=0.02` (≈35天半衰期), `sigma=0.6`, `mu=0.04`, `cold_threshold=0.20`
— 来源: `crates/ai-memory-store/src/decay.rs`

#### 页面分类与 Supersession

Wiki 页面按 kind 分类: `concepts/` (持久知识), `decisions/` (架构决策), `gotchas/` (陷阱), `_rules/` (项目规则), `sessions/` (会话日志)

Supersession 链: 旧页面 `is_latest=false`, 新页面 `supersedes=old_id`。不是删除，而是版本化替代。
— 来源: `docs/ARCHITECTURE.md` Schema, `docs/design-decisions.md §7`

#### LLM 可选设计

- **零 LLM 模式**: FTS5 + 实体匹配 + 图邻居搜索 + 规则化摘要 → 系统完全可用
- **有 LLM 模式**: 额外获得 consolidation (页面重写)、lint (矛盾检测)、auto-improvement (自动改进)
- **Consolidation 用小模型**: 推荐 Claude Haiku 4.5 (每次 ~$0.02)，因为 "consolidation is summarisation, not hard reasoning"

— 来源: README §LLM Providers, `docs/design-decisions.md §5`

#### 权衡

- **优势**: 知识复利累积（cross-reference 已经建立，矛盾已经标记）；检索快速且可解释；人类可审查每一步
- **劣势**: 编译步骤需要 LLM（或退化为规则化摘要）；wiki 需要维护（但有 auto-improvement 和 curator）

---

### 3.4 D4: 跨 Agent 交接作为一等协议

#### 解决的问题

这是 ai-memory 的核心用例：**关闭 Claude Code，打开 Codex，新 Agent 在第一个 prompt 前就知道从哪里继续**。

agentmemory 的跨 Agent 交接是 "informal" 的（通过 `/handoff` skill），ai-memory 将其提升为一等类型化协议。
— 来源: `docs/design-decisions.md §9`, `docs/research-agentmemory.md §6`

#### 类型化 Handoff 结构

```rust
struct Handoff {
    from_agent: String,       // "claude-code", "codex"
    to_agent: Option<String>,
    project_id: ProjectId,
    cwd: PathBuf,
    summary: String,
    open_questions: Vec<String>,
    files_touched: Vec<PathBuf>,
    next_steps: Vec<String>,
    model: String,
    created_at: DateTime,
}
```
— 来源: `docs/design-decisions.md §9`

#### 状态机

```
open → accepted (by next agent)
     → expired (manually cancelled or superseded)
```

三个 MCP 工具:
- `memory_handoff_begin` — 创建 open 状态的 handoff
- `memory_handoff_accept` — 获取 + 确认最新 handoff
- `memory_handoff_cancel` — 标记错误创建的 handoff 为 expired

#### 关键设计决策

1. **cwd 路径边界匹配**: `/repo` 的 handoff 会传递给 `/repo/api` 的会话，但不会传递给 `/repo-other`
2. **手动优先于自动**: 手动 `memory_handoff_begin` 优先于自动 SessionEnd handoff
3. **原子过期**: 接受一个 handoff 原子地过期所有更老的同 cwd 同 owner 的候选项
4. **SessionEnd 自动创建**: 实质性会话结束时自动创建 handoff + 规则化摘要页面

— 来源: `docs/design-decisions.md §9`, `docs/ARCHITECTURE.md` Data flow step 3

#### 管理型工作流 (Managed Workstreams)

`ai-memory run` 提供更深层的跨 Agent 连续性:
- 一个逻辑 workstream 拥有每个 harness 的一个 native session + 一个 append-only 的便携事件账本
- **拒绝格式转换**: 不将 Claude transcript 转换为假的 Codex rollout — native store 包含私有、版本化状态
- **Renewable single-writer lease** 解决并发和优先级
— 来源: `docs/design-decisions.md §15`

#### 权衡

- **优势**: 真正的跨 Agent 无缝切换；handoff 是可审查的类型化数据
- **劣势**: 不同 Agent 的 hook 能力不同（如 Grok 忽略 SessionStart stdout，Zero 丢弃 hook stdout）

---

## 4. 代码架构概览 (Code Architecture Overview)

### 4.1 Single-Writer Actor 模型

所有 SQLite 写入经过一个 `mpsc` channel 到一个专用 OS 线程:

```
Hook/MCP/CLI → WriteCmd → mpsc channel → Writer Actor (dedicated thread)
                                              ├── SQLite WAL write
                                              ├── FTS5 trigger (same txn)
                                              └── wiki git commit
```

> "Single-writer SQLite actor. All writes go through one mpsc channel to one dedicated OS thread."
> — `docs/ARCHITECTURE.md` Cross-cutting invariants #2

这直接避免了 MemPalace 和 cognee 的主要故障类别：并行 SQLite 死锁、未协调的写入进程、ChromaDB/HNSW 损坏。
— 来源: `docs/prior-art-implementation-findings.md`

### 4.2 18 个 MCP 工具 (narrow on purpose)

对比: basic-memory 有 ~25 个工具，agentmemory 有 53 个。ai-memory 刻意保持狭窄的 18 个工具表面。

| 类别 | 工具数 | 示例 |
|---|---|---|
| 读取 | 7 | `memory_query`, `memory_recent`, `memory_read_page`, `memory_briefing` |
| 交接 | 3 | `memory_handoff_begin/accept/cancel` |
| 写入 | 5 | `memory_write_page`, `memory_consolidate`, `memory_feedback`, `memory_auto_improve`, `memory_delete_page` |
| 维护 | 2 | `memory_forget_sweep`, `memory_lint` |
| 元 | 1 | `memory_install_self_routing` |

> "basic-memory has ~25 tools, agentmemory has 53. Both have user confusion as a result."
> — `docs/design-decisions.md §10`

### 4.3 15 条 Cross-Cutting Invariants

这些是从 prior-art issue tracker 中提炼的 "不可违反规则"，每条都有具体的 bug 来源引用:

1. One config-read path (agentmemory #456)
2. Single-writer SQLite actor (cognee #2717)
3. Indexes commit in same txn as data (basic-memory #763)
4. Typed 3-tuple identity (basic-memory #783)
5. Hooks are fire-and-forget (agentmemory #221)
6. Privacy strip is a typed boundary (design-decisions §14)
7. JSON-schema structured outputs only (agentmemory #492)
8. `{provider, model, dim}` denormalised next to every embedding (agentmemory #469)
9. Live-process check before destructive ops (basic-memory #765)
10. Atomic file writes (tmp + rename + fsync)
11. Absolute canonical data dir default (agentmemory #303)
12. No global singletons / lazy_static configs (cognee #2228)
13. Zero-LLM default path
14. Provider auth resolves before provider construction
15. Tracing subscribers explicitly filter their own module (agentmemory #519)

— 来源: `docs/ARCHITECTURE.md` Cross-cutting invariants

### 4.4 检索管道

```
memory_query(q) →
  ├── FTS5 search (BM25 ranking)
  ├── Entity-match RRF (frontmatter noun index, ≤10/page)
  ├── Graph-neighbor RRF (wikilink cross-references)
  ├── [optional] Vector cosine RRF (when embedding provider configured)
  ├── RRF fusion
  ├── Bounded authority adjustment (kind/tier/pinned/tags multiplier)
  ├── [optional] LLM reranker (AI_MEMORY_RERANKER=llm, ≤1 call, 4 concurrent cap)
  └── [fallback] Raw observation FTS (when compiled wiki misses)
```
— 来源: `docs/ARCHITECTURE.md` Data flow step 6, `docs/design-decisions.md §8`

---

## 5. Prior Art 对比与设计影响

ai-memory 的设计深受四个先行项目的影响，且明确记录了从每个项目中 "采纳了什么" 和 "拒绝了什么"：

| 项目 | 采纳 | 拒绝 | 来源 |
|---|---|---|---|
| **Karpathy LLM Wiki** | 编译而非检索模式；wiki-on-disk；三种操作 (ingest/query/lint) | 人工管理（ai-memory 自动化） | `docs/research-karpathy-llm-wiki.md` |
| **agentmemory** | 四层记忆模型；supersession；retention 公式；hybrid retrieval | iii-engine sidecar；KV 存储；XML 解析；53 个工具 | `docs/research-agentmemory.md` |
| **basic-memory** | Markdown-on-disk 真实来源；人类可编辑 | 手动 `write_note`；脆弱的 file watcher | `docs/research-basic-memory.md` |
| **cognee** | Pipeline composition；triplet embeddings | 多 store 编排；LiteLLM/Instructor 脆弱性 | `docs/research-cognee.md` |
| **Hermes Agent** | Self-improvement loop；approval gates；curator boundaries | Agent-local skill 系统 | `docs/auto-improvement-loop.md` |
| **A-MEM** | Zettelkasten 原子笔记 + link evolution | — | README §Influences |

— 来源: README §Influences and prior art, 各 research 文档

---

## 6. 对 Octopus 平台的启发 (Implications for Octopus)

### 6.1 Agent Memory 系统改进

Octopus 当前有 Agent 记忆系统（SQLite FTS + session summaries + memory retention）。ai-memory 的设计提供了以下具体改进方向:

#### 6.1.1 Karpathy 编译模式 vs 当前的 raw log 检索

**现状**: Octopus 的 agent memory 主要存储 session summaries，检索依赖 FTS。

**启发**: 引入 "编译" 层 — 在 session 结束时，将原始观察编译为分类页面 (`decisions/`, `gotchas/`, `concepts/`)，而非仅存储摘要。这让知识可复利积累。

**集成点**: 可在 `@octopus/engine` 的 agent executor 完成后触发一个 "compilation" 步骤，将 session 日志编译到 agent 的 wiki 空间。

#### 6.1.2 记忆衰减公式

**现状**: Octopus 有 memory retention 但衰减模型较简单。

**启发**: 采用 agentmemory 风格的 retention 公式:
```
score = salience · exp(−λ · age) + σ · log(1 + access_count) · exp(−μ · days_since_access)
```
参数可调（`lambda=0.02`, `sigma=0.6`, `mu=0.04`），让经常被查询的记忆存活更久，无人问津的记忆自然衰减。

**集成点**: 在 `@octopus/engine` 的 agent memory 表中添加 `salience`, `access_count`, `last_accessed_at` 列，实现 `decay.rs` 等效逻辑。

#### 6.1.3 Typed Handoff 协议

**现状**: Octopus agent clone 可以合并结果，但没有显式的 "上一个 session 的交接" 概念。

**启发**: 引入类型化的 `Handoff` 结构：
```typescript
interface AgentHandoff {
  fromSessionId: string;
  agentId: string;
  summary: string;
  openQuestions: string[];
  filesTouched: string[];
  nextSteps: string[];
  state: 'open' | 'accepted' | 'expired';
}
```
当新 session 启动时，自动注入最新的 open handoff 到 agent context。

**集成点**: 在 `@octopus/engine` 的 agent session 创建流程中检查 pending handoff，注入到 system prompt。

#### 6.1.4 3-Tuple Identity 隔离

**现状**: Octopus 有 workspace 概念但可能缺少严格的 `(workspace, project, path)` 三元组隔离。

**启发**: ai-memory 的 "从第一天起就强制 3-tuple identity" 避免了 basic-memory 后来的 retrofit 痛苦。Octopus 的 agent memory 可以在 schema 层强制 `(workspace_id, project_id, session_id)` 隔离。

### 6.2 工作流引擎改进

#### 6.2.1 Fire-and-Forget Hook 模式

**现状**: Octopus 工作流有 7 种执行器，但 hook/notification 机制可能阻塞执行。

**启发**: ai-memory 的 hook 设计: ≤200ms hard timeout, 202/429 response, agent 热路径永不阻塞。Octopus 的 Workflow Hook（如 Hermes 通知）应采用同样的 fire-and-forget 模式。

**集成点**: `@octopus/engine` 的 HookExecutor 或 NotifyNode 应实现 bounded timeout + 饱和退避。

#### 6.2.2 Single-Writer Actor 模式

**现状**: Octopus 使用 SQLite 作为工作流状态存储。

**启发**: ai-memory 的 single-writer actor (所有写入经过一个 mpsc channel 到一个专用线程) 直接避免了并发写入导致的 SQLite 死锁和 FTS5 损坏——这是 MemPalace 和 cognee 的主要故障类别。

**集成点**: `@octopus/engine` 的 SQLite 写入路径可以考虑引入 writer actor 模式，特别是高并发工作流执行场景。

#### 6.2.3 Auto-Improvement 循环

**现状**: Octopus 有 `octo-agent-evolution` skill 用于 SKILL self-improvement。

**启发**: ai-memory 的 auto-improvement 是一个后台调度器，对新完成的 session 进行 review，提出 wiki 编辑提案，经过 approval gate 后应用。关键设计:
- 调度和审批是分离的 (`scheduler.enabled` vs `require_approval`)
- Proposal 有 immutable target snapshot + append-only decision events
- 不与活跃 agent context 竞争

**集成点**: 可以在 Octopus scheduler 中添加 "agent memory review" 类型的 scheduled job。

### 6.3 可迁移的架构模式

| ai-memory 模式 | Octopus 迁移方向 | 复杂度 |
|---|---|---|
| **Typed Sanitizer Boundary** (`Sanitized<T>` 只有一个构造函数) | Agent 输入的消毒层 — 确保 untrusted observation 不携带 secrets | 中 |
| **Entity-Assisted Recall** (frontmatter entities → RRF) | Agent memory 的页面分类 + 关键词索引，增强 FTS 检索精度 | 低 |
| **Authority-Aware Retrieval** (rules/decisions 优先于 episodic) | 工作流变量解析时，"pinned" 变量优先于临时变量 | 低 |
| **Supersession Chain** (is_latest + supersedes) | 工作流执行日志的版本化 — 允许 "重跑" 时保留历史 | 中 |
| **Zero-LLM Fallback** (系统在有/无 LLM 时都可用) | Octopus 工作流的 graceful degradation — LLM 节点失败时回退到规则化路径 | 低 |
| **Narrow Tool Surface** (18 tools vs 53) | Agent skill 设计：少而精，每个 skill 必须 "earn its slot" | 设计约束 |

### 6.4 具体集成方案

**短期 (可直接实施)**:
1. **Agent session 结束时编译结构化知识页面** — 在 `@octopus/engine` 的 agent session close 逻辑中，将 session 摘要分类为 decisions/gotchas/concepts
2. **添加 memory decay 参数** — 在 agent memory 表中增加衰减相关字段
3. **SessionStart handoff injection** — 新 session 启动时检查并注入 pending handoff

**中期 (需要 schema 变更)**:
4. **Single-writer actor for workflow state** — 重构 SQLite 写入路径
5. **Typed handoff table** — 新增 `agent_handoffs` 表
6. **Entity index for agent memory** — 从 memory 页面提取关键词构建 RRF 检索流

**长期 (架构级变更)**:
7. **Karpathy Wiki 模式完整实现** — 为每个 Octopus workspace 维护一个编译中的 knowledge wiki
8. **Cross-workspace knowledge graph** — 跨 workspace 的 wikilink + graph-neighbor retrieval
9. **Auto-improvement scheduler** — 后台 review agent session，提出知识改进提案

---

## 7. 建议的后续步骤 (Recommended Next Steps)

### 7.1 立即可做

1. **阅读 ai-memory 的 `decay.rs`** (`crates/ai-memory-store/src/decay.rs`) — 60 行纯函数代码，可直接参考实现 Octopus 的 memory retention 公式
2. **研究 Handoff 结构** — `docs/design-decisions.md §9` 的 Rust struct 可直接翻译为 TypeScript interface
3. **评估 Octopus agent memory schema** — 对照 ai-memory 的 `pages` 表 schema (M8 columns: `last_accessed_at`, `access_count`, `salience`)

### 7.2 设计阶段

4. **RFC: Agent Memory Compilation** — 提议在 agent session 结束时触发知识编译步骤
5. **ADR: Single-Writer Pattern** — 评估 Octopus 当前 SQLite 并发写入的风险级别
6. **ADR: Typed Handoff Protocol** — 设计 Octopus 版本的 Agent 交接协议

### 7.3 实施优先级

| 优先级 | 改进项 | 预期收益 | 实施成本 |
|---|---|---|---|
| P0 | Memory decay formula | 自动遗忘低价值记忆，减少噪音 | 低 (纯数学) |
| P1 | Typed handoff | 跨 session 连续性，减少重复解释 | 中 (schema + injection) |
| P1 | Entity-assisted recall | 检索精度提升 | 中 (index + RRF) |
| P2 | Knowledge compilation | 知识复利积累 | 高 (需要 LLM pipeline) |
| P2 | Single-writer actor | 消除并发写入风险 | 高 (架构重构) |

---

## 8. 引用来源 (Source Citations)

### 本地文件 (ai-memory 仓库 `C:\MiYuan\github\ai-memory`)

| 文件 | 引用内容 |
|---|---|
| `README.md` | 项目概述、Support Matrix、Key features、Architecture、Influences |
| `docs/ARCHITECTURE.md` | Data flow, Schema, Crate layout, Cross-cutting invariants, MCP tools |
| `docs/design-decisions.md` | §1-§15 全部设计决策、prior art 分析、mistakes-to-avoid checklist |
| `docs/research-karpathy-llm-wiki.md` | Karpathy LLM Wiki 模式研究 |
| `docs/research-agentmemory.md` | agentmemory 架构分析和采纳/拒绝决策 |
| `docs/auto-improvement-loop.md` | Hermes Agent 启发的 auto-improvement 设计 |
| `docs/prior-art-implementation-findings.md` | 四个 prior art 的对比分析 |
| `docs/issues-mempalace.md` | MemPalace 故障模式分析 |
| `crates/ai-memory-core/src/lib.rs` | 领域类型结构 |
| `crates/ai-memory-store/src/decay.rs` | 衰减公式实现 |
| `AGENTS.md` | 项目技术栈和贡献者指南 |
| `CONTRIBUTING.md` | 工作流规则和 cross-cutting invariants |

### 网络来源

| URL | 引用内容 |
|---|---|
| [akitaonrails.com - ai-memory long-term memory](https://akitaonrails.com/en/2026/06/16/ai-memory-long-term-memory-karpathy-wiki-self-improvement-hermes-projects/) | 作者的设计哲学和设计原则 |
| [thecrazyalpaca.com - Cross-Agent Memory](https://thecrazyalpaca.com/blog/cross-agent-memory-ai-memory-persistent-context-claude-code-codex-cursor) | 设计哲学总结、架构决策表、关键引述 |
| [Karpathy - llm-wiki.md gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | "Compile, not retrieve" 的原始论述 |
| [GitHub - akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory) | 项目主页 |

---

## 附录: 关键引述

> "Agent memory is text. Text lives on disk. You index it with SQLite. You compile with an LLM when the work is worth it. You forget what nobody looks at anymore. You stay out of the way."
> — akitaonrails 博客 (引用于 thecrazyalpaca.com 文章)

> "Consolidation is text in, text out... No complex reasoning, no code."
> — akitaonrails 博客

> "basic-memory has ~25 tools, agentmemory has 53. Both have user confusion as a result."
> — `docs/design-decisions.md §10`

> "Bad Memory Is Worse Than No Memory."
> — akitaonrails 博客 — 关于 auto-improvement 的安全边界

> "The wiki is a persistent, compounding artifact. The cross-references are already there. The contradictions have already been flagged."
> — Andrej Karpathy, llm-wiki.md gist (引用于 `docs/research-karpathy-llm-wiki.md §1`)
