export const AUTO_TAG_MAP: Record<string, string[]> = {
  order: ["订单", "order"],
  user: ["用户", "user", "account"],
  gateway: ["网关", "gateway", "route"],
  message: ["消息", "message", "notification"],
  common: ["通用", "common", "shared"],
  monitor: ["监控", "monitor", "alert"],
  wechat: ["微信", "wechat"],
  ai: ["AI", "ai"],
  risk: ["风控", "risk"],
  content: ["内容", "content"],
  system: ["系统", "system", "config"],
  honor: ["勋章", "honor", "badge"],
  upload: ["上传", "upload"],
  task: ["任务", "task"],
  account: ["账号", "account", "auth"],
}

export function inferAutoTags(name: string): string[] {
  const tags: string[] = []
  const nameLower = name.toLowerCase().replace(/-/g, "_")

  for (const [keyword, tagList] of Object.entries(AUTO_TAG_MAP)) {
    if (nameLower.includes(keyword)) {
      tags.push(...tagList)
    }
  }

  return tags
}