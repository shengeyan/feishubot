import type { TaskRecord } from './tasks.js';

export type ParsedCodexOutput = {
  finalMessage: string | null;
  errors: string[];
  progress: string[];
};

export type CodexRunResult = {
  task: TaskRecord;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  logsDir: string;
  jsonlPath: string;
  stderrPath: string;
  finalSummaryPath: string;
  diffPatchPath: string;
  diffStatPath: string;
  diffStat: string;
  finalMessage: string | null;
  summary: string;
  errorMessage: string | null;
};
