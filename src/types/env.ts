/**
 * 环境变量和配置类型
 */

/** 环境变量接口 */
export interface Env {
  // ===== 基础配置 =====
  /** Telegram Bot Token - 必需 */
  BOT_TOKEN: string;
  /** 允许使用的聊天ID列表 (逗号分隔) - 可选 */
  ALLOWED_CHAT_IDS?: string;

  // ===== Cloudflare 资源绑定 =====
  /** 游戏房间 Durable Object 命名空间 */
  GAME_ROOMS: DurableObjectNamespace;
  /** 百家乐游戏数据存储 KV 命名空间 */
  BC_GAME_KV: KVNamespace;

  // ===== 时间相关配置 (所有单位: 毫秒) =====

  // 🎮 核心游戏时间
  /** 下注阶段持续时间 (默认: 30000ms = 30秒) */
  BETTING_DURATION_MS?: string;
  /** 自动游戏间隔时间 (默认: 10000ms = 10秒) */
  AUTO_GAME_INTERVAL_MS?: string;

  // 🎲 骰子相关时间
  /** 骰子投掷超时时间 (默认: 10000ms = 10秒) */
  DICE_ROLL_TIMEOUT_MS?: string;
  /** 骰子投掷最大重试次数 (默认: 2次) */
  DICE_ROLL_MAX_RETRIES?: string;
  /** 骰子动画等待时间 (默认: 4000ms = 4秒) */
  DICE_ANIMATION_WAIT_MS?: string;
  /** 结果发送延迟时间 (默认: 1000ms = 1秒) */
  DICE_RESULT_DELAY_MS?: string;

  // ⏱️ 流程控制时间
  /** 发牌间隔时间 (默认: 500ms = 0.5秒) */
  CARD_DEAL_DELAY_MS?: string;
  /** 消息发送间隔 (默认: 2000ms = 2秒) */
  MESSAGE_DELAY_MS?: string;

  // 🔒 系统保护时间
  /** 游戏处理全局超时 (默认: 90000ms = 90秒) */
  GLOBAL_PROCESS_TIMEOUT_MS?: string;
  /** 游戏清理延迟时间 (默认: 30000ms = 30秒) */
  CLEANUP_DELAY_MS?: string;
}

/** 系统常量配置 */
export interface Constants {
  /** 下注阶段持续时间(毫秒) */
  BETTING_DURATION_MS: number;
  /** 自动游戏间隔时间(毫秒) */
  AUTO_GAME_INTERVAL_MS: number;
  /** 骰子投掷超时时间(毫秒) */
  DICE_ROLL_TIMEOUT_MS: number;
  /** 骰子投掷最大重试次数 */
  DICE_ROLL_MAX_RETRIES: number;
  /** 骰子动画等待时间(毫秒) */
  DICE_ANIMATION_WAIT_MS: number;
  /** 结果发送延迟时间(毫秒) */
  DICE_RESULT_DELAY_MS: number;
  /** 发牌间隔时间(毫秒) */
  CARD_DEAL_DELAY_MS: number;
  /** 消息发送间隔(毫秒) */
  MESSAGE_DELAY_MS: number;
  /** 游戏处理全局超时(毫秒) */
  GLOBAL_PROCESS_TIMEOUT_MS: number;
  /** 游戏清理延迟时间(毫秒) */
  CLEANUP_DELAY_MS: number;
}
