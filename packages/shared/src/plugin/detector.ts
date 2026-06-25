import fs from 'fs'
import path from 'path'
import os from 'os'
import type { DetectedPlugin, InstalledPluginsFile, PluginSdkConfig } from './types'

/** 白名单 — 只有列在这里的 plugin 才会被自动加载 */
const DEFAULT_WHITELIST: ReadonlySet<string> = new Set(['ponytail'])

/**
 * 检测 ~/.claude 中已安装且在白名单内的 plugins
 *
 * 读取 installed_plugins.json → 按白名单过滤 → 验证目录存在 → 返回结果
 */
export function detectUserPlugins(
  whitelist: ReadonlySet<string> = DEFAULT_WHITELIST,
): DetectedPlugin[] {
  const installedPath = path.join(
    os.homedir(), '.claude', 'plugins', 'installed_plugins.json',
  )

  let raw: string
  try {
    raw = fs.readFileSync(installedPath, 'utf8')
  } catch {
    return []
  }

  let data: InstalledPluginsFile
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }

  const detected: DetectedPlugin[] = []

  for (const [key, records] of Object.entries(data.plugins ?? {})) {
    const name = key.split('@')[0] ?? key
    if (!whitelist.has(name)) continue

    const record = records[records.length - 1]
    if (!record?.installPath) continue

    const pluginDir = record.installPath
    const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json')
    try {
      fs.accessSync(pluginDir, fs.constants.R_OK)
      fs.accessSync(manifestPath, fs.constants.R_OK)
    } catch {
      continue
    }

    detected.push({
      name,
      marketplace: key.split('@')[1] ?? '',
      version: record.version,
      installPath: pluginDir,
      sdkConfig: { type: 'local', path: pluginDir },
    })
  }

  return detected
}

/** 获取白名单 plugins 的 SDK 配置数组，直接传给 sdkOptions.plugins */
export function getPluginSdkConfigs(
  whitelist?: ReadonlySet<string>,
): PluginSdkConfig[] {
  return detectUserPlugins(whitelist).map(p => p.sdkConfig)
}
