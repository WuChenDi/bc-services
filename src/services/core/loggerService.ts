import { BaseService } from '@/services'
import type { ServiceContainer } from '@/services'
import type {
  LogEntry,
  ServiceHealthStatus,
  LogContext,
  PerformanceTimer,
  LoggerConfig,
  LoggerStats,
  ServiceContext,
} from '@/types'
import { LogLevel } from '@/types'

/**
 * 日志服务
 * 
 * 职责:
 * 1. 📝 统一的日志记录和格式化
 * 2. 🎯 上下文感知的日志管理
 * 3. ⚡ 性能监控和计时
 * 4. 📊 日志统计和分析
 * 5. 🎨 灵活的日志格式和输出
 * 6. 🔍 结构化日志支持
 */
export class LoggerService extends BaseService {
  private loggerConfig: LoggerConfig;
  private currentGameId: string | null = null;
  private globalContext: LogContext = {};
  private stats: LoggerStats;
  private activeTimers: Map<string, number> = new Map();
  private recentLogs: LogEntry[] = [];
  private readonly maxRecentLogs = 100;

  constructor(container: ServiceContainer) {
    super(container, {
      name: 'LoggerService',
      debug: false
    });

    // 初始化配置
    this.loggerConfig = {
      minLevel: LogLevel.DEBUG,
      colorEnabled: true,
      includeTimestamp: true,
      performanceEnabled: true,
      format: 'detailed'
    };

    // 初始化统计
    this.stats = {
      totalLogs: 0,
      logsByLevel: {
        [LogLevel.DEBUG]: 0,
        [LogLevel.INFO]: 0,
        [LogLevel.WARN]: 0,
        [LogLevel.ERROR]: 0
      },
      lastLogTime: Date.now(),
      performanceTimers: 0,
      activeTimers: 0
    };

    console.log('[LoggerService] 日志服务已初始化');
  }

  /**
   * 设置当前游戏ID
   */
  setCurrentGame(gameId: string): void {
    this.currentGameId = gameId;
    this.container.updateGameContext(gameId);

    this.log(LogLevel.INFO, '当前游戏ID已设置', {
      operation: 'set-current-game',
      gameId
    });
  }

  /**
   * 清除当前游戏ID
   */
  clearCurrentGame(): void {
    const oldGameId = this.currentGameId;
    this.currentGameId = null;

    this.log(LogLevel.INFO, '当前游戏ID已清除', {
      operation: 'clear-current-game',
      oldGameId
    });
  }

  /**
   * 设置全局上下文
   */
  setGlobalContext(context: LogContext): void {
    this.globalContext = { ...this.globalContext, ...context };

    this.log(LogLevel.DEBUG, '全局上下文已更新', {
      operation: 'set-global-context',
      context
    });
  }

  /**
   * 清除全局上下文
   */
  clearGlobalContext(): void {
    this.globalContext = {};

    this.log(LogLevel.DEBUG, '全局上下文已清除', {
      operation: 'clear-global-context'
    });
  }

  /**
   * 更新日志配置
   */
  updateConfig(newConfig: Partial<LoggerConfig>): void {
    const oldConfig = { ...this.loggerConfig };
    this.loggerConfig = { ...this.loggerConfig, ...newConfig };

    this.log(LogLevel.INFO, '日志配置已更新', {
      operation: 'update-config',
      oldConfig,
      newConfig: this.loggerConfig
    });
  }

  /**
   * 核心日志记录方法
   */
  private log(level: LogLevel, message: string, context?: LogContext, data?: any): void {
    // 检查日志级别
    if (!this.shouldLog(level)) {
      return;
    }

    // 合并上下文
    const mergedContext = this.mergeContext(context);

    // 创建日志条目
    const logEntry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      context: mergedContext,
      data,
      gameId: this.currentGameId || undefined,
      chatId: this.context.chatId,
      component: mergedContext.component
    };

    // 更新统计
    this.updateStats(level);

    // 保存到最近日志
    this.saveToRecentLogs(logEntry);

    // 输出日志
    this.outputLog(logEntry);
  }

  /**
   * DEBUG 级别日志
   */
  debug(message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.DEBUG, message, context, data);
  }

  /**
   * INFO 级别日志
   */
  info(message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.INFO, message, context, data);
  }

  /**
   * WARN 级别日志
   */
  warn(message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.WARN, message, context, data);
  }

  /**
   * ERROR 级别日志
   */
  error(message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.ERROR, message, context, data);
  }

  /**
   * 创建性能计时器
   */
  createPerformanceTimer(operation: string, context?: LogContext): PerformanceTimer {
    if (!this.loggerConfig.performanceEnabled) {
      // 返回空操作计时器
      return {
        end: () => 0
      };
    }

    const timerId = `${operation}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    this.activeTimers.set(timerId, startTime);
    this.stats.performanceTimers++;
    this.stats.activeTimers++;

    this.debug(`性能计时开始: ${operation}`, {
      operation: 'perf-start',
      timerId,
      targetOperation: operation,
      ...context
    });

    return {
      end: (additionalData?: any) => {
        const endTime = Date.now();
        const duration = endTime - startTime;

        this.activeTimers.delete(timerId);
        this.stats.activeTimers--;

        this.info(`性能计时结束: ${operation}`, {
          operation: 'perf-end',
          timerId,
          targetOperation: operation,
          duration: `${duration}ms`,
          ...context
        }, additionalData);

        return duration;
      }
    };
  }

  /**
   * 检查是否应该记录此级别的日志
   */
  private shouldLog(level: LogLevel): boolean {
    const levelOrder = {
      [LogLevel.DEBUG]: 0,
      [LogLevel.INFO]: 1,
      [LogLevel.WARN]: 2,
      [LogLevel.ERROR]: 3
    };

    return levelOrder[level] >= levelOrder[this.loggerConfig.minLevel];
  }

  /**
   * 合并上下文信息
   */
  private mergeContext(context?: LogContext): LogContext {
    return {
      ...this.globalContext,
      gameId: this.currentGameId || this.globalContext.gameId,
      chatId: this.context.chatId || this.globalContext.chatId,
      userId: this.context.userId || this.globalContext.userId,
      ...context
    };
  }

  /**
   * 更新统计信息
   */
  private updateStats(level: LogLevel): void {
    this.stats.totalLogs++;
    this.stats.logsByLevel[level]++;
    this.stats.lastLogTime = Date.now();
  }

  /**
   * 保存到最近日志
   */
  private saveToRecentLogs(logEntry: LogEntry): void {
    this.recentLogs.push(logEntry);

    // 保持最近日志数量限制
    if (this.recentLogs.length > this.maxRecentLogs) {
      this.recentLogs = this.recentLogs.slice(-this.maxRecentLogs);
    }
  }

  /**
   * 输出日志
   */
  private outputLog(logEntry: LogEntry): void {
    const formattedMessage = this.formatLogMessage(logEntry);

    switch (logEntry.level) {
      case LogLevel.DEBUG:
        console.log(formattedMessage);
        break;
      case LogLevel.INFO:
        console.log(formattedMessage);
        break;
      case LogLevel.WARN:
        console.warn(formattedMessage);
        break;
      case LogLevel.ERROR:
        console.error(formattedMessage);
        break;
    }
  }

  /**
   * 格式化日志消息
   */
  private formatLogMessage(logEntry: LogEntry): string {
    switch (this.loggerConfig.format) {
      case 'json':
        return JSON.stringify(logEntry);

      case 'simple':
        return `[${logEntry.level}] ${logEntry.message}`;

      case 'detailed':
      default:
        return this.formatDetailedMessage(logEntry);
    }
  }

  /**
   * 格式化详细消息
   */
  private formatDetailedMessage(logEntry: LogEntry): string {
    // const timestamp = this.loggerConfig.includeTimestamp
    //   ? new Date(logEntry.timestamp).toISOString() + ' '
    //   : '';

    const contextParts: string[] = [];

    if (logEntry.gameId) contextParts.push(`Game:${logEntry.gameId}`);
    if (logEntry.chatId) contextParts.push(`Chat:${logEntry.chatId}`);
    if (logEntry.component) contextParts.push(`${logEntry.component}`);
    if (logEntry.context?.operation) contextParts.push(`[${logEntry.context.operation}]`);

    const contextStr = contextParts.length > 0 ? `[${contextParts.join('|')}] ` : '';
    const levelStr = `[${logEntry.level}] `;

    // let message = `${timestamp}${levelStr}${contextStr}${logEntry.message}`;
    let message = `${levelStr}${contextStr}${logEntry.message}`;

    // 添加额外数据
    if (logEntry.data) {
      const extraData = this.formatExtraData(logEntry.data);
      if (extraData) {
        message += extraData;
      }
    }

    return message;
  }

  /**
   * 格式化额外数据
   */
  private formatExtraData(data: any): string {
    if (!data) return '';

    try {
      if (typeof data === 'string') return ` | ${data}`;
      if (typeof data === 'object') {
        return ` | ${JSON.stringify(data, null, 0)}`;
      }
      return ` | ${String(data)}`;
    } catch {
      return ` | [Unserializable Data]`;
    }
  }

  /**
   * 获取最近的日志
   */
  getRecentLogs(count?: number): LogEntry[] {
    const logs = count ? this.recentLogs.slice(-count) : this.recentLogs;
    return [...logs]; // 返回副本
  }

  /**
   * 获取统计信息
   */
  getStats(): LoggerStats {
    return { ...this.stats };
  }

  /**
   * 获取当前配置
   */
  getLoggerConfig(): LoggerConfig {
    return { ...this.loggerConfig };
  }

  /**
   * 清理过期的计时器
   */
  private cleanupTimers(): void {
    const now = Date.now();
    const expiredTimers: string[] = [];

    // 查找超过1小时的计时器
    this.activeTimers.forEach((startTime, timerId) => {
      if (now - startTime > 60 * 60 * 1000) {
        expiredTimers.push(timerId);
      }
    });

    // 清理过期计时器
    expiredTimers.forEach(timerId => {
      this.activeTimers.delete(timerId);
      this.stats.activeTimers--;
    });

    if (expiredTimers.length > 0) {
      this.warn(`清理了 ${expiredTimers.length} 个过期的性能计时器`, {
        operation: 'cleanup-timers',
        expiredCount: expiredTimers.length
      });
    }
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      totalLogs: 0,
      logsByLevel: {
        [LogLevel.DEBUG]: 0,
        [LogLevel.INFO]: 0,
        [LogLevel.WARN]: 0,
        [LogLevel.ERROR]: 0
      },
      lastLogTime: Date.now(),
      performanceTimers: 0,
      activeTimers: this.activeTimers.size
    };

    this.info('日志统计信息已重置', {
      operation: 'reset-stats'
    });
  }

  /**
   * 清理最近日志
   */
  clearRecentLogs(): void {
    const clearedCount = this.recentLogs.length;
    this.recentLogs = [];

    this.info(`已清理 ${clearedCount} 条最近日志`, {
      operation: 'clear-recent-logs',
      clearedCount
    });
  }

  /**
   * 自定义健康检查
   */
  protected override getCustomHealth(): Partial<ServiceHealthStatus> {
    const stats = this.getStats();
    const timeSinceLastLog = Date.now() - stats.lastLogTime;

    // 如果超过10分钟没有日志，可能有问题
    const isHealthy = timeSinceLastLog < 10 * 60 * 1000;

    return {
      healthy: isHealthy,
      message: isHealthy
        ? 'Logger service is active and recording logs'
        : `No logs for ${Math.round(timeSinceLastLog / 1000)}s`,
      details: {
        stats,
        timeSinceLastLog,
        recentLogsCount: this.recentLogs.length,
        activeTimersCount: this.activeTimers.size,
        loggerConfig: this.loggerConfig
      }
    };
  }

  /**
   * 服务上下文更新处理
   */
  protected override onContextUpdate(newContext: ServiceContext): void {
    // 当上下文更新时，可能需要清理一些状态
    if (newContext.gameId !== this.currentGameId) {
      this.currentGameId = newContext.gameId || null;
    }
  }

  /**
   * 清理资源
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();

    // 清理过期计时器
    this.cleanupTimers();

    // 记录最终统计
    const finalStats = this.getStats();

    console.log('[LoggerService] 日志服务已清理', {
      operation: 'logger-service-cleanup',
      finalStats,
      activeTimers: this.activeTimers.size,
      recentLogsCount: this.recentLogs.length
    });

    // 清空所有数据
    this.activeTimers.clear();
    this.recentLogs = [];
    this.globalContext = {};
    this.currentGameId = null;
  }

  // ========== 便捷的日志方法 ==========

  /**
   * 游戏特定的日志方法
   */
  game = {
    debug: (message: string, context?: LogContext, data?: any) => {
      this.debug(message, { component: 'GameService', ...context }, data);
    },
    info: (message: string, context?: LogContext, data?: any) => {
      this.info(message, { component: 'GameService', ...context }, data);
    },
    warn: (message: string, context?: LogContext, data?: any) => {
      this.warn(message, { component: 'GameService', ...context }, data);
    },
    error: (message: string, context?: LogContext, data?: any) => {
      this.error(message, { component: 'GameService', ...context }, data);
    }
  };

  /**
   * 骰子特定的日志方法
   */
  dice = {
    debug: (message: string, context?: LogContext, data?: any) => {
      this.debug(message, { component: 'DiceService', ...context }, data);
    },
    info: (message: string, context?: LogContext, data?: any) => {
      this.info(message, { component: 'DiceService', ...context }, data);
    },
    warn: (message: string, context?: LogContext, data?: any) => {
      this.warn(message, { component: 'DiceService', ...context }, data);
    },
    error: (message: string, context?: LogContext, data?: any) => {
      this.error(message, { component: 'DiceService', ...context }, data);
    }
  };

  /**
   * 消息队列特定的日志方法
   */
  queue = {
    debug: (message: string, context?: LogContext, data?: any) => {
      this.debug(message, { component: 'MessageQueue', ...context }, data);
    },
    info: (message: string, context?: LogContext, data?: any) => {
      this.info(message, { component: 'MessageQueue', ...context }, data);
    },
    warn: (message: string, context?: LogContext, data?: any) => {
      this.warn(message, { component: 'MessageQueue', ...context }, data);
    },
    error: (message: string, context?: LogContext, data?: any) => {
      this.error(message, { component: 'MessageQueue', ...context }, data);
    }
  };

  /**
   * API 特定的日志方法
   */
  api = {
    debug: (message: string, context?: LogContext, data?: any) => {
      this.debug(message, { component: 'ApiHandler', ...context }, data);
    },
    info: (message: string, context?: LogContext, data?: any) => {
      this.info(message, { component: 'ApiHandler', ...context }, data);
    },
    warn: (message: string, context?: LogContext, data?: any) => {
      this.warn(message, { component: 'ApiHandler', ...context }, data);
    },
    error: (message: string, context?: LogContext, data?: any) => {
      this.error(message, { component: 'ApiHandler', ...context }, data);
    }
  };

  /**
   * 性能监控方法
   */
  performance = {
    start: (operation: string, context?: LogContext): PerformanceTimer => {
      return this.createPerformanceTimer(operation, context);
    }
  };
}
