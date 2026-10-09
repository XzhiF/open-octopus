# Windows / Git Bash 操作陷阱

> Bash 工具在本机跑 Git Bash（POSIX sh）。以下坑各有真实翻车记录，动 git、拆 worktree、派子代理前先过一眼。

## ref:path 的冒号被转路径
MSYS 会把 `origin/main:file.md` 这类参数转成 `origin\main;file.md`。用前导出 `MSYS2_ARG_CONV_EXCL='*'`；**用完必须 unset**——否则连 `git -C /c/...` 这类 POSIX 路径也会瞎（"No such file or directory"）。

## cwd 漂移
Bash 工具的 cwd 跨调用**持续**：任何一次 `cd`（含测试脚本里带上的）都会带走后续所有调用。翻车实录：凭"应该在 tbm-int"裸跑 `git merge`，实际落在主仓，靠脏文件挡下才没出事。纪律：每条命令自带绝对坐标——`git -C C:/xzf/ai/open-octopus/.worktrees/<name> …`（Windows 式最稳），复合命令开头显式 `cd /abs/here &&`。

## 杀 dev 服务留孤儿
`pnpm dev` 被 kill/TaskStop 后，node 子树常仍占着 worktree 端口（netstat 查 `:3296|:3297` 段，逐 PID `taskkill //F //PID`，与无关 node.exe 甄别后再杀）。拆 worktree 目录报 `Device or resource busy` 时先清进程再重试 rm，最后一轮 `git worktree prune` 收尸。

## worktree 测试前置
worktree 里 `pnpm install` 之后还要 `pnpm build`（workspace dist 缺失会让整个 server 套件假红）。测试过滤语法：`pnpm --filter @octopus/<pkg> test <name>`——**不带 `--`**（带上变成全量跑）。

## 线序
`.gitattributes`（`* text=auto eol=lf`）已定死单源；工作树再现可疑 ` M` 先用 `grep -c $'\r' <file>` 验尸，非 CR 即另有真改，别当噪音清。
