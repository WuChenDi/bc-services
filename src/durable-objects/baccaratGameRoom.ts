import { Bot } from 'grammy';
import type { Env, StartGameRequest, PlaceBetRequest, EnableAutoRequest } from '@/types';
import { GameService } from '@/services/gameService';

export class BaccaratGameRoom {
  private gameService: GameService;

  constructor(state: DurableObjectState, env: Env) {
    const bot = new Bot(env.BOT_TOKEN);
    this.gameService = new GameService(state, env, bot);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      await this.gameService.initialize();

      switch (url.pathname) {
        case '/start-game':
          return this.handleStartGame(request);
        case '/place-bet':
          return this.handlePlaceBet(request);
        case '/process-game':
          return this.handleProcessGame();
        case '/get-status':
          return this.handleGetStatus();
        case '/stop-game':
          return this.handleStopGame();
        case '/enable-auto':
          return this.handleEnableAuto(request);
        case '/disable-auto':
          return this.handleDisableAuto();
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('DO request error:', error);
      return new Response(`Internal Error: ${error}`, { status: 500 });
    }
  }

  private async handleStartGame(request: Request): Promise<Response> {
    try {
      const { chatId } = await request.json() as StartGameRequest;
      if (!chatId) {
        return Response.json({ success: false, error: 'chatId is required' });
      }

      const result = await this.gameService.startGame(chatId);
      return Response.json(result);
    } catch (error) {
      console.error('Start game error:', error);
      return Response.json({ success: false, error: 'Failed to start game' });
    }
  }

  private async handlePlaceBet(request: Request): Promise<Response> {
    try {
      const { userId, userName, betType, amount } = await request.json() as PlaceBetRequest;
      const result = await this.gameService.placeBet(userId, userName, betType, amount);
      return Response.json(result);
    } catch (error) {
      console.error('Place bet error:', error);
      return Response.json({ success: false, error: 'Failed to place bet' });
    }
  }

  private async handleProcessGame(): Promise<Response> {
    try {
      await this.gameService.processGame();
      return Response.json({ success: true });
    } catch (error) {
      console.error('Handle process game error:', error);
      return Response.json({ success: false, error: 'Failed to process game' });
    }
  }

  private async handleGetStatus(): Promise<Response> {
    const status = await this.gameService.getGameStatus();
    return Response.json(status);
  }

  private async handleStopGame(): Promise<Response> {
    try {
      await this.gameService.disableAutoGame();
      await this.gameService.cleanupGame();
      return Response.json({ success: true });
    } catch (error) {
      console.error('Handle stop game error:', error);
      return Response.json({ success: false, error: 'Failed to stop game' });
    }
  }

  private async handleEnableAuto(request: Request): Promise<Response> {
    try {
      const { chatId } = await request.json() as EnableAutoRequest;
      if (!chatId) {
        return Response.json({ success: false, error: 'chatId is required' });
      }
      const result = await this.gameService.enableAutoGame(chatId);
      return Response.json(result);
    } catch (error) {
      console.error('Enable auto error:', error);
      return Response.json({ success: false, error: 'Failed to enable auto game' });
    }
  }

  private async handleDisableAuto(): Promise<Response> {
    try {
      const result = await this.gameService.disableAutoGame();
      return Response.json(result);
    } catch (error) {
      console.error('Disable auto error:', error);
      return Response.json({ success: false, error: 'Failed to disable auto game' });
    }
  }
}
