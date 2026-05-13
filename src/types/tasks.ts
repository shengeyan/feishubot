export type TaskStatus =
  | 'pending_confirmation'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ArtifactKind =
  | 'codex_jsonl'
  | 'stderr_log'
  | 'final_summary'
  | 'git_diff'
  | 'git_diff_stat';

export type TaskRecord = {
  id: string;
  feishuMessageId: string;
  chatId: string;
  userId: string;
  repo: string;
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  finalSummary: string | null;
  errorMessage: string | null;
};

export type TaskEventRecord = {
  id: number;
  taskId: string;
  type: string;
  content: string;
  rawJson: string | null;
  createdAt: string;
};

export type TaskArtifactRecord = {
  id: number;
  taskId: string;
  kind: ArtifactKind;
  path: string;
  createdAt: string;
};

export type CreateTaskInput = {
  feishuMessageId: string;
  chatId: string;
  userId: string;
  repo: string;
  prompt: string;
  status?: TaskStatus;
};

export type UpdateTaskStatusInput = {
  status: TaskStatus;
  finalSummary?: string | null;
  errorMessage?: string | null;
};
