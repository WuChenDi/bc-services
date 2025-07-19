import { Bot, webhookCallback } from 'grammy';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { BetType, Env, GameState, GameRecord } from './types';

// 创建 Hono 应用
const app = new Hono<{ Bindings: Env }>();
app.use('*', cors());

// 创建 Bot 实例
function createBot(token: string, gameRooms: DurableObjectNamespace) {
  const bot = new Bot(token);

  // /start 命令
  bot.command('start', (ctx) => {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;

    if (chatType === 'group' || chatType === 'supergroup') {
      return ctx.reply(
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
      return ctx.reply(
        `👋 你好！这是私聊。\n` +
        `你的用户 ID: \`${chatId}\`\n\n` +
        `请将我添加到群组中使用百家乐功能。`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // /id 命令
  bot.command('id', (ctx) => {
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

    return ctx.reply(message, { parse_mode: 'Markdown' });
  });

  // /newgame 命令
  bot.command('newgame', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    try {
      const roomId = gameRooms.idFromName(chatId);
      const room = gameRooms.get(roomId);

      const response = await room.fetch(new Request('https://game.room/start-game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId })
      }));

      const result = await response.json() as any;

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
        await ctx.reply(`❌ ${result.error}`);
      }
    } catch (error) {
      console.error('New game error:', error);
      await ctx.reply('❌ 创建游戏失败，请稍后再试');
    }
  });

  // /autogame 命令
  bot.command('autogame', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    try {
      const roomId = gameRooms.idFromName(chatId);
      const room = gameRooms.get(roomId);

      const response = await room.fetch(new Request('https://game.room/enable-auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId })
      }));

      const result = await response.json() as any;

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
        await ctx.reply(`❌ ${result.error}`);
      }
    } catch (error) {
      console.error('Auto game error:', error);
      await ctx.reply('❌ 开启自动游戏失败，请稍后再试');
    }
  });

  // 🔥 新增：/stopauto 命令
  bot.command('stopauto', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    try {
      const roomId = gameRooms.idFromName(chatId);
      const room = gameRooms.get(roomId);

      const response = await room.fetch(new Request('https://game.room/disable-auto', {
        method: 'POST'
      }));

      const result = await response.json() as any;

      if (result.success) {
        await ctx.reply(
          `🛑 **自动游戏模式已关闭**\n\n` +
          `💡 使用 /newgame 手动开始游戏\n` +
          `🤖 使用 /autogame 重新开启自动模式`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(`❌ ${result.error}`);
      }
    } catch (error) {
      console.error('Stop auto error:', error);
      await ctx.reply('❌ 关闭自动游戏失败，请稍后再试');
    }
  });

  // /bet 命令
  bot.command('bet', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    try {
      const args = ctx.match?.split(' ');
      if (!args || args.length !== 2) {
        return ctx.reply('❌ 下注格式错误\n正确格式: /bet banker 100');
      }

      const betType = args[0].toLowerCase();
      const amount = parseInt(args[1]);

      if (!Object.values(BetType).includes(betType as BetType) || isNaN(amount) || amount <= 0) {
        return ctx.reply('❌ 下注参数错误');
      }

      const roomId = gameRooms.idFromName(chatId);
      const room = gameRooms.get(roomId);

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

      const result = await response.json() as any;

      if (result.success) {
        const betTypeText = {
          [BetType.Banker]: '庄家',
          [BetType.Player]: '闲家',
          [BetType.Tie]: '和局'
        };

        await ctx.reply(
          `✅ **${result.userName} 下注成功！**\n\n` +
          `💰 ${betTypeText[result.betType as keyof typeof betTypeText]} ${result.amount} 点\n` +
          `👥 当前参与人数：${result.totalBets}\n` +
          `⏰ 剩余时间：${result.remainingTime} 秒`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(`❌ ${result.error}`);
      }
    } catch (error) {
      console.error('Bet error:', error);
      await ctx.reply('❌ 下注失败，请稍后再试');
    }
  });

  // /process 命令
  bot.command('process', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    try {
      const roomId = gameRooms.idFromName(chatId);
      const room = gameRooms.get(roomId);

      const response = await room.fetch(new Request('https://game.room/process-game', {
        method: 'POST'
      }));

      const result = await response.json() as any;

      if (!result.success) {
        await ctx.reply(`❌ ${result.error}`);
      }
    } catch (error) {
      console.error('Process game error:', error);
      await ctx.reply('❌ 处理游戏失败，请稍后再试');
    }
  });

  // /status 命令
  bot.command('status', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    try {
      const roomId = gameRooms.idFromName(chatId);
      const room = gameRooms.get(roomId);

      const response = await room.fetch('https://game.room/get-status');
      const result = await response.json() as any;

      if (result.status === 'no_game') {
        return ctx.reply(
          `❌ 当前没有进行中的游戏\n\n` +
          `🤖 自动游戏: ${result.autoGameEnabled ? '✅ 已开启' : '❌ 已关闭'}`
        );
      }

      const stateText = {
        [GameState.Idle]: '等待中',
        [GameState.Betting]: '下注中',
        [GameState.Processing]: '处理中',
        [GameState.Revealing]: '开牌中',
        [GameState.Finished]: '已结束'
      };

      let message = `📊 **游戏状态 - 第 ${result.gameNumber} 局**\n\n`;
      message += `🎯 状态: ${stateText[result.state]}\n`;
      message += `👥 下注人数: ${result.betsCount}\n`;
      message += `🤖 自动游戏: ${result.autoGameEnabled ? '✅ 已开启' : '❌ 已关闭'}\n`;

      if (result.state === GameState.Betting) {
        message += `⏰ 剩余时间: ${result.timeRemaining} 秒\n`;
      }

      if (result.state === GameState.Finished && result.result.winner) {
        const winnerText = {
          [BetType.Banker]: '庄家胜',
          [BetType.Player]: '闲家胜',
          [BetType.Tie]: '和局'
        };
        message += `\n🏆 **结果:** ${winnerText[result.result.winner]}`;
        message += `\n🎲 庄家: ${result.result.banker} 点`;
        message += `\n🎲 闲家: ${result.result.player} 点`;
      }

      return ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Status error:', error);
      return ctx.reply('❌ 获取状态失败，请稍后再试');
    }
  });

  // /history 命令
  bot.command('history', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    try {
      const response = await fetch(`https://your-worker-domain.workers.dev/game-history/${chatId}`);
      const result = await response.json() as any;

      if (!result.success || !result.history || result.history.length === 0) {
        return ctx.reply('📊 暂无游戏记录');
      }

      let message = `📊 **最近10局游戏记录**\n\n`;

      result.history.forEach((record: GameRecord, index: number) => {
        const winnerText = {
          [BetType.Banker]: '🏦庄',
          [BetType.Player]: '👤闲',
          [BetType.Tie]: '🤝和'
        };

        const date = new Date(record.endTime);
        const timeStr = date.toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });

        message += `${index + 1}. **${record.gameNumber}**\n`;
        message += `   ${timeStr} | ${winnerText[record.result.winner!]} | ${record.result.banker}-${record.result.player} | ${record.totalBets}人\n\n`;
      });

      message += `💡 使用 /gameinfo <游戏编号> 查看详情`;

      return ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('History error:', error);
      return ctx.reply('❌ 获取历史记录失败，请稍后再试');
    }
  });

  // /gameinfo 命令
  bot.command('gameinfo', async (ctx) => {
    const gameNumber = ctx.match?.trim();
    if (!gameNumber) {
      return ctx.reply('❌ 请提供游戏编号\n格式: /gameinfo 20250719123456789');
    }

    try {
      const response = await fetch(`https://your-worker-domain.workers.dev/game-detail/${gameNumber}`);
      const result = await response.json() as any;

      if (!result.success || !result.game) {
        return ctx.reply('❌ 未找到该游戏记录');
      }

      const game: GameRecord = result.game;
      const winnerText = {
        [BetType.Banker]: '🏦 庄家胜',
        [BetType.Player]: '👤 闲家胜',
        [BetType.Tie]: '🤝 和局'
      };

      const startTime = new Date(game.startTime).toLocaleString('zh-CN');
      const endTime = new Date(game.endTime).toLocaleString('zh-CN');
      const duration = Math.floor((game.endTime - game.startTime) / 1000);

      let message = `🎯 **游戏详情 - ${game.gameNumber}**\n\n`;
      message += `📅 开始时间: ${startTime}\n`;
      message += `⏰ 结束时间: ${endTime}\n`;
      message += `⏱️ 游戏时长: ${duration}秒\n\n`;

      message += `🎲 **开牌结果:**\n`;
      message += `🏦 庄家: ${game.cards.banker.join(' + ')} = ${game.result.banker}点\n`;
      message += `👤 闲家: ${game.cards.player.join(' + ')} = ${game.result.player}点\n`;
      message += `🏆 **${winnerText[game.result.winner!]}**\n\n`;

      if (game.totalBets > 0) {
        message += `💰 **下注情况:**\n`;
        message += `👥 参与人数: ${game.totalBets}\n`;
        message += `💵 总下注额: ${game.totalAmount}点\n\n`;

        const betSummary = Object.values(game.bets).reduce((acc, bet) => {
          acc[bet.type] = (acc[bet.type] || 0) + bet.amount;
          return acc;
        }, {} as Record<BetType, number>);

        message += `📊 **分类下注:**\n`;
        message += `🏦 庄家: ${betSummary[BetType.Banker] || 0}点\n`;
        message += `👤 闲家: ${betSummary[BetType.Player] || 0}点\n`;
        message += `🤝 和局: ${betSummary[BetType.Tie] || 0}点`;
      } else {
        message += `😔 **无人下注**`;
      }

      return ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Game info error:', error);
      return ctx.reply('❌ 获取游戏详情失败，请稍后再试');
    }
  });

  // /stopgame 命令
  bot.command('stopgame', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    try {
      const roomId = gameRooms.idFromName(chatId);
      const room = gameRooms.get(roomId);

      const response = await room.fetch('https://game.room/stop-game', {
        method: 'POST'
      });

      const result = await response.json() as any;

      if (result.success) {
        await ctx.reply('🛑 游戏已停止，自动模式已关闭');
      } else {
        await ctx.reply(`❌ ${result.error}`);
      }
    } catch (error) {
      console.error('Stop game error:', error);
      await ctx.reply('❌ 停止游戏失败，请稍后再试');
    }
  });

  // /help 命令
  bot.command('help', (ctx) => {
    return ctx.reply(
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
      `💡 自动模式下游戏将持续进行，每局间隔10秒`,
      { parse_mode: 'Markdown' }
    );
  });

  return bot;
}

// API 路由
app.get('/', (c) => {
  return c.json({
    message: '百家乐 Bot with Hono and Durable Objects!',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    platform: 'cloudflare-workers',
    timestamp: new Date().toISOString()
  });
});

app.post('/webhook', async (c) => {
  const token = c.env.BOT_TOKEN;
  if (!token) {
    return c.json({ error: 'BOT_TOKEN not configured' }, 500);
  }

  try {
    const bot = createBot(token, c.env.GAME_ROOMS);
    const callback = webhookCallback(bot, 'hono');
    return await callback(c);
  } catch (error) {
    console.error('Webhook error:', error);
    return c.json({
      error: 'Webhook processing failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 获取游戏历史记录 API
app.get('/game-history/:chatId', async (c) => {
  try {
    const chatId = c.req.param('chatId');
    const latestGamesKey = `latest_games:${chatId}`;

    const latestGamesData = await c.env.BC_GAME_KV.get(latestGamesKey);
    if (!latestGamesData) {
      return c.json({ success: true, history: [] });
    }

    const latestGames: string[] = JSON.parse(latestGamesData);
    const history: GameRecord[] = [];

    // 获取最近10局的详细信息
    for (const gameNumber of latestGames.slice(0, 10)) {
      try {
        const gameData = await c.env.BC_GAME_KV.get(`game:${gameNumber}`);
        if (gameData) {
          history.push(JSON.parse(gameData));
        }
      } catch (e) {
        console.error(`Failed to get game ${gameNumber}:`, e);
      }
    }

    return c.json({
      success: true,
      history,
      total: latestGames.length
    });
  } catch (error) {
    console.error('Game history error:', error);
    return c.json({
      error: 'Failed to get game history',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 获取指定游戏详情 API
app.get('/game-detail/:gameNumber', async (c) => {
  try {
    const gameNumber = c.req.param('gameNumber');
    const gameData = await c.env.BC_GAME_KV.get(`game:${gameNumber}`);

    if (!gameData) {
      return c.json({ success: false, error: 'Game not found' });
    }

    const game: GameRecord = JSON.parse(gameData);
    return c.json({
      success: true,
      game
    });
  } catch (error) {
    console.error('Game detail error:', error);
    return c.json({
      error: 'Failed to get game detail',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 自动开始游戏 API
app.post('/auto-game/:chatId', async (c) => {
  const token = c.env.BOT_TOKEN;
  if (!token) {
    return c.json({ error: 'BOT_TOKEN not configured' }, 500);
  }

  try {
    const chatId = c.req.param('chatId');
    const roomId = c.env.GAME_ROOMS.idFromName(chatId);
    const room = c.env.GAME_ROOMS.get(roomId);

    const response = await room.fetch(new Request('https://game.room/start-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId })
    }));

    const result = await response.json() as any;

    if (result.success) {
      const bot = new Bot(token);
      await bot.api.sendMessage(chatId,
        `🎲 **自动游戏 - 第 ${result.gameNumber} 局开始！**\n\n` +
        `💰 下注时间：30秒\n` +
        `📝 下注格式：/bet banker 100\n` +
        `⏰ 30秒后将自动处理游戏...`,
        { parse_mode: 'Markdown' }
      );

      return c.json({
        success: true,
        gameNumber: result.gameNumber,
        chatId,
        bettingEndTime: result.bettingEndTime,
        message: 'Auto game started'
      });
    } else {
      return c.json({ error: result.error }, 400);
    }
  } catch (error) {
    console.error('Auto game error:', error);
    return c.json({
      error: 'Failed to start auto game',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 启用自动游戏 API
app.post('/enable-auto/:chatId', async (c) => {
  try {
    const chatId = c.req.param('chatId');
    const roomId = c.env.GAME_ROOMS.idFromName(chatId);
    const room = c.env.GAME_ROOMS.get(roomId);

    const response = await room.fetch(new Request('https://game.room/enable-auto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId })
    }));

    return response;
  } catch (error) {
    console.error('Enable auto error:', error);
    return c.json({
      error: 'Failed to enable auto game',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 禁用自动游戏 API
app.post('/disable-auto/:chatId', async (c) => {
  try {
    const chatId = c.req.param('chatId');
    const roomId = c.env.GAME_ROOMS.idFromName(chatId);
    const room = c.env.GAME_ROOMS.get(roomId);

    const response = await room.fetch(new Request('https://game.room/disable-auto', {
      method: 'POST'
    }));

    return response;
  } catch (error) {
    console.error('Disable auto error:', error);
    return c.json({
      error: 'Failed to disable auto game',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 处理游戏 API
app.post('/process-game/:chatId', async (c) => {
  const token = c.env.BOT_TOKEN;
  if (!token) {
    return c.json({ error: 'BOT_TOKEN not configured' }, 500);
  }

  try {
    const chatId = c.req.param('chatId');
    const roomId = c.env.GAME_ROOMS.idFromName(chatId);
    const room = c.env.GAME_ROOMS.get(roomId);

    const response = await room.fetch(new Request('https://game.room/process-game', {
      method: 'POST'
    }));

    const result = await response.json() as any;

    if (result.success) {
      return c.json({
        success: true,
        message: 'Game processed successfully'
      });
    } else {
      return c.json({ error: result.error }, 400);
    }
  } catch (error) {
    console.error('Process game error:', error);
    return c.json({
      error: 'Failed to process game',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 获取游戏状态 API
app.get('/game-status/:chatId', async (c) => {
  try {
    const chatId = c.req.param('chatId');
    const roomId = c.env.GAME_ROOMS.idFromName(chatId);
    const room = c.env.GAME_ROOMS.get(roomId);

    const response = await room.fetch('https://game.room/get-status');
    const result = await response.json() as any;

    return c.json(result);
  } catch (error) {
    console.error('Game status error:', error);
    return c.json({
      error: 'Failed to get game status',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 手动发送消息 API
app.post('/send-message', async (c) => {
  const token = c.env.BOT_TOKEN;
  if (!token) {
    return c.json({ error: 'BOT_TOKEN not configured' }, 500);
  }

  try {
    const { chatId, message, parseMode } = await c.req.json();

    if (!chatId || !message) {
      return c.json({ error: 'chatId and message are required' }, 400);
    }

    const allowedChatIds = c.env.ALLOWED_CHAT_IDS?.split(',').map(id => id.trim());
    if (allowedChatIds && !allowedChatIds.includes(chatId.toString())) {
      return c.json({ error: 'Chat ID not allowed' }, 403);
    }

    const bot = new Bot(token);
    const result = await bot.api.sendMessage(chatId, message, {
      parse_mode: parseMode || undefined
    });

    return c.json({
      success: true,
      messageId: result.message_id,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Send message error:', error);
    return c.json({
      error: 'Failed to send message',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 设置 webhook API
app.post('/set-webhook', async (c) => {
  const token = c.env.BOT_TOKEN;
  if (!token) {
    return c.json({ error: 'BOT_TOKEN not configured' }, 500);
  }

  try {
    const { url } = await c.req.json();
    if (!url) {
      return c.json({ error: 'webhook url is required' }, 400);
    }

    const bot = new Bot(token);
    await bot.api.setWebhook(url);

    return c.json({
      success: true,
      message: 'Webhook set successfully',
      url
    });
  } catch (error) {
    console.error('Set webhook error:', error);
    return c.json({
      error: 'Failed to set webhook',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

export default app;
export { BaccaratGameRoom } from './baccaratGameRoom';
