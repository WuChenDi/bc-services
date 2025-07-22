import { BaseService } from '@/services'
import type { ServiceContainer } from '@/services'
import type {
  ServiceHealthStatus,
  GameRecord,
  GameData,
  StorageStats,
  StorageConfig,
  StorageResult,
} from '@/types'

/**
 * 存储服务
 * 
 * 职责:
 * 1. 💾 游戏记录的持久化存储
 * 2. 📊 游戏历史数据管理
 * 3. 🔍 高效的数据检索
 * 4. 📈 存储操作统计
 * 5. 🚀 缓存优化
 * 6. 🛡️ 数据完整性保证
 */
export class StorageService extends BaseService {
  private kv: KVNamespace;
  private stats: StorageStats;
  private storageConfig: StorageConfig;
  private cache: Map<string, { data: any; timestamp: number }> = new Map();

  constructor(container: ServiceContainer) {
    super(container, {
      name: 'StorageService',
      debug: false
    });

    this.kv = this.context.env.BC_GAME_KV;

    // 初始化存储配置
    this.storageConfig = {
      maxGameHistoryCount: 100,
      cacheExpirationMs: 5 * 60 * 1000, // 5分钟
      enableCache: true
    };

    // 初始化统计信息
    this.stats = {
      total: 0,
      successful: 0,
      failed: 0,
      lastActivity: Date.now(),
      gameRecordsSaved: 0,
      gameRecordsRetrieved: 0,
      gameHistoriesRetrieved: 0,
      errors: 0,
      totalOperations: 0,
      lastOperationTime: Date.now()
    };

    this.logger.info('存储服务已初始化', {
      operation: 'storage-service-init',
      kvNamespace: this.kv ? 'configured' : 'missing',
      cacheEnabled: this.storageConfig.enableCache
    });
  }

  /**
   * 保存游戏记录
   * 
   * @param game - 游戏数据
   * @returns 保存结果
   */
  async saveGameRecord(game: GameData): Promise<StorageResult<void>> {
    const timer = this.createTimer('save-game-record', {
      gameId: game.gameNumber,
      chatId: game.chatId
    });

    try {
      // 移除 bettingEndTime 字段，因为记录中不需要
      const { bettingEndTime, ...gameWithoutBettingEndTime } = game;

      // 计算游戏统计信息
      const gameStats = this.calculateGameStats(game);

      // 创建游戏记录
      const gameRecord: GameRecord = {
        ...gameWithoutBettingEndTime,
        endTime: Date.now(),
        totalBets: gameStats.totalBets,
        totalAmount: gameStats.totalAmount
      };

      // 保存游戏记录
      const gameKey = `game:${game.gameNumber}`;
      await this.kv.put(gameKey, JSON.stringify(gameRecord));

      // 更新最新游戏列表
      await this.updateLatestGamesList(game.chatId, game.gameNumber);

      // 更新缓存
      if (this.storageConfig.enableCache) {
        this.setCache(gameKey, gameRecord);
      }

      // 更新统计
      this.updateStats('save');

      this.logger.info('游戏记录保存成功', {
        operation: 'save-game-record-success',
        gameId: game.gameNumber,
        chatId: game.chatId,
        totalBets: gameStats.totalBets,
        totalAmount: gameStats.totalAmount
      });

      timer.end({
        success: true,
        gameId: game.gameNumber,
        totalBets: gameStats.totalBets
      });

      return { success: true };
    } catch (error) {
      this.stats.errors++;

      this.logger.error('保存游戏记录失败', {
        operation: 'save-game-record-error',
        gameId: game.gameNumber,
        chatId: game.chatId
      }, error);

      timer.end({ success: false, error: true });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * 获取游戏历史记录
   * 
   * @param chatId - 聊天ID
   * @param limit - 记录数量限制 (默认: 10)
   * @returns 游戏历史记录
   */
  async getGameHistory(chatId: string, limit: number = 10): Promise<StorageResult<GameRecord[]>> {
    const timer = this.createTimer('get-game-history', {
      chatId,
      limit
    });

    try {
      // 获取最新游戏列表
      const latestGamesKey = `latest_games:${chatId}`;
      const latestGamesData = await this.kv.get(latestGamesKey);

      if (!latestGamesData) {
        timer.end({ success: true, recordCount: 0 });
        return { success: true, data: [] };
      }

      const latestGames: string[] = JSON.parse(latestGamesData);
      const history: GameRecord[] = [];

      // 获取指定数量的游戏记录
      const gamesToFetch = latestGames.slice(0, limit);

      for (const gameNumber of gamesToFetch) {
        try {
          const gameRecord = await this.getGameDetail(gameNumber);
          if (gameRecord.success && gameRecord.data) {
            history.push(gameRecord.data);
          }
        } catch (error) {
          this.logger.warn('获取单个游戏记录失败', {
            operation: 'get-single-game-error',
            gameNumber,
            chatId
          }, error);
          // 继续处理其他记录，不因单个记录失败而终止
        }
      }

      // 更新统计
      this.updateStats('history');

      this.logger.info('游戏历史记录获取成功', {
        operation: 'get-game-history-success',
        chatId,
        requestedLimit: limit,
        actualCount: history.length,
        availableGames: latestGames.length
      });

      timer.end({
        success: true,
        recordCount: history.length,
        requestedLimit: limit
      });

      return { success: true, data: history };
    } catch (error) {
      this.stats.errors++;

      this.logger.error('获取游戏历史记录失败', {
        operation: 'get-game-history-error',
        chatId,
        limit
      }, error);

      timer.end({ success: false, error: true });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        data: []
      };
    }
  }

  /**
   * 获取游戏详情
   * 
   * @param gameNumber - 游戏编号
   * @returns 游戏详情
   */
  async getGameDetail(gameNumber: string): Promise<StorageResult<GameRecord>> {
    const timer = this.createTimer('get-game-detail', {
      gameNumber
    });

    try {
      // 验证游戏编号格式
      if (!/^\d{17}$/.test(gameNumber)) {
        timer.end({ success: false, reason: 'invalid-format' });
        return {
          success: false,
          error: 'Invalid game number format. Expected 17 digits.'
        };
      }

      const gameKey = `game:${gameNumber}`;

      // 先检查缓存
      if (this.storageConfig.enableCache) {
        const cachedData = this.getCache(gameKey);
        if (cachedData) {
          this.logger.debug('从缓存获取游戏详情', {
            operation: 'get-game-detail-cache',
            gameNumber
          });

          timer.end({ success: true, source: 'cache' });
          return { success: true, data: cachedData };
        }
      }

      // 从 KV 存储获取
      const gameData = await this.kv.get(gameKey);

      if (!gameData) {
        timer.end({ success: false, reason: 'not-found' });
        return {
          success: false,
          error: 'Game not found'
        };
      }

      const gameRecord: GameRecord = JSON.parse(gameData);

      // 更新缓存
      if (this.storageConfig.enableCache) {
        this.setCache(gameKey, gameRecord);
      }

      // 更新统计
      this.updateStats('retrieve');

      this.logger.debug('游戏详情获取成功', {
        operation: 'get-game-detail-success',
        gameNumber,
        totalBets: gameRecord.totalBets,
        winner: gameRecord.result.winner
      });

      timer.end({
        success: true,
        source: 'kv',
        gameNumber
      });

      return { success: true, data: gameRecord };
    } catch (error) {
      this.stats.errors++;

      this.logger.error('获取游戏详情失败', {
        operation: 'get-game-detail-error',
        gameNumber
      }, error);

      timer.end({ success: false, error: true });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * 删除游戏记录
   * 
   * @param gameNumber - 游戏编号
   * @returns 删除结果
   */
  async deleteGameRecord(gameNumber: string): Promise<StorageResult<void>> {
    const timer = this.createTimer('delete-game-record', {
      gameNumber
    });

    try {
      const gameKey = `game:${gameNumber}`;

      // 从 KV 存储删除
      await this.kv.delete(gameKey);

      // 从缓存删除
      if (this.storageConfig.enableCache) {
        this.cache.delete(gameKey);
      }

      this.logger.info('游戏记录删除成功', {
        operation: 'delete-game-record-success',
        gameNumber
      });

      timer.end({ success: true, gameNumber });

      return { success: true };
    } catch (error) {
      this.stats.errors++;

      this.logger.error('删除游戏记录失败', {
        operation: 'delete-game-record-error',
        gameNumber
      }, error);

      timer.end({ success: false, error: true });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * 计算游戏统计信息
   */
  private calculateGameStats(game: GameData): { totalBets: number; totalAmount: number } {
    const allUserBets = Object.values(game.bets);
    let totalAmount = 0;

    allUserBets.forEach(userBets => {
      if (userBets.banker) totalAmount += userBets.banker;
      if (userBets.player) totalAmount += userBets.player;
      if (userBets.tie) totalAmount += userBets.tie;
    });

    return {
      totalBets: allUserBets.length,
      totalAmount
    };
  }

  /**
   * 更新最新游戏列表
   */
  private async updateLatestGamesList(chatId: string, gameNumber: string): Promise<void> {
    const latestGamesKey = `latest_games:${chatId}`;
    let latestGames: string[] = [];

    try {
      const existing = await this.kv.get(latestGamesKey);
      if (existing) {
        latestGames = JSON.parse(existing);
      }
    } catch (error) {
      this.logger.warn('获取最新游戏列表失败，创建新列表', {
        operation: 'get-latest-games-error',
        chatId
      }, error);
    }

    // 添加新游戏到列表开头
    latestGames.unshift(gameNumber);

    // 保持列表长度限制
    if (latestGames.length > this.storageConfig.maxGameHistoryCount) {
      latestGames = latestGames.slice(0, this.storageConfig.maxGameHistoryCount);
    }

    await this.kv.put(latestGamesKey, JSON.stringify(latestGames));

    this.logger.debug('最新游戏列表已更新', {
      operation: 'update-latest-games',
      chatId,
      gameNumber,
      totalGames: latestGames.length
    });
  }

  /**
   * 设置缓存
   */
  private setCache(key: string, data: any): void {
    if (!this.storageConfig.enableCache) return;

    this.cache.set(key, {
      data: { ...data },
      timestamp: Date.now()
    });

    this.logger.debug('缓存已设置', {
      operation: 'set-cache',
      key,
      cacheSize: this.cache.size
    });
  }

  /**
   * 获取缓存
   */
  private getCache(key: string): any | null {
    if (!this.storageConfig.enableCache) return null;

    const cached = this.cache.get(key);
    if (!cached) return null;

    // 检查缓存是否过期
    const isExpired = Date.now() - cached.timestamp > this.storageConfig.cacheExpirationMs;
    if (isExpired) {
      this.cache.delete(key);
      this.logger.debug('缓存已过期并删除', {
        operation: 'cache-expired',
        key
      });
      return null;
    }

    return cached.data;
  }

  /**
   * 清理过期缓存
   */
  private cleanupExpiredCache(): void {
    if (!this.storageConfig.enableCache) return;

    const now = Date.now();
    const expiredKeys: string[] = [];

    this.cache.forEach((cached, key) => {
      if (now - cached.timestamp > this.storageConfig.cacheExpirationMs) {
        expiredKeys.push(key);
      }
    });

    expiredKeys.forEach(key => {
      this.cache.delete(key);
    });

    if (expiredKeys.length > 0) {
      this.logger.debug('清理过期缓存', {
        operation: 'cleanup-expired-cache',
        expiredCount: expiredKeys.length,
        remainingCount: this.cache.size
      });
    }
  }

  /**
   * 更新统计信息
   */
  private updateStats(operation: 'save' | 'retrieve' | 'history'): void {
    this.stats.totalOperations++;
    this.stats.total++;
    this.stats.successful++;
    this.stats.lastActivity = Date.now();
    this.stats.lastOperationTime = Date.now();

    switch (operation) {
      case 'save':
        this.stats.gameRecordsSaved++;
        break;
      case 'retrieve':
        this.stats.gameRecordsRetrieved++;
        break;
      case 'history':
        this.stats.gameHistoriesRetrieved++;
        break;
    }
  }

  /**
   * 获取存储统计信息
   * 
   * @returns 统计信息
   */
  getStats(): StorageStats {
    return { ...this.stats };
  }

  /**
   * 获取存储配置
   * 
   * @returns 存储配置
   */
  getStorageConfig(): StorageConfig {
    return { ...this.storageConfig };
  }

  /**
   * 更新存储配置
   * 
   * @param newConfig - 新配置
   */
  updateStorageConfig(newConfig: Partial<StorageConfig>): void {
    const oldConfig = { ...this.storageConfig };
    this.storageConfig = { ...this.storageConfig, ...newConfig };

    this.logger.info('存储配置已更新', {
      operation: 'update-storage-config',
      oldConfig,
      newConfig: this.storageConfig
    });

    // 如果禁用了缓存，清空现有缓存
    if (!this.storageConfig.enableCache && this.cache.size > 0) {
      this.cache.clear();
      this.logger.info('缓存已禁用并清空', {
        operation: 'disable-cache'
      });
    }
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    const cacheSize = this.cache.size;
    this.cache.clear();

    this.logger.info('缓存已清空', {
      operation: 'clear-cache',
      clearedItems: cacheSize
    });
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      total: 0,
      successful: 0,
      failed: 0,
      lastActivity: Date.now(),
      gameRecordsSaved: 0,
      gameRecordsRetrieved: 0,
      gameHistoriesRetrieved: 0,
      errors: 0,
      totalOperations: 0,
      lastOperationTime: Date.now()
    };

    this.logger.info('存储统计信息已重置', {
      operation: 'reset-stats'
    });
  }

  /**
   * 获取缓存状态
   */
  getCacheStatus(): {
    enabled: boolean;
    size: number;
    maxAge: number;
    hitRate?: number;
  } {
    return {
      enabled: this.storageConfig.enableCache,
      size: this.cache.size,
      maxAge: this.storageConfig.cacheExpirationMs,
      // TODO: 实现命中率统计
    };
  }

  /**
   * 自定义健康检查
   */
  protected override getCustomHealth(): Partial<ServiceHealthStatus> {
    const stats = this.getStats();
    const cacheStatus = this.getCacheStatus();
    const timeSinceLastOperation = Date.now() - stats.lastOperationTime;

    // 如果错误率超过10%，标记为不健康
    const errorRate = stats.totalOperations > 0 ? stats.errors / stats.totalOperations : 0;
    const isHealthy = errorRate < 0.1;

    return {
      healthy: isHealthy,
      message: isHealthy
        ? 'Storage service is operating normally'
        : `High error rate: ${(errorRate * 100).toFixed(1)}%`,
      details: {
        stats,
        cacheStatus,
        timeSinceLastOperation,
        errorRate: errorRate.toFixed(3),
        kvNamespace: this.kv ? 'configured' : 'missing'
      }
    };
  }

  /**
   * 服务上下文更新处理
   */
  protected override onContextUpdate(newContext: ServiceContainer['context']): void {
    // 上下文更新时，可以考虑清理与旧游戏相关的缓存
    if (newContext.gameId !== this.context.gameId) {
      this.logger.debug('游戏上下文已更改，执行缓存清理', {
        operation: 'context-change-cleanup',
        oldGameId: this.context.gameId,
        newGameId: newContext.gameId
      });

      // 可以选择性清理缓存或保留
      // this.cleanupExpiredCache();
    }
  }

  /**
   * 清理资源
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();

    // 清理缓存
    this.clearCache();

    // 记录最终统计
    const finalStats = this.getStats();

    this.logger.info('存储服务已清理', {
      operation: 'storage-service-cleanup',
      finalStats,
      cacheSize: this.cache.size
    });
  }
}
