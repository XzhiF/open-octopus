import { Hono } from "hono"
import type { QueueTaskView } from "../services/knowledge/wiki/compile-queue"

/**
 * 队列可观测路由（知识中心票06 AC8，S2 契约面）——挂 `/api/knowledge/wiki`：
 *
 *   GET /queue          ⇒ { depth, running, tasks: QueueTaskView[] }
 *                         depth = queued+running（与健康条 queueDepth 同口径）；
 *                         tasks 按登记顺序（FIFO 执行序），每项带 state 与位次
 *                         #N（queued 时有值；running/终态 null）——UI 票12
 *                         「排队中 #N → 编译中 → 已提交」卡片消费面。
 *   GET /queue/task/:id ⇒ { task: QueueTaskView }；未知 id ⇒ 404 NOT_FOUND
 *                         （错误形状沿用 {error:{code,message}} 纪律）。
 *
 * 只读观测：本路由不enqueue、不解锁、不干预执行——读永不锁的 API 侧投影。
 */

export interface CompileQueueReadApi {
  get(id: string): QueueTaskView | undefined
  list(): QueueTaskView[]
  depth(): number
}

export function createCompileQueueRoutes(queue: CompileQueueReadApi): Hono {
  const routes = new Hono()

  routes.get("/queue", (c) => {
    const tasks = queue.list()
    return c.json({
      depth: queue.depth(),
      running: tasks.some(t => t.state === "running"),
      tasks,
    })
  })

  routes.get("/queue/task/:id", (c) => {
    const id = c.req.param("id")
    const task = queue.get(id)
    if (!task) {
      return c.json({ error: { code: "NOT_FOUND", message: `queue task not found: ${id}` } }, 404)
    }
    return c.json({ task })
  })

  return routes
}
