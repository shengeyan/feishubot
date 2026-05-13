import 'dotenv/config';

import path from 'node:path';

import { z } from 'zod';

export type AppConfig = {
  feishu: {
    appId: string;
    appSecret: string;
  };
  allowedUserIds: string[];
  taskTimeoutMs: number;
  dataDir: string;
  logLevel: string;
};

const envSchema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_ALLOWED_USER_IDS: z.string().min(1),
  TASK_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  DATA_DIR: z.string().min(1).default('data'),
  LOG_LEVEL: z.string().min(1).default('info')
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const dataDir = path.resolve(parsed.DATA_DIR);

  return {
    feishu: {
      appId: parsed.FEISHU_APP_ID,
      appSecret: parsed.FEISHU_APP_SECRET
    },
    allowedUserIds: parseCsv(parsed.FEISHU_ALLOWED_USER_IDS),
    taskTimeoutMs: parsed.TASK_TIMEOUT_MS,
    dataDir,
    logLevel: parsed.LOG_LEVEL
  };
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
