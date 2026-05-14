import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import type {
  AppendConversationMessageInput,
  ArtifactKind,
  ConversationContext,
  ConversationMessageRecord,
  ConversationRole,
  ConversationStateRecord,
  CreateTaskInput,
  TaskArtifactRecord,
  TaskEventRecord,
  TaskRecord,
  TaskStatus,
  UpdateTaskStatusInput,
  UpsertConversationStateInput
} from '../types/tasks.js';

type SqlRow = Record<string, SQLOutputValue>;

export type ClearFinishedTasksResult = {
  taskIds: string[];
  artifactPaths: string[];
  deletedTaskCount: number;
  deletedEventCount: number;
  deletedArtifactCount: number;
  preservedActiveTaskCount: number;
};

export type ClearConversationResult = {
  deletedMessageCount: number;
  deletedStateCount: number;
};

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

  listTaskArtifacts(taskId: string): TaskArtifactRecord[] {
    return this.db
      .prepare(
        `
        SELECT
          id,
          task_id,
          kind,
          path,
          created_at
        FROM task_artifacts
        WHERE task_id = ?
        ORDER BY created_at ASC, id ASC
      `
      )
      .all(taskId)
      .map(mapTaskArtifactRow);
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

  appendConversationMessage(
    input: AppendConversationMessageInput
  ): ConversationMessageRecord {
    const createdAt = now();
    const result = this.db
      .prepare(
        `
        INSERT INTO conversation_messages (
          chat_id,
          user_id,
          role,
          content,
          task_id,
          repo,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        input.chatId,
        input.userId,
        input.role,
        input.content,
        input.taskId ?? null,
        input.repo ?? null,
        createdAt
      );

    return {
      id: Number(result.lastInsertRowid),
      chatId: input.chatId,
      userId: input.userId,
      role: input.role,
      content: input.content,
      taskId: input.taskId ?? null,
      repo: input.repo ?? null,
      createdAt
    };
  }

  upsertConversationState(
    input: UpsertConversationStateInput
  ): ConversationStateRecord {
    const existing = this.getConversationState(input.chatId, input.userId);
    const state: ConversationStateRecord = {
      chatId: input.chatId,
      userId: input.userId,
      lastRepo:
        input.lastRepo === undefined ? existing?.lastRepo ?? null : input.lastRepo,
      lastProjectName:
        input.lastProjectName === undefined
          ? existing?.lastProjectName ?? null
          : input.lastProjectName,
      lastTaskId:
        input.lastTaskId === undefined
          ? existing?.lastTaskId ?? null
          : input.lastTaskId,
      updatedAt: now()
    };

    this.db
      .prepare(
        `
        INSERT INTO conversation_state (
          chat_id,
          user_id,
          last_repo,
          last_project_name,
          last_task_id,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, user_id) DO UPDATE SET
          last_repo = excluded.last_repo,
          last_project_name = excluded.last_project_name,
          last_task_id = excluded.last_task_id,
          updated_at = excluded.updated_at
      `
      )
      .run(
        state.chatId,
        state.userId,
        state.lastRepo,
        state.lastProjectName,
        state.lastTaskId,
        state.updatedAt
      );

    return state;
  }

  getConversationContext(
    chatId: string,
    userId: string,
    messageLimit = 8
  ): ConversationContext {
    const state = this.getConversationState(chatId, userId);
    const messages = this.db
      .prepare(
        `
        SELECT
          id,
          chat_id,
          user_id,
          role,
          content,
          task_id,
          repo,
          created_at
        FROM conversation_messages
        WHERE chat_id = ? AND user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `
      )
      .all(chatId, userId, messageLimit)
      .map(mapConversationMessageRow)
      .reverse();

    return {
      state,
      messages
    };
  }

  clearConversation(chatId: string, userId: string): ClearConversationResult {
    const deletedMessageCount = asNumber(
      this.db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM conversation_messages
          WHERE chat_id = ? AND user_id = ?
        `
        )
        .get(chatId, userId)?.count
    );
    const deletedStateCount = asNumber(
      this.db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM conversation_state
          WHERE chat_id = ? AND user_id = ?
        `
        )
        .get(chatId, userId)?.count
    );

    this.db
      .prepare('DELETE FROM conversation_messages WHERE chat_id = ? AND user_id = ?')
      .run(chatId, userId);
    this.db
      .prepare('DELETE FROM conversation_state WHERE chat_id = ? AND user_id = ?')
      .run(chatId, userId);

    return {
      deletedMessageCount,
      deletedStateCount
    };
  }

  clearFinishedTasks(): ClearFinishedTasksResult {
    const taskIds = this.db
      .prepare(
        `
        SELECT id
        FROM tasks
        WHERE status IN ('succeeded', 'failed', 'cancelled')
      `
      )
      .all()
      .map((row) => asString(row.id));
    const preservedActiveTaskCount = asNumber(
      this.db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM tasks
          WHERE status IN ('pending_confirmation', 'queued', 'running')
        `
        )
        .get()?.count
    );

    if (taskIds.length === 0) {
      return {
        taskIds: [],
        artifactPaths: [],
        deletedTaskCount: 0,
        deletedEventCount: 0,
        deletedArtifactCount: 0,
        preservedActiveTaskCount
      };
    }

    const placeholders = taskIds.map(() => '?').join(', ');
    const artifactPaths = this.db
      .prepare(
        `
        SELECT path
        FROM task_artifacts
        WHERE task_id IN (${placeholders})
      `
      )
      .all(...taskIds)
      .map((row) => asString(row.path));
    const deletedEventCount = asNumber(
      this.db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM task_events
          WHERE task_id IN (${placeholders})
        `
        )
        .get(...taskIds)?.count
    );
    const deletedArtifactCount = artifactPaths.length;

    this.db.exec('BEGIN IMMEDIATE');

    try {
      this.db
        .prepare(`DELETE FROM task_artifacts WHERE task_id IN (${placeholders})`)
        .run(...taskIds);
      this.db
        .prepare(`DELETE FROM task_events WHERE task_id IN (${placeholders})`)
        .run(...taskIds);
      this.db
        .prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`)
        .run(...taskIds);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return {
      taskIds,
      artifactPaths,
      deletedTaskCount: taskIds.length,
      deletedEventCount,
      deletedArtifactCount,
      preservedActiveTaskCount
    };
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

      CREATE TABLE IF NOT EXISTS conversation_state (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        last_repo TEXT,
        last_project_name TEXT,
        last_task_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        task_id TEXT,
        repo TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at
        ON tasks(status, created_at);

      CREATE INDEX IF NOT EXISTS idx_task_events_task_id_created_at
        ON task_events(task_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_id
        ON task_artifacts(task_id);

      CREATE INDEX IF NOT EXISTS idx_conversation_messages_lookup
        ON conversation_messages(chat_id, user_id, created_at, id);
    `);
  }

  private getConversationState(
    chatId: string,
    userId: string
  ): ConversationStateRecord | null {
    const row = this.db
      .prepare(
        `
        SELECT
          chat_id,
          user_id,
          last_repo,
          last_project_name,
          last_task_id,
          updated_at
        FROM conversation_state
        WHERE chat_id = ? AND user_id = ?
      `
      )
      .get(chatId, userId);

    return row ? mapConversationStateRow(row) : null;
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

function mapTaskArtifactRow(row: SqlRow): TaskArtifactRecord {
  return {
    id: asNumber(row.id),
    taskId: asString(row.task_id),
    kind: asArtifactKind(row.kind),
    path: asString(row.path),
    createdAt: asString(row.created_at)
  };
}

function mapConversationMessageRow(row: SqlRow): ConversationMessageRecord {
  return {
    id: asNumber(row.id),
    chatId: asString(row.chat_id),
    userId: asString(row.user_id),
    role: asConversationRole(row.role),
    content: asString(row.content),
    taskId: asNullableString(row.task_id),
    repo: asNullableString(row.repo),
    createdAt: asString(row.created_at)
  };
}

function mapConversationStateRow(row: SqlRow): ConversationStateRecord {
  return {
    chatId: asString(row.chat_id),
    userId: asString(row.user_id),
    lastRepo: asNullableString(row.last_repo),
    lastProjectName: asNullableString(row.last_project_name),
    lastTaskId: asNullableString(row.last_task_id),
    updatedAt: asString(row.updated_at)
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

function asNumber(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  throw new Error(`Expected SQLite number, got ${String(value)}`);
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

function asArtifactKind(value: SQLOutputValue | undefined): ArtifactKind {
  const kind = asString(value);

  if (
    kind === 'codex_jsonl' ||
    kind === 'stderr_log' ||
    kind === 'final_summary' ||
    kind === 'git_diff' ||
    kind === 'git_diff_stat'
  ) {
    return kind;
  }

  throw new Error(`Invalid artifact kind: ${kind}`);
}

function asConversationRole(value: SQLOutputValue | undefined): ConversationRole {
  const role = asString(value);

  if (role === 'user' || role === 'assistant') {
    return role;
  }

  throw new Error(`Invalid conversation role: ${role}`);
}
