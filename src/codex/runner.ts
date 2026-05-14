import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AppConfig } from '../config.js';
import {
  buildFailureReceipt,
  buildSuccessReceipt,
  parseCodexJsonlFile
} from './parser.js';
import type { TaskStore } from '../tasks/store.js';
import type { CodexRunResult } from '../types/codex.js';
import type { TaskRecord } from '../types/tasks.js';

const execFileAsync = promisify(execFile);

type RunningCodexProcess = {
  child: ChildProcess;
  forceKillTimer: NodeJS.Timeout | null;
};

export class CodexRunner {
  private readonly runningProcesses = new Map<string, RunningCodexProcess>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: TaskStore
  ) {}

  interrupt(taskId: string, reason: string): boolean {
    const runningProcess = this.runningProcesses.get(taskId);

    if (!runningProcess || runningProcess.child.killed) {
      return false;
    }

    this.store.appendTaskEvent(taskId, 'codex.interrupt', reason);
    const signalled = runningProcess.child.kill('SIGTERM');

    if (signalled && !runningProcess.forceKillTimer) {
      runningProcess.forceKillTimer = setTimeout(() => {
        runningProcess.child.kill('SIGKILL');
      }, 5_000);
    }

    return signalled;
  }

  async run(task: TaskRecord): Promise<CodexRunResult> {
    const logsDir = path.join(this.config.dataDir, 'logs', task.id);
    mkdirSync(logsDir, { recursive: true });

    const jsonlPath = path.join(logsDir, 'codex.jsonl');
    const stderrPath = path.join(logsDir, 'stderr.log');
    const finalSummaryPath = path.join(logsDir, 'final.txt');
    const diffPatchPath = path.join(logsDir, 'git-diff.patch');
    const diffStatPath = path.join(logsDir, 'git-diff-stat.txt');

    this.store.addArtifact(task.id, 'codex_jsonl', jsonlPath);
    this.store.addArtifact(task.id, 'stderr_log', stderrPath);

    const stdoutStream = createWriteStream(jsonlPath, { flags: 'a' });
    const stderrStream = createWriteStream(stderrPath, { flags: 'a' });
    const codexArgs = [
      'exec',
      '--json',
      '-C',
      task.repo,
      '-s',
      'danger-full-access',
      '--skip-git-repo-check',
      task.prompt
    ];

    this.store.appendTaskEvent(
      task.id,
      'codex.start',
      `codex ${codexArgs.map(formatShellArg).join(' ')}`
    );

    const runResult = await this.runCodexProcess({
      task,
      args: codexArgs,
      stdoutStream,
      stderrStream
    });
    const diffStat = await this.writeGitArtifacts(task, diffPatchPath, diffStatPath);
    const parsedOutput = parseCodexJsonlFile(jsonlPath);
    const succeeded = !runResult.timedOut && runResult.exitCode === 0;
    const summary = succeeded
      ? buildSuccessReceipt({
          task,
          finalMessage: parsedOutput.finalMessage,
          diffStat,
          logsDir
        })
      : buildFailureReceipt({
          task,
          exitCode: runResult.exitCode,
          signal: runResult.signal,
          timedOut: runResult.timedOut,
          errors: parsedOutput.errors,
          stderr: runResult.stderr,
          logsDir
        });

    writeFileSync(finalSummaryPath, summary);
    this.store.addArtifact(task.id, 'final_summary', finalSummaryPath);

    return {
      task,
      exitCode: runResult.exitCode,
      signal: runResult.signal,
      timedOut: runResult.timedOut,
      logsDir,
      jsonlPath,
      stderrPath,
      finalSummaryPath,
      diffPatchPath,
      diffStatPath,
      diffStat,
      finalMessage: parsedOutput.finalMessage,
      summary,
      errorMessage: succeeded
        ? null
        : (parsedOutput.errors.at(-1) ?? runResult.stderr.trim()) ||
          'Codex 执行失败'
    };
  }

  private async runCodexProcess(input: {
    task: TaskRecord;
    args: string[];
    stdoutStream: NodeJS.WritableStream;
    stderrStream: NodeJS.WritableStream;
  }): Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stderr: string;
  }> {
    const child = spawn('codex', input.args, {
      cwd: input.task.repo,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    let timedOut = false;
    const runningProcess: RunningCodexProcess = {
      child,
      forceKillTimer: null
    };
    this.runningProcesses.set(input.task.id, runningProcess);

    const timeout = setTimeout(() => {
      timedOut = true;
      this.store.appendTaskEvent(
        input.task.id,
        'codex.timeout',
        `Codex 超过 ${this.config.taskTimeoutMs}ms，发送 SIGTERM`
      );
      child.kill('SIGTERM');
      if (!runningProcess.forceKillTimer) {
        runningProcess.forceKillTimer = setTimeout(
          () => child.kill('SIGKILL'),
          5_000
        );
      }
    }, this.config.taskTimeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      input.stdoutStream.write(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      input.stderrStream.write(chunk);
    });

    try {
      const result = await new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });

      if (stderr.trim()) {
        this.store.appendTaskEvent(input.task.id, 'codex.stderr', tail(stderr, 2000));
      }

      return {
        ...result,
        timedOut,
        stderr
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.appendTaskEvent(input.task.id, 'codex.spawn_error', message);

      return {
        exitCode: null,
        signal: null,
        timedOut,
        stderr: message
      };
    } finally {
      clearTimeout(timeout);

      if (runningProcess.forceKillTimer) {
        clearTimeout(runningProcess.forceKillTimer);
      }

      this.runningProcesses.delete(input.task.id);
      await endStream(input.stdoutStream);
      await endStream(input.stderrStream);
    }
  }

  private async writeGitArtifacts(
    task: TaskRecord,
    diffPatchPath: string,
    diffStatPath: string
  ): Promise<string> {
    if (!(await isGitWorkTree(task.repo))) {
      writeFileSync(diffStatPath, '');
      writeFileSync(diffPatchPath, '');

      this.store.addArtifact(task.id, 'git_diff_stat', diffStatPath);
      this.store.addArtifact(task.id, 'git_diff', diffPatchPath);
      this.store.appendTaskEvent(
        task.id,
        'git.diff.skip',
        '当前任务目录不是 git 工作区，跳过 diff 采集'
      );

      return '';
    }

    const diffStatResult = await runGit(task.repo, ['diff', '--stat']);
    const diffResult = await runGit(task.repo, ['diff']);
    const diffStat = diffStatResult.stdout || diffStatResult.stderr;

    writeFileSync(diffStatPath, diffStat);
    writeFileSync(diffPatchPath, diffResult.stdout || diffResult.stderr);

    this.store.addArtifact(task.id, 'git_diff_stat', diffStatPath);
    this.store.addArtifact(task.id, 'git_diff', diffPatchPath);

    if (diffStatResult.stderr.trim()) {
      this.store.appendTaskEvent(
        task.id,
        'git.diff_stat.stderr',
        diffStatResult.stderr.trim()
      );
    }

    if (diffResult.stderr.trim()) {
      this.store.appendTaskEvent(task.id, 'git.diff.stderr', diffResult.stderr.trim());
    }

    return diffStat;
  }
}

async function isGitWorkTree(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.stdout.trim() === 'true';
}

async function runGit(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    if (isExecFileError(error)) {
      return {
        stdout: error.stdout,
        stderr: error.stderr || error.message
      };
    }

    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}

function formatShellArg(value: string): string {
  if (/^[a-zA-Z0-9_./:=+-]+$/u.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function isExecFileError(
  error: unknown
): error is Error & { stdout: string; stderr: string } {
  return (
    error instanceof Error &&
    'stdout' in error &&
    typeof error.stdout === 'string' &&
    'stderr' in error &&
    typeof error.stderr === 'string'
  );
}

function tail(value: string, maxLength: number): string {
  const trimmed = value.trim();

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return trimmed.slice(trimmed.length - maxLength);
}

async function endStream(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
}
