/**
 * API请求响应类型
 */
import type { BetType, GameState } from './game';

/** 开始游戏请求 */
export interface StartGameRequest {
  /** 聊天ID */
  chatId: string;
}

/** 下注请求 */
export interface PlaceBetRequest {
  /** 用户ID */
  userId: string;
  /** 用户名 */
  userName: string;
  /** 下注类型 (banker/player/tie) */
  betType: BetType;
  /** 下注金额 */
  amount: number;
}

/** 启用自动游戏请求 */
export interface EnableAutoRequest {
  /** 聊天ID */
  chatId: string;
}

/** 游戏状态响应 */
export interface GameStatusResponse {
  /** 请求是否成功 */
  success?: boolean;
  /** 错误信息 */
  error?: string;
  /** 游戏状态详情 */
  status: {
    /** 游戏编号 */
    gameNumber?: string;
    /** 游戏状态 */
    state: GameState | string;
    /** 参与下注的用户数量 */
    betsCount: number;
    /** 总下注金额 */
    totalBets: number;
    /** 总下注数量 */
    totalBetsCount?: number;
    /** 参与用户数量（别名） */
    usersCount?: number;
    /** 所有用户的下注信息 */
    bets?: Record<string, any>;
    /** 剩余下注时间(秒) */
    timeRemaining?: number;
    /** 游戏结果 */
    result?: {
      /** 庄家点数 */
      banker: number;
      /** 闲家点数 */
      player: number;
      /** 获胜方 */
      winner: BetType | null;
    };
    /** 是否需要处理游戏 */
    needsProcessing?: boolean;
    /** 是否启用自动游戏 */
    autoGameEnabled: boolean;
    /** 是否为自动模式（别名） */
    isAutoMode?: boolean;
    /** 调试信息 */
    debug?: {
      /** 消息队列长度 */
      queueLength: number;
      /** 队列是否正在处理 */
      queueProcessing: boolean;
      /** 是否正在处理游戏 */
      isProcessing: boolean;
      /** 是否正在开牌 */
      revealingInProgress: boolean;
    };
  };
}

/** 下注响应 */
export interface PlaceBetResponse {
  /** 下注是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
  /** 下注类型 */
  betType?: BetType;
  /** 下注金额 */
  amount?: number;
  /** 用户名 */
  userName?: string;
  /** 剩余下注时间(秒) */
  remainingTime?: number;
  /** 参与下注的用户数量 */
  totalBets?: number;
  /** 总下注金额 */
  totalBetsAmount?: number;
  /** 总下注数量 */
  totalBetsCount?: number;
  /** 是否为累加下注 */
  isAccumulated?: boolean;
  /** 是否为替换下注 */
  isReplaced?: boolean;
  /** 是否为新的下注类型 */
  isNewBetType?: boolean;
  /** 之前的下注金额 */
  previousAmount?: number;
  /** 新增的下注金额 */
  addedAmount?: number;
  /** 之前的下注类型 */
  previousBetType?: BetType;
}

/** 开始游戏响应 */
export interface StartGameResponse {
  /** 是否成功 */
  success: boolean;
  /** 游戏编号 */
  gameNumber?: string;
  /** 下注结束时间戳 */
  bettingEndTime?: number;
  /** 错误信息 */
  error?: string;
}
