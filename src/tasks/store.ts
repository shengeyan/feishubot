import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import type {
  ArtifactKind,
  CreateTaskInput,
  TaskArtifactRecord,
  TaskEventRecord,
  TaskRecord,
  TaskStatus,
  UpdateTaskStatusInput
} from '../types/tasks.js';

type SqlRow = Record<string, SQLOutputValue>;

export class TaskStore {
  readonly dbPath: string;

  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'agent.sqlite');
    this.db = new DatabaseSync(this.dbPath);
    this.initialize();
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const task: TaskRecord = {
      id: randomUUID(),
      feishuMessageId: input.feishuMessageId,
      chatId: input.chatId,
      userId: input.userId,
      repo: input.repo,
      prompt: input.prompt,
      status: input.status ?? 'queued',
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      finalSummary: null,
      errorMessage: null
    };

    this.db
      .prepare(
        `
        INSERT INTO tasks (
          id,
          feishu_message_id,
          chat_id,
          user_id,
          repo,
          prompt,
          status,
          created_at,
          started_at,
          finished_at,
          final_summary,
          error_message
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        task.id,
        task.feishuMessageId,
        task.chatId,
        task.userId,
        task.repo,
        task.prompt,
        task.status,
        task.createdAt,
        task.startedAt,
        task.finishedAt,
        task.finalSummary,
        task.errorMessage
      );

    this.appendTaskEvent(task.id, 'task.created', '任务已创建');

    return task;
  }

  updateTaskStatus(taskId: string, input: UpdateTaskStatusInput): TaskRecord {
    const existing = this.getTask(taskId);

    if (!existing) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const updated: TaskRecord = {
      ...existing,
      status: input.status,
      startedAt:
        existing.startedAt ?? (input.status === 'running' ? now() : null),
      finishedAt:
        existing.finishedAt ?? (isTerminalStatus(input.status) ? now() : null),
      finalSummary: input.finalSummary ?? existing.finalSummary,
      errorMessage: input.errorMessage ?? existing.errorMessage
    };

    this.db
      .prepare(
        `
        UPDATE tasks
        SET
          status = ?,
          started_at = ?,
          finished_at = ?,
          final_summary = ?,
          error_message = ?
        WHERE id = ?
      `
      )
      .run(
        updated.status,
        updated.startedAt,
        updated.finishedAt,
        updated.finalSummary,
        updated.errorMessage,
        updated.id
      );

    this.appendTaskEvent(
      taskId,
      `task.${input.status}`,
      input.errorMessage ?? input.finalSummary ?? `任务状态更新为 ${input.status}`
    );

    return updated;
  }

  appendTaskEvent(
    taskId: string,
    type: string,
    content: string,
    rawJson?: unknown
  ): TaskEventRecord {
    const createdAt = now();
    const result = this.db
      .prepare(
        `
        INSERT INTO task_events (task_id, type, content, raw_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `
      )
      .run(
        taskId,
        type,
        content,
        rawJson === undefined ? null : JSON.stringify(rawJson),
        createdAt
      );

    return {
      id: Number(result.lastInsertRowid),
      taskId,
      type,
      content,
      rawJson: rawJson === undefined ? null : JSON.stringify(rawJson),
      createdAt
    };
  }

  addArtifact(
    taskId: string,
    kind: ArtifactKind,
    artifactPath: string
  ): TaskArtifactRecord {
    const createdAt = now();
    const result = this.db
      .prepare(
        `
        INSERT INTO task_artifacts (task_id, kind, path, created_at)
        VALUES (?, ?, ?, ?)
      `
      )
      .run(taskId, kind, artifactPath, createdAt);

    return {
      id: Number(result.lastInsertRowid),
      taskId,
      kind,
      path: artifactPath,
      createdAt
    };
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db
      .prepare(
        `
        SELECT
          id,
          feishu_message_id,
          chat_id,
          user_id,
          repo,
          prompt,
          status,
          created_at,
          started_at,
          finished_at,
          final_summary,
          error_message
        FROM tasks
        WHERE id = ?
      `
      )
      .get(taskId);

    return row ? mapTaskRow(row) : null;
  }

  listRecentTasks(limit = 10): TaskRecord[] {
    return this.db
      .prepare(
        `
        SELECT
          id,
          feishu_message_id,
          chat_id,
          user_id,
          repo,
          prompt,
          status,
          created_at,
          started_at,
          finished_at,
          final_summary,
          error_message
        FROM tasks
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(limit)
      .map(mapTaskRow);
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        feishu_message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        final_summary TEXT,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS task_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at
        ON tasks(status, created_at);

      CREATE INDEX IF NOT EXISTS idx_task_events_task_id_created_at
        ON task_events(task_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_id
        ON task_artifacts(task_id);
    `);
  }
}

function mapTaskRow(row: SqlRow): TaskRecord {
  return {
    id: asString(row.id),
    feishuMessageId: asString(row.feishu_message_id),
    chatId: asString(row.chat_id),
    userId: asString(row.user_id),
    repo: asString(row.repo),
    prompt: asString(row.prompt),
    status: asTaskStatus(row.status),
    createdAt: asString(row.created_at),
    startedAt: asNullableString(row.started_at),
    finishedAt: asNullableString(row.finished_at),
    finalSummary: asNullableString(row.final_summary),
    errorMessage: asNullableString(row.error_message)
  };
}

function now(): string {
  return new Date().toISOString();
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function asString(value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected SQLite string, got ${String(value)}`);
  }

  return value;
}

function asNullableString(value: SQLOutputValue | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return asString(value);
}

function asTaskStatus(value: SQLOutputValue | undefined): TaskStatus {
  const status = asString(value);

  if (
    status === 'pending_confirmation' ||
    status === 'queued' ||
    status === 'running' ||
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled'
  ) {
    return status;
  }

  throw new Error(`Invalid task status: ${status}`);
}
