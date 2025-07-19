import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { webhookCallback } from 'grammy';
import type { Env, StartGameRequest, EnableAutoRequest } from '@/types';
import { BotService, StorageService } from '@/services';
import { CommandHandlers } from './commandHandlers';

export class ApiHandlers {
  private app: Hono<{ Bindings: Env }>;
  private commandHandlers: CommandHandlers;

  constructor(
    private gameRooms: DurableObjectNamespace,
    private storage: StorageService,
    private botService: BotService
  ) {
    this.app = new Hono<{ Bindings: Env }>();
    this.app.use('*', cors());

    // 在这里注册 Bot 命令 - 这是关键修复
    this.commandHandlers = new CommandHandlers(
      this.botService.bot, // 使用同一个 Bot 实例
      this.gameRooms,
      this.storage
    );

    this.registerRoutes();
  }

  private registerRoutes(): void {
    // 基础路由
    this.app.get('/', (c) => {
      return c.json({
        message: '百家乐 Bot with Hono and Durable Objects!',
        timestamp: new Date().toISOString()
      });
    });

    this.app.get('/health', (c) => {
      return c.json({
        status: 'ok',
        platform: 'cloudflare-workers',
        timestamp: new Date().toISOString()
      });
    });

    // Webhook 路由 - 使用已经注册了命令的 Bot
    this.app.post('/webhook', async (c) => {
      const token = c.env.BOT_TOKEN;
      if (!token) {
        return c.json({ error: 'BOT_TOKEN not configured' }, 500);
      }

      try {
        // 使用已经注册了命令的 Bot 实例
        const callback = webhookCallback(this.botService.bot, 'hono');
        return await callback(c);
      } catch (error) {
        console.error('Webhook error:', error);
        return c.json({
          error: 'Webhook processing failed',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 游戏历史记录 API
    this.app.get('/game-history/:chatId', async (c) => {
      try {
        const chatId = c.req.param('chatId');
        const history = await this.storage.getGameHistory(chatId);
        return c.json({
          success: true,
          history,
          total: history.length
        });
      } catch (error) {
        console.error('Game history error:', error);
        return c.json({
          error: 'Failed to get game history',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 游戏详情 API
    this.app.get('/game-detail/:gameNumber', async (c) => {
      try {
        const gameNumber = c.req.param('gameNumber');
        const game = await this.storage.getGameDetail(gameNumber);
        if (!game) {
          return c.json({ success: false, error: 'Game not found' });
        }
        return c.json({ success: true, game });
      } catch (error) {
        console.error('Game detail error:', error);
        return c.json({
          error: 'Failed to get game detail',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 自动游戏 API
    this.app.post('/auto-game/:chatId', async (c) => {
      try {
        const chatId = c.req.param('chatId');
        const roomId = c.env.GAME_ROOMS.idFromName(chatId);
        const room = c.env.GAME_ROOMS.get(roomId);

        const response = await room.fetch(new Request('https://game.room/start-game', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId } as StartGameRequest)
        }));

        const result = await response.json() as any;

        if (result.success) {
          await this.botService.sendMessage(chatId,
            `🎲 **自动游戏 - 第 ${result.gameNumber} 局开始！**\n\n` +
            `💰 下注时间：30秒\n` +
            `📝 下注格式：/bet banker 100\n` +
            `⏰ 30秒后将自动处理游戏...`
          );
          return c.json({
            success: true,
            gameNumber: result.gameNumber,
            chatId,
            bettingEndTime: result.bettingEndTime,
            message: 'Auto game started'
          });
        } else {
          return c.json({ error: result.error }, 400);
        }
      } catch (error) {
        console.error('Auto game error:', error);
        return c.json({
          error: 'Failed to start auto game',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 启用自动游戏
    this.app.post('/enable-auto/:chatId', async (c) => {
      try {
        const chatId = c.req.param('chatId');
        const roomId = c.env.GAME_ROOMS.idFromName(chatId);
        const room = c.env.GAME_ROOMS.get(roomId);

        const response = await room.fetch(new Request('https://game.room/enable-auto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId } as EnableAutoRequest)
        }));

        return response;
      } catch (error) {
        console.error('Enable auto error:', error);
        return c.json({
          error: 'Failed to enable auto game',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 禁用自动游戏
    this.app.post('/disable-auto/:chatId', async (c) => {
      try {
        const chatId = c.req.param('chatId');
        const roomId = c.env.GAME_ROOMS.idFromName(chatId);
        const room = c.env.GAME_ROOMS.get(roomId);

        const response = await room.fetch(new Request('https://game.room/disable-auto', {
          method: 'POST'
        }));

        return response;
      } catch (error) {
        console.error('Disable auto error:', error);
        return c.json({
          error: 'Failed to disable auto game',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 处理游戏 API
    this.app.post('/process-game/:chatId', async (c) => {
      try {
        const chatId = c.req.param('chatId');
        const roomId = c.env.GAME_ROOMS.idFromName(chatId);
        const room = c.env.GAME_ROOMS.get(roomId);

        const response = await room.fetch(new Request('https://game.room/process-game', {
          method: 'POST'
        }));

        const result = await response.json() as any;

        if (result.success) {
          return c.json({
            success: true,
            message: 'Game processed successfully'
          });
        } else {
          return c.json({ error: result.error }, 400);
        }
      } catch (error) {
        console.error('Process game error:', error);
        return c.json({
          error: 'Failed to process game',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 游戏状态 API
    this.app.get('/game-status/:chatId', async (c) => {
      try {
        const chatId = c.req.param('chatId');
        const roomId = c.env.GAME_ROOMS.idFromName(chatId);
        const room = c.env.GAME_ROOMS.get(roomId);

        const response = await room.fetch('https://game.room/get-status');
        const result = await response.json() as any;

        return c.json(result);
      } catch (error) {
        console.error('Game status error:', error);
        return c.json({
          error: 'Failed to get game status',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 发送消息 API
    this.app.post('/send-message', async (c) => {
      try {
        const { chatId, message, parseMode } = await c.req.json();

        if (!chatId || !message) {
          return c.json({ error: 'chatId and message are required' }, 400);
        }

        const allowedChatIds = c.env.ALLOWED_CHAT_IDS?.split(',').map(id => id.trim());
        if (allowedChatIds && !allowedChatIds.includes(chatId.toString())) {
          return c.json({ error: 'Chat ID not allowed' }, 403);
        }

        const result = await this.botService.sendMessage(chatId, message, parseMode || undefined);
        return c.json({
          success: true,
          messageId: result.message_id,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Send message error:', error);
        return c.json({
          error: 'Failed to send message',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 设置 Webhook API
    this.app.post('/set-webhook', async (c) => {
      try {
        const { url } = await c.req.json();
        if (!url) {
          return c.json({ error: 'webhook url is required' }, 400);
        }

        await this.botService.setWebhook(url);
        return c.json({
          success: true,
          message: 'Webhook set successfully',
          url
        });
      } catch (error) {
        console.error('Set webhook error:', error);
        return c.json({
          error: 'Failed to set webhook',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });
  }

  getApp(): Hono<{ Bindings: Env }> {
    return this.app;
  }
}
