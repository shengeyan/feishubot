import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveRepoPath } from '../security/policy.js';

export type ProjectIntent =
  | {
      type: 'matched';
      repoPath: string;
      projectName: string;
      prompt: string;
    }
  | {
      type: 'missing';
      reason: string;
    }
  | {
      type: 'none';
    };

export function resolveProjectIntent(
  text: string,
  workspaceDir: string
): ProjectIntent {
  const explicitPath = extractExplicitPath(text);

  if (explicitPath) {
    try {
      const repoPath = resolveRepoPath(explicitPath);
      return {
        type: 'matched',
        repoPath,
        projectName: path.basename(repoPath),
        prompt: text
      };
    } catch (error) {
      return {
        type: 'missing',
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  const projects = listProjects([workspaceDir]);
  const lowerText = text.toLowerCase();
  const matchedProject = projects.find((project) =>
    lowerText.includes(project.name.toLowerCase())
  );

  if (matchedProject) {
    return {
      type: 'matched',
      repoPath: matchedProject.path,
      projectName: matchedProject.name,
      prompt: text
    };
  }

  if (looksLikeProjectRequest(text)) {
    return {
      type: 'missing',
      reason: [
        '我感觉这是一个项目任务，但没从消息里识别到本机项目。',
        `当前会从这个目录查找项目：${workspaceDir}`,
        '你可以直接写项目绝对路径，例如：请处理 /Users/hero/Documents/workspace/heroverse 里的 build 报错'
      ].join('\n')
    };
  }

  return { type: 'none' };
}

export function formatKnownProjects(workspaceDir: string): string {
  const projects = listProjects([workspaceDir]);

  if (projects.length === 0) {
    return [
      '当前没有在项目根目录下发现项目。',
      `项目根目录：${workspaceDir}`
    ].join('\n');
  }

  return projects
    .map((project) => `${project.name}: ${project.path}`)
    .join('\n');
}

function listProjects(roots: string[]): Array<{ name: string; path: string }> {
  const projects = roots.flatMap((root) => {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return [];
    }

    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const projectPath = realpathSync.native(path.join(root, entry.name));
        return {
          name: entry.name,
          path: projectPath
        };
      });
  });

  return [...new Map(projects.map((project) => [project.path, project])).values()]
    .sort((left, right) => right.name.length - left.name.length);
}

function extractExplicitPath(text: string): string | null {
  const match = /(?:^|[\s，。；,;])((?:~|\/Users|\/Volumes|\/private|\/tmp|\/var)\/[^\s，。；,;]+)/u.exec(
    text
  );

  if (!match?.[1]) {
    return null;
  }

  return expandHome(match[1]);
}

function looksLikeProjectRequest(text: string): boolean {
  return (
    /项目|仓库|代码|需求|修复|实现|处理|检查|build|lint|bug|页面|接口/u.test(
      text
    ) && !/^\/?codex(?:\s|$)/iu.test(text)
  );
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
