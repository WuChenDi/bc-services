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

export interface UserBets {
  banker?: number;
  player?: number;
  tie?: number;
  userName: string;
}

export interface GameData {
  gameNumber: string;
  state: GameState;
  bets: { [userId: string]: UserBets };
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

export interface GameRecord extends Omit<GameData, 'bettingEndTime'> {
  endTime: number;
  totalBets: number;
  totalAmount: number;
}
