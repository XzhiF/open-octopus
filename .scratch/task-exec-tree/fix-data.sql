-- task-exec-tree 数据修复：把历史 v4 轮次链成树 (schema v44 同语义)
--
-- 背景：v44 之前每轮都是独立 root (parent_id='0')，任务在工作区执行树里散成 N 个根。
-- 本脚本按插入顺序 (rowid) 把同一任务的带 phase 标记轮次重新挂链：
--   第 1 轮 = 根 (parent_id 归 '0')，第 k 轮 parent = 第 k-1 轮；
--   按 (task, workspace) 分段 —— ws 重建后另起一棵树，与 armTask 的 same-ws 守卫一致。
-- composite 子单元臂 (phase_index IS NULL) 不动 —— 它们的 parent 本来就是派发关系。
--
-- ★ 执行时机（重要）：
--   必须在新代码重启之后跑。未重启的旧服务器仍按 parent_id='0' 识别轮次：
--     - 改链一个 RUNNING 行 → 它完成时 finalize 会误走子单元分支（collect/待验收丢失）；
--     - 改链一个 终态但未验收 行 → 旧 deriveView/findTaskRound 查不到 → 验收 409。
--   脚本自带保护：只改「终态」行（见 WHERE status）——running/pending 行即使误早跑也不动。
--   跑之前先执行文件头段之后的 dry-run SELECT 看影响面（已在下方）。
--
-- 用法（dev 主库）:
--   sqlite3 ~/.octopus/db/octopus.db < fix-data.sql     -- 先跑只读盘点，再跑 UPDATE
--
-- 幂等：已链好 (parent 正确) 的行不命中 WHERE；重复执行安全。

-- ── dry-run 盘点：将被改链的行 ────────────────────────────────────────
WITH rounds AS (
  SELECT
    id,
    task_id,
    parent_id AS old_parent,
    LAG(id) OVER (PARTITION BY task_id, workspace_id ORDER BY rowid) AS want_parent
  FROM executions
  WHERE task_id IS NOT NULL
    AND phase_index IS NOT NULL          -- 只动 v4 轮次（实例标记）
)
SELECT r.task_id, r.id, e.phase_index, e.round_index, e.status,
       r.old_parent,
       CASE WHEN r.old_parent = '0' THEN '(root)' ELSE r.old_parent END AS current_parent,
       COALESCE(r.want_parent, '(keep root)') AS target_parent
  FROM rounds r
  JOIN executions e ON e.id = r.id
 WHERE r.want_parent IS NOT NULL
   AND e.parent_id = '0'                  -- 只修仍是散根的行（幂等）
   AND e.status IN ('completed','completed_with_failures','failed','cancelled','aborted','skipped','rejected')
 ORDER BY r.task_id, e.rowid;

-- ── 改链 ─────────────────────────────────────────────────────────────
WITH rounds AS (
  SELECT
    id,
    LAG(id) OVER (PARTITION BY task_id, workspace_id ORDER BY rowid) AS want_parent
  FROM executions
  WHERE task_id IS NOT NULL
    AND phase_index IS NOT NULL
)
UPDATE executions
   SET parent_id = (SELECT want_parent FROM rounds WHERE rounds.id = executions.id)
 WHERE id IN (
   SELECT r.id FROM rounds r
   JOIN executions e ON e.id = r.id
   WHERE r.want_parent IS NOT NULL
     AND e.parent_id = '0'
     AND e.status IN ('completed','completed_with_failures','failed','cancelled','aborted','skipped','rejected')
 );

-- ── 验证：每个任务的轮次树（tip = 看板 badge 读的那行） ───────────────
SELECT e.task_id, e.id, e.parent_id, e.phase_index, e.round_index, e.status
  FROM executions e
 WHERE e.task_id IS NOT NULL AND e.phase_index IS NOT NULL
 ORDER BY e.task_id, e.rowid;
