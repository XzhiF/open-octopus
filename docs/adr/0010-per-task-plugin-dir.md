# Per-Task Plugin 目录：Skill 组的 SDK 原生加载

## 状态
Accepted

## 背景

Task authoring v3 引入 **Skill 组**（方法论套件，如 open-spec / mattpocock-skills），安装于 ResourceManager 路径 `~/.octopus/resources/installed/skills/{group}/...`。该路径**不在** Claude Agent SDK 的 plugin 扫描范围内（ADR-0006 的扫描目录是 `~/.octopus/agent/` + clone 目录）。

现状机制 `TaskAuthorSessionAugmenter` 把 `tasks.authoring_resources[]` 指向的 SKILL.md **全文**每轮注入 systemPrompt.append：token 膨胀、无 Skill 工具语义、无 /slash 命令、组内关联 skills 不可发现。

## 决策

为每个 task 建立 **per-task plugin 目录** `~/.octopus/tasks/{task-id}/skills/`：

1. 用户在新建任务时选定 Skill 组（可多选，创建后锁定）
2. Server 在 draft 创建时把所选组的 skills 从 `resources/installed/` **symlink**（Windows 用 junction，失败降级为 copy）进任务 plugin 目录
3. `CloneRuntime.getPlugins()` 对 task-author 会话追加第三个 plugin 路径（该 task 的目录）
4. SDK 原生机制接管：frontmatter(name+description) 进 system prompt → Skill 工具按需注入全文 → /slash 命令原生可用 → 组内关联 skills 同目录自动可发现

选组锁定于创建时（见 ADR-0012），因此 plugin 目录在会话生命周期内不变，无 session 中途变更问题。

## 后果

### 正面
- Skill 组获得与共享 skills 完全相同的 SDK 原生待遇（渐进式披露，零全文注入）
- 关联 skills 免费解决（同目录即可被 Skill 工具发现）
- 未选组零 token 开销
- `authoring_resources` 全文注入机制保留为兜底（非 plugin 场景）

### 负面
- 文件系统新增 symlink/junction（Windows 需降级路径）
- draft 删除时需 reap 任务目录（与 task home 约定一并处理，见 ADR-0011）
- plugin 数量随任务增长（每会话最多 3 个 plugin，无实质压力）

## 替代方案

### 方案 A: 全文注入（现状 authoring_resources）
每轮把 SKILL.md 全文 append 进 system prompt。token 膨胀，无 Skill 工具语义。保留为兜底而非主路径。

### 方案 B: 手写摘要索引 + 提示 Read
system prompt 注入「名称+描述+路径」表，提示 agent 按需 Read。可行但偏离 SDK 原生机制：无 Skill 工具、/slash 需前端模拟、索引需自己维护。

### 方案 C: 复制进共享 skills 目录
污染全局目录，组的选择无法按任务隔离，弃用。
