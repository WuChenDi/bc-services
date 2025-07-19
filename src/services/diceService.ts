import { Bot } from 'grammy';
import { sleep } from '@/utils';
import type { Env } from '@/types';
import { getConstants, type Constants } from '@/config/constants';

export class DiceService {
  private constants: Constants;

  constructor(private bot: Bot, env: Env) {
    this.constants = getConstants(env);
  }

  async rollDice(chatId: string, playerType: string, cardIndex: number): Promise<number> {
    const maxRetries = this.constants.DICE_ROLL_MAX_RETRIES;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        console.log(`Rolling dice for ${playerType} card ${cardIndex}, attempt ${retryCount + 1}`);

        // 🔥 第一步：发送骰子动画
        const dicePromise = this.bot.api.sendDice(chatId, '🎲');
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Dice timeout')), this.constants.DICE_ROLL_TIMEOUT_MS);
        });

        const diceMessage = await Promise.race([dicePromise, timeoutPromise]) as any;
        const actualDiceValue = diceMessage.dice?.value;

        if (!actualDiceValue || actualDiceValue < 1 || actualDiceValue > 6) {
          throw new Error(`Invalid dice value: ${actualDiceValue}`);
        }

        console.log(`Dice animation sent, value will be: ${actualDiceValue}`);

        // 🔥 第二步：等待骰子动画播放完成
        await sleep(this.constants.DICE_ANIMATION_WAIT_MS);

        // 🔥 第三步：发送点数结果
        await this.sendDiceResult(chatId, playerType, cardIndex, actualDiceValue);

        // 🔥 第四步：稍作停顿再继续下一张牌
        await sleep(this.constants.DICE_RESULT_DELAY_MS);

        console.log(`Dice process completed for ${playerType} card ${cardIndex}: ${actualDiceValue}`);
        return actualDiceValue;

      } catch (error) {
        retryCount++;
        console.error(`Roll dice error (attempt ${retryCount}):`, error);

        if (retryCount < maxRetries) {
          // 🔥 重试前发送提示信息
          await this.sendRetryMessage(chatId, playerType, cardIndex, retryCount);
          await sleep(500);
        }
      }
    }

    // 🔥 所有重试都失败时，使用随机值保证游戏继续
    const fallbackValue = Math.floor(Math.random() * 6) + 1;
    console.warn(`All dice roll attempts failed, using fallback value: ${fallbackValue}`);

    // 🔥 发送失败提示和随机结果
    await this.sendFallbackResult(chatId, playerType, cardIndex, fallbackValue);

    return fallbackValue;
  }

  // 🔥 发送骰子点数结果（同步方式，确保顺序）
  private async sendDiceResult(chatId: string, playerType: string, cardIndex: number, value: number): Promise<void> {
    try {
      const playerText = playerType === 'banker' ? '🏦 庄家' : '👤 闲家';
      await this.bot.api.sendMessage(chatId,
        `🎯 **${playerText}第${cardIndex}张牌开出：${value} 点**`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Failed to send dice result message:', error);
    }
  }

  // 🔥 发送重试提示信息
  private async sendRetryMessage(chatId: string, playerType: string, cardIndex: number, retryCount: number): Promise<void> {
    try {
      const playerText = playerType === 'banker' ? '🏦 庄家' : '👤 闲家';
      await this.bot.api.sendMessage(chatId,
        `⚠️ ${playerText}第${cardIndex}张牌发送失败，正在重试... (${retryCount}/${this.constants.DICE_ROLL_MAX_RETRIES})`
      );
    } catch (error) {
      console.error('Failed to send retry message:', error);
    }
  }

  // 🔥 发送失败回退结果
  private async sendFallbackResult(chatId: string, playerType: string, cardIndex: number, value: number): Promise<void> {
    try {
      const playerText = playerType === 'banker' ? '🏦 庄家' : '👤 闲家';
      await this.bot.api.sendMessage(chatId,
        `⚠️ **${playerText}第${cardIndex}张牌**\n` +
        `🎲 骰子发送失败，系统随机开出：**${value} 点**\n` +
        `💡 游戏继续进行...`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Failed to send fallback message:', error);
    }
  }
}
