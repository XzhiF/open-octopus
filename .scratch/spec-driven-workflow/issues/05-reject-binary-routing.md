# 05 — 打回二分路由（server + web）

Status: done

## What
server：`AcceptanceInput.next_flow?: "fix"|"rerun"`（缺省 rerun=现行为）；rejected 分支 fix=dispatchPhaseRound opts{workflowRefOverride:"built-in/task-fix", inputOverride 合成 ws 同构批次位+反馈路径+artifacts 目录}，override 只进 workflow_chain（K16 phases[] 冻结破不了）；`dispatchPhaseRound` opts 参数 + create 用 effective ref；deriveView 采 `executions.workflow_ref` → round 视图带实际执行流。
web：acceptance-modal 反馈面板二选一 radio（默认 rerun 保旧链绿）+ 提交后回显卡（替换 disabled D13① 假卡）+ toast 路由文案；tasks-api next_flow/listHomeDir/HomeFileListingEntry/TaskRoundExec.workflow_ref；home-file LIST（dir-mode 守卫 + GET ?list=1）；phase-spec-dialog 批次文件清单（spec/反馈/报告/票 分组徽章 + 点击切换编辑）。

## Verification Method
- `npx vitest run tasks-v4-acceptance` AC3.5 三用例（缺省=绑定流；fix=chain override+合成输入+exec 行流名；非法值 400 账本不脏）
- `npx vitest run acceptance-modal phase-spec-dialog`（radio 双路由 body + 回显非 disabled + 清单 mock）
- playwright task-phase-acceptance AC2（真 UI 打一枪看 chain）
