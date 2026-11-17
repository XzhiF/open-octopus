// packages/server/src/routes/agent/fs-routes.ts
//
// 目录浏览器数据源（composer 的「选择目录…」）。
// 只暴露「非系统敏感」目录；策略见 services/path-policy。
// 挂在 /api/agent 下 = 自动吃 agentAuthMiddleware（需要 Bearer）。

import { Hono } from 'hono'
import { browseDirectory, createDirectory, PathPolicyError } from '../../services/path-policy'
import { createAgentError } from './middleware'

function statusFor(code: PathPolicyError['code']): 400 | 403 | 404 | 409 {
  if (code === 'PATH_BLOCKED') return 403
  if (code === 'PATH_NOT_FOUND') return 404
  if (code === 'PATH_EXISTS') return 409
  return 400
}

export function createFsRoutes(): Hono {
  const app = new Hono()

  app.get('/fs/browse', (c) => {
    try {
      return c.json(browseDirectory(c.req.query('path')))
    } catch (err: unknown) {
      if (err instanceof PathPolicyError) {
        return c.json(createAgentError(err.code, err.message), statusFor(err.code))
      }
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // 目录浏览器里的「新建文件夹」。父目录走同一套 path-policy（敏感目录挡）；
  // 名字只允许单段，重名返回 409。
  app.post('/fs/mkdir', async (c) => {
    let body: { parent?: unknown; name?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json(createAgentError('INVALID_BODY', '请求体不是合法 JSON'), 400)
    }
    if (typeof body?.parent !== 'string' || typeof body?.name !== 'string') {
      return c.json(createAgentError('INVALID_BODY', '需要 parent 与 name 两个字符串'), 400)
    }
    try {
      return c.json(createDirectory(body.parent, body.name))
    } catch (err: unknown) {
      if (err instanceof PathPolicyError) {
        return c.json(createAgentError(err.code, err.message), statusFor(err.code))
      }
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  return app
}
