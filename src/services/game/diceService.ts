import { BaseService, MessageQueueService } from '@/services'
import type { ServiceContainer } from '@/services'
import type { DiceConfig, DiceResult, DiceStats, ServiceHealthStatus } from '@/types'

/**
 * 骰子服务
 * 
 * 职责:
 * 1. 🎲 封装骰子投掷逻辑
 * 2. 📨 管理骰子消息队列
 * 3. 🔄 处理骰子失败和重试
 * 4. 📊 骰子投掷统计
 * 5. 🛡️ 备用方案和容错处理
 * 6. ⏰ 游戏序列控制
 */
export class DiceService extends BaseService {
  private diceConfig: DiceConfig;
  private stats: DiceStats;

  constructor(container: ServiceContainer) {
    super(container, {
      name: 'DiceService',
      debug: false
    });

    // 初始化配置
    this.diceConfig = {
      animationWaitMs: this.context.constants.DICE_ANIMATION_WAIT_MS,
      resultDelayMs: this.context.constants.DICE_RESULT_DELAY_MS,
      rollTimeoutMs: this.context.constants.DICE_ROLL_TIMEOUT_MS,
      maxRetries: this.context.constants.DICE_ROLL_MAX_RETRIES,
      defaultEmoji: '🎲'
    };

    // 初始化统计
    this.stats = {
      totalRolls: 0,
      successfulRolls: 0,
      failedRolls: 0,
      fallbackUsed: 0,
      averageRollTime: 0,
      valueDistribution: {
        1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0
      },
      lastRollTime: Date.now(),
      successRate: 0
    };

    this.logger.info('骰子服务已初始化', {
      operation: 'dice-service-init',
      config: this.diceConfig
    });
  }

  /**
   * 设置当前游戏ID，用于消息序列控制
   */
  setCurrentGame(gameId: string): void {
    this.logger.info('设置当前游戏ID', {
      operation: 'set-current-game',
      gameId
    });

    // 通过消息队列服务设置当前游戏
    const messageQueue = this.getService(MessageQueueService);
    messageQueue.setCurrentGame(gameId);
  }

  /**
   * 发送非阻塞消息
   * 
   * @param chatId - 聊天ID
   * @param content - 消息内容
   * @param parseMode - 解析模式
   * @returns 消息ID
   */
  async sendMessage(
    chatId: string,
    content: string,
    parseMode: 'Markdown' | 'HTML' = 'Markdown'
  ): Promise<string> {
    const timer = this.createTimer('send-message', {
      chatId,
      contentLength: content.length,
      parseMode
    });

    try {
      this.logger.debug('添加非阻塞消息到队列', {
        operation: 'send-message',
        chatId,
        contentLength: content.length,
        parseMode
      });

      const messageQueue = this.getService(MessageQueueService);
      const messageId = await messageQueue.enqueueMessage(chatId, content, false, parseMode);

      timer.end({ success: true, messageId });
      return messageId;
    } catch (error) {
      this.logger.error('发送消息失败', {
        operation: 'send-message-error',
        chatId,
        contentLength: content.length
      }, error);

      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 发送阻塞消息
   * 
   * @param chatId - 聊天ID
   * @param content - 消息内容
   * @param parseMode - 解析模式
   * @returns 消息ID
   */
  async sendBlockingMessage(
    chatId: string,
    content: string,
    parseMode: 'Markdown' | 'HTML' = 'Markdown'
  ): Promise<string> {
    const timer = this.createTimer('send-blocking-message', {
      chatId,
      contentLength: content.length,
      parseMode
    });

    try {
      this.logger.debug('添加阻塞消息到队列', {
        operation: 'send-blocking-message',
        chatId,
        contentLength: content.length,
        parseMode
      });

      const messageQueue = this.getService(MessageQueueService);
      const messageId = await messageQueue.enqueueMessage(chatId, content, true, parseMode);

      timer.end({ success: true, messageId });
      return messageId;
    } catch (error) {
      this.logger.error('发送阻塞消息失败', {
        operation: 'send-blocking-message-error',
        chatId,
        contentLength: content.length
      }, error);

      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 投掷骰子，总是阻塞的
   * 
   * @param chatId - 聊天ID
   * @param playerType - 玩家类型 (banker/player)
   * @param cardIndex - 牌的索引
   * @param emoji - 骰子表情 (可选)
   * @returns 骰子结果
   */
  async rollDice(
    chatId: string,
    playerType: string,
    cardIndex: number,
    emoji?: string
  ): Promise<DiceResult> {
    const timer = this.createTimer('roll-dice', {
      chatId,
      playerType,
      cardIndex
    });

    try {
      this.logger.info('开始投掷骰子', {
        operation: 'roll-dice',
        chatId,
        playerType,
        cardIndex,
        emoji: emoji || this.diceConfig.defaultEmoji
      });

      // 更新统计
      this.updateStats('attempt');

      const rollStart = Date.now();

      // 通过消息队列投掷骰子
      const messageQueue = this.getService(MessageQueueService);
      const diceValue = await messageQueue.enqueueDice(
        chatId,
        playerType,
        cardIndex,
        emoji || this.diceConfig.defaultEmoji
      );

      const rollDuration = Date.now() - rollStart;

      // 验证骰子值
      if (!diceValue || diceValue < 1 || diceValue > 6) {
        throw new Error(`Invalid dice value: ${diceValue}`);
      }

      // 更新统计
      this.updateStats('success', diceValue, rollDuration);

      this.logger.info('骰子投掷完成', {
        operation: 'roll-dice-complete',
        chatId,
        playerType,
        cardIndex,
        diceValue,
        duration: rollDuration
      });

      timer.end({
        success: true,
        diceValue,
        duration: rollDuration
      });

      return {
        success: true,
        value: diceValue,
        duration: rollDuration
      };
    } catch (error) {
      const rollDuration = timer.end({ success: false, error: true }).valueOf();

      this.logger.error('骰子投掷失败', {
        operation: 'roll-dice-error',
        chatId,
        playerType,
        cardIndex
      }, error);

      // 更新失败统计
      this.updateStats('failure', undefined, rollDuration);

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: rollDuration
      };
    }
  }

  /**
   * 批量投掷骰子
   * 
   * @param chatId - 聊天ID
   * @param rolls - 投掷配置数组
   * @returns 骰子结果数组
   */
  async rollMultipleDice(
    chatId: string,
    rolls: Array<{
      playerType: string;
      cardIndex: number;
      emoji?: string;
    }>
  ): Promise<DiceResult[]> {
    const timer = this.createTimer('roll-multiple-dice', {
      chatId,
      rollCount: rolls.length
    });

    try {
      this.logger.info('开始批量投掷骰子', {
        operation: 'roll-multiple-dice',
        chatId,
        rollCount: rolls.length,
        rolls: rolls.map(r => ({ playerType: r.playerType, cardIndex: r.cardIndex }))
      });

      const results: DiceResult[] = [];

      // 严格按顺序投掷
      for (const roll of rolls) {
        const result = await this.rollDice(
          chatId,
          roll.playerType,
          roll.cardIndex,
          roll.emoji
        );
        results.push(result);
      }

      const successCount = results.filter(r => r.success).length;

      this.logger.info('批量骰子投掷完成', {
        operation: 'roll-multiple-dice-complete',
        chatId,
        totalRolls: rolls.length,
        successCount,
        failureCount: rolls.length - successCount
      });

      timer.end({
        success: true,
        totalRolls: rolls.length,
        successCount
      });

      return results;
    } catch (error) {
      this.logger.error('批量骰子投掷失败', {
        operation: 'roll-multiple-dice-error',
        chatId,
        rollCount: rolls.length
      }, error);

      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 清空消息队列
   */
  clearMessageQueue(): void {
    this.logger.info('清空消息队列', {
      operation: 'clear-message-queue'
    });

    try {
      const messageQueue = this.getService(MessageQueueService);
      messageQueue.clearQueue();

      this.logger.info('消息队列清空成功', {
        operation: 'clear-message-queue-success'
      });
    } catch (error) {
      this.logger.error('清空消息队列失败', {
        operation: 'clear-message-queue-error'
      }, error);
    }
  }

  /**
   * 获取消息队列状态
   */
  getQueueStatus() {
    this.logger.debug('获取消息队列状态', {
      operation: 'get-queue-status'
    });

    try {
      const messageQueue = this.getService(MessageQueueService);
      return messageQueue.getQueueStatus();
    } catch (error) {
      this.logger.error('获取消息队列状态失败', {
        operation: 'get-queue-status-error'
      }, error);

      return {
        queueLength: 0,
        processing: false,
        currentSequence: 0,
        currentGame: null,
        processingCount: 0,
        blockingCount: 0
      };
    }
  }

  /**
   * 更新统计信息
   */
  private updateStats(
    action: 'attempt' | 'success' | 'failure',
    diceValue?: number,
    duration?: number
  ): void {
    const now = Date.now();

    switch (action) {
      case 'attempt':
        this.stats.totalRolls++;
        this.stats.lastRollTime = now;
        break;

      case 'success':
        this.stats.successfulRolls++;
        if (diceValue && diceValue >= 1 && diceValue <= 6) {
          this.stats.valueDistribution[diceValue as (1 | 2 | 3 | 4 | 5 | 6)]++;
        }
        if (duration && duration > 0) {
          const totalTime = this.stats.averageRollTime * (this.stats.successfulRolls - 1) + duration;
          this.stats.averageRollTime = totalTime / this.stats.successfulRolls;
        }
        break;

      case 'failure':
        this.stats.failedRolls++;
        break;
    }

    // 重新计算成功率
    this.stats.successRate = this.stats.totalRolls > 0
      ? this.stats.successfulRolls / this.stats.totalRolls
      : 0;
  }

  /**
   * 获取骰子统计信息
   * 
   * @returns 统计信息
   */
  getStats(): DiceStats {
    return { ...this.stats };
  }

  /**
   * 获取骰子配置
   * 
   * @returns 配置信息
   */
  getDiceConfig(): DiceConfig {
    return { ...this.diceConfig };
  }

  /**
   * 更新骰子配置
   * 
   * @param newConfig - 新配置
   */
  updateDiceConfig(newConfig: Partial<DiceConfig>): void {
    const oldConfig = { ...this.diceConfig };
    this.diceConfig = { ...this.diceConfig, ...newConfig };

    this.logger.info('骰子配置已更新', {
      operation: 'update-dice-config',
      oldConfig,
      newConfig: this.diceConfig
    });
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      totalRolls: 0,
      successfulRolls: 0,
      failedRolls: 0,
      fallbackUsed: 0,
      averageRollTime: 0,
      valueDistribution: {
        1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0
      },
      lastRollTime: Date.now(),
      successRate: 0
    };

    this.logger.info('骰子统计信息已重置', {
      operation: 'reset-stats'
    });
  }

  /**
   * 获取骰子分布分析
   */
  getDistributionAnalysis(): {
    distribution: Record<1 | 2 | 3 | 4 | 5 | 6, number>;
    percentages: Record<1 | 2 | 3 | 4 | 5 | 6, number>;
    expectedPercentage: number;
    isBalanced: boolean;
    deviation: number;
  } {
    const total = this.stats.successfulRolls;
    const expectedPercentage = 100 / 6; // 理论上每个点数应该是16.67%

    const percentages = {} as Record<1 | 2 | 3 | 4 | 5 | 6, number>;
    let totalDeviation = 0;

    for (let i = 1; i <= 6; i++) {
      const value = i as (1 | 2 | 3 | 4 | 5 | 6);
      percentages[value] = total > 0 ? (this.stats.valueDistribution[value] / total) * 100 : 0;
      totalDeviation += Math.abs(percentages[value] - expectedPercentage);
    }

    const deviation = totalDeviation / 6;
    const isBalanced = deviation < 5; // 5%以内的偏差认为是平衡的

    return {
      distribution: { ...this.stats.valueDistribution },
      percentages,
      expectedPercentage,
      isBalanced,
      deviation
    };
  }

  /**
   * 检查骰子系统健康状态
   */
  checkDiceHealth(): {
    healthy: boolean;
    issues: string[];
    recommendations: string[];
  } {
    const stats = this.getStats();
    const queueStatus = this.getQueueStatus();
    const distribution = this.getDistributionAnalysis();

    const issues: string[] = [];
    const recommendations: string[] = [];

    // 检查成功率
    if (stats.successRate < 0.9 && stats.totalRolls > 10) {
      issues.push(`低成功率: ${(stats.successRate * 100).toFixed(1)}%`);
      recommendations.push('检查网络连接或Bot API状态');
    }

    // 检查队列积压
    if (queueStatus.queueLength > 10) {
      issues.push(`消息队列积压: ${queueStatus.queueLength}条消息`);
      recommendations.push('检查消息处理是否正常');
    }

    // 检查骰子分布
    if (!distribution.isBalanced && stats.successfulRolls > 100) {
      issues.push(`骰子分布不均衡，偏差: ${distribution.deviation.toFixed(2)}%`);
      recommendations.push('这可能是正常的随机波动');
    }

    // 检查处理时间
    if (stats.averageRollTime > 10000) { // 超过10秒
      issues.push(`平均处理时间过长: ${stats.averageRollTime}ms`);
      recommendations.push('检查网络延迟或API响应时间');
    }

    const healthy = issues.length === 0;

    return {
      healthy,
      issues,
      recommendations
    };
  }

  /**
   * 自定义健康检查
   */
  protected override getCustomHealth(): Partial<ServiceHealthStatus> {
    const stats = this.getStats();
    const queueStatus = this.getQueueStatus();
    const health = this.checkDiceHealth();

    return {
      healthy: health.healthy,
      message: health.healthy
        ? 'Dice service is operating normally'
        : `Issues detected: ${health.issues.join(', ')}`,
      details: {
        stats,
        queueStatus,
        health,
        distribution: this.getDistributionAnalysis(),
        config: this.diceConfig
      }
    };
  }

  /**
   * 服务上下文更新处理
   */
  protected override onContextUpdate(newContext: ServiceContainer['context']): void {
    // 当游戏上下文更新时，可以考虑清理消息队列
    if (newContext.gameId !== this.context.gameId) {
      this.logger.debug('检测到游戏上下文变更', {
        operation: 'context-game-change',
        oldGameId: this.context.gameId,
        newGameId: newContext.gameId
      });

      // 如果需要，可以在这里清理队列
      // this.clearMessageQueue();
    }
  }

  /**
   * 清理资源
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();

    // 清空消息队列
    this.clearMessageQueue();

    // 记录最终统计
    const finalStats = this.getStats();
    const finalHealth = this.checkDiceHealth();

    this.logger.info('骰子服务已清理', {
      operation: 'dice-service-cleanup',
      finalStats,
      finalHealth
    });
  }
}
