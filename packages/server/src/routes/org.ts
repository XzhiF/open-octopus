import { Hono } from "hono"
import { OrgDAO } from "../db/dao"

export function createOrgRoutes(orgDAO: OrgDAO): Hono {
  const orgRoutes = new Hono()

  orgRoutes.get("/", async (c) => {
    const orgs = await orgDAO.findAll()
    return c.json(orgs)
  })

  return orgRoutes
}
