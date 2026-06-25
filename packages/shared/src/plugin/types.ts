/** Plugin SDK 配置（与 @anthropic-ai/claude-agent-sdk 的 SdkPluginConfig 保持一致） */
export interface PluginSdkConfig {
  type: 'local'
  path: string
}

/** installed_plugins.json 中单个 plugin 的安装记录 */
export interface InstalledPluginRecord {
  scope: string
  installPath: string
  version: string
  installedAt: string
  lastUpdated: string
  gitCommitSha?: string
}

/** installed_plugins.json 的顶层结构 */
export interface InstalledPluginsFile {
  version: number
  plugins: Record<string, InstalledPluginRecord[]>
}

/** 检测到的已安装 plugin 信息 */
export interface DetectedPlugin {
  /** plugin 名称，如 "ponytail" */
  name: string
  /** marketplace 来源，如 "ponytail" */
  marketplace: string
  /** 版本号 */
  version: string
  /** 安装绝对路径 */
  installPath: string
  /** 传递给 SDK 的配置 */
  sdkConfig: PluginSdkConfig
}
