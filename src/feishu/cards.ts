import type * as Lark from '@larksuiteoapi/node-sdk';

import type { TaskRecord } from '../types/tasks.js';

type CardTemplate =
  | 'blue'
  | 'wathet'
  | 'turquoise'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'carmine'
  | 'violet'
  | 'purple'
  | 'indigo'
  | 'grey';

export type TaskCardActionKind = 'approve' | 'reject' | 'stop';

export type TaskCardActionValue = {
  source: 'feishu-codex-agent';
  action: TaskCardActionKind;
  taskId: string;
};

export function buildPendingTaskCard(
  task: TaskRecord,
  prompt = task.prompt
): Lark.InteractiveCard {
  return buildTaskCard({
    title: '任务待确认',
    template: 'orange',
    task,
    statusText: 'pending_confirmation',
    body: ['任务描述：', prompt].join('\n'),
    actions: [
      button('确认执行', 'primary', 'approve', task.id),
      button('拒绝执行', 'danger', 'reject', task.id, {
        title: '拒绝执行？',
        text: '任务会被标记为 cancelled，不会交给 Codex 执行。'
      })
    ],
    note: '涉及本地项目操作，确认后才会运行。'
  });
}

export function buildQueuedTaskCard(
  task: TaskRecord,
  queueLength: number
): Lark.InteractiveCard {
  return buildTaskCard({
    title: '任务已入队',
    template: 'blue',
    task,
    statusText: 'queued',
    body: `队列长度：${queueLength}`,
    actions: [
      button('取消任务', 'danger', 'stop', task.id, {
        title: '取消任务？',
        text: '未开始任务会直接取消；运行中任务会中断 Codex 子进程。'
      })
    ]
  });
}

export function buildRunningTaskCard(task: TaskRecord): Lark.InteractiveCard {
  return buildTaskCard({
    title: '任务执行中',
    template: 'green',
    task,
    statusText: 'running',
    body: 'Codex 正在处理这个任务。',
    actions: [
      button('中断任务', 'danger', 'stop', task.id, {
        title: '中断任务？',
        text: '将向 Codex 子进程发送 SIGTERM，必要时会在数秒后强制结束。'
      })
    ]
  });
}

export function buildCancelledTaskCard(
  task: TaskRecord,
  reason: string
): Lark.InteractiveCard {
  return buildTaskCard({
    title: '任务已取消',
    template: 'grey',
    task,
    statusText: task.status,
    body: reason
  });
}

export function buildTaskInfoCard(input: {
  title: string;
  template: CardTemplate;
  task?: TaskRecord | null;
  body: string;
}): Lark.InteractiveCard {
  return buildTaskCard({
    title: input.title,
    template: input.template,
    task: input.task,
    statusText: input.task?.status ?? '-',
    body: input.body
  });
}

export function parseTaskCardActionValue(
  value: unknown
): TaskCardActionValue | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (candidate.source !== 'feishu-codex-agent') {
    return null;
  }

  if (
    candidate.action !== 'approve' &&
    candidate.action !== 'reject' &&
    candidate.action !== 'stop'
  ) {
    return null;
  }

  if (typeof candidate.taskId !== 'string' || !candidate.taskId) {
    return null;
  }

  return {
    source: 'feishu-codex-agent',
    action: candidate.action,
    taskId: candidate.taskId
  };
}

function buildTaskCard(input: {
  title: string;
  template: CardTemplate;
  task?: TaskRecord | null;
  statusText: string;
  body: string;
  actions?: Lark.InteractiveCardActionItem[];
  note?: string;
}): Lark.InteractiveCard {
  const elements: Lark.InteractiveCardElement[] = [
    {
      tag: 'markdown',
      content: [
        `**任务 ID：** ${input.task?.id ?? '-'}`,
        `**状态：** ${input.statusText}`,
        `**仓库：** ${input.task?.repo ?? '-'}`
      ].join('\n')
    },
    {
      tag: 'markdown',
      content: input.body
    }
  ];

  if (input.actions?.length) {
    elements.push({
      tag: 'action',
      layout: input.actions.length >= 2 ? 'bisected' : 'flow',
      actions: input.actions
    });
  }

  if (input.note) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: input.note }]
    });
  }

  return {
    config: {
      enable_forward: false,
      update_multi: true,
      wide_screen_mode: true
    },
    header: {
      template: input.template,
      title: {
        tag: 'plain_text',
        content: input.title
      }
    },
    elements
  };
}

function button(
  text: string,
  type: 'default' | 'primary' | 'danger',
  action: TaskCardActionKind,
  taskId: string,
  confirm?: { title: string; text: string }
): Lark.InteractiveCardButtonActionItem {
  return {
    tag: 'button',
    type,
    text: {
      tag: 'plain_text',
      content: text
    },
    value: {
      source: 'feishu-codex-agent',
      action,
      taskId
    },
    confirm: confirm
      ? {
          title: { tag: 'plain_text', content: confirm.title },
          text: { tag: 'plain_text', content: confirm.text }
        }
      : undefined
  };
}
