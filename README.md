# Feishu Codex Local Agent

本项目在本机运行一个飞书机器人 Agent：手机飞书给机器人发自然语言消息，本机通过飞书长连接接收消息，按需调用本机 `codex exec --json`，再把回复、任务状态和摘要回发飞书。

第一版只面向个人或少量白名单用户使用，不自动 `commit`、`push`、部署或执行生产数据库操作。

## 要求

- Node.js 24 或更高版本。
- 本机已安装并登录 Codex CLI，且 `codex exec --help` 可正常运行。
- 飞书自建应用已开启机器人能力。
- 飞书开放平台已开启事件订阅、长连接模式、接收消息事件 `im.message.receive_v1`。
- 飞书应用具备发送消息权限，机器人已加入目标会话。

## 配置

复制 `.env.example` 为 `.env`，并填写：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_ALLOWED_USER_IDS=ou_xxxxxxxxxxxxx,user_xxxxxxxxxxxxx
TASK_TIMEOUT_MS=1800000
DATA_DIR=data
LOG_LEVEL=info
```

`FEISHU_ALLOWED_USER_IDS` 是飞书用户白名单。路径不配置白名单：任意存在的本机目录都可以提交给 Agent，但每个项目任务都会先进入确认状态，必须回复 `/approve <taskId>` 后才会执行。

## 运行

开发运行：

```bash
npm run dev
```

生产运行：

```bash
npm run build
npm run start
```

可选常驻方式：

- `pm2 start dist/index.js --name feishu-codex-agent`
- macOS `launchd`，将 `npm run start` 或 `node dist/index.js` 配成用户级守护进程。

## 命令

你可以直接说：

```text
你好
请处理 heroverse 项目的 build 报错
请检查 /Users/hero/Documents/workspace/heroverse 里的权限问题
```

普通聊天会直接交给 Codex 回复。消息里出现当前 workspace 下的项目名，或出现本机绝对路径时，会创建待确认项目任务。直接写绝对路径时不受项目名识别目录限制。

也可以使用命令：

```text
/help
/repos
/clear
/status <taskId>
/approve <taskId>
/reject <taskId>
/cancel <taskId>
/repo=<本机目录路径> <任务描述>
```

飞书机器人菜单的「发送文字消息」会把菜单名称本身作为消息发送。菜单名称可以直接填 `/help`、`/repos`、`/clear`，也可以填中文别名：`帮助`、`项目列表`、`仓库列表`、`清空记录`。

示例：

```text
/repo=/Users/hero/Documents/workspace/heroverse 帮我跑 build 并修复报错
/repo=~/Documents/workspace/heroverse 检查项目结构并总结
```

发送任务后，机器人会回复一个 `pending_confirmation` 任务 ID。确认执行：

```text
/approve <taskId>
```

拒绝执行：

```text
/reject <taskId>
```

`/repos` 会说明当前路径策略：没有路径白名单，所有存在目录都可提交，但需要确认。

`/clear` 会清空已结束任务的数据库记录和对应日志目录；正在等待确认、排队或运行中的任务会保留。

## 数据与日志

任务记录保存在：

```text
data/agent.sqlite
```

每个任务的本地日志目录：

```text
data/logs/<taskId>/
```

包含：

- `codex.jsonl`：`codex exec --json` stdout 原始 JSONL。
- `stderr.log`：Codex 子进程 stderr。
- `final.txt`：飞书回执摘要。
- `git-diff-stat.txt`：任务结束后的 `git diff --stat`。
- `git-diff.patch`：任务结束后的 `git diff`。

## 安全边界

- 只有 `FEISHU_ALLOWED_USER_IDS` 中的用户可以创建、查询、取消任务。
- 不配置路径白名单；任意存在目录都可作为 `repo`，但任务必须先由白名单用户显式 approve。
- Codex 执行参数固定使用 `-s danger-full-access --skip-git-repo-check`，允许访问本机路径。
- 回发飞书只发送摘要和本地日志路径，不发送完整 diff。
- 任务全局 FIFO 串行执行，避免多个 Codex 任务同时修改同一工作区。
- `/cancel` 对未开始任务会直接取消；对运行中任务第一版只标记取消，不主动终止 Codex 子进程。

## 验证清单

1. 运行 `npm run build`。
2. 运行 `npm run lint`。
3. 在飞书发送 `/help`，确认机器人回复。
4. 使用非白名单用户发送命令，确认被拒绝。
5. 使用不存在的目录发送命令，确认被拒绝。
6. 使用存在目录发送只读任务，确认任务停在 `pending_confirmation`。
7. 回复 `/approve <taskId>`，确认任务开始执行并生成记录、JSONL 和飞书回执。
8. 使用小改动任务，确认生成 `git-diff.patch` 且不会自动 commit/push。
