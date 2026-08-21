# 14 — UI/UX Prototype v2（弹窗统一，全交互面）

Type: prototype
Status: resolved (user confirmed v2.1: spec 左 / 对话 右; 其余 OK)
Blocked by: None

> v1 右侧 authoring 拥挤 + 复合 drill-down 两层点击——用户反馈累。v2 改 **统一任务弹窗**：kanban 全宽干净；点卡 / [+新建] 弹同一个大 modal，按 status+type 上下文切换 authoring / 复合执行 / 简单执行。不再有侧栏，不再有额外 drill-down 步。

## 核心交互原则

1. **kanban 全宽**，5 列，干净。无右侧常驻面板。
2. **一个统一任务 Modal**（~80% 视口，居中）。入口：点任意卡 或 [+ 新建任务]。
3. **上下文感知**（按 status + type 切换 modal 内容）：
   - draft / 新建 → **Authoring 模式**（对话 + spec + subunit 编辑 + [入队]）
   - running/queued/claimed + 简单 → **简单执行视图**（单 ws 流程图 + 实时）
   - running/claimed + 复合 → **复合执行视图**（composition DAG + N 子 + 聚合 + 实时）
   - done → **结果视图**（产物：synth 报告 / PR 链接）
4. 复合详情 **直接在 modal 内**，不再"点卡→再点 drill-down"。一步到位。

## Screen 1 — /tasks 看板（全宽干净）

```
╔═══════════════════════════ /tasks · 任务池 ═════════════════════════════╗
║  [刷新]   [+ 新建任务]                              12 个任务           ║
╟──────────┬──────────┬──────────┬───────────┬───────────────────────────╣
║ draft 3  │ queued 2  │ claimed1 │ running 1 │ done 5                   ║
║          │          │          │           │                          ║
║ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │ ┌───────┐ │ ┌──────┐ ┌──────┐       ║
║ │登录  │ │ │缓存  │ │ │暗色  │ │ │API v2 │ │ │登录✓│ │监控✓│       ║
║ │重构  │ │ │优化  │ │ │模式  │ │ │[复合] │ │ │      │ │      │       ║
║ │Oct2  │ │ │Oct2  │ │ │agent │ │ │3 子  │ │ │      │ │      │       ║
║ └──────┘ │ └──────┘ │ └──────┘ │ └───────┘ │ └──────┘ └──────┘       ║
║ ┌──────┐ │          │          │           │ ┌──────┐                 ║
║ │报表  │ │          │          │           │ │权限✓│                 ║
║ │导出  │ │          │          │           │ │      │                 ║
║ └──────┘ │          │          │           │ └──────┘                 ║
╚══════════╧══════════╧══════════╧═══════════╧══════════════════════════╝
   点任意卡 / [+ 新建] → 弹出统一任务 Modal（Screen 2/3/4 之一）
```

## Screen 2 — Modal · Authoring 模式（[+新建] 或 draft 卡）· spec 左 / 对话 右

```
┌── 任务 · OAuth 多仓库登录 · [draft] ────────────────────────── × ─┐
│ project: ▾octo-web +▾octo-api   skills:[✓]spec [✓]web-dev          │
├───────────────────────────────┬───────────────────────────────────┤
│ ◤ spec 预览 + subunit 编辑     │  对话 (task-author 分身) ▶          │
│ ┌────────────────────────────┐ │  user: 加 OAuth 登录,多仓库         │
│ │ goal: OAuth 多仓库登录     │ │  ai:  生成 spec 中…  ▸ 流          │
│ │ AC: ①登录页 ②回调 ③token   │ │  ───────────────                  │
│ │ subunits (2):              │ │  ▸ 消息…                          │
│ │  • octo-web : impl-ui  [▾] │ │                                   │
│ │  • octo-api : impl-auth [▾]│ │                                   │
│ │  + 添加 subunit           │ │                                   │
│ │ integration: synthesis ▾  │ │  ┌──────────────────────┐         │
│ └────────────────────────────┘ │  │ 描述需求…        [发送]│         │
│                                │  └──────────────────────┘         │
├───────────────────────────────┴───────────────────────────────────┤
│                    [重新生成]         [入队 →]      [取消]           │
└─────────────────────────────────────────────────────────────────────┘
   spec 左 / 对话 右；[入队]=confirm gate(12=i)；复合在此直接编 subunits
```

## Screen 3 — Modal · 复合执行视图（点 running [复合] 卡，直接进）

```
┌── 任务 · API v2 重构 · [running 2/3] · 复合 ────────── [中止] × ─┐
│ integration_goal: synthesis · coordinator-ws: ws-coord             │
├────────────────────────────────────────────┬───────────────────────┤
│  composition DAG (复用引擎流程图组件)      │  实时事件 (SSE)        │
│                                            │  ─ schedule_status    │
│   ┌────────┐      ┌────────┐               │  ws-A → done ✓        │
│   │ sub-A  │      │ sub-B  │               │  ws-B → done ✓        │
│   │✓ done  │      │✓ done  │               │  ws-C → running ⏳     │
│   └───┬────┘      └───┬────┘               │  ◆ moa → pending      │
│       └──────┬───────┘                     │  ───────────────────  │
│              ▼                             │  [跳转 ws-A 执行详情] │
│      ┌────────────┐  ← 同wf 不同vars=Loop  │  [跳转 ws-B]          │
│      │ sub-C ⏳   │                          │  [跳转 ws-C]          │
│      └─────┬──────┘                          │                       │
│            ▼                                 │                       │
│      ┌────────────┐                          │                       │
│      │ ◆ moa 聚合 │  ← integration           │                       │
│      └────────────┘                          │                       │
├────────────────────────────────────────────┴───────────────────────┤
│  子 ws: [ws-A ✓][ws-B ✓][ws-C ⏳]   各自独立 git worktree          │
└────────────────────────────────────────────────────────────────────┘
   同一个弹窗，上下文感知；点卡即见全貌，无 drill-down 二次点击
```

## Screen 4 — Modal · 简单执行视图（点 running 简单卡）

```
┌── 任务 · 登录重构 · [running] ──────────────────────────────── × ─┐
│ workflow_ref: impl-login (execution-only, 默认 07=i) · ws: ws-login │
├────────────────────────────────────────────────────────────────────┤
│   ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐   单链执行流    │
│   │ init   │──▶│ impl   │──▶│ test   │──▶│ ship   │                │
│   │ ✓      │   │ ⏳     │   │        │   │        │                │
│   └────────┘   └────────┘   └────────┘   └────────┘                │
│   实时 SSE node_start/node_end + 日志                               │
├────────────────────────────────────────────────────────────────────┤
│   [中止]                                                            │
└────────────────────────────────────────────────────────────────────┘
```

## Screen 5 — Modal · done 结果视图

```
┌── 任务 · API v2 重构 · [done] · 复合 ──────────────────────── × ─┐
│ ◆ integration: synthesis (moa)                                     │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ 综合报告: 3 子任务全完成。web 登录页 + api OAuth + staging 验证│ │
│ │ 通过。建议合并 PR。                                              │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ 子 ws 产物:  [ws-A PR→]  [ws-B PR→]  [ws-C PR→]                    │
└────────────────────────────────────────────────────────────────────┘
```

## Screen 6 — lifecycle & real-time（不变）

```
 [draft]──[入队]──▶[queued]──[claim]──▶[claimed]──[dispatch]──▶[running]──▶[done]
    ▲              │ (10s 轮询)        │                  │ SSE schedule_status
    │ authoring    ▼                   ▼                  ▼ → 看板卡状态秒变
    │ modal        [stale>10min       crash recovery     点卡 → modal 切到对应模式
    │              rollback→queued]   checkStaleClaimed
```

## 交互面清单（全覆盖，已对位）

1. /tasks 看板 5 列全宽（Screen 1）✓
2. 统一任务 Modal：authoring / 复合执行 / 简单执行 / done 结果，上下文切换（Screen 2-5）✓
3. task-author chatbot（peer clone，curl→scheduler API via skill），住 modal 左区（Screen 2）✓
4. confirm/enqueue：modal 内 [入队] 按钮，draft→queued（Screen 2/6）✓
5. 复合详情直接在 modal（DAG + N 子 + 聚合 + 实时），无 drill-down 二次点击（Screen 3）✓
6. spec/subunit 编辑器：modal 右区，复合 draft 态编辑 N subunits（Screen 2）✓
7. execution-time HITL：pinned workflow 内 interaction 节点（沿用 chatbot-workflow-design，复用 ChatPanel）✓
