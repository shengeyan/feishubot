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
  const searchRoots = getProjectSearchRoots(workspaceDir);

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

  const projects = listProjects(searchRoots);
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
        `当前会从这些目录查找项目：${searchRoots.join('、')}`,
        '你可以直接写项目绝对路径，例如：请处理 /Users/hero/Documents/workspace/heroverse 里的 build 报错'
      ].join('\n')
    };
  }

  return { type: 'none' };
}

export function formatKnownProjects(workspaceDir: string): string {
  const searchRoots = getProjectSearchRoots(workspaceDir);
  const projects = listProjects(searchRoots);

  if (projects.length === 0) {
    return [
      '当前没有在项目根目录下发现项目。',
      `项目查找目录：${searchRoots.join('、')}`
    ].join('\n');
  }

  return projects
    .map((project) => `${project.name}: ${project.path}`)
    .join('\n');
}

function getProjectSearchRoots(workspaceDir: string): string[] {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const workspaceParentDir = path.dirname(resolvedWorkspaceDir);
  const homeDir = os.homedir();
  const candidates = [
    resolvedWorkspaceDir,
    workspaceParentDir,
    path.join(homeDir, 'Documents'),
    path.join(homeDir, 'Documents', 'workspace'),
    path.join(homeDir, 'workspace'),
    path.join(homeDir, 'Projects'),
    path.join(homeDir, 'projects'),
    path.join(homeDir, 'Developer'),
    path.join(homeDir, 'code'),
    path.join(homeDir, 'repos')
  ];

  return uniqueStrings(
    candidates
      .filter((root) => root !== homeDir && root !== path.parse(root).root)
      .map((root) => tryRealpathDirectory(root))
      .filter((root): root is string => Boolean(root))
  );
}

function listProjects(roots: string[]): Array<{ name: string; path: string }> {
  const projects = roots.flatMap((root) => {
    if (!isExistingDirectory(root)) {
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

function tryRealpathDirectory(root: string): string | null {
  if (!isExistingDirectory(root)) {
    return null;
  }

  return realpathSync.native(root);
}

function isExistingDirectory(root: string): boolean {
  try {
    return existsSync(root) && statSync(root).isDirectory();
  } catch {
    return false;
  }
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
