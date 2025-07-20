import { BetType, GameState, type UserBets } from './game';

export interface StartGameRequest {
  chatId: string;
}

export interface PlaceBetRequest {
  userId: string;
  userName: string;
  betType: BetType;
  amount: number;
}

export interface EnableAutoRequest {
  chatId: string;
}

export interface GameStatusResponse {
  status?: string;
  gameNumber?: string;
  state?: GameState;
  betsCount?: number;
  bets?: { [userId: string]: UserBets };
  timeRemaining?: number;
  result?: {
    banker: number;
    player: number;
    winner: BetType | null;
  };
  needsProcessing?: boolean;
  autoGameEnabled: boolean;
  // 🔥 新增调试信息
  debug?: {
    queueLength: number;
    queueProcessing: boolean;
    isProcessing: boolean;
    revealingInProgress: boolean;
  };
}

export interface PlaceBetResponse {
  success: boolean;
  betType?: BetType;
  amount?: number;
  userName?: string;
  remainingTime?: number;
  totalBets?: number;
  error?: string;
  isAccumulated?: boolean;      // 是否为累加下注
  previousAmount?: number;      // 之前的金额
  addedAmount?: number;         // 新增的金额
  isReplaced?: boolean;         // 是否为替换下注
  previousBetType?: BetType;    // 之前的下注类型
}

export interface StartGameResponse {
  success: boolean;
  gameNumber?: string;
  bettingEndTime?: number;
  error?: string;
}

export interface ApiResponse {
  success: boolean;
  message?: string;
  error?: string;
}
