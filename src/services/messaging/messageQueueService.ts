import { BaseService, BotService } from '@/services'
import type { ServiceContainer } from '@/services'
import { sleep } from '@/utils'
import type {
  ServiceHealthStatus,
  QueuedMessage,
  DiceMessage,
  TextMessage,
  MessageProcessResult,
  QueueStatus,
  MessageQueueStats,
  MessageQueueConfig,
  MessageFilter,
  MessageMiddleware,
  WaitForMessageOptions,
} from '@/types'
import { MessageType } from '@/types'

/**
 * 消息队列服务
 * 
 * 职责:
 * 1. 📨 严格按序列号顺序处理消息
 * 2. 🎲 特殊处理骰子消息和阻塞逻辑
 * 3. 🔄 消息重试和错误恢复
 * 4. ⚡ 限流和并发控制
 * 5. 📊 队列监控和统计
 * 6. 🛡️ 消息过滤和中间件支持
 */
export class MessageQueueService extends BaseService {
  private queue: QueuedMessage[] = [];
  private processing: boolean = false;
  private messageCounter = 0;
  private sequenceCounter = 0;
  private currentGameId: string | null = null;

  // 配置和统计
  private queueConfig: MessageQueueConfig;
  private stats: MessageQueueStats;

  // 中间件和过滤器
  private filters: MessageFilter[] = [];
  private middlewares: MessageMiddleware[] = [];

  // 等待映射 - 用于阻塞消息等待
  private waitingPromises: Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout?: number;
  }> = new Map();

  constructor(container: ServiceContainer) {
    super(container, {
      name: 'MessageQueueService',
      debug: false
    });

    // 初始化配置
    this.queueConfig = {
      maxRetries: 3,
      retryBaseDelay: 1000,
      messageInterval: this.context.constants.MESSAGE_DELAY_MS,
      diceAnimationWait: this.context.constants.DICE_ANIMATION_WAIT_MS,
      diceResultDelay: this.context.constants.DICE_RESULT_DELAY_MS,
      queueTimeout: 30000,
      enablePriority: true,
      maxQueueLength: 100
    };

    // 初始化统计
    this.stats = {
      totalProcessed: 0,
      successfulMessages: 0,
      failedMessages: 0,
      textMessages: 0,
      diceMessages: 0,
      retriedMessages: 0,
      averageProcessingTime: 0,
      maxQueueLength: 0,
      lastProcessedTime: Date.now(),
      errorRate: 0
    };

    this.logger.info('消息队列服务已初始化', {
      operation: 'message-queue-init',
      config: this.queueConfig
    });
  }

  /**
   * 设置当前游戏ID，用于消息序列控制
   */
  setCurrentGame(gameId: string): void {
    const previousGameId = this.currentGameId;
    this.currentGameId = gameId;
    this.sequenceCounter = 0; // 重置序列计数器

    // 同步更新容器的游戏上下文
    this.container.updateGameContext(gameId);

    this.logger.info('新游戏已设置，序列已重置', {
      operation: 'set-current-game',
      gameId,
      previousGameId,
      resetSequence: this.sequenceCounter,
      queueLength: this.queue.length
    });

    // 清理与旧游戏相关的等待Promise
    this.cleanupWaitingPromises('游戏切换');
  }

  /**
   * 添加文本消息到队列
   */
  async enqueueMessage(
    chatId: string,
    content: string,
    isBlocking: boolean = false,
    parseMode: 'Markdown' | 'HTML' = 'Markdown',
    priority?: number
  ): Promise<string> {
    const timer = this.createTimer('enqueue-message', {
      chatId,
      isBlocking,
      contentLength: content.length
    });

    try {
      // 检查队列长度限制
      if (this.queue.length >= this.queueConfig.maxQueueLength) {
        throw new Error(`Queue length exceeded limit: ${this.queueConfig.maxQueueLength}`);
      }

      const id = `msg_${++this.messageCounter}_${Date.now()}`;
      const sequenceId = ++this.sequenceCounter;

      const message: TextMessage = {
        id,
        chatId,
        content,
        parseMode,
        type: MessageType.TEXT,
        sequenceId,
        retries: 0,
        timestamp: Date.now(),
        isBlocking,
        priority: priority || 5,
        disableWebPagePreview: false,
        disableNotification: false
      };

      this.logger.debug('添加文本消息到队列', {
        operation: 'enqueue-text-message',
        messageId: id,
        sequenceId,
        isBlocking,
        priority: message.priority,
        contentLength: content.length,
        queueLength: this.queue.length
      });

      await this.addToQueue(message);

      // 如果是阻塞消息，等待处理完成
      if (isBlocking) {
        await this.waitForMessage(id, { timeout: this.queueConfig.queueTimeout });
      }

      timer.end({
        success: true,
        messageId: id,
        isBlocking
      });

      return id;
    } catch (error) {
      this.logger.error('添加文本消息失败', {
        operation: 'enqueue-message-error',
        chatId,
        isBlocking,
        queueLength: this.queue.length
      }, error);

      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 添加骰子消息到队列（总是阻塞的）
   */
  async enqueueDice(
    chatId: string,
    playerType: string,
    cardIndex: number,
    emoji: string = '🎲'
  ): Promise<number> {
    const timer = this.createTimer('enqueue-dice', {
      chatId,
      playerType,
      cardIndex
    });

    return new Promise(async (resolve, reject) => {
      try {
        const id = `dice_${++this.messageCounter}_${Date.now()}`;
        const sequenceId = ++this.sequenceCounter;

        this.logger.info('添加骰子消息到队列', {
          operation: 'enqueue-dice',
          messageId: id,
          sequenceId,
          playerType,
          cardIndex,
          queueLength: this.queue.length
        });

        const diceMessage: DiceMessage = {
          id,
          chatId,
          content: '', // 骰子消息内容为空
          type: MessageType.DICE,
          playerType,
          cardIndex,
          emoji,
          sequenceId,
          retries: 0,
          timestamp: Date.now(),
          isBlocking: true,
          priority: 1, // 骰子消息高优先级
          onDiceResult: async (value: number) => {
            this.logger.info('收到骰子结果', {
              operation: 'dice-result',
              messageId: id,
              playerType,
              cardIndex,
              diceValue: value
            });

            timer.end({
              success: true,
              diceValue: value,
              playerType,
              cardIndex
            });

            resolve(value);
          }
        };

        await this.addToQueue(diceMessage);

        // 设置骰子超时
        const timeoutId = setTimeout(() => {
          this.logger.error('骰子处理超时', {
            operation: 'dice-timeout',
            messageId: id,
            playerType,
            cardIndex,
            timeout: 20000
          });

          timer.end({ success: false, error: true, reason: 'timeout' });
          reject(new Error(`骰子超时：${playerType} 第${cardIndex}张牌`));
        }, 20000);

        // 记录超时ID以便清理
        if (this.waitingPromises.has(id)) {
          this.waitingPromises.get(id)!.timeout = timeoutId;
        }

      } catch (error) {
        this.logger.error('添加骰子消息失败', {
          operation: 'enqueue-dice-error',
          chatId,
          playerType,
          cardIndex
        }, error);

        timer.end({ success: false, error: true });
        reject(error);
      }
    });
  }

  /**
   * 将消息添加到队列并排序
   */
  private async addToQueue(message: QueuedMessage): Promise<void> {
    // 应用消息过滤器
    const filterResult = this.applyFilters(message);
    if (filterResult.action === 'block') {
      this.logger.warn('消息被过滤器阻止', {
        operation: 'message-filtered',
        messageId: message.id,
        filterName: filterResult.filterName
      });
      return;
    }

    // 应用优先级调整
    if (filterResult.action === 'priority' && filterResult.priorityAdjustment) {
      message.priority = (message.priority || 5) + filterResult.priorityAdjustment;
    }

    // 应用预处理中间件
    let processedMessage = message;
    for (const middleware of this.middlewares) {
      if (middleware.preProcess) {
        try {
          processedMessage = await middleware.preProcess(processedMessage);
        } catch (error) {
          this.logger.error('中间件预处理失败', {
            operation: 'middleware-preprocess-error',
            middlewareName: middleware.name,
            messageId: message.id
          }, error);
        }
      }
    }

    this.queue.push(processedMessage);

    // 排序队列：优先级 > 序列号
    if (this.queueConfig.enablePriority) {
      this.queue.sort((a, b) => {
        const priorityA = a.priority || 5;
        const priorityB = b.priority || 5;

        if (priorityA !== priorityB) {
          return priorityA - priorityB; // 数字越小优先级越高
        }

        return a.sequenceId - b.sequenceId; // 相同优先级按序列号排序
      });
    } else {
      // 只按序列号排序
      this.queue.sort((a, b) => a.sequenceId - b.sequenceId);
    }

    // 更新最大队列长度统计
    if (this.queue.length > this.stats.maxQueueLength) {
      this.stats.maxQueueLength = this.queue.length;
    }

    this.logger.debug('消息已添加到队列', {
      operation: 'add-to-queue',
      messageId: processedMessage.id,
      sequenceId: processedMessage.sequenceId,
      type: processedMessage.type,
      priority: processedMessage.priority,
      queueLength: this.queue.length,
      isBlocking: processedMessage.isBlocking
    });

    // 立即开始处理队列
    this.processQueue();
  }

  /**
   * 处理队列 - 严格按序列号顺序处理
   */
  private async processQueue(): Promise<void> {
    if (this.processing) {
      this.logger.debug('队列处理已在进行，跳过', {
        operation: 'process-queue-skip',
        queueLength: this.queue.length
      });
      return;
    }

    this.processing = true;
    const timer = this.createTimer('process-queue');

    this.logger.info('开始顺序处理队列', {
      operation: 'process-queue-start',
      queueLength: this.queue.length,
      currentSequence: this.sequenceCounter
    });

    let processedCount = 0;
    let errorCount = 0;

    while (this.queue.length > 0) {
      const message = this.queue.shift()!;

      try {
        this.logger.debug('处理消息', {
          operation: 'process-message',
          messageId: message.id,
          sequenceId: message.sequenceId,
          type: message.type,
          priority: message.priority,
          remainingInQueue: this.queue.length
        });

        const result = await this.processMessage(message);

        if (result.success) {
          processedCount++;
          this.updateStats('success', message.type, result.duration);
        } else {
          errorCount++;
          this.updateStats('failure', message.type, result.duration);
        }

        // 应用后处理中间件
        await this.applyPostProcessMiddlewares(message, result);

        // 通知等待的Promise
        this.resolveWaitingPromise(message.id);

        // 消息间隔控制
        await sleep(this.queueConfig.messageInterval);

      } catch (error) {
        errorCount++;
        this.logger.error('消息处理失败', {
          operation: 'process-message-error',
          messageId: message.id,
          sequenceId: message.sequenceId,
          type: message.type
        }, error);

        // 应用错误处理中间件
        await this.applyErrorMiddlewares(message, error);

        // 处理重试逻辑
        await this.handleMessageError(message, error);
      }
    }

    this.processing = false;

    timer.end({
      processedCount,
      errorCount,
      finalQueueLength: this.queue.length
    });

    this.logger.info('队列顺序处理完成', {
      operation: 'process-queue-complete',
      processedCount,
      errorCount,
      finalQueueLength: this.queue.length
    });
  }

  /**
   * 处理单个消息
   */
  private async processMessage(message: QueuedMessage): Promise<MessageProcessResult> {
    const timer = this.createTimer(`process-${message.type}`, {
      messageId: message.id,
      type: message.type
    });

    try {
      let result: MessageProcessResult;

      if (message.type === MessageType.TEXT) {
        result = await this.processTextMessage(message as TextMessage);
      } else if (message.type === MessageType.DICE) {
        result = await this.processDiceMessage(message as DiceMessage);
      } else {
        throw new Error(`Unsupported message type: ${message.type}`);
      }

      result.duration = timer.end({ success: result.success }).valueOf();
      return result;
    } catch (error) {
      const duration = timer.end({ success: false, error: true }).valueOf();
      return {
        success: false,
        messageId: message.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryable: this.isRetryableError(error),
        duration
      };
    }
  }

  /**
   * 处理文本消息
   */
  private async processTextMessage(message: TextMessage): Promise<MessageProcessResult> {
    const botService = this.getService(BotService);

    const result = await botService.sendMessage(message.chatId, message.content, {
      parseMode: message.parseMode,
      disableWebPagePreview: message.disableWebPagePreview,
      disableNotification: message.disableNotification,
      replyToMessageId: message.replyToMessageId
    });

    this.logger.info('文本消息处理完成', {
      operation: 'process-text-message',
      messageId: message.id,
      chatId: message.chatId,
      success: result.success,
      telegramMessageId: result.data?.message_id
    });

    return {
      success: result.success,
      messageId: message.id,
      telegramMessageId: result.data?.message_id,
      error: result.error,
      retryable: result.retryable || false
    };
  }

  /**
   * 处理骰子消息
   */
  private async processDiceMessage(diceMessage: DiceMessage): Promise<MessageProcessResult> {
    const botService = this.getService(BotService);

    try {
      this.logger.info('开始处理骰子投掷', {
        operation: 'dice-roll-start',
        messageId: diceMessage.id,
        playerType: diceMessage.playerType,
        cardIndex: diceMessage.cardIndex,
        chatId: diceMessage.chatId
      });

      // 第一步：发送骰子
      const diceResult = await botService.sendDice(diceMessage.chatId, diceMessage.emoji);

      if (!diceResult.success) {
        throw new Error(`Failed to send dice: ${diceResult.error}`);
      }

      const diceValue = diceResult.data?.dice?.value;
      if (!diceValue || diceValue < 1 || diceValue > 6) {
        throw new Error(`Invalid dice value: ${diceValue}`);
      }

      this.logger.info('骰子动画已开始', {
        operation: 'dice-animation-start',
        messageId: diceMessage.id,
        playerType: diceMessage.playerType,
        cardIndex: diceMessage.cardIndex,
        diceValue,
        telegramMessageId: diceResult.data?.message_id
      });

      // 第二步：等待骰子动画完成
      await sleep(this.queueConfig.diceAnimationWait);

      // 第三步：发送结果消息
      const playerText = diceMessage.playerType === 'banker' ? '🏦 庄家' : '👤 闲家';
      const resultMessage = `🎯 **${playerText}第${diceMessage.cardIndex}张牌开出：${diceValue} 点**`;

      const resultSendResult = await botService.sendMessage(diceMessage.chatId, resultMessage, {
        parseMode: 'Markdown'
      });

      this.logger.info('骰子处理完成', {
        operation: 'dice-process-complete',
        messageId: diceMessage.id,
        playerType: diceMessage.playerType,
        cardIndex: diceMessage.cardIndex,
        diceValue,
        resultMessageSent: resultSendResult.success
      });

      // 第四步：调用回调
      if (diceMessage.onDiceResult) {
        await diceMessage.onDiceResult(diceValue);
      }

      return {
        success: true,
        messageId: diceMessage.id,
        telegramMessageId: diceResult.data?.message_id
      };

    } catch (error) {
      this.logger.error('骰子消息处理失败', {
        operation: 'dice-process-error',
        messageId: diceMessage.id,
        playerType: diceMessage.playerType,
        cardIndex: diceMessage.cardIndex
      }, error);

      // 骰子失败时使用随机值作为备用方案
      const fallbackValue = Math.floor(Math.random() * 6) + 1;

      this.logger.warn('使用备用骰子值', {
        operation: 'dice-fallback',
        messageId: diceMessage.id,
        playerType: diceMessage.playerType,
        cardIndex: diceMessage.cardIndex,
        fallbackValue
      });

      try {
        const playerText = diceMessage.playerType === 'banker' ? '🏦 庄家' : '👤 闲家';
        const fallbackMessage =
          `⚠️ **${playerText}第${diceMessage.cardIndex}张牌**\n` +
          `🎲 骰子发送失败，系统随机开出：**${fallbackValue} 点**\n` +
          `💡 游戏继续进行...`;

        const botService = this.getService(BotService);
        await botService.sendMessage(diceMessage.chatId, fallbackMessage, {
          parseMode: 'Markdown'
        });

        if (diceMessage.onDiceResult) {
          await diceMessage.onDiceResult(fallbackValue);
        }

        this.logger.info('备用消息发送成功', {
          operation: 'dice-fallback-success',
          messageId: diceMessage.id,
          fallbackValue
        });

        return {
          success: true,
          messageId: diceMessage.id,
          error: 'Used fallback value due to dice failure'
        };

      } catch (fallbackError) {
        this.logger.error('备用消息发送失败', {
          operation: 'dice-fallback-error',
          messageId: diceMessage.id,
          fallbackValue
        }, fallbackError);

        // 最终兜底：直接调用回调
        if (diceMessage.onDiceResult) {
          await diceMessage.onDiceResult(fallbackValue);
        }

        return {
          success: false,
          messageId: diceMessage.id,
          error: error instanceof Error ? error.message : 'Unknown error',
          retryable: false
        };
      }
    }
  }

  /**
   * 等待特定消息处理完成
   */
  private async waitForMessage(messageId: string, options: WaitForMessageOptions = {}): Promise<void> {
    const {
      timeout = 10000,
      checkInterval = 100,
      throwOnTimeout = true
    } = options;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      this.logger.debug('开始等待消息处理', {
        operation: 'wait-message-start',
        messageId,
        timeout,
        queueLength: this.queue.length
      });

      // 存储Promise解析器
      this.waitingPromises.set(messageId, { resolve, reject });

      // 设置超时
      const timeoutId = setTimeout(() => {
        this.waitingPromises.delete(messageId);
        const waitTime = Date.now() - startTime;

        this.logger.warn('消息等待超时', {
          operation: 'wait-message-timeout',
          messageId,
          waitTime,
          timeout
        });

        if (throwOnTimeout) {
          reject(new Error(`Message wait timeout: ${messageId}`));
        } else {
          resolve();
        }
      }, timeout);

      // 更新超时ID
      const waiting = this.waitingPromises.get(messageId);
      if (waiting) {
        waiting.timeout = timeoutId;
      }
    });
  }

  /**
   * 解析等待的Promise
   */
  private resolveWaitingPromise(messageId: string): void {
    const waiting = this.waitingPromises.get(messageId);
    if (waiting) {
      if (waiting.timeout) {
        clearTimeout(waiting.timeout);
      }
      waiting.resolve();
      this.waitingPromises.delete(messageId);

      this.logger.debug('消息等待完成', {
        operation: 'wait-message-complete',
        messageId
      });
    }
  }

  /**
   * 清理等待的Promise
   */
  private cleanupWaitingPromises(reason: string): void {
    const count = this.waitingPromises.size;

    this.waitingPromises.forEach((waiting, messageId) => {
      if (waiting.timeout) {
        clearTimeout(waiting.timeout);
      }
      waiting.reject(new Error(`Promise cleanup: ${reason}`));
    });

    this.waitingPromises.clear();

    if (count > 0) {
      this.logger.warn('清理等待中的Promise', {
        operation: 'cleanup-waiting-promises',
        count,
        reason
      });
    }
  }

  /**
   * 应用消息过滤器
   */
  private applyFilters(message: QueuedMessage): {
    action: 'allow' | 'block' | 'priority';
    filterName?: string;
    priorityAdjustment?: number;
  } {
    for (const filter of this.filters) {
      try {
        if (filter.predicate(message)) {
          this.logger.debug('消息匹配过滤器', {
            operation: 'apply-filter',
            messageId: message.id,
            filterName: filter.name,
            action: filter.action
          });

          return {
            action: filter.action,
            filterName: filter.name,
            priorityAdjustment: filter.priorityAdjustment
          };
        }
      } catch (error) {
        this.logger.error('过滤器执行失败', {
          operation: 'filter-error',
          filterName: filter.name,
          messageId: message.id
        }, error);
      }
    }

    return { action: 'allow' };
  }

  /**
   * 应用后处理中间件
   */
  private async applyPostProcessMiddlewares(
    message: QueuedMessage,
    result: MessageProcessResult
  ): Promise<void> {
    for (const middleware of this.middlewares) {
      if (middleware.postProcess) {
        try {
          await middleware.postProcess(message, result);
        } catch (error) {
          this.logger.error('中间件后处理失败', {
            operation: 'middleware-postprocess-error',
            middlewareName: middleware.name,
            messageId: message.id
          }, error);
        }
      }
    }
  }

  /**
   * 应用错误处理中间件
   */
  private async applyErrorMiddlewares(message: QueuedMessage, error: any): Promise<void> {
    for (const middleware of this.middlewares) {
      if (middleware.onError) {
        try {
          await middleware.onError(message, error);
        } catch (middlewareError) {
          this.logger.error('中间件错误处理失败', {
            operation: 'middleware-error-handler-error',
            middlewareName: middleware.name,
            messageId: message.id
          }, middlewareError);
        }
      }
    }
  }

  /**
   * 处理消息错误
   */
  private async handleMessageError(message: QueuedMessage, error: any): Promise<void> {
    message.retries = (message.retries || 0) + 1;

    this.logger.warn('消息处理失败，正在处理错误', {
      operation: 'handle-message-error',
      messageId: message.id,
      type: message.type,
      retries: message.retries,
      maxRetries: this.queueConfig.maxRetries
    }, error);

    if (message.retries < this.queueConfig.maxRetries && this.isRetryableError(error)) {
      this.logger.info('重试消息', {
        operation: 'retry-message',
        messageId: message.id,
        attempt: message.retries + 1,
        maxRetries: this.queueConfig.maxRetries
      });

      // 重新加入队列，保持原序列号
      this.queue.push(message);

      // 重新排序
      if (this.queueConfig.enablePriority) {
        this.queue.sort((a, b) => {
          const priorityA = a.priority || 5;
          const priorityB = b.priority || 5;
          if (priorityA !== priorityB) return priorityA - priorityB;
          return a.sequenceId - b.sequenceId;
        });
      } else {
        this.queue.sort((a, b) => a.sequenceId - b.sequenceId);
      }

      this.stats.retriedMessages++;

      // 指数退避延迟
      const delay = this.queueConfig.retryBaseDelay * Math.pow(2, message.retries - 1);
      await sleep(delay);

    } else {
      this.logger.error('消息在所有重试后失败', {
        operation: 'message-failed-final',
        messageId: message.id,
        type: message.type,
        totalRetries: this.queueConfig.maxRetries
      }, error);

      // 如果是骰子消息，必须调用回调防止卡住
      if (message.type === MessageType.DICE) {
        const diceMessage = message as DiceMessage;
        if (diceMessage.onDiceResult) {
          const fallbackValue = Math.floor(Math.random() * 6) + 1;

          this.logger.warn('为失败的骰子消息使用最终备用值', {
            operation: 'dice-final-fallback',
            messageId: diceMessage.id,
            playerType: diceMessage.playerType,
            cardIndex: diceMessage.cardIndex,
            fallbackValue
          });

          await diceMessage.onDiceResult(fallbackValue);
        }
      }

      // 解析等待Promise（如果有）
      this.resolveWaitingPromise(message.id);
    }
  }

  /**
   * 判断错误是否可重试
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

    // 超时错误
    if (error?.message && error.message.includes('timeout')) {
      return true;
    }

    return false;
  }

  /**
   * 更新统计信息
   */
  private updateStats(
    result: 'success' | 'failure',
    messageType: MessageType,
    duration?: number
  ): void {
    this.stats.totalProcessed++;
    this.stats.lastProcessedTime = Date.now();

    if (result === 'success') {
      this.stats.successfulMessages++;
    } else {
      this.stats.failedMessages++;
    }

    // 按类型统计
    if (messageType === MessageType.TEXT) {
      this.stats.textMessages++;
    } else if (messageType === MessageType.DICE) {
      this.stats.diceMessages++;
    }

    // 更新平均处理时间
    if (duration && duration > 0) {
      const totalTime = this.stats.averageProcessingTime * (this.stats.totalProcessed - 1) + duration;
      this.stats.averageProcessingTime = totalTime / this.stats.totalProcessed;
    }

    // 计算错误率
    this.stats.errorRate = this.stats.totalProcessed > 0
      ? this.stats.failedMessages / this.stats.totalProcessed
      : 0;
  }

  /**
   * 清空队列并重置状态
   */
  clearQueue(): void {
    const queueLength = this.queue.length;
    const waitingCount = this.waitingPromises.size;

    this.logger.warn('正在清空消息队列', {
      operation: 'clear-queue',
      queueLength,
      waitingCount,
      processing: this.processing,
      currentSequence: this.sequenceCounter
    });

    // 清理等待的Promise
    this.cleanupWaitingPromises('队列清空');

    // 清空队列
    this.queue = [];
    this.processing = false;
    this.sequenceCounter = 0;

    this.logger.info('消息队列已清空', {
      operation: 'queue-cleared',
      previousLength: queueLength,
      previousWaitingCount: waitingCount
    });
  }

  /**
   * 添加消息过滤器
   */
  addFilter(filter: MessageFilter): void {
    this.filters.push(filter);

    this.logger.info('消息过滤器已添加', {
      operation: 'add-filter',
      filterName: filter.name,
      action: filter.action,
      totalFilters: this.filters.length
    });
  }

  /**
   * 移除消息过滤器
   */
  removeFilter(filterName: string): boolean {
    const index = this.filters.findIndex(f => f.name === filterName);
    if (index >= 0) {
      this.filters.splice(index, 1);

      this.logger.info('消息过滤器已移除', {
        operation: 'remove-filter',
        filterName,
        remainingFilters: this.filters.length
      });

      return true;
    }
    return false;
  }

  /**
   * 添加中间件
   */
  addMiddleware(middleware: MessageMiddleware): void {
    this.middlewares.push(middleware);

    this.logger.info('消息中间件已添加', {
      operation: 'add-middleware',
      middlewareName: middleware.name,
      totalMiddlewares: this.middlewares.length
    });
  }

  /**
   * 移除中间件
   */
  removeMiddleware(middlewareName: string): boolean {
    const index = this.middlewares.findIndex(m => m.name === middlewareName);
    if (index >= 0) {
      this.middlewares.splice(index, 1);

      this.logger.info('消息中间件已移除', {
        operation: 'remove-middleware',
        middlewareName,
        remainingMiddlewares: this.middlewares.length
      });

      return true;
    }
    return false;
  }

  /**
   * 获取队列状态
   */
  getQueueStatus(): QueueStatus {
    const blockingCount = this.queue.filter(msg => msg.isBlocking).length;

    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentSequence: this.sequenceCounter,
      currentGame: this.currentGameId,
      processingCount: this.processing ? 1 : 0,
      blockingCount
    };
  }

  /**
   * 获取统计信息
   */
  getStats(): MessageQueueStats {
    return { ...this.stats };
  }

  /**
   * 获取配置
   */
  getQueueConfig(): MessageQueueConfig {
    return { ...this.queueConfig };
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<MessageQueueConfig>): void {
    const oldConfig = { ...this.queueConfig };
    this.queueConfig = { ...this.queueConfig, ...newConfig };

    this.logger.info('队列配置已更新', {
      operation: 'update-config',
      oldConfig,
      newConfig: this.queueConfig
    });
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      totalProcessed: 0,
      successfulMessages: 0,
      failedMessages: 0,
      textMessages: 0,
      diceMessages: 0,
      retriedMessages: 0,
      averageProcessingTime: 0,
      maxQueueLength: 0,
      lastProcessedTime: Date.now(),
      errorRate: 0
    };

    this.logger.info('队列统计信息已重置', {
      operation: 'reset-stats'
    });
  }

  /**
   * 获取队列详细信息（调试用）
   */
  getQueueDetails(): {
    messages: Array<{
      id: string;
      type: MessageType;
      sequenceId: number;
      priority?: number;
      retries?: number;
      isBlocking?: boolean;
      age: number;
    }>;
    waitingPromises: string[];
    filters: string[];
    middlewares: string[];
  } {
    const now = Date.now();

    return {
      messages: this.queue.map(msg => ({
        id: msg.id,
        type: msg.type,
        sequenceId: msg.sequenceId,
        priority: msg.priority,
        retries: msg.retries,
        isBlocking: msg.isBlocking,
        age: now - msg.timestamp
      })),
      waitingPromises: Array.from(this.waitingPromises.keys()),
      filters: this.filters.map(f => f.name),
      middlewares: this.middlewares.map(m => m.name)
    };
  }

  /**
   * 自定义健康检查
   */
  protected override getCustomHealth(): Partial<ServiceHealthStatus> {
    const stats = this.getStats();
    const status = this.getQueueStatus();

    // 检查错误率和队列积压
    const highErrorRate = stats.errorRate > 0.1; // 10%错误率
    const queueBacklog = status.queueLength > 20; // 队列积压超过20条
    const stuckProcessing = this.processing && (Date.now() - stats.lastProcessedTime) > 30000; // 处理卡住超过30秒

    const isHealthy = !highErrorRate && !queueBacklog && !stuckProcessing;

    const issues: string[] = [];
    if (highErrorRate) issues.push(`高错误率: ${(stats.errorRate * 100).toFixed(1)}%`);
    if (queueBacklog) issues.push(`队列积压: ${status.queueLength}条消息`);
    if (stuckProcessing) issues.push('处理进程疑似卡住');

    return {
      healthy: isHealthy,
      message: isHealthy
        ? 'Message queue is operating normally'
        : `Issues detected: ${issues.join(', ')}`,
      details: {
        stats,
        status,
        queueDetails: this.getQueueDetails(),
        issues,
        config: this.queueConfig
      }
    };
  }

  /**
   * 服务上下文更新处理
   */
  protected override onContextUpdate(newContext: ServiceContainer['context']): void {
    // 当游戏上下文更新时，更新当前游戏ID
    if (newContext.gameId !== this.currentGameId) {
      this.logger.debug('检测到游戏上下文变更', {
        operation: 'context-game-change',
        oldGameId: this.currentGameId,
        newGameId: newContext.gameId
      });

      this.currentGameId = newContext.gameId || null;
    }
  }

  /**
   * 清理资源
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();

    // 清理队列和等待Promise
    this.cleanupWaitingPromises('服务清理');
    this.clearQueue();

    // 清理中间件和过滤器
    this.filters = [];
    this.middlewares = [];

    // 记录最终状态
    const finalStats = this.getStats();

    this.logger.info('消息队列服务已清理', {
      operation: 'message-queue-cleanup',
      finalStats,
      clearedQueue: true,
      clearedWaitingPromises: true
    });
  }
}
