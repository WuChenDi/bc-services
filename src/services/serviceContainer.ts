import type { Bot } from 'grammy'
import type { Env, ServiceConstructor, ServiceContext } from '@/types'
import { getConstants } from '@/config/constants'

/**
 * 服务容器 - 依赖注入核心
 * 
 * 职责:
 * 1. 管理所有服务实例的生命周期
 * 2. 提供统一的上下文传递机制
 * 3. 实现服务间的依赖注入
 * 4. 统一资源清理和内存管理
 */
export class ServiceContainer {
  private services: Map<string, any> = new Map();
  private context: ServiceContext;
  private isDisposed: boolean = false;

  /**
   * 私有构造函数 - 强制使用工厂方法创建
   */
  private constructor(context: ServiceContext) {
    this.context = { ...context };
  }

  /**
   * 创建服务容器实例
   * 
   * @param env - 环境变量
   * @param bot - Telegram Bot 实例
   * @param state - Durable Object 状态 (可选，Worker环境下可能不可用)
   * @returns 服务容器实例
   */
  static create(env: Env, bot: Bot, state?: DurableObjectState): ServiceContainer {
    const constants = getConstants(env);

    const context: ServiceContext = {
      env,
      bot,
      state,
      constants
    };

    // 记录容器创建信息
    console.log(`[ServiceContainer] Creating container - Environment: ${state ? 'DurableObject' : 'Worker'}`);

    if (!state) {
      console.log('[ServiceContainer] No DurableObjectState provided - running in Worker mode');
      console.log('[ServiceContainer] Services requiring state will use alternative storage (KV, D1, etc.)');
    }

    return new ServiceContainer(context);
  }

  /**
   * 检查是否在 Durable Object 环境中运行
   * 
   * @returns 是否有可用的 DurableObjectState
   */
  hasDurableObjectState(): boolean {
    return !!this.context.state;
  }

  /**
   * 获取 DurableObjectState (如果可用)
   * 
   * @returns DurableObjectState 或 undefined
   */
  getDurableObjectState(): DurableObjectState | undefined {
    return this.context.state;
  }

  /**
   * 安全获取 DurableObjectState
   * 如果不可用，抛出错误并提供替代方案建议
   * 
   * @returns DurableObjectState
   * @throws Error 如果在 Worker 环境中调用
   */
  requireDurableObjectState(): DurableObjectState {
    if (!this.context.state) {
      throw new Error(
        'DurableObjectState is not available in Worker environment. ' +
        'Consider using KV storage, D1 database, or other Worker-compatible storage solutions.'
      );
    }
    return this.context.state;
  }

  /**
   * 获取或创建服务实例 (单例模式)
   * 
   * @param serviceClass - 服务类构造函数
   * @returns 服务实例
   */
  getService<T>(serviceClass: ServiceConstructor<T>): T {
    if (this.isDisposed) {
      throw new Error('ServiceContainer has been disposed');
    }

    const serviceName = serviceClass.name;

    // 如果服务已存在，直接返回
    if (this.services.has(serviceName)) {
      return this.services.get(serviceName)!;
    }

    // 创建新的服务实例
    try {
      const serviceInstance = new serviceClass(this);
      this.services.set(serviceName, serviceInstance);

      console.log(`[ServiceContainer] Created service: ${serviceName}`);
      return serviceInstance;
    } catch (error) {
      console.error(`[ServiceContainer] Failed to create service ${serviceName}:`, error);
      throw new Error(`Failed to create service ${serviceName}: ${error}`);
    }
  }

  /**
   * 获取当前上下文
   * 
   * @returns 服务上下文
   */
  getContext(): Readonly<ServiceContext> {
    return { ...this.context };
  }

  /**
   * 更新游戏上下文
   * 
   * @param gameId - 游戏ID
   * @param chatId - 聊天ID (可选)
   * @param userId - 用户ID (可选)
   */
  updateGameContext(gameId: string, chatId?: string, userId?: string): void {
    if (this.isDisposed) {
      console.warn('[ServiceContainer] Cannot update context on disposed container');
      return;
    }

    // 更新上下文
    this.context.gameId = gameId;
    if (chatId) this.context.chatId = chatId;
    if (userId) this.context.userId = userId;

    console.log(`[ServiceContainer] Updated game context: gameId=${gameId}, chatId=${chatId}, userId=${userId}`);

    // 通知所有已创建的服务更新上下文
    this.services.forEach((service, serviceName) => {
      try {
        if (service && typeof service.updateContext === 'function') {
          service.updateContext(this.context);
          console.log(`[ServiceContainer] Updated context for service: ${serviceName}`);
        }
      } catch (error) {
        console.error(`[ServiceContainer] Failed to update context for service ${serviceName}:`, error);
      }
    });
  }

  /**
   * 清除游戏上下文
   */
  clearGameContext(): void {
    if (this.isDisposed) {
      return;
    }

    this.context.gameId = undefined;
    this.context.chatId = undefined;
    this.context.userId = undefined;

    console.log('[ServiceContainer] Cleared game context');

    // 通知所有服务清除上下文
    this.services.forEach((service, serviceName) => {
      try {
        if (service && typeof service.updateContext === 'function') {
          service.updateContext(this.context);
        }
      } catch (error) {
        console.error(`[ServiceContainer] Failed to clear context for service ${serviceName}:`, error);
      }
    });
  }

  /**
   * 检查服务是否已创建
   * 
   * @param serviceClass - 服务类构造函数
   * @returns 是否已创建
   */
  hasService<T>(serviceClass: ServiceConstructor<T>): boolean {
    return this.services.has(serviceClass.name);
  }

  /**
   * 获取已创建的服务列表
   * 
   * @returns 服务名称列表
   */
  getCreatedServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * 获取容器状态信息
   * 
   * @returns 容器状态
   */
  getContainerInfo(): {
    isDisposed: boolean;
    serviceCount: number;
    services: string[];
    environment: 'worker' | 'durable-object';
    context: {
      gameId?: string;
      chatId?: string;
      userId?: string;
    };
  } {
    return {
      isDisposed: this.isDisposed,
      serviceCount: this.services.size,
      services: this.getCreatedServices(),
      environment: this.hasDurableObjectState() ? 'durable-object' : 'worker',
      context: {
        gameId: this.context.gameId,
        chatId: this.context.chatId,
        userId: this.context.userId
      }
    };
  }

  /**
   * 清理所有服务资源
   * 
   * ⚠️ 调用后容器将不可用
   */
  dispose(): void {
    if (this.isDisposed) {
      console.warn('[ServiceContainer] Container already disposed');
      return;
    }

    console.log(`[ServiceContainer] Disposing container with ${this.services.size} services`);

    // 按创建顺序的逆序清理服务
    const serviceEntries = Array.from(this.services.entries()).reverse();

    for (const [serviceName, service] of serviceEntries) {
      try {
        if (service && typeof service.cleanup === 'function') {
          service.cleanup();
          console.log(`[ServiceContainer] Cleaned up service: ${serviceName}`);
        }
      } catch (error) {
        console.error(`[ServiceContainer] Failed to cleanup service ${serviceName}:`, error);
      }
    }

    // 清空服务映射
    this.services.clear();

    // 标记为已释放
    this.isDisposed = true;

    console.log('[ServiceContainer] Container disposed successfully');
  }

  /**
   * 析构函数 - 确保资源被释放
   */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
