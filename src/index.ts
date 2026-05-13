import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { loadConfig, type AppConfig } from './config.js';
import {
  createFeishuClient,
  type FeishuAgentClient
} from './feishu/client.js';
import {
  formatHelpText,
  parseCodexCommand
} from './feishu/messages.js';
import { CodexRunner } from './codex/runner.js';
import {
  describeRepoAccessPolicy,
  isAllowedUser,
  resolveRepoPath
} from './security/policy.js';
import {
  formatKnownProjects,
  resolveProjectIntent
} from './projects/resolver.js';
import { TaskQueue } from './tasks/queue.js';
import { TaskStore } from './tasks/store.js';
import type { FeishuTextMessage, ParsedCodexCommand } from './types/feishu.js';
import type { TaskRecord } from './types/tasks.js';
import { logger } from './utils/logger.js';

type AppRuntime = {
  config: AppConfig;
  store: TaskStore;
  queue: TaskQueue;
  feishuClient: FeishuAgentClient;
};

const FEISHU_MESSAGE_MAX_LENGTH = 3500;
const DEFAULT_WORKSPACE_DIR = path.resolve('..');

async function main(): Promise<void> {
  const config = loadConfig();
  logger.level = config.logLevel;
  const chatWorkspaceDir = path.join(config.dataDir, 'chat-workspace');
  mkdirSync(chatWorkspaceDir, { recursive: true });

  const store = new TaskStore(config.dataDir);
  const runner = new CodexRunner(config, store);
  let feishuClient: FeishuAgentClient | null = null;

  const sendText = async (chatId: string, text: string): Promise<void> => {
    if (!feishuClient) {
      throw new Error('Feishu client is not initialized');
    }

    await feishuClient.sendText(chatId, truncateFeishuMessage(text));
  };

  const queue = new TaskQueue(store, runner, {
    onTaskStarted: async (task) => {
      if (isChatTask(task, chatWorkspaceDir)) {
        await sendText(task.chatId, '我收到啦，正在让 Codex 思考。');
        return;
      }

      await sendText(
        task.chatId,
        [
          `任务开始执行：${task.id}`,
          `仓库：${task.repo}`,
          `本地数据库：${store.dbPath}`
        ].join('\n')
      );
    },
    onTaskSucceeded: async (_task, result) => {
      if (isChatTask(result.task, chatWorkspaceDir)) {
        await sendText(result.task.chatId, result.finalMessage ?? result.summary);
        return;
      }

      await sendText(result.task.chatId, result.summary);
    },
    onTaskFailed: async (_task, result) => {
      await sendText(result.task.chatId, result.summary);
    },
    onTaskErrored: async (task, errorMessage) => {
      await sendText(
        task.chatId,
        [
          `任务失败：${task.id}`,
          `仓库：${task.repo}`,
          '',
          '错误摘要：',
          errorMessage
        ].join('\n')
      );
    },
    onTaskCancelled: async (task, reason) => {
      await sendText(
        task.chatId,
        [`任务已取消：${task.id}`, `原因：${reason}`].join('\n')
      );
    }
  });

  feishuClient = createFeishuClient({
    config,
    onTextMessage: async (message) => {
      if (!message) {
        return;
      }

      try {
        await handleTextMessage(message, {
          config,
          store,
          queue,
          sendText
        });
      } catch (error) {
        logger.error(
          {
            chatId: message.chatId,
            messageId: message.messageId,
            error: error instanceof Error ? error.message : String(error)
          },
          'Failed to handle Feishu text message'
        );
      }
    }
  });

  const runtime: AppRuntime = {
    config,
    store,
    queue,
    feishuClient
  };

  registerShutdown(runtime);
  await feishuClient.start();

  logger.info(
    {
      dataDir: config.dataDir,
      workspaceDir: DEFAULT_WORKSPACE_DIR,
      chatWorkspaceDir,
      allowedUserCount: config.allowedUserIds.length
    },
    'Feishu Codex Agent started'
  );
}

async function handleTextMessage(
  message: FeishuTextMessage,
  context: {
    config: AppConfig;
    store: TaskStore;
    queue: TaskQueue;
    sendText: (chatId: string, text: string) => Promise<void>;
  }
): Promise<void> {
  const command = parseCodexCommand(message);

  logger.info(
    {
      chatId: message.chatId,
      messageId: message.messageId,
      senderUserId: message.senderUserId,
      commandType: command.type
    },
    'Parsed Feishu command'
  );

  if (command.type === 'help') {
    await context.sendText(message.chatId, formatHelpText());
    return;
  }

  if (!isAllowedUser(message.senderUserId, context.config)) {
    await context.sendText(
      message.chatId,
      [
        '你不在 FEISHU_ALLOWED_USER_IDS 白名单中。',
        `当前识别到的 sender ID：${message.senderUserId}`,
        '把这个值加入 .env 后重启 Agent 即可。'
      ].join('\n')
    );
    return;
  }

  if (command.type === 'ignore') {
    await handleNaturalMessage(message, context);
    return;
  }

  await handleAuthorizedCommand(command, context);
}

async function handleAuthorizedCommand(
  command: Exclude<ParsedCodexCommand, { type: 'ignore' | 'help' }>,
  context: {
    config: AppConfig;
    store: TaskStore;
    queue: TaskQueue;
    sendText: (chatId: string, text: string) => Promise<void>;
  }
): Promise<void> {
  switch (command.type) {
    case 'invalid':
      await context.sendText(
        command.message.chatId,
        `${command.reason}\n\n${formatHelpText()}`
      );
      return;
    case 'repos':
      await context.sendText(
        command.message.chatId,
        `${describeRepoAccessPolicy()}\n\n我能识别到的项目：\n${formatKnownProjects(DEFAULT_WORKSPACE_DIR)}`
      );
      return;
    case 'clear':
      await clearFinishedTaskRecords(command.message, context);
      return;
    case 'status':
      await context.sendText(
        command.message.chatId,
        formatTaskStatus(context.store.getTask(command.taskId), command.taskId)
      );
      return;
    case 'approve':
      await approveTask(command.taskId, command.message, context);
      return;
    case 'reject':
      await rejectTask(command.taskId, command.message, context);
      return;
    case 'cancel': {
      const result = await context.queue.cancelTask(command.taskId);
      await context.sendText(command.message.chatId, result.message);
      return;
    }
    case 'task':
      await createAndEnqueueTask(command, context);
      return;
  }
}

async function handleNaturalMessage(
  message: FeishuTextMessage,
  context: {
    config: AppConfig;
    store: TaskStore;
    queue: TaskQueue;
    sendText: (chatId: string, text: string) => Promise<void>;
  }
): Promise<void> {
  const projectIntent = resolveProjectIntent(message.text, DEFAULT_WORKSPACE_DIR);

  if (projectIntent.type === 'matched') {
    await createPendingProjectTask(
      {
        message,
        repo: projectIntent.repoPath,
        prompt: projectIntent.prompt,
        projectName: projectIntent.projectName
      },
      context
    );
    return;
  }

  if (projectIntent.type === 'missing') {
    await context.sendText(message.chatId, projectIntent.reason);
    return;
  }

  const task = context.store.createTask({
    feishuMessageId: message.messageId,
    chatId: message.chatId,
    userId: message.senderUserId,
    repo: path.join(context.config.dataDir, 'chat-workspace'),
    prompt: buildChatPrompt(message.text),
    status: 'queued'
  });
  const queueLength = context.queue.enqueue(task);

  await context.sendText(
    message.chatId,
    [`已收到，我会用 Codex 回复。`, `队列长度：${queueLength}`].join('\n')
  );
}

async function createAndEnqueueTask(
  command: Extract<ParsedCodexCommand, { type: 'task' }>,
  context: {
    config: AppConfig;
    store: TaskStore;
    queue: TaskQueue;
    sendText: (chatId: string, text: string) => Promise<void>;
  }
): Promise<void> {
  let repo: string;

  try {
    repo = resolveRepoPath(command.repoInput);
  } catch (error) {
    await context.sendText(
      command.message.chatId,
      `路径校验失败：${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const task = context.store.createTask({
    feishuMessageId: command.message.messageId,
    chatId: command.message.chatId,
    userId: command.message.senderUserId,
    repo,
    prompt: command.prompt,
    status: 'pending_confirmation'
  });

  await context.sendText(
    command.message.chatId,
    [
      `已创建待确认任务：${task.id}`,
      `状态：pending_confirmation`,
      `仓库：${task.repo}`,
      '',
      '任务描述：',
      command.prompt,
      '',
      '确认执行：',
      `/approve ${task.id}`,
      '',
      '拒绝执行：',
      `/reject ${task.id}`
    ].join('\n')
  );
}

async function createPendingProjectTask(
  input: {
    message: FeishuTextMessage;
    repo: string;
    prompt: string;
    projectName: string;
  },
  context: {
    store: TaskStore;
    sendText: (chatId: string, text: string) => Promise<void>;
  }
): Promise<void> {
  const task = context.store.createTask({
    feishuMessageId: input.message.messageId,
    chatId: input.message.chatId,
    userId: input.message.senderUserId,
    repo: input.repo,
    prompt: input.prompt,
    status: 'pending_confirmation'
  });

  await context.sendText(
    input.message.chatId,
    [
      `我识别到你想处理项目：${input.projectName}`,
      `已创建待确认任务：${task.id}`,
      `状态：pending_confirmation`,
      `仓库：${task.repo}`,
      '',
      '任务描述：',
      input.prompt,
      '',
      '确认执行：',
      `/approve ${task.id}`,
      '',
      '拒绝执行：',
      `/reject ${task.id}`
    ].join('\n')
  );
}

async function clearFinishedTaskRecords(
  message: FeishuTextMessage,
  context: {
    config: AppConfig;
    store: TaskStore;
    sendText: (chatId: string, text: string) => Promise<void>;
  }
): Promise<void> {
  const result = context.store.clearFinishedTasks();
  let deletedLogDirCount = 0;
  const failedLogDirs: string[] = [];

  for (const taskId of result.taskIds) {
    const logsDir = path.join(context.config.dataDir, 'logs', taskId);

    if (!existsSync(logsDir)) {
      continue;
    }

    try {
      rmSync(logsDir, { recursive: true, force: true });
      deletedLogDirCount += 1;
    } catch (error) {
      failedLogDirs.push(
        `${logsDir}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  await context.sendText(
    message.chatId,
    formatClearResult({
      deletedTaskCount: result.deletedTaskCount,
      deletedEventCount: result.deletedEventCount,
      deletedArtifactCount: result.deletedArtifactCount,
      deletedLogDirCount,
      preservedActiveTaskCount: result.preservedActiveTaskCount,
      failedLogDirs
    })
  );
}

async function approveTask(
  taskId: string,
  message: FeishuTextMessage,
  context: {
    store: TaskStore;
    queue: TaskQueue;
    sendText: (chatId: string, text: string) => Promise<void>;
  }
): Promise<void> {
  const task = context.store.getTask(taskId);

  if (!task) {
    await context.sendText(message.chatId, `未找到任务：${taskId}`);
    return;
  }

  if (task.status !== 'pending_confirmation') {
    await context.sendText(
      message.chatId,
      `任务当前状态为 ${task.status}，不能重复确认。`
    );
    return;
  }

  const queuedTask = context.store.updateTaskStatus(task.id, {
    status: 'queued'
  });
  const queueLength = context.queue.enqueue(queuedTask);

  await context.sendText(
    message.chatId,
    [
      `已确认并入队：${task.id}`,
      `状态：queued`,
      `仓库：${task.repo}`,
      `队列长度：${queueLength}`,
      `本地数据库：${context.store.dbPath}`
    ].join('\n')
  );
}

async function rejectTask(
  taskId: string,
  message: FeishuTextMessage,
  context: {
    store: TaskStore;
    sendText: (chatId: string, text: string) => Promise<void>;
  }
): Promise<void> {
  const task = context.store.getTask(taskId);

  if (!task) {
    await context.sendText(message.chatId, `未找到任务：${taskId}`);
    return;
  }

  if (task.status !== 'pending_confirmation') {
    await context.sendText(
      message.chatId,
      `任务当前状态为 ${task.status}，不能拒绝。`
    );
    return;
  }

  context.store.updateTaskStatus(task.id, {
    status: 'cancelled',
    errorMessage: '任务被拒绝执行'
  });

  await context.sendText(message.chatId, `已拒绝执行任务：${task.id}`);
}

function formatTaskStatus(task: TaskRecord | null, taskId: string): string {
  if (!task) {
    return `未找到任务：${taskId}`;
  }

  return [
    `任务 ID：${task.id}`,
    `状态：${task.status}`,
    `仓库：${task.repo}`,
    `创建时间：${task.createdAt}`,
    `开始时间：${task.startedAt ?? '-'}`,
    `结束时间：${task.finishedAt ?? '-'}`,
    `错误：${task.errorMessage ?? '-'}`
  ].join('\n');
}

function formatClearResult(input: {
  deletedTaskCount: number;
  deletedEventCount: number;
  deletedArtifactCount: number;
  deletedLogDirCount: number;
  preservedActiveTaskCount: number;
  failedLogDirs: string[];
}): string {
  const lines = [
    '已清空已结束任务记录。',
    `任务记录：${input.deletedTaskCount}`,
    `事件记录：${input.deletedEventCount}`,
    `产物记录：${input.deletedArtifactCount}`,
    `日志目录：${input.deletedLogDirCount}`
  ];

  if (input.preservedActiveTaskCount > 0) {
    lines.push(`保留未结束任务：${input.preservedActiveTaskCount}`);
  }

  if (input.failedLogDirs.length > 0) {
    lines.push('', '以下日志目录删除失败：', ...input.failedLogDirs.slice(0, 3));
  }

  return lines.join('\n');
}

function truncateFeishuMessage(text: string): string {
  if (text.length <= FEISHU_MESSAGE_MAX_LENGTH) {
    return text;
  }

  return `${text.slice(0, FEISHU_MESSAGE_MAX_LENGTH - 30)}\n...消息过长，已截断`;
}

function isChatTask(task: TaskRecord, chatWorkspaceDir: string): boolean {
  return task.repo === chatWorkspaceDir;
}

function buildChatPrompt(text: string): string {
  return [
    '你是运行在飞书机器人背后的 Codex。请用中文自然回复用户。',
    '如果用户只是寒暄，就简短友好地回应。',
    '如果用户要求操作代码项目，但没有给出项目名或路径，请提醒用户补充项目名或路径。',
    '不要声称已经修改了项目，除非你确实被要求并进入了项目任务执行流程。',
    '',
    '用户消息：',
    text
  ].join('\n');
}

function registerShutdown(runtime: AppRuntime): void {
  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'Shutting down Feishu Codex Agent');
    runtime.feishuClient.close();
    runtime.store.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  logger.fatal(
    { error: error instanceof Error ? error.message : String(error) },
    'Feishu Codex Agent failed to start'
  );
  process.exit(1);
});
