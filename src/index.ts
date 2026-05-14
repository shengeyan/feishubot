import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type * as Lark from '@larksuiteoapi/node-sdk';

import { loadConfig, type AppConfig } from './config.js';
import {
  createFeishuClient,
  type FeishuCardActionEvent,
  type FeishuAgentClient
} from './feishu/client.js';
import {
  buildCancelledTaskCard,
  buildPendingTaskCard,
  buildQueuedTaskCard,
  buildRunningTaskCard,
  buildTaskInfoCard,
  parseTaskCardActionValue
} from './feishu/cards.js';
import {
  formatHelpText,
  parseCodexCommand
} from './feishu/messages.js';
import { CodexRunner } from './codex/runner.js';
import {
  describeRepoAccessPolicy,
  isAllowedUser,
  resolveLocalFilePath,
  resolveRepoPath
} from './security/policy.js';
import {
  formatKnownProjects,
  resolveProjectIntent
} from './projects/resolver.js';
import { TaskQueue } from './tasks/queue.js';
import { TaskStore } from './tasks/store.js';
import type { FeishuTextMessage, ParsedCodexCommand } from './types/feishu.js';
import type {
  ArtifactKind,
  ConversationContext,
  TaskArtifactRecord,
  TaskRecord
} from './types/tasks.js';
import { logger } from './utils/logger.js';

type AppRuntime = {
  config: AppConfig;
  store: TaskStore;
  queue: TaskQueue;
  feishuClient: FeishuAgentClient;
};

const FEISHU_MESSAGE_MAX_LENGTH = 3500;
const CONVERSATION_HISTORY_LIMIT = 8;
const MEMORY_SNIPPET_MAX_LENGTH = 900;
const DEFAULT_WORKSPACE_DIR = path.resolve('..');

type MessageContext = {
  config: AppConfig;
  store: TaskStore;
  queue: TaskQueue;
  sendText: (chatId: string, text: string) => Promise<void>;
  sendFile: (chatId: string, filePath: string, fileName?: string) => Promise<void>;
  sendCard: (chatId: string, card: Lark.InteractiveCard) => Promise<void>;
};

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

  const sendCard = async (
    chatId: string,
    card: Lark.InteractiveCard
  ): Promise<void> => {
    if (!feishuClient) {
      throw new Error('Feishu client is not initialized');
    }

    await feishuClient.sendCard(chatId, card);
  };

  const sendFile = async (
    chatId: string,
    filePath: string,
    fileName?: string
  ): Promise<void> => {
    if (!feishuClient) {
      throw new Error('Feishu client is not initialized');
    }

    await feishuClient.sendFile(chatId, filePath, fileName);
  };

  const queue = new TaskQueue(store, runner, {
    onTaskStarted: async (task) => {
      if (isChatTask(task, chatWorkspaceDir)) {
        await sendText(task.chatId, '我收到啦，正在让 Codex 思考。');
        return;
      }

      await sendCardWithFallback(
        sendCard,
        sendText,
        task.chatId,
        buildRunningTaskCard(task),
        [
          `任务开始执行：${task.id}`,
          `仓库：${task.repo}`,
          `本地数据库：${store.dbPath}`,
          '',
          '中断任务：',
          `/stop ${task.id}`
        ].join('\n')
      );
    },
    onTaskSucceeded: async (_task, result) => {
      rememberAssistantResult(
        store,
        result.task,
        result.finalMessage ?? result.summary,
        chatWorkspaceDir
      );

      if (isChatTask(result.task, chatWorkspaceDir)) {
        await sendText(result.task.chatId, result.finalMessage ?? result.summary);
        return;
      }

      await sendText(result.task.chatId, result.summary);
    },
    onTaskFailed: async (_task, result) => {
      rememberAssistantResult(store, result.task, result.summary, chatWorkspaceDir);
      await sendText(result.task.chatId, result.summary);
    },
    onTaskErrored: async (task, errorMessage) => {
      rememberAssistantResult(store, task, errorMessage, chatWorkspaceDir);
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
          sendText,
          sendFile,
          sendCard
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
    },
    onCardAction: async (event) => {
      try {
        return await handleCardAction(event, {
          config,
          store,
          queue,
          sendText,
          sendFile,
          sendCard
        });
      } catch (error) {
        logger.error(
          {
            event,
            error: error instanceof Error ? error.message : String(error)
          },
          'Failed to handle Feishu card action'
        );
        return buildTaskInfoCard({
          title: '操作失败',
          template: 'red',
          body: error instanceof Error ? error.message : String(error)
        });
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
  context: MessageContext
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
  context: MessageContext
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
    case 'stop': {
      const result = await context.queue.cancelTask(command.taskId);
      await context.sendText(command.message.chatId, result.message);
      return;
    }
    case 'file':
      await sendTaskArtifactFile(command, context);
      return;
    case 'send_file':
      await sendLocalFileCommand(command, context);
      return;
    case 'task':
      await createAndEnqueueTask(command, context);
      return;
  }
}

async function handleNaturalMessage(
  message: FeishuTextMessage,
  context: MessageContext
): Promise<void> {
  const memory = context.store.getConversationContext(
    message.chatId,
    message.senderUserId,
    CONVERSATION_HISTORY_LIMIT
  );
  const projectIntent = resolveProjectIntent(message.text, DEFAULT_WORKSPACE_DIR);
  const rememberedProject = getRememberedProject(memory);
  const rememberedTaskId = memory.state?.lastTaskId;
  const localFileTarget = resolveNaturalLocalFileSendTarget({
    text: message.text,
    memory,
    projectIntent,
    rememberedProject
  });

  if (localFileTarget) {
    await sendResolvedLocalFile(message, localFileTarget, context);
    return;
  }

  if (rememberedTaskId && looksLikeTaskArtifactSendRequest(message.text)) {
    await sendTaskArtifactFile(
      {
        type: 'file',
        message,
        taskId: rememberedTaskId,
        artifact: inferArtifactAliasFromText(message.text)
      },
      context
    );
    return;
  }

  if (projectIntent.type === 'matched') {
    await createPendingProjectTask(
      {
        message,
        repo: projectIntent.repoPath,
        prompt: projectIntent.prompt,
        projectName: projectIntent.projectName,
        memory
      },
      context
    );
    return;
  }

  if (
    rememberedProject &&
    looksLikeProjectFollowUp(message.text) &&
    !mentionsExplicitLocalPath(message.text)
  ) {
    await createPendingProjectTask(
      {
        message,
        repo: rememberedProject.repo,
        prompt: message.text,
        projectName: rememberedProject.projectName,
        memory,
        prefix: `我会沿用上一轮项目：${rememberedProject.projectName}`
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
    prompt: buildChatPrompt(message.text, memory),
    status: 'queued'
  });
  rememberUserTask(context.store, {
    message,
    task,
    content: message.text
  });
  const queueLength = context.queue.enqueue(task);

  await context.sendText(
    message.chatId,
    [`已收到，我会用 Codex 回复。`, `队列长度：${queueLength}`].join('\n')
  );
}

async function createAndEnqueueTask(
  command: Extract<ParsedCodexCommand, { type: 'task' }>,
  context: MessageContext
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

  const memory = context.store.getConversationContext(
    command.message.chatId,
    command.message.senderUserId,
    CONVERSATION_HISTORY_LIMIT
  );
  const projectName = path.basename(repo);
  const task = context.store.createTask({
    feishuMessageId: command.message.messageId,
    chatId: command.message.chatId,
    userId: command.message.senderUserId,
    repo,
    prompt: buildProjectPrompt(command.prompt, memory, {
      repo,
      projectName
    }),
    status: 'pending_confirmation'
  });
  rememberUserTask(context.store, {
    message: command.message,
    task,
    content: command.prompt,
    repo,
    projectName
  });

  await sendPendingTaskResponse(task, command.prompt, command.message.chatId, context);
}

async function createPendingProjectTask(
  input: {
    message: FeishuTextMessage;
    repo: string;
    prompt: string;
    projectName: string;
    memory: ConversationContext;
    prefix?: string;
  },
  context: MessageContext
): Promise<void> {
  const task = context.store.createTask({
    feishuMessageId: input.message.messageId,
    chatId: input.message.chatId,
    userId: input.message.senderUserId,
    repo: input.repo,
    prompt: buildProjectPrompt(input.prompt, input.memory, {
      repo: input.repo,
      projectName: input.projectName
    }),
    status: 'pending_confirmation'
  });
  rememberUserTask(context.store, {
    message: input.message,
    task,
    content: input.prompt,
    repo: input.repo,
    projectName: input.projectName
  });

  await sendPendingTaskResponse(
    task,
    input.prompt,
    input.message.chatId,
    context,
    input.prefix ?? `我识别到你想处理项目：${input.projectName}`
  );
}

async function sendPendingTaskResponse(
  task: TaskRecord,
  prompt: string,
  chatId: string,
  context: MessageContext,
  prefix?: string
): Promise<void> {
  const lines = [
    prefix,
    `已创建待确认任务：${task.id}`,
    `状态：pending_confirmation`,
    `仓库：${task.repo}`,
    '',
    '任务描述：',
    prompt,
    '',
    '也可以手动回复：',
    `/approve ${task.id}`,
    `/reject ${task.id}`
  ].filter((line): line is string => line !== undefined);

  await sendCardWithFallback(
    context.sendCard,
    context.sendText,
    chatId,
    buildPendingTaskCard(task, prompt),
    lines.join('\n')
  );
}

async function handleCardAction(
  event: FeishuCardActionEvent,
  context: MessageContext
): Promise<Lark.InteractiveCard | undefined> {
  const value = parseTaskCardActionValue(event.action?.value);

  if (!value) {
    return buildTaskInfoCard({
      title: '无法识别的操作',
      template: 'red',
      body: '这个按钮不是当前 Agent 生成的任务操作。'
    });
  }

  const task = context.store.getTask(value.taskId);
  const operatorUserId = extractCardActionOperatorUserId(event);

  if (!operatorUserId || !isAllowedUser(operatorUserId, context.config)) {
    return buildTaskInfoCard({
      title: '没有权限',
      template: 'red',
      task,
      body: [
        '你不在 FEISHU_ALLOWED_USER_IDS 白名单中。',
        `当前识别到的 sender ID：${operatorUserId ?? '-'}`
      ].join('\n')
    });
  }

  if (!task) {
    return buildTaskInfoCard({
      title: '未找到任务',
      template: 'red',
      body: `未找到任务：${value.taskId}`
    });
  }

  if (value.action === 'approve') {
    if (task.status !== 'pending_confirmation') {
      return buildTaskInfoCard({
        title: '任务不能重复确认',
        template: 'grey',
        task,
        body: `任务当前状态为 ${task.status}。`
      });
    }

    const queuedTask = context.store.updateTaskStatus(task.id, {
      status: 'queued'
    });
    const queueLength = context.queue.enqueue(queuedTask);

    return buildQueuedTaskCard(queuedTask, queueLength);
  }

  if (value.action === 'reject') {
    if (task.status !== 'pending_confirmation') {
      return buildTaskInfoCard({
        title: '任务不能拒绝',
        template: 'grey',
        task,
        body: `任务当前状态为 ${task.status}。`
      });
    }

    const cancelledTask = context.store.updateTaskStatus(task.id, {
      status: 'cancelled',
      errorMessage: '任务被拒绝执行'
    });

    return buildCancelledTaskCard(cancelledTask, '任务被拒绝执行');
  }

  const result = await context.queue.cancelTask(task.id, { notify: false });
  const latestTask = context.store.getTask(task.id) ?? task;

  if (result.cancelled && latestTask.status === 'cancelled') {
    return buildCancelledTaskCard(latestTask, result.message);
  }

  return buildTaskInfoCard({
    title: '任务无法中断',
    template: 'grey',
    task: latestTask,
    body: result.message
  });
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
  const conversationResult = context.store.clearConversation(
    message.chatId,
    message.senderUserId
  );
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
      deletedConversationMessageCount: conversationResult.deletedMessageCount,
      deletedConversationStateCount: conversationResult.deletedStateCount,
      failedLogDirs
    })
  );
}

async function approveTask(
  taskId: string,
  message: FeishuTextMessage,
  context: MessageContext
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

  await sendCardWithFallback(
    context.sendCard,
    context.sendText,
    message.chatId,
    buildQueuedTaskCard(queuedTask, queueLength),
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
  context: MessageContext
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

  const cancelledTask = context.store.updateTaskStatus(task.id, {
    status: 'cancelled',
    errorMessage: '任务被拒绝执行'
  });

  await sendCardWithFallback(
    context.sendCard,
    context.sendText,
    message.chatId,
    buildCancelledTaskCard(cancelledTask, '任务被拒绝执行'),
    `已拒绝执行任务：${task.id}`
  );
}

async function sendLocalFileCommand(
  command: Extract<ParsedCodexCommand, { type: 'send_file' }>,
  context: MessageContext
): Promise<void> {
  let filePath: string;

  try {
    filePath = resolveLocalFilePath(command.filePathInput);
  } catch (error) {
    await context.sendText(
      command.message.chatId,
      `文件校验失败：${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  try {
    await context.sendFile(command.message.chatId, filePath);
  } catch (error) {
    await context.sendText(
      command.message.chatId,
      `发送文件失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function sendResolvedLocalFile(
  message: FeishuTextMessage,
  filePath: string,
  context: MessageContext
): Promise<void> {
  try {
    await context.sendFile(message.chatId, filePath);
  } catch (error) {
    await context.sendText(
      message.chatId,
      `发送文件失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function sendTaskArtifactFile(
  command: Extract<ParsedCodexCommand, { type: 'file' }>,
  context: MessageContext
): Promise<void> {
  const task = context.store.getTask(command.taskId);

  if (!task) {
    await context.sendText(command.message.chatId, `未找到任务：${command.taskId}`);
    return;
  }

  if (task.chatId !== command.message.chatId) {
    await context.sendText(
      command.message.chatId,
      '出于安全考虑，只能在任务创建的飞书会话里发送该任务产物。'
    );
    return;
  }

  const kind = resolveArtifactKind(command.artifact);

  if (!kind) {
    await context.sendText(command.message.chatId, formatArtifactCommandHelp(task.id));
    return;
  }

  const artifacts = context.store.listTaskArtifacts(task.id);
  const artifact = artifacts
    .slice()
    .reverse()
    .find((item) => item.kind === kind);

  if (!artifact) {
    await context.sendText(
      command.message.chatId,
      [
        `任务 ${task.id} 还没有可发送的 ${getArtifactKindLabel(kind)} 产物。`,
        formatAvailableArtifacts(artifacts)
      ].join('\n')
    );
    return;
  }

  if (!existsSync(artifact.path)) {
    await context.sendText(
      command.message.chatId,
      `产物文件不存在，可能已被清理：${artifact.path}`
    );
    return;
  }

  try {
    await context.sendFile(
      command.message.chatId,
      artifact.path,
      buildArtifactFileName(task, artifact)
    );
    context.store.appendTaskEvent(
      task.id,
      'feishu.file.sent',
      `${getArtifactKindLabel(kind)} 已发送到飞书：${artifact.path}`
    );
  } catch (error) {
    await context.sendText(
      command.message.chatId,
      `发送文件失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
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

function resolveArtifactKind(value: string | undefined): ArtifactKind | null {
  if (!value) {
    return 'final_summary';
  }

  const normalized = value.toLowerCase();

  if (
    ['summary', 'final', 'result', 'receipt', 'final.txt', '结果', '摘要', '回执'].includes(
      normalized
    )
  ) {
    return 'final_summary';
  }

  if (
    ['diff', 'patch', 'git-diff', 'git_diff', 'git-diff.patch', '修改', '补丁'].includes(
      normalized
    )
  ) {
    return 'git_diff';
  }

  if (
    [
      'stat',
      'stats',
      'diff-stat',
      'git-diff-stat',
      'git_diff_stat',
      '统计'
    ].includes(normalized)
  ) {
    return 'git_diff_stat';
  }

  if (['jsonl', 'codex', 'raw', 'codex.jsonl', '原始'].includes(normalized)) {
    return 'codex_jsonl';
  }

  if (
    ['stderr', 'error', 'errors', 'stderr.log', 'log', '日志', '错误'].includes(
      normalized
    )
  ) {
    return 'stderr_log';
  }

  return null;
}

function formatArtifactCommandHelp(taskId: string): string {
  return [
    '不认识这个产物类型。',
    '',
    '可用格式：',
    `/file ${taskId} summary`,
    `/file ${taskId} diff`,
    `/file ${taskId} stat`,
    `/file ${taskId} jsonl`,
    `/file ${taskId} stderr`
  ].join('\n');
}

function formatAvailableArtifacts(artifacts: TaskArtifactRecord[]): string {
  if (artifacts.length === 0) {
    return '当前任务暂无本地产物。任务完成或失败后会生成可发送文件。';
  }

  return [
    '当前已有产物：',
    ...artifacts.map(
      (artifact) => `${getArtifactKindLabel(artifact.kind)}：${artifact.path}`
    )
  ].join('\n');
}

function getArtifactKindLabel(kind: ArtifactKind): string {
  switch (kind) {
    case 'final_summary':
      return 'summary';
    case 'git_diff':
      return 'diff';
    case 'git_diff_stat':
      return 'stat';
    case 'codex_jsonl':
      return 'jsonl';
    case 'stderr_log':
      return 'stderr';
  }
}

function buildArtifactFileName(
  task: TaskRecord,
  artifact: TaskArtifactRecord
): string {
  return `${task.id.slice(0, 8)}-${path.basename(artifact.path)}`;
}

async function sendCardWithFallback(
  sendCard: (chatId: string, card: Lark.InteractiveCard) => Promise<void>,
  sendText: (chatId: string, text: string) => Promise<void>,
  chatId: string,
  card: Lark.InteractiveCard,
  fallbackText: string
): Promise<void> {
  try {
    await sendCard(chatId, card);
  } catch (error) {
    logger.warn(
      { chatId, error: error instanceof Error ? error.message : String(error) },
      'Failed to send Feishu card, falling back to text'
    );
    await sendText(chatId, fallbackText);
  }
}

function extractCardActionOperatorUserId(
  event: FeishuCardActionEvent
): string | null {
  const operator = event.operator as
    | (Record<string, unknown> & {
        operator_id?: Record<string, unknown>;
      })
    | undefined;
  const nestedOperatorId = operator?.operator_id;

  return (
    asOptionalString(operator?.user_id) ??
    asOptionalString(operator?.open_id) ??
    asOptionalString(operator?.union_id) ??
    asOptionalString(nestedOperatorId?.user_id) ??
    asOptionalString(nestedOperatorId?.open_id) ??
    asOptionalString(nestedOperatorId?.union_id) ??
    event.user_id ??
    event.open_id ??
    null
  );
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function formatClearResult(input: {
  deletedTaskCount: number;
  deletedEventCount: number;
  deletedArtifactCount: number;
  deletedLogDirCount: number;
  preservedActiveTaskCount: number;
  deletedConversationMessageCount: number;
  deletedConversationStateCount: number;
  failedLogDirs: string[];
}): string {
  const lines = [
    '已清空已结束任务记录。',
    `任务记录：${input.deletedTaskCount}`,
    `事件记录：${input.deletedEventCount}`,
    `产物记录：${input.deletedArtifactCount}`,
    `日志目录：${input.deletedLogDirCount}`,
    `本会话记忆消息：${input.deletedConversationMessageCount}`,
    `本会话记忆状态：${input.deletedConversationStateCount}`
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

function getRememberedProject(
  memory: ConversationContext
): { repo: string; projectName: string } | null {
  const repo = memory.state?.lastRepo;

  if (!repo) {
    return null;
  }

  return {
    repo,
    projectName: memory.state?.lastProjectName ?? path.basename(repo)
  };
}

function looksLikeTaskArtifactSendRequest(text: string): boolean {
  const normalized = text.trim();

  if (!normalized) {
    return false;
  }

  return /(?:上次|上一轮|刚才|结果|摘要|回执|产物|diff|patch|日志|jsonl|stderr).*(?:文件|附件|发我|发送|给我|导出)|(?:文件|附件).*(?:上次|上一轮|刚才|结果|摘要|回执|产物|diff|patch|日志|jsonl|stderr)|以文件形式(?:发我|发送|给我)?/iu.test(
    normalized
  );
}

function inferArtifactAliasFromText(text: string): string | undefined {
  if (/diff|patch|补丁|修改/u.test(text)) {
    return 'diff';
  }

  if (/stat|统计/u.test(text)) {
    return 'stat';
  }

  if (/jsonl|原始/u.test(text)) {
    return 'jsonl';
  }

  if (/stderr|错误|日志|log/u.test(text)) {
    return 'stderr';
  }

  return undefined;
}

function resolveNaturalLocalFileSendTarget(input: {
  text: string;
  memory: ConversationContext;
  projectIntent: ReturnType<typeof resolveProjectIntent>;
  rememberedProject: { repo: string; projectName: string } | null;
}): string | null {
  if (!looksLikeLocalFileSendRequest(input.text)) {
    return null;
  }

  const explicitPath = resolveFirstExistingLocalFile(
    extractLocalPathCandidates(input.text)
  );

  if (explicitPath) {
    return explicitPath;
  }

  if (looksLikeTaskArtifactSpecificRequest(input.text)) {
    return null;
  }

  if (mentionsReadme(input.text)) {
    if (input.projectIntent.type === 'matched') {
      return findReadmeFile(input.projectIntent.repoPath);
    }

    if (input.rememberedProject) {
      return findReadmeFile(input.rememberedProject.repo);
    }
  }

  return resolveRecentReferencedLocalFile(input.text, input.memory);
}

function looksLikeLocalFileSendRequest(text: string): boolean {
  const normalized = text.trim();

  if (!normalized) {
    return false;
  }

  if (
    /(?:内容|全文|查看|看一下|总结)/u.test(normalized) &&
    !/(?:文件|附件|以文件形式|发我|发给我|发送|下载|导出|上传)/u.test(
      normalized
    )
  ) {
    return false;
  }

  return /(?:以文件形式|文件形式|附件|发文件|发送文件|发我|发给我|发送给我|发送|下载|导出|上传|给我)/iu.test(
    normalized
  ) && /(?:文件|附件|readme|README|这个|那个|它|这份|该文件|链接|\.[a-z0-9]{1,8})/iu.test(
    normalized
  );
}

function looksLikeTaskArtifactSpecificRequest(text: string): boolean {
  return /(?:结果|摘要|回执|产物|diff|patch|日志|jsonl|stderr|stat|统计)/iu.test(
    text
  );
}

function mentionsReadme(text: string): boolean {
  return /readme/i.test(text);
}

function findReadmeFile(repo: string): string | null {
  const preferredNames = [
    'README.md',
    'README.MD',
    'README',
    'README.txt',
    'Readme.md',
    'readme.md'
  ];

  for (const fileName of preferredNames) {
    const resolved = tryResolveLocalFilePath(path.join(repo, fileName));

    if (resolved) {
      return resolved;
    }
  }

  if (!existsSync(repo)) {
    return null;
  }

  for (const entry of readdirSync(repo, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().startsWith('readme')) {
      continue;
    }

    const resolved = tryResolveLocalFilePath(path.join(repo, entry.name));

    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function resolveRecentReferencedLocalFile(
  text: string,
  memory: ConversationContext
): string | null {
  const recentCandidates = memory.messages
    .slice()
    .reverse()
    .flatMap((message) => extractLocalPathCandidates(message.content));
  const resolvedCandidates = uniqueStrings(
    recentCandidates
      .map((candidate) => tryResolveLocalFilePath(candidate))
      .filter((candidate): candidate is string => Boolean(candidate))
  );

  if (resolvedCandidates.length === 0) {
    return null;
  }

  const lowerText = text.toLowerCase();
  const mentionedCandidate = resolvedCandidates.find((candidate) =>
    lowerText.includes(path.basename(candidate).toLowerCase())
  );

  if (mentionedCandidate) {
    return mentionedCandidate;
  }

  if (looksLikeReferencedFileFollowUp(text)) {
    return resolvedCandidates[0] ?? null;
  }

  return null;
}

function looksLikeReferencedFileFollowUp(text: string): boolean {
  return /(?:这个|那个|它|这份|该文件|链接|刚才|上面|前面|以文件形式|附件|发我|发给我|发送|下载|导出)/iu.test(
    text
  );
}

function extractLocalPathCandidates(text: string): string[] {
  const candidates: string[] = [];
  const patterns = [
    /\[[^\]]+\]\(((?:~|\/Users|\/Volumes|\/private|\/tmp|\/var)\/[^)]+)\)/gu,
    /["'“”‘’]((?:~|\/Users|\/Volumes|\/private|\/tmp|\/var)\/[^"'“”‘’]+)["'“”‘’]/gu,
    /(?:^|[\s，。；,;])((?:~|\/Users|\/Volumes|\/private|\/tmp|\/var)\/[^\s，。；,;)\]]+)/gu
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim();

      if (candidate) {
        candidates.push(stripTrailingPathPunctuation(candidate));
      }
    }
  }

  return uniqueStrings(candidates);
}

function stripTrailingPathPunctuation(value: string): string {
  return value.replace(/[。；;，,.)\]]+$/u, '');
}

function resolveFirstExistingLocalFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const resolved = tryResolveLocalFilePath(candidate);

    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function tryResolveLocalFilePath(filePath: string): string | null {
  try {
    return resolveLocalFilePath(filePath);
  } catch {
    return null;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function looksLikeProjectFollowUp(text: string): boolean {
  const normalized = text.trim();

  if (!normalized) {
    return false;
  }

  if (/^(?:你好|hi|hello|谢谢|多谢|辛苦了?|ok|好的|收到)[。.!！\s]*$/iu.test(normalized)) {
    return false;
  }

  return /上次|上一轮|上面|前面|刚才|刚刚|继续|同上|这个|那个|它|这份|该项目|再|重新|改成|换成|仍然|还是|顺便|另外|文件|readme|README|保存|导出|发我|以.+形式/u.test(
    normalized
  );
}

function mentionsExplicitLocalPath(text: string): boolean {
  return /(?:^|[\s，。；,;])(?:~|\/Users|\/Volumes|\/private|\/tmp|\/var)\//u.test(
    text
  );
}

function buildProjectPrompt(
  text: string,
  memory: ConversationContext,
  project: { repo: string; projectName: string }
): string {
  const contextLines = formatConversationContext(memory);

  if (contextLines.length === 0) {
    return text;
  }

  return [
    '你正在处理飞书会话里的本地项目任务。请结合近期上下文理解用户省略的指代。',
    `当前项目：${project.projectName}`,
    `当前项目路径：${project.repo}`,
    '',
    '近期上下文：',
    ...contextLines,
    '',
    '当前用户消息：',
    text
  ].join('\n');
}

function buildChatPrompt(text: string, memory: ConversationContext): string {
  const contextLines = formatConversationContext(memory);
  const lines = [
    '你是运行在飞书机器人背后的 Codex。请用中文自然回复用户。',
    '如果用户只是寒暄，就简短友好地回应。',
    '如果用户要求操作代码项目，但没有给出项目名或路径，请提醒用户补充项目名或路径。',
    '不要声称已经修改了项目，除非你确实被要求并进入了项目任务执行流程。'
  ];

  if (contextLines.length > 0) {
    lines.push('', '同一飞书会话的近期上下文：', ...contextLines);
  }

  lines.push('', '用户消息：', text);

  return lines.join('\n');
}

function formatConversationContext(memory: ConversationContext): string[] {
  const lines: string[] = [];

  if (memory.state?.lastRepo) {
    const projectName =
      memory.state.lastProjectName ?? path.basename(memory.state.lastRepo);
    lines.push(`最近项目：${projectName} (${memory.state.lastRepo})`);
  }

  for (const message of memory.messages) {
    const role = message.role === 'assistant' ? 'Codex' : '用户';
    const repo = message.repo ? `（${path.basename(message.repo)}）` : '';
    lines.push(`${role}${repo}：${truncateMemorySnippet(message.content)}`);
  }

  return lines;
}

function truncateMemorySnippet(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();

  if (normalized.length <= MEMORY_SNIPPET_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MEMORY_SNIPPET_MAX_LENGTH - 20)}...`;
}

function rememberUserTask(
  store: TaskStore,
  input: {
    message: FeishuTextMessage;
    task: TaskRecord;
    content: string;
    repo?: string;
    projectName?: string;
  }
): void {
  store.appendConversationMessage({
    chatId: input.message.chatId,
    userId: input.message.senderUserId,
    role: 'user',
    content: input.content,
    taskId: input.task.id,
    repo: input.repo ?? null
  });

  if (input.repo) {
    store.upsertConversationState({
      chatId: input.message.chatId,
      userId: input.message.senderUserId,
      lastRepo: input.repo,
      lastProjectName: input.projectName ?? path.basename(input.repo),
      lastTaskId: input.task.id
    });
    return;
  }

  store.upsertConversationState({
    chatId: input.message.chatId,
    userId: input.message.senderUserId,
    lastTaskId: input.task.id
  });
}

function rememberAssistantResult(
  store: TaskStore,
  task: TaskRecord,
  content: string,
  chatWorkspaceDir: string
): void {
  const isProjectTask = !isChatTask(task, chatWorkspaceDir);
  const repo = isProjectTask ? task.repo : null;

  store.appendConversationMessage({
    chatId: task.chatId,
    userId: task.userId,
    role: 'assistant',
    content,
    taskId: task.id,
    repo
  });

  if (repo) {
    store.upsertConversationState({
      chatId: task.chatId,
      userId: task.userId,
      lastRepo: repo,
      lastProjectName: path.basename(repo),
      lastTaskId: task.id
    });
    return;
  }

  store.upsertConversationState({
    chatId: task.chatId,
    userId: task.userId,
    lastTaskId: task.id
  });
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
