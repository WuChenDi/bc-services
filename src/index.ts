import type { Env } from '@/types';
import { ApiHandlers } from '@/handlers';
import { StorageService, BotService } from '@/services';
import { BaccaratGameRoom } from '@/durable-objects/baccaratGameRoom';

export default {
  fetch: async (request: Request, env: Env) => {
    const botService = new BotService(env.BOT_TOKEN);
    const storageService = new StorageService(env.BC_GAME_KV);

    const apiHandlers = new ApiHandlers(env.GAME_ROOMS, storageService, botService);

    return apiHandlers.getApp().fetch(request, env);
  }
};

export { BaccaratGameRoom };
