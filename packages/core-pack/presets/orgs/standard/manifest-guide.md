# Manifest 格式引导

此文件说明 `manifest.md` 的填写格式，仅供参考，不会被 octopus 解析。

---

## 行格式

每行一条项目，格式如下：

```
- 项目名 git_url [分支] {标签}
```

| 字段   | 必填 | 说明                                                     | 示例                                          |
| ------ | ---- | -------------------------------------------------------- | --------------------------------------------- |
| 项目名 | 是   | 项目唯一标识名，用于 clone 目录名和索引                   | `octopus`                                     |
| git_url | 是   | Git 仓库地址，HTTPS 或 SSH 格式均可                       | `git@github.com:XzhiF/octopus.git`            |
| [分支] | 否   | 默认 `master`，GitHub 项目通常填 `[main]`                | `[main]`                                      |
| {标签} | 否   | 手动分类标签，逗号或斜杠分隔                              | `{frontend, react}`                           |

## 分组

用 `## 组名` 或 `## 组名 (描述)` 创建分组。描述可选，不会影响解析。

```
## frontend (前端项目)
## backend
## infra (基础设施)
```

## SSH 格式示例（推荐，免密码）

```
## opensource (开源项目)

- octopus git@github.com:XzhiF/octopus.git [main] {cli, tool}
- my-lib git@github.com:XzhiF/my-lib.git [main]

## work (公司项目)

- admin-ui git@github.com:company/admin-ui.git [main] {frontend}
- api-server git@github.com:company/api-server.git [release] {backend}
```

## HTTPS 格式示例

```
## opensource (开源项目)

- octopus https://github.com/XzhiF/octopus.git [main] {cli, tool}
- my-lib https://github.com/XzhiF/my-lib.git [main]
```

## GitLab / 自建 Git 示例

```
## internal (内部项目)

- order-service git@git.example.com:team/order-service.git [release]
- gateway https://git.example.com/infra/gateway.git [master]
```

## 注意事项

- 项目名不能包含空格
- git_url 支持 HTTPS (`https://...`) 和 SSH (`git@host:path`) 两种格式
- SSH 格式需要本地已配置好密钥（`~/.ssh/id_*` + `ssh-add`）
- `## {org}` 这一行会在 setup 时自动生成，不要删除
- 添加新项目后运行 `octopus repos update --org {org}` 更新索引