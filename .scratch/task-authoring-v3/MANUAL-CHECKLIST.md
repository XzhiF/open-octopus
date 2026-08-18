# MANUAL-CHECKLIST — task-authoring-v3

> 人工验证清单：LLM 对话行为残差（spec R2 策略：LLM 行为非确定性，自动断言只打机制层 API/SSE/FS，对话内容走人工 checklist）。
>
> **STATUS: BLOCKED-pending-human** — 本清单的 M1–M5 必须由人工在真实 LLM provider 下逐项执行并回填「证据」栏后，方可视为 US8（对话改产物）PASS。在此之前 US8 保持 PARTIAL。仅靠自动化测试无法推进这些项（见各项「机制侧已自动覆盖」说明）。

## 运行环境

- 真实 provider（非 mock）：`pnpm dev`（server:3001 / web:3000），或 `pnpm prod`。
- 至少一个可用 Skill 组（如 `octo-backend`），模板页选 `coding` task_type + Skill 组 → 创建 → 编写页。
- DB：dev `~/.octopus/db/octopus.db`。任务数据使用 `E2E_TD_` 前缀，跑完清理。

## 机制侧（已由自动化测试覆盖，无需人工重复，仅供残差定位）

| 机制 | 自动化测试 | 说明 |
|------|-----------|------|
| US5 `@@spec_updated` 投递到下轮 system prompt | clone-spec-notice.test.ts AC3a/AC3b | 存→读→传给 CloneRuntime.chat→清空（one-shot） |
| D6 `@@task_context` 注入（产物目录绝对路径 + artifacts.json 登记指引 + Skill 组锁定措辞） | clone-spec-notice.test.ts D6 三例 | v3 任务且 home 存在才注入；v2 / 无 home 不注入 |
| US8 persona 机制契约（decisions 字段 / source_chat_session_id / @@spec_updated 说明） | persona-v3-instructions.test.ts | persona 文本 AS IS 断言 |
| US9 assist 工作流触发 + 白名单 + 临时 workspace | tasks-v3-assist.test.ts AC2/AC3 | 400 非法模板 + source='task-assist' |
| US10 过程日志（时间戳 + 专家步骤） | tasks-v3-assist.test.ts AC4 | JSONL → {t,icon,text} |
| US11 MoA 勾选采纳（ac + decisions）+ 解析兜底 | tasks-v3-assist.test.ts AC5 | broken JSON → output_raw fallback |
| D19 产物 SSE 刷新（无轮询） | tasks-v3-gates D19 test | TASK_ARTIFACTS_UPDATE_EVENT 伴随 emit |

> 注：产物目录/artifacts.json 登记指引的机制断言归属 `@@task_context`（D6，clone-spec-notice 套件），不在 persona 文本内——见 persona-v3-instructions.test.ts 头部注释，勿误判 persona 缺项。

---

## M1 (US5) — 用户直编 goal → 下轮对话收到 `@@spec_updated: goal` 并调和

**前置条件**
- 已创建一个 v3 任务（模板页选 task_type + Skill 组 → 编写页），处于 draft。
- 已发送至少一轮对话（autosave 已建立 task 行 + 会话绑定）。
- 真实 LLM provider 已就绪。

**操作步骤**
1. 在右侧 SpecPanel 直接编辑 `goal` 字段（GoalAcCard，source=user）。
2. 点击 `[保存草稿]`（PUT /api/tasks）。
3. 回到左侧对话，发送下一轮消息。

**期望观察**
- 下一轮 task-author 对话中，agent 的回应体现出它收到了 `@@spec_updated: goal` 反向通知（例如主动确认/调和用户改的 goal，而非忽略）。
- （机制侧已验证：server 在下轮 system prompt 追加 `@@spec_updated: goal` 并 one-shot 清空——此处只验「agent 行为是否体现」。）

**证据**（待人工填写）
- [ ] agent 回应原文摘录：______
- [ ] 执行人 / 日期：______

---

## M2 (US8) — 对话改产物：agent 写绝对路径 + 登记 artifacts.json + OutputViewer 可见

**前置条件**
- 一个 v3 任务已创建（有 home 目录），编写页打开。
- 真实 LLM provider 已就绪（agent 能调工具写文件）。
- 知道该任务 home 绝对路径（`<OCTOPUS_HOME>/orgs/<org>/tasks/<task_id>/` 或 dev 默认 `~/.octopus/...`）。

**操作步骤**
1. 在对话中要求 agent 产出一个产物文件（例如「写一份 API 设计草案到产物目录」）或修改已有产物。
2. 等待 agent 执行写入。
3. 观察右侧 OutputViewer；点击产物打开全文弹窗（artifact-viewer-dialog）。
4. 用文件系统直接读取 `{home}/artifacts/<file>` 与 `{home}/artifacts/artifacts.json`。

**期望观察**
- agent 用**绝对路径**写入 `{home}/artifacts/`（来自 `@@task_context` 注入的产物目录），而非相对当前 cwd。
- agent 在 `artifacts.json` 中登记该产物条目。
- OutputViewer 经 SSE 刷新（D19，TASK_ARTIFACTS_UPDATE_EVENT）可见新产物；全文弹窗内容与磁盘文件**一致**。
- （机制侧已验证：@@task_context 注入产物目录绝对路径 + artifacts.json 登记指引、SSE 刷新无轮询——此处验 agent 是否遵守。）

**证据**（待人工填写）
- [ ] agent 写入的绝对路径：______
- [ ] artifacts.json 登记条目（JSON 摘录）：______
- [ ] 弹窗内容 vs 磁盘文件一致性确认：______
- [ ] 执行人 / 日期：______

---

## M3 (US9) — agent 主动建议运行辅助工作流，用户点击触发

**前置条件**
- 一个 v3 任务编写页打开，已有多轮对话上下文。
- 真实 LLM provider 已就绪。
- 内置 3 个辅助工作流模板已装载（D9，moa-requirements-review 等白名单）。

**操作步骤**
1. 在对话中给出可被建议「跑辅助工作流」的上下文（例如「帮我评审一下需求是否完整」）。
2. 观察 agent 是否主动给出建议（建议气泡或文本建议运行某辅助工作流）。
3. 用户点击/采纳建议触发运行。

**期望观察**
- agent 主动建议运行辅助工作流（建议气泡或文本形式），而非仅被动应答。
- 用户点击后出现 run 卡片（assist run）。
- （机制侧已验证：assist-workflow trigger + 白名单 + source='task-assist' 临时 workspace——此处验 agent 建议主动性。）

**证据**（待人工填写）
- [ ] agent 建议原文摘录：______
- [ ] run 卡片出现确认（run id / 状态）：______
- [ ] 执行人 / 日期：______

---

## M4 (D6) — v3 第二轮对话体现 `@@task_context`（知产物目录、不擅改锁定 Skill 组）

**前置条件**
- 一个 v3 任务（task_type + skill_groups 已锁定）已创建，home 目录存在。
- 已发一轮对话（第二轮开始时 @@task_context 已注入）。
- 真实 LLM provider 已就绪。

**操作步骤**
1. 在第二轮对话中问 agent：「你把产物写到哪个目录？」
2. 在同一轮中试探 agent：「能不能把 Skill 组换成别的？」

**期望观察**
- agent 能说出产物目录的**绝对路径**（来自 @@task_context，非编造相对路径）。
- agent 拒绝/不建议修改已锁定的 Skill 组（ADR-0012 创建时锁定），而是引导用户走重新创建。
- （机制侧已验证：@@task_context 注入含产物目录绝对路径 + skill_groups 锁定措辞——此处验 agent 行为是否体现。）

**证据**（待人工填写）
- [ ] agent 报出的产物目录绝对路径：______
- [ ] agent 对改 Skill 组的回应原文摘录：______
- [ ] 执行人 / 日期：______

---

## M5 (real-LLM MoA) — 真实 provider 触发 moa-requirements-review 至终态

**前置条件**
- 一个 v3 任务编写页打开，已有 goal/ac。
- 真实 LLM provider 已就绪（非 mock；assist E2E 用的是 seeded 聚合器输出，此处必须跑真实 LLM）。
- moa-requirements-review 模板装载（D9）。

**操作步骤**
1. 触发 moa-requirements-review 辅助工作流（真实 LLM）。
2. 等待运行至终态。
3. 打开过程日志弹窗；观察结构化产出 + 勾选采纳。

**期望观察**
- 运行至终态（非卡死/超时）。
- 日志弹窗含**专家步骤**（多专家 + 聚合器，带时间戳/icon，US10）。
- 结构化产出（ac + decisions）可勾选采纳进 spec（US11）。
- （机制侧已验证：日志 {t,icon,text} 解析、MoA 采纳 spec-field(ac)+spec-field(decisions)、broken JSON → output_raw 兜底——此处验真实 LLM 跑通全链。）

**证据**（待人工填写）
- [ ] 终态确认（run status / 耗时）：______
- [ ] 日志弹窗专家步骤摘录：______
- [ ] 采纳进 spec 的字段（ac/decisions）确认：______
- [ ] 执行人 / 日期：______

---

## 收敛判定

- 全部 M1–M5 证据栏回填 → US8 视为 PASS，本清单 status 改为 `done`。
- 任一项未执行/未通过 → US8 维持 PARTIAL（BLOCKED-pending-human），不得视为收敛。
