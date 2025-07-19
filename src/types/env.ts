export interface Env {
  // ===== 基础配置 =====
  BOT_TOKEN: string;                        // Telegram Bot Token - 必需
  WEBHOOK_SECRET?: string;                  // Webhook 安全密钥 - 可选
  ALLOWED_CHAT_IDS?: string;                // 允许使用的聊天ID列表 (逗号分隔) - 可选

  // ===== Cloudflare 资源绑定 =====
  GAME_ROOMS: DurableObjectNamespace;       // 游戏房间 Durable Object 命名空间
  BC_GAME_KV: KVNamespace;                  // 百家乐游戏数据存储 KV 命名空间

  // ===== 时间相关配置 (所有单位: 毫秒) =====

  // 🎮 核心游戏时间
  BETTING_DURATION_MS?: string;             // 下注阶段持续时间 (默认: 30000ms = 30秒)
  AUTO_GAME_INTERVAL_MS?: string;           // 自动游戏间隔时间 (默认: 10000ms = 10秒)

  // 🎲 骰子相关时间
  DICE_ROLL_TIMEOUT_MS?: string;            // 骰子投掷超时时间 (默认: 10000ms = 10秒)
  DICE_ROLL_MAX_RETRIES?: string;           // 骰子投掷最大重试次数 (默认: 2次)
  DICE_ANIMATION_WAIT_MS?: string;          // 骰子动画等待时间 (默认: 4000ms = 4秒)
  DICE_RESULT_DELAY_MS?: string;            // 结果发送延迟时间 (默认: 1000ms = 1秒)

  // ⏱️ 流程控制时间  
  CARD_DEAL_DELAY_MS?: string;              // 发牌间隔时间 (默认: 500ms = 0.5秒)
  MESSAGE_DELAY_MS?: string;                // 消息发送间隔 (默认: 2000ms = 2秒)

  // 🔒 系统保护时间
  GLOBAL_PROCESS_TIMEOUT_MS?: string;       // 游戏处理全局超时 (默认: 90000ms = 90秒)
  CLEANUP_DELAY_MS?: string;                // 游戏清理延迟时间 (默认: 30000ms = 30秒)
}
