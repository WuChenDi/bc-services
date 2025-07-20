import { Bot } from 'grammy';
import { sleep } from '@/utils';
import type { Env } from '@/types';
import { getConstants, type Constants } from '@/config/constants';
import { MessageQueueService } from './messageQueue';

export class DiceService {
  private constants: Constants;
  private messageQueue: MessageQueueService;

  constructor(private bot: Bot, env: Env) {
    this.constants = getConstants(env);
    this.messageQueue = new MessageQueueService(bot);
  }

  /**
   * 投掷骰子 - 使用消息队列确保顺序
   */
  async rollDice(chatId: string, playerType: string, cardIndex: number): Promise<number> {
    console.log(`Rolling dice for ${playerType} card ${cardIndex}`);

    try {
      // 使用消息队列处理骰子，确保顺序和重试机制
      const diceValue = await this.messageQueue.enqueueDice(chatId, playerType, cardIndex);
      
      console.log(`Dice process completed for ${playerType} card ${cardIndex}: ${diceValue}`);
      return diceValue;
      
    } catch (error) {
      console.error(`Roll dice error for ${playerType} card ${cardIndex}:`, error);
      
      // 最终失败时使用随机值
      const fallbackValue = Math.floor(Math.random() * 6) + 1;
      console.warn(`Using fallback value: ${fallbackValue}`);
      
      return fallbackValue;
    }
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
