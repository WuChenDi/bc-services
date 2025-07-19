import { Bot } from 'grammy';
import { BetType, Env, GameData, GameState, GameRecord } from './types';

export class BaccaratGameRoom {
  private state: DurableObjectState;
  private env: Env;
  private game: GameData | null = null;
  private timers: Set<any> = new Set(); // 管理所有定时器
  private autoGameEnabled: boolean = false; // 自动游戏开关

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      // 从存储中恢复游戏状态
      if (!this.game) {
        this.game = await this.state.storage.get('game') || null;
        this.autoGameEnabled = await this.state.storage.get('autoGame') || false;
      }

      switch (url.pathname) {
        case '/start-game':
          return this.handleStartGame(request);
        case '/place-bet':
          return this.handlePlaceBet(request);
        case '/process-game':
          return this.handleProcessGame();
        case '/get-status':
          return this.handleGetStatus();
        case '/stop-game':
          return this.handleStopGame();
        case '/enable-auto':
          return this.handleEnableAuto(request);
        case '/disable-auto':
          return this.handleDisableAuto();
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('DO request error:', error);
      return new Response(`Internal Error: ${error}`, { status: 500 });
    }
  }

  async handleStartGame(request: Request): Promise<Response> {
    if (this.game && this.game.state !== GameState.Finished) {
      return Response.json({
        success: false,
        error: 'Game already in progress'
      });
    }

    try {
      const { chatId } = await request.json();
      if (!chatId) {
        return Response.json({ success: false, error: 'chatId is required' });
      }

      // 清理旧定时器
      this.clearAllTimers();

      const gameNumber = this.generateGameNumber();
      const now = Date.now();

      this.game = {
        gameNumber,
        state: GameState.Betting,
        bets: {},
        cards: { banker: [], player: [] },
        result: { banker: 0, player: 0, winner: null },
        startTime: now,
        bettingEndTime: now + 30000,
        chatId
      };

      await this.state.storage.put('game', this.game);

      // 设置定时器
      this.setupCountdownTimers(chatId, gameNumber);

      return Response.json({
        success: true,
        gameNumber,
        bettingEndTime: this.game.bettingEndTime
      });
    } catch (error) {
      console.error('Start game error:', error);
      return Response.json({
        success: false,
        error: 'Failed to start game'
      });
    }
  }

  // 启用自动游戏
  async handleEnableAuto(request: Request): Promise<Response> {
    try {
      const { chatId } = await request.json();
      if (!chatId) {
        return Response.json({ success: false, error: 'chatId is required' });
      }

      this.autoGameEnabled = true;
      await this.state.storage.put('autoGame', true);

      // 如果当前没有游戏，立即开始一局
      if (!this.game || this.game.state === GameState.Finished) {
        await this.startAutoGame(chatId);
      }

      return Response.json({ success: true, message: 'Auto game enabled' });
    } catch (error) {
      console.error('Enable auto error:', error);
      return Response.json({ success: false, error: 'Failed to enable auto game' });
    }
  }

  // 禁用自动游戏
  async handleDisableAuto(): Promise<Response> {
    try {
      this.autoGameEnabled = false;
      await this.state.storage.put('autoGame', false);

      return Response.json({ success: true, message: 'Auto game disabled' });
    } catch (error) {
      console.error('Disable auto error:', error);
      return Response.json({ success: false, error: 'Failed to disable auto game' });
    }
  }

  // 🔥 新增：开始自动游戏
  private async startAutoGame(chatId: string) {
    try {
      const gameNumber = this.generateGameNumber();
      const now = Date.now();

      this.game = {
        gameNumber,
        state: GameState.Betting,
        bets: {},
        cards: { banker: [], player: [] },
        result: { banker: 0, player: 0, winner: null },
        startTime: now,
        bettingEndTime: now + 30000,
        chatId
      };

      await this.state.storage.put('game', this.game);

      const bot = this.createBot();
      await bot.api.sendMessage(chatId,
        `🤖 **自动游戏 - 第 ${gameNumber} 局开始！**\n\n` +
        `💰 下注时间：30秒\n` +
        `📝 下注格式：/bet banker 100\n` +
        `⏰ 30秒后将自动处理游戏...\n` +
        `🔄 游戏将持续自动进行`,
        { parse_mode: 'Markdown' }
      );

      this.setupCountdownTimers(chatId, gameNumber);
    } catch (error) {
      console.error('Start auto game error:', error);
    }
  }

  // 🔥 修复定时器管理
  private setupCountdownTimers(chatId: string, gameNumber: string) {
    const intervals = [20, 10, 5];

    intervals.forEach(seconds => {
      const timer = setTimeout(async () => {
        if (this.game && this.game.state === GameState.Betting && this.game.gameNumber === gameNumber) {
          await this.sendCountdownMessage(chatId, seconds);
        }
      }, (30 - seconds) * 1000);
      this.timers.add(timer);
    });

    // 30秒后自动处理
    const autoProcessTimer = setTimeout(async () => {
      if (this.game && this.game.state === GameState.Betting && this.game.gameNumber === gameNumber) {
        await this.autoProcessGame(chatId);
      }
    }, 30000);
    this.timers.add(autoProcessTimer);
  }

  private async sendCountdownMessage(chatId: string, seconds: number) {
    try {
      const bot = this.createBot();
      const betsCount = this.game ? Object.keys(this.game.bets).length : 0;

      await bot.api.sendMessage(chatId,
        `⏰ **下注倒计时：${seconds}秒！**\n\n` +
        `👥 当前参与人数：${betsCount}\n` +
        `💡 抓紧时间下注哦~`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Send countdown message error:', error);
    }
  }

  private async autoProcessGame(chatId: string) {
    if (!this.game || this.game.state !== GameState.Betting) {
      return;
    }

    try {
      const bot = this.createBot();
      await bot.api.sendMessage(chatId,
        `⛔ **第 ${this.game.gameNumber} 局停止下注！**\n\n` +
        `🎲 开始自动处理游戏...`,
        { parse_mode: 'Markdown' }
      );

      await this.processGame(bot);
    } catch (error) {
      console.error('Auto process error:', error);
      try {
        await this.createBot().api.sendMessage(chatId,
          '❌ 自动处理游戏失败，请联系管理员'
        );
      } catch (e) {
        console.error('Failed to send error message:', e);
      }
    }
  }

  async handlePlaceBet(request: Request): Promise<Response> {
    if (!this.game || this.game.state !== GameState.Betting) {
      return Response.json({
        success: false,
        error: 'No active betting game'
      });
    }

    const now = Date.now();
    if (now > this.game.bettingEndTime) {
      return Response.json({
        success: false,
        error: 'Betting time ended'
      });
    }

    try {
      const { userId, userName, betType, amount } = await request.json();

      if (!Object.values(BetType).includes(betType) || amount <= 0 || !userId) {
        return Response.json({
          success: false,
          error: 'Invalid bet parameters'
        });
      }

      this.game.bets[userId] = { type: betType, amount, userName };
      await this.state.storage.put('game', this.game);

      const remainingTime = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));

      return Response.json({
        success: true,
        betType,
        amount,
        userName,
        remainingTime,
        totalBets: Object.keys(this.game.bets).length
      });
    } catch (error) {
      console.error('Place bet error:', error);
      return Response.json({
        success: false,
        error: 'Failed to place bet'
      });
    }
  }

  private async processGame(bot: Bot) {
    if (!this.game) return;

    try {
      this.game.state = GameState.Processing;
      await this.state.storage.put('game', this.game);

      // 清理定时器
      this.clearAllTimers();

      const betsCount = Object.keys(this.game.bets).length;

      // 即使没有人下注也继续游戏
      if (betsCount === 0) {
        await bot.api.sendMessage(this.game.chatId,
          `😔 **第 ${this.game.gameNumber} 局无人下注**\n\n` +
          `🎲 但游戏继续进行，开始发牌...`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await this.showBetSummary(bot);
        await this.sleep(3000);
      }

      await this.startRevealing(bot);
    } catch (error) {
      console.error('Process game error:', error);
      this.game.state = GameState.Betting;
      await this.state.storage.put('game', this.game);
      await bot.api.sendMessage(this.game.chatId,
        '❌ 处理游戏失败，请稍后再试'
      );
    }
  }

  // 使用 Telegram 骰子返回的点数
  private async rollDice(bot: Bot, chatId: string, playerType: string, cardIndex: number): Promise<number> {
    try {
      // 发送骰子，Telegram 会返回真实的点数
      const diceMessage = await bot.api.sendDice(chatId, '🎲');

      // 使用 Telegram 返回的真实点数
      const actualDiceValue = diceMessage.dice?.value;

      if (!actualDiceValue) {
        throw new Error('Failed to get dice value from Telegram');
      }

      // 等待骰子动画播放完毕
      await this.sleep(5000);

      // 发送确认消息，显示 Telegram 返回的真实点数
      await bot.api.sendMessage(chatId,
        `${playerType === 'banker' ? '🏦 庄家' : '👤 闲家'}第${cardIndex}张牌: **${actualDiceValue} 点**`,
        { parse_mode: 'Markdown' }
      );

      return actualDiceValue; // 返回 Telegram 的真实点数

    } catch (error) {
      console.error('Roll dice error:', error);
      // 只有在 API 完全失败时才使用备用方案
      await bot.api.sendMessage(chatId,
        '❌ 骰子发送失败，请重新开始游戏'
      );
      throw error; // 抛出错误，让游戏处理失败情况
    }
  }

  // 开牌流程完全依赖 Telegram 骰子
  private async startRevealing(bot: Bot) {
    if (!this.game) return;

    this.game.state = GameState.Revealing;
    await this.state.storage.put('game', this.game);

    await bot.api.sendMessage(this.game.chatId,
      `🎲 **开牌阶段开始！**\n\n` +
      `🃏 庄家和闲家各发两张牌...`,
      { parse_mode: 'Markdown' }
    );

    try {
      // 发前两张牌
      for (let i = 0; i < 2; i++) {
        await this.sleep(1000);

        // 庄家牌
        const bankerCard = await this.rollDice(bot, this.game.chatId, 'banker', i + 1);
        this.game.cards.banker.push(bankerCard);

        await this.sleep(1000);

        // 闲家牌
        const playerCard = await this.rollDice(bot, this.game.chatId, 'player', i + 1);
        this.game.cards.player.push(playerCard);
      }

      await this.state.storage.put('game', this.game);

      const bankerSum = this.calculatePoints(this.game.cards.banker);
      const playerSum = this.calculatePoints(this.game.cards.player);

      await this.sleep(2000);
      await bot.api.sendMessage(this.game.chatId,
        `📊 **前两张牌点数:**\n` +
        `🏦 庄家: ${this.game.cards.banker.join(' + ')} = **${bankerSum} 点**\n` +
        `👤 闲家: ${this.game.cards.player.join(' + ')} = **${playerSum} 点**`,
        { parse_mode: 'Markdown' }
      );

      await this.sleep(3000);

      if (bankerSum >= 8 || playerSum >= 8) {
        await bot.api.sendMessage(this.game.chatId,
          '🎯 **天牌！无需补牌！**',
          { parse_mode: 'Markdown' }
        );
      } else {
        await this.handleThirdCard(bot, bankerSum, playerSum);
      }

      await this.calculateResult(bot);

    } catch (error) {
      console.error('Revealing error:', error);
      await bot.api.sendMessage(this.game.chatId,
        '❌ 开牌过程失败，游戏终止。请使用 /newgame 重新开始'
      );
      await this.cleanupGame();
    }
  }

  // 补牌操作
  private async handleThirdCard(bot: Bot, bankerSum: number, playerSum: number) {
    if (!this.game) return;

    let playerThirdCard: number | null = null;

    if (playerSum <= 5) {
      await this.sleep(2000);
      await bot.api.sendMessage(this.game.chatId,
        '👤 **闲家需要补牌...**',
        { parse_mode: 'Markdown' }
      );
      await this.sleep(1000);

      playerThirdCard = await this.rollDice(bot, this.game.chatId, 'player', 3);
      this.game.cards.player.push(playerThirdCard);
    }

    let bankerNeedCard = false;
    if (playerThirdCard === null) {
      bankerNeedCard = bankerSum <= 5;
    } else {
      if (bankerSum <= 2) bankerNeedCard = true;
      else if (bankerSum === 3 && playerThirdCard !== 8) bankerNeedCard = true;
      else if (bankerSum === 4 && [2, 3, 4, 5, 6, 7].includes(playerThirdCard)) bankerNeedCard = true;
      else if (bankerSum === 5 && [4, 5, 6, 7].includes(playerThirdCard)) bankerNeedCard = true;
      else if (bankerSum === 6 && [6, 7].includes(playerThirdCard)) bankerNeedCard = true;
    }

    if (bankerNeedCard) {
      await this.sleep(2000);
      await bot.api.sendMessage(this.game.chatId,
        '🏦 **庄家需要补牌...**',
        { parse_mode: 'Markdown' }
      );
      await this.sleep(1000);

      const bankerThirdCard = await this.rollDice(bot, this.game.chatId, 'banker', 3);
      this.game.cards.banker.push(bankerThirdCard);
    }

    await this.state.storage.put('game', this.game);
  }

  private async calculateResult(bot: Bot) {
    if (!this.game) return;

    const bankerFinal = this.calculatePoints(this.game.cards.banker);
    const playerFinal = this.calculatePoints(this.game.cards.player);

    this.game.result.banker = bankerFinal;
    this.game.result.player = playerFinal;

    if (bankerFinal > playerFinal) {
      this.game.result.winner = BetType.Banker;
    } else if (playerFinal > bankerFinal) {
      this.game.result.winner = BetType.Player;
    } else {
      this.game.result.winner = BetType.Tie;
    }

    this.game.state = GameState.Finished;
    await this.state.storage.put('game', this.game);

    // 保存游戏记录到 KV
    await this.saveGameRecord();

    await this.sleep(3000);

    const winnerText = {
      [BetType.Banker]: '🏦 庄家胜！',
      [BetType.Player]: '👤 闲家胜！',
      [BetType.Tie]: '🤝 和局！'
    };

    let resultMessage = `🎯 **第 ${this.game.gameNumber} 局开牌结果**\n\n`;
    resultMessage += `🏦 庄家最终点数: ${bankerFinal} 点\n`;
    resultMessage += `👤 闲家最终点数: ${playerFinal} 点\n\n`;
    resultMessage += `🏆 **${winnerText[this.game.result.winner!]}**\n\n`;

    const winners: string[] = [];
    const losers: string[] = [];

    Object.entries(this.game.bets).forEach(([userId, bet]) => {
      if (bet.type === this.game!.result.winner) {
        const winAmount = bet.type === BetType.Tie ? bet.amount * 8 : bet.amount;
        winners.push(`${bet.userName}: +${winAmount}`);
      } else {
        losers.push(`${bet.userName}: -${bet.amount}`);
      }
    });

    if (winners.length > 0) {
      resultMessage += `✅ **获胜者:**\n${winners.join('\n')}\n\n`;
    }
    if (losers.length > 0) {
      resultMessage += `❌ **失败者:**\n${losers.join('\n')}\n\n`;
    }

    // 根据自动游戏状态显示不同信息
    if (this.autoGameEnabled) {
      resultMessage += `🔄 **自动游戏模式：10秒后开始下一局**`;

      // 10秒后自动开始下一局
      const nextGameTimer = setTimeout(async () => {
        if (this.autoGameEnabled) {
          await this.startAutoGame(this.game!.chatId);
        }
      }, 10000);
      this.timers.add(nextGameTimer);
    } else {
      resultMessage += `⏰ 游戏结束，使用 /newgame 开始下一局`;
    }

    await bot.api.sendMessage(this.game.chatId, resultMessage, { parse_mode: 'Markdown' });

    // 如果不是自动模式，30秒后清理数据
    if (!this.autoGameEnabled) {
      const cleanupTimer = setTimeout(async () => {
        await this.cleanupGame();
      }, 30000);
      this.timers.add(cleanupTimer);
    }
  }

  // 保存游戏记录到 KV
  private async saveGameRecord() {
    if (!this.game) return;

    try {
      const gameRecord: GameRecord = {
        gameNumber: this.game.gameNumber,
        startTime: this.game.startTime,
        endTime: Date.now(),
        chatId: this.game.chatId,
        bets: this.game.bets,
        cards: this.game.cards,
        result: this.game.result,
        totalBets: Object.keys(this.game.bets).length,
        totalAmount: Object.values(this.game.bets).reduce((sum, bet) => sum + bet.amount, 0)
      };

      // 保存到 KV，使用游戏编号作为 key
      await this.env.BC_GAME_KV.put(`game:${this.game.gameNumber}`, JSON.stringify(gameRecord));

      // 更新最新游戏列表（保留最近100局）
      const latestGamesKey = `latest_games:${this.game.chatId}`;
      let latestGames: string[] = [];

      try {
        const existing = await this.env.BC_GAME_KV.get(latestGamesKey);
        if (existing) {
          latestGames = JSON.parse(existing);
        }
      } catch (e) {
        console.error('Failed to get latest games:', e);
      }

      latestGames.unshift(this.game.gameNumber);
      if (latestGames.length > 100) {
        latestGames = latestGames.slice(0, 100);
      }

      await this.env.BC_GAME_KV.put(latestGamesKey, JSON.stringify(latestGames));

      console.log(`Game record saved: ${this.game.gameNumber}`);
    } catch (error) {
      console.error('Failed to save game record:', error);
    }
  }

  // 修复清理函数
  private async cleanupGame() {
    this.clearAllTimers();
    this.game = null;
    await this.state.storage.delete('game');
  }

  // 新增定时器管理
  private clearAllTimers() {
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
  }

  private createBot() {
    return new Bot(this.env.BOT_TOKEN);
  }

  private generateGameNumber(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0');
    const randomStr = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    return `${dateStr}${timeStr}${randomStr}`;
  }

  // 百家乐计分规则
  private calculatePoints(cards: number[]): number {
    // 在真正的百家乐中，10/J/Q/K 都算0点
    // 但我们用骰子(1-6)，所以直接相加然后取个位数
    return cards.reduce((sum, card) => sum + card, 0) % 10;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async showBetSummary(bot: Bot) {
    if (!this.game) return;

    const bets = Object.values(this.game.bets);
    const betSummary = bets.reduce((acc, bet) => {
      acc[bet.type] = (acc[bet.type] || 0) + bet.amount;
      return acc;
    }, {} as Record<BetType, number>);

    let message = `📋 **第 ${this.game.gameNumber} 局下注汇总**\n\n`;
    message += `👥 参与人数: ${bets.length}\n`;
    message += `💰 总下注: ${bets.reduce((sum, bet) => sum + bet.amount, 0)} 点\n\n`;
    message += `📊 **各项下注:**\n`;
    message += `🏦 庄家: ${betSummary[BetType.Banker] || 0} 点\n`;
    message += `👤 闲家: ${betSummary[BetType.Player] || 0} 点\n`;
    message += `🤝 和局: ${betSummary[BetType.Tie] || 0} 点\n\n`;
    message += `🎲 准备开牌...`;

    await bot.api.sendMessage(this.game.chatId, message, { parse_mode: 'Markdown' });
  }

  async handleGetStatus(): Promise<Response> {
    if (!this.game) {
      return Response.json({
        status: 'no_game',
        autoGameEnabled: this.autoGameEnabled
      });
    }

    const now = Date.now();
    const timeRemaining = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));

    return Response.json({
      gameNumber: this.game.gameNumber,
      state: this.game.state,
      betsCount: Object.keys(this.game.bets).length,
      bets: this.game.bets,
      timeRemaining: this.game.state === GameState.Betting ? timeRemaining : 0,
      result: this.game.result,
      needsProcessing: this.game.state === GameState.Betting && now >= this.game.bettingEndTime,
      autoGameEnabled: this.autoGameEnabled
    });
  }

  async handleProcessGame(): Promise<Response> {
    if (!this.game || this.game.state !== GameState.Betting) {
      return Response.json({
        success: false,
        error: 'No active betting game'
      });
    }

    try {
      const bot = this.createBot();
      await this.processGame(bot);
      return Response.json({ success: true });
    } catch (error) {
      console.error('Handle process game error:', error);
      return Response.json({
        success: false,
        error: 'Failed to process game'
      });
    }
  }

  async handleStopGame(): Promise<Response> {
    if (!this.game) {
      return Response.json({ success: true, message: 'No game to stop' });
    }

    try {
      const chatId = this.game.chatId;

      // 🔥 停止自动游戏
      this.autoGameEnabled = false;
      await this.state.storage.put('autoGame', false);

      await this.cleanupGame();

      await this.createBot().api.sendMessage(chatId,
        '🛑 游戏已停止，自动模式已关闭'
      );

      return Response.json({ success: true });
    } catch (error) {
      console.error('Handle stop game error:', error);
      return Response.json({
        success: false,
        error: 'Failed to stop game'
      });
    }
  }
}
