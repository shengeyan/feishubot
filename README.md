# Feishu Codex Local Agent

本项目在本机运行一个飞书机器人 Agent：手机飞书给机器人发自然语言消息，本机通过飞书长连接接收消息，按需调用本机 `codex exec --json`，再把回复、任务状态和摘要回发飞书。

第一版只面向个人或少量白名单用户使用，不自动 `commit`、`push`、部署或执行生产数据库操作。

## 要求

- Node.js 24 或更高版本。
- 本机已安装并登录 Codex CLI，且 `codex exec --help` 可正常运行。
- 飞书自建应用已开启机器人能力。
- 飞书开放平台已开启事件订阅、长连接模式、接收消息事件 `im.message.receive_v1`。
- 如需使用任务卡片按钮，需开启消息卡片回调 `card.action.trigger`。
- 飞书应用具备发送消息、上传文件权限，机器人已加入目标会话。

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

机器人会按飞书 `chatId + userId` 保存短期会话记忆：最近项目、最近任务和最近几轮用户/Codex 消息。后续消息里出现「继续」「刚才」「这个」「文件」「README」这类上下文追问时，会沿用上一轮项目并把近期上下文一起交给 Codex，例如「请把 xxx 项目的 README 给我」之后再说「请以文件形式给我」，会继续指向 `xxx` 项目。

也可以使用命令：

```text
/help
/repos
/clear
/status <taskId>
/approve <taskId>
/reject <taskId>
/cancel <taskId>
/stop <taskId>
/file <taskId> [summary|diff|stat|jsonl|stderr]
/sendfile <本机文件路径>
/repo=<本机目录路径> <任务描述>
```

飞书机器人菜单的「发送文字消息」会把菜单名称本身作为消息发送。菜单名称可以直接填 `/help`、`/repos`、`/clear`，也可以填中文别名：`帮助`、`项目列表`、`仓库列表`、`清空记录`。

示例：

```text
/repo=/Users/hero/Documents/workspace/heroverse 帮我跑 build 并修复报错
/repo=~/Documents/workspace/heroverse 检查项目结构并总结
```

发送任务后，机器人会回复一张待确认卡片，可以直接点「确认执行」或「拒绝执行」。也可以手动回复：

```text
/approve <taskId>
```

拒绝执行：

```text
/reject <taskId>
```

`/repos` 会说明当前路径策略：没有路径白名单，所有存在目录都可提交，但需要确认。

`/clear` 会清空已结束任务的数据库记录和对应日志目录，并清空当前飞书会话下当前用户的短期记忆；正在等待确认、排队或运行中的任务会保留。

`/stop <taskId>` 会取消未开始任务；如果任务正在运行，会向 Codex 子进程发送 `SIGTERM`，必要时数秒后强制结束。运行中任务卡片也会提供「中断任务」按钮。

`/file <taskId>` 会把任务回执文件 `final.txt` 上传并发送到当前飞书会话。也可以指定产物：

```text
/file <taskId> summary
/file <taskId> diff
/file <taskId> stat
/file <taskId> jsonl
/file <taskId> stderr
```

如果上一轮任务已经生成产物，直接说「把上次结果以文件形式发我」「把 diff 发我」也会尝试发送对应文件。若 Codex 回复里包含本机文件链接，或上下文能定位到当前项目的 README，也可以直接说「把这个以文件形式发我」「把 README 文件发我」，机器人会优先上传真实项目文件。飞书即时消息文件上传限制为 30MB，空文件不会发送。

`/sendfile <本机文件路径>` 可以发送白名单用户明确指定的本机文件，例如：

```text
/sendfile /Users/hero/Documents/report.pdf
/sendfile "/Users/hero/Documents/file with spaces.txt"
```

## 数据与日志

任务记录保存在：

```text
data/agent.sqlite
```

其中 `conversation_state` 保存每个会话/用户的最近项目和任务，`conversation_messages` 保存短期上下文消息。

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
- 默认回发飞书只发送摘要和本地日志路径；白名单用户可用 `/file` 将指定任务产物作为飞书文件发送，也可用 `/sendfile` 发送明确指定的本机文件。
- 任务全局 FIFO 串行执行，避免多个 Codex 任务同时修改同一工作区。
- `/cancel` 和 `/stop` 对未开始任务会直接取消；对运行中任务会尝试终止 Codex 子进程。

## 验证清单

1. 运行 `npm run build`。
2. 运行 `npm run lint`。
3. 在飞书发送 `/help`，确认机器人回复。
4. 使用非白名单用户发送命令，确认被拒绝。
5. 使用不存在的目录发送命令，确认被拒绝。
6. 使用存在目录发送只读任务，确认任务停在 `pending_confirmation`。
7. 点击卡片「确认执行」或回复 `/approve <taskId>`，确认任务开始执行并生成记录、JSONL 和飞书回执。
8. 点击运行中任务卡片「中断任务」或回复 `/stop <taskId>`，确认任务被取消。
9. 使用 `/file <taskId> summary`，确认飞书收到 `final.txt` 文件。
10. 使用 `/sendfile <本机文件路径>`，确认飞书收到指定本机文件。
11. 使用小改动任务，确认生成 `git-diff.patch` 且不会自动 commit/push。
