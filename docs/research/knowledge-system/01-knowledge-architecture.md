# 01 — 知识系统架构

## 1. 存储层级

两层**同时生效**，全局提供通用规则，Org 级提供组织特定规则。

```
~/.octopus/
├── knowledge/                           ← 全局级（跨 org 共享）
│   ├── user_preference.md               ← 通用偏好（编码习惯、模型偏好）
│   └── index.md                         ← 全局规则索引
│
└── {org}/
    └── knowledge/                       ← Org 级（组织特定）
        ├── user_preference.md           ← Org 偏好（拼接在全局之后，同名条目覆盖）
        ├── index.md                     ← Org 规则索引
        ├── {project-a}.md               ← 项目 A 的规则
        ├── {project-b}.md               ← 项目 B 的规则
        ├── workflow-prd-impl.md         ← 工作流级规则
        └── workflow-bug-hunter.md       ← 工作流级规则
```

**合并规则**（详见 [08-data-flow.md §5](./08-data-flow.md)）：
- **user_preference.md**：全局 + Org 内容拼接注入，Org 同名条目覆盖全局
- **知识文件**：全局和 Org 各自独立，注入时都读
- **index.md**：全局和 Org 各自维护，注入时合并查询
- **写入默认到 Org 级**，除非用户显式标记 `scope: 'global'`

## 2. 文件格式

### 2.1 user_preference.md

用户手动维护 + AI 辅助编辑。**永不被 LLM 自动修改**。

```markdown
# 用户偏好

> 手动维护。Agent 执行时永远注入此文件的全部内容。
> 可通过 Dashboard 知识 Tab 或 Agent 对话编辑。

## 项目阶段
- 当前 octopus 项目在快速功能迭代阶段，没有 release
- 不考虑安全性、用户登录鉴权等功能
- 优先保证功能可用，代码质量次之

## 环境
- 测试默认用 uat01 环境
- 本机 GITLAB_TOKEN = xxx（仅内部使用）
- 不同 JDK 项目：mvn=jdk21, mvn_jdk8=jdk1.8, mvn_jdk17=jdk1.7

## 工具链
- 已安装 glab cli 和 gh cli，根据 git 仓库自动选择
- 构建命令: pnpm build
- 测试命令: pnpm test

## 常用项目
- xzf-dev/octopus — AI 工作流编排平台
- xzf-dev/agency-agents-zh — 中文 Agent 角色库
```

### 2.2 index.md

程序维护的轻量索引。**Agent 先读 index 判断相关性，再读详情文件**。

```markdown
# 知识索引 — xzf-dev

## 统计
项目知识: octopus (12 条) | agency-agents-zh (3 条)
工作流知识: prd-impl (8 条) | bug-hunter (5 条)
最近更新: 2026-06-29

## 规则条目

| ID | 文件 | 摘要 | 来源 | 日期 | 状态 |
|----|------|------|------|------|------|
| oct-007 | octopus.md | Promise.allSettled 聚合必须设全局超时 | prd-impl | 2026-06-23 | active |
| oct-008 | octopus.md | stale 检测一律用 updated_at | prd-impl | 2026-06-23 | active |
| oct-009 | octopus.md | actuator 端点用 TCP remoteAddress | prd-impl | 2026-06-23 | active |
| oct-001 | octopus.md | 修改 shared/ 后先 build shared | prd-impl | 2026-06-25 | active |
| bh-001 | workflow-bug-hunter.md | scan 节点 Grep 优先再 Read | bug-hunter | 2026-06-26 | active |
```

### 2.3 {project}.md

项目级规则。**从执行中提取 + 人审核后累加**。

格式约定：
- 每条规则一行，`- ` 开头
- 规则后跟 HTML 注释标注来源和日期（对人可见，注入时 LLM 忽略）
- 按 `## 分类` 分组
- HTML 注释中的 `id` 是该规则的稳定标识（用于 index.md 引用）

```markdown
# 项目知识: octopus

## 构建规则
- 修改 shared/ 后必须 `pnpm build -w shared` 再全量构建 <!-- id:oct-001 | 2026-06-25 | prd-impl -->
- 构建命令: `pnpm build` <!-- id:oct-002 | 2026-06-23 | prd-impl -->
- 启动隔离服务: `pnpm dev --isolated`（自动分配 hash 端口） <!-- id:oct-003 | 2026-06-23 | prd-impl -->

## 测试
- 运行: `pnpm test` <!-- id:oct-004 | 2026-06-23 | prd-impl -->
- git-ops.test.ts 有已知环境相关失败，与代码改动无关 <!-- id:oct-005 | 2026-06-23 | prd-impl -->
- 创建 actuator 测试时，必须在 setup 中导入完整 DAO 依赖链 <!-- id:oct-006 | 2026-06-23 | prd-impl | blocker-B1 -->

## 已知陷阱
- Promise.allSettled 聚合调用必须设全局超时 <!-- id:oct-007 | 2026-06-23 | prd-impl | blocker-B4 -->
- stale 检测一律用 updated_at（不是 started_at） <!-- id:oct-008 | 2026-06-23 | prd-impl | blocker-B3 -->
- actuator 端点不能仅依赖 x-real-ip 做 localhost 判断 <!-- id:oct-009 | 2026-06-23 | prd-impl | security-W1 -->

## 端口规则
- ⛔ 保护端口: 3000, 3001, 3098, 3099 <!-- id:oct-010 | 2026-06-23 | prd-impl -->
- 只允许 `kill $vars.e2e_dev_pid` 杀 e2e 服务进程 <!-- id:oct-011 | 2026-06-23 | prd-impl -->
```

**规则 ID 规则**：`{项目缩写}-{序号}`，如 `oct-001`。序号递增，不复用。

### 2.4 workflow-{name}.md

工作流级规则。跨项目共享（同一个工作流在不同项目上跑的经验）。

```markdown
# 工作流知识: prd-impl

## 实现阶段
- 拆分为 P1-P5 子阶段提交，每阶段独立 commit
- implement 节点通常 30+ 分钟，是最大的 token 消耗点
- P1 基础框架和 P2 详细诊断是最重要的阶段

## 审查阶段
- review 通常发现依赖注入和超时相关问题
- 如果实现阶段遵守已知规则，可以避免大部分 blocker

## E2E 阶段
- E2E 修复通常 1 轮即通过
- TC 都是 api_response/cli_output/file_content 类型
  （infrastructure 项目无 UI）
```

## 3. 格式选择：为什么用 Markdown 不用 JSON/YAML

| 需求 | JSON/YAML | Markdown |
|------|-----------|----------|
| 加一条规则 | 改 schema → 改序列化 → 改所有读写方 | 追加一行文本 |
| LLM 理解 | 需要解析结构 | 原生理解 |
| 人编辑 | 需要工具 | 任何文本编辑器 |
| 规则表达 | 字符串值，不自然 | 祈使句，天然适合 |
| 版本控制 | diff 不友好 | diff 清晰 |
| 注入 prompt | 需要模板渲染 | 直接拼接 |

**结论**：知识文件用 Markdown。归档记录（execution_archive 表）继续用 SQL，只存指标数据。

## 4. 与现有系统的边界

```
┌── Agent 认知层 ──────────────────────────────────┐
│                                                   │
│  Memory (已有)                                    │
│    daily/*.md — 每次对话自动写入                   │
│    long-term.md — session-compress 定期压缩        │
│                                                   │
│  Knowledge (新)                                   │
│    user_preference.md — 手动 + AI 辅助            │
│    {project}.md — extractRules + 人审核            │
│    index.md — 程序维护                            │
│                                                   │
│  SKILL (已有, 扩展)                               │
│    SKILL.md — 已有 skill 库                       │
│    experiences/ — 已有经验记录                     │
│    + 新增: Skill 化审批流程 (见 04 章)             │
│                                                   │
└───────────────────────────────────────────────────┘
```

**Memory vs Knowledge 的区分**：
- Memory 记录"2026-06-23 prd-impl 执行发现 4 个 blocker"（事件）
- Knowledge 记录"Promise.allSettled 必须设全局超时"（规则）
- 事件是时间绑定的，规则是 timeless 的
