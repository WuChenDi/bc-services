import type { ServiceContainer } from '@/services'
import type {
  ServiceLifecycle,
  ServiceHealth,
  ServiceHealthStatus,
  ServiceConfig,
  PerformanceTimer,
  LogContext,
  ServiceContext,
  ServiceConstructor,
} from '@/types'

/**
 * 简化的日志服务接口 - 避免循环依赖
 */
interface SimpleLogger {
  debug(message: string, context?: LogContext, data?: any): void;
  info(message: string, context?: LogContext, data?: any): void;
  warn(message: string, context?: LogContext, data?: any): void;
  error(message: string, context?: LogContext, data?: any): void;
  performance: {
    start(operation: string, context?: LogContext): PerformanceTimer;
  };
}

/**
 * 基础服务类 - 所有业务服务的基类
 * 
 * 提供功能:
 * 1. 🔗 统一的依赖注入访问
 * 2. 📝 集成的日志管理
 * 3. 🔄 生命周期管理
 * 4. 💊 健康检查支持
 * 5. ⚡ 性能监控
 * 6. 🛡️ 错误处理
 */
export abstract class BaseService implements ServiceLifecycle, ServiceHealth {
  protected container: ServiceContainer;
  protected context: ServiceContext;
  protected logger: SimpleLogger;
  protected config: ServiceConfig;
  private createdAt: number;
  private lastHealthCheck: number = 0;

  /**
   * 构造函数
   * @param container - 服务容器
   * @param config - 服务配置 (可选)
   */
  constructor(container: ServiceContainer, config?: Partial<ServiceConfig>) {
    this.container = container;
    this.context = container.getContext();
    this.createdAt = Date.now();

    // 设置服务配置
    this.config = {
      name: this.constructor.name,
      debug: process.env.NODE_ENV === 'dev',
      ...config
    };

    // 创建简化的日志器，避免循环依赖
    this.logger = this.createLogger();

    // 记录服务创建
    this.logger.info('服务已创建', {
      operation: 'service-create',
      serviceName: this.config.name
    });

    // 自动调用初始化
    this.safeInitialize();
  }

  /**
   * 创建简化的日志器
   */
  private createLogger(): SimpleLogger {
    const serviceName = this.config.name;
    const gameId = this.context.gameId;
    const chatId = this.context.chatId;

    const formatMessage = (level: string, message: string, context?: LogContext): string => {
      const contextParts: string[] = [];

      const mergedContext = {
        gameId: gameId,
        chatId: chatId,
        component: serviceName,
        ...context
      };

      if (mergedContext.gameId) contextParts.push(`Game:${mergedContext.gameId}`);
      if (mergedContext.chatId) contextParts.push(`Chat:${mergedContext.chatId}`);
      if (mergedContext.component) contextParts.push(`${mergedContext.component}`);
      if (mergedContext.operation) contextParts.push(`[${mergedContext.operation}]`);

      const contextStr = contextParts.length > 0 ? `[${contextParts.join('|')}]` : '';
      return `[${level}] ${contextStr} ${message}`;
    };

    const formatExtraData = (data?: any): string => {
      if (!data) return '';
      try {
        if (typeof data === 'string') return ` | ${data}`;
        if (typeof data === 'object') return ` | ${JSON.stringify(data, null, 0)}`;
        return ` | ${String(data)}`;
      } catch {
        return ` | [Unserializable Data]`;
      }
    };

    return {
      debug: (message: string, context?: LogContext, data?: any) => {
        if (this.config.debug) {
          console.log(formatMessage('DEBUG', message, context) + formatExtraData(data));
        }
      },
      info: (message: string, context?: LogContext, data?: any) => {
        console.log(formatMessage('INFO', message, context) + formatExtraData(data));
      },
      warn: (message: string, context?: LogContext, data?: any) => {
        console.warn(formatMessage('WARN', message, context) + formatExtraData(data));
      },
      error: (message: string, context?: LogContext, data?: any) => {
        console.error(formatMessage('ERROR', message, context) + formatExtraData(data));
      },
      performance: {
        start: (operation: string, context?: LogContext): PerformanceTimer => {
          const startTime = Date.now();
          this.logger.debug(`Performance start: ${operation}`, {
            operation,
            ...context
          });

          return {
            end: (additionalData?: any) => {
              const duration = Date.now() - startTime;
              this.logger.info(`Performance end: ${operation}`, {
                operation,
                duration: `${duration}ms`,
                ...context
              }, additionalData);
              return duration;
            }
          };
        }
      }
    };
  }

  /**
   * 安全初始化 - 包装初始化方法以处理异常
   */
  private async safeInitialize(): Promise<void> {
    try {
      if (this.initialize) {
        await this.initialize();
        this.logger.debug('服务初始化完成', {
          operation: 'service-initialize'
        });
      }
    } catch (error) {
      this.logger.error('服务初始化失败', {
        operation: 'service-initialize-error'
      }, error);
      throw error;
    }
  }

  /**
   * 获取其他服务实例
   * @param serviceClass - 服务类构造函数
   * @returns 服务实例
   */
  protected getService<T>(serviceClass: ServiceConstructor<T>): T {
    try {
      return this.container.getService(serviceClass);
    } catch (error) {
      this.logger.error('获取服务失败', {
        operation: 'get-service-error',
        targetService: serviceClass.name
      }, error);
      throw error;
    }
  }

  /**
   * 检查服务是否存在
   * @param serviceClass - 服务类构造函数
   * @returns 是否存在
   */
  protected hasService<T>(serviceClass: ServiceConstructor<T>): boolean {
    return this.container.hasService(serviceClass);
  }

  /**
   * 创建性能计时器
   * @param operation - 操作名称
   * @param context - 额外上下文
   * @returns 性能计时器
   */
  protected createTimer(operation: string, context?: LogContext): PerformanceTimer {
    return this.logger.performance.start(operation, context);
  }

  /**
   * 安全执行异步操作
   * @param operation - 操作名称
   * @param fn - 异步函数
   * @param context - 上下文
   * @returns 操作结果
   */
  protected async safeExecute<T>(
    operation: string,
    fn: () => Promise<T>,
    context?: LogContext
  ): Promise<T> {
    const timer = this.createTimer(operation, context);

    try {
      const result = await fn();
      timer.end({ success: true });
      return result;
    } catch (error) {
      this.logger.error(`操作失败: ${operation}`, {
        operation,
        ...context
      }, error);
      timer.end({ success: false, error: true });
      throw error;
    }
  }

  /**
   * 获取服务运行时间(毫秒)
   */
  protected getUptime(): number {
    return Date.now() - this.createdAt;
  }

  /**
   * 获取服务配置
   */
  protected getConfig(): Readonly<ServiceConfig> {
    return { ...this.config };
  }

  // ========== 生命周期方法 ==========

  /**
   * 服务初始化 - 子类可重写
   */
  initialize?(): Promise<void> | void;

  /**
   * 上下文更新处理
   * @param newContext - 新的上下文
   */
  updateContext(newContext: ServiceContext): void {
    const oldGameId = this.context.gameId;
    const oldChatId = this.context.chatId;

    this.context = { ...newContext };

    // 重新创建日志器以使用新上下文
    this.logger = this.createLogger();

    this.logger.debug('服务上下文已更新', {
      operation: 'context-update',
      oldGameId,
      newGameId: newContext.gameId,
      oldChatId,
      newChatId: newContext.chatId
    });

    // 调用子类的上下文更新处理
    this.onContextUpdate?.(newContext);
  }

  /**
   * 子类可重写的上下文更新钩子
   * @param newContext - 新的上下文
   */
  protected onContextUpdate?(newContext: ServiceContext): void;

  /**
   * 服务清理 - 子类可重写
   */
  cleanup(): Promise<void> | void {
    this.logger.info('服务正在清理', {
      operation: 'service-cleanup',
      uptime: this.getUptime()
    });
  }

  // ========== 健康检查 ==========

  /**
   * 获取服务健康状态
   * @returns 健康状态
   */
  getHealth(): ServiceHealthStatus {
    this.lastHealthCheck = Date.now();

    const baseHealth: ServiceHealthStatus = {
      serviceName: this.config.name,
      healthy: true,
      message: 'Service is running normally',
      lastCheck: this.lastHealthCheck,
      details: {
        uptime: this.getUptime(),
        createdAt: this.createdAt,
        context: {
          gameId: this.context.gameId,
          chatId: this.context.chatId,
          userId: this.context.userId
        }
      }
    };

    // 调用子类的健康检查
    const customHealth = this.getCustomHealth?.();
    if (customHealth) {
      return {
        ...baseHealth,
        ...customHealth,
        details: {
          ...baseHealth.details,
          ...customHealth.details
        }
      };
    }

    return baseHealth;
  }

  /**
   * 子类可重写的自定义健康检查
   * @returns 自定义健康状态
   */
  protected getCustomHealth?(): Partial<ServiceHealthStatus>;

  // ========== 调试和监控 ==========

  /**
   * 获取服务详细信息
   */
  getServiceInfo(): {
    name: string;
    uptime: number;
    createdAt: number;
    lastHealthCheck: number;
    config: ServiceConfig;
    context: {
      gameId?: string;
      chatId?: string;
      userId?: string;
    };
  } {
    return {
      name: this.config.name,
      uptime: this.getUptime(),
      createdAt: this.createdAt,
      lastHealthCheck: this.lastHealthCheck,
      config: this.config,
      context: {
        gameId: this.context.gameId,
        chatId: this.context.chatId,
        userId: this.context.userId
      }
    };
  }

  /**
   * 启用调试模式
   */
  enableDebug(): void {
    this.config.debug = true;
    this.logger.info('调试模式已启用', {
      operation: 'enable-debug'
    });
  }

  /**
   * 禁用调试模式
   */
  disableDebug(): void {
    this.config.debug = false;
    this.logger.info('调试模式已禁用', {
      operation: 'disable-debug'
    });
  }
}
