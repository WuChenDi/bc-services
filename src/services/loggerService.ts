export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR'
}

export interface LogContext {
  gameId?: string;
  chatId?: string;
  userId?: string;
  component?: string;
  operation?: string;
  [key: string]: any;
}

export class LoggerService {
  private static instance: LoggerService;
  private currentGameId: string | null = null;
  private globalContext: LogContext = {};

  private constructor() { }

  static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }
    return LoggerService.instance;
  }

  /**
   * 设置当前游戏ID
   */
  setCurrentGame(gameId: string): void {
    this.currentGameId = gameId;
  }

  /**
   * 清除当前游戏ID
   */
  clearCurrentGame(): void {
    this.currentGameId = null;
  }

  /**
   * 设置全局上下文
   */
  setGlobalContext(context: LogContext): void {
    this.globalContext = { ...this.globalContext, ...context };
  }

  /**
   * 清除全局上下文
   */
  clearGlobalContext(): void {
    this.globalContext = {};
  }

  /**
   * 格式化日志消息
   */
  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const mergedContext = {
      ...this.globalContext,
      ...context,
      gameId: context?.gameId || this.currentGameId
    };

    // 构建上下文字符串
    const contextParts: string[] = [];

    if (mergedContext.gameId) {
      contextParts.push(`Game:${mergedContext.gameId}`);
    }

    if (mergedContext.chatId) {
      contextParts.push(`Chat:${mergedContext.chatId}`);
    }

    if (mergedContext.userId) {
      contextParts.push(`User:${mergedContext.userId}`);
    }

    if (mergedContext.component) {
      contextParts.push(`${mergedContext.component}`);
    }

    if (mergedContext.operation) {
      contextParts.push(`[${mergedContext.operation}]`);
    }

    const contextStr = contextParts.length > 0 ? `[${contextParts.join('|')}]` : '';
    const levelStr = `[${level}]`;

    // return `${timestamp} ${levelStr} ${contextStr} ${message}`;
    return `${levelStr} ${contextStr} ${message}`;
  }

  /**
   * 添加额外的调试信息
   */
  private formatExtraData(data?: any): string {
    if (!data) return '';

    try {
      if (typeof data === 'string') return ` | ${data}`;
      if (typeof data === 'object') {
        return ` | ${JSON.stringify(data, null, 0)}`;
      }
      return ` | ${String(data)}`;
    } catch (error) {
      return ` | [Unserializable Data]`;
    }
  }

  /**
   * DEBUG 级别日志
   */
  debug(message: string, context?: LogContext, data?: any): void {
    const formattedMessage = this.formatMessage(LogLevel.DEBUG, message, context);
    const extraData = this.formatExtraData(data);
    console.log(formattedMessage + extraData);
  }

  /**
   * INFO 级别日志
   */
  info(message: string, context?: LogContext, data?: any): void {
    const formattedMessage = this.formatMessage(LogLevel.INFO, message, context);
    const extraData = this.formatExtraData(data);
    console.log(formattedMessage + extraData);
  }

  /**
   * WARN 级别日志
   */
  warn(message: string, context?: LogContext, data?: any): void {
    const formattedMessage = this.formatMessage(LogLevel.WARN, message, context);
    const extraData = this.formatExtraData(data);
    console.warn(formattedMessage + extraData);
  }

  /**
   * ERROR 级别日志
   */
  error(message: string, context?: LogContext, data?: any): void {
    const formattedMessage = this.formatMessage(LogLevel.ERROR, message, context);
    const extraData = this.formatExtraData(data);
    console.error(formattedMessage + extraData);
  }

  /**
   * 游戏特定的日志方法 - 自动包含当前游戏上下文
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
      const startTime = Date.now();
      this.debug(`Performance start: ${operation}`, {
        operation,
        ...context
      });

      return {
        end: (additionalData?: any) => {
          const duration = Date.now() - startTime;
          this.info(`Performance end: ${operation}`, {
            operation,
            duration: `${duration}ms`,
            ...context
          }, additionalData);
          return duration;
        }
      };
    }
  };
}

export interface PerformanceTimer {
  end: (additionalData?: any) => number;
}

export const logger = LoggerService.getInstance();
