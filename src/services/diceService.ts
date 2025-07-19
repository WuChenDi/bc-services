import { Bot } from 'grammy';
import { sleep } from '@/utils';

export class DiceService {
  constructor(private bot: Bot) {}

  async rollDice(chatId: string, playerType: string, cardIndex: number): Promise<number> {
    try {
      const diceMessage = await this.bot.api.sendDice(chatId, '🎲');
      const actualDiceValue = diceMessage.dice?.value;

      if (!actualDiceValue) {
        throw new Error('Failed to get dice value from Telegram');
      }

      await sleep(5000);
      await this.bot.api.sendMessage(chatId,
        `${playerType === 'banker' ? '🏦 庄家' : '👤 闲家'}第${cardIndex}张牌: **${actualDiceValue} 点**`,
        { parse_mode: 'Markdown' }
      );

      return actualDiceValue;
    } catch (error) {
      console.error('Roll dice error:', error);
      await this.bot.api.sendMessage(chatId,
        '❌ 骰子发送失败，请重新开始游戏'
      );
      throw error;
    }
  }
}
