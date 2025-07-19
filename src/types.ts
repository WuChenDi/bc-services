export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  ALLOWED_CHAT_IDS?: string;
  GAME_ROOMS: DurableObjectNamespace;
}

export enum GameState {
  Idle = 'idle',
  Betting = 'betting',
  Processing = 'processing',
  Revealing = 'revealing',
  Finished = 'finished'
}

export enum BetType {
  Banker = 'banker',
  Player = 'player',
  Tie = 'tie'
}

export interface GameData {
  gameNumber: string;
  state: GameState;
  bets: { [userId: string]: { type: BetType; amount: number; userName: string } };
  cards: {
    banker: number[];
    player: number[];
  };
  result: {
    banker: number;
    player: number;
    winner: BetType | null;
  };
  startTime: number;
  bettingEndTime: number;
  chatId: string;
}
