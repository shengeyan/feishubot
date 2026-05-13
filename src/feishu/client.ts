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
  sendCard: (chatId: string, card: Lark.InteractiveCard | string) => Promise<void>;
  updateCard: (
    messageId: string,
    card: Lark.InteractiveCard | string
  ) => Promise<void>;
};

type CreateFeishuClientOptions = {
  config: AppConfig;
  onTextMessage: (message: ReturnType<typeof extractTextMessage>) => Promise<void>;
};

export function createFeishuClient({
  config,
  onTextMessage
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
