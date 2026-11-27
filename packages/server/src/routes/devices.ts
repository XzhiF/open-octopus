// packages/server/src/routes/devices.ts
//
// M3 · 手机配对与设备管理（2026-11-27）。
//
//   POST   /api/pair/code      —— 生成一次性 6 位码（**仅回环**）
//   POST   /api/pair/redeem    —— 码换长期令牌（鉴权闸外；一次性、2 分钟、5 次错误作废）
//   GET    /api/remote/status  —— 远程拉起是否就绪 / 密钥槽余量（仅回环）
//   POST   /api/remote/setup   —— 一键启用：发起一次 UAC 安装（仅回环）
//   GET    /api/devices        —— 已配对设备（仅回环）
//   PATCH  /api/devices/:id    —— 改名（仅回环）
//   DELETE /api/devices/:id    —— 吊销（仅回环；行保留，下一次请求立刻 401）
//
// 手机端只需 redeem；其余都在 PC 设置页。设备管理接口刻意不开放给远程令牌：
// 一部手机被偷了，不能拿它自己的令牌再生成别人的令牌。
//
// M4：redeem 可以带 `wants_remote: true` —— 从密钥槽里取一把 SSH 私钥随身返回
// （槽位由 install-remote.ps1 预授权；私钥只在响应里出现一次，随即从磁盘删除）。

import { Hono, type Context } from "hono"
import { isLocalRequest } from "../middleware/device-auth"
import { PairingError, type DeviceAuthService } from "../services/device-auth"
import {
  getRemoteControlService,
  type IssuedSshKey,
  type RemoteControlService,
} from "../services/remote-control"

type ServiceGetter = () => DeviceAuthService
type RemoteGetter = () => RemoteControlService

export function createDeviceRoutes(
  getService: ServiceGetter,
  getRemote: RemoteGetter = getRemoteControlService,
): Hono {
  const app = new Hono()

  const requireLocal = (c: Context): Response | null => {
    if (isLocalRequest(c.req.raw.headers)) return null
    return c.json(
      {
        error: "forbidden",
        message: "只能在电脑本机操作 —— 手机端只需配对，不需要管理设备",
      },
      403,
    )
  }

  app.post("/pair/code", (c) => {
    const denied = requireLocal(c)
    if (denied) return denied
    return c.json(getService().createPairCode())
  })

  app.post("/pair/redeem", async (c) => {
    let body: unknown = {}
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const input = (body ?? {}) as Record<string, unknown>
    const code = typeof input.code === "string" ? input.code : ""
    const name = typeof input.name === "string" ? input.name : null
    const platform = typeof input.platform === "string" ? input.platform : null
    const wantsRemote = input.wants_remote === true || input.wantsRemote === true
    try {
      const result = getService().redeem(code, { name, platform })
      let device = result.device
      let ssh: IssuedSshKey | null = null
      let sshUnavailable: string | undefined
      if (wantsRemote) {
        const alloc = getRemote().allocate()
        if (alloc.ok) {
          const updated = getService().attachKeySlot(device.id, alloc.key.slot)
          if (updated) device = updated
          ssh = alloc.key
        } else {
          sshUnavailable = alloc.reason
        }
      }
      return c.json({
        ...result,
        device,
        ...(ssh ? { ssh } : {}),
        ...(sshUnavailable ? { ssh_unavailable: sshUnavailable } : {}),
      })
    } catch (err) {
      if (err instanceof PairingError) {
        return c.json({ error: "pairing_failed", message: err.message }, err.status)
      }
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: "pairing_failed", message: msg }, 500)
    }
  })

  app.get("/remote/status", (c) => {
    const denied = requireLocal(c)
    if (denied) return denied
    return c.json(getRemote().status())
  })

  app.post("/remote/setup", (c) => {
    const denied = requireLocal(c)
    if (denied) return denied
    const result = getRemote().setup()
    if (result.installed) return c.json(result)
    if (!result.started) {
      const code =
        result.reason === "installer_missing" || result.reason === "spawn_failed" ? 500 : 409
      return c.json(
        { error: result.reason ?? "setup_failed", message: result.message ?? "没能发起安装" },
        code,
      )
    }    return c.json(result, 202)
  })

  app.get("/devices", (c) => {
    const denied = requireLocal(c)
    if (denied) return denied
    return c.json({ devices: getService().list() })
  })

  app.patch("/devices/:id", async (c) => {
    const denied = requireLocal(c)
    if (denied) return denied
    let body: unknown = {}
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const name = (body as Record<string, unknown> | null)?.name
    if (typeof name !== "string" || !name.trim()) {
      return c.json({ error: "invalid_name", message: "名字不能为空" }, 400)
    }
    const device = getService().rename(c.req.param("id"), name)
    if (!device) return c.json({ error: "not_found", message: "没有这台设备" }, 404)
    return c.json({ device })
  })

  app.delete("/devices/:id", (c) => {
    const denied = requireLocal(c)
    if (denied) return denied
    const ok = getService().revoke(c.req.param("id"))
    if (!ok) return c.json({ error: "not_found", message: "没有这台设备" }, 404)
    return c.body(null, 204)
  })

  return app
}
