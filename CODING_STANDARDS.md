# Coding Standards — code-review 轴一执法手册

> 本文件在 **review 时**读，不在实现时读（实现者上下文已经很挤）。
> 每条 = 一句判据 + 一个反例锚点（commit/事故），reviewer 对着 diff 逐条过。
> 机械可查的先建检查，不写规则；能进 eslint/CI 的早晚要进。

1. **单源呈现**：格式化/渲染/口径计算必有唯一源，复用方 import 它。给接口换名以绕开单源闸 = 加重情节，直接打回。
   *反例锚点：账本命中率一度双式（JS vs SQL）→ 现 `shared/ledger.ts` LEDGER_SQL 镜像金表钉死。*

2. **catch 不得伪造空态覆盖已载数据**：取数失败保留旧值 + 显式错误位；把"失败"写成"没有"是数据损毁。
   *反例锚点：`51ee1a4e`（refetch 失败写空 groups 覆盖了已加载产物清单）。*

3. **UI 锚点搬家同票迁尽**：挪动/删除 `data-testid`、`data-*` 挂载点时，同 commit grep 全引用面（含 e2e 与快照）一并迁移。
   *反例锚点：`a3b2f5b7`（railless 改版后 e2e 还钉旧 `[data-acceptance-reject]`，流⑤超时才暴露）。*

4. **"与基线持平"必须引数**：全量套件有环境性预存红时，报持平要给出红数与红文件清单来源（stash 对照或基线记录），不得以"应该没关系"过关。基线红的登记位唯一在 PR/票的 Closed 行。

5. **占位与脚手架同票清**：placeholder/临时壳被真身替换的**同一张票**内删除；活文档里不留"为已退役接缝辩护"的注释。
   *反例锚点：二轮终审 ③（ready-tab-placeholders 换真身后成零 importer 死码）。*

6. **UI 行为判据绑域数据，不绑派生态**："这个 phase 有没有执行行"是真相；"任务显示为 ready"是投影——多 phase 推进、触发瞬间都会让投影说谎。
   *反例锚点：`92af9641`（静态节点预览判据从 `status==="ready"` 改 `!nodesRun`）。*
