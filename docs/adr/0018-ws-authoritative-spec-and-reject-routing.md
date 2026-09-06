# 0018 — ws 权威 spec 环 + spec 家族文件名约定 + 打回二分路由

## 状态

Accepted（2026-09-05）· 部分修订 ADR-0011 的 spec 权威句（登记不搬迁框架不变）

## 背景

v4 任务（phase 化）上线后暴露四个问题：

1. **命名误导**：task home 的 `{home}/spec.json` 实为 task_spec 的**元数据快照**（format / phases 绑定 / decisions），与各 phase 真正的规格文档 `spec.md` 撞名；且快照文案残留 goal/ac（v3 面）。
2. **缺规格直执行流**：内置 coding 流中 `matt-dev-pipeline` 收 `idea` 并在 workspace 内**重新澄清 + 再生成 spec**（不消费 phase.specPath）；`task-dev`/`superpowers-task-dev` 收 goal/ac；唯一直读批次目录的是 `task-fix`。已冻结的 spec.md+issues/ 没有对应的正向执行流。
3. **打回换流不可表达**：信封 phases[] 入队冻结（K16）；打回后下一 round 只重跑同一 workflowRef + 字符串注入 feedback；验收弹窗的「修复流 / round-2 spec」推荐卡（D13①）是 disabled 假占位，文案还谎称默认走修复流。
4. **spec 修订权威错位**：#56 定的是「home 权威、ws 乱改不回流」。实践需要相反语义——验收打回或执行中重大决策时，**修订发生在执行侧（ws）**，home 应随回流更新为终态；「task 空间里的 spec.md 跟着变」。

## 决策

### 1. `spec.json` → `manifest.json`

- server 端 `writeManifestFile` / `writeManifestSnapshot` / `GET /:id/context` 响应字段 `manifestContent/manifestPath`；文件名收敛到 `MANIFEST_FILENAME` 单源（消灭 /context 路由硬编码二源）。
- **v4 快照过滤**：`format==="v4"` 时写出剔除 v3-only schema 默认键（`goal/ac/goal_confirmed/ac_confirmed/subunits/integration_goal/input_values/workflow_ref/task_type`）——仅写侧，DB 镜像语义让位给「清单只放活字段」。
- **懒迁移，无 boot 扫描**：快照写回时删除 legacy `spec.json` 并刷新静态 rules 指针；`ensureRulesFile`（每 chat turn）带 stale-marker 自愈 + rename 迁移；`GET /:id/context` 对只有 spec.json 的旧 home 读回退。context.md 每轮 chat 已由路由重写，无需处理。
- 注记：org 仓库注册表另有 `manifest.json`（`~/.octopus/orgs/{org}/repos/`），目录不同名不同义，不改名不合并。

### 2. spec 家族 = 文件名约定（零 schema 类型位）

批次目录 `{home}/.scratch/<date>/<slug>/`（ws 同构位）：

| 文件 | 语义 | 写方 / 流向 |
|---|---|---|
| `spec.md` | **唯一活文档**。入队前草稿初版；入队后 ws 终态 | 草稿侧→home→seed；执行侧→ws→collect |
| `spec-rN.md` | 起草窗口的整版修订（并存，K8 行稳定） | 草稿侧；流取「最大 rN 否则 spec.md」为底本 |
| `fix-feedback-rN.md` | 打回反馈（N=被打回轮） | server 产物化；home→seed 下行 |
| `fix-report-rN.md` | task-fix 输出 | 执行侧；ws→collect 上行 |
| `round-report.md` | matt-spec-dev 每轮终报（含「Spec 修订」节） | 执行侧；ws→collect 上行 |

类型不进 DB：server 从不解释 spec 内容；UI 用 `GET /:id/home-file?path=&list=1`（新增 dir-mode 守卫，`.scratch/**` 限深 ≤2 仅 .md）枚举批次目录呈现分组徽章。**修订形态定为「就地改 spec.md」**（不引入 fix-spec delta 层）——spec.md 永远是最新版，修订史记在 round-report / fix-report。

### 3. `collect` 全类回流（唯一 server 代码反转）

`task-artifact-sync.ts` 删除 `HOME_AUTHORITATIVE_RE` 跳过分支：批次目录内所有文件（含 `spec*.md`）统一「ws mtime 严格新 → 回流 home」。seed（home→ws 覆盖 + mtime 保留）不变——home 自此语义为**上轮终态镜像 / 草稿起点**，而非权威。已知代价：abort 清 ws 丢失未 collect 的本轮修订（终态只在 round terminal 产生，接受）。

### 4. 新内置流 `matt-spec-dev`（规格直执行）

- inputs：`batch_dir`（必填，绑 `${phase.batch_rel}`——新占位符 = home 相对 posix 批次目录 = ws 同构位）+ `task_artifacts_dir`（管理键自动注入）。
- 节点：`spec-resolve`（bash 确定性核对 + 底本定位 + 反馈探测，fail-fast）→ `spec-review`（agent，仅反馈轮：在 ws 就地更新 spec.md，K8 行稳定，修订点记 round-report）→ `ticket-dag`（票 DAG，普通票 skills implement+tdd，末张 NN-e2e-* 票走 matt-e2e-test-methodology+e2e-harness）→ `integration-gate` → `code-review` → `integration-verify` → `ship-pr`。
- **零澄清、零 spec 再生成、零内部 loop / approval**——人是唯一 gate（验收）。`matt-dev-pipeline` 保留给「从 idea 现场澄清」场景；v4 phase 默认推荐 matt-spec-dev。
- **安装注记**：`registerBuiltins()` 只登记不拷文件、`pnpm build`/sync-builtin 不覆盖 workflows——新流须 `octopus setup` 落 `~/.octopus/resources/installed/workflows/built-in/`。

### 5. 打回二分路由（round 级 override，人裁决）

- `POST /:id/acceptance` body 增 `next_flow?: "fix" | "rerun"`（缺省 `rerun`=现行为，零回归）：
  - `rerun`：重跑 phase 绑定流 + feedback 注入；绑 matt-spec-dev 时其 `spec-review` 段兑现「修订重跑」（ws 内先再审 spec）。
  - `fix`：`workflow_chain[0]` override `built-in/task-fix`，输入由 server **合成**（`phase_spec_dir`/`feedback_path` 指向 ws 同构批次位与本轮反馈——task-fix 起草期永远不绑，绕开 gate 必填死结）。
- override 只进 `workflow_chain`（持久化 ⇒ 崩溃 re-claim 可复现），**信封 phases[] 冻结不破（K16）**——后续重开 round 回到绑定流。
- 派生轮次视图带上实际执行流（`DeriveExecutionInput` 增采 `workflow_ref`），验收弹窗 disabled 假卡（D13①）替换为真 radio + 提交后路由回显。
- **不做**（v4.1）：D14 影响清单数据源、信封 phases[] resync、artifacts.json 自动登记。

### 6. 纪律载体 = SKILL / persona / 流提示词，不是 server 代码

写权环三段制、就地修订台账、路由话术、绑定推荐（matt-spec-dev + `${phase.batch_rel}`）全部落 `task-author` SKILL.md、`TASK_AUTHOR_PERSONA`、两流 YAML 提示词；server 只持有机械不变量（gate 存在性/可解析性、override 持久化、mtime 回流）。

## 后果

- 正面：manifest 名副其实；spec 终态跟执行走，验收人经 round-report「Spec 修订」节 + 批次清单 diff 看住漂移；换流能力出现且 K16 冻结不破；内置目录有了 spec-native 正向流，matt 方法论闭环（起草 spec → 直执行 → 打回再审）。
- 负面：agent 乱改 spec 不再被 home 兜底（防线移到人工验收）；`matt-dev-pipeline` 存量绑定打回 rerun 仍会重走澄清（文档标注反模式）；旧 home 文案自愈依赖 chat turn / 快照写触发。

## 附：同批修复（未入 ADR 本体）

- Windows 冒号缺陷：`createFromSpec` 目录名单独 sanitize（`workspaces.name` 展示名保留 `task:` 前缀）；workspace/v4 测试族补假 `USERPROFILE`（`os.homedir()` Windows 读它，基线 62 红的另一半根因）。
