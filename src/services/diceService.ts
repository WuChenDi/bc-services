import { Bot } from 'grammy';
import type { Env } from '@/types';
import { getConstants, type Constants } from '@/config/constants';
import { MessageQueueService } from './messageQueue';

export class DiceService {
  private constants: Constants;
  private messageQueue: MessageQueueService;

  constructor(private bot: Bot, env: Env) {
    this.constants = getConstants(env);
    this.messageQueue = new MessageQueueService(bot, env);
  }

  /**
   * 设置当前游戏ID，重置消息序列
   */
  setCurrentGame(gameId: string): void {
    this.messageQueue.setCurrentGame(gameId);
  }

  /**
   * 投掷骰子 - 使用严格顺序的消息队列
   */
  async rollDice(chatId: string, playerType: string, cardIndex: number): Promise<number> {
    console.log(`🎲 Starting dice roll for ${playerType} card ${cardIndex}`);

    try {
      // 使用消息队列处理骰子，严格按顺序
      const diceValue = await this.messageQueue.enqueueDice(chatId, playerType, cardIndex);

      console.log(`🎲 Dice completed for ${playerType} card ${cardIndex}: ${diceValue}`);
      return diceValue;

    } catch (error) {
      console.error(`🎲 Roll dice error for ${playerType} card ${cardIndex}:`, error);

      // 最终失败时使用随机值
      const fallbackValue = Math.floor(Math.random() * 6) + 1;
      console.warn(`🎲 Using final fallback value: ${fallbackValue}`);

      return fallbackValue;
    }
  }

  /**
   * 发送阻塞文本消息（等待发送完成）
   */
  async sendBlockingMessage(chatId: string, content: string, parseMode: 'Markdown' | 'HTML' = 'Markdown'): Promise<void> {
    await this.messageQueue.enqueueMessage(chatId, content, true, parseMode);
  }

  /**
   * 发送非阻塞文本消息（不等待发送完成）
   */
  async sendMessage(chatId: string, content: string, parseMode: 'Markdown' | 'HTML' = 'Markdown'): Promise<void> {
    await this.messageQueue.enqueueMessage(chatId, content, false, parseMode);
  }

  /**
   * 获取消息队列服务实例
   */
  getMessageQueue(): MessageQueueService {
    return this.messageQueue;
  }

  /**
   * 清空消息队列 (紧急情况使用)
   */
  clearMessageQueue(): void {
    this.messageQueue.clearQueue();
  }

  /**
   * 获取队列状态
   */
  getQueueStatus() {
    return this.messageQueue.getQueueStatus();
  }
}
