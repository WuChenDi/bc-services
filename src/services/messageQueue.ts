import { Bot } from 'grammy';
import type { Env } from '@/types';
import { sleep } from '@/utils';
import { logger } from '@/services/loggerService';
import { getConstants, type Constants } from '@/config/constants';

export interface QueuedMessage {
  id: string;
  chatId: string;
  content: string;
  parseMode?: 'Markdown' | 'HTML';
  type: 'text' | 'dice';
  sequenceId: number; // 严格的序列号控制
  retries?: number;
  timestamp: number;
  isBlocking?: boolean; // 是否阻塞后续消息
}

export interface DiceMessage extends QueuedMessage {
  type: 'dice';
  playerType: string;
  cardIndex: number;
  onDiceResult?: (value: number) => Promise<void> | void;
}

export class MessageQueueService {
  private constants: Constants;
  private queue: QueuedMessage[] = [];
  private processing: boolean = false;
  private readonly maxRetries = 3;
  private messageCounter = 0;
  private sequenceCounter = 0;
  private currentGameId: string | null = null;

  constructor(private bot: Bot, env: Env) {
    this.constants = getConstants(env);
    // 设置组件级别的上下文
    logger.setGlobalContext({ component: 'MessageQueue' });
    logger.queue.info('消息队列服务已初始化');
  }

  /**
   * 设置当前游戏ID，用于消息序列控制
   */
  setCurrentGame(gameId: string): void {
    const previousGameId = this.currentGameId;
    this.currentGameId = gameId;
    this.sequenceCounter = 0; // 重置序列计数器

    // 同步更新日志服务的游戏ID
    logger.setCurrentGame(gameId);

    logger.queue.info('新游戏已设置，序列已重置', {
      operation: 'set-current-game',
      gameId,
      previousGameId,
      resetSequence: this.sequenceCounter
    });
  }

  /**
   * 添加文本消息到队列
   */
  async enqueueMessage(
    chatId: string,
    content: string,
    isBlocking: boolean = false,
    parseMode: 'Markdown' | 'HTML' = 'Markdown'
  ): Promise<string> {
    const id = `msg_${++this.messageCounter}_${Date.now()}`;
    const sequenceId = ++this.sequenceCounter;

    const message: QueuedMessage = {
      id,
      chatId,
      content,
      parseMode,
      type: 'text',
      sequenceId,
      retries: 0,
      timestamp: Date.now(),
      isBlocking
    };

    logger.queue.debug('添加文本消息到队列', {
      operation: 'enqueue-message',
      messageId: id,
      sequenceId,
      isBlocking,
      contentLength: content.length,
      chatId,
      queueLength: this.queue.length
    });

    this.addToQueue(message);

    // 如果是阻塞消息，等待处理完成
    if (isBlocking) {
      logger.queue.debug('等待阻塞消息完成', {
        operation: 'wait-blocking',
        messageId: id
      });
      await this.waitForMessage(id);
      logger.queue.debug('阻塞消息已完成', {
        operation: 'blocking-completed',
        messageId: id
      });
    }

    return id;
  }

  /**
   * 添加骰子消息到队列（总是阻塞的）
   */
  async enqueueDice(
    chatId: string,
    playerType: string,
    cardIndex: number
  ): Promise<number> {
    return new Promise(async (resolve, reject) => {
      const id = `dice_${++this.messageCounter}_${Date.now()}`;
      const sequenceId = ++this.sequenceCounter;

      logger.dice.info('添加骰子消息到队列', {
        operation: 'enqueue-dice',
        messageId: id,
        sequenceId,
        playerType,
        cardIndex,
        chatId,
        queueLength: this.queue.length
      });

      const diceMessage: DiceMessage = {
        id,
        chatId,
        content: '',
        type: 'dice',
        playerType,
        cardIndex,
        sequenceId,
        retries: 0,
        timestamp: Date.now(),
        isBlocking: true,
        onDiceResult: async (value: number) => {
          logger.dice.info('收到骰子结果', {
            operation: 'dice-result',
            messageId: id,
            playerType,
            cardIndex,
            diceValue: value
          });
          resolve(value);
        }
      };

      this.addToQueue(diceMessage);

      // 等待骰子处理完成
      await this.waitForMessage(id);

      // 超时处理
      const timeoutId = setTimeout(() => {
        logger.dice.error('骰子处理超时', {
          operation: 'dice-timeout',
          messageId: id,
          playerType,
          cardIndex,
          timeout: 20000
        });
        reject(new Error(`骰子超时：${playerType} 第${cardIndex}张牌`));
      }, 20000);

      // 监听 queue 变化，确保超时被取消
      const checkCompletion = () => {
        if (!this.queue.some(msg => msg.id === id) && !this.processing) {
          clearTimeout(timeoutId);
        }
      };
      this.queue.push = new Proxy(this.queue.push, {
        apply: (target, thisArg, argumentsList) => {
          const result = target.apply(thisArg, argumentsList);
          checkCompletion();
          return result;
        }
      });
    });
  }

  /**
   * 清空队列并重置状态
   */
  clearQueue(): void {
    const queueLength = this.queue.length;
    const queueItems = this.queue.map(msg => ({
      id: msg.id,
      type: msg.type,
      sequenceId: msg.sequenceId
    }));

    logger.queue.warn('正在清空消息队列', {
      operation: 'clear-queue',
      queueLength,
      processing: this.processing,
      currentSequence: this.sequenceCounter,
      clearedItems: queueItems
    });

    this.queue = [];
    this.processing = false;
    this.sequenceCounter = 0;

    logger.queue.info('消息队列已清空', {
      operation: 'queue-cleared',
      previousLength: queueLength
    });
  }

  /**
   * 获取队列状态
   */
  getQueueStatus(): {
    queueLength: number;
    processing: boolean;
    currentSequence: number;
    currentGame: string | null;
  } {
    const status = {
      queueLength: this.queue.length,
      processing: this.processing,
      currentSequence: this.sequenceCounter,
      currentGame: this.currentGameId
    };

    logger.queue.debug('请求队列状态', {
      operation: 'get-status',
      ...status
    });

    return status;
  }

  /**
   * 等待特定消息处理完成
   */
  private async waitForMessage(messageId: string): Promise<void> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      logger.queue.debug('开始等待消息处理', {
        operation: 'wait-message-start',
        messageId,
        queueLength: this.queue.length
      });

      const checkInterval = setInterval(() => {
        const messageExists = this.queue.some(msg => msg.id === messageId);
        const waitTime = Date.now() - startTime;

        if (!messageExists && !this.processing) {
          clearInterval(checkInterval);
          clearTimeout(timeoutId); // 清除超时定时器
          logger.queue.debug('消息等待完成', {
            operation: 'wait-message-complete',
            messageId,
            waitTime
          });
          resolve();
        }
      }, 100);

      // 10秒超时
      const timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        const waitTime = Date.now() - startTime;
        logger.queue.warn('消息等待超时', {
          operation: 'wait-message-timeout',
          messageId,
          waitTime,
          timeout: 10000
        });
        resolve();
      }, 10000);
    });
  }

  /**
   * 将消息添加到队列并严格按序列号排序
   */
  private addToQueue(message: QueuedMessage): void {
    this.queue.push(message);

    // 严格按序列号排序，确保顺序
    this.queue.sort((a, b) => a.sequenceId - b.sequenceId);

    logger.queue.debug('消息已添加到队列', {
      operation: 'add-to-queue',
      messageId: message.id,
      sequenceId: message.sequenceId,
      type: message.type,
      queueLength: this.queue.length,
      isBlocking: message.isBlocking
    });

    // 立即开始处理队列
    this.processQueue();
  }

  /**
   * 处理队列 - 严格按序列号顺序处理
   */
  private async processQueue(): Promise<void> {
    if (this.processing) {
      logger.queue.debug('队列处理已在进行，跳过', {
        operation: 'process-queue-skip',
        queueLength: this.queue.length
      });
      return;
    }

    this.processing = true;
    const timer = logger.performance.start('processQueue');

    logger.queue.info('开始顺序处理队列', {
      operation: 'process-queue-start',
      queueLength: this.queue.length,
      currentSequence: this.sequenceCounter
    });

    let processedCount = 0;
    let errorCount = 0;

    while (this.queue.length > 0) {
      // 取出序列号最小的消息
      const message = this.queue.shift()!;

      try {
        logger.queue.debug('处理消息', {
          operation: 'process-message',
          messageId: message.id,
          sequenceId: message.sequenceId,
          type: message.type,
          remainingInQueue: this.queue.length
        });

        await this.processMessage(message);
        processedCount++;

        // 固定延迟，确保消息不会太快
        await sleep(this.constants.MESSAGE_DELAY_MS);

      } catch (error) {
        errorCount++;
        logger.queue.error('消息处理失败', {
          operation: 'process-message-error',
          messageId: message.id,
          sequenceId: message.sequenceId,
          type: message.type
        }, error);

        await this.handleMessageError(message, error);
      }
    }

    this.processing = false;

    timer.end({
      processedCount,
      errorCount,
      finalQueueLength: this.queue.length
    });

    logger.queue.info('队列顺序处理完成', {
      operation: 'process-queue-complete',
      processedCount,
      errorCount,
      finalQueueLength: this.queue.length
    });
  }

  /**
   * 处理单个消息
   */
  private async processMessage(message: QueuedMessage): Promise<void> {
    const timer = logger.performance.start(`processMessage_${message.type}`, {
      messageId: message.id,
      type: message.type
    });

    try {
      if (message.type === 'text') {
        await this.processTextMessage(message);
      } else if (message.type === 'dice') {
        await this.processDiceMessage(message as DiceMessage);
      }

      timer.end({ success: true });
    } catch (error) {
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 处理文本消息
   */
  private async processTextMessage(message: QueuedMessage): Promise<void> {
    const timer = logger.performance.start('sendTextMessage', {
      messageId: message.id,
      chatId: message.chatId
    });

    try {
      await this.bot.api.sendMessage(message.chatId, message.content, {
        parse_mode: message.parseMode
      });

      logger.queue.info('文本消息发送成功', {
        operation: 'send-text-message',
        messageId: message.id,
        chatId: message.chatId,
        contentLength: message.content.length,
        parseMode: message.parseMode
      });

      timer.end({
        success: true,
        contentLength: message.content.length
      });
    } catch (error) {
      logger.queue.error('文本消息发送失败', {
        operation: 'send-text-message-error',
        messageId: message.id,
        chatId: message.chatId,
        parseMode: message.parseMode
      }, error);

      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 处理骰子消息
   */
  private async processDiceMessage(diceMessage: DiceMessage): Promise<void> {
    const timer = logger.performance.start('processDiceMessage', {
      messageId: diceMessage.id,
      playerType: diceMessage.playerType,
      cardIndex: diceMessage.cardIndex
    });

    try {
      logger.dice.info('开始处理骰子投掷', {
        operation: 'dice-roll-start',
        messageId: diceMessage.id,
        playerType: diceMessage.playerType,
        cardIndex: diceMessage.cardIndex,
        chatId: diceMessage.chatId
      });

      // 第一步：发送骰子
      const diceResult = await this.bot.api.sendDice(diceMessage.chatId, '🎲');
      const diceValue = diceResult.dice?.value;

      if (!diceValue || diceValue < 1 || diceValue > 6) {
        throw new Error(`无效的骰子值：${diceValue}`);
      }

      logger.dice.info('骰子动画已开始', {
        operation: 'dice-animation-start',
        messageId: diceMessage.id,
        playerType: diceMessage.playerType,
        cardIndex: diceMessage.cardIndex,
        diceValue,
        telegramMessageId: diceResult.message_id
      });

      // 第二步：等待骰子动画完成
      await sleep(this.constants.DICE_ANIMATION_WAIT_MS);

      // 第三步：发送结果消息
      const playerText = diceMessage.playerType === 'banker' ? '🏦 庄家' : '👤 闲家';
      const resultMessage = `🎯 **${playerText}第${diceMessage.cardIndex}张牌开出：${diceValue} 点**`;

      await this.bot.api.sendMessage(diceMessage.chatId, resultMessage, {
        parse_mode: 'Markdown'
      });

      logger.dice.info('骰子处理完成', {
        operation: 'dice-process-complete',
        messageId: diceMessage.id,
        playerType: diceMessage.playerType,
        cardIndex: diceMessage.cardIndex,
        diceValue
      });

      // 第四步：调用回调
      if (diceMessage.onDiceResult) {
        await diceMessage.onDiceResult(diceValue);
      }

      timer.end({
        success: true,
        diceValue,
        playerType: diceMessage.playerType,
        cardIndex: diceMessage.cardIndex
      });

    } catch (error) {
      logger.dice.error('骰子消息处理失败', {
        operation: 'dice-process-error',
        messageId: diceMessage.id,
        playerType: diceMessage.playerType,
        cardIndex: diceMessage.cardIndex
      }, error);

      // 骰子失败时使用随机值
      const fallbackValue = Math.floor(Math.random() * 6) + 1;

      logger.dice.warn('使用备用骰子值', {
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

        await this.bot.api.sendMessage(diceMessage.chatId, fallbackMessage, {
          parse_mode: 'Markdown'
        });

        if (diceMessage.onDiceResult) {
          await diceMessage.onDiceResult(fallbackValue);
        }

        logger.dice.info('备用消息发送成功', {
          operation: 'dice-fallback-success',
          messageId: diceMessage.id,
          fallbackValue
        });

        timer.end({
          success: true,
          usedFallback: true,
          fallbackValue
        });

      } catch (fallbackError) {
        logger.dice.error('备用消息发送失败', {
          operation: 'dice-fallback-error',
          messageId: diceMessage.id,
          fallbackValue
        }, fallbackError);

        // 最终兜底：直接调用回调
        if (diceMessage.onDiceResult) {
          await diceMessage.onDiceResult(fallbackValue);
        }

        timer.end({
          success: false,
          usedFallback: true,
          fallbackValue,
          error: true
        });
      }
    }
  }

  /**
   * 处理消息错误
   */
  private async handleMessageError(message: QueuedMessage, error: any): Promise<void> {
    message.retries = (message.retries || 0) + 1;

    logger.queue.warn('消息处理失败，正在处理错误', {
      operation: 'handle-message-error',
      messageId: message.id,
      type: message.type,
      retries: message.retries,
      maxRetries: this.maxRetries
    }, error);

    if (message.retries < this.maxRetries) {
      logger.queue.info('重试消息', {
        operation: 'retry-message',
        messageId: message.id,
        attempt: message.retries + 1,
        maxRetries: this.maxRetries
      });

      // 重新加入队列，保持原序列号
      this.queue.push(message);
      this.queue.sort((a, b) => a.sequenceId - b.sequenceId);

      // 延迟后重试
      await sleep(1000 * message.retries);

    } else {
      logger.queue.error('消息在所有重试后失败', {
        operation: 'message-failed-final',
        messageId: message.id,
        type: message.type,
        totalRetries: this.maxRetries
      }, error);

      // 如果是骰子消息，必须调用回调防止卡住
      if (message.type === 'dice') {
        const diceMessage = message as DiceMessage;
        if (diceMessage.onDiceResult) {
          const fallbackValue = Math.floor(Math.random() * 6) + 1;

          logger.dice.warn('为失败的骰子消息使用最终备用值', {
            operation: 'dice-final-fallback',
            messageId: diceMessage.id,
            playerType: diceMessage.playerType,
            cardIndex: diceMessage.cardIndex,
            fallbackValue
          });

          await diceMessage.onDiceResult(fallbackValue);
        }
      }
    }
  }
}
