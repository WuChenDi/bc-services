import { BaseService, StorageService, DiceService, TimerService } from '@/services'
import type { ServiceContainer } from '@/services'
import type {
  GameProcessResult,
  GameServiceConfig,
  GameStats,
  ServiceHealthStatus,
  GameData,
  GameStatusResponse,
  PlaceBetResponse,
  StartGameResponse,
  ApiResponse,
} from '@/types'
import { BetType, GameState, TimerType } from '@/types'

import { formatBetSummary, formatGameResult, calculatePoints } from '@/utils'

/**
 * 游戏服务
 * 
 * 职责:
 * 1. 🎮 管理百家乐游戏的完整生命周期
 * 2. 🎲 协调骰子投掷和卡牌处理
 * 3. 💰 处理下注逻辑和验证
 * 4. ⏰ 管理游戏定时器和自动化
 * 5. 💾 保存游戏记录和状态
 * 6. 🛡️ 错误恢复和状态管理
 */
export class GameService extends BaseService {
  private game: GameData | null = null;
  private isProcessing: boolean = false;
  private gameCleanupScheduled: boolean = false;
  private revealingInProgress: boolean = false;
  private gameConfig: GameServiceConfig;
  private stats: GameStats;

  constructor(container: ServiceContainer) {
    super(container, {
      name: 'GameService',
      debug: false
    });

    // 初始化配置
    this.gameConfig = {
      bettingDurationMs: this.context.constants.BETTING_DURATION_MS,
      autoGameIntervalMs: this.context.constants.AUTO_GAME_INTERVAL_MS,
      globalProcessTimeoutMs: this.context.constants.GLOBAL_PROCESS_TIMEOUT_MS,
      cleanupDelayMs: this.context.constants.CLEANUP_DELAY_MS,
      maxBetAmount: 10000,
      maxUserTotalBet: 50000
    };

    // 初始化统计
    this.stats = {
      gamesStarted: 0,
      gamesCompleted: 0,
      gamesFailed: 0,
      totalBets: 0,
      totalAmount: 0,
      averageGameDuration: 0,
      activeGames: 0,
      lastGameTime: Date.now()
    };

    this.logger.info('游戏服务已初始化', {
      operation: 'game-service-init',
      config: this.gameConfig
    });
  }

  /**
   * 服务初始化
   */
  override async initialize(): Promise<void> {
    const timer = this.createTimer('initialize');

    try {
      // 从持久化存储恢复游戏状态
      this.game = await this.context.state?.storage.get('game') || null;

      if (this.game) {
        // 更新容器的游戏上下文
        this.container.updateGameContext(this.game.gameNumber, this.game.chatId);

        const now = Date.now();
        this.logger.info('正在初始化现有游戏', {
          gameId: this.game.gameNumber,
          state: this.game.state,
          chatId: this.game.chatId,
          bettingEndTime: this.game.bettingEndTime,
          currentTime: now
        });

        // 清理骰子服务的消息队列，避免旧消息干扰
        const diceService = this.getService(DiceService);
        diceService.clearMessageQueue();

        // 根据游戏状态进行恢复处理
        await this.recoverGameState(now);
      } else {
        this.logger.info('未找到现有游戏，准备开始新游戏');
      }

      timer.end({ hasExistingGame: !!this.game });
    } catch (error) {
      this.logger.error('初始化失败', { operation: 'initialize' }, error);
      await this.safeCleanupGame('初始化错误');
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 恢复游戏状态
   */
  private async recoverGameState(now: number): Promise<void> {
    if (!this.game) return;

    const timeSinceBettingEnd = now - this.game.bettingEndTime;

    switch (this.game.state) {
      case GameState.Betting:
        if (timeSinceBettingEnd > 30000) { // 超过30秒
          this.logger.warn('检测到下注状态卡住，自动处理', {
            operation: 'auto-recover-betting',
            timeDiff: timeSinceBettingEnd
          });
          await this.safeProcessGame();
        } else {
          this.logger.info('恢复下注定时器');
          this.setupCountdownTimers(this.game.chatId, this.game.gameNumber);
        }
        break;

      case GameState.Processing:
      case GameState.Revealing:
        this.logger.warn('检测到处理或开牌状态卡住，执行清理', {
          operation: 'cleanup-stuck-game',
          state: this.game.state
        });
        await this.safeCleanupGame('游戏在处理或开牌状态卡住');
        break;

      case GameState.Finished:
        // 检查是否需要自动开始下一局
        const autoGameEnabled = Boolean(await this.context.state?.storage.get('autoGame'));
        if (autoGameEnabled) {
          this.logger.info('恢复自动游戏模式');
          await this.handleGameCompletion();
        }
        break;
    }
  }

  /**
   * 开始新游戏
   */
  async startGame(chatId: string): Promise<StartGameResponse> {
    const timer = this.createTimer('start-game', { chatId });

    try {
      // 检查当前游戏状态
      if (this.game && this.game.state !== GameState.Finished) {
        this.logger.warn('游戏已在进行中', {
          operation: 'start-game',
          chatId,
          currentState: this.game.state,
          currentGameId: this.game.gameNumber
        });
        timer.end({ success: false, reason: 'game-in-progress' });
        return { success: false, error: '游戏已在进行中' };
      }

      // 清理旧游戏状态
      await this.safeCleanupGame('开始新游戏');
      this.resetAllFlags();

      // 生成新游戏
      const gameNumber = this.generateGameNumber();
      const now = Date.now();

      // 更新容器上下文
      this.container.updateGameContext(gameNumber, chatId);

      // 创建新游戏数据
      this.game = {
        gameNumber,
        state: GameState.Betting,
        bets: {},
        cards: { banker: [], player: [] },
        result: { banker: 0, player: 0, winner: null },
        startTime: now,
        bettingEndTime: now + this.gameConfig.bettingDurationMs,
        chatId
      };

      // 保存游戏状态
      await this.context.state?.storage.put('game', this.game);

      // 设置骰子服务的当前游戏ID，重置消息序列
      const diceService = this.getService(DiceService);
      diceService.setCurrentGame(gameNumber);

      // 设置倒计时定时器
      this.setupCountdownTimers(chatId, gameNumber);

      // 更新统计
      this.updateStats('started', now);

      this.logger.info('游戏启动成功', {
        operation: 'start-game',
        chatId,
        gameNumber,
        bettingDuration: this.gameConfig.bettingDurationMs,
        bettingEndTime: this.game.bettingEndTime
      });

      timer.end({
        success: true,
        gameNumber,
        bettingDuration: this.gameConfig.bettingDurationMs
      });

      return {
        success: true,
        gameNumber,
        bettingEndTime: this.game.bettingEndTime
      };
    } catch (error) {
      this.logger.error('启动游戏失败', {
        operation: 'start-game',
        chatId
      }, error);
      await this.safeCleanupGame('启动游戏失败');
      timer.end({ success: false, error: true });
      return { success: false, error: '无法启动游戏' };
    }
  }

  /**
   * 处理下注 - 完整的下注逻辑处理（修正版）
   * 
   * @param userId - 用户ID
   * @param userName - 用户名
   * @param betType - 下注类型 (banker/player/tie)
   * @param amount - 下注金额
   * @returns 下注结果
   */
  async placeBet(
    userId: string,
    userName: string,
    betType: BetType,
    amount: number
  ): Promise<PlaceBetResponse> {
    const timer = this.createTimer('place-bet', {
      userId,
      userName,
      betType,
      amount
    });

    try {
      // 第一步：验证游戏状态
      if (!this.game || this.game.state !== GameState.Betting) {
        this.logger.error('下注失败 - 无有效下注游戏', {
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

      // 第二步：检查下注时间
      const now = Date.now();
      if (now > this.game.bettingEndTime) {
        this.logger.error('下注失败 - 下注时间已结束', {
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

      // 第三步：验证参数有效性
      const validationResult = this.validateBetParameters(userId, userName, betType, amount);
      if (!validationResult.valid) {
        timer.end({ success: false, reason: 'invalid-parameters' });
        return { success: false, error: validationResult.error };
      }

      // 第四步：检查金额限制
      const limitCheckResult = this.checkBetLimits(userId, betType, amount);
      if (!limitCheckResult.valid) {
        timer.end({ success: false, reason: 'amount-limit' });
        return { success: false, error: limitCheckResult.error };
      }

      // 第五步：处理下注逻辑（核心业务逻辑）
      const betResult = this.processBetLogic(userId, userName, betType, amount);

      // 第六步：保存游戏状态
      await this.context.state?.storage.put('game', this.game);

      // 第七步：计算返回信息
      const remainingTime = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));
      const totalUsers = Object.keys(this.game.bets).length;

      // 修正：计算总下注金额和下注数量
      const { totalBetsAmount, totalBetsCount } = this.calculateGameTotalBets();

      // 第八步：更新统计
      this.updateStats('bet', undefined, amount);

      // 第九步：记录成功日志
      this.logger.info('下注成功', {
        operation: 'place-bet',
        userId,
        userName,
        betType,
        amount: betResult.finalAmount,
        isAccumulated: betResult.isAccumulated,
        isReplaced: betResult.isReplaced,
        remainingTime,
        totalUsers,
        totalBetsAmount,
        totalBetsCount
      });

      timer.end({
        success: true,
        betType,
        finalAmount: betResult.finalAmount,
        isAccumulated: betResult.isAccumulated
      });

      // 第十步：返回结果
      return {
        success: true,
        betType,
        amount: betResult.finalAmount,
        userName,
        remainingTime,
        totalBets: totalUsers,
        totalBetsAmount,
        totalBetsCount,
        ...betResult  // 包含 isAccumulated, isReplaced, previousAmount 等详细信息
      };
    } catch (error) {
      this.logger.error('下注失败', {
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

  /**
   * 计算游戏总下注金额和数量
   */
  private calculateGameTotalBets(): { totalBetsAmount: number; totalBetsCount: number } {
    if (!this.game) {
      return { totalBetsAmount: 0, totalBetsCount: 0 };
    }

    let totalBetsAmount = 0;
    let totalBetsCount = 0;

    // 遍历所有用户的下注
    Object.values(this.game.bets).forEach(userBets => {
      // 遍历每个用户的所有下注类型
      Object.entries(userBets).forEach(([key, value]) => {
        // 跳过userName字段，只统计实际下注
        if (key !== 'userName' && typeof value === 'number' && value > 0) {
          totalBetsAmount += value;
          totalBetsCount += 1;
        }
      });
    });

    return { totalBetsAmount, totalBetsCount };
  }

  /**
   * 验证下注参数
   */
  private validateBetParameters(
    userId: string,
    userName: string,
    betType: BetType,
    amount: number
  ): { valid: boolean; error?: string } {
    if (!Object.values(BetType).includes(betType)) {
      return {
        valid: false,
        error: '下注类型错误\n可选类型: banker(庄家), player(闲家), tie(和局)'
      };
    }

    if (!userId || !userName) {
      return {
        valid: false,
        error: '用户信息不完整'
      };
    }

    if (isNaN(amount) || amount <= 0) {
      return {
        valid: false,
        error: '下注金额必须是大于0的数字'
      };
    }

    return { valid: true };
  }

  /**
   * 检查下注金额限制
   */
  private checkBetLimits(
    userId: string,
    betType: BetType,
    amount: number
  ): { valid: boolean; error?: string } {
    if (!this.game) {
      return { valid: false, error: '游戏状态异常' };
    }

    // 单次下注限制
    if (amount > this.gameConfig.maxBetAmount) {
      return {
        valid: false,
        error: `单次下注金额不能超过${this.gameConfig.maxBetAmount}点`
      };
    }

    const userBets = this.game.bets[userId];
    if (userBets) {
      // 累加后单项限制
      const existingAmount = userBets[betType] || 0;
      const newAmount = existingAmount + amount;

      if (newAmount > this.gameConfig.maxBetAmount) {
        return {
          valid: false,
          error: `${betType}累加后金额${newAmount}点超过单次下注限制${this.gameConfig.maxBetAmount}点\n当前已下注${existingAmount}点`
        };
      }

      // 用户总下注限制
      const currentTotal = this.calculateUserTotalBets(userBets);
      if (currentTotal + amount > this.gameConfig.maxUserTotalBet) {
        return {
          valid: false,
          error: `总下注金额不能超过${this.gameConfig.maxUserTotalBet}点\n当前总下注：${currentTotal}点`
        };
      }
    }

    return { valid: true };
  }

  /**
   * 计算用户总下注金额
   */
  private calculateUserTotalBets(userBets: any): number {
    return Object.entries(userBets).reduce((sum: number, [key, value]) => {
      if (key !== 'userName' && typeof value === 'number') {
        return sum + value;
      }
      return sum;
    }, 0);
  }

  /**
   * 处理下注逻辑
   */
  private processBetLogic(
    userId: string,
    userName: string,
    betType: BetType,
    amount: number
  ): {
    finalAmount: number;
    isAccumulated?: boolean;
    isReplaced?: boolean;
    previousAmount?: number;
    addedAmount?: number;
    previousBetType?: BetType;
  } {
    if (!this.game) {
      throw new Error('Game state is null');
    }

    // 初始化用户下注记录
    if (!this.game.bets[userId]) {
      this.game.bets[userId] = { userName };
    }

    const userBets = this.game.bets[userId];
    const existingAmount = userBets[betType] || 0;

    // 检查是否有其他类型的下注需要替换
    let previousBetType: BetType | undefined;
    let previousAmount: number | undefined;

    if (existingAmount === 0) {
      // 检查是否有其他类型的下注
      for (const [key, value] of Object.entries(userBets)) {
        if (key !== 'userName' && typeof value === 'number' && value > 0) {
          previousBetType = key as BetType;
          previousAmount = value;
          // 清除之前的下注
          delete userBets[key as BetType];
          break;
        }
      }
    }

    // 设置新的下注
    const finalAmount = existingAmount + amount;
    userBets[betType] = finalAmount;
    userBets.userName = userName;

    if (existingAmount > 0) {
      // 累加下注
      return {
        finalAmount,
        isAccumulated: true,
        previousAmount: existingAmount,
        addedAmount: amount
      };
    } else if (previousBetType && previousAmount) {
      // 替换下注
      return {
        finalAmount,
        isReplaced: true,
        previousBetType,
        previousAmount
      };
    } else {
      // 首次下注
      return {
        finalAmount
      };
    }
  }

  /**
   * 处理游戏（立即开牌）
   */
  async processGame(): Promise<GameProcessResult> {
    const timer = this.createTimer('process-game', { gameId: this.game?.gameNumber });
    this.logger.info('开始处理游戏', { operation: 'process-game' });

    const result = await this.safeProcessGame();
    timer.end({ success: true });

    return {
      success: true,
      gameNumber: this.game?.gameNumber
    };
  }

  /**
   * 安全处理游戏
   */
  private async safeProcessGame(): Promise<void> {
    const timer = this.createTimer('safe-process-game', { gameId: this.game?.gameNumber });

    if (!this.game || this.game.state !== GameState.Betting) {
      this.logger.warn('无可处理游戏或游戏不在下注状态', {
        operation: 'safe-process',
        state: this.game?.state
      });
      timer.end({ success: false, reason: 'no-active-betting' });
      return;
    }

    if (this.isProcessing) {
      this.logger.warn('游戏已在处理中，跳过', { operation: 'safe-process' });
      timer.end({ success: false, reason: 'already-processing' });
      return;
    }

    this.logger.info('开始处理游戏', {
      operation: 'safe-process',
      gameId: this.game.gameNumber
    });

    this.isProcessing = true;

    // 设置全局超时保护
    const globalTimeoutId = setTimeout(async () => {
      this.logger.error('游戏处理超时，强制清理', { operation: 'timeout-cleanup' });
      await this.forceCleanupGame('全局处理超时');
    }, this.gameConfig.globalProcessTimeoutMs);

    try {
      // 更新游戏状态
      this.game.state = GameState.Processing;
      await this.context.state?.storage.put('game', this.game);

      this.logger.info('游戏状态更新为处理中', {
        operation: 'state-update',
        newState: GameState.Processing
      });

      // 清除所有定时器
      const timerService = this.getService(TimerService);
      timerService.cancelTimersByType(TimerType.COUNTDOWN, this.game.gameNumber);
      timerService.cancelTimersByType(TimerType.AUTO_PROCESS, this.game.gameNumber);

      const betsCount = Object.keys(this.game.bets).length;
      this.logger.info('获取下注人数', { operation: 'get-bets', count: betsCount });

      // 发送下注汇总消息
      const diceService = this.getService(DiceService);
      if (betsCount === 0) {
        await diceService.sendBlockingMessage(
          this.game.chatId,
          `😔 **第 ${this.game.gameNumber} 局无人下注**\n\n🎲 但游戏继续进行，开始发牌...`
        );
        this.logger.info('发送无人下注消息', { operation: 'send-message' });
      } else {
        await diceService.sendBlockingMessage(
          this.game.chatId,
          formatBetSummary(this.game)
        );
        this.logger.info('发送下注汇总', { operation: 'send-summary', betsCount });
      }

      // 开始开牌阶段
      await this.startRevealing();

      clearTimeout(globalTimeoutId);
      this.logger.info('开牌阶段开始', { operation: 'start-revealing' });
    } catch (error) {
      clearTimeout(globalTimeoutId);
      this.logger.error('处理游戏失败', { operation: 'safe-process' }, error);
      await this.forceCleanupGame('处理游戏失败');
      throw error;
    } finally {
      this.isProcessing = false;
      timer.end({ success: true });
    }
  }

  /**
   * 开始开牌阶段
   */
  private async startRevealing(): Promise<void> {
    const timer = this.createTimer('start-revealing', { gameId: this.game?.gameNumber });

    if (!this.game || this.revealingInProgress) {
      this.logger.warn('无游戏或开牌已在进行中', {
        operation: 'start-revealing',
        revealingInProgress: this.revealingInProgress
      });
      timer.end({ success: false, reason: 'no-game-or-in-progress' });
      return;
    }

    try {
      this.logger.info('开始游戏开牌阶段', {
        operation: 'start-revealing',
        gameId: this.game.gameNumber
      });

      this.revealingInProgress = true;
      this.game.state = GameState.Revealing;
      await this.context.state?.storage.put('game', this.game);

      this.logger.info('游戏状态更新为开牌中', {
        operation: 'state-update',
        newState: GameState.Revealing
      });

      // 发送开牌开始消息
      const diceService = this.getService(DiceService);
      await diceService.sendBlockingMessage(
        this.game.chatId,
        `🎲 **开牌阶段开始！**\n\n🃏 庄家和闲家各发两张牌...`
      );

      this.logger.info('发送开牌开始消息', { operation: 'send-message' });

      // 开始发牌
      await this.dealCards();
      this.logger.info('发牌完成，进入结果计算', { operation: 'deal-cards' });

      // 计算并发送结果
      await this.calculateAndSendResult();
    } catch (error) {
      this.logger.error('开牌失败', { operation: 'start-revealing' }, error);

      const diceService = this.getService(DiceService);
      await diceService.sendBlockingMessage(
        this.game.chatId,
        '❌ 开牌过程失败，游戏终止。请使用 /newgame 重新开始'
      );

      await this.forceCleanupGame('开牌失败');
      throw error;
    } finally {
      this.revealingInProgress = false;
      timer.end({ success: true });
    }
  }

  /**
   * 发牌处理
   */
  private async dealCards(): Promise<void> {
    const timer = this.createTimer('deal-cards', { gameId: this.game?.gameNumber });

    if (!this.game) {
      this.logger.warn('无可用游戏进行发牌', { operation: 'deal-cards' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    this.logger.info('开始按严格顺序发牌', { operation: 'deal-cards' });

    try {
      const diceService = this.getService(DiceService);

      // 严格按顺序发牌，每张牌等待完成
      this.logger.debug('发庄家第1张牌', { operation: 'deal-card', player: 'banker', cardIndex: 1 });
      const bankerCard1Result = await diceService.rollDice(this.game.chatId, 'banker', 1);
      if (!bankerCard1Result.success || !bankerCard1Result.value) {
        throw new Error('Failed to roll banker card 1');
      }
      this.game.cards.banker.push(bankerCard1Result.value);

      this.logger.debug('发闲家第1张牌', { operation: 'deal-card', player: 'player', cardIndex: 1 });
      const playerCard1Result = await diceService.rollDice(this.game.chatId, 'player', 1);
      if (!playerCard1Result.success || !playerCard1Result.value) {
        throw new Error('Failed to roll player card 1');
      }
      this.game.cards.player.push(playerCard1Result.value);

      this.logger.debug('发庄家第2张牌', { operation: 'deal-card', player: 'banker', cardIndex: 2 });
      const bankerCard2Result = await diceService.rollDice(this.game.chatId, 'banker', 2);
      if (!bankerCard2Result.success || !bankerCard2Result.value) {
        throw new Error('Failed to roll banker card 2');
      }
      this.game.cards.banker.push(bankerCard2Result.value);

      this.logger.debug('发闲家第2张牌', { operation: 'deal-card', player: 'player', cardIndex: 2 });
      const playerCard2Result = await diceService.rollDice(this.game.chatId, 'player', 2);
      if (!playerCard2Result.success || !playerCard2Result.value) {
        throw new Error('Failed to roll player card 2');
      }
      this.game.cards.player.push(playerCard2Result.value);

      // 保存发牌结果
      await this.context.state?.storage.put('game', this.game);
      this.logger.info('发牌完成并保存', { operation: 'save-cards' });

      const bankerSum = calculatePoints(this.game.cards.banker);
      const playerSum = calculatePoints(this.game.cards.player);

      // 发牌完成后发送汇总
      await diceService.sendBlockingMessage(
        this.game.chatId,
        `📊 **前两张牌点数:**\n` +
        `🏦 庄家: ${this.game.cards.banker.join(' + ')} = **${bankerSum} 点**\n` +
        `👤 闲家: ${this.game.cards.player.join(' + ')} = **${playerSum} 点**`
      );

      this.logger.info('发送前两张牌汇总', {
        operation: 'send-summary',
        bankerSum,
        playerSum
      });

      // 判断是否需要补牌
      if (bankerSum >= 8 || playerSum >= 8) {
        await diceService.sendBlockingMessage(
          this.game.chatId,
          '🎯 **天牌！无需补牌！**'
        );
        this.logger.info('检测到天牌，无需补牌', {
          operation: 'natural-win',
          bankerSum,
          playerSum
        });
      } else {
        await this.handleThirdCard(bankerSum, playerSum);
      }

      timer.end({ success: true, cardsDealt: 4 });
    } catch (error) {
      this.logger.error('发牌失败', { operation: 'deal-cards' }, error);
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 处理第三张牌
   */
  private async handleThirdCard(bankerSum: number, playerSum: number): Promise<void> {
    const timer = this.createTimer('handle-third-card', { gameId: this.game?.gameNumber });

    if (!this.game) {
      this.logger.warn('无可用游戏进行补牌处理', { operation: 'handle-third-card' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      const diceService = this.getService(DiceService);
      let playerThirdCard: number | null = null;

      // 闲家补牌逻辑
      if (playerSum <= 5) {
        await diceService.sendBlockingMessage(
          this.game.chatId,
          '👤 **闲家需要补牌...**'
        );
        this.logger.info('闲家需要补牌', { operation: 'handle-third-card', playerSum });

        this.logger.debug('发闲家第3张牌', { operation: 'deal-card', player: 'player', cardIndex: 3 });
        const playerCard3Result = await diceService.rollDice(this.game.chatId, 'player', 3);
        if (!playerCard3Result.success || !playerCard3Result.value) {
          throw new Error('Failed to roll player card 3');
        }

        playerThirdCard = playerCard3Result.value;
        this.game.cards.player.push(playerThirdCard);
        this.logger.info('闲家补牌完成', { operation: 'deal-card', cardValue: playerThirdCard });
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
        await diceService.sendBlockingMessage(
          this.game.chatId,
          '🏦 **庄家需要补牌...**'
        );
        this.logger.info('庄家需要补牌', { operation: 'handle-third-card', bankerSum });

        this.logger.debug('发庄家第3张牌', { operation: 'deal-card', player: 'banker', cardIndex: 3 });
        const bankerCard3Result = await diceService.rollDice(this.game.chatId, 'banker', 3);
        if (!bankerCard3Result.success || !bankerCard3Result.value) {
          throw new Error('Failed to roll banker card 3');
        }

        this.game.cards.banker.push(bankerCard3Result.value);
        this.logger.info('庄家补牌完成', { operation: 'deal-card', cardValue: bankerCard3Result.value });
      }

      await this.context.state?.storage.put('game', this.game);
      this.logger.info('补牌处理完成并保存', { operation: 'save-third-cards' });

      timer.end({
        success: true,
        playerThirdCard: !!playerThirdCard,
        bankerThirdCard: bankerNeedCard
      });
    } catch (error) {
      this.logger.error('补牌处理失败', { operation: 'handle-third-card' }, error);
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 计算并发送游戏结果
   */
  private async calculateAndSendResult(): Promise<void> {
    const timer = this.createTimer('calculate-and-send-result', { gameId: this.game?.gameNumber });

    if (!this.game) {
      this.logger.warn('无可用游戏进行结果计算', { operation: 'calculate-result' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      this.logger.info('开始计算游戏结果', {
        operation: 'calculate-result',
        gameId: this.game.gameNumber
      });

      // 计算最终点数
      const bankerFinal = calculatePoints(this.game.cards.banker);
      const playerFinal = calculatePoints(this.game.cards.player);

      this.game.result.banker = bankerFinal;
      this.game.result.player = playerFinal;

      // 确定获胜方
      if (bankerFinal > playerFinal) {
        this.game.result.winner = BetType.Banker;
      } else if (playerFinal > bankerFinal) {
        this.game.result.winner = BetType.Player;
      } else {
        this.game.result.winner = BetType.Tie;
      }

      this.game.state = GameState.Finished;
      await this.context.state?.storage.put('game', this.game);

      this.logger.info('游戏结果计算并保存', {
        operation: 'save-result',
        winner: this.game.result.winner,
        bankerPoints: bankerFinal,
        playerPoints: playerFinal
      });

      // 异步保存游戏记录
      this.saveGameRecordAsync();

      // 发送最终结果
      const autoGameEnabled = Boolean(await this.context.state?.storage.get('autoGame'));
      const diceService = this.getService(DiceService);

      await diceService.sendBlockingMessage(
        this.game.chatId,
        formatGameResult(this.game, {
          isAutoGameEnabled: autoGameEnabled,
          nextGameDelaySeconds: this.gameConfig.autoGameIntervalMs / 1000
        })
      );

      this.logger.info('发送最终游戏结果', { operation: 'send-result' });

      // 更新统计
      this.updateStats('completed', this.game.startTime);

      this.isProcessing = false;
      await this.handleGameCompletion();

      timer.end({ success: true, winner: this.game.result.winner });
    } catch (error) {
      this.logger.error('计算并发送结果失败', { operation: 'calculate-result' }, error);
      await this.forceCleanupGame('计算结果失败');
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 异步保存游戏记录
   */
  private async saveGameRecordAsync(): Promise<void> {
    const timer = this.createTimer('save-game-record-async', { gameId: this.game?.gameNumber });

    if (!this.game) {
      this.logger.warn('无可用游戏保存记录', { operation: 'save-record' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      const storageService = this.getService(StorageService);
      const result = await storageService.saveGameRecord(this.game);

      if (result.success) {
        this.logger.info('游戏记录保存成功', {
          operation: 'save-record',
          gameId: this.game.gameNumber
        });
      } else {
        this.logger.error('游戏记录保存失败', {
          operation: 'save-record',
          error: result.error
        });
      }

      timer.end({ success: result.success });
    } catch (saveError) {
      this.logger.error('保存游戏记录失败', { operation: 'save-record' }, saveError);
      timer.end({ success: false, error: true });
    }
  }

  /**
   * 处理游戏完成
   */
  private async handleGameCompletion(): Promise<void> {
    const timer = this.createTimer('handle-game-completion', { gameId: this.game?.gameNumber });

    if (!this.game) {
      this.logger.warn('无可用游戏进行完成处理', { operation: 'handle-completion' });
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    try {
      const autoGameEnabled = await this.context.state?.storage.get('autoGame');
      this.logger.info('游戏完成，检查自动游戏状态', {
        operation: 'handle-completion',
        autoGameEnabled
      });

      const timerService = this.getService(TimerService);

      if (autoGameEnabled) {
        // 设置下一局自动游戏定时器
        timerService.createGameTimer(
          TimerType.NEXT_GAME,
          'auto-next-game',
          this.gameConfig.autoGameIntervalMs,
          async () => {
            try {
              this.logger.info('启动下一局自动游戏', { operation: 'auto-next-game' });
              const stillAutoEnabled = await this.context.state?.storage.get('autoGame');
              if (stillAutoEnabled && this.game) {
                await this.startAutoGame(this.game.chatId);
              } else {
                this.logger.info('自动游戏已禁用或无游戏，执行清理', { operation: 'auto-cleanup' });
                await this.safeCleanupGame('自动游戏已禁用');
              }
            } catch (autoError) {
              this.logger.error('自动游戏失败', { operation: 'auto-next-game' }, autoError);
              await this.safeCleanupGame('自动游戏错误');
            }
          },
          {
            gameId: this.game.gameNumber,
            chatId: this.game.chatId
          }
        );

        this.logger.info('下一局自动游戏已调度', {
          operation: 'schedule-auto',
          delayMs: this.gameConfig.autoGameIntervalMs
        });
      } else {
        // 设置清理定时器
        timerService.createGameTimer(
          TimerType.CLEANUP,
          'game-cleanup',
          this.gameConfig.cleanupDelayMs,
          async () => {
            await this.safeCleanupGame('游戏结束后手动清理');
          },
          {
            gameId: this.game.gameNumber,
            chatId: this.game.chatId
          }
        );

        this.logger.info('游戏清理已调度', {
          operation: 'schedule-cleanup',
          delayMs: this.gameConfig.cleanupDelayMs
        });
      }

      timer.end({ success: true });
    } catch (error) {
      this.logger.error('处理游戏完成失败', { operation: 'handle-completion' }, error);
      await this.safeCleanupGame('游戏完成处理错误');
      timer.end({ success: false, error: true });
    }
  }

  /**
   * 启动自动游戏
   */
  async startAutoGame(chatId: string): Promise<void> {
    const timer = this.createTimer('start-auto-game', { chatId });

    try {
      this.logger.info('为聊天ID启动自动游戏', { operation: 'start-auto-game', chatId });
      const result = await this.startGame(chatId);

      if (result.success) {
        const diceService = this.getService(DiceService);
        await diceService.sendBlockingMessage(
          chatId,
          `🤖 **自动游戏 - 第 ${result.gameNumber} 局开始！**\n\n` +
          `💰 下注时间：30秒\n` +
          `📝 下注格式：/bet banker 100\n` +
          `⏰ 30秒后将自动处理游戏...\n` +
          `🔄 游戏将持续自动进行`
        );
        this.logger.info('自动游戏启动成功', { operation: 'start-auto-game', gameId: result.gameNumber });
      } else {
        this.logger.error('启动自动游戏失败', { operation: 'start-auto-game', chatId }, result.error);
        await this.safeCleanupGame('自动游戏启动失败');
      }

      timer.end({ success: result.success });
    } catch (error) {
      this.logger.error('启动自动游戏失败', { operation: 'start-auto-game', chatId }, error);
      await this.safeCleanupGame('启动自动游戏错误');
      timer.end({ success: false, error: true });
    }
  }

  /**
   * 启用自动游戏
   */
  async enableAutoGame(chatId: string): Promise<ApiResponse> {
    const timer = this.createTimer('enable-auto-game', { chatId });

    try {
      this.logger.info('启用自动游戏', { operation: 'enable-auto-game', chatId });
      await this.context.state?.storage.put('autoGame', true);

      if (!this.game || this.game.state === GameState.Finished) {
        await this.startAutoGame(chatId);
      }

      this.logger.info('自动游戏启用成功', { operation: 'enable-auto-game' });
      timer.end({ success: true });
      return { success: true, message: '自动游戏已启用' };
    } catch (error) {
      this.logger.error('启用自动游戏失败', { operation: 'enable-auto-game', chatId }, error);
      timer.end({ success: false, error: true });
      return { success: false, error: '无法启用自动游戏' };
    }
  }

  /**
   * 禁用自动游戏
   */
  async disableAutoGame(): Promise<ApiResponse> {
    const timer = this.createTimer('disable-auto-game');

    try {
      this.logger.info('禁用自动游戏', { operation: 'disable-auto-game' });
      await this.context.state?.storage.put('autoGame', false);

      // 取消所有自动游戏相关的定时器
      const timerService = this.getService(TimerService);
      const cancelledCount = timerService.cancelTimersByType(TimerType.NEXT_GAME);

      // 清空消息队列，停止所有待处理的消息
      const diceService = this.getService(DiceService);
      diceService.clearMessageQueue();

      this.logger.info('自动游戏已禁用且消息队列已清空', {
        operation: 'disable-auto-game',
        cancelledTimers: cancelledCount
      });

      timer.end({ success: true });
      return { success: true, message: '自动游戏已禁用' };
    } catch (error) {
      this.logger.error('禁用自动游戏失败', { operation: 'disable-auto-game' }, error);
      timer.end({ success: false, error: true });
      return { success: false, error: '无法禁用自动游戏' };
    }
  }

  /**
   * 设置倒计时定时器
   */
  private setupCountdownTimers(chatId: string, gameNumber: string): void {
    const timer = this.createTimer('setup-countdown-timers', { gameId: gameNumber });

    this.logger.info('为游戏设置倒计时定时器', {
      operation: 'setup-timers',
      gameId: gameNumber
    });

    if (!this.game) {
      timer.end({ success: false, reason: 'no-game' });
      return;
    }

    const timerService = this.getService(TimerService);
    const diceService = this.getService(DiceService);

    // 清除可能存在的旧定时器
    timerService.cancelTimersByType(TimerType.COUNTDOWN, gameNumber);
    timerService.cancelTimersByType(TimerType.AUTO_PROCESS, gameNumber);

    const gameEndTime = this.game.bettingEndTime;
    const intervals = [20, 10, 5];

    // 设置倒计时提醒定时器
    intervals.forEach(seconds => {
      const reminderTime = gameEndTime - (seconds * 1000);
      const timeToReminder = reminderTime - Date.now();

      if (timeToReminder > 0) {
        timerService.createGameTimer(
          TimerType.COUNTDOWN,
          `countdown-${seconds}s`,
          timeToReminder,
          () => {
            if (this.game && this.game.state === GameState.Betting && this.game.gameNumber === gameNumber) {
              diceService.sendMessage(
                chatId,
                `⏰ **下注倒计时：${seconds}秒！**\n\n` +
                `👥 当前参与人数：${Object.keys(this.game.bets).length}\n` +
                `💡 抓紧时间下注哦~`
              );
              this.logger.debug('发送倒计时消息', { operation: 'send-countdown', remainingSeconds: seconds });
            }
          },
          {
            gameId: gameNumber,
            chatId: chatId
          }
        );
      }
    });

    // 设置游戏自动处理定时器
    const timeToGameEnd = gameEndTime - Date.now();
    if (timeToGameEnd > 0) {
      timerService.createGameTimer(
        TimerType.AUTO_PROCESS,
        'auto-process-game',
        timeToGameEnd,
        async () => {
          try {
            if (this.game && this.game.state === GameState.Betting && this.game.gameNumber === gameNumber) {
              this.logger.info('自动处理游戏', { operation: 'auto-process', gameId: gameNumber });

              // 发送停止下注消息
              diceService.sendMessage(
                chatId,
                `⛔ **第 ${this.game.gameNumber} 局停止下注！**\n\n🎲 开始自动处理游戏...`
              );

              await this.safeProcessGame();
            }
          } catch (error) {
            this.logger.error('自动处理定时器失败', { operation: 'auto-process' }, error);
            await this.forceCleanupGame('自动处理定时器错误');
          }
        },
        {
          gameId: gameNumber,
          chatId: chatId
        }
      );
    }

    this.logger.info('动态倒计时定时器设置完成', {
      operation: 'setup-timers',
      reminderTimers: intervals.length,
      autoProcessTimer: timeToGameEnd > 0 ? 1 : 0
    });

    timer.end({ success: true, timersSet: intervals.length + (timeToGameEnd > 0 ? 1 : 0) });
  }

  /**
   * 重置所有标志
   */
  private resetAllFlags(): void {
    this.logger.debug('重置所有标志', {
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

  /**
   * 强制清理游戏
   */
  private async forceCleanupGame(reason?: string): Promise<void> {
    this.logger.warn('强制清理游戏', {
      operation: 'force-cleanup',
      reason: reason || '手动清理',
      gameId: this.game?.gameNumber
    });

    try {
      // 取消所有定时器
      const timerService = this.getService(TimerService);
      const cancelledCount = timerService.cancelAllTimers();

      // 重置标志
      this.resetAllFlags();

      // 清空消息队列
      const diceService = this.getService(DiceService);
      diceService.clearMessageQueue();

      const oldGameId = this.game?.gameNumber;
      this.game = null;

      // 删除持久化状态
      await this.context.state?.storage.delete('game');

      // 清除容器上下文中的游戏ID
      this.container.clearGameContext();

      this.logger.info('游戏强制清理成功', {
        operation: 'force-cleanup',
        cleanedGameId: oldGameId,
        cancelledTimers: cancelledCount
      });
    } catch (error) {
      this.logger.error('强制清理游戏失败', { operation: 'force-cleanup' }, error);
    }
  }

  /**
   * 安全清理游戏
   */
  private async safeCleanupGame(reason?: string): Promise<void> {
    const timer = this.createTimer('safe-cleanup-game', { gameId: this.game?.gameNumber });

    if (this.gameCleanupScheduled) {
      this.logger.info('游戏清理已调度，跳过', { operation: 'safe-cleanup' });
      timer.end({ success: false, reason: 'already-scheduled' });
      return;
    }

    this.gameCleanupScheduled = true;

    try {
      this.logger.info('开始清理游戏', { operation: 'safe-cleanup', reason: reason || '手动清理' });

      // 取消所有定时器
      const timerService = this.getService(TimerService);
      timerService.cancelAllTimers();

      // 重置标志
      this.resetAllFlags();

      // 清空消息队列
      const diceService = this.getService(DiceService);
      diceService.clearMessageQueue();

      this.game = null;
      await this.context.state?.storage.delete('game');

      this.logger.info('游戏清理成功', { operation: 'safe-cleanup' });
    } catch (error) {
      this.logger.error('清理游戏失败', { operation: 'safe-cleanup' }, error);
    } finally {
      this.gameCleanupScheduled = false;
      timer.end({ success: true });
    }
  }

  /**
   * 清理游戏（外部调用）
   */
  async cleanupGame(): Promise<void> {
    const timer = this.createTimer('cleanup-game', { gameId: this.game?.gameNumber });
    this.logger.info('发起外部清理请求', { operation: 'cleanup-game' });
    await this.safeCleanupGame('外部清理请求');
    timer.end({ success: true });
  }

  /**
   * 生成游戏编号
   */
  private generateGameNumber(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    const randomStr = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    return `${dateStr}${timeStr}${randomStr}`;
  }

  /**
   * 更新统计信息
   */
  private updateStats(
    action: 'started' | 'completed' | 'failed' | 'bet',
    startTime?: number,
    amount?: number
  ): void {
    const now = Date.now();

    switch (action) {
      case 'started':
        this.stats.gamesStarted++;
        this.stats.activeGames = 1;
        this.stats.lastGameTime = now;
        break;

      case 'completed':
        this.stats.gamesCompleted++;
        this.stats.activeGames = 0;
        if (startTime) {
          const duration = now - startTime;
          const totalDuration = this.stats.averageGameDuration * (this.stats.gamesCompleted - 1) + duration;
          this.stats.averageGameDuration = totalDuration / this.stats.gamesCompleted;
        }
        break;

      case 'failed':
        this.stats.gamesFailed++;
        this.stats.activeGames = 0;
        break;

      case 'bet':
        this.stats.totalBets++;
        if (amount) {
          this.stats.totalAmount += amount;
        }
        break;
    }
  }

  /**
   * 获取游戏状态
   */
  async getGameStatus(): Promise<GameStatusResponse> {
    const timer = this.createTimer('get-game-status', { gameId: this.game?.gameNumber });

    try {
      this.logger.info('获取游戏状态', { operation: 'get-status' });
      const autoGameEnabled = Boolean(await this.context.state?.storage.get('autoGame'));

      if (!this.game) {
        this.logger.info('无有效游戏，返回无游戏状态', { operation: 'get-status' });
        timer.end({ success: true, status: 'no_game' });
        return {
          success: true,
          status: {
            state: 'no_game',
            autoGameEnabled,
            totalBets: 0,
            betsCount: 0
          }
        };
      }

      const now = Date.now();
      const timeRemaining = Math.max(0, Math.floor((this.game.bettingEndTime - now) / 1000));

      // 计算总下注统计
      const { totalBetsAmount, totalBetsCount } = this.calculateGameTotalBets();

      // 添加调试信息
      const diceService = this.getService(DiceService);
      const queueStatus = diceService.getQueueStatus();

      const statusResponse: GameStatusResponse = {
        success: true,
        status: {
          gameNumber: this.game.gameNumber,
          state: this.game.state,
          betsCount: Object.keys(this.game.bets).length, // 参与下注的用户数
          totalBets: totalBetsAmount, // 总下注金额
          totalBetsCount: totalBetsCount, // 总下注数量
          bets: this.game.bets,
          timeRemaining: this.game.state === GameState.Betting ? timeRemaining : 0,
          result: this.game.result,
          needsProcessing: this.game.state === GameState.Betting && now >= this.game.bettingEndTime,
          autoGameEnabled,
          isAutoMode: autoGameEnabled,
          debug: {
            queueLength: queueStatus.queueLength,
            queueProcessing: queueStatus.processing,
            isProcessing: this.isProcessing,
            revealingInProgress: this.revealingInProgress
          }
        }
      };

      this.logger.info('游戏状态获取成功', {
        operation: 'get-status',
        state: this.game.state,
        totalBetsAmount,
        totalBetsCount,
        usersCount: Object.keys(this.game.bets).length
      });

      timer.end({ success: true, status: this.game.state });
      return statusResponse;
    } catch (error) {
      this.logger.error('获取游戏状态失败', { operation: 'get-status' }, error);
      timer.end({ success: false, error: true });
      return {
        success: false,
        error: '获取游戏状态失败',
        status: {
          state: 'error',
          autoGameEnabled: false,
          totalBets: 0,
          betsCount: 0
        }
      };
    }
  }

  /**
   * 获取游戏统计信息
   */
  getStats(): GameStats {
    return { ...this.stats };
  }

  /**
   * 获取游戏配置
   */
  getGameConfig(): GameServiceConfig {
    return { ...this.gameConfig };
  }

  /**
   * 更新游戏配置
   */
  updateGameConfig(newConfig: Partial<GameServiceConfig>): void {
    const oldConfig = { ...this.gameConfig };
    this.gameConfig = { ...this.gameConfig, ...newConfig };

    this.logger.info('游戏服务配置已更新', {
      operation: 'update-game-config',
      oldConfig,
      newConfig: this.gameConfig
    });
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      gamesStarted: 0,
      gamesCompleted: 0,
      gamesFailed: 0,
      totalBets: 0,
      totalAmount: 0,
      averageGameDuration: 0,
      activeGames: this.game ? 1 : 0,
      lastGameTime: Date.now()
    };

    this.logger.info('游戏统计信息已重置', {
      operation: 'reset-stats'
    });
  }

  /**
   * 获取消息队列状态（用于调试）
   */
  getMessageQueueStatus() {
    const timer = this.createTimer('get-message-queue-status', { gameId: this.game?.gameNumber });
    this.logger.info('获取消息队列状态', { operation: 'get-queue-status' });

    try {
      const diceService = this.getService(DiceService);
      const status = diceService.getQueueStatus();
      this.logger.debug('消息队列状态获取成功', { operation: 'get-queue-status', status });
      timer.end({ success: true });
      return status;
    } catch (error) {
      this.logger.error('获取消息队列状态失败', { operation: 'get-queue-status' }, error);
      timer.end({ success: false, error: true });
      return null;
    }
  }

  /**
   * 手动清空消息队列（紧急情况使用）
   */
  clearMessageQueue(): void {
    const timer = this.createTimer('clear-message-queue', { gameId: this.game?.gameNumber });
    this.logger.info('手动清空消息队列', { operation: 'clear-queue' });

    try {
      const diceService = this.getService(DiceService);
      diceService.clearMessageQueue();
      this.logger.info('消息队列清空成功', { operation: 'clear-queue' });
      timer.end({ success: true });
    } catch (error) {
      this.logger.error('清空消息队列失败', { operation: 'clear-queue' }, error);
      timer.end({ success: false, error: true });
    }
  }

  /**
   * 自定义健康检查
   */
  protected override getCustomHealth(): Partial<ServiceHealthStatus> {
    const stats = this.getStats();
    const queueStatus = this.getMessageQueueStatus();

    // 检查游戏状态
    const hasStuckGame = this.game &&
      (this.isProcessing || this.revealingInProgress) &&
      (Date.now() - this.stats.lastGameTime) > 300000; // 5分钟

    // 检查失败率
    const totalGames = stats.gamesCompleted + stats.gamesFailed;
    const failureRate = totalGames > 0 ? stats.gamesFailed / totalGames : 0;
    const highFailureRate = failureRate > 0.1; // 10%失败率

    // 检查队列状态
    const queueIssues = queueStatus && (
      queueStatus.queueLength > 20 ||
      (queueStatus.processing && (Date.now() - this.stats.lastGameTime) > 60000)
    );

    const isHealthy = !hasStuckGame && !highFailureRate && !queueIssues;

    const issues: string[] = [];
    if (hasStuckGame) issues.push('检测到卡住的游戏');
    if (highFailureRate) issues.push(`高失败率: ${(failureRate * 100).toFixed(1)}%`);
    if (queueIssues) issues.push('消息队列异常');

    return {
      healthy: isHealthy,
      message: isHealthy
        ? 'Game service is operating normally'
        : `Issues detected: ${issues.join(', ')}`,
      details: {
        stats,
        queueStatus,
        currentGame: this.game ? {
          gameNumber: this.game.gameNumber,
          state: this.game.state,
          betsCount: Object.keys(this.game.bets).length
        } : null,
        flags: {
          isProcessing: this.isProcessing,
          revealingInProgress: this.revealingInProgress,
          gameCleanupScheduled: this.gameCleanupScheduled
        },
        issues,
        config: this.gameConfig
      }
    };
  }

  /**
   * 服务上下文更新处理
   */
  protected override onContextUpdate(newContext: ServiceContainer['context']): void {
    // 当上下文更新时，确保游戏ID同步
    if (newContext.gameId !== this.game?.gameNumber) {
      this.logger.debug('检测到游戏上下文变更', {
        operation: 'context-game-change',
        oldGameId: this.game?.gameNumber,
        newGameId: newContext.gameId
      });
    }
  }

  /**
   * 清理资源
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();

    // 强制清理游戏状态
    await this.forceCleanupGame('服务清理');

    // 记录最终状态
    const finalStats = this.getStats();

    this.logger.info('游戏服务已清理', {
      operation: 'game-service-cleanup',
      finalStats,
      hadActiveGame: !!this.game
    });
  }
}
