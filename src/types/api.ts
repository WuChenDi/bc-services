import { BetType, GameState, type BetInfo } from './game';

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
  bets?: { [userId: string]: BetInfo };
  timeRemaining?: number;
  result?: {
    banker: number;
    player: number;
    winner: BetType | null;
  };
  needsProcessing?: boolean;
  autoGameEnabled: boolean;
}

export interface PlaceBetResponse {
  success: boolean;
  betType?: BetType;
  amount?: number;
  userName?: string;
  remainingTime?: number;
  totalBets?: number;
  error?: string;
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
