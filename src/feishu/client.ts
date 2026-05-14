import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';

import type { AppConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { extractTextMessage } from './messages.js';

export type FeishuMessageHandler = NonNullable<
  ConstructorParameters<typeof Lark.EventDispatcher>[0]
>;

export type FeishuAgentClient = {
  start: () => Promise<void>;
  close: () => void;
  sendText: (chatId: string, text: string) => Promise<void>;
  sendFile: (
    chatId: string,
    filePath: string,
    fileName?: string
  ) => Promise<void>;
  sendCard: (chatId: string, card: Lark.InteractiveCard | string) => Promise<void>;
  updateCard: (
    messageId: string,
    card: Lark.InteractiveCard | string
  ) => Promise<void>;
};

export type FeishuCardActionEvent = {
  open_message_id?: string;
  open_chat_id?: string;
  context?: {
    open_message_id?: string;
    open_chat_id?: string;
  };
  operator?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
    name?: string;
  };
  open_id?: string;
  user_id?: string;
  action?: {
    value?: unknown;
    tag?: string;
    name?: string;
    option?: string;
    timezone?: string;
  };
};

type CreateFeishuClientOptions = {
  config: AppConfig;
  onTextMessage: (message: ReturnType<typeof extractTextMessage>) => Promise<void>;
  onCardAction?: (
    event: FeishuCardActionEvent
  ) => Promise<Lark.InteractiveCard | undefined>;
};

const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;

export function createFeishuClient({
  config,
  onTextMessage,
  onCardAction
}: CreateFeishuClientOptions): FeishuAgentClient {
  const baseConfig = {
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: Lark.LoggerLevel.info
  };

  const client = new Lark.Client(baseConfig);
  const wsClient = new Lark.WSClient({
    ...baseConfig,
    onReady: () => {
      logger.info('Feishu long connection is ready');
    },
    onError: (error) => {
      logger.error({ error: error.message }, 'Feishu long connection failed');
    },
    onReconnecting: () => {
      logger.warn('Feishu long connection is reconnecting');
    },
    onReconnected: () => {
      logger.info('Feishu long connection reconnected');
    }
  });
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (event) => {
      logger.info(
        {
          messageId: event.message?.message_id,
          chatId: event.message?.chat_id,
          messageType: event.message?.message_type,
          senderId: event.sender?.sender_id
        },
        'Received Feishu message event'
      );

      const textMessage = extractTextMessage(event);

      if (!textMessage) {
        logger.warn(
          {
            messageId: event.message?.message_id,
            messageType: event.message?.message_type
          },
          'Ignored Feishu event because it was not a text message'
        );
      }

      await onTextMessage(textMessage);
    },
    'card.action.trigger': async (event: FeishuCardActionEvent) => {
      logger.info(
        {
          messageId: event.context?.open_message_id ?? event.open_message_id,
          chatId: event.context?.open_chat_id ?? event.open_chat_id,
          operator: event.operator,
          action: event.action
        },
        'Received Feishu card action event'
      );

      return onCardAction?.(event);
    }
  });

  return {
    start: async () => {
      await wsClient.start({ eventDispatcher });
    },
    close: () => {
      wsClient.close();
    },
    sendText: async (chatId, text) => {
      try {
        logger.info({ chatId, length: text.length }, 'Sending Feishu text message');
        await client.im.v1.message.create({
          params: {
            receive_id_type: 'chat_id'
          },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text })
          }
        });
      } catch (error) {
        logger.error(
          { chatId, error: error instanceof Error ? error.message : String(error) },
          'Failed to send Feishu text message'
        );
        throw error;
      }
    },
    sendFile: async (chatId, filePath, fileName) => {
      const fileStat = statSync(filePath);

      if (!fileStat.isFile()) {
        throw new Error(`只能发送普通文件：${filePath}`);
      }

      if (fileStat.size <= 0) {
        throw new Error(`飞书不允许上传空文件：${filePath}`);
      }

      if (fileStat.size > FEISHU_FILE_MAX_BYTES) {
        throw new Error(
          `文件超过飞书 30MB 上传限制：${filePath} (${fileStat.size} bytes)`
        );
      }

      const displayName = fileName ?? path.basename(filePath);
      logger.info(
        { chatId, filePath, fileName: displayName, size: fileStat.size },
        'Uploading Feishu file'
      );

      const uploaded = await client.im.v1.file.create({
        data: {
          file_type: getFeishuFileType(displayName),
          file_name: displayName,
          file: createReadStream(filePath)
        }
      });
      const fileKey = uploaded?.file_key;

      if (!fileKey) {
        throw new Error(`飞书文件上传未返回 file_key：${filePath}`);
      }

      await client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id'
        },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey })
        }
      });
    },
    sendCard: async (chatId, card) => {
      await client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id'
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: typeof card === 'string' ? card : JSON.stringify(card)
        }
      });
    },
    updateCard: async (messageId, card) => {
      await client.im.v1.message.patch({
        path: {
          message_id: messageId
        },
        data: {
          content: typeof card === 'string' ? card : JSON.stringify(card)
        }
      });
    }
  };
}

function getFeishuFileType(
  fileName: string
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const extension = path.extname(fileName).toLowerCase();

  if (extension === '.opus') {
    return 'opus';
  }

  if (extension === '.mp4') {
    return 'mp4';
  }

  if (extension === '.pdf') {
    return 'pdf';
  }

  if (extension === '.doc' || extension === '.docx') {
    return 'doc';
  }

  if (extension === '.xls' || extension === '.xlsx') {
    return 'xls';
  }

  if (extension === '.ppt' || extension === '.pptx') {
    return 'ppt';
  }

  return 'stream';
}
