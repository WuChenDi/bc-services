import { Bot } from 'grammy';
import type { Env } from '@/types';
import { MessageQueueService, logger } from '@/services';
import { getConstants, type Constants } from '@/config/constants';

export class DiceService {
  private queue: MessageQueueService;
  private constants: Constants;

  constructor(bot: Bot, env: Env) {
    this.queue = new MessageQueueService(bot, env);
    this.constants = getConstants(env);
    logger.setGlobalContext({ component: 'DiceService' });
    logger.dice.info('骰子服务已初始化');
  }

  /**
   * 设置当前游戏ID，用于消息序列控制
   */
  setCurrentGame(gameId: string): void {
    logger.dice.info('设置当前游戏ID', {
      operation: 'set-current-game',
      gameId
    });
    this.queue.setCurrentGame(gameId);
  }

  /**
   * 发送非阻塞消息
   */
  async sendMessage(
    chatId: string,
    content: string,
    parseMode: 'Markdown' | 'HTML' = 'Markdown'
  ): Promise<string> {
    logger.dice.debug('添加非阻塞消息到队列', {
      operation: 'send-message',
      chatId,
      contentLength: content.length,
      parseMode
    });
    return this.queue.enqueueMessage(chatId, content, false, parseMode);
  }

  /**
   * 发送阻塞消息
   */
  async sendBlockingMessage(
    chatId: string,
    content: string,
    parseMode: 'Markdown' | 'HTML' = 'Markdown'
  ): Promise<string> {
    logger.dice.debug('添加阻塞消息到队列', {
      operation: 'send-blocking-message',
      chatId,
      contentLength: content.length,
      parseMode
    });
    return this.queue.enqueueMessage(chatId, content, true, parseMode);
  }

  /**
   * 投掷骰子，总是阻塞的
   */
  async rollDice(chatId: string, playerType: string, cardIndex: number): Promise<number> {
    const timer = logger.performance.start('rollDice', {
      chatId,
      playerType,
      cardIndex
    });

    try {
      logger.dice.info('开始投掷骰子', {
        operation: 'roll-dice',
        chatId,
        playerType,
        cardIndex
      });

      const diceValue = await this.queue.enqueueDice(chatId, playerType, cardIndex);

      logger.dice.info('骰子投掷完成', {
        operation: 'roll-dice-complete',
        chatId,
        playerType,
        cardIndex,
        diceValue
      });

      timer.end({ success: true, diceValue });
      return diceValue;
    } catch (error) {
      logger.dice.error('骰子投掷失败', {
        operation: 'roll-dice-error',
        chatId,
        playerType,
        cardIndex
      }, error);
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 清空消息队列
   */
  clearMessageQueue(): void {
    logger.dice.info('清空消息队列', {
      operation: 'clear-message-queue'
    });
    this.queue.clearQueue();
  }

  /**
   * 获取消息队列状态
   */
  getQueueStatus() {
    logger.dice.debug('获取消息队列状态', {
      operation: 'get-queue-status'
    });
    return this.queue.getQueueStatus();
  }
}
