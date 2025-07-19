import { Bot } from 'grammy';
import {
  BetType,
  type Env,
  type GameData, GameState,
  type GameStatusResponse,
  type PlaceBetResponse,
  type StartGameResponse,
  type ApiResponse
} from '@/types';
import { StorageService, DiceService } from '@/services';
import { sleep, formatBetSummary, formatGameResult, calculatePoints } from '@/utils';
import { BETTING_DURATION_MS, AUTO_GAME_INTERVAL_MS } from '@/config/constants';

export class GameService {
  private game: GameData | null = null;
  private storage: StorageService;
  private diceService: DiceService;
  private timers: Set<number> = new Set();
  private isProcessing: boolean = false;

  constructor(
    private state: DurableObjectState,
    private env: Env,
    private bot: Bot
  ) {
    this.storage = new StorageService(env.BC_GAME_KV);
    this.diceService = new DiceService(bot);
  }

  async initialize(): Promise<void> {
    this.game = await this.state.storage.get('game') || null;

    if (this.game) {
      const now = Date.now();
      if (this.game.state === GameState.Betting && now > this.game.bettingEndTime + 10000) {
        console.log('Detected stuck betting game, auto-processing...');
        await this.processGame();
      } else if (this.game.state === GameState.Processing || this.game.state === GameState.Revealing) {
        console.log('Detected stuck processing/revealing game, cleaning up...');
        await this.cleanupGame();
      }
    }
  }

  async startGame(chatId: string): Promise<StartGameResponse> {
    if (this.game && this.game.state !== GameState.Finished) {
      return { success: false, error: 'Game already in progress' };
    }

    this.clearAllTimers();
    this.isProcessing = false;

    const gameNumber = this.generateGameNumber();
    const now = Date.now();

    this.game = {
      gameNumber,
      state: GameState.Betting,
      bets: {},
      cards: { banker: [], player: [] },
      result: { banker: 0, player: 0, winner: null },
      startTime: now,
      bettingEndTime: now + BETTING_DURATION_MS,
      chatId
    };

    await this.state.storage.put('game', this.game);
    this.setupCountdownTimers(chatId, gameNumber);

    return { success: true, gameNumber, bettingEndTime: this.game.bettingEndTime };
  }

  async placeBet(userId: string, userName: string, betType: BetType, amount: number): Promise<PlaceBetResponse> {
    if (!this.game || this.game.state !== GameState.Betting) {
      return { success: false, error: 'No active betting game' };
    }

    const now = Date.now();
    if (now > this.game.bettingEndTime) {
      return { success: false, error: 'Betting time ended' };
    }

    if (!Object.values(BetType).includes(betType) || amount <= 0 || !userId) {
      return { success: false, error: 'Invalid bet parameters' };
    }

    // 检查用户是否已经下注
    const existingBet = this.game.bets[userId];

    if (existingBet) {
      // 如果已有下注，检查是否是相同类型
      if (existingBet.type === betType) {
        const newAmount = existingBet.amount + amount;

        // 检查累加后是否超过限制
        if (newAmount > 10000) {
          return {
            success: false,
            error: `累加后金额${newAmount}点超过单次下注限制10000点\n当前已下注${existingBet.amount}点`
          };
        }

        this.game.bets[userId] = {
          type: betType,
          amount: newAmount,
          userName
        };

        await this.state.storage.put('game', this.game);

        const remainingTime = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));
        return {
          success: true,
          betType,
          amount: newAmount,
          userName,
          remainingTime,
          totalBets: Object.keys(this.game.bets).length,
          isAccumulated: true,
          previousAmount: existingBet.amount,
          addedAmount: amount
        };
      } else {
        this.game.bets[userId] = {
          type: betType,
          amount,
          userName
        };

        await this.state.storage.put('game', this.game);

        const remainingTime = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));
        return {
          success: true,
          betType,
          amount,
          userName,
          remainingTime,
          totalBets: Object.keys(this.game.bets).length,
          // 🔥 添加替换信息
          isReplaced: true,
          previousBetType: existingBet.type,
          previousAmount: existingBet.amount
        };
      }
    } else {
      if (amount > 10000) {
        return { success: false, error: '单次下注金额不能超过10000点' };
      }

      this.game.bets[userId] = { type: betType, amount, userName };
      await this.state.storage.put('game', this.game);

      const remainingTime = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));
      return {
        success: true,
        betType,
        amount,
        userName,
        remainingTime,
        totalBets: Object.keys(this.game.bets).length
      };
    }
  }

  async processGame(): Promise<void> {
    if (!this.game || this.game.state !== GameState.Betting) return;

    if (this.isProcessing) {
      console.log('Game is already being processed, skipping...');
      return;
    }

    this.isProcessing = true;

    try {
      this.game.state = GameState.Processing;
      await this.state.storage.put('game', this.game);
      this.clearAllTimers();

      const betsCount = Object.keys(this.game.bets).length;
      if (betsCount === 0) {
        await this.bot.api.sendMessage(this.game.chatId,
          `😔 **第 ${this.game.gameNumber} 局无人下注**\n\n` +
          `🎲 但游戏继续进行，开始发牌...`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await this.showBetSummary();
        await sleep(3000);
      }

      await this.startRevealing();
    } catch (error) {
      console.error('Process game error:', error);
      this.isProcessing = false;
      await this.cleanupGame();
    }
  }

  private async startRevealing(): Promise<void> {
    if (!this.game) return;

    try {
      this.game.state = GameState.Revealing;
      await this.state.storage.put('game', this.game);

      await this.bot.api.sendMessage(this.game.chatId,
        `🎲 **开牌阶段开始！**\n\n` +
        `🃏 庄家和闲家各发两张牌...`,
        { parse_mode: 'Markdown' }
      );

      const revealingTimeout = setTimeout(async () => {
        console.log('Revealing timeout, cleaning up game...');
        await this.cleanupGame();
      }, 60000);

      try {
        for (let i = 0; i < 2; i++) {
          await sleep(1000);
          const bankerCard = await this.diceService.rollDice(this.game.chatId, 'banker', i + 1);
          this.game.cards.banker.push(bankerCard);

          await sleep(1000);
          const playerCard = await this.diceService.rollDice(this.game.chatId, 'player', i + 1);
          this.game.cards.player.push(playerCard);
        }

        clearTimeout(revealingTimeout);
        await this.state.storage.put('game', this.game);

        const bankerSum = calculatePoints(this.game.cards.banker);
        const playerSum = calculatePoints(this.game.cards.player);

        await sleep(2000);
        await this.bot.api.sendMessage(this.game.chatId,
          `📊 **前两张牌点数:**\n` +
          `🏦 庄家: ${this.game.cards.banker.join(' + ')} = **${bankerSum} 点**\n` +
          `👤 闲家: ${this.game.cards.player.join(' + ')} = **${playerSum} 点**`,
          { parse_mode: 'Markdown' }
        );

        await sleep(3000);

        if (bankerSum >= 8 || playerSum >= 8) {
          await this.bot.api.sendMessage(this.game.chatId,
            '🎯 **天牌！无需补牌！**',
            { parse_mode: 'Markdown' }
          );
        } else {
          await this.handleThirdCard(bankerSum, playerSum);
        }

        await this.calculateResult();
      } catch (revealError) {
        clearTimeout(revealingTimeout);
        throw revealError;
      }
    } catch (error) {
      console.error('Revealing error:', error);
      await this.bot.api.sendMessage(this.game.chatId,
        '❌ 开牌过程失败，游戏终止。请使用 /newgame 重新开始'
      );
      await this.cleanupGame();
    }
  }

  private async handleThirdCard(bankerSum: number, playerSum: number): Promise<void> {
    if (!this.game) return;

    let playerThirdCard: number | null = null;

    if (playerSum <= 5) {
      await sleep(2000);
      await this.bot.api.sendMessage(this.game.chatId,
        '👤 **闲家需要补牌...**',
        { parse_mode: 'Markdown' }
      );
      await sleep(1000);

      playerThirdCard = await this.diceService.rollDice(this.game.chatId, 'player', 3);
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
      await sleep(2000);
      await this.bot.api.sendMessage(this.game.chatId,
        '🏦 **庄家需要补牌...**',
        { parse_mode: 'Markdown' }
      );
      await sleep(1000);

      const bankerThirdCard = await this.diceService.rollDice(this.game.chatId, 'banker', 3);
      this.game.cards.banker.push(bankerThirdCard);
    }

    await this.state.storage.put('game', this.game);
  }

  private async calculateResult(): Promise<void> {
    if (!this.game) return;

    try {
      const bankerFinal = calculatePoints(this.game.cards.banker);
      const playerFinal = calculatePoints(this.game.cards.player);

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

      try {
        await this.storage.saveGameRecord(this.game);
      } catch (saveError) {
        console.error('Failed to save game record, but continuing...', saveError);
      }

      await sleep(3000);

      try {
        await this.bot.api.sendMessage(this.game.chatId, formatGameResult(this.game), { parse_mode: 'Markdown' });
      } catch (msgError) {
        console.error('Failed to send result message:', msgError);
      }

      this.isProcessing = false;

      try {
        const autoGameEnabled = await this.state.storage.get('autoGame');
        if (autoGameEnabled) {
          const nextGameTimer = setTimeout(async () => {
            try {
              const stillAutoEnabled = await this.state.storage.get('autoGame');
              if (stillAutoEnabled && this.game) {
                await this.startAutoGame(this.game.chatId);
              }
            } catch (autoError) {
              console.error('Auto game error:', autoError);
              await this.cleanupGame();
            }
          }, AUTO_GAME_INTERVAL_MS);
          this.timers.add(nextGameTimer);
        } else {
          const cleanupTimer = setTimeout(async () => {
            await this.cleanupGame();
          }, 30000);
          this.timers.add(cleanupTimer);
        }
      } catch (autoCheckError) {
        console.error('Failed to check auto game status:', autoCheckError);
        await this.cleanupGame();
      }
    } catch (error) {
      console.error('Calculate result error:', error);
      this.isProcessing = false;
      await this.cleanupGame();
    }
  }

  async startAutoGame(chatId: string): Promise<void> {
    try {
      const result = await this.startGame(chatId);
      if (result.success) {
        await this.bot.api.sendMessage(chatId,
          `🤖 **自动游戏 - 第 ${result.gameNumber} 局开始！**\n\n` +
          `💰 下注时间：30秒\n` +
          `📝 下注格式：/bet banker 100\n` +
          `⏰ 30秒后将自动处理游戏...\n` +
          `🔄 游戏将持续自动进行`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (error) {
      console.error('Start auto game error:', error);
      await this.cleanupGame();
    }
  }

  async enableAutoGame(chatId: string): Promise<ApiResponse> {
    await this.state.storage.put('autoGame', true);
    if (!this.game || this.game.state === GameState.Finished) {
      await this.startAutoGame(chatId);
    }
    return { success: true, message: 'Auto game enabled' };
  }

  async disableAutoGame(): Promise<ApiResponse> {
    await this.state.storage.put('autoGame', false);
    this.clearAllTimers();
    return { success: true, message: 'Auto game disabled' };
  }

  private async showBetSummary(): Promise<void> {
    if (!this.game) return;
    try {
      await this.bot.api.sendMessage(this.game.chatId, formatBetSummary(this.game), { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Failed to show bet summary:', error);
    }
  }

  private setupCountdownTimers(chatId: string, gameNumber: string): void {
    const intervals = [20, 10, 5];

    intervals.forEach(seconds => {
      const timer = setTimeout(async () => {
        try {
          if (this.game && this.game.state === GameState.Betting && this.game.gameNumber === gameNumber) {
            await this.bot.api.sendMessage(chatId,
              `⏰ **下注倒计时：${seconds}秒！**\n\n` +
              `👥 当前参与人数：${Object.keys(this.game.bets).length}\n` +
              `💡 抓紧时间下注哦~`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (error) {
          console.error('Countdown message error:', error);
        }
      }, (30 - seconds) * 1000);
      this.timers.add(timer);
    });

    const autoProcessTimer = setTimeout(async () => {
      try {
        if (this.game && this.game.state === GameState.Betting && this.game.gameNumber === gameNumber) {
          await this.bot.api.sendMessage(chatId,
            `⛔ **第 ${this.game.gameNumber} 局停止下注！**\n\n` +
            `🎲 开始自动处理游戏...`,
            { parse_mode: 'Markdown' }
          );
          await this.processGame();
        }
      } catch (error) {
        console.error('Auto process timer error:', error);
        await this.cleanupGame();
      }
    }, BETTING_DURATION_MS);
    this.timers.add(autoProcessTimer);
  }

  async cleanupGame(): Promise<void> {
    try {
      this.clearAllTimers();
      this.isProcessing = false;
      this.game = null;
      await this.state.storage.delete('game');
      console.log('Game cleaned up successfully');
    } catch (error) {
      console.error('Cleanup game error:', error);
    }
  }

  private clearAllTimers(): void {
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
  }

  private generateGameNumber(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0');
    const randomStr = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    return `${dateStr}${timeStr}${randomStr}`;
  }

  async getGameStatus(): Promise<GameStatusResponse> {
    try {
      const autoGameEnabled = Boolean(await this.state.storage.get('autoGame'));

      if (!this.game) {
        return { status: 'no_game', autoGameEnabled };
      }

      const now = Date.now();
      const timeRemaining = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));

      return {
        gameNumber: this.game.gameNumber,
        state: this.game.state,
        betsCount: Object.keys(this.game.bets).length,
        bets: this.game.bets,
        timeRemaining: this.game.state === GameState.Betting ? timeRemaining : 0,
        result: this.game.result,
        needsProcessing: this.game.state === GameState.Betting && now >= this.game.bettingEndTime,
        autoGameEnabled
      };
    } catch (error) {
      console.error('Get game status error:', error);
      return { status: 'error', autoGameEnabled: false };
    }
  }
}
