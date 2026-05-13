import type { CodexRunner } from '../codex/runner.js';
import type { TaskStore } from './store.js';
import type { CodexRunResult } from '../types/codex.js';
import type { TaskRecord } from '../types/tasks.js';

type QueueCallbacks = {
  onTaskStarted?: (task: TaskRecord) => Promise<void>;
  onTaskSucceeded?: (
    task: TaskRecord,
    result: CodexRunResult
  ) => Promise<void>;
  onTaskFailed?: (task: TaskRecord, result: CodexRunResult) => Promise<void>;
  onTaskErrored?: (task: TaskRecord, errorMessage: string) => Promise<void>;
  onTaskCancelled?: (task: TaskRecord, reason: string) => Promise<void>;
};

export class TaskQueue {
  private readonly items: TaskRecord[] = [];

  private activeTaskId: string | null = null;

  private draining = false;

  constructor(
    private readonly store: TaskStore,
    private readonly runner: CodexRunner,
    private readonly callbacks: QueueCallbacks = {}
  ) {}

  enqueue(task: TaskRecord): number {
    this.items.push(task);
    this.store.appendTaskEvent(task.id, 'queue.enqueued', '任务已进入本机 FIFO 队列');
    void this.drain();
    return this.items.length;
  }

  async cancelTask(taskId: string): Promise<{
    cancelled: boolean;
    message: string;
  }> {
    const queuedIndex = this.items.findIndex((task) => task.id === taskId);

    if (queuedIndex >= 0) {
      const [task] = this.items.splice(queuedIndex, 1);

      if (!task) {
        return {
          cancelled: false,
          message: `未找到任务：${taskId}`
        };
      }

      const cancelledTask = this.store.updateTaskStatus(task.id, {
        status: 'cancelled',
        errorMessage: '任务在开始前被取消'
      });
      await this.notifyCancelled(cancelledTask, '任务在开始前被取消');

      return {
        cancelled: true,
        message: `任务已取消：${taskId}`
      };
    }

    const task = this.store.getTask(taskId);

    if (!task) {
      return {
        cancelled: false,
        message: `未找到任务：${taskId}`
      };
    }

    if (task.status === 'pending_confirmation') {
      const cancelledTask = this.store.updateTaskStatus(taskId, {
        status: 'cancelled',
        errorMessage: '任务在确认前被取消'
      });
      await this.notifyCancelled(cancelledTask, '任务在确认前被取消');

      return {
        cancelled: true,
        message: `任务已取消：${taskId}`
      };
    }

    if (this.activeTaskId === taskId && task.status === 'running') {
      const cancelledTask = this.store.updateTaskStatus(taskId, {
        status: 'cancelled',
        errorMessage:
          '运行中任务已标记取消；第一版不会主动终止 Codex 子进程'
      });
      await this.notifyCancelled(
        cancelledTask,
        '运行中任务已标记取消；第一版不会主动终止 Codex 子进程'
      );

      return {
        cancelled: true,
        message: `运行中的任务已标记取消：${taskId}`
      };
    }

    return {
      cancelled: false,
      message: `任务当前状态为 ${task.status}，无法取消`
    };
  }

  getQueueLength(): number {
    return this.items.length;
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }

    this.draining = true;

    try {
      while (this.items.length > 0) {
        const task = this.items.shift();

        if (!task) {
          continue;
        }

        this.activeTaskId = task.id;
        await this.runTask(task);
        this.activeTaskId = null;
      }
    } finally {
      this.activeTaskId = null;
      this.draining = false;
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    const runningTask = this.store.updateTaskStatus(task.id, {
      status: 'running'
    });
    await this.safeNotify(task.id, 'notify.started', () =>
      this.callbacks.onTaskStarted?.(runningTask)
    );

    let result: CodexRunResult;

    try {
      result = await this.runner.run(runningTask);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failedTask = this.store.updateTaskStatus(task.id, {
        status: 'failed',
        errorMessage
      });
      await this.safeNotify(task.id, 'notify.failed', () =>
        this.callbacks.onTaskErrored?.(failedTask, errorMessage)
      );
      return;
    }

    const latestTask = this.store.getTask(task.id);

    if (latestTask?.status === 'cancelled') {
      return;
    }

    if (result.errorMessage) {
      const failedTask = this.store.updateTaskStatus(task.id, {
        status: 'failed',
        finalSummary: result.summary,
        errorMessage: result.errorMessage
      });
      await this.safeNotify(task.id, 'notify.failed', () =>
        this.callbacks.onTaskFailed?.(failedTask, result)
      );
      return;
    }

    const succeededTask = this.store.updateTaskStatus(task.id, {
      status: 'succeeded',
      finalSummary: result.summary
    });
    await this.safeNotify(task.id, 'notify.succeeded', () =>
      this.callbacks.onTaskSucceeded?.(succeededTask, result)
    );
  }

  private async notifyCancelled(
    task: TaskRecord,
    reason: string
  ): Promise<void> {
    await this.safeNotify(task.id, 'notify.cancelled', () =>
      this.callbacks.onTaskCancelled?.(task, reason)
    );
  }

  private async safeNotify(
    taskId: string,
    eventType: string,
    notify: () => Promise<void> | undefined
  ): Promise<void> {
    try {
      await notify();
    } catch (error) {
      this.store.appendTaskEvent(
        taskId,
        eventType,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
