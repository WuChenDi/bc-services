import { Context } from 'grammy';
import { BetType } from '@/types';
import { BotService, StorageService, LoggerService } from '@/services';
import { formatGameInfo, formatGameHistory } from '@/utils';

/**
 * Telegram 命令处理器
 * 
 * 职责:
 * 1. 🤖 注册和处理所有Telegram Bot命令
 * 2. 🎮 直接调用API实现游戏功能
 * 3. 📊 集成游戏状态查询和历史记录
 * 4. 🛡️ 命令验证和错误处理
 * 5. 📝 用户操作日志和统计
 */
export class CommandHandlers {
  private gameRoomsBinding: DurableObjectNamespace;

  constructor(
    private botService: BotService,
    private storageService: StorageService,
    private logger: LoggerService,
    gameRoomsBinding: DurableObjectNamespace
  ) {
    this.gameRoomsBinding = gameRoomsBinding;
    this.registerCommands();
    this.logger.info('命令处理器已初始化', {
      operation: 'command-handlers-init'
    });
  }

  /**
   * 注册所有命令
   */
  private registerCommands(): void {
    const bot = this.botService.bot;

    bot.command('start', this.handleStart.bind(this));
    bot.command('id', this.handleId.bind(this));
    bot.command('newgame', this.handleNewGame.bind(this));
    bot.command('autogame', this.handleAutoGame.bind(this));
    bot.command('stopauto', this.handleStopAuto.bind(this));
    bot.command('bet', this.handleBet.bind(this));
    bot.command('process', this.handleProcess.bind(this));
    bot.command('status', this.handleStatus.bind(this));
    bot.command('history', this.handleHistory.bind(this));
    bot.command('gameinfo', this.handleGameInfo.bind(this));
    bot.command('stopgame', this.handleStopGame.bind(this));
    bot.command('help', this.handleHelp.bind(this));

    this.logger.info('所有命令已注册', {
      operation: 'commands-registered',
      commandCount: 12
    });
  }

  /**
   * 工具方法：调用游戏房间API
   */
  private async callGameRoomAPI(chatId: string, path: string, method: 'GET' | 'POST' = 'POST', data?: any): Promise<any> {
    try {
      const roomId = this.gameRoomsBinding.idFromName(chatId);
      const room = this.gameRoomsBinding.get(roomId);

      const requestBody = method === 'POST' ? { ...data, chatId } : undefined;

      const response = await room.fetch(new Request(`https://game.room${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: requestBody ? JSON.stringify(requestBody) : undefined
      }));

      return await response.json();
    } catch (error) {
      this.logger.error('调用游戏房间API失败', {
        operation: 'call-game-room-api-error',
        chatId,
        path,
        method
      }, error);
      throw error;
    }
  }

  /**
   * 工具方法：获取命令匹配文本
   */
  private getMatchText(ctx: Context): string | undefined {
    return typeof ctx.match === 'string' ? ctx.match : ctx.match?.[0];
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
   * 工具方法：发送成功消息
   */
  private async sendSuccessMessage(ctx: Context, message: string): Promise<void> {
    await ctx.reply(`✅ ${message}`);
  }

  /**
   * /start 命令处理
   */
  private handleStart = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;

    this.logger.info('处理start命令', {
      operation: 'handle-start',
      chatId: chatId?.toString(),
      chatType,
      userId: ctx.from?.id.toString() || 'unknown'
    });

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

    this.logger.info('处理id命令', {
      operation: 'handle-id',
      chatId: chat?.id ? chat.id.toString() : 'unknown',
      userId: user?.id ? user.id.toString() : 'unknown',
      chatType: chat?.type
    });

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

    this.logger.info('处理newgame命令', {
      operation: 'handle-newgame',
      chatId,
      userId: ctx.from?.id.toString() || 'unknown'
    });

    try {
      await ctx.reply('🎲 正在开始新游戏...');

      const result = await this.callGameRoomAPI(chatId, '/start-game');

      if (result.success) {
        await this.sendSuccessMessage(ctx,
          `🎮 新游戏已开始！\n` +
          `游戏编号: ${result.gameNumber}\n` +
          `⏰ 下注时间: 30秒\n` +
          `💰 使用 /bet 命令进行下注`
        );
      } else {
        await this.sendErrorMessage(ctx, result.error || '创建游戏失败');
      }
    } catch (error) {
      this.logger.error('处理newgame命令失败', {
        operation: 'handle-newgame-error',
        chatId
      }, error);
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

    this.logger.info('处理autogame命令', {
      operation: 'handle-autogame',
      chatId,
      userId: ctx.from?.id.toString() || 'unknown'
    });

    try {
      await ctx.reply('🤖 正在开启自动游戏模式...');

      const result = await this.callGameRoomAPI(chatId, '/enable-auto');

      if (result.success) {
        await this.sendSuccessMessage(ctx,
          `🤖 自动游戏模式已开启！\n` +
          `🔄 游戏将每10秒自动进行\n` +
          `🛑 使用 /stopauto 停止自动模式`
        );
      } else {
        await this.sendErrorMessage(ctx, result.error || '开启自动游戏失败');
      }
    } catch (error) {
      this.logger.error('处理autogame命令失败', {
        operation: 'handle-autogame-error',
        chatId
      }, error);
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

    this.logger.info('处理stopauto命令', {
      operation: 'handle-stopauto',
      chatId,
      userId: ctx.from?.id.toString() || 'unknown'
    });

    try {
      await ctx.reply('🛑 正在关闭自动游戏模式...');

      const result = await this.callGameRoomAPI(chatId, '/disable-auto');

      if (result.success) {
        await this.sendSuccessMessage(ctx,
          `🛑 自动游戏模式已关闭\n` +
          `🎮 使用 /newgame 开始手动游戏`
        );
      } else {
        await this.sendErrorMessage(ctx, result.error || '关闭自动游戏失败');
      }
    } catch (error) {
      this.logger.error('处理stopauto命令失败', {
        operation: 'handle-stopauto-error',
        chatId
      }, error);
      await this.sendErrorMessage(ctx, '关闭自动游戏失败，请稍后再试');
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

      this.logger.info('处理bet命令', {
        operation: 'handle-bet',
        chatId,
        userId: ctx.from?.id.toString() || 'unknown',
        betType,
        amount
      });

      await ctx.reply('💰 正在处理下注...');

      const result = await this.callGameRoomAPI(chatId, '/place-bet', 'POST', {
        betType,
        amount,
        userId: ctx.from?.id.toString(),
        userName: ctx.from?.first_name || ctx.from?.username || 'Unknown'
      });

      if (result.success) {
        const betTypeNames = {
          banker: '庄家',
          player: '闲家',
          tie: '和局'
        };

        let message = `✅ 💰 ${ctx.from?.first_name || ctx.from?.username || 'Unknown'} (${ctx.from?.id}) 下注成功！\n`;
        message += `类型: ${betTypeNames[betType]}\n`;

        const finalAmount = result.amount || amount;

        if (result.isAccumulated) {
          // 同类型累加
          const previousAmount = result.previousAmount || 0;
          const addedAmount = result.addedAmount || amount;
          message += `金额: ${previousAmount} + ${addedAmount} = ${finalAmount} 点\n`;
          message += `📈 累加下注\n`;
        } else if (result.isNewBetType) {
          // 新的下注类型
          message += `金额: ${finalAmount} 点\n`;
          message += `✨ 新增下注类型\n`;
        } else {
          // 首次下注
          message += `金额: ${finalAmount} 点\n`;
          message += `🎯 首次下注\n`;
        }

        message += `当前总下注: ${result.totalBetsAmount || 0} 点`;

        await this.sendSuccessMessage(ctx, message);
      } else {
        await this.sendErrorMessage(ctx, result.error || '下注失败');
      }
    } catch (error) {
      this.logger.error('处理bet命令失败', {
        operation: 'handle-bet-error',
        chatId
      }, error);
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

    this.logger.info('处理process命令', {
      operation: 'handle-process',
      chatId,
      userId: ctx.from?.id.toString() || 'unknown'
    });

    try {
      await ctx.reply('🎲 正在立即处理游戏...');

      const result = await this.callGameRoomAPI(chatId, '/process-game');

      if (result.success) {
        await this.sendSuccessMessage(ctx,
          `🎯 游戏处理完成！\n` +
          `🎲 游戏结果将很快揭晓`
        );
      } else {
        await this.sendErrorMessage(ctx, result.error || '处理游戏失败');
      }
    } catch (error) {
      this.logger.error('处理process命令失败', {
        operation: 'handle-process-error',
        chatId
      }, error);
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

    this.logger.info('处理status命令', {
      operation: 'handle-status',
      chatId,
      userId: ctx.from?.id.toString() || 'unknown'
    });

    try {
      const result = await this.callGameRoomAPI(chatId, '/get-status', 'GET');

      if (result.success && result.status) {
        const status = result.status;

        // 修正：使用字符串映射而不是枚举
        const stateNames: Record<string, string> = {
          'idle': '空闲',
          'betting': '下注中',
          'processing': '处理中',
          'revealing': '开牌中',
          'finished': '已结束',
          'no_game': '无游戏',
          'error': '错误状态'
        };

        let message = `📊 **游戏状态**\n\n`;
        message += `🎮 状态: ${stateNames[status.state] || status.state}\n`;

        if (status.gameNumber) {
          message += `🎯 游戏编号: ${status.gameNumber}\n`;
        }

        if (status.isAutoMode || status.autoGameEnabled) {
          message += `🤖 自动模式: 开启\n`;
        }

        if (status.totalBets > 0) {
          message += `💰 总下注: ${status.totalBets} 点\n`;
        }

        if (status.betsCount > 0) {
          message += `👥 参与人数: ${status.betsCount} 人\n`;
        }

        if (status.totalBetsCount && status.totalBetsCount > 0) {
          message += `🎲 下注次数: ${status.totalBetsCount} 次\n`;
        }

        if (status.timeRemaining && status.timeRemaining > 0) {
          message += `⏰ 剩余时间: ${Math.ceil(status.timeRemaining / 1000)} 秒\n`;
        }

        await ctx.reply(message, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('📊 暂无游戏状态信息');
      }
    } catch (error) {
      this.logger.error('处理status命令失败', {
        operation: 'handle-status-error',
        chatId
      }, error);
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

    this.logger.info('处理history命令', {
      operation: 'handle-history',
      chatId,
      userId: ctx.from?.id.toString() || 'unknown'
    });

    try {
      const result = await this.storageService.getGameHistory(chatId, 10);

      if (result.success && result.data && result.data.length > 0) {
        await ctx.reply(formatGameHistory(result.data), { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('📊 暂无游戏记录');
      }
    } catch (error) {
      this.logger.error('处理history命令失败', {
        operation: 'handle-history-error',
        chatId
      }, error);
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

    this.logger.info('处理gameinfo命令', {
      operation: 'handle-gameinfo',
      gameNumber,
      userId: ctx.from?.id.toString() || 'unknown'
    });

    try {
      const result = await this.storageService.getGameDetail(gameNumber);

      if (result.success && result.data) {
        await ctx.reply(formatGameInfo(result.data), { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('❌ 未找到该游戏记录');
      }
    } catch (error) {
      this.logger.error('处理gameinfo命令失败', {
        operation: 'handle-gameinfo-error',
        gameNumber
      }, error);
      await this.sendErrorMessage(ctx, '获取游戏详情失败，请稍后再试');
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

    this.logger.info('处理stopgame命令', {
      operation: 'handle-stopgame',
      chatId,
      userId: ctx.from?.id.toString() || 'unknown'
    });

    try {
      await ctx.reply('🛑 正在停止游戏...');

      const result = await this.callGameRoomAPI(chatId, '/disable-auto');

      if (result.success) {
        await this.sendSuccessMessage(ctx,
          `🛑 游戏已停止\n` +
          `🎮 使用 /newgame 开始新游戏`
        );
      } else {
        await this.sendErrorMessage(ctx, result.error || '停止游戏失败');
      }
    } catch (error) {
      this.logger.error('处理stopgame命令失败', {
        operation: 'handle-stopgame-error',
        chatId
      }, error);
      await this.sendErrorMessage(ctx, '停止游戏失败，请稍后再试');
    }
  };

  /**
   * /help 命令处理
   */
  private handleHelp = async (ctx: Context): Promise<void> => {
    this.logger.info('处理help命令', {
      operation: 'handle-help',
      userId: ctx.from?.id.toString() || 'unknown',
      chatId: ctx.chat?.id.toString() || 'unknown'
    });

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
      `💡 自动模式下游戏将持续进行，每局间隔10秒\n\n` +
      `🎯 所有功能现已完全支持，直接使用命令即可！`,
      { parse_mode: 'Markdown' }
    );
  };
}
