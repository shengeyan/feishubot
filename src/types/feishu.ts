export type FeishuTextMessage = {
  chatId: string;
  messageId: string;
  senderUserId: string;
  text: string;
};

export type ParsedCodexCommand =
  | { type: 'ignore'; reason: string }
  | { type: 'invalid'; message: FeishuTextMessage; reason: string }
  | { type: 'help'; message: FeishuTextMessage }
  | { type: 'repos'; message: FeishuTextMessage }
  | { type: 'clear'; message: FeishuTextMessage }
  | { type: 'status'; message: FeishuTextMessage; taskId: string }
  | { type: 'approve'; message: FeishuTextMessage; taskId: string }
  | { type: 'reject'; message: FeishuTextMessage; taskId: string }
  | { type: 'cancel'; message: FeishuTextMessage; taskId: string }
  | { type: 'stop'; message: FeishuTextMessage; taskId: string }
  | { type: 'file'; message: FeishuTextMessage; taskId: string; artifact?: string }
  | { type: 'send_file'; message: FeishuTextMessage; filePathInput: string }
  | {
      type: 'task';
      message: FeishuTextMessage;
      repoInput: string;
      prompt: string;
    };
