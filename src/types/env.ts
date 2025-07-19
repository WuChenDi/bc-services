export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  ALLOWED_CHAT_IDS?: string;
  GAME_ROOMS: DurableObjectNamespace;
  BC_GAME_KV: KVNamespace;
}
