/**
 * 游戏相关类型
 */

/** 游戏状态枚举 */
export enum GameState {
  /** 空闲状态 */
  Idle = 'idle',
  /** 下注中 */
  Betting = 'betting',
  /** 处理中 */
  Processing = 'processing',
  /** 开牌中 */
  Revealing = 'revealing',
  /** 已完成 */
  Finished = 'finished'
}

/** 下注类型枚举 */
export enum BetType {
  /** 庄家 */
  Banker = 'banker',
  /** 闲家 */
  Player = 'player',
  /** 和局 */
  Tie = 'tie'
}

/** 用户下注信息 */
export interface UserBets {
  /** 下注庄家的金额 */
  banker?: number;
  /** 下注闲家的金额 */
  player?: number;
  /** 下注和局的金额 */
  tie?: number;
  /** 用户名 */
  userName: string;
}

/** 游戏数据 */
export interface GameData {
  /** 游戏编号 (17位数字) */
  gameNumber: string;
  /** 游戏状态 */
  state: GameState;
  /** 所有用户的下注信息 (userId -> UserBets) */
  bets: Record<string, UserBets>;
  /** 卡牌信息 */
  cards: {
    /** 庄家的牌 */
    banker: number[];
    /** 闲家的牌 */
    player: number[];
  };
  /** 游戏结果 */
  result: {
    /** 庄家总点数 */
    banker: number;
    /** 闲家总点数 */
    player: number;
    /** 获胜方 */
    winner: BetType | null;
  };
  /** 游戏开始时间戳 */
  startTime: number;
  /** 下注结束时间戳 */
  bettingEndTime: number;
  /** 聊天ID */
  chatId: string;
}

/** 游戏记录（用于存储） */
export interface GameRecord extends Omit<GameData, 'bettingEndTime'> {
  /** 游戏结束时间戳 */
  endTime: number;
  /** 参与下注的用户总数 */
  totalBets: number;
  /** 总下注金额 */
  totalAmount: number;
}

/** 游戏结果格式化选项 */
export interface GameResultOptions {
  /** 是否启用自动游戏 */
  isAutoGameEnabled?: boolean;
  /** 下一局开始的延迟秒数 */
  nextGameDelaySeconds?: number;
  /** 本次会话总游戏数 */
  totalGamesInSession?: number;
}

/** 游戏处理结果 */
export interface GameProcessResult {
  /** 处理是否成功 */
  success: boolean;
  /** 游戏编号 */
  gameNumber?: string;
  /** 错误信息 */
  error?: string;
  /** 处理耗时(毫秒) */
  duration?: number;
}

/** 游戏统计信息 */
export interface GameStats {
  /** 已开始的游戏数 */
  gamesStarted: number;
  /** 已完成的游戏数 */
  gamesCompleted: number;
  /** 失败的游戏数 */
  gamesFailed: number;
  /** 总下注次数 */
  totalBets: number;
  /** 总下注金额 */
  totalAmount: number;
  /** 平均游戏时长(毫秒) */
  averageGameDuration: number;
  /** 当前活跃游戏数 */
  activeGames: number;
  /** 最后游戏时间戳 */
  lastGameTime: number;
}
