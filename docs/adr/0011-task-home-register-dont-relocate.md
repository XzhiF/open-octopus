# 任务家目录约定 + 登记不搬迁（产物收集策略）

## 状态
Accepted（§3 执行期物化保留）；**spec 回流权威部分被 [ADR-0018](0018-ws-authoritative-spec-and-reject-routing.md) 修订**：v4 批次目录内 `spec*.md` 改为 ws 侧权威、collect 全类回流 home（home=终态镜像）；「登记不搬迁」框架与 artifacts 索引机制不变。

## 背景

Skill 组产出的文件（spec.md / proposal.md / stories…）需要被 UI 展示、被后续执行阶段读取。难点：

- task-author clone 的 cwd 是 `~/.octopus/agent/built-in/task-author/`（agent 家目录，不是项目，git 不追踪）
- 第三方 skills 在 SKILL.md 中写死产物路径（如 open-spec → `openspec/changes/`），system prompt 强制改道不可靠
- 编写期任务可能尚未绑定具体项目仓库，`{repo}/.scratch/` 无处可写

## 决策

### 1. 任务家目录（约定，不加 DB 字段）

每个 task 由 id 直接推出家目录：

```
~/.octopus/tasks/{task-id}/
├── skills/            ← per-task plugin 目录（ADR-0010）
└── artifacts/
    ├── ...            ← octopus 原生 skill 产物直接写这里
    └── artifacts.json ← 产物索引
```

- system prompt 注入一行绝对路径：`本任务产物目录: ~/.octopus/tasks/{id}/artifacts/`
- author agent cwd 不变，Write 用绝对路径
- draft 删除时 reap 整个家目录

### 2. 登记不搬迁（register, don't relocate）

- **octopus 原生 skills**（可控）→ 直接写统一 artifacts/ 目录
- **第三方 skills**（写死路径）→ 留在原生位置，完成后把 `{path, by, title, external: true}` 登记进 `artifacts.json`
- UI / 调度器只读索引，不关心物理位置

### 3. 执行期物化

task_dispatch 物化到项目仓库后，执行期产物写 `{repo}/.scratch/task-{slug}/`（git 可追踪，符合现有 `.scratch/<feature>/` 惯例）；家目录索引保留编写期记录。

## 后果

### 正面
- 零 DB schema 变更（路径由 id 推出）
- 不与第三方 skill 的产物约定对抗，可靠性高
- 编写期/执行期两阶段各有合适的存储位置
- 索引是单一事实来源，UI 渲染与产物位置解耦

### 负面
- 产物物理位置分散（统一索引弥补）
- 家目录 reap 需要与 draft 删除路径联动（orphan reaper 兜底，SG12 模式）
- external 产物依赖 agent 如实登记（persona 指令约束 + artifacts.json 校验）

## 替代方案

### 方案 A: system prompt 强制统一目录
对第三方 skill 不可靠，每个 skill 定制提示词维护成本高。

### 方案 B: 事后扫描收集
不知道去哪扫、扫出什么算本任务产物。弃用。

### 方案 C: tasks 表加 artifacts_dir 字段
路径可由 id 确定性推出，字段是冗余。除非未来需要自定义位置，不引入。
