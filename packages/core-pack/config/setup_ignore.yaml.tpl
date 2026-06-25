# ~/.octopus/setup_ignore.yaml
# setup 命令不会覆盖这些文件 (--force 也不覆盖)
# repos/manifest.md 会合并 (用户优先+模板补充), 不在忽略名单
# repos/index.md 和 repos/projects/ 不合并, 在忽略名单

ignore_patterns:
  - {org}/repos/index.md
  - {org}/repos/projects**
  - {org}/evolution/experiences**
  - {org}/evolution/index.md
  - {org}/evolution/global_experience.md
  - {org}/evolution/{org}_user_preference.md
  - user_preference.md