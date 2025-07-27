import { Bot } from 'grammy';
import type { Env, StartGameRequest, PlaceBetRequest, EnableAutoRequest } from '@/types';
import { ServiceContainer, GameService, LoggerService } from '@/services';

/**
 * 百家乐游戏房间 Durable Object
 * 
 * 职责:
 * 1. 🏠 为每个聊天群组提供独立的游戏实例
 * 2. 📡 处理来自API和命令的各种游戏请求
 * 3. 🔄 管理服务容器的生命周期
 * 4. 🛡️ 提供统一的错误处理和响应格式
 * 5. 📊 维护游戏房间的状态和统计
 * 6. 🎮 支持完整的Telegram命令集成
 */
export class BaccaratGameRoom {
  private container: ServiceContainer | null = null;
  private isInitialized: boolean = false;
  private currentChatId: string | null = null;

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {
    console.log('[BaccaratGameRoom] 游戏房间已创建');
  }

  /**
   * 处理所有HTTP请求
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const startTime = Date.now();

    console.log(`[BaccaratGameRoom] 收到请求: ${request.method} ${url.pathname}`);

    try {
      // 确保服务容器已初始化
      await this.ensureInitialized();

      // 路由分发
      switch (url.pathname) {
        case '/start-game':
          return await this.handleStartGame(request);
        case '/place-bet':
          return await this.handlePlaceBet(request);
        case '/process-game':
          return await this.handleProcessGame(request);
        case '/get-status':
          return await this.handleGetStatus();
        case '/stop-game':
          return await this.handleStopGame();
        case '/force-stop-game':
          return await this.handleForceStopGame(request);
        case '/enable-auto':
          return await this.handleEnableAuto(request);
        case '/disable-auto':
          return await this.handleDisableAuto(request);
        case '/health':
          return await this.handleHealthCheck();
        case '/stats':
          return await this.handleGetStats();
        default:
          return this.createErrorResponse('Not Found', 404);
      }
    } catch (error) {
      console.error('[BaccaratGameRoom] 请求处理失败:', error);

      const logger = this.getLoggerService();
      if (logger) {
        logger.error('DO请求处理失败', {
          operation: 'do-request-failed',
          pathname: url.pathname,
          method: request.method
        }, error);
      }

      return this.createErrorResponse(
        `Internal Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        500
      );
    } finally {
      const duration = Date.now() - startTime;
      console.log(`[BaccaratGameRoom] 请求完成: ${url.pathname} (${duration}ms)`);

      // 请求结束后清理容器资源（但不销毁容器本身）
      if (this.container) {
        try {
          // 这里不调用 dispose()，因为容器需要在多个请求间复用
          // 只清理一些临时状态或过期缓存
          console.log('[BaccaratGameRoom] 请求资源清理完成');
        } catch (cleanupError) {
          console.error('[BaccaratGameRoom] 清理资源失败:', cleanupError);
        }
      }
    }
  }

  /**
   * 确保服务容器已初始化
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized && this.container) {
      return;
    }

    try {
      console.log('[BaccaratGameRoom] 正在初始化服务容器...');

      // 创建Bot实例
      const bot = new Bot(this.env.BOT_TOKEN);

      // 创建服务容器
      this.container = ServiceContainer.create(this.env, bot, this.state);

      // 初始化游戏服务
      const gameService = this.container.getService(GameService);
      await gameService.initialize();

      this.isInitialized = true;
      console.log('[BaccaratGameRoom] 服务容器初始化完成');
    } catch (error) {
      console.error('[BaccaratGameRoom] 初始化失败:', error);

      // 清理失败的容器
      if (this.container) {
        try {
          this.container.dispose();
        } catch (disposeError) {
          console.error('[BaccaratGameRoom] 容器清理失败:', disposeError);
        }
        this.container = null;
      }

      this.isInitialized = false;
      throw new Error(`服务容器初始化失败: ${error}`);
    }
  }

  /**
   * 获取游戏服务实例
   */
  private getGameService(): GameService {
    if (!this.container) {
      throw new Error('Service container not initialized');
    }
    return this.container.getService(GameService);
  }

  /**
   * 获取日志服务实例
   */
  private getLoggerService(): LoggerService | null {
    try {
      if (!this.container) return null;

      return this.container.getService(LoggerService);
    } catch {
      return null;
    }
  }

  /**
   * 提取chatId从请求
   */
  private async extractChatId(request: Request): Promise<string | null> {
    try {
      const body = await request.json() as StartGameRequest;
      return body.chatId || this.currentChatId;
    } catch {
      return this.currentChatId;
    }
  }

  /**
   * 处理开始游戏请求
   */
  private async handleStartGame(request: Request): Promise<Response> {
    try {
      const { chatId } = await request.json() as StartGameRequest;

      if (!chatId) {
        return this.createErrorResponse('chatId is required', 400);
      }

      // 设置当前chatId
      this.currentChatId = chatId;

      console.log(`[BaccaratGameRoom] 开始游戏: chatId=${chatId}`);

      const gameService = this.getGameService();
      const result = await gameService.startGame(chatId);

      console.log(`[BaccaratGameRoom] 游戏启动结果:`, result);

      if (result.success) {
        return Response.json({
          success: true,
          message: '新游戏已开始',
          gameNumber: result.gameNumber,
          chatId,
          timestamp: new Date().toISOString()
        });
      } else {
        return this.createErrorResponse(result.error || '开始游戏失败', 400);
      }
    } catch (error) {
      console.error('[BaccaratGameRoom] 开始游戏失败:', error);
      return this.createErrorResponse('Failed to start game', 500);
    }
  }

  /**
   * 处理下注请求
   */
  private async handlePlaceBet(request: Request): Promise<Response> {
    try {
      const body = await request.json() as PlaceBetRequest & { chatId?: string };
      const { userId, userName, betType, amount, chatId } = body;

      if (!userId || !betType || !amount) {
        return this.createErrorResponse('Missing required parameters: userId, betType, amount', 400);
      }

      // 验证下注类型
      const validBetTypes = ['banker', 'player', 'tie'];
      if (!validBetTypes.includes(betType)) {
        return this.createErrorResponse('Invalid bet type. Must be: banker, player, or tie', 400);
      }

      // 验证金额
      if (typeof amount !== 'number' || amount <= 0 || amount > 10000) {
        return this.createErrorResponse('Bet amount must be between 1 and 10000', 400);
      }

      // 更新chatId
      if (chatId) {
        this.currentChatId = chatId;
      }

      console.log(`[BaccaratGameRoom] 处理下注: userId=${userId}, betType=${betType}, amount=${amount}`);

      const gameService = this.getGameService();
      const result = await gameService.placeBet(userId, userName || userId, betType, amount);

      if (result.success) {
        // 修正：从下注结果中获取统计信息
        const totalBetsAmount = result.totalBetsAmount || 0;
        const totalBetsCount = result.totalBetsCount || 0;
        const usersCount = result.totalBets || 0; // totalBets 在这里指的是用户数量

        const betTypeNames = {
          banker: '庄家',
          player: '闲家',
          tie: '和局'
        };

        return Response.json({
          success: true,
          message: '下注成功',
          bet: {
            userId,
            userName: userName || userId,
            betType,
            amount: result.amount,
            timestamp: new Date().toISOString()
          },
          totalBets: totalBetsAmount,  // 总下注金额
          betsCount: totalBetsCount,   // 总下注数量
          usersCount: usersCount,      // 参与用户数量
          betTypeName: betTypeNames[betType],
          isAccumulated: result.isAccumulated,
          isReplaced: result.isReplaced,
          previousAmount: result.previousAmount,
          remainingTime: result.remainingTime
        });
      } else {
        return this.createErrorResponse(result.error || '下注失败', 400);
      }
    } catch (error) {
      console.error('[BaccaratGameRoom] 下注处理失败:', error);
      return this.createErrorResponse('Failed to place bet', 500);
    }
  }

  /**
   * 处理游戏处理请求
   */
  private async handleProcessGame(request?: Request): Promise<Response> {
    try {
      console.log('[BaccaratGameRoom] 处理游戏请求');

      // 如果有请求体，尝试提取chatId
      if (request) {
        const chatId = await this.extractChatId(request);
        if (chatId) {
          this.currentChatId = chatId;
        }
      }

      const gameService = this.getGameService();
      const result = await gameService.processGame();

      if (result.success) {
        return Response.json({
          success: true,
          message: '游戏处理完成',
          timestamp: new Date().toISOString()
        });
      } else {
        return this.createErrorResponse(result.error || '游戏处理失败', 400);
      }
    } catch (error) {
      console.error('[BaccaratGameRoom] 游戏处理失败:', error);
      return this.createErrorResponse('Failed to process game', 500);
    }
  }

  /**
   * 处理获取状态请求
   */
  private async handleGetStatus(): Promise<Response> {
    try {
      console.log('[BaccaratGameRoom] 获取游戏状态');

      const gameService = this.getGameService();
      const statusResult = await gameService.getGameStatus();

      if (statusResult.success && statusResult.status) {
        return Response.json({
          success: true,
          status: {
            ...statusResult.status,
            // 确保状态包含所有必要字段
            totalBets: statusResult.status.totalBets || 0,
            betsCount: statusResult.status.betsCount || 0,
            totalBetsCount: statusResult.status.totalBetsCount || 0,
            usersCount: statusResult.status.betsCount || 0
          },
          timestamp: new Date().toISOString()
        });
      } else {
        return this.createErrorResponse(statusResult.error || '获取状态失败', 400);
      }
    } catch (error) {
      console.error('[BaccaratGameRoom] 获取状态失败:', error);
      return this.createErrorResponse('Failed to get game status', 500);
    }
  }

  /**
   * 处理停止游戏请求
   */
  private async handleStopGame(): Promise<Response> {
    try {
      console.log('[BaccaratGameRoom] 停止游戏');

      const gameService = this.getGameService();
      await gameService.forceStopCurrentGame();

      return Response.json({
        success: true,
        message: '游戏已停止',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[BaccaratGameRoom] 停止游戏失败:', error);
      return this.createErrorResponse('Failed to stop game', 500);
    }
  }

  /**
   * 处理强制停止游戏请求
   */
  private async handleForceStopGame(request: Request): Promise<Response> {
    try {
      const chatId = await this.extractChatId(request);
      
      console.log(`[BaccaratGameRoom] 强制停止游戏: chatId=${chatId}`);

      const gameService = this.getGameService();
      
      // 1. 禁用自动游戏
      await gameService.disableAutoGame();
      
      // 2. 强制清理当前游戏
      await gameService.forceStopCurrentGame();
      
      // 3. 清理消息队列
      gameService.clearMessageQueue();

      return Response.json({
        success: true,
        message: '游戏已强制停止',
        chatId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[BaccaratGameRoom] 强制停止游戏失败:', error);
      return this.createErrorResponse('Failed to force stop game', 500);
    }
  }

  /**
   * 处理启用自动游戏请求
   */
  private async handleEnableAuto(request: Request): Promise<Response> {
    try {
      const { chatId } = await request.json() as EnableAutoRequest;

      if (!chatId) {
        return this.createErrorResponse('chatId is required', 400);
      }

      // 设置当前chatId
      this.currentChatId = chatId;

      console.log(`[BaccaratGameRoom] 启用自动游戏: chatId=${chatId}`);

      const gameService = this.getGameService();
      const result = await gameService.enableAutoGame(chatId);

      if (result.success) {
        return Response.json({
          success: true,
          message: '自动游戏模式已启用',
          chatId,
          timestamp: new Date().toISOString()
        });
      } else {
        return this.createErrorResponse(result.error || '启用自动游戏失败', 400);
      }
    } catch (error) {
      console.error('[BaccaratGameRoom] 启用自动游戏失败:', error);
      return this.createErrorResponse('Failed to enable auto game', 500);
    }
  }

  /**
   * 处理禁用自动游戏请求
   */
  private async handleDisableAuto(request?: Request): Promise<Response> {
    try {
      console.log('[BaccaratGameRoom] 禁用自动游戏');

      // 如果有请求体，尝试提取chatId
      if (request) {
        const chatId = await this.extractChatId(request);
        if (chatId) {
          this.currentChatId = chatId;
        }
      }

      const gameService = this.getGameService();
      const result = await gameService.disableAutoGame();

      if (result.success) {
        return Response.json({
          success: true,
          message: '自动游戏模式已禁用',
          timestamp: new Date().toISOString()
        });
      } else {
        return this.createErrorResponse(result.error || '禁用自动游戏失败', 400);
      }
    } catch (error) {
      console.error('[BaccaratGameRoom] 禁用自动游戏失败:', error);
      return this.createErrorResponse('Failed to disable auto game', 500);
    }
  }

  /**
   * 处理健康检查请求
   */
  private async handleHealthCheck(): Promise<Response> {
    try {
      console.log('[BaccaratGameRoom] 健康检查');

      if (!this.container) {
        return Response.json({
          healthy: false,
          message: 'Service container not initialized',
          timestamp: new Date().toISOString()
        });
      }

      // 获取容器信息
      const containerInfo = this.container.getContainerInfo();

      // 获取各服务的健康状态
      const gameService = this.getGameService();
      const gameHealth = gameService.getHealth();

      const healthInfo = {
        healthy: gameHealth.healthy && !containerInfo.isDisposed,
        message: gameHealth.healthy ? 'All services operational' : gameHealth.message,
        timestamp: new Date().toISOString(),
        container: containerInfo,
        services: {
          game: gameHealth
        },
        currentChatId: this.currentChatId
      };

      return Response.json(healthInfo);
    } catch (error) {
      console.error('[BaccaratGameRoom] 健康检查失败:', error);
      return Response.json({
        healthy: false,
        message: `Health check failed: ${error}`,
        timestamp: new Date().toISOString()
      }, { status: 500 });
    }
  }

  /**
   * 处理获取统计信息请求
   */
  private async handleGetStats(): Promise<Response> {
    try {
      console.log('[BaccaratGameRoom] 获取统计信息');

      if (!this.container) {
        return this.createErrorResponse('Service container not initialized', 500);
      }

      const gameService = this.getGameService();
      const gameStats = gameService.getStats();
      const queueStatus = gameService.getMessageQueueStatus();

      const stats = {
        game: gameStats,
        queue: queueStatus,
        container: this.container.getContainerInfo(),
        currentChatId: this.currentChatId,
        timestamp: new Date().toISOString(),
        endpoints: [
          '/start-game',
          '/place-bet',
          '/process-game',
          '/get-status',
          '/stop-game',
          '/enable-auto',
          '/disable-auto',
          '/health',
          '/stats'
        ]
      };

      return Response.json({
        success: true,
        stats
      });
    } catch (error) {
      console.error('[BaccaratGameRoom] 获取统计失败:', error);
      return this.createErrorResponse('Failed to get stats', 500);
    }
  }

  /**
   * 创建错误响应
   */
  private createErrorResponse(message: string, status: number = 500): Response {
    return Response.json({
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
      currentChatId: this.currentChatId
    }, { status });
  }

  /**
   * 创建成功响应
   */
  private createSuccessResponse(data: any, message?: string): Response {
    return Response.json({
      success: true,
      message,
      data,
      timestamp: new Date().toISOString(),
      currentChatId: this.currentChatId
    });
  }

  /**
   * Durable Object 销毁时的清理
   * 
   * 注意：这个方法在 Cloudflare Workers 环境中可能不会被调用
   * 主要依赖请求结束时的清理逻辑
   */
  async dispose(): Promise<void> {
    console.log('[BaccaratGameRoom] 开始清理游戏房间...');

    if (this.container) {
      try {
        // 停止自动游戏
        const gameService = this.getGameService();
        await gameService.disableAutoGame();
        await gameService.cleanupGame();

        // 清理容器
        this.container.dispose();
        console.log('[BaccaratGameRoom] 服务容器已清理');
      } catch (error) {
        console.error('[BaccaratGameRoom] 清理服务容器失败:', error);
      }
      this.container = null;
    }

    this.isInitialized = false;
    this.currentChatId = null;
    console.log('[BaccaratGameRoom] 游戏房间清理完成');
  }
}
