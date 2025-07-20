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
import { getConstants, type Constants } from '@/config/constants';
import { MessageQueueService } from './messageQueue';

export class GameService {
  private game: GameData | null = null;
  private storage: StorageService;
  private diceService: DiceService;
  private messageQueue: MessageQueueService;
  private timers: Map<string, number> = new Map();
  private isProcessing: boolean = false;
  private gameCleanupScheduled: boolean = false;
  private revealingInProgress: boolean = false;
  private constants: Constants;

  constructor(
    private state: DurableObjectState,
    private env: Env,
    private bot: Bot
  ) {
    this.storage = new StorageService(env.BC_GAME_KV);
    this.diceService = new DiceService(bot, env);
    this.messageQueue = this.diceService.getMessageQueue(); // 共享消息队列
    this.constants = getConstants(env);
  }

  async initialize() {
    try {
      this.game = await this.state.storage.get('game') || null;

      if (this.game) {
        const now = Date.now();
        console.log(`Initializing with game state: ${this.game.state}, gameNumber: ${this.game.gameNumber}`);

        // 清理消息队列，避免旧消息干扰
        this.messageQueue.clearQueue();

        if (this.game.state === GameState.Betting) {
          if (now > this.game.bettingEndTime + 30000) {
            console.log('Detected stuck betting game, auto-processing...');
            await this.safeProcessGame();
          } else {
            console.log('Restoring betting timers...');
            this.setupCountdownTimers(this.game.chatId, this.game.gameNumber);
          }
        } else if (this.game.state === GameState.Processing || this.game.state === GameState.Revealing) {
          console.log('Detected stuck processing/revealing game, cleaning up...');
          await this.safeCleanupGame('Game was stuck in processing/revealing state');
        }
      }
    } catch (error) {
      console.error('Initialize error:', error);
      await this.safeCleanupGame('Initialization error');
    }
  }

  async startGame(chatId: string): Promise<StartGameResponse> {
    try {
      if (this.game && this.game.state !== GameState.Finished) {
        console.log(`Game already in progress: ${this.game.state}`);
        return { success: false, error: 'Game already in progress' };
      }

      await this.safeCleanupGame('Starting new game');
      this.resetAllFlags();

      const gameNumber = this.generateGameNumber();
      const now = Date.now();

      this.game = {
        gameNumber,
        state: GameState.Betting,
        bets: {},
        cards: { banker: [], player: [] },
        result: { banker: 0, player: 0, winner: null },
        startTime: now,
        bettingEndTime: now + this.constants.BETTING_DURATION_MS,
        chatId
      };

      await this.state.storage.put('game', this.game);
      console.log(`Game ${gameNumber} started successfully`);

      this.setupCountdownTimers(chatId, gameNumber);

      return { success: true, gameNumber, bettingEndTime: this.game.bettingEndTime };
    } catch (error) {
      console.error('Start game error:', error);
      await this.safeCleanupGame('Start game failed');
      return { success: false, error: 'Failed to start game' };
    }
  }

  async placeBet(userId: string, userName: string, betType: BetType, amount: number): Promise<PlaceBetResponse> {
    try {
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

      if (amount > 10000) {
        return { success: false, error: '单次下注金额不能超过10000点' };
      }

      if (!this.game.bets[userId]) {
        this.game.bets[userId] = { userName };
      }

      const userBets = this.game.bets[userId];
      const existingBetAmount = (userBets as any)[betType] || 0;

      const newAmount = existingBetAmount + amount;
      if (newAmount > 10000) {
        return {
          success: false,
          error: `${betType}累加后金额${newAmount}点超过单次下注限制10000点\n当前已下注${existingBetAmount}点`
        };
      }

      const totalUserBets = Object.entries(userBets).reduce((sum: number, [key, value]) => {
        if (key !== 'userName' && typeof value === 'number') {
          return sum + value;
        }
        return sum;
      }, 0);

      if (totalUserBets + amount > 50000) {
        return {
          success: false,
          error: `总下注金额不能超过50000点\n当前总下注：${totalUserBets}点`
        };
      }

      (userBets as any)[betType] = newAmount;
      userBets.userName = userName;

      await this.state.storage.put('game', this.game);

      const remainingTime = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));
      const totalUsers = Object.keys(this.game.bets).length;

      if (existingBetAmount > 0) {
        return {
          success: true,
          betType,
          amount: newAmount,
          userName,
          remainingTime,
          totalBets: totalUsers,
          isAccumulated: true,
          previousAmount: existingBetAmount,
          addedAmount: amount
        };
      } else {
        return {
          success: true,
          betType,
          amount: newAmount,
          userName,
          remainingTime,
          totalBets: totalUsers
        };
      }
    } catch (error) {
      console.error('Place bet error:', error);
      return { success: false, error: 'Failed to place bet' };
    }
  }

  async processGame(): Promise<void> {
    await this.safeProcessGame();
  }

  private async safeProcessGame(): Promise<void> {
    if (!this.game || this.game.state !== GameState.Betting) {
      console.log('No game to process or game not in betting state');
      return;
    }

    if (this.isProcessing) {
      console.log('Game is already being processed, skipping...');
      return;
    }

    console.log(`Starting to process game ${this.game.gameNumber}`);
    this.isProcessing = true;

    const globalTimeoutId = setTimeout(async () => {
      console.error('Game processing global timeout, forcing cleanup...');
      await this.forceCleanupGame('Global processing timeout');
    }, this.constants.GLOBAL_PROCESS_TIMEOUT_MS);

    try {
      this.game.state = GameState.Processing;
      await this.state.storage.put('game', this.game);
      this.clearAllTimers();

      const betsCount = Object.keys(this.game.bets).length;

      // 使用消息队列发送消息，确保顺序
      if (betsCount === 0) {
        this.messageQueue.enqueueMessage(
          this.game.chatId,
          `😔 **第 ${this.game.gameNumber} 局无人下注**\n\n🎲 但游戏继续进行，开始发牌...`,
          1 // 高优先级
        );
      } else {
        this.messageQueue.enqueueMessage(
          this.game.chatId,
          formatBetSummary(this.game),
          1 // 高优先级
        );
      }

      // 等待一下让消息发送完成
      await sleep(2000);

      await this.startRevealing();
      clearTimeout(globalTimeoutId);
    } catch (error) {
      clearTimeout(globalTimeoutId);
      console.error('Process game error:', error);
      await this.forceCleanupGame('Process game error');
    }
  }

  private async startRevealing(): Promise<void> {
    if (!this.game || this.revealingInProgress) {
      console.log('No game or revealing already in progress');
      return;
    }

    try {
      console.log(`Starting revealing phase for game ${this.game.gameNumber}`);
      this.revealingInProgress = true;
      this.game.state = GameState.Revealing;
      await this.state.storage.put('game', this.game);

      // 使用消息队列发送开牌消息
      this.messageQueue.enqueueMessage(
        this.game.chatId,
        `🎲 **开牌阶段开始！**\n\n🃏 庄家和闲家各发两张牌...`,
        1 // 高优先级
      );

      await this.dealCards();
      await this.calculateAndSendResult();
    } catch (error) {
      console.error('Revealing error:', error);
      this.messageQueue.enqueueMessage(
        this.game.chatId,
        '❌ 开牌过程失败，游戏终止。请使用 /newgame 重新开始',
        1 // 高优先级
      );
      await this.forceCleanupGame('Revealing error');
    } finally {
      this.revealingInProgress = false;
    }
  }

  private async dealCards(): Promise<void> {
    if (!this.game) return;

    console.log('Starting card dealing...');

    try {
      // 前两张牌 - 使用消息队列确保顺序
      for (let i = 0; i < 2; i++) {
        const bankerCard = await this.diceService.rollDice(this.game.chatId, 'banker', i + 1);
        this.game.cards.banker.push(bankerCard);

        const playerCard = await this.diceService.rollDice(this.game.chatId, 'player', i + 1);
        this.game.cards.player.push(playerCard);
      }

      await this.state.storage.put('game', this.game);

      const bankerSum = calculatePoints(this.game.cards.banker);
      const playerSum = calculatePoints(this.game.cards.player);

      // 使用消息队列发送点数汇总
      this.messageQueue.enqueueMessage(
        this.game.chatId,
        `📊 **前两张牌点数:**\n` +
        `🏦 庄家: ${this.game.cards.banker.join(' + ')} = **${bankerSum} 点**\n` +
        `👤 闲家: ${this.game.cards.player.join(' + ')} = **${playerSum} 点**`,
        2 // 中高优先级
      );

      // 判断是否需要补牌
      if (bankerSum >= 8 || playerSum >= 8) {
        this.messageQueue.enqueueMessage(
          this.game.chatId,
          '🎯 **天牌！无需补牌！**',
          2
        );
      } else {
        await this.handleThirdCard(bankerSum, playerSum);
      }
    } catch (error) {
      console.error('Deal cards error:', error);
      throw error;
    }
  }

  private async handleThirdCard(bankerSum: number, playerSum: number): Promise<void> {
    if (!this.game) return;

    try {
      let playerThirdCard: number | null = null;

      // 闲家补牌逻辑
      if (playerSum <= 5) {
        this.messageQueue.enqueueMessage(
          this.game.chatId,
          '👤 **闲家需要补牌...**',
          2
        );
        
        // 等待消息发送
        await sleep(1000);
        
        playerThirdCard = await this.diceService.rollDice(this.game.chatId, 'player', 3);
        this.game.cards.player.push(playerThirdCard);
      }

      // 庄家补牌逻辑
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
        this.messageQueue.enqueueMessage(
          this.game.chatId,
          '🏦 **庄家需要补牌...**',
          2
        );
        
        // 等待消息发送
        await sleep(1000);
        
        const bankerThirdCard = await this.diceService.rollDice(this.game.chatId, 'banker', 3);
        this.game.cards.banker.push(bankerThirdCard);
      }

      await this.state.storage.put('game', this.game);
    } catch (error) {
      console.error('Handle third card error:', error);
      throw error;
    }
  }

  private async calculateAndSendResult(): Promise<void> {
    if (!this.game) return;

    try {
      console.log(`Calculating result for game ${this.game.gameNumber}`);

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

      // 异步保存游戏记录
      this.saveGameRecordAsync();

      // 使用消息队列发送最终结果
      const autoGameEnabled = Boolean(await this.state.storage.get('autoGame'));
      this.messageQueue.enqueueMessage(
        this.game.chatId,
        formatGameResult(this.game, {
          isAutoGameEnabled: autoGameEnabled,
          nextGameDelaySeconds: this.constants.AUTO_GAME_INTERVAL_MS / 1000
        }),
        1 // 最高优先级
      );

      this.isProcessing = false;
      
      // 等待消息发送完成再处理游戏完成逻辑
      await sleep(3000);
      await this.handleGameCompletion();
    } catch (error) {
      console.error('Calculate and send result error:', error);
      await this.forceCleanupGame('Calculate result error');
    }
  }

  private async saveGameRecordAsync(): Promise<void> {
    if (!this.game) return;

    try {
      await this.storage.saveGameRecord(this.game);
      console.log(`Game record saved for ${this.game.gameNumber}`);
    } catch (saveError) {
      console.error('Failed to save game record:', saveError);
    }
  }

  private async handleGameCompletion(): Promise<void> {
    if (!this.game) return;

    try {
      const autoGameEnabled = await this.state.storage.get('autoGame');
      console.log(`Game completed, auto game enabled: ${autoGameEnabled}`);

      if (autoGameEnabled) {
        const nextGameTimer = setTimeout(async () => {
          try {
            console.log('Starting next auto game...');
            const stillAutoEnabled = await this.state.storage.get('autoGame');
            if (stillAutoEnabled && this.game) {
              await this.startAutoGame(this.game.chatId);
            } else {
              console.log('Auto game disabled or no game, cleaning up...');
              await this.safeCleanupGame('Auto game disabled');
            }
          } catch (autoError) {
            console.error('Auto game error:', autoError);
            await this.safeCleanupGame('Auto game error');
          }
        }, this.constants.AUTO_GAME_INTERVAL_MS);

        this.timers.set('nextGame', nextGameTimer);
        console.log('Next auto game scheduled');
      } else {
        const cleanupTimer = setTimeout(async () => {
          await this.safeCleanupGame('Manual cleanup after game finished');
        }, this.constants.CLEANUP_DELAY_MS);

        this.timers.set('cleanup', cleanupTimer);
        console.log('Game cleanup scheduled');
      }
    } catch (error) {
      console.error('Handle game completion error:', error);
      await this.safeCleanupGame('Game completion error');
    }
  }

  async startAutoGame(chatId: string): Promise<void> {
    try {
      console.log(`Starting auto game for chatId: ${chatId}`);
      const result = await this.startGame(chatId);

      if (result.success) {
        // 使用消息队列发送自动游戏开始消息
        this.messageQueue.enqueueMessage(
          chatId,
          `🤖 **自动游戏 - 第 ${result.gameNumber} 局开始！**\n\n` +
          `💰 下注时间：30秒\n` +
          `📝 下注格式：/bet banker 100\n` +
          `⏰ 30秒后将自动处理游戏...\n` +
          `🔄 游戏将持续自动进行`,
          1 // 高优先级
        );
      } else {
        console.error('Failed to start auto game:', result.error);
        await this.safeCleanupGame('Auto game start failed');
      }
    } catch (error) {
      console.error('Start auto game error:', error);
      await this.safeCleanupGame('Start auto game error');
    }
  }

  async enableAutoGame(chatId: string): Promise<ApiResponse> {
    try {
      await this.state.storage.put('autoGame', true);
      console.log('Auto game enabled');

      if (!this.game || this.game.state === GameState.Finished) {
        await this.startAutoGame(chatId);
      }

      return { success: true, message: 'Auto game enabled' };
    } catch (error) {
      console.error('Enable auto game error:', error);
      return { success: false, error: 'Failed to enable auto game' };
    }
  }

  async disableAutoGame(): Promise<ApiResponse> {
    try {
      await this.state.storage.put('autoGame', false);
      this.clearAllTimers();
      // 清空消息队列，停止所有待处理的消息
      this.messageQueue.clearQueue();
      console.log('Auto game disabled and message queue cleared');
      return { success: true, message: 'Auto game disabled' };
    } catch (error) {
      console.error('Disable auto game error:', error);
      return { success: false, error: 'Failed to disable auto game' };
    }
  }

  private setupCountdownTimers(chatId: string, gameNumber: string): void {
    console.log(`Setting up countdown timers for game ${gameNumber}`);

    this.clearAllTimers();

    // 使用消息队列发送倒计时消息
    const sendCountdownMessage = (remainingSeconds: number) => {
      if (this.game && this.game.state === GameState.Betting && this.game.gameNumber === gameNumber) {
        this.messageQueue.enqueueMessage(
          chatId,
          `⏰ **下注倒计时：${remainingSeconds}秒！**\n\n` +
          `👥 当前参与人数：${Object.keys(this.game.bets).length}\n` +
          `💡 抓紧时间下注哦~`,
          2 // 中高优先级
        );
      }
    };

    if (this.game) {
      const gameEndTime = this.game.bettingEndTime;
      const intervals = [20, 10, 5];

      intervals.forEach(seconds => {
        const reminderTime = gameEndTime - (seconds * 1000);
        const timeToReminder = reminderTime - Date.now();

        if (timeToReminder > 0) {
          const timerId = `countdown_${seconds}`;
          const timer = setTimeout(() => {
            sendCountdownMessage(seconds);
          }, timeToReminder);

          this.timers.set(timerId, timer);
        }
      });

      // 游戏结束处理
      const timeToGameEnd = gameEndTime - Date.now();
      if (timeToGameEnd > 0) {
        const autoProcessTimer = setTimeout(async () => {
          try {
            if (this.game && this.game.state === GameState.Betting && this.game.gameNumber === gameNumber) {
              console.log(`Auto processing game ${gameNumber}`);

              // 使用消息队列发送停止下注消息
              this.messageQueue.enqueueMessage(
                chatId,
                `⛔ **第 ${this.game.gameNumber} 局停止下注！**\n\n🎲 开始自动处理游戏...`,
                1 // 最高优先级
              );

              await this.safeProcessGame();
            }
          } catch (error) {
            console.error('Auto process timer error:', error);
            await this.forceCleanupGame('Auto process timer error');
          }
        }, timeToGameEnd);

        this.timers.set('autoProcess', autoProcessTimer);
      }
    }

    console.log(`Dynamic countdown timers set for game ${gameNumber}`);
  }

  private resetAllFlags(): void {
    this.isProcessing = false;
    this.gameCleanupScheduled = false;
    this.revealingInProgress = false;
  }

  private async forceCleanupGame(reason?: string): Promise<void> {
    console.log(`Force cleaning up game: ${reason || 'Manual cleanup'}`);
    try {
      this.clearAllTimers();
      this.resetAllFlags();
      // 清空消息队列
      this.messageQueue.clearQueue();
      this.game = null;
      await this.state.storage.delete('game');
      console.log('Game force cleaned up successfully');
    } catch (error) {
      console.error('Force cleanup game error:', error);
    }
  }

  private async safeCleanupGame(reason?: string): Promise<void> {
    if (this.gameCleanupScheduled) {
      console.log('Game cleanup already scheduled, skipping...');
      return;
    }

    this.gameCleanupScheduled = true;

    try {
      console.log(`Cleaning up game: ${reason || 'Manual cleanup'}`);
      this.clearAllTimers();
      this.resetAllFlags();
      // 清空消息队列
      this.messageQueue.clearQueue();
      this.game = null;
      await this.state.storage.delete('game');
      console.log('Game cleaned up successfully');
    } catch (error) {
      console.error('Cleanup game error:', error);
    } finally {
      this.gameCleanupScheduled = false;
    }
  }

  async cleanupGame(): Promise<void> {
    await this.safeCleanupGame('External cleanup request');
  }

  private clearAllTimers(): void {
    console.log(`Clearing ${this.timers.size} timers`);
    this.timers.forEach((timer, name) => {
      clearTimeout(timer);
      console.log(`Cleared timer: ${name}`);
    });
    this.timers.clear();
  }

  private generateGameNumber(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
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

      // 添加消息队列状态信息
      const queueStatus = this.messageQueue.getQueueStatus();

      return {
        gameNumber: this.game.gameNumber,
        state: this.game.state,
        betsCount: Object.keys(this.game.bets).length,
        bets: this.game.bets,
        timeRemaining: this.game.state === GameState.Betting ? timeRemaining : 0,
        result: this.game.result,
        needsProcessing: this.game.state === GameState.Betting && now >= this.game.bettingEndTime,
        autoGameEnabled,
        // 添加调试信息
        debug: {
          queueLength: queueStatus.queueLength,
          queueProcessing: queueStatus.processing,
          isProcessing: this.isProcessing,
          revealingInProgress: this.revealingInProgress
        }
      };
    } catch (error) {
      console.error('Get game status error:', error);
      return { status: 'error', autoGameEnabled: false };
    }
  }

  // 新增方法：获取消息队列状态（用于调试）
  getMessageQueueStatus() {
    return this.messageQueue.getQueueStatus();
  }

  // 新增方法：手动清空消息队列（紧急情况使用）
  clearMessageQueue(): void {
    this.messageQueue.clearQueue();
    console.log('Message queue manually cleared');
  }
}
