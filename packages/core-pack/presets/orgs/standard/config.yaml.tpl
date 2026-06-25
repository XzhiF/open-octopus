# ~/.octopus/{org}/config.yaml — 组织配置
# 请手动填写以下配置项

name: "{org}"                       # 组织显示名 (必填, 可改为中文名)
prefix: {org}-                      # Skill 前缀 (自动从 org 名推断)
# description: "{org} 项目"          # 组织描述 (可选, 取消注释可填写)
platform: gitlab                    # 代码平台 (gitlab/github)
groups:                             # 项目组列表
  - {org}
clone_base: ~/.octopus/{org}/repos/projects