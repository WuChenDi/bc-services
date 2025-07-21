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
        logger.game.info('正在初始化现有游戏', {
          gameId: this.game.gameNumber,
          state: this.game.state,
          chatId: this.game.chatId
        });

        // 清理消息队列，避免旧消息干扰
        this.diceService.clearMessageQueue();

        if (this.game.state === GameState.Betting) {
          if (now > this.game.bettingEndTime + 30000) {
            logger.game.warn('检测到下注状态卡住，自动处理', {
              operation: 'auto-recover',
              bettingEndTime: this.game.bettingEndTime,
              currentTime: now,
              timeDiff: now - this.game.bettingEndTime
            });
            await this.safeProcessGame();
          } else {
            logger.game.info('恢复下注定时器');
            this.setupCountdownTimers(this.game.chatId, this.game.gameNumber);
          }
        } else if (this.game.state === GameState.Processing || this.game.state === GameState.Revealing) {
          logger.game.warn('检测到处理或开牌状态卡住，执行清理', {
            operation: 'cleanup-stuck-game',
            state: this.game.state
          });
          await this.safeCleanupGame('游戏在处理或开牌状态卡住');
        }
      } else {
        logger.game.info('未找到现有游戏，准备开始新游戏');
      }

      timer.end({ hasExistingGame: !!this.game });
    } catch (error) {
      logger.game.error('初始化失败', { operation: 'initialize' }, error);
      await this.safeCleanupGame('初始化错误');
    }
  }

  async startGame(chatId: string): Promise<StartGameResponse> {
    const timer = logger.performance.start('startGame', { chatId });

    try {
      if (this.game && this.game.state !== GameState.Finished) {
        logger.game.warn('游戏已在进行中', {
          operation: 'start-game',
          chatId,
          currentState: this.game.state,
          currentGameId: this.game.gameNumber
        });
        timer.end({ success: false, reason: 'game-in-progress' });
        return { success: false, error: '游戏已在进行中' };
      }

      await this.safeCleanupGame('开始新游戏');
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

      logger.game.info('游戏启动成功', {
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
      logger.game.error('启动游戏失败', {
        operation: 'start-game',
        chatId
      }, error);
      await this.safeCleanupGame('启动游戏失败');
      timer.end({ success: false, error: true });
      return { success: false, error: '无法启动游戏' };
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
        logger.game.error('下注失败 - 无有效下注游戏', {
          operation: 'place-bet',
          userId,
          userName,
          betType,
          amount,
          gameState: this.game?.state || 'no-game'
        });
        timer.end({ success: false, reason: 'no-active-game' });
        return { success: false, error: '无有效下注游戏' };
      }

      const now = Date.now();
      if (now > this.game.bettingEndTime) {
        logger.game.error('下注失败 - 下注时间已结束', {
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
        return { success: false, error: '下注时间已结束' };
      }

      // 验证参数
      if (!Object.values(BetType).includes(betType) || amount <= 0 || !userId) {
        logger.game.error('下注失败 - 参数无效', {
          operation: 'place-bet',
          userId,
          userName,
          betType,
          amount,
          validBetTypes: Object.values(BetType)
        });
        timer.end({ success: false, reason: 'invalid-parameters' });
        return { success: false, error: '下注参数无效' };
      }

      if (amount > 10000) {
        logger.game.error('下注失败 - 金额超限', {
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
        logger.game.error('下注失败 - 累计金额超限', {
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
        logger.game.error('下注失败 - 用户总下注金额超限', {
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

      logger.game.info('下注成功', {
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
      logger.game.error('下注失败', {
        operation: 'place-bet',
        userId,
        userName,
        betType,
        amount
      }, error);
      timer.end({ success: false, error: true });
      return { success: false, error: '下注失败' };
    }
  }

  async processGame(): Promise<void> {
    const timer = logger.performance.start('processGame', { gameId: this.game?.gameNumber });
    logger.game.info('开始处理游戏', { operation: 'process-game' });
    await this.safeProcessGame();
    timer.end({ success: true });
  }

  private async safeProcessGame(): Promise<void> {
    const timer = logger.performance.start('safeProcessGame', { gameId: this.game?.gameNumber });
    if (!this.game || this.game.state !== GameState.Betting) {
      logger.game.warn('无可处理游戏或游戏不在下注状态', { operation: 'safe-process', state: this.game?.state });
      timer.end({ success: false, reason: 'no-active-betting' });
      return;
    }

    if (this.isProcessing) {
      logger.game.warn('游戏已在处理中，跳过', { operation: 'safe-process' });
      timer.end({ success: false, reason: 'already-processing' });
      return;
    }

    logger.game.info('开始处理游戏', { operation: 'safe-process', gameId: this.game.gameNumber });
    this.isProcessing = true;

    const globalTimeoutId = setTimeout(async () => {
      logger.game.error('游戏处理超时，强制清理', { operation: 'timeout-cleanup' });
      await this.forceCleanupGame('全局处理超时');
    }, this.constants.GLOBAL_PROCESS_TIMEOUT_MS);

    try {
      this.game.state = GameState.Processing;
      await this.state.storage.put('game', this.game);
      logger.game.info('游戏状态更新为处理中', { operation: 'state-update', newState: GameState.Processing });

      this.clearAllTimers();
      logger.game.debug('已清除所有定时器', { operation: 'clear-timers' });

      const betsCount = Object.keys(this.game.bets).length;
      logger.game.info('获取下注人数', { operation: 'get-bets', count: betsCount });

      // 使用阻塞消息，确保顺序
      if (betsCount === 0) {
        await this.diceService.sendBlockingMessage(
          this.game.chatId,
          `😔 **第 ${this.game.gameNumber} 局无人下注**\n\n🎲 但游戏继续进行，开始发牌...`
        );
        logger.game.info('发送无人下注消息', { operation: 'send-message' });
      } else {
        await this.diceService.sendBlockingMessage(
          this.game.chatId,
          formatBetSummary(this.game)
        );
        logger.game.info('发送下注汇总', { operation: 'send-summary', betsCount });
      }

      await this.startRevealing();
      clearTimeout(globalTimeoutId);
      logger.game.info('开牌阶段开始', { operation: 'start-revealing' });
    } catch (error) {
      clearTimeout(globalTimeoutId);
      logger.game.error('处理游戏失败', { operation: 'safe-process' }, error);
      await this.forceCleanupGame('处理游戏失败');
    } finally {
      this.isProcessing = false;
      timer.end({ success: true });
    }
  }

  private async startRevealing(): Promise<void> {
    const timer = logger.performance.start('startRevealing', { gameId: this.game?.gameNumber });
    if (!this.game || this.revealingInProgress) {
      logger.game.warn('无游戏或开牌已在进行中', { operation: 'start-revealing', revealingInProgress: this.revealingInProgress });
      timer.end({ success: false, reason: 'no-game-or-in-progress' });
      return;
    }

    try {
      logger.game.info('开始游戏开牌阶段', { operation: 'start-revealing', gameId: this.game.gameNumber });
      this.revealingInProgress = true;
      this.game.state = GameState.Revealing;
      await this.state.storage.put('game', this.game);
      logger.game.info('游戏状态更新为开牌中', { operation: 'state-update', newState: GameState.Revealing });

      // 使用阻塞消息，确保开牌消息先发送
      await this.diceService.sendBlockingMessage(
        this.game.chatId,
        `🎲 **开牌阶段开始！**\n\n🃏 庄家和闲家各发两张牌...`
      );
      logger.game.info('发送开牌开始消息', { operation: 'send-message' });

      await this.dealCards();
      logger.game.info('发牌完成，进入结果计算', { operation: 'deal-cards' });
      await this.calculateAndSendResult();
    } catch (error) {
      logger.game.error('开牌失败', { operation: 'start-revealing' }, error);
      await this.diceService.sendBlockingMessage(
        this.game.chatId,
        '❌ 开牌过程失败，游戏终止。请使用 /newgame 重新开始'
      );
      await this.forceCleanupGame('开牌失败');
    } finally {
      this.revealingInProgress = false;
      timer.end({ success: true });
    }
  }

  private async dealCards(): Promise<void> {
    const timer = logger.performance.start('dealCards', { gameId: this.game?.gameNumber });
    if (!this.game) {
      logger.game.warn('无可用游戏进行发牌', { operation: 'deal-cards' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    logger.game.info('开始按严格顺序发牌', { operation: 'deal-cards' });

    try {
      // 严格按顺序发牌，每张牌等待完成
      logger.game.debug('发庄家第1张牌', { operation: 'deal-card', player: 'banker', cardIndex: 1 });
      const bankerCard1 = await this.diceService.rollDice(this.game.chatId, 'banker', 1);
      this.game.cards.banker.push(bankerCard1);

      logger.game.debug('发闲家第1张牌', { operation: 'deal-card', player: 'player', cardIndex: 1 });
      const playerCard1 = await this.diceService.rollDice(this.game.chatId, 'player', 1);
      this.game.cards.player.push(playerCard1);

      logger.game.debug('发庄家第2张牌', { operation: 'deal-card', player: 'banker', cardIndex: 2 });
      const bankerCard2 = await this.diceService.rollDice(this.game.chatId, 'banker', 2);
      this.game.cards.banker.push(bankerCard2);

      logger.game.debug('发闲家第2张牌', { operation: 'deal-card', player: 'player', cardIndex: 2 });
      const playerCard2 = await this.diceService.rollDice(this.game.chatId, 'player', 2);
      this.game.cards.player.push(playerCard2);

      await this.state.storage.put('game', this.game);
      logger.game.info('发牌完成并保存', { operation: 'save-cards' });

      const bankerSum = calculatePoints(this.game.cards.banker);
      const playerSum = calculatePoints(this.game.cards.player);

      // 发牌完成后再发送汇总，使用阻塞消息
      await this.diceService.sendBlockingMessage(
        this.game.chatId,
        `📊 **前两张牌点数:**\n` +
        `🏦 庄家: ${this.game.cards.banker.join(' + ')} = **${bankerSum} 点**\n` +
        `👤 闲家: ${this.game.cards.player.join(' + ')} = **${playerSum} 点**`
      );
      logger.game.info('发送前两张牌汇总', { operation: 'send-summary', bankerSum, playerSum });

      // 判断是否需要补牌
      if (bankerSum >= 8 || playerSum >= 8) {
        await this.diceService.sendBlockingMessage(
          this.game.chatId,
          '🎯 **天牌！无需补牌！**'
        );
        logger.game.info('检测到天牌，无需补牌', { operation: 'natural-win', bankerSum, playerSum });
      } else {
        await this.handleThirdCard(bankerSum, playerSum);
      }
      timer.end({ success: true, cardsDealt: 4 });
    } catch (error) {
      logger.game.error('发牌失败', { operation: 'deal-cards' }, error);
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  private async handleThirdCard(bankerSum: number, playerSum: number): Promise<void> {
    const timer = logger.performance.start('handleThirdCard', { gameId: this.game?.gameNumber });
    if (!this.game) {
      logger.game.warn('无可用游戏进行补牌处理', { operation: 'handle-third-card' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      let playerThirdCard: number | null = null;

      // 闲家补牌逻辑，严格顺序
      if (playerSum <= 5) {
        await this.diceService.sendBlockingMessage(
          this.game.chatId,
          '👤 **闲家需要补牌...**'
        );
        logger.game.info('闲家需要补牌', { operation: 'handle-third-card', playerSum });

        logger.game.debug('发闲家第3张牌', { operation: 'deal-card', player: 'player', cardIndex: 3 });
        playerThirdCard = await this.diceService.rollDice(this.game.chatId, 'player', 3);
        this.game.cards.player.push(playerThirdCard);
        logger.game.info('闲家补牌完成', { operation: 'deal-card', cardValue: playerThirdCard });
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
        logger.game.info('庄家需要补牌', { operation: 'handle-third-card', bankerSum });

        logger.game.debug('发庄家第3张牌', { operation: 'deal-card', player: 'banker', cardIndex: 3 });
        const bankerThirdCard = await this.diceService.rollDice(this.game.chatId, 'banker', 3);
        this.game.cards.banker.push(bankerThirdCard);
        logger.game.info('庄家补牌完成', { operation: 'deal-card', cardValue: bankerThirdCard });
      }

      await this.state.storage.put('game', this.game);
      logger.game.info('补牌处理完成并保存', { operation: 'save-third-cards' });
      timer.end({ success: true, playerThirdCard: !!playerThirdCard, bankerThirdCard: bankerNeedCard });
    } catch (error) {
      logger.game.error('补牌处理失败', { operation: 'handle-third-card' }, error);
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  private async calculateAndSendResult(): Promise<void> {
    const timer = logger.performance.start('calculateAndSendResult', { gameId: this.game?.gameNumber });
    if (!this.game) {
      logger.game.warn('无可用游戏进行结果计算', { operation: 'calculate-result' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      logger.game.info('开始计算游戏结果', { operation: 'calculate-result', gameId: this.game.gameNumber });

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
      logger.game.info('游戏结果计算并保存', {
        operation: 'save-result',
        winner: this.game.result.winner,
        bankerPoints: bankerFinal,
        playerPoints: playerFinal
      });

      // 异步保存游戏记录
      this.saveGameRecordAsync();

      // 最终结果使用阻塞消息，确保在所有骰子之后发送
      const autoGameEnabled = Boolean(await this.state.storage.get('autoGame'));
      await this.diceService.sendBlockingMessage(
        this.game.chatId,
        formatGameResult(this.game, {
          isAutoGameEnabled: autoGameEnabled,
          nextGameDelaySeconds: this.constants.AUTO_GAME_INTERVAL_MS / 1000
        })
      );
      logger.game.info('发送最终游戏结果', { operation: 'send-result' });

      this.isProcessing = false;
      await this.handleGameCompletion();
      timer.end({ success: true, winner: this.game.result.winner });
    } catch (error) {
      logger.game.error('计算并发送结果失败', { operation: 'calculate-result' }, error);
      await this.forceCleanupGame('计算结果失败');
      timer.end({ success: false, error: true });
    }
  }

  private async saveGameRecordAsync(): Promise<void> {
    const timer = logger.performance.start('saveGameRecordAsync', { gameId: this.game?.gameNumber });
    if (!this.game) {
      logger.game.warn('无可用游戏保存记录', { operation: 'save-record' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      await this.storage.saveGameRecord(this.game);
      logger.game.info('游戏记录保存成功', { operation: 'save-record', gameId: this.game.gameNumber });
      timer.end({ success: true });
    } catch (saveError) {
      logger.game.error('保存游戏记录失败', { operation: 'save-record' }, saveError);
      timer.end({ success: false, error: true });
    }
  }

  private async handleGameCompletion(): Promise<void> {
    const timer = logger.performance.start('handleGameCompletion', { gameId: this.game?.gameNumber });
    if (!this.game) {
      logger.game.warn('无可用游戏进行完成处理', { operation: 'handle-completion' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      const autoGameEnabled = await this.state.storage.get('autoGame');
      logger.game.info('游戏完成，检查自动游戏状态', {
        operation: 'handle-completion',
        autoGameEnabled
      });

      if (autoGameEnabled) {
        const nextGameTimer = setTimeout(async () => {
          try {
            logger.game.info('启动下一局自动游戏', { operation: 'auto-next-game' });
            const stillAutoEnabled = await this.state.storage.get('autoGame');
            if (stillAutoEnabled && this.game) {
              await this.startAutoGame(this.game.chatId);
            } else {
              logger.game.info('自动游戏已禁用或无游戏，执行清理', { operation: 'auto-cleanup' });
              await this.safeCleanupGame('自动游戏已禁用');
            }
          } catch (autoError) {
            logger.game.error('自动游戏失败', { operation: 'auto-next-game' }, autoError);
            await this.safeCleanupGame('自动游戏错误');
          }
        }, this.constants.AUTO_GAME_INTERVAL_MS);

        this.timers.set('nextGame', nextGameTimer);
        logger.game.info('下一局自动游戏已调度', { operation: 'schedule-auto', delayMs: this.constants.AUTO_GAME_INTERVAL_MS });
      } else {
        const cleanupTimer = setTimeout(async () => {
          await this.safeCleanupGame('游戏结束后手动清理');
        }, this.constants.CLEANUP_DELAY_MS);

        this.timers.set('cleanup', cleanupTimer);
        logger.game.info('游戏清理已调度', { operation: 'schedule-cleanup', delayMs: this.constants.CLEANUP_DELAY_MS });
      }
      timer.end({ success: true });
    } catch (error) {
      logger.game.error('处理游戏完成失败', { operation: 'handle-completion' }, error);
      await this.safeCleanupGame('游戏完成处理错误');
      timer.end({ success: false, error: true });
    }
  }

  async startAutoGame(chatId: string): Promise<void> {
    const timer = logger.performance.start('startAutoGame', { chatId });
    try {
      logger.game.info('为聊天ID启动自动游戏', { operation: 'start-auto-game', chatId });
      const result = await this.startGame(chatId);

      if (result.success) {
        // 自动游戏开始消息使用阻塞发送
        await this.diceService.sendBlockingMessage(
          chatId,
          `🤖 **自动游戏 - 第 ${result.gameNumber} 局开始！**\n\n` +
          `💰 下注时间：30秒\n` +
          `📝 下注格式：/bet banker 100\n` +
          `⏰ 30秒后将自动处理游戏...\n` +
          `🔄 游戏将持续自动进行`
        );
        logger.game.info('自动游戏启动成功', { operation: 'start-auto-game', gameId: result.gameNumber });
      } else {
        logger.game.error('启动自动游戏失败', { operation: 'start-auto-game', chatId }, result.error);
        await this.safeCleanupGame('自动游戏启动失败');
      }
      timer.end({ success: result.success });
    } catch (error) {
      logger.game.error('启动自动游戏失败', { operation: 'start-auto-game', chatId }, error);
      await this.safeCleanupGame('启动自动游戏错误');
      timer.end({ success: false, error: true });
    }
  }

  async enableAutoGame(chatId: string): Promise<ApiResponse> {
    const timer = logger.performance.start('enableAutoGame', { chatId });
    try {
      logger.game.info('启用自动游戏', { operation: 'enable-auto-game', chatId });
      await this.state.storage.put('autoGame', true);

      if (!this.game || this.game.state === GameState.Finished) {
        await this.startAutoGame(chatId);
      }

      logger.game.info('自动游戏启用成功', { operation: 'enable-auto-game' });
      timer.end({ success: true });
      return { success: true, message: '自动游戏已启用' };
    } catch (error) {
      logger.game.error('启用自动游戏失败', { operation: 'enable-auto-game', chatId }, error);
      timer.end({ success: false, error: true });
      return { success: false, error: '无法启用自动游戏' };
    }
  }

  async disableAutoGame(): Promise<ApiResponse> {
    const timer = logger.performance.start('disableAutoGame');
    try {
      logger.game.info('禁用自动游戏', { operation: 'disable-auto-game' });
      await this.state.storage.put('autoGame', false);
      this.clearAllTimers();
      // 清空消息队列，停止所有待处理的消息
      this.diceService.clearMessageQueue();
      logger.game.info('自动游戏已禁用且消息队列已清空', { operation: 'disable-auto-game' });
      timer.end({ success: true });
      return { success: true, message: '自动游戏已禁用' };
    } catch (error) {
      logger.game.error('禁用自动游戏失败', { operation: 'disable-auto-game' }, error);
      timer.end({ success: false, error: true });
      return { success: false, error: '无法禁用自动游戏' };
    }
  }

  private setupCountdownTimers(chatId: string, gameNumber: string): void {
    const timer = logger.performance.start('setupCountdownTimers', { gameId: gameNumber });
    logger.game.info('为游戏设置倒计时定时器', { operation: 'setup-timers', gameId: gameNumber });

    this.clearAllTimers();

    // 倒计时消息使用非阻塞发送（不影响游戏流程）
    const sendCountdownMessage = (remainingSeconds: number) => {
      if (this.game && this.game.state === GameState.Betting && this.game.gameNumber === gameNumber) {
        this.diceService.sendMessage(
          chatId,
          `⏰ **下注倒计时：${remainingSeconds}秒！**\n\n` +
          `👥 当前参与人数：${Object.keys(this.game.bets).length}\n` +
          `💡 抓紧时间下注哦~`
        );
        logger.game.debug('发送倒计时消息', { operation: 'send-countdown', remainingSeconds });
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
              logger.game.info('自动处理游戏', { operation: 'auto-process', gameId: gameNumber });

              // 停止下注消息使用非阻塞发送
              this.diceService.sendMessage(
                chatId,
                `⛔ **第 ${this.game.gameNumber} 局停止下注！**\n\n🎲 开始自动处理游戏...`
              );

              await this.safeProcessGame();
            }
          } catch (error) {
            logger.game.error('自动处理定时器失败', { operation: 'auto-process' }, error);
            await this.forceCleanupGame('自动处理定时器错误');
          }
        }, timeToGameEnd);

        this.timers.set('autoProcess', autoProcessTimer);
      }
    }

    logger.game.info('动态倒计时定时器设置完成', { operation: 'setup-timers', timerCount: this.timers.size });
    timer.end({ success: true, timersSet: this.timers.size });
  }

  private resetAllFlags(): void {
    logger.game.debug('重置所有标志', {
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
    logger.game.warn('强制清理游戏', {
      operation: 'force-cleanup',
      reason: reason || '手动清理',
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

      logger.game.info('游戏强制清理成功', {
        operation: 'force-cleanup',
        cleanedGameId: oldGameId
      });
    } catch (error) {
      logger.game.error('强制清理游戏失败', { operation: 'force-cleanup' }, error);
    }
  }

  private async safeCleanupGame(reason?: string): Promise<void> {
    const timer = logger.performance.start('safeCleanupGame', { gameId: this.game?.gameNumber });
    if (this.gameCleanupScheduled) {
      logger.game.info('游戏清理已调度，跳过', { operation: 'safe-cleanup' });
      timer.end({ success: false, reason: 'already-scheduled' });
      return;
    }

    this.gameCleanupScheduled = true;

    try {
      logger.game.info('开始清理游戏', { operation: 'safe-cleanup', reason: reason || '手动清理' });
      this.clearAllTimers();
      this.resetAllFlags();
      // 清空消息队列
      this.diceService.clearMessageQueue();
      this.game = null;
      await this.state.storage.delete('game');
      logger.game.info('游戏清理成功', { operation: 'safe-cleanup' });
    } catch (error) {
      logger.game.error('清理游戏失败', { operation: 'safe-cleanup' }, error);
    } finally {
      this.gameCleanupScheduled = false;
      timer.end({ success: true });
    }
  }

  async cleanupGame(): Promise<void> {
    const timer = logger.performance.start('cleanupGame', { gameId: this.game?.gameNumber });
    logger.game.info('发起外部清理请求', { operation: 'cleanup-game' });
    await this.safeCleanupGame('外部清理请求');
    timer.end({ success: true });
  }

  private clearAllTimers(): void {
    logger.game.debug('清除定时器', {
      operation: 'clear-timers',
      timerCount: this.timers.size,
      timerNames: Array.from(this.timers.keys())
    });

    this.timers.forEach((timer, name) => {
      clearTimeout(timer);
      logger.game.debug(`已清除定时器: ${name}`, { operation: 'clear-timer' });
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
      logger.game.info('获取游戏状态', { operation: 'get-status' });
      const autoGameEnabled = Boolean(await this.state.storage.get('autoGame'));

      if (!this.game) {
        logger.game.info('无有效游戏，返回无游戏状态', { operation: 'get-status' });
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
      logger.game.info('游戏状态获取成功', { operation: 'get-status', state: this.game.state });
      timer.end({ success: true, status: this.game.state });
      return status;
    } catch (error) {
      logger.game.error('获取游戏状态失败', { operation: 'get-status' }, error);
      timer.end({ success: false, error: true });
      return { status: 'error', autoGameEnabled: false };
    }
  }

  // 获取消息队列状态（用于调试）
  getMessageQueueStatus() {
    const timer = logger.performance.start('getMessageQueueStatus', { gameId: this.game?.gameNumber });
    logger.game.info('获取消息队列状态', { operation: 'get-queue-status' });
    const status = this.diceService.getQueueStatus();
    logger.game.debug('消息队列状态获取成功', { operation: 'get-queue-status', status });
    timer.end({ success: true });
    return status;
  }

  // 手动清空消息队列（紧急情况使用）
  clearMessageQueue(): void {
    const timer = logger.performance.start('clearMessageQueue', { gameId: this.game?.gameNumber });
    logger.game.info('手动清空消息队列', { operation: 'clear-queue' });
    this.diceService.clearMessageQueue();
    logger.game.info('消息队列清空成功', { operation: 'clear-queue' });
    timer.end({ success: true });
  }
}
