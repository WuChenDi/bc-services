import { Bot } from 'grammy';

export class BotService {
  public bot: Bot;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  async sendMessage(
    chatId: string,
    message: string,
    parseMode: 'Markdown' | 'HTML' | undefined = 'Markdown'
  ): Promise<any> {
    return await this.bot.api.sendMessage(chatId, message, { parse_mode: parseMode });
  }

  async setWebhook(url: string): Promise<void> {
    await this.bot.api.setWebhook(url);
  }
}
