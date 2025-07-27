import { BaseService } from '@/services'
import type { ServiceContainer } from '@/services'
import {
  TimerStatus,
  type GameTimer,
  type ServiceHealthStatus,
  type TimerServiceConfig,
  type TimerStats,
  TimerType,
} from '@/types'

/**
 * 定时器服务
 * 
 * 职责:
 * 1. ⏰ 管理游戏中的所有定时器
 * 2. 🔄 支持定时器重试和错误恢复
 * 3. 📊 定时器统计和监控
 * 4. 🛡️ 定时器生命周期管理
 * 5. 🧹 自动清理过期定时器
 * 6. 🎯 游戏上下文感知的定时器
 */
export class TimerService extends BaseService {
  private timers: Map<string, GameTimer> = new Map();
  private timerCounter = 0;
  private timerConfig: TimerServiceConfig;
  private stats: TimerStats;
  private cleanupTimerId?: NodeJS.Timeout;

  constructor(container: ServiceContainer) {
    super(container, {
      name: 'TimerService',
      debug: false
    });

    // 初始化配置
    this.timerConfig = {
      defaultMaxRetries: 2,
      retryBaseDelay: 1000,
      cleanupInterval: 60000, // 1分钟清理一次
      maxTimers: 50,
      timerTimeout: 300000 // 5分钟超时
    };

    // 初始化统计
    this.stats = {
      totalCreated: 0,
      totalCompleted: 0,
      totalCancelled: 0,
      totalFailed: 0,
      activeTimers: 0,
      averageDelay: 0,
      averageExecutionTime: 0
    };

    this.logger.info('定时器服务已初始化', {
      operation: 'timer-service-init',
      config: this.timerConfig
    });

    // 启动定期清理
    this.startPeriodicCleanup();
  }

  /**
   * 创建游戏定时器
   * 
   * @param type - 定时器类型
   * @param name - 定时器名称
   * @param delay - 延迟时间(毫秒)
   * @param callback - 执行回调
   * @param options - 额外选项
   * @returns 定时器ID
   */
  createGameTimer(
    type: TimerType,
    name: string,
    delay: number,
    callback: () => Promise<void> | void,
    options: {
      gameId?: string;
      chatId?: string;
      maxRetries?: number;
    } = {}
  ): string {
    const timer = this.createTimer('create-game-timer', {
      type,
      name,
      delay
    });

    try {
      // 检查定时器数量限制
      if (this.timers.size >= this.timerConfig.maxTimers) {
        throw new Error(`Timer limit exceeded: ${this.timerConfig.maxTimers}`);
      }

      const id = `timer_${type}_${++this.timerCounter}_${Date.now()}`;
      const now = Date.now();

      const gameTimer: GameTimer = {
        id,
        type,
        name,
        gameId: options.gameId || this.context.gameId,
        chatId: options.chatId || this.context.chatId,
        createdAt: now,
        executeAt: now + delay,
        delay,
        status: TimerStatus.PENDING,
        callback,
        retries: 0,
        maxRetries: options.maxRetries ?? this.timerConfig.defaultMaxRetries
      };

      // 设置浏览器定时器
      const timerId = setTimeout(async () => {
        await this.executeTimer(id);
      }, delay);

      gameTimer.timerId = timerId;
      this.timers.set(id, gameTimer);

      // 更新统计
      this.updateStats('created', delay);

      this.logger.info('定时器已创建', {
        operation: 'create-timer',
        timerId: id,
        type,
        name,
        delay,
        executeAt: gameTimer.executeAt,
        gameId: gameTimer.gameId,
        chatId: gameTimer.chatId
      });

      timer.end({
        success: true,
        timerId: id,
        delay
      });

      return id;
    } catch (error) {
      this.logger.error('创建定时器失败', {
        operation: 'create-timer-error',
        type,
        name,
        delay
      }, error);

      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 取消定时器
   * 
   * @param timerId - 定时器ID
   * @returns 是否成功取消
   */
  cancelTimer(timerId: string): boolean {
    const timer = this.createTimer('cancel-timer', { timerId });

    try {
      const gameTimer = this.timers.get(timerId);
      if (!gameTimer) {
        this.logger.warn('定时器不存在', {
          operation: 'cancel-timer-not-found',
          timerId
        });
        timer.end({ success: false, reason: 'not-found' });
        return false;
      }

      // 取消浏览器定时器
      if (gameTimer.timerId) {
        clearTimeout(gameTimer.timerId);
      }

      // 更新状态
      gameTimer.status = TimerStatus.CANCELLED;
      gameTimer.completedAt = Date.now();

      // 从活跃定时器中移除
      this.timers.delete(timerId);

      // 更新统计
      this.updateStats('cancelled');

      this.logger.info('定时器已取消', {
        operation: 'cancel-timer',
        timerId,
        type: gameTimer.type,
        name: gameTimer.name,
        remainingTime: gameTimer.executeAt - Date.now()
      });

      timer.end({ success: true, timerId });
      return true;
    } catch (error) {
      this.logger.error('取消定时器失败', {
        operation: 'cancel-timer-error',
        timerId
      }, error);

      timer.end({ success: false, error: true });
      return false;
    }
  }

  /**
   * 取消指定类型的所有定时器
   * 
   * @param type - 定时器类型
   * @param gameId - 游戏ID (可选)
   * @returns 取消的定时器数量
   */
  cancelTimersByType(type: TimerType, gameId?: string): number {
    const timer = this.createTimer('cancel-timers-by-type', {
      type,
      gameId
    });

    try {
      let cancelledCount = 0;
      const timersToCancel: string[] = [];

      // 找到匹配的定时器
      this.timers.forEach((gameTimer, id) => {
        if (gameTimer.type === type) {
          if (!gameId || gameTimer.gameId === gameId) {
            timersToCancel.push(id);
          }
        }
      });

      // 批量取消
      timersToCancel.forEach(id => {
        if (this.cancelTimer(id)) {
          cancelledCount++;
        }
      });

      this.logger.info('批量取消定时器完成', {
        operation: 'cancel-timers-by-type',
        type,
        gameId,
        cancelledCount,
        totalFound: timersToCancel.length
      });

      timer.end({
        success: true,
        cancelledCount,
        type
      });

      return cancelledCount;
    } catch (error) {
      this.logger.error('批量取消定时器失败', {
        operation: 'cancel-timers-by-type-error',
        type,
        gameId
      }, error);

      timer.end({ success: false, error: true });
      return 0;
    }
  }

  /**
   * 取消所有定时器
   * 
   * @returns 取消的定时器数量
   */
  cancelAllTimers(): number {
    const timer = this.createTimer('cancel-all-timers');

    try {
      const timerIds = Array.from(this.timers.keys());
      let cancelledCount = 0;

      timerIds.forEach(id => {
        if (this.cancelTimer(id)) {
          cancelledCount++;
        }
      });

      this.logger.info('所有定时器已取消', {
        operation: 'cancel-all-timers',
        cancelledCount,
        totalTimers: timerIds.length
      });

      timer.end({
        success: true,
        cancelledCount
      });

      return cancelledCount;
    } catch (error) {
      this.logger.error('取消所有定时器失败', {
        operation: 'cancel-all-timers-error'
      }, error);

      timer.end({ success: false, error: true });
      return 0;
    }
  }

  /**
   * 执行定时器
   */
  private async executeTimer(timerId: string): Promise<void> {
    const timer = this.createTimer('execute-timer', { timerId });

    try {
      const gameTimer = this.timers.get(timerId);
      if (!gameTimer) {
        this.logger.warn('执行时定时器不存在', {
          operation: 'execute-timer-not-found',
          timerId
        });
        timer.end({ success: false, reason: 'not-found' });
        return;
      }

      gameTimer.status = TimerStatus.RUNNING;

      this.logger.info('开始执行定时器', {
        operation: 'execute-timer-start',
        timerId,
        type: gameTimer.type,
        name: gameTimer.name,
        actualDelay: Date.now() - gameTimer.createdAt
      });

      const executeStart = Date.now();

      try {
        // 执行回调
        await gameTimer.callback();

        // 执行成功
        const executionTime = Date.now() - executeStart;
        gameTimer.status = TimerStatus.COMPLETED;
        gameTimer.completedAt = Date.now();

        // 从活跃定时器中移除
        this.timers.delete(timerId);

        // 更新统计
        this.updateStats('completed', undefined, executionTime);

        this.logger.info('定时器执行完成', {
          operation: 'execute-timer-complete',
          timerId,
          type: gameTimer.type,
          name: gameTimer.name,
          executionTime
        });

        timer.end({
          success: true,
          timerId,
          executionTime
        });

      } catch (callbackError) {
        // 执行失败，尝试重试
        await this.handleTimerError(gameTimer, callbackError);

        timer.end({
          success: false,
          error: true,
          retried: gameTimer.retries! > 0
        });
      }
    } catch (error) {
      this.logger.error('执行定时器时发生异常', {
        operation: 'execute-timer-error',
        timerId
      }, error);

      timer.end({ success: false, error: true });
    }
  }

  /**
   * 处理定时器错误
   */
  private async handleTimerError(gameTimer: GameTimer, error: any): Promise<void> {
    gameTimer.retries = (gameTimer.retries || 0) + 1;
    gameTimer.error = error instanceof Error ? error.message : 'Unknown error';

    this.logger.warn('定时器执行失败', {
      operation: 'timer-execution-error',
      timerId: gameTimer.id,
      type: gameTimer.type,
      name: gameTimer.name,
      retries: gameTimer.retries,
      maxRetries: gameTimer.maxRetries
    }, error);

    if (gameTimer.retries! <= gameTimer.maxRetries!) {
      // 重试
      const retryDelay = this.timerConfig.retryBaseDelay * Math.pow(2, gameTimer.retries! - 1);

      this.logger.info('定时器将重试', {
        operation: 'timer-retry',
        timerId: gameTimer.id,
        attempt: gameTimer.retries,
        retryDelay
      });

      gameTimer.status = TimerStatus.PENDING;
      gameTimer.executeAt = Date.now() + retryDelay;

      // 设置重试定时器
      const timerId = setTimeout(async () => {
        await this.executeTimer(gameTimer.id);
      }, retryDelay);

      gameTimer.timerId = timerId;
    } else {
      // 重试次数用完，标记为失败
      gameTimer.status = TimerStatus.FAILED;
      gameTimer.completedAt = Date.now();

      // 从活跃定时器中移除
      this.timers.delete(gameTimer.id);

      // 更新统计
      this.updateStats('failed');

      this.logger.error('定时器最终失败', {
        operation: 'timer-final-failure',
        timerId: gameTimer.id,
        type: gameTimer.type,
        name: gameTimer.name,
        totalRetries: gameTimer.retries
      });
    }
  }

  /**
   * 获取定时器信息
   * 
   * @param timerId - 定时器ID
   * @returns 定时器信息
   */
  getTimer(timerId: string): GameTimer | null {
    return this.timers.get(timerId) || null;
  }

  /**
   * 获取指定类型的定时器
   * 
   * @param type - 定时器类型
   * @param gameId - 游戏ID (可选)
   * @returns 定时器列表
   */
  getTimersByType(type: TimerType, gameId?: string): GameTimer[] {
    const result: GameTimer[] = [];

    this.timers.forEach(timer => {
      if (timer.type === type) {
        if (!gameId || timer.gameId === gameId) {
          result.push({ ...timer });
        }
      }
    });

    return result;
  }

  /**
   * 获取所有活跃定时器
   * 
   * @returns 活跃定时器列表
   */
  getAllActiveTimers(): GameTimer[] {
    return Array.from(this.timers.values()).map(timer => ({ ...timer }));
  }

  /**
   * 获取定时器统计信息
   * 
   * @returns 统计信息
   */
  getStats(): TimerStats {
    // 计算动态统计
    const activeTimers = this.timers.size;
    let longestRunningTimer: string | undefined;
    let oldestPendingTimer: string | undefined;
    let longestRunningTime = 0;
    let oldestPendingTime = Date.now();

    this.timers.forEach(timer => {
      if (timer.status === TimerStatus.RUNNING) {
        const runningTime = Date.now() - timer.createdAt;
        if (runningTime > longestRunningTime) {
          longestRunningTime = runningTime;
          longestRunningTimer = timer.id;
        }
      } else if (timer.status === TimerStatus.PENDING) {
        if (timer.createdAt < oldestPendingTime) {
          oldestPendingTime = timer.createdAt;
          oldestPendingTimer = timer.id;
        }
      }
    });

    return {
      ...this.stats,
      activeTimers,
      longestRunningTimer,
      oldestPendingTimer
    };
  }

  /**
   * 更新统计信息
   */
  private updateStats(
    action: 'created' | 'completed' | 'cancelled' | 'failed',
    delay?: number,
    executionTime?: number
  ): void {
    switch (action) {
      case 'created':
        this.stats.totalCreated++;
        if (delay) {
          const totalDelay = this.stats.averageDelay * (this.stats.totalCreated - 1) + delay;
          this.stats.averageDelay = totalDelay / this.stats.totalCreated;
        }
        break;
      case 'completed':
        this.stats.totalCompleted++;
        if (executionTime) {
          const totalExecTime = this.stats.averageExecutionTime * (this.stats.totalCompleted - 1) + executionTime;
          this.stats.averageExecutionTime = totalExecTime / this.stats.totalCompleted;
        }
        break;
      case 'cancelled':
        this.stats.totalCancelled++;
        break;
      case 'failed':
        this.stats.totalFailed++;
        break;
    }

    this.stats.activeTimers = this.timers.size;
  }

  /**
   * 启动定期清理
   */
  private startPeriodicCleanup(): void {
    this.cleanupTimerId = setInterval(() => {
      this.cleanupExpiredTimers();
    }, this.timerConfig.cleanupInterval);

    this.logger.debug('定期清理已启动', {
      operation: 'start-periodic-cleanup',
      interval: this.timerConfig.cleanupInterval
    });
  }

  /**
   * 清理过期定时器
   */
  private cleanupExpiredTimers(): void {
    const now = Date.now();
    const expiredTimers: string[] = [];

    this.timers.forEach((timer, id) => {
      // 清理超时的定时器
      if (now - timer.createdAt > this.timerConfig.timerTimeout) {
        expiredTimers.push(id);
      }
    });

    if (expiredTimers.length > 0) {
      this.logger.warn('清理过期定时器', {
        operation: 'cleanup-expired-timers',
        expiredCount: expiredTimers.length,
        timeout: this.timerConfig.timerTimeout
      });

      expiredTimers.forEach(id => {
        this.cancelTimer(id);
      });
    }
  }

  /**
   * 获取配置
   */
  getTimerConfig(): TimerServiceConfig {
    return { ...this.timerConfig };
  }

  /**
   * 更新配置
   */
  updateTimerConfig(newConfig: Partial<TimerServiceConfig>): void {
    const oldConfig = { ...this.timerConfig };
    this.timerConfig = { ...this.timerConfig, ...newConfig };

    this.logger.info('定时器服务配置已更新', {
      operation: 'update-config',
      oldConfig,
      newConfig: this.timerConfig
    });
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      totalCreated: 0,
      totalCompleted: 0,
      totalCancelled: 0,
      totalFailed: 0,
      activeTimers: this.timers.size,
      averageDelay: 0,
      averageExecutionTime: 0
    };

    this.logger.info('定时器统计信息已重置', {
      operation: 'reset-stats'
    });
  }

  /**
   * 自定义健康检查
   */
  protected override getCustomHealth(): Partial<ServiceHealthStatus> {
    const stats = this.getStats();

    // 检查是否有过多的活跃定时器
    const tooManyActiveTimers = stats.activeTimers > this.timerConfig.maxTimers * 0.8;

    // 检查是否有长时间运行的定时器
    const hasStuckTimer = stats.longestRunningTimer &&
      this.timers.get(stats.longestRunningTimer)?.status === TimerStatus.RUNNING;

    // 检查失败率
    const totalAttempts = stats.totalCompleted + stats.totalFailed;
    const failureRate = totalAttempts > 0 ? stats.totalFailed / totalAttempts : 0;
    const highFailureRate = failureRate > 0.1; // 10%失败率

    const isHealthy = !tooManyActiveTimers && !hasStuckTimer && !highFailureRate;

    const issues: string[] = [];
    if (tooManyActiveTimers) issues.push(`过多活跃定时器: ${stats.activeTimers}`);
    if (hasStuckTimer) issues.push('检测到卡住的定时器');
    if (highFailureRate) issues.push(`高失败率: ${(failureRate * 100).toFixed(1)}%`);

    return {
      healthy: isHealthy,
      message: isHealthy
        ? 'Timer service is operating normally'
        : `Issues detected: ${issues.join(', ')}`,
      details: {
        stats,
        config: this.timerConfig,
        issues,
        failureRate: failureRate.toFixed(3)
      }
    };
  }

  /**
   * 服务上下文更新处理
   */
  protected override onContextUpdate(newContext: ServiceContainer['context']): void {
    // 当游戏上下文更新时，可以考虑取消旧游戏的定时器
    if (newContext.gameId !== this.context.gameId) {
      this.logger.debug('检测到游戏上下文变更', {
        operation: 'context-game-change',
        oldGameId: this.context.gameId,
        newGameId: newContext.gameId
      });

      // 可以选择取消旧游戏的定时器
      if (this.context.gameId) {
        const cancelledCount = this.cancelTimersByType(TimerType.COUNTDOWN, this.context.gameId);
        if (cancelledCount > 0) {
          this.logger.info('取消旧游戏的倒计时定时器', {
            operation: 'cancel-old-game-timers',
            oldGameId: this.context.gameId,
            cancelledCount
          });
        }
      }
    }
  }

  /**
   * 清理资源
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();

    // 停止定期清理
    if (this.cleanupTimerId) {
      clearInterval(this.cleanupTimerId);
      this.cleanupTimerId = undefined;
    }

    // 取消所有定时器
    const cancelledCount = this.cancelAllTimers();

    // 记录最终统计
    const finalStats = this.getStats();

    this.logger.info('定时器服务已清理', {
      operation: 'timer-service-cleanup',
      cancelledTimers: cancelledCount,
      finalStats
    });
  }
}
