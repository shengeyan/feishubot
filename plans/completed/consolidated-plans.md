# 已完成 Plan 汇总

---

## feishu-codex-local-agent-plan.md

- 完成时间：2026-05-13
- 来源：plans/feishu-codex-local-agent-plan.md

# 飞书长连接控制本机 Codex Agent 方案

## 概要

本计划用于落地“手机飞书给机器人发送消息 -> 本机 Agent 接收 -> 调用本机 Codex 处理代码任务 -> 飞书返回进度与结果 -> 本地保存双边记录”的方案 A。第一版聚焦个人本机使用，不引入云端中转，不自动 commit、push 或部署。

## 目标

- 搭建一个运行在本机的 Feishu Codex Agent。
- 通过飞书自建应用机器人与长连接事件接收文本任务。
- 校验白名单用户与白名单仓库，避免越权执行。
- 将飞书消息转换为本地任务，串行调用 `codex exec --json`。
- 将任务开始、完成、失败等状态回发飞书。
- 在本地保存任务记录、Codex JSONL、最终摘要和 diff。
- 为后续扩展“飞书卡片二次确认 commit/push/重试/取消”预留结构。

## 非目标

- 第一版不实现云端任务中转。
- 第一版不自动执行 `git push`、部署、发布或生产数据库操作。
- 第一版不做多机器 Worker 调度。
- 第一版不实现完整 Web 管理后台。
- 第一版不使用 `danger-full-access` 作为默认 Codex 执行模式。

## 影响范围

**主要文件：**
- `package.json`
- `tsconfig.json`
- `.env.example`
- `src/index.ts`
- `src/config.ts`
- `src/feishu/client.ts`
- `src/feishu/messages.ts`
- `src/tasks/store.ts`
- `src/tasks/queue.ts`
- `src/codex/runner.ts`
- `src/codex/parser.ts`
- `src/security/policy.ts`
- `src/utils/logger.ts`

**运行时目录：**
- `data/agent.sqlite`
- `data/logs/<taskId>/codex.jsonl`
- `data/logs/<taskId>/final.txt`
- `data/logs/<taskId>/git-diff.patch`

**可能不改但需核对：**
- 飞书开放平台应用配置
- 本机 Codex CLI 登录状态
- 本机目标项目 Git 状态与依赖安装状态
- macOS `launchd` 或 `pm2` 常驻进程配置

## Step Plan

- [ ] **Step 1: 初始化 Node.js TypeScript 项目**
  - 在项目根目录创建 `package.json`、`tsconfig.json`、`.env.example`。
  - 配置脚本：`dev`、`build`、`start`、`lint`。
  - 选择依赖：飞书 Node SDK、SQLite 客户端、dotenv、zod、execa 或 Node `child_process`、pino 或同类日志库。
  - 在 `.env.example` 中声明 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_ALLOWED_USER_IDS`、`CODEX_ALLOWED_REPOS`、`TASK_TIMEOUT_MS`。

- [ ] **Step 2: 定义配置与安全策略**
  - 新增 `src/config.ts`，使用 `zod` 或等价方式校验环境变量。
  - 新增 `src/security/policy.ts`，实现 `isAllowedUser(userId)`、`resolveAllowedRepo(input)`、`assertRepoAllowed(repoPath)`。
  - `CODEX_ALLOWED_REPOS` 支持别名映射或绝对路径列表，例如 `heroverse=/Users/hero/Documents/workspace/heroverse`。
  - 所有仓库路径必须解析为绝对路径，并确认位于白名单内。

- [ ] **Step 3: 接入飞书长连接与消息发送**
  - 新增 `src/feishu/client.ts`，初始化飞书 SDK 客户端。
  - 使用飞书长连接能力订阅机器人消息事件，重点处理 `im.message.receive_v1`。
  - 实现 `sendText(chatId, text)`，用于回发普通文本消息。
  - 预留 `sendCard(chatId, card)` 或 `updateCard(messageId, card)`，后续支持按钮确认。

- [ ] **Step 4: 解析飞书任务消息**
  - 新增 `src/feishu/messages.ts`。
  - 支持命令格式：
    - `/codex repo=heroverse 帮我修复项目成员页面权限问题`
    - `/codex repo=/Users/hero/Documents/workspace/heroverse 帮我跑 build 并修复报错`
  - 解析出 `repo`、`prompt`、`chatId`、`messageId`、`senderUserId`。
  - 对非 `/codex` 消息默认忽略或回复简短帮助文案。
  - 对缺少 `repo` 或 `prompt` 的消息返回格式提示。

- [ ] **Step 5: 建立 SQLite 任务存储**
  - 新增 `src/tasks/store.ts`。
  - 初始化 `data/agent.sqlite`。
  - 建表 `tasks`，字段包括 `id`、`feishu_message_id`、`chat_id`、`user_id`、`repo`、`prompt`、`status`、`created_at`、`started_at`、`finished_at`、`final_summary`、`error_message`。
  - 建表 `task_events`，字段包括 `id`、`task_id`、`type`、`content`、`raw_json`、`created_at`。
  - 建表 `task_artifacts`，字段包括 `id`、`task_id`、`kind`、`path`、`created_at`。
  - 提供 `createTask`、`updateTaskStatus`、`appendTaskEvent`、`addArtifact`、`getTask` 方法。

- [ ] **Step 6: 实现本机串行任务队列**
  - 新增 `src/tasks/queue.ts`。
  - 第一版使用进程内 FIFO 队列，保证同一时间只执行一个 Codex 任务。
  - 同一仓库任务必须串行，避免并发修改同一工作区。
  - 支持状态流转：`queued -> running -> succeeded`、`queued -> running -> failed`、`running -> cancelled`。
  - 预留 `cancelTask(taskId)`，第一版可先标记状态，后续再接入子进程 kill。

- [ ] **Step 7: 封装 Codex 执行器**
  - 新增 `src/codex/runner.ts`。
  - 通过子进程调用：
    ```bash
    codex exec --json -C <repoPath> -s workspace-write -a never "<prompt>"
    ```
  - 为任务创建日志目录 `data/logs/<taskId>/`。
  - 将 stdout JSONL 原样写入 `codex.jsonl`。
  - 将 stderr 写入 `stderr.log` 或作为 `task_events` 记录。
  - 设置 `TASK_TIMEOUT_MS`，超时后终止子进程并标记失败。
  - 执行结束后运行 `git diff --stat` 和 `git diff`，分别生成摘要与 `git-diff.patch`。

- [ ] **Step 8: 解析 Codex 输出与生成飞书回执**
  - 新增 `src/codex/parser.ts`。
  - 解析 `codex exec --json` 输出中的最终消息、错误事件和重要进度事件。
  - 如果 JSONL 中没有可用最终消息，回退读取子进程退出码、stderr 和 diff 摘要。
  - 完成时生成飞书摘要：任务 ID、仓库、修改文件、验证结果、最终说明、本地日志路径。
  - 失败时生成飞书摘要：任务 ID、失败阶段、错误摘要、本地日志路径、是否可重试。

- [ ] **Step 9: 串联入口流程**
  - 修改 `src/index.ts`。
  - 启动时加载配置、初始化 SQLite、初始化飞书客户端、注册事件处理器。
  - 收到飞书消息后执行：解析消息 -> 校验用户 -> 校验仓库 -> 创建任务 -> 回发“已创建任务” -> 入队执行。
  - 任务开始时回发“正在执行”。
  - 任务完成或失败时回发最终结果。
  - 所有异常必须写入 `task_events`，并尽量回发飞书错误摘要。

- [ ] **Step 10: 增加基础操作命令**
  - 支持 `/codex help`，返回命令格式与可用仓库别名。
  - 支持 `/codex status <taskId>`，查询任务状态。
  - 支持 `/codex cancel <taskId>`，取消未开始任务；运行中任务先做状态标记，后续增强为终止子进程。
  - 支持 `/codex repos`，返回当前白名单仓库列表或别名列表。

- [ ] **Step 11: 增加本地运行与常驻说明**
  - 在 `README.md` 中说明飞书开放平台需要开启的能力：机器人、事件订阅、长连接、接收消息事件、发送消息权限。
  - 说明 `.env` 配置示例和白名单配置方式。
  - 说明开发运行：`npm run dev`。
  - 说明生产运行：`npm run build && npm run start`。
  - 说明可选常驻方式：`pm2` 或 macOS `launchd`。

- [ ] **Step 12: 验证端到端链路**
  - 使用飞书向机器人发送 `/codex help`，确认本机 Agent 可收到并回复。
  - 使用非白名单用户发送命令，确认被拒绝。
  - 使用非白名单仓库路径发送命令，确认被拒绝。
  - 使用白名单仓库发送一个只读任务，例如“检查项目结构并总结”，确认 Codex 可执行并回发结果。
  - 使用白名单仓库发送一个小改动任务，确认可生成 diff、日志和最终摘要。
  - 检查 `data/agent.sqlite`、`data/logs/<taskId>/codex.jsonl`、`git-diff.patch` 是否完整。

## 预期结果

- 用户可以在手机飞书中通过机器人下发 Codex 代码任务。
- 本机 Agent 可以接收飞书长连接消息并调用本机 Codex CLI。
- Agent 可以把任务创建、执行中、完成、失败状态回发飞书。
- 本机可以保存完整任务记录、Codex JSONL、最终摘要和 diff。
- 非授权用户和非白名单仓库无法触发本机代码处理。

## 假设

- 本机已安装并登录 Codex CLI，且 `codex exec --help` 可正常运行。
- 本机网络可以访问飞书开放平台长连接服务。
- 飞书自建应用已创建，并具备机器人、事件订阅和发送消息权限。
- 目标代码仓库位于本机，且可由当前用户读写。
- 第一版只服务个人或少量白名单用户，不需要多租户隔离。

## 风险

- **飞书权限配置不完整：** 可能收不到事件或无法回发消息。应在 README 中列出所需权限，并用 `/codex help` 做连通性验证。
- **Codex 任务运行时间过长：** 可能导致用户不清楚当前状态。应定时回发进度或至少在开始、结束、失败时回发消息。
- **同一仓库并发修改冲突：** 第一版必须串行执行同一仓库任务。
- **日志泄露敏感信息：** 回发飞书时只发摘要和本地日志路径，避免直接发送完整 diff、token、密钥或环境变量。
- **`-a never` 导致命令失败无法交互审批：** 第一版接受该限制，失败后由用户在飞书中发起后续任务或本机人工处理。
- **本机休眠或关机：** Agent 无法处理任务。该方案要求本机开机、联网且 Agent 进程运行。

## 验证建议

- 运行 `npm run build`，确认 TypeScript 编译通过。
- 运行本地单元测试或最小脚本，验证消息解析、仓库白名单、用户白名单。
- 在飞书发送 `/codex help`，确认机器人回复正常。
- 在飞书发送一个只读 Codex 任务，确认任务记录、日志和飞书回执完整。
- 在飞书发送一个小范围代码修改任务，确认 diff 文件生成且不会自动 commit/push。
- 手动中断 Codex 子进程或模拟失败，确认任务状态变为 `failed`，飞书收到错误摘要。
