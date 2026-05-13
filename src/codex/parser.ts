import { existsSync, readFileSync } from 'node:fs';

import type { ParsedCodexOutput } from '../types/codex.js';
import type { TaskRecord } from '../types/tasks.js';

type JsonRecord = Record<string, unknown>;

export function parseCodexJsonlFile(filePath: string): ParsedCodexOutput {
  if (!existsSync(filePath)) {
    return {
      finalMessage: null,
      errors: [],
      progress: []
    };
  }

  const lines = readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  const errors: string[] = [];
  const progress: string[] = [];
  let finalMessage: string | null = null;

  for (const line of lines) {
    const record = parseJsonRecord(line);

    if (!record) {
      continue;
    }

    const type = getRecordType(record);
    const text = extractRecordText(record);

    if (isErrorRecord(record, type)) {
      errors.push(text ?? JSON.stringify(record));
      continue;
    }

    if (isAssistantOrFinalRecord(record, type) && text) {
      finalMessage = text;
      continue;
    }

    if (text && progress.length < 20) {
      progress.push(text);
    }
  }

  return {
    finalMessage,
    errors,
    progress
  };
}

export function buildSuccessReceipt(input: {
  task: TaskRecord;
  finalMessage: string | null;
  diffStat: string;
  logsDir: string;
}): string {
  return [
    `任务 ID：${input.task.id}`,
    `仓库：${input.task.repo}`,
    '状态：完成',
    `修改文件：${formatDiffStat(input.diffStat)}`,
    '',
    '最终说明：',
    truncate(input.finalMessage ?? 'Codex 未返回最终消息。'),
    '',
    `本地日志：${input.logsDir}`
  ].join('\n');
}

export function buildFailureReceipt(input: {
  task: TaskRecord;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  errors: string[];
  stderr: string;
  logsDir: string;
}): string {
  const statusLine = input.timedOut
    ? '失败阶段：Codex 执行超时'
    : `失败阶段：Codex 子进程退出，exitCode=${input.exitCode ?? 'null'}，signal=${input.signal ?? 'null'}`;
  const errorSummary =
    input.errors.at(-1) ?? tail(input.stderr, 1200) ?? '未捕获到明确错误信息。';

  return [
    `任务 ID：${input.task.id}`,
    `仓库：${input.task.repo}`,
    '状态：失败',
    statusLine,
    '',
    '错误摘要：',
    truncate(errorSummary),
    '',
    `本地日志：${input.logsDir}`,
    '可重试：是'
  ].join('\n');
}

function parseJsonRecord(line: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getRecordType(record: JsonRecord): string {
  const type = record.type ?? record.event ?? record.name;
  return typeof type === 'string' ? type : '';
}

function isErrorRecord(record: JsonRecord, type: string): boolean {
  return (
    type.toLowerCase().includes('error') ||
    record.error !== undefined ||
    record.level === 'error'
  );
}

function isAssistantOrFinalRecord(record: JsonRecord, type: string): boolean {
  const role = record.role ?? getNestedValue(record, ['message', 'role']);
  const itemRole = getNestedValue(record, ['item', 'role']);
  const itemType = getNestedValue(record, ['item', 'type']);
  const normalizedItemType = typeof itemType === 'string' ? itemType.toLowerCase() : '';

  return (
    role === 'assistant' ||
    itemRole === 'assistant' ||
    normalizedItemType === 'agent_message' ||
    normalizedItemType.includes('assistant') ||
    normalizedItemType.includes('final') ||
    type.toLowerCase().includes('assistant') ||
    type.toLowerCase().includes('final') ||
    type === 'message'
  );
}

function extractRecordText(record: JsonRecord): string | null {
  const candidates = [
    record.text,
    record.message,
    record.content,
    record.delta,
    record.final_answer,
    record.error,
    getNestedValue(record, ['item', 'text']),
    getNestedValue(record, ['item', 'content']),
    getNestedValue(record, ['item', 'message']),
    getNestedValue(record, ['item', 'delta']),
    getNestedValue(record, ['response', 'output']),
    getNestedValue(record, ['message', 'content'])
  ];

  const pieces = candidates.flatMap((candidate) => extractTextPieces(candidate));
  const text = unique(pieces)
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  return text || null;
}

function extractTextPieces(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextPieces(item, depth + 1));
  }

  if (!isRecord(value)) {
    return [];
  }

  const interestingKeys = [
    'text',
    'content',
    'message',
    'delta',
    'output_text',
    'final_answer',
    'error'
  ];

  return interestingKeys.flatMap((key) =>
    extractTextPieces(value[key], depth + 1)
  );
}

function formatDiffStat(diffStat: string): string {
  const trimmed = diffStat.trim();

  if (!trimmed) {
    return '无工作区 diff';
  }

  const lines = trimmed.split(/\r?\n/u);

  if (lines.length <= 8) {
    return `\n${trimmed}`;
  }

  return `\n${lines.slice(0, 7).join('\n')}\n...`;
}

function getNestedValue(record: JsonRecord, path: string[]): unknown {
  let value: unknown = record;

  for (const key of path) {
    if (!isRecord(value)) {
      return undefined;
    }

    value = value[key];
  }

  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(value: string, maxLength = 1800): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 20)}\n...已截断`;
}

function tail(value: string, maxLength: number): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return trimmed.slice(trimmed.length - maxLength);
}
