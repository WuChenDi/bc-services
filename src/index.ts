import type { Env } from '@/types';
import { ApiHandlers } from '@/handlers';
import { ServiceContainer, LoggerService } from '@/services';
import { BaccaratGameRoom } from '@/durable-objects/baccaratGameRoom';

/**
 * Cloudflare Workers 入口点
 * 
 * 职责:
 * 1. 🌐 处理所有HTTP请求路由
 * 2. 🔧 初始化服务容器和核心服务
 * 3. 📊 提供全局的健康检查和监控
 * 4. 🛡️ 统一的错误处理和响应
 * 5. 📝 请求日志和性能监控
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);

    // 基础日志记录
    console.log(`[Worker] 收到请求: ${request.method} ${url.pathname}`);

    try {
      // 健康检查端点 - 不需要完整服务初始化
      if (url.pathname === '/health' || url.pathname === '/ping') {
        return await handleHealthCheck(env);
      }

      // 创建服务容器 (每个请求都创建新的容器实例)
      const container = await createServiceContainer(env);

      try {
        // 创建API处理器
        const apiHandlers = new ApiHandlers(container);

        // 处理请求
        const response = await apiHandlers.getApp().fetch(request, env, ctx);

        // 记录成功请求
        const duration = Date.now() - startTime;
        console.log(`[Worker] 请求完成: ${url.pathname} (${duration}ms) - ${response.status}`);

        return response;
      } finally {
        // 请求结束后清理容器资源
        try {
          container.dispose();
          console.log('[Worker] 服务容器已清理');
        } catch (cleanupError) {
          console.error('[Worker] 容器清理失败:', cleanupError);
        }
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[Worker] 请求失败: ${url.pathname} (${duration}ms):`, error);

      // 返回统一的错误响应
      return createErrorResponse(error, url.pathname);
    }
  }
};

/**
 * 创建和初始化服务容器
 */
async function createServiceContainer(env: Env): Promise<ServiceContainer> {
  try {
    console.log('[Worker] 正在创建服务容器...');

    // 验证环境变量
    validateEnvironment(env);

    // 创建Bot实例
    const bot = new (await import('grammy')).Bot(env.BOT_TOKEN);

    // 创建服务容器
    const container = ServiceContainer.create(env, bot);

    // 预热核心服务 (可选 - 可以延迟到需要时再创建)
    const logger = container.getService(LoggerService);
    logger.info('Workers 入口服务容器已创建', {
      operation: 'container-created',
      timestamp: new Date().toISOString()
    });

    console.log('[Worker] 服务容器创建完成');
    return container;
  } catch (error) {
    console.error('[Worker] 创建服务容器失败:', error);
    throw new Error(`Failed to create service container: ${error}`);
  }
}

/**
 * 验证必需的环境变量
 */
function validateEnvironment(env: Env): void {
  const requiredVars = ['BOT_TOKEN', 'BC_GAME_KV', 'GAME_ROOMS'];
  const missingVars: string[] = [];

  if (!env.BOT_TOKEN) missingVars.push('BOT_TOKEN');
  if (!env.BC_GAME_KV) missingVars.push('BC_GAME_KV');
  if (!env.GAME_ROOMS) missingVars.push('GAME_ROOMS');

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
}

/**
 * 处理健康检查
 */
async function handleHealthCheck(env: Env): Promise<Response> {
  try {
    const healthInfo = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      platform: 'cloudflare-workers',
      version: '1.0.0',
      environment: {
        botToken: env.BOT_TOKEN ? 'configured' : 'missing',
        kvNamespace: env.BC_GAME_KV ? 'configured' : 'missing',
        gameRooms: env.GAME_ROOMS ? 'configured' : 'missing',
        allowedChatIds: env.ALLOWED_CHAT_IDS ? 'configured' : 'not-set'
      },
      uptime: Date.now(), // Workers重启时间
    };

    return Response.json(healthInfo);
  } catch (error) {
    return Response.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

/**
 * 创建统一的错误响应
 */
function createErrorResponse(error: unknown, pathname: string): Response {
  const errorInfo = {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error',
    path: pathname,
    timestamp: new Date().toISOString(),
    platform: 'cloudflare-workers'
  };

  // 根据错误类型返回不同的状态码
  let status = 500;

  if (error instanceof Error) {
    if (error.message.includes('Missing required') || error.message.includes('required')) {
      status = 400; // Bad Request
    } else if (error.message.includes('not found') || error.message.includes('Not Found')) {
      status = 404; // Not Found
    } else if (error.message.includes('unauthorized') || error.message.includes('forbidden')) {
      status = 403; // Forbidden
    }
  }

  return Response.json(errorInfo, { status });
}

/**
 * 导出Durable Object类
 */
export { BaccaratGameRoom };
