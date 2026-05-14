import type {
  FeishuTextMessage,
  ParsedCodexCommand
} from '../types/feishu.js';

type RawFeishuMessageEvent = {
  sender?: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    message_type?: string;
    content?: string;
  };
};

export const CODEX_COMMAND_PREFIX = '/codex';
export const CODEX_COMMAND_ALIAS = 'codex';

const MENU_TEXT_COMMAND_ALIASES = new Map<string, string>([
  ['帮助', '/help'],
  ['项目列表', '/repos'],
  ['仓库列表', '/repos'],
  ['清空记录', '/clear']
]);

export function extractTextMessage(
  event: RawFeishuMessageEvent
): FeishuTextMessage | null {
  const message = event.message;
  const senderId = event.sender?.sender_id;

  if (!message?.message_id || !message.chat_id || !message.content) {
    return null;
  }

  if (message.message_type && message.message_type !== 'text') {
    return null;
  }

  const senderUserId = senderId?.user_id ?? senderId?.open_id ?? senderId?.union_id;
  const text = parseFeishuTextContent(message.content);

  if (!senderUserId || !text) {
    return null;
  }

  return {
    chatId: message.chat_id,
    messageId: message.message_id,
    senderUserId,
    text
  };
}

export function parseCodexCommand(
  message: FeishuTextMessage
): ParsedCodexCommand {
  const text = normalizeCommandText(message.text);

  const args = getCommandArgs(text);

  if (args === null) {
    return { type: 'ignore', reason: 'not a codex command' };
  }

  if (!args || args === 'help') {
    return { type: 'help', message };
  }

  const [rawVerb, ...restArgs] = args.split(/\s+/u);
  const verb = rawVerb ?? '';
  const secondArg = restArgs[0];
  const verbRemainder = args.slice(verb.length).trim();

  if (verb === 'help') {
    return { type: 'help', message };
  }

  if (verb === 'repos') {
    return { type: 'repos', message };
  }

  if (verb === 'clear') {
    return { type: 'clear', message };
  }

  if (verb === 'status') {
    return secondArg
      ? { type: 'status', message, taskId: secondArg }
      : { type: 'invalid', message, reason: '缺少 taskId，格式：/status <taskId>' };
  }

  if (verb === 'approve') {
    return secondArg
      ? { type: 'approve', message, taskId: secondArg }
      : { type: 'invalid', message, reason: '缺少 taskId，格式：/approve <taskId>' };
  }

  if (verb === 'reject') {
    return secondArg
      ? { type: 'reject', message, taskId: secondArg }
      : { type: 'invalid', message, reason: '缺少 taskId，格式：/reject <taskId>' };
  }

  if (verb === 'cancel') {
    return secondArg
      ? { type: 'cancel', message, taskId: secondArg }
      : { type: 'invalid', message, reason: '缺少 taskId，格式：/cancel <taskId>' };
  }

  if (verb === 'stop' || verb === 'interrupt' || verb === '中断') {
    return secondArg
      ? { type: 'stop', message, taskId: secondArg }
      : { type: 'invalid', message, reason: '缺少 taskId，格式：/stop <taskId>' };
  }

  if (
    verb === 'file' ||
    verb === 'artifact' ||
    verb === '文件' ||
    verb === '发文件'
  ) {
    return secondArg
      ? {
          type: 'file',
          message,
          taskId: secondArg,
          artifact: restArgs[1]
        }
      : {
          type: 'invalid',
          message,
          reason:
            '缺少 taskId，格式：/file <taskId> [summary|diff|stat|jsonl|stderr]'
        };
  }

  if (
    verb === 'sendfile' ||
    verb === 'send-file' ||
    verb === 'localfile' ||
    verb === '发本机文件' ||
    verb === '发本地文件'
  ) {
    const filePathInput = parseFilePathArgument(verbRemainder);

    return filePathInput
      ? { type: 'send_file', message, filePathInput }
      : {
          type: 'invalid',
          message,
          reason: '缺少文件路径，格式：/sendfile <本机文件路径>'
        };
  }

  const repoToken = findRepoToken(args);

  if (!repoToken) {
    return {
      type: 'invalid',
      message,
      reason: '缺少 repo 参数，格式：/repo=<本机目录路径> <任务描述>'
    };
  }

  const prompt = `${args.slice(0, repoToken.start)} ${args.slice(repoToken.end)}`
    .replace(/\s+/g, ' ')
    .trim();

  if (!prompt) {
    return {
      type: 'invalid',
      message,
      reason: '缺少任务描述，格式：/repo=<本机目录路径> <任务描述>'
    };
  }

  return {
    type: 'task',
    message,
    repoInput: unquote(repoToken.value),
    prompt
  };
}

export function formatHelpText(): string {
  return [
    '你可以直接和我说话，例如：',
    '你好',
    '请处理 heroverse 项目的 build 报错',
    '请检查 /Users/hero/Documents/workspace/heroverse 里的权限问题',
    '',
    '也可以使用命令：',
    '/help',
    '/repos',
    '/clear',
    '/status <taskId>',
    '/approve <taskId>',
    '/reject <taskId>',
    '/cancel <taskId>',
    '/stop <taskId>',
    '/file <taskId> [summary|diff|stat|jsonl|stderr]',
    '/sendfile <本机文件路径>',
    '/repo=<本机目录路径> <任务描述>',
    '',
    '如果 Codex 回复里提到本机文件，也可以直接说：把这个以文件形式发我。',
    '',
    '飞书菜单名称也可以直接填：帮助、项目列表、清空记录。',
    '',
    '涉及项目修改时会先等待确认，回复 /approve 后才会执行。'
  ].join('\n');
}

function parseFeishuTextContent(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return content;
  }
}

function normalizeCommandText(text: string): string {
  const normalized = text
    .replace(/<at[^>]*>.*?<\/at>/g, '')
    .replace(/^@\S+\s+/, '')
    .replace(/^／/u, '/')
    .trim();

  const menuAlias = MENU_TEXT_COMMAND_ALIASES.get(normalized);

  if (menuAlias) {
    return menuAlias;
  }

  const lowerNormalized = normalized.toLowerCase();

  if (
    lowerNormalized === CODEX_COMMAND_ALIAS ||
    lowerNormalized.startsWith(`${CODEX_COMMAND_ALIAS} `)
  ) {
    return `${CODEX_COMMAND_PREFIX}${normalized.slice(CODEX_COMMAND_ALIAS.length)}`;
  }

  return normalized;
}

function isCodexCommandText(text: string): boolean {
  return text === CODEX_COMMAND_PREFIX || text.startsWith(`${CODEX_COMMAND_PREFIX} `);
}

function getCommandArgs(text: string): string | null {
  if (isCodexCommandText(text)) {
    return text.slice(CODEX_COMMAND_PREFIX.length).trim();
  }

  if (text.startsWith('/')) {
    return text.slice(1).trim();
  }

  return null;
}

function findRepoToken(
  args: string
): { value: string; start: number; end: number } | null {
  const match = /(?:^|\s)repo=(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(args);

  if (!match || match.index === undefined) {
    return null;
  }

  const fullMatch = match[0];
  const leadingWhitespace = fullMatch.startsWith(' ') ? 1 : 0;
  const value = match[1] ?? match[2] ?? match[3];

  if (!value) {
    return null;
  }

  return {
    value,
    start: match.index + leadingWhitespace,
    end: match.index + fullMatch.length
  };
}

function parseFilePathArgument(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const quote = trimmed[0];

  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);

    if (end > 1) {
      return trimmed.slice(1, end);
    }
  }

  return trimmed.split(/\s+/u)[0] ?? null;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
