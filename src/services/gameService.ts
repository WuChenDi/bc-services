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
import { StorageService, DiceService, logger } from '@/services';
import { sleep, formatBetSummary, formatGameResult, calculatePoints } from '@/utils';
import { getConstants, type Constants } from '@/config/constants';

export class GameService {
  private game: GameData | null = null;
  private storage: StorageService;
  private diceService: DiceService;
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
    this.constants = getConstants(env);

    logger.setGlobalContext({ component: 'GameService' });
  }

  async initialize() {
    const timer = logger.performance.start('initialize');
    try {
      this.game = await this.state.storage.get('game') || null;

      if (this.game) {
        logger.setCurrentGame(this.game.gameNumber);

        const now = Date.now();
        logger.game.info('Initializing with existing game', {
          gameId: this.game.gameNumber,
          state: this.game.state,
          chatId: this.game.chatId
        });

        // 清理消息队列，避免旧消息干扰
        this.diceService.clearMessageQueue();

        if (this.game.state === GameState.Betting) {
          if (now > this.game.bettingEndTime + 30000) {
            logger.game.warn('Detected stuck betting game, auto-processing', {
              operation: 'auto-recover',
              bettingEndTime: this.game.bettingEndTime,
              currentTime: now,
              timeDiff: now - this.game.bettingEndTime
            });
            await this.safeProcessGame();
          } else {
            logger.game.info('Restoring betting timers');
            this.setupCountdownTimers(this.game.chatId, this.game.gameNumber);
          }
        } else if (this.game.state === GameState.Processing || this.game.state === GameState.Revealing) {
          logger.game.warn('Detected stuck processing/revealing game, cleaning up', {
            operation: 'cleanup-stuck-game',
            state: this.game.state
          });
          await this.safeCleanupGame('Game was stuck in processing/revealing state');
        }
      } else {
        logger.game.info('No existing game found, ready for new game');
      }

      timer.end({ hasExistingGame: !!this.game });
    } catch (error) {
      logger.game.error('Initialize error', { operation: 'initialize' }, error);
      await this.safeCleanupGame('Initialization error');
    }
  }

  async startGame(chatId: string): Promise<StartGameResponse> {
    const timer = logger.performance.start('startGame', { chatId });

    try {
      if (this.game && this.game.state !== GameState.Finished) {
        logger.game.warn('Game already in progress', {
          operation: 'start-game',
          chatId,
          currentState: this.game.state,
          currentGameId: this.game.gameNumber
        });
        timer.end({ success: false, reason: 'game-in-progress' });
        return { success: false, error: 'Game already in progress' };
      }

      await this.safeCleanupGame('Starting new game');
      this.resetAllFlags();

      const gameNumber = this.generateGameNumber();
      const now = Date.now();

      logger.setCurrentGame(gameNumber);

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

      // 设置当前游戏ID，重置消息序列
      this.diceService.setCurrentGame(gameNumber);

      logger.game.info('Game started successfully', {
        operation: 'start-game',
        chatId,
        bettingDuration: this.constants.BETTING_DURATION_MS,
        bettingEndTime: this.game.bettingEndTime
      });

      this.setupCountdownTimers(chatId, gameNumber);

      timer.end({
        success: true,
        gameNumber,
        bettingDuration: this.constants.BETTING_DURATION_MS
      });

      return { success: true, gameNumber, bettingEndTime: this.game.bettingEndTime };
    } catch (error) {
      logger.game.error('Start game error', {
        operation: 'start-game',
        chatId
      }, error);
      await this.safeCleanupGame('Start game failed');
      timer.end({ success: false, error: true });
      return { success: false, error: 'Failed to start game' };
    }
  }

  async placeBet(userId: string, userName: string, betType: BetType, amount: number): Promise<PlaceBetResponse> {
    const timer = logger.performance.start('placeBet', {
      userId,
      userName,
      betType,
      amount
    });

    try {
      if (!this.game || this.game.state !== GameState.Betting) {
        logger.game.warn('Place bet failed - no active betting game', {
          operation: 'place-bet',
          userId,
          userName,
          betType,
          amount,
          gameState: this.game?.state || 'no-game'
        });
        timer.end({ success: false, reason: 'no-active-game' });
        return { success: false, error: 'No active betting game' };
      }

      const now = Date.now();
      if (now > this.game.bettingEndTime) {
        logger.game.warn('Place bet failed - betting time ended', {
          operation: 'place-bet',
          userId,
          userName,
          betType,
          amount,
          bettingEndTime: this.game.bettingEndTime,
          currentTime: now,
          timeDiff: now - this.game.bettingEndTime
        });
        timer.end({ success: false, reason: 'betting-ended' });
        return { success: false, error: 'Betting time ended' };
      }

      // 验证参数
      if (!Object.values(BetType).includes(betType) || amount <= 0 || !userId) {
        logger.game.warn('Place bet failed - invalid parameters', {
          operation: 'place-bet',
          userId,
          userName,
          betType,
          amount,
          validBetTypes: Object.values(BetType)
        });
        timer.end({ success: false, reason: 'invalid-parameters' });
        return { success: false, error: 'Invalid bet parameters' };
      }

      if (amount > 10000) {
        logger.game.warn('Place bet failed - amount too high', {
          operation: 'place-bet',
          userId,
          userName,
          betType,
          amount,
          maxAmount: 10000
        });
        timer.end({ success: false, reason: 'amount-too-high' });
        return { success: false, error: '单次下注金额不能超过10000点' };
      }

      // 处理下注逻辑
      if (!this.game.bets[userId]) {
        this.game.bets[userId] = { userName };
      }

      const userBets = this.game.bets[userId];
      const existingBetAmount = userBets[betType] || 0;
      const newAmount = existingBetAmount + amount;

      if (newAmount > 10000) {
        logger.game.warn('Place bet failed - accumulated amount too high', {
          operation: 'place-bet',
          userId,
          userName,
          betType,
          existingAmount: existingBetAmount,
          addAmount: amount,
          newAmount,
          maxAmount: 10000
        });
        timer.end({ success: false, reason: 'accumulated-too-high' });
        return {
          success: false,
          error: `${betType}累加后金额${newAmount}点超过单次下注限制10000点\n当前已下注${existingBetAmount}点`
        };
      }

      // 检查总下注限制
      const totalUserBets = Object.entries(userBets).reduce((sum: number, [key, value]) => {
        if (key !== 'userName' && typeof value === 'number') {
          return sum + value;
        }
        return sum;
      }, 0);

      if (totalUserBets + amount > 50000) {
        logger.game.warn('Place bet failed - total user bets too high', {
          operation: 'place-bet',
          userId,
          userName,
          currentTotalBets: totalUserBets,
          addAmount: amount,
          newTotal: totalUserBets + amount,
          maxTotal: 50000
        });
        timer.end({ success: false, reason: 'total-too-high' });
        return {
          success: false,
          error: `总下注金额不能超过50000点\n当前总下注：${totalUserBets}点`
        };
      }

      // 更新下注信息
      userBets[betType] = newAmount;
      userBets.userName = userName;

      await this.state.storage.put('game', this.game);

      const remainingTime = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));
      const totalUsers = Object.keys(this.game.bets).length;

      logger.game.info('Bet placed successfully', {
        operation: 'place-bet',
        userId,
        userName,
        betType,
        amount: newAmount,
        isAccumulated: existingBetAmount > 0,
        previousAmount: existingBetAmount,
        addedAmount: amount,
        remainingTime,
        totalUsers
      });

      timer.end({
        success: true,
        betType,
        finalAmount: newAmount,
        isAccumulated: existingBetAmount > 0
      });

      // 返回结果
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
      logger.game.error('Place bet error', {
        operation: 'place-bet',
        userId,
        userName,
        betType,
        amount
      }, error);
      timer.end({ success: false, error: true });
      return { success: false, error: 'Failed to place bet' };
    }
  }

  async processGame(): Promise<void> {
    const timer = logger.performance.start('processGame', { gameId: this.game?.gameNumber });
    logger.game.info('Initiating game processing', { operation: 'process-game' });
    await this.safeProcessGame();
    timer.end({ success: true });
  }

  private async safeProcessGame(): Promise<void> {
    const timer = logger.performance.start('safeProcessGame', { gameId: this.game?.gameNumber });
    if (!this.game || this.game.state !== GameState.Betting) {
      logger.game.warn('No game to process or game not in betting state', { operation: 'safe-process', state: this.game?.state });
      timer.end({ success: false, reason: 'no-active-betting' });
      return;
    }

    if (this.isProcessing) {
      logger.game.warn('Game is already being processed, skipping...', { operation: 'safe-process' });
      timer.end({ success: false, reason: 'already-processing' });
      return;
    }

    logger.game.info('Starting to process game', { operation: 'safe-process', gameId: this.game.gameNumber });
    this.isProcessing = true;

    const globalTimeoutId = setTimeout(async () => {
      logger.game.error('Game processing global timeout, forcing cleanup...', { operation: 'timeout-cleanup' });
      await this.forceCleanupGame('Global processing timeout');
    }, this.constants.GLOBAL_PROCESS_TIMEOUT_MS);

    try {
      this.game.state = GameState.Processing;
      await this.state.storage.put('game', this.game);
      logger.game.info('Game state updated to Processing', { operation: 'state-update', newState: GameState.Processing });

      this.clearAllTimers();
      logger.game.debug('Cleared all timers', { operation: 'clear-timers' });

      const betsCount = Object.keys(this.game.bets).length;
      logger.game.info('Retrieved bets count', { operation: 'get-bets', count: betsCount });

      // 🔥 使用阻塞消息，确保顺序
      if (betsCount === 0) {
        await this.diceService.sendBlockingMessage(
          this.game.chatId,
          `😔 **第 ${this.game.gameNumber} 局无人下注**\n\n🎲 但游戏继续进行，开始发牌...`
        );
        logger.game.info('Sent no-bets message', { operation: 'send-message' });
      } else {
        await this.diceService.sendBlockingMessage(
          this.game.chatId,
          formatBetSummary(this.game)
        );
        logger.game.info('Sent bet summary', { operation: 'send-summary', betsCount });
      }

      await this.startRevealing();
      clearTimeout(globalTimeoutId);
      logger.game.info('Revealing phase started', { operation: 'start-revealing' });
    } catch (error) {
      clearTimeout(globalTimeoutId);
      logger.game.error('Process game error', { operation: 'safe-process' }, error);
      await this.forceCleanupGame('Process game error');
    } finally {
      this.isProcessing = false;
      timer.end({ success: true });
    }
  }

  private async startRevealing(): Promise<void> {
    const timer = logger.performance.start('startRevealing', { gameId: this.game?.gameNumber });
    if (!this.game || this.revealingInProgress) {
      logger.game.warn('No game or revealing already in progress', { operation: 'start-revealing', revealingInProgress: this.revealingInProgress });
      timer.end({ success: false, reason: 'no-game-or-in-progress' });
      return;
    }

    try {
      logger.game.info('Starting revealing phase for game', { operation: 'start-revealing', gameId: this.game.gameNumber });
      this.revealingInProgress = true;
      this.game.state = GameState.Revealing;
      await this.state.storage.put('game', this.game);
      logger.game.info('Game state updated to Revealing', { operation: 'state-update', newState: GameState.Revealing });

      // 🔥 使用阻塞消息，确保开牌消息先发送
      await this.diceService.sendBlockingMessage(
        this.game.chatId,
        `🎲 **开牌阶段开始！**\n\n🃏 庄家和闲家各发两张牌...`
      );
      logger.game.info('Sent revealing start message', { operation: 'send-message' });

      await this.dealCards();
      logger.game.info('Cards dealt, proceeding to result', { operation: 'deal-cards' });
      await this.calculateAndSendResult();
    } catch (error) {
      logger.game.error('Revealing error', { operation: 'start-revealing' }, error);
      await this.diceService.sendBlockingMessage(
        this.game.chatId,
        '❌ 开牌过程失败，游戏终止。请使用 /newgame 重新开始'
      );
      await this.forceCleanupGame('Revealing error');
    } finally {
      this.revealingInProgress = false;
      timer.end({ success: true });
    }
  }

  private async dealCards(): Promise<void> {
    const timer = logger.performance.start('dealCards', { gameId: this.game?.gameNumber });
    if (!this.game) {
      logger.game.warn('No game available for dealing cards', { operation: 'deal-cards' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    logger.game.info('Starting card dealing with strict sequence', { operation: 'deal-cards' });

    try {
      // 🔥 严格按顺序发牌，每张牌等待完成
      logger.game.debug('Dealing banker card 1', { operation: 'deal-card', player: 'banker', cardIndex: 1 });
      const bankerCard1 = await this.diceService.rollDice(this.game.chatId, 'banker', 1);
      this.game.cards.banker.push(bankerCard1);

      logger.game.debug('Dealing player card 1', { operation: 'deal-card', player: 'player', cardIndex: 1 });
      const playerCard1 = await this.diceService.rollDice(this.game.chatId, 'player', 1);
      this.game.cards.player.push(playerCard1);

      logger.game.debug('Dealing banker card 2', { operation: 'deal-card', player: 'banker', cardIndex: 2 });
      const bankerCard2 = await this.diceService.rollDice(this.game.chatId, 'banker', 2);
      this.game.cards.banker.push(bankerCard2);

      logger.game.debug('Dealing player card 2', { operation: 'deal-card', player: 'player', cardIndex: 2 });
      const playerCard2 = await this.diceService.rollDice(this.game.chatId, 'player', 2);
      this.game.cards.player.push(playerCard2);

      await this.state.storage.put('game', this.game);
      logger.game.info('Cards dealt and saved', { operation: 'save-cards' });

      const bankerSum = calculatePoints(this.game.cards.banker);
      const playerSum = calculatePoints(this.game.cards.player);

      // 🔥 发牌完成后再发送汇总，使用阻塞消息
      await this.diceService.sendBlockingMessage(
        this.game.chatId,
        `📊 **前两张牌点数:**\n` +
        `🏦 庄家: ${this.game.cards.banker.join(' + ')} = **${bankerSum} 点**\n` +
        `👤 闲家: ${this.game.cards.player.join(' + ')} = **${playerSum} 点**`
      );
      logger.game.info('Sent initial card summary', { operation: 'send-summary', bankerSum, playerSum });

      // 判断是否需要补牌
      if (bankerSum >= 8 || playerSum >= 8) {
        await this.diceService.sendBlockingMessage(
          this.game.chatId,
          '🎯 **天牌！无需补牌！**'
        );
        logger.game.info('Natural win detected, no third card needed', { operation: 'natural-win', bankerSum, playerSum });
      } else {
        await this.handleThirdCard(bankerSum, playerSum);
      }
      timer.end({ success: true, cardsDealt: 4 });
    } catch (error) {
      logger.game.error('Deal cards error', { operation: 'deal-cards' }, error);
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  private async handleThirdCard(bankerSum: number, playerSum: number): Promise<void> {
    const timer = logger.performance.start('handleThirdCard', { gameId: this.game?.gameNumber });
    if (!this.game) {
      logger.game.warn('No game available for handling third card', { operation: 'handle-third-card' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      let playerThirdCard: number | null = null;

      // 🔥 闲家补牌逻辑，严格顺序
      if (playerSum <= 5) {
        await this.diceService.sendBlockingMessage(
          this.game.chatId,
          '👤 **闲家需要补牌...**'
        );
        logger.game.info('Player needs third card', { operation: 'handle-third-card', playerSum });

        logger.game.debug('Dealing player card 3', { operation: 'deal-card', player: 'player', cardIndex: 3 });
        playerThirdCard = await this.diceService.rollDice(this.game.chatId, 'player', 3);
        this.game.cards.player.push(playerThirdCard);
        logger.game.info('Dealt player third card', { operation: 'deal-card', cardValue: playerThirdCard });
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
        await this.diceService.sendBlockingMessage(
          this.game.chatId,
          '🏦 **庄家需要补牌...**'
        );
        logger.game.info('Banker needs third card', { operation: 'handle-third-card', bankerSum });

        logger.game.debug('Dealing banker card 3', { operation: 'deal-card', player: 'banker', cardIndex: 3 });
        const bankerThirdCard = await this.diceService.rollDice(this.game.chatId, 'banker', 3);
        this.game.cards.banker.push(bankerThirdCard);
        logger.game.info('Dealt banker third card', { operation: 'deal-card', cardValue: bankerThirdCard });
      }

      await this.state.storage.put('game', this.game);
      logger.game.info('Third card handling completed and saved', { operation: 'save-third-cards' });
      timer.end({ success: true, playerThirdCard: !!playerThirdCard, bankerThirdCard: bankerNeedCard });
    } catch (error) {
      logger.game.error('Handle third card error', { operation: 'handle-third-card' }, error);
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  private async calculateAndSendResult(): Promise<void> {
    const timer = logger.performance.start('calculateAndSendResult', { gameId: this.game?.gameNumber });
    if (!this.game) {
      logger.game.warn('No game available for calculating result', { operation: 'calculate-result' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      logger.game.info('Calculating result for game', { operation: 'calculate-result', gameId: this.game.gameNumber });

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
      logger.game.info('Game result calculated and saved', {
        operation: 'save-result',
        winner: this.game.result.winner,
        bankerPoints: bankerFinal,
        playerPoints: playerFinal
      });

      // 异步保存游戏记录
      this.saveGameRecordAsync();

      // 🔥 最终结果使用阻塞消息，确保在所有骰子之后发送
      const autoGameEnabled = Boolean(await this.state.storage.get('autoGame'));
      await this.diceService.sendBlockingMessage(
        this.game.chatId,
        formatGameResult(this.game, {
          isAutoGameEnabled: autoGameEnabled,
          nextGameDelaySeconds: this.constants.AUTO_GAME_INTERVAL_MS / 1000
        })
      );
      logger.game.info('Sent final game result', { operation: 'send-result' });

      this.isProcessing = false;
      await this.handleGameCompletion();
      timer.end({ success: true, winner: this.game.result.winner });
    } catch (error) {
      logger.game.error('Calculate and send result error', { operation: 'calculate-result' }, error);
      await this.forceCleanupGame('Calculate result error');
      timer.end({ success: false, error: true });
    }
  }

  private async saveGameRecordAsync(): Promise<void> {
    const timer = logger.performance.start('saveGameRecordAsync', { gameId: this.game?.gameNumber });
    if (!this.game) {
      logger.game.warn('No game available for saving record', { operation: 'save-record' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      await this.storage.saveGameRecord(this.game);
      logger.game.info('Game record saved successfully', { operation: 'save-record', gameId: this.game.gameNumber });
      timer.end({ success: true });
    } catch (saveError) {
      logger.game.error('Failed to save game record', { operation: 'save-record' }, saveError);
      timer.end({ success: false, error: true });
    }
  }

  private async handleGameCompletion(): Promise<void> {
    const timer = logger.performance.start('handleGameCompletion', { gameId: this.game?.gameNumber });
    if (!this.game) {
      logger.game.warn('No game available for completion handling', { operation: 'handle-completion' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      const autoGameEnabled = await this.state.storage.get('autoGame');
      logger.game.info('Game completed, checking auto game status', {
        operation: 'handle-completion',
        autoGameEnabled
      });

      if (autoGameEnabled) {
        const nextGameTimer = setTimeout(async () => {
          try {
            logger.game.info('Starting next auto game', { operation: 'auto-next-game' });
            const stillAutoEnabled = await this.state.storage.get('autoGame');
            if (stillAutoEnabled && this.game) {
              await this.startAutoGame(this.game.chatId);
            } else {
              logger.game.info('Auto game disabled or no game, cleaning up', { operation: 'auto-cleanup' });
              await this.safeCleanupGame('Auto game disabled');
            }
          } catch (autoError) {
            logger.game.error('Auto game error', { operation: 'auto-next-game' }, autoError);
            await this.safeCleanupGame('Auto game error');
          }
        }, this.constants.AUTO_GAME_INTERVAL_MS);

        this.timers.set('nextGame', nextGameTimer);
        logger.game.info('Next auto game scheduled', { operation: 'schedule-auto', delayMs: this.constants.AUTO_GAME_INTERVAL_MS });
      } else {
        const cleanupTimer = setTimeout(async () => {
          await this.safeCleanupGame('Manual cleanup after game finished');
        }, this.constants.CLEANUP_DELAY_MS);

        this.timers.set('cleanup', cleanupTimer);
        logger.game.info('Game cleanup scheduled', { operation: 'schedule-cleanup', delayMs: this.constants.CLEANUP_DELAY_MS });
      }
      timer.end({ success: true });
    } catch (error) {
      logger.game.error('Handle game completion error', { operation: 'handle-completion' }, error);
      await this.safeCleanupGame('Game completion error');
      timer.end({ success: false, error: true });
    }
  }

  async startAutoGame(chatId: string): Promise<void> {
    const timer = logger.performance.start('startAutoGame', { chatId });
    try {
      logger.game.info('Starting auto game for chatId', { operation: 'start-auto-game', chatId });
      const result = await this.startGame(chatId);

      if (result.success) {
        // 🔥 自动游戏开始消息使用阻塞发送
        await this.diceService.sendBlockingMessage(
          chatId,
          `🤖 **自动游戏 - 第 ${result.gameNumber} 局开始！**\n\n` +
          `💰 下注时间：30秒\n` +
          `📝 下注格式：/bet banker 100\n` +
          `⏰ 30秒后将自动处理游戏...\n` +
          `🔄 游戏将持续自动进行`
        );
        logger.game.info('Auto game started successfully', { operation: 'start-auto-game', gameId: result.gameNumber });
      } else {
        logger.game.error('Failed to start auto game', { operation: 'start-auto-game', chatId }, result.error);
        await this.safeCleanupGame('Auto game start failed');
      }
      timer.end({ success: result.success });
    } catch (error) {
      logger.game.error('Start auto game error', { operation: 'start-auto-game', chatId }, error);
      await this.safeCleanupGame('Start auto game error');
      timer.end({ success: false, error: true });
    }
  }

  async enableAutoGame(chatId: string): Promise<ApiResponse> {
    const timer = logger.performance.start('enableAutoGame', { chatId });
    try {
      logger.game.info('Enabling auto game', { operation: 'enable-auto-game', chatId });
      await this.state.storage.put('autoGame', true);

      if (!this.game || this.game.state === GameState.Finished) {
        await this.startAutoGame(chatId);
      }

      logger.game.info('Auto game enabled successfully', { operation: 'enable-auto-game' });
      timer.end({ success: true });
      return { success: true, message: 'Auto game enabled' };
    } catch (error) {
      logger.game.error('Enable auto game error', { operation: 'enable-auto-game', chatId }, error);
      timer.end({ success: false, error: true });
      return { success: false, error: 'Failed to enable auto game' };
    }
  }

  async disableAutoGame(): Promise<ApiResponse> {
    const timer = logger.performance.start('disableAutoGame');
    try {
      logger.game.info('Disabling auto game', { operation: 'disable-auto-game' });
      await this.state.storage.put('autoGame', false);
      this.clearAllTimers();
      // 清空消息队列，停止所有待处理的消息
      this.diceService.clearMessageQueue();
      logger.game.info('Auto game disabled and message queue cleared', { operation: 'disable-auto-game' });
      timer.end({ success: true });
      return { success: true, message: 'Auto game disabled' };
    } catch (error) {
      logger.game.error('Disable auto game error', { operation: 'disable-auto-game' }, error);
      timer.end({ success: false, error: true });
      return { success: false, error: 'Failed to disable auto game' };
    }
  }

  private setupCountdownTimers(chatId: string, gameNumber: string): void {
    const timer = logger.performance.start('setupCountdownTimers', { gameId: gameNumber });
    logger.game.info('Setting up countdown timers for game', { operation: 'setup-timers', gameId: gameNumber });

    this.clearAllTimers();

    // 🔥 倒计时消息使用非阻塞发送（不影响游戏流程）
    const sendCountdownMessage = (remainingSeconds: number) => {
      if (this.game && this.game.state === GameState.Betting && this.game.gameNumber === gameNumber) {
        this.diceService.sendMessage(
          chatId,
          `⏰ **下注倒计时：${remainingSeconds}秒！**\n\n` +
          `👥 当前参与人数：${Object.keys(this.game.bets).length}\n` +
          `💡 抓紧时间下注哦~`
        );
        logger.game.debug('Sent countdown message', { operation: 'send-countdown', remainingSeconds });
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
              logger.game.info('Auto processing game', { operation: 'auto-process', gameId: gameNumber });

              // 🔥 停止下注消息使用非阻塞发送
              this.diceService.sendMessage(
                chatId,
                `⛔ **第 ${this.game.gameNumber} 局停止下注！**\n\n🎲 开始自动处理游戏...`
              );

              await this.safeProcessGame();
            }
          } catch (error) {
            logger.game.error('Auto process timer error', { operation: 'auto-process' }, error);
            await this.forceCleanupGame('Auto process timer error');
          }
        }, timeToGameEnd);

        this.timers.set('autoProcess', autoProcessTimer);
      }
    }

    logger.game.info('Dynamic countdown timers set for game', { operation: 'setup-timers', timerCount: this.timers.size });
    timer.end({ success: true, timersSet: this.timers.size });
  }

  private resetAllFlags(): void {
    logger.game.debug('Resetting all flags', {
      operation: 'reset-flags',
      previousState: {
        isProcessing: this.isProcessing,
        gameCleanupScheduled: this.gameCleanupScheduled,
        revealingInProgress: this.revealingInProgress
      }
    });

    this.isProcessing = false;
    this.gameCleanupScheduled = false;
    this.revealingInProgress = false;
  }

  private async forceCleanupGame(reason?: string): Promise<void> {
    logger.game.warn('Force cleaning up game', {
      operation: 'force-cleanup',
      reason: reason || 'Manual cleanup',
      gameId: this.game?.gameNumber
    });

    try {
      this.clearAllTimers();
      this.resetAllFlags();
      this.diceService.clearMessageQueue();

      const oldGameId = this.game?.gameNumber;
      this.game = null;

      await this.state.storage.delete('game');

      // 清除日志上下文中的游戏ID
      logger.clearCurrentGame();

      logger.game.info('Game force cleaned up successfully', {
        operation: 'force-cleanup',
        cleanedGameId: oldGameId
      });
    } catch (error) {
      logger.game.error('Force cleanup game error', {
        operation: 'force-cleanup'
      }, error);
    }
  }

  private async safeCleanupGame(reason?: string): Promise<void> {
    const timer = logger.performance.start('safeCleanupGame', { gameId: this.game?.gameNumber });
    if (this.gameCleanupScheduled) {
      logger.game.info('Game cleanup already scheduled, skipping...', { operation: 'safe-cleanup' });
      timer.end({ success: false, reason: 'already-scheduled' });
      return;
    }

    this.gameCleanupScheduled = true;

    try {
      logger.game.info('Cleaning up game', { operation: 'safe-cleanup', reason: reason || 'Manual cleanup' });
      this.clearAllTimers();
      this.resetAllFlags();
      // 清空消息队列
      this.diceService.clearMessageQueue();
      this.game = null;
      await this.state.storage.delete('game');
      logger.game.info('Game cleaned up successfully', { operation: 'safe-cleanup' });
    } catch (error) {
      logger.game.error('Cleanup game error', { operation: 'safe-cleanup' }, error);
    } finally {
      this.gameCleanupScheduled = false;
      timer.end({ success: true });
    }
  }

  async cleanupGame(): Promise<void> {
    const timer = logger.performance.start('cleanupGame', { gameId: this.game?.gameNumber });
    logger.game.info('Initiating external cleanup', { operation: 'cleanup-game' });
    await this.safeCleanupGame('External cleanup request');
    timer.end({ success: true });
  }

  private clearAllTimers(): void {
    logger.game.debug('Clearing timers', {
      operation: 'clear-timers',
      timerCount: this.timers.size,
      timerNames: Array.from(this.timers.keys())
    });

    this.timers.forEach((timer, name) => {
      clearTimeout(timer);
      logger.game.debug(`Cleared timer: ${name}`, { operation: 'clear-timer' });
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
    const timer = logger.performance.start('getGameStatus', { gameId: this.game?.gameNumber });
    try {
      logger.game.info('Getting game status', { operation: 'get-status' });
      const autoGameEnabled = Boolean(await this.state.storage.get('autoGame'));

      if (!this.game) {
        logger.game.info('No active game, returning no_game status', { operation: 'get-status' });
        timer.end({ success: true, status: 'no_game' });
        return { status: 'no_game', autoGameEnabled };
      }

      const now = Date.now();
      const timeRemaining = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));

      // 添加消息队列状态信息
      const queueStatus = this.diceService.getQueueStatus();

      const status: GameStatusResponse = {
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
      logger.game.info('Game status retrieved successfully', { operation: 'get-status', state: this.game.state });
      timer.end({ success: true, status: this.game.state });
      return status;
    } catch (error) {
      logger.game.error('Get game status error', { operation: 'get-status' }, error);
      timer.end({ success: false, error: true });
      return { status: 'error', autoGameEnabled: false };
    }
  }

  // 获取消息队列状态（用于调试）
  getMessageQueueStatus() {
    const timer = logger.performance.start('getMessageQueueStatus', { gameId: this.game?.gameNumber });
    logger.game.info('Getting message queue status', { operation: 'get-queue-status' });
    const status = this.diceService.getQueueStatus();
    logger.game.debug('Message queue status retrieved', { operation: 'get-queue-status', status });
    timer.end({ success: true });
    return status;
  }

  // 手动清空消息队列（紧急情况使用）
  clearMessageQueue(): void {
    const timer = logger.performance.start('clearMessageQueue', { gameId: this.game?.gameNumber });
    logger.game.info('Manually clearing message queue', { operation: 'clear-queue' });
    this.diceService.clearMessageQueue();
    logger.game.info('Message queue cleared successfully', { operation: 'clear-queue' });
    timer.end({ success: true });
  }
}
