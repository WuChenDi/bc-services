import type { Env } from '@/types';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { webhookCallback } from 'grammy';
import { CommandHandlers } from '@/handlers/commandHandlers';
import { ServiceContainer, BotService, StorageService, LoggerService } from '@/services';

/**
 * API 路由处理器
 * 
 * 职责:
 * 1. 🌐 设置所有HTTP路由和中间件
 * 2. 📡 处理Webhook和API请求
 * 3. 🔧 集成服务容器和业务逻辑
 * 4. 🛡️ 统一的错误处理和验证
 * 5. 📊 API请求统计和监控
 */
export class ApiHandlers {
  private app: Hono<{ Bindings: Env }>;
  private container: ServiceContainer;
  private commandHandlers: CommandHandlers;

  constructor(container: ServiceContainer) {
    this.container = container;
    this.app = new Hono<{ Bindings: Env }>();

    // 设置CORS中间件
    this.app.use('*', cors());

    // 获取服务实例
    const botService = this.container.getService(BotService);
    const storageService = this.container.getService(StorageService);
    const logger = this.container.getService(LoggerService);

    // 获取环境配置
    const context = this.container.getContext();
    if (!context.env.GAME_ROOMS) {
      throw new Error('GAME_ROOMS binding not found');
    }

    // 创建增强命令处理器
    this.commandHandlers = new CommandHandlers(
      botService,
      storageService,
      logger,
      context.env.GAME_ROOMS
    );

    // 注册所有路由
    this.registerRoutes();

    logger.info('API处理器已初始化', {
      operation: 'api-handlers-init',
      commandCount: 18
    });
  }

  /**
   * 注册所有路由
   */
  private registerRoutes(): void {
    // 基础路由
    this.app.get('/', (c) => {
      const context = this.container.getContext();
      return c.json({
        message: '百家乐 Bot with Hono and Durable Objects!',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        features: [
          '✅ 完整的Telegram命令支持',
          '✅ 直接API调用功能',
          '✅ 自动游戏模式',
          '✅ 实时下注和状态查询',
          '✅ 游戏历史记录'
        ],
        constants: {
          bettingDuration: `${context.constants.BETTING_DURATION_MS / 1000}s`,
          autoGameInterval: `${context.constants.AUTO_GAME_INTERVAL_MS / 1000}s`,
          diceAnimationWait: `${context.constants.DICE_ANIMATION_WAIT_MS / 1000}s`
        },
        services: this.container.getCreatedServices()
      });
    });

    this.app.get('/health', (c) => {
      try {
        const containerInfo = this.container.getContainerInfo();
        const context = this.container.getContext();

        return c.json({
          status: 'ok',
          platform: 'cloudflare-workers',
          timestamp: new Date().toISOString(),
          container: containerInfo,
          config: {
            bettingDurationMs: context.constants.BETTING_DURATION_MS,
            autoGameIntervalMs: context.constants.AUTO_GAME_INTERVAL_MS,
            diceAnimationWaitMs: context.constants.DICE_ANIMATION_WAIT_MS,
            globalProcessTimeoutMs: context.constants.GLOBAL_PROCESS_TIMEOUT_MS
          },
          commandsEnabled: true
        });
      } catch (error) {
        return c.json({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }, 500);
      }
    });

    // Webhook路由
    this.app.post('/webhook', async (c) => {
      try {
        const botService = this.container.getService(BotService);
        const callback = webhookCallback(botService.bot, 'hono');
        return await callback(c);
      } catch (error) {
        const logger = this.container.getService(LoggerService);
        logger.error('Webhook处理失败', {
          operation: 'webhook-error'
        }, error);

        return c.json({
          error: 'Webhook processing failed',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 游戏历史记录API
    this.app.get('/game-history/:chatId', async (c) => {
      try {
        const chatId = c.req.param('chatId');
        const limit = parseInt(c.req.query('limit') || '10');

        // 验证群组权限
        if (!this.validateChatId(c, chatId)) {
          return c.json({ error: 'Chat ID not allowed' }, 403);
        }

        const storageService = this.container.getService(StorageService);
        const result = await storageService.getGameHistory(chatId, limit);

        if (result.success) {
          return c.json({
            success: true,
            history: result.data,
            total: result.data?.length || 0
          });
        } else {
          return c.json({
            success: false,
            error: result.error
          }, 500);
        }
      } catch (error) {
        const logger = this.container.getService(LoggerService);
        logger.error('获取游戏历史失败', {
          operation: 'get-game-history-error'
        }, error);

        return c.json({
          error: 'Failed to get game history',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 游戏详情API
    this.app.get('/game-detail/:gameNumber', async (c) => {
      try {
        const gameNumber = c.req.param('gameNumber');

        // 验证游戏编号格式
        if (!/^\d{17}$/.test(gameNumber)) {
          return c.json({
            success: false,
            error: 'Invalid game number format. Expected 17 digits.'
          }, 400);
        }

        const storageService = this.container.getService(StorageService);
        const result = await storageService.getGameDetail(gameNumber);

        if (result.success) {
          return c.json({ success: true, game: result.data });
        } else {
          return c.json({ success: false, error: result.error }, 404);
        }
      } catch (error) {
        const logger = this.container.getService(LoggerService);
        logger.error('获取游戏详情失败', {
          operation: 'get-game-detail-error'
        }, error);

        return c.json({
          error: 'Failed to get game detail',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // Durable Object 游戏操作代理路由
    this.app.post('/auto-game/:chatId', async (c) => this.proxyToGameRoom(c, '/start-game'));
    this.app.post('/enable-auto/:chatId', async (c) => this.proxyToGameRoom(c, '/enable-auto'));
    this.app.post('/disable-auto/:chatId', async (c) => this.proxyToGameRoom(c, '/disable-auto'));
    this.app.post('/process-game/:chatId', async (c) => this.proxyToGameRoom(c, '/process-game'));
    this.app.get('/game-status/:chatId', async (c) => this.proxyToGameRoom(c, '/get-status'));
    this.app.post('/place-bet/:chatId', async (c) => this.proxyToGameRoom(c, '/place-bet'));

    // 发送消息API
    this.app.post('/send-message', async (c) => {
      try {
        const { chatId, message, parseMode } = await c.req.json();

        if (!chatId || !message) {
          return c.json({ error: 'chatId and message are required' }, 400);
        }

        // 验证群组权限
        if (!this.validateChatId(c, chatId.toString())) {
          return c.json({ error: 'Chat ID not allowed' }, 403);
        }

        const botService = this.container.getService(BotService);
        const result = await botService.sendMessage(chatId, message, {
          parseMode: parseMode || 'Markdown'
        });

        if (result.success) {
          return c.json({
            success: true,
            messageId: result.data?.message_id,
            timestamp: new Date().toISOString()
          });
        } else {
          return c.json({
            success: false,
            error: result.error
          }, 500);
        }
      } catch (error) {
        const logger = this.container.getService(LoggerService);
        logger.error('发送消息失败', {
          operation: 'send-message-error'
        }, error);

        return c.json({
          error: 'Failed to send message',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 设置Webhook API
    this.app.post('/set-webhook', async (c) => {
      try {
        const { url } = await c.req.json();
        if (!url) {
          return c.json({ error: 'webhook url is required' }, 400);
        }

        // 验证URL格式
        try {
          new URL(url);
        } catch {
          return c.json({ error: 'Invalid webhook URL format' }, 400);
        }

        const botService = this.container.getService(BotService);
        const result = await botService.setWebhook(url);

        if (result.success) {
          return c.json({
            success: true,
            message: 'Webhook set successfully',
            url,
            timestamp: new Date().toISOString()
          });
        } else {
          return c.json({
            success: false,
            error: result.error
          }, 500);
        }
      } catch (error) {
        const logger = this.container.getService(LoggerService);
        logger.error('设置Webhook失败', {
          operation: 'set-webhook-error'
        }, error);

        return c.json({
          error: 'Failed to set webhook',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 获取配置信息API
    this.app.get('/config', (c) => {
      const context = this.container.getContext();

      return c.json({
        success: true,
        config: {
          // 核心游戏时间
          bettingDurationMs: context.constants.BETTING_DURATION_MS,
          autoGameIntervalMs: context.constants.AUTO_GAME_INTERVAL_MS,

          // 骰子相关时间
          diceRollTimeoutMs: context.constants.DICE_ROLL_TIMEOUT_MS,
          diceRollMaxRetries: context.constants.DICE_ROLL_MAX_RETRIES,
          diceAnimationWaitMs: context.constants.DICE_ANIMATION_WAIT_MS,
          diceResultDelayMs: context.constants.DICE_RESULT_DELAY_MS,

          // 流程控制时间
          cardDealDelayMs: context.constants.CARD_DEAL_DELAY_MS,
          messageDelayMs: context.constants.MESSAGE_DELAY_MS,

          // 系统保护时间
          globalProcessTimeoutMs: context.constants.GLOBAL_PROCESS_TIMEOUT_MS,
          cleanupDelayMs: context.constants.CLEANUP_DELAY_MS,

          // 人性化显示
          humanReadable: {
            bettingDuration: `${context.constants.BETTING_DURATION_MS / 1000}秒`,
            autoGameInterval: `${context.constants.AUTO_GAME_INTERVAL_MS / 1000}秒`,
            diceAnimationWait: `${context.constants.DICE_ANIMATION_WAIT_MS / 1000}秒`,
            globalProcessTimeout: `${context.constants.GLOBAL_PROCESS_TIMEOUT_MS / 1000}秒`
          }
        },
        timestamp: new Date().toISOString()
      });
    });

    // 服务统计API
    this.app.get('/stats', (c) => {
      try {
        const containerInfo = this.container.getContainerInfo();
        const botService = this.container.getService(BotService);
        const storageService = this.container.getService(StorageService);

        return c.json({
          success: true,
          stats: {
            container: containerInfo,
            bot: botService.getStats(),
            storage: storageService.getStats(),
            commands: {
              enabled: true,
              totalCommands: 12,
              features: [
                'start', 'id', 'newgame', 'autogame', 'stopauto',
                'bet', 'process', 'status', 'history', 'gameinfo',
                'stopgame', 'help'
              ]
            }
          },
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        return c.json({
          error: 'Failed to get stats',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 命令测试API
    this.app.get('/commands', (c) => {
      return c.json({
        success: true,
        commands: [
          {
            command: '/start',
            description: '启动机器人',
            status: 'enabled'
          },
          {
            command: '/id',
            description: '获取群组和用户信息',
            status: 'enabled'
          },
          {
            command: '/newgame',
            description: '开始新游戏',
            status: 'enabled'
          },
          {
            command: '/autogame',
            description: '开启自动游戏模式',
            status: 'enabled'
          },
          {
            command: '/stopauto',
            description: '关闭自动游戏模式',
            status: 'enabled'
          },
          {
            command: '/bet banker 100',
            description: '下注庄家100点',
            status: 'enabled'
          },
          {
            command: '/process',
            description: '立即处理游戏',
            status: 'enabled'
          },
          {
            command: '/status',
            description: '查看游戏状态',
            status: 'enabled'
          },
          {
            command: '/history',
            description: '查看最近10局记录',
            status: 'enabled'
          },
          {
            command: '/gameinfo <编号>',
            description: '查看游戏详情',
            status: 'enabled'
          },
          {
            command: '/stopgame',
            description: '停止当前游戏',
            status: 'enabled'
          },
          {
            command: '/help',
            description: '查看帮助',
            status: 'enabled'
          }
        ],
        timestamp: new Date().toISOString()
      });
    });
  }

  /**
   * 代理请求到Durable Object游戏房间
   */
  private async proxyToGameRoom(c: any, doPath: string): Promise<Response> {
    try {
      const chatId = c.req.param('chatId');

      // 验证群组权限
      if (!this.validateChatId(c, chatId)) {
        return c.json({ error: 'Chat ID not allowed' }, 403);
      }

      const context = this.container.getContext();
      if (!context.env.GAME_ROOMS) {
        return c.json({ error: 'Game rooms not configured' }, 500);
      }

      // 获取Durable Object实例
      const roomId = context.env.GAME_ROOMS.idFromName(chatId);
      const room = context.env.GAME_ROOMS.get(roomId);

      // 构造请求
      let requestBody: any = {};
      if (c.req.method === 'POST') {
        try {
          requestBody = await c.req.json();
        } catch {
          // 如果没有body就使用空对象
        }
        requestBody.chatId = chatId;
      }

      // 发送请求到DO
      const response = await room.fetch(new Request(`https://game.room${doPath}`, {
        method: c.req.method,
        headers: { 'Content-Type': 'application/json' },
        body: c.req.method === 'POST' ? JSON.stringify(requestBody) : undefined
      }));

      // 转发响应
      const result = await response.json();
      return c.json(result, response.status);
    } catch (error) {
      const logger = this.container.getService(LoggerService);
      logger.error('代理到游戏房间失败', {
        operation: 'proxy-to-game-room-error',
        doPath
      }, error);

      return c.json({
        error: 'Failed to proxy to game room',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  }

  /**
   * 验证群组ID权限
   */
  private validateChatId(c: any, chatId: string): boolean {
    const context = this.container.getContext();
    const allowedChatIds = context.env.ALLOWED_CHAT_IDS?.split(',').map((id: string) => id.trim());

    if (allowedChatIds && !allowedChatIds.includes(chatId)) {
      return false;
    }
    return true;
  }

  /**
   * 获取Hono应用实例
   */
  getApp(): Hono<{ Bindings: Env }> {
    return this.app;
  }
}
