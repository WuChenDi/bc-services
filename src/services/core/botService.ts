import { Bot } from 'grammy'
import { BaseService } from '@/services'
import type { ServiceContainer } from '@/services'
import type {
  BotApiResult,
  BotServiceStats,
  SendMessageOptions,
  ServiceHealthStatus,
} from '@/types'

/**
 * Telegram Bot 服务
 * 
 * 职责:
 * 1. 🤖 封装 Telegram Bot API 调用
 * 2. 📊 统计和监控 Bot 操作
 * 3. 🛡️ 错误处理和重试机制
 * 4. ⚡ 性能优化和限流
 * 5. 📝 Bot 操作日志记录
 */
export class BotService extends BaseService {
  public readonly bot: Bot;
  private stats: BotServiceStats;
  private rateLimitQueue: Array<() => Promise<any>> = [];
  private isProcessingQueue = false;

  constructor(container: ServiceContainer) {
    super(container, {
      name: 'BotService',
      debug: false
    });

    // 初始化 Bot 实例
    this.bot = new Bot(this.context.env.BOT_TOKEN);

    // 初始化统计信息
    this.stats = {
      total: 0,
      successful: 0,
      failed: 0,
      messagesSent: 0,
      messagesReceived: 0,
      diceRolled: 0,
      apiCalls: 0,
      errors: 0,
      uptime: 0,
      lastActivity: Date.now()
    };

    this.logger.info('Bot服务已初始化', {
      operation: 'bot-service-init',
      botToken: this.context.env.BOT_TOKEN ? 'configured' : 'missing'
    });
  }

  /**
   * 服务初始化
   */
  override async initialize(): Promise<void> {
    const timer = this.createTimer('bot-initialize');

    try {
      // 验证 Bot Token
      const botInfo = await this.bot.api.getMe();

      this.logger.info('Bot信息已获取', {
        operation: 'bot-info',
        botId: botInfo.id,
        botUsername: botInfo.username,
        botName: botInfo.first_name
      });

      timer.end({
        success: true,
        botId: botInfo.id,
        botUsername: botInfo.username
      });
    } catch (error) {
      this.logger.error('Bot初始化失败', {
        operation: 'bot-init-error'
      }, error);
      timer.end({ success: false, error: true });
      throw new Error(`Bot初始化失败: ${error}`);
    }
  }

  /**
   * 发送文本消息
   * 
   * @param chatId - 聊天ID
   * @param message - 消息内容
   * @param options - 发送选项
   * @returns 发送结果
   */
  async sendMessage(
    chatId: string | number,
    message: string,
    options: SendMessageOptions = {}
  ): Promise<BotApiResult> {
    const timer = this.createTimer('send-message', {
      chatId: chatId.toString(),
      messageLength: message.length
    });

    try {
      const result = await this.executeWithRateLimit(async () => {
        const sendOptions: any = {};
        if (options.parseMode) sendOptions.parse_mode = options.parseMode;
        if (options.disableWebPagePreview) sendOptions.disable_web_page_preview = options.disableWebPagePreview;
        if (options.disableNotification) sendOptions.disable_notification = options.disableNotification;
        if (options.replyToMessageId) sendOptions.reply_to_message_id = options.replyToMessageId;
        if (options.allowSendingWithoutReply) sendOptions.allow_sending_without_reply = options.allowSendingWithoutReply;

        return await this.bot.api.sendMessage(chatId, message, sendOptions);
      });

      // 更新统计
      this.stats.messagesSent++;
      this.stats.lastActivity = Date.now();

      this.logger.info('消息发送成功', {
        operation: 'send-message-success',
        chatId: chatId.toString(),
        messageId: result.message_id,
        parseMode: options.parseMode
      });

      timer.end({
        success: true,
        messageId: result.message_id,
        chatId: chatId.toString()
      });

      return {
        success: true,
        data: result
      };
    } catch (error) {
      this.stats.errors++;

      this.logger.error('消息发送失败', {
        operation: 'send-message-error',
        chatId: chatId.toString(),
        messageLength: message.length,
        parseMode: options.parseMode
      }, error);

      timer.end({ success: false, error: true });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryable: this.isRetryableError(error)
      };
    }
  }

  /**
   * 发送骰子
   * 
   * @param chatId - 聊天ID
   * @param emoji - 骰子表情 (默认: 🎲)
   * @returns 发送结果
   */
  async sendDice(
    chatId: string | number,
    emoji: string = '🎲'
  ): Promise<BotApiResult> {
    const timer = this.createTimer('send-dice', {
      chatId: chatId.toString(),
      emoji
    });

    try {
      const result = await this.executeWithRateLimit(async () => {
        return await this.bot.api.sendDice(chatId, emoji);
      });

      // 更新统计
      this.stats.diceRolled++;
      this.stats.lastActivity = Date.now();

      const diceValue = result.dice?.value;

      this.logger.info('骰子发送成功', {
        operation: 'send-dice-success',
        chatId: chatId.toString(),
        messageId: result.message_id,
        diceValue,
        emoji
      });

      timer.end({
        success: true,
        messageId: result.message_id,
        diceValue,
        chatId: chatId.toString()
      });

      return {
        success: true,
        data: result
      };
    } catch (error) {
      this.stats.errors++;

      this.logger.error('骰子发送失败', {
        operation: 'send-dice-error',
        chatId: chatId.toString(),
        emoji
      }, error);

      timer.end({ success: false, error: true });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryable: this.isRetryableError(error)
      };
    }
  }

  /**
   * 设置 Webhook
   * 
   * @param url - Webhook URL
   * @returns 设置结果
   */
  async setWebhook(url: string): Promise<BotApiResult> {
    const timer = this.createTimer('set-webhook', { url });

    try {
      // 验证 URL 格式
      new URL(url);

      const result = await this.executeWithRateLimit(async () => {
        return await this.bot.api.setWebhook(url);
      });

      this.logger.info('Webhook设置成功', {
        operation: 'set-webhook-success',
        url
      });

      timer.end({ success: true, url });

      return {
        success: true,
        data: result
      };
    } catch (error) {
      this.stats.errors++;

      this.logger.error('Webhook设置失败', {
        operation: 'set-webhook-error',
        url
      }, error);

      timer.end({ success: false, error: true });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryable: this.isRetryableError(error)
      };
    }
  }

  /**
   * 获取 Bot 信息
   * 
   * @returns Bot 信息
   */
  async getBotInfo(): Promise<BotApiResult> {
    const timer = this.createTimer('get-bot-info');

    try {
      const result = await this.executeWithRateLimit(async () => {
        return await this.bot.api.getMe();
      });

      this.logger.debug('Bot信息获取成功', {
        operation: 'get-bot-info-success',
        botId: result.id,
        botUsername: result.username
      });

      timer.end({ success: true, botId: result.id });

      return {
        success: true,
        data: result
      };
    } catch (error) {
      this.stats.errors++;

      this.logger.error('Bot信息获取失败', {
        operation: 'get-bot-info-error'
      }, error);

      timer.end({ success: false, error: true });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryable: this.isRetryableError(error)
      };
    }
  }

  /**
   * 获取聊天信息
   * 
   * @param chatId - 聊天ID
   * @returns 聊天信息
   */
  async getChatInfo(chatId: string | number): Promise<BotApiResult> {
    const timer = this.createTimer('get-chat-info', {
      chatId: chatId.toString()
    });

    try {
      const result = await this.executeWithRateLimit(async () => {
        return await this.bot.api.getChat(chatId);
      });

      this.logger.debug('聊天信息获取成功', {
        operation: 'get-chat-info-success',
        chatId: chatId.toString(),
        chatType: result.type,
        chatTitle: result.title
      });

      timer.end({
        success: true,
        chatId: chatId.toString(),
        chatType: result.type
      });

      return {
        success: true,
        data: result
      };
    } catch (error) {
      this.stats.errors++;

      this.logger.error('聊天信息获取失败', {
        operation: 'get-chat-info-error',
        chatId: chatId.toString()
      }, error);

      timer.end({ success: false, error: true });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryable: this.isRetryableError(error)
      };
    }
  }

  /**
   * 执行带限流的 API 调用
   * 
   * @param apiCall - API 调用函数
   * @returns API 调用结果
   */
  private async executeWithRateLimit<T>(apiCall: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.rateLimitQueue.push(async () => {
        try {
          this.stats.apiCalls++;
          const result = await apiCall();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  /**
   * 处理限流队列
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.rateLimitQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.rateLimitQueue.length > 0) {
      const apiCall = this.rateLimitQueue.shift();
      if (apiCall) {
        try {
          await apiCall();
        } catch (error) {
          // 错误已在 executeWithRateLimit 中处理
        }

        // 简单的限流 - 每次API调用间隔50ms
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * 判断错误是否可重试
   * 
   * @param error - 错误对象
   * @returns 是否可重试
   */
  private isRetryableError(error: any): boolean {
    if (error?.error_code) {
      // Telegram API 错误码
      const retryableCodes = [429, 500, 502, 503, 504];
      return retryableCodes.includes(error.error_code);
    }

    // 网络相关错误
    if (error?.code) {
      const retryableNetworkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
      return retryableNetworkCodes.includes(error.code);
    }

    return false;
  }

  /**
   * 获取服务统计信息
   * 
   * @returns 统计信息
   */
  getStats(): BotServiceStats {
    return {
      ...this.stats,
      uptime: this.getUptime()
    };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      total: 0,
      successful: 0,
      failed: 0,
      messagesSent: 0,
      messagesReceived: 0,
      diceRolled: 0,
      apiCalls: 0,
      errors: 0,
      uptime: 0,
      lastActivity: Date.now()
    };

    this.logger.info('统计信息已重置', {
      operation: 'reset-stats'
    });
  }

  /**
   * 自定义健康检查
   */
  protected override getCustomHealth(): Partial<ServiceHealthStatus> {
    const stats = this.getStats();
    const timeSinceLastActivity = Date.now() - stats.lastActivity;

    // 如果超过5分钟没有活动，标记为不健康
    const isHealthy = timeSinceLastActivity < 5 * 60 * 1000;

    return {
      healthy: isHealthy,
      message: isHealthy
        ? 'Bot service is active and responding'
        : `No activity for ${Math.round(timeSinceLastActivity / 1000)}s`,
      details: {
        stats,
        timeSinceLastActivity,
        queueLength: this.rateLimitQueue.length,
        isProcessingQueue: this.isProcessingQueue,
        botToken: this.context.env.BOT_TOKEN ? 'configured' : 'missing'
      }
    };
  }

  /**
   * 清理资源
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();

    // 清空限流队列
    this.rateLimitQueue = [];
    this.isProcessingQueue = false;

    this.logger.info('Bot服务已清理', {
      operation: 'bot-service-cleanup',
      finalStats: this.getStats()
    });
  }
}
