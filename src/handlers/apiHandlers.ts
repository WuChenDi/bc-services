import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { webhookCallback } from 'grammy';
import type { Env, StartGameRequest, EnableAutoRequest } from '@/types';
import { BotService, StorageService } from '@/services';
import { CommandHandlers } from './commandHandlers';
import { getConstants, type Constants } from '@/config/constants';

export class ApiHandlers {
  private app: Hono<{ Bindings: Env }>;
  private commandHandlers: CommandHandlers;
  private constants: Constants;

  constructor(
    private gameRooms: DurableObjectNamespace,
    private storage: StorageService,
    private botService: BotService,
    private env: Env
  ) {
    this.app = new Hono<{ Bindings: Env }>();
    this.app.use('*', cors());
    this.constants = getConstants(env);

    this.commandHandlers = new CommandHandlers(
      this.botService.bot,
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
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        constants: {
          bettingDuration: `${this.constants.BETTING_DURATION_MS / 1000}s`,
          autoGameInterval: `${this.constants.AUTO_GAME_INTERVAL_MS / 1000}s`,
          diceAnimationWait: `${this.constants.DICE_ANIMATION_WAIT_MS / 1000}s`
        }
      });
    });

    this.app.get('/health', (c) => {
      return c.json({
        status: 'ok',
        platform: 'cloudflare-workers',
        timestamp: new Date().toISOString(),
        config: {
          bettingDurationMs: this.constants.BETTING_DURATION_MS,
          autoGameIntervalMs: this.constants.AUTO_GAME_INTERVAL_MS,
          diceAnimationWaitMs: this.constants.DICE_ANIMATION_WAIT_MS,
          globalProcessTimeoutMs: this.constants.GLOBAL_PROCESS_TIMEOUT_MS
        }
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

        // 验证群组权限
        if (!this.validateChatId(c, chatId)) {
          return c.json({ error: 'Chat ID not allowed' }, 403);
        }

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

        // 验证游戏编号格式
        if (!/^\d{17}$/.test(gameNumber)) {
          return c.json({
            success: false,
            error: 'Invalid game number format. Expected 17 digits.'
          }, 400);
        }

        const game = await this.storage.getGameDetail(gameNumber);
        if (!game) {
          return c.json({ success: false, error: 'Game not found' }, 404);
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

        // 验证群组权限
        if (!this.validateChatId(c, chatId)) {
          return c.json({ error: 'Chat ID not allowed' }, 403);
        }

        const roomId = c.env.GAME_ROOMS.idFromName(chatId);
        const room = c.env.GAME_ROOMS.get(roomId);

        const response = await room.fetch(new Request('https://game.room/start-game', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId } as StartGameRequest)
        }));

        const result = await response.json() as any;

        if (result.success) {
          const bettingDurationSeconds = this.constants.BETTING_DURATION_MS / 1000;
          await this.botService.sendMessage(chatId,
            `🎲 **自动游戏 - 第 ${result.gameNumber} 局开始！**\n\n` +
            `💰 下注时间：${bettingDurationSeconds}秒\n` +
            `📝 下注格式：/bet banker 100\n` +
            `⏰ ${bettingDurationSeconds}秒后将自动处理游戏...`
          );
          return c.json({
            success: true,
            gameNumber: result.gameNumber,
            chatId,
            bettingEndTime: result.bettingEndTime,
            bettingDurationMs: this.constants.BETTING_DURATION_MS,
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

        // 验证群组权限
        if (!this.validateChatId(c, chatId)) {
          return c.json({ error: 'Chat ID not allowed' }, 403);
        }

        const roomId = c.env.GAME_ROOMS.idFromName(chatId);
        const room = c.env.GAME_ROOMS.get(roomId);

        const response = await room.fetch(new Request('https://game.room/enable-auto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId } as EnableAutoRequest)
        }));

        const result = await response.json() as any;

        if (result.success) {
          const autoIntervalSeconds = this.constants.AUTO_GAME_INTERVAL_MS / 1000;
          return c.json({
            ...result,
            autoGameIntervalMs: this.constants.AUTO_GAME_INTERVAL_MS,
            autoGameIntervalSeconds: autoIntervalSeconds,
            message: `Auto game enabled with ${autoIntervalSeconds}s interval`
          });
        }

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

        // 验证群组权限
        if (!this.validateChatId(c, chatId)) {
          return c.json({ error: 'Chat ID not allowed' }, 403);
        }

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

        // 验证群组权限
        if (!this.validateChatId(c, chatId)) {
          return c.json({ error: 'Chat ID not allowed' }, 403);
        }

        const roomId = c.env.GAME_ROOMS.idFromName(chatId);
        const room = c.env.GAME_ROOMS.get(roomId);

        const response = await room.fetch(new Request('https://game.room/process-game', {
          method: 'POST'
        }));

        const result = await response.json() as any;

        if (result.success) {
          return c.json({
            success: true,
            message: 'Game processed successfully',
            timestamp: new Date().toISOString()
          });
        } else {
          return c.json({
            error: result.error || 'Unknown error',
            timestamp: new Date().toISOString()
          }, 400);
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

        // 验证群组权限
        if (!this.validateChatId(c, chatId)) {
          return c.json({ error: 'Chat ID not allowed' }, 403);
        }

        const roomId = c.env.GAME_ROOMS.idFromName(chatId);
        const room = c.env.GAME_ROOMS.get(roomId);

        const response = await room.fetch('https://game.room/get-status');
        const result = await response.json() as any;

        // 添加时间配置信息
        if (result.gameNumber) {
          result.config = {
            bettingDurationMs: this.constants.BETTING_DURATION_MS,
            autoGameIntervalMs: this.constants.AUTO_GAME_INTERVAL_MS,
            diceAnimationWaitMs: this.constants.DICE_ANIMATION_WAIT_MS
          };
        }

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

        // 验证群组权限
        if (!this.validateChatId(c, chatId.toString())) {
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

        // 验证 URL 格式
        try {
          new URL(url);
        } catch {
          return c.json({ error: 'Invalid webhook URL format' }, 400);
        }

        await this.botService.setWebhook(url);
        return c.json({
          success: true,
          message: 'Webhook set successfully',
          url,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Set webhook error:', error);
        return c.json({
          error: 'Failed to set webhook',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
      }
    });

    // 获取配置信息 API
    this.app.get('/config', (c) => {
      return c.json({
        success: true,
        config: {
          // 核心游戏时间
          bettingDurationMs: this.constants.BETTING_DURATION_MS,
          autoGameIntervalMs: this.constants.AUTO_GAME_INTERVAL_MS,

          // 骰子相关时间
          diceRollTimeoutMs: this.constants.DICE_ROLL_TIMEOUT_MS,
          diceRollMaxRetries: this.constants.DICE_ROLL_MAX_RETRIES,
          diceAnimationWaitMs: this.constants.DICE_ANIMATION_WAIT_MS,
          diceResultDelayMs: this.constants.DICE_RESULT_DELAY_MS,

          // 流程控制时间
          cardDealDelayMs: this.constants.CARD_DEAL_DELAY_MS,
          messageDelayMs: this.constants.MESSAGE_DELAY_MS,

          // 系统保护时间
          globalProcessTimeoutMs: this.constants.GLOBAL_PROCESS_TIMEOUT_MS,
          cleanupDelayMs: this.constants.CLEANUP_DELAY_MS,

          // 人性化显示
          humanReadable: {
            bettingDuration: `${this.constants.BETTING_DURATION_MS / 1000}秒`,
            autoGameInterval: `${this.constants.AUTO_GAME_INTERVAL_MS / 1000}秒`,
            diceAnimationWait: `${this.constants.DICE_ANIMATION_WAIT_MS / 1000}秒`,
            globalProcessTimeout: `${this.constants.GLOBAL_PROCESS_TIMEOUT_MS / 1000}秒`
          }
        },
        timestamp: new Date().toISOString()
      });
    });
  }

  /**
   * 验证群组ID权限
   */
  private validateChatId(c: any, chatId: string): boolean {
    const allowedChatIds = c.env.ALLOWED_CHAT_IDS?.split(',').map((id: string) => id.trim());
    if (allowedChatIds && !allowedChatIds.includes(chatId)) {
      return false;
    }
    return true;
  }

  getApp(): Hono<{ Bindings: Env }> {
    return this.app;
  }
}
