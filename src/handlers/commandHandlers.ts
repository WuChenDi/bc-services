import { Bot, Context } from 'grammy';
import {
  BetType,
  GameState,
  type GameRecord,
  type StartGameResponse,
  type PlaceBetResponse,
  type ApiResponse,
  type GameStatusResponse
} from '@/types';
import { StorageService } from '@/services';
import { formatGameInfo, formatGameHistory } from '@/utils';

export class CommandHandlers {
  constructor(
    private bot: Bot,
    private gameRooms: DurableObjectNamespace,
    private storage: StorageService
  ) {
    this.registerCommands();
  }

  private registerCommands(): void {
    this.bot.command('start', this.handleStart.bind(this));
    this.bot.command('id', this.handleId.bind(this));
    this.bot.command('newgame', this.handleNewGame.bind(this));
    this.bot.command('autogame', this.handleAutoGame.bind(this));
    this.bot.command('stopauto', this.handleStopAuto.bind(this));
    this.bot.command('bet', this.handleBet.bind(this));
    this.bot.command('process', this.handleProcess.bind(this));
    this.bot.command('status', this.handleStatus.bind(this));
    this.bot.command('history', this.handleHistory.bind(this));
    this.bot.command('gameinfo', this.handleGameInfo.bind(this));
    this.bot.command('stopgame', this.handleStopGame.bind(this));
    this.bot.command('help', this.handleHelp.bind(this));
  }

  /**
   * 工具方法：获取命令匹配文本
   */
  private getMatchText(ctx: Context): string | undefined {
    return typeof ctx.match === 'string' ? ctx.match : ctx.match?.[0];
  }

  /**
   * 工具方法：获取游戏房间实例
   */
  private getRoomStub(chatId: string) {
    const roomId = this.gameRooms.idFromName(chatId);
    return this.gameRooms.get(roomId);
  }

  /**
   * 工具方法：验证聊天ID
   */
  private validateChatId(ctx: Context): string | null {
    const chatId = ctx.chat?.id?.toString();
    return chatId || null;
  }

  /**
   * 工具方法：发送错误消息
   */
  private async sendErrorMessage(ctx: Context, message: string): Promise<void> {
    await ctx.reply(`❌ ${message}`);
  }

  /**
   * /start 命令处理
   */
  private handleStart = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;

    if (chatType === 'group' || chatType === 'supergroup') {
      await ctx.reply(
        `🎮 百家乐 Bot 已启动！\n` +
        `群组 ID: \`${chatId}\`\n\n` +
        `🎲 游戏命令:\n` +
        `/newgame - 开始新游戏\n` +
        `/bet banker 100 - 下注庄家\n` +
        `/bet player 50 - 下注闲家\n` +
        `/bet tie 25 - 下注和局\n` +
        `/process - 立即处理游戏\n` +
        `/status - 查看游戏状态\n` +
        `/stopgame - 停止当前游戏\n\n` +
        `🤖 自动游戏:\n` +
        `/autogame - 开启自动游戏模式\n` +
        `/stopauto - 关闭自动游戏模式\n\n` +
        `📊 游戏记录:\n` +
        `/history - 查看最近10局记录\n` +
        `/gameinfo <游戏编号> - 查看指定游戏详情\n\n` +
        `📋 其他命令:\n` +
        `/help - 查看帮助\n` +
        `/id - 获取群组ID`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        `👋 你好！这是私聊。\n` +
        `你的用户 ID: \`${chatId}\`\n\n` +
        `请将我添加到群组中使用百家乐功能。`,
        { parse_mode: 'Markdown' }
      );
    }
  };

  /**
   * /id 命令处理
   */
  private handleId = async (ctx: Context): Promise<void> => {
    const chat = ctx.chat;
    const user = ctx.from;

    let message = `🆔 **ID 信息**\n\n`;

    if (chat?.type === 'group' || chat?.type === 'supergroup') {
      message += `📋 群组信息:\n`;
      message += `• 群组名: ${chat.title}\n`;
      message += `• 群组 ID: \`${chat.id}\`\n`;
      message += `• 类型: ${chat.type}\n\n`;
    } else {
      message += `👤 私聊信息:\n`;
      message += `• 聊天 ID: \`${chat?.id}\`\n\n`;
    }

    message += `👤 用户信息:\n`;
    message += `• 用户 ID: \`${user?.id}\`\n`;
    message += `• 姓名: ${user?.first_name} ${user?.last_name || ''}\n`;
    message += `• 用户名: @${user?.username || '无'}\n\n`;
    message += `💡 复制上面的 ID 用于 API 调用`;

    await ctx.reply(message, { parse_mode: 'Markdown' });
  };

  /**
   * /newgame 命令处理
   */
  private handleNewGame = async (ctx: Context): Promise<void> => {
    const chatId = this.validateChatId(ctx);
    if (!chatId) {
      await this.sendErrorMessage(ctx, '无法获取聊天ID');
      return;
    }

    try {
      const room = this.getRoomStub(chatId);
      const response = await room.fetch(new Request('https://game.room/start-game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId })
      }));

      const result = await response.json() as StartGameResponse;

      if (result.success) {
        await ctx.reply(
          `🎲 **第 ${result.gameNumber} 局百家乐开始！**\n\n` +
          `💰 下注时间：30秒\n` +
          `📝 下注格式：\n` +
          `• /bet banker 100 - 下注庄家 100 点\n` +
          `• /bet player 50 - 下注闲家 50 点\n` +
          `• /bet tie 25 - 下注和局 25 点\n\n` +
          `⏰ 系统将自动倒计时和开牌\n` +
          `💡 或使用 /process 立即开牌`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await this.sendErrorMessage(ctx, result.error || '创建游戏失败');
      }
    } catch (error) {
      console.error('New game error:', error);
      await this.sendErrorMessage(ctx, '创建游戏失败，请稍后再试');
    }
  };

  /**
   * /autogame 命令处理
   */
  private handleAutoGame = async (ctx: Context): Promise<void> => {
    const chatId = this.validateChatId(ctx);
    if (!chatId) {
      await this.sendErrorMessage(ctx, '无法获取聊天ID');
      return;
    }

    try {
      const room = this.getRoomStub(chatId);
      const response = await room.fetch(new Request('https://game.room/enable-auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId })
      }));

      const result = await response.json() as ApiResponse;

      if (result.success) {
        await ctx.reply(
          `🤖 **自动游戏模式已开启！**\n\n` +
          `🔄 游戏将持续自动进行\n` +
          `⏰ 每局间隔10秒\n` +
          `💡 即使无人下注也会继续发牌\n\n` +
          `🛑 使用 /stopauto 关闭自动模式`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await this.sendErrorMessage(ctx, result.error || '开启自动游戏失败');
      }
    } catch (error) {
      console.error('Auto game error:', error);
      await this.sendErrorMessage(ctx, '开启自动游戏失败，请稍后再试');
    }
  };

  /**
   * /stopauto 命令处理
   */
  private handleStopAuto = async (ctx: Context): Promise<void> => {
    const chatId = this.validateChatId(ctx);
    if (!chatId) {
      await this.sendErrorMessage(ctx, '无法获取聊天ID');
      return;
    }

    try {
      const room = this.getRoomStub(chatId);
      const response = await room.fetch(new Request('https://game.room/disable-auto', {
        method: 'POST'
      }));

      const result = await response.json() as ApiResponse;

      if (result.success) {
        await ctx.reply(
          `🛑 **自动游戏模式已关闭**\n\n` +
          `💡 使用 /newgame 手动开始游戏\n` +
          `🤖 使用 /autogame 重新开启自动模式`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await this.sendErrorMessage(ctx, result.error || '关闭自动游戏失败');
      }
    } catch (error) {
      console.error('Stop auto error:', error);
      await this.sendErrorMessage(ctx, '关闭自动游戏失败，请稍后再试');
    }
  };

  /**
   * /stopgame 命令处理
   */
  private handleStopGame = async (ctx: Context): Promise<void> => {
    const chatId = this.validateChatId(ctx);
    if (!chatId) {
      await this.sendErrorMessage(ctx, '无法获取聊天ID');
      return;
    }

    try {
      const room = this.getRoomStub(chatId);
      const response = await room.fetch(new Request('https://game.room/stop-game', {
        method: 'POST'
      }));

      const result = await response.json() as ApiResponse;

      if (result.success) {
        await ctx.reply(
          `🛑 **游戏已强制停止**\n\n` +
          `✅ 当前游戏已终止\n` +
          `🔄 自动游戏模式已关闭\n` +
          `💡 使用 /newgame 开始新游戏`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await this.sendErrorMessage(ctx, result.error || '停止游戏失败');
      }
    } catch (error) {
      console.error('Stop game error:', error);
      await this.sendErrorMessage(ctx, '停止游戏失败，请稍后再试');
    }
  };

  /**
   * /bet 命令处理
   */
  private handleBet = async (ctx: Context): Promise<void> => {
    const chatId = this.validateChatId(ctx);
    if (!chatId) {
      await this.sendErrorMessage(ctx, '无法获取聊天ID');
      return;
    }

    try {
      const matchText = this.getMatchText(ctx);
      const args = matchText?.trim().split(/\s+/);

      if (!args || args.length !== 2) {
        await ctx.reply('❌ 下注格式错误\n正确格式: /bet banker 100');
        return;
      }

      const betTypeInput = args[0]?.toLowerCase();
      const amountInput = args[1];

      if (!betTypeInput || !amountInput) {
        await ctx.reply('❌ 下注参数不完整');
        return;
      }

      if (!Object.values(BetType).includes(betTypeInput as BetType)) {
        await ctx.reply('❌ 下注类型错误\n可选类型: banker(庄家), player(闲家), tie(和局)');
        return;
      }

      const betType = betTypeInput as BetType;
      const amount = parseInt(amountInput, 10);

      if (isNaN(amount) || amount <= 0) {
        await ctx.reply('❌ 下注金额必须是大于0的数字');
        return;
      }

      if (amount > 10000) {
        await ctx.reply('❌ 单次下注金额不能超过10000点');
        return;
      }

      const room = this.getRoomStub(chatId);
      const response = await room.fetch(new Request('https://game.room/place-bet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: ctx.from?.id?.toString(),
          userName: ctx.from?.first_name || '匿名用户',
          betType,
          amount
        })
      }));

      const result = await response.json() as PlaceBetResponse;

      if (result.success) {
        const betTypeText: Record<BetType, string> = {
          [BetType.Banker]: '庄家',
          [BetType.Player]: '闲家',
          [BetType.Tie]: '和局'
        };

        let message = `✅ **${result.userName} 下注成功！**\n\n`;

        if (result.isAccumulated) {
          message += `💰 ${betTypeText[result.betType!]} ${result.previousAmount} + ${result.addedAmount} = **${result.amount} 点**\n`;
          message += `📈 累加下注成功\n`;
        } else if (result.isReplaced) {
          const previousBetTypeText: Record<BetType, string> = {
            [BetType.Banker]: '庄家',
            [BetType.Player]: '闲家',
            [BetType.Tie]: '和局'
          };
          message += `💰 从 ${previousBetTypeText[result.previousBetType!]} ${result.previousAmount}点\n`;
          message += `📝 改为 ${betTypeText[result.betType!]} **${result.amount} 点**\n`;
          message += `🔄 下注类型已更换\n`;
        } else {
          message += `💰 ${betTypeText[result.betType!]} **${result.amount} 点**\n`;
          message += `🆕 首次下注\n`;
        }

        message += `👥 当前参与人数：${result.totalBets}\n`;
        message += `⏰ 剩余时间：${result.remainingTime} 秒\n\n`;

        // 🔥 添加下注提示
        message += `💡 **下注规则:**\n`;
        message += `• 相同类型重复下注会累加金额\n`;
        message += `• 不同类型下注会替换之前的下注\n`;
        message += `• 单人最大下注限制：10000点\n`;
        message += `🎰 买定离手，不可取消！`;

        await ctx.reply(message, { parse_mode: 'Markdown' });
      } else {
        await this.sendErrorMessage(ctx, result.error || '下注失败');
      }
    } catch (error) {
      console.error('Bet error:', error);
      await this.sendErrorMessage(ctx, '下注失败，请稍后再试');
    }
  };

  /**
   * /process 命令处理
   */
  private handleProcess = async (ctx: Context): Promise<void> => {
    const chatId = this.validateChatId(ctx);
    if (!chatId) {
      await this.sendErrorMessage(ctx, '无法获取聊天ID');
      return;
    }

    try {
      const room = this.getRoomStub(chatId);
      const response = await room.fetch(new Request('https://game.room/process-game', {
        method: 'POST'
      }));

      const result = await response.json() as ApiResponse;

      if (!result.success) {
        await this.sendErrorMessage(ctx, result.error || '处理游戏失败');
      }
    } catch (error) {
      console.error('Process game error:', error);
      await this.sendErrorMessage(ctx, '处理游戏失败，请稍后再试');
    }
  };

  /**
   * /status 命令处理
   */
  private handleStatus = async (ctx: Context): Promise<void> => {
    const chatId = this.validateChatId(ctx);
    if (!chatId) {
      await this.sendErrorMessage(ctx, '无法获取聊天ID');
      return;
    }

    try {
      const room = this.getRoomStub(chatId);
      const response = await room.fetch('https://game.room/get-status');
      const result = await response.json() as GameStatusResponse;

      if (result.status === 'no_game') {
        await ctx.reply(
          `❌ 当前没有进行中的游戏\n\n` +
          `🤖 自动游戏: ${result.autoGameEnabled ? '✅ 已开启' : '❌ 已关闭'}`
        );
        return;
      }

      const stateText = {
        [GameState.Idle]: '等待中',
        [GameState.Betting]: '下注中',
        [GameState.Processing]: '处理中',
        [GameState.Revealing]: '开牌中',
        [GameState.Finished]: '已结束'
      };

      let message = `📊 **游戏状态 - 第 ${result.gameNumber} 局**\n\n`;
      message += `🎯 状态: ${stateText[result.state!]}\n`;
      message += `👥 下注人数: ${result.betsCount}\n`;
      message += `🤖 自动游戏: ${result.autoGameEnabled ? '✅ 已开启' : '❌ 已关闭'}\n`;

      if (result.state === GameState.Betting && result.timeRemaining) {
        message += `⏰ 剩余时间: ${result.timeRemaining} 秒\n`;
      }

      if (result.state === GameState.Finished && result.result?.winner) {
        const winnerText = {
          [BetType.Banker]: '庄家胜',
          [BetType.Player]: '闲家胜',
          [BetType.Tie]: '和局'
        };
        message += `\n🏆 **结果:** ${winnerText[result.result.winner]}`;
        message += `\n🎲 庄家: ${result.result.banker} 点`;
        message += `\n🎲 闲家: ${result.result.player} 点`;
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Status error:', error);
      await this.sendErrorMessage(ctx, '获取状态失败，请稍后再试');
    }
  };

  /**
   * /history 命令处理
   */
  private handleHistory = async (ctx: Context): Promise<void> => {
    const chatId = this.validateChatId(ctx);
    if (!chatId) {
      await this.sendErrorMessage(ctx, '无法获取聊天ID');
      return;
    }

    try {
      const history = await this.storage.getGameHistory(chatId);
      if (!history.length) {
        await ctx.reply('📊 暂无游戏记录');
        return;
      }

      await ctx.reply(formatGameHistory(history), { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('History error:', error);
      await this.sendErrorMessage(ctx, '获取历史记录失败，请稍后再试');
    }
  };

  /**
   * /gameinfo 命令处理
   */
  private handleGameInfo = async (ctx: Context): Promise<void> => {
    const matchText = this.getMatchText(ctx);
    const gameNumber = matchText?.trim();

    if (!gameNumber) {
      await ctx.reply('❌ 请提供游戏编号\n格式: /gameinfo 20250719123456789');
      return;
    }

    if (!/^\d{17}$/.test(gameNumber)) {
      await ctx.reply('❌ 游戏编号格式错误\n应为17位数字');
      return;
    }

    try {
      const game = await this.storage.getGameDetail(gameNumber);
      if (!game) {
        await ctx.reply('❌ 未找到该游戏记录');
        return;
      }

      await ctx.reply(formatGameInfo(game), { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Game info error:', error);
      await this.sendErrorMessage(ctx, '获取游戏详情失败，请稍后再试');
    }
  };

  /**
   * /help 命令处理
   */
  private handleHelp = async (ctx: Context): Promise<void> => {
    await ctx.reply(
      `🎮 **百家乐 Bot 帮助**\n\n` +
      `📋 **基础命令：**\n` +
      `/start - 启动机器人\n` +
      `/id - 获取群组和用户信息\n` +
      `/newgame - 开始新游戏\n` +
      `/bet banker 100 - 下注庄家 100 点\n` +
      `/bet player 50 - 下注闲家 50 点\n` +
      `/bet tie 25 - 下注和局 25 点\n` +
      `/process - 立即处理游戏\n` +
      `/status - 查看游戏状态\n` +
      `/stopgame - 停止当前游戏\n\n` +
      `🤖 **自动游戏：**\n` +
      `/autogame - 开启自动游戏模式\n` +
      `/stopauto - 关闭自动游戏模式\n\n` +
      `📊 **游戏记录：**\n` +
      `/history - 查看最近10局记录\n` +
      `/gameinfo <编号> - 查看游戏详情\n\n` +
      `📏 **使用规则：**\n` +
      `• 单次下注金额：1-10000点\n` +
      `• 下注时间：30秒\n` +
      `• 和局赔率：1:8\n` +
      `• 庄家/闲家赔率：1:1\n\n` +
      `💡 自动模式下游戏将持续进行，每局间隔10秒`,
      { parse_mode: 'Markdown' }
    );
  };
}
