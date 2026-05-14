import { existsSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../config.js';

export function isAllowedUser(userId: string, config: AppConfig): boolean {
  return config.allowedUserIds.includes(userId);
}

export function resolveRepoPath(input: string): string {
  const repoPath = expandHome(input.trim());
  const absoluteRepoPath = path.resolve(repoPath);

  if (!existsSync(absoluteRepoPath)) {
    throw new Error(`路径不存在：${absoluteRepoPath}`);
  }

  const realRepoPath = realpathSync.native(absoluteRepoPath);

  if (!statSync(realRepoPath).isDirectory()) {
    throw new Error(`路径不是目录：${realRepoPath}`);
  }

  return realRepoPath;
}

export function resolveLocalFilePath(input: string): string {
  const filePath = expandHome(input.trim());
  const absoluteFilePath = path.resolve(filePath);

  if (!existsSync(absoluteFilePath)) {
    throw new Error(`文件不存在：${absoluteFilePath}`);
  }

  const realFilePath = realpathSync.native(absoluteFilePath);

  if (!statSync(realFilePath).isFile()) {
    throw new Error(`路径不是普通文件：${realFilePath}`);
  }

  return realFilePath;
}

export function describeRepoAccessPolicy(): string {
  return [
    '当前没有仓库路径白名单。',
    '任意存在的本机目录都可以作为 repo 提交，但 Agent 不会立即执行。',
    '每个任务都会先进入 pending_confirmation，必须回复 /approve <taskId> 后才会运行。'
  ].join('\n');
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}
