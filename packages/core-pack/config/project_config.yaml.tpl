# .octopus/config.yaml — 项目级配置
# 此文件由 octopus init 自动生成
# 以下注释字段继承自 ~/.octopus/orgs/{org}/config.yaml
# 取消注释即可覆盖全局配置，覆盖优先级: 项目级 > 用户级(~/.octopus/orgs/{org}/)

org: {org}                          # 当前项目所属组织 (init 时自动写入)
skill_dir: .claude/skills           # Skill 安装目录
shared_scripts: .octopus/scripts    # 共享脚本目录

# --- 继承自 ~/.octopus/orgs/{org}/config.yaml，取消注释可覆盖 ---
{commented_global_fields}
