import type { GameRecord, GameData } from '@/types';

export class StorageService {
  constructor(private kv: KVNamespace) { }

  async saveGameRecord(game: GameData): Promise<void> {
    try {
      const { bettingEndTime, ...gameWithoutBettingEndTime } = game;
      
      const gameRecord: GameRecord = {
        ...gameWithoutBettingEndTime,
        endTime: Date.now(),
        totalBets: Object.keys(game.bets).length,
        totalAmount: Object.values(game.bets).reduce((sum, bet) => sum + bet.amount, 0)
      };

      await this.kv.put(`game:${game.gameNumber}`, JSON.stringify(gameRecord));

      const latestGamesKey = `latest_games:${game.chatId}`;
      let latestGames: string[] = [];

      try {
        const existing = await this.kv.get(latestGamesKey);
        if (existing) {
          latestGames = JSON.parse(existing);
        }
      } catch (e) {
        console.error('Failed to get latest games:', e);
      }

      latestGames.unshift(game.gameNumber);
      if (latestGames.length > 100) {
        latestGames = latestGames.slice(0, 100);
      }

      await this.kv.put(latestGamesKey, JSON.stringify(latestGames));
      console.log(`Game record saved: ${game.gameNumber}`);
    } catch (error) {
      console.error('Failed to save game record:', error);
    }
  }

  async getGameHistory(chatId: string): Promise<GameRecord[]> {
    const latestGamesKey = `latest_games:${chatId}`;
    const latestGamesData = await this.kv.get(latestGamesKey);
    if (!latestGamesData) {
      return [];
    }

    const latestGames: string[] = JSON.parse(latestGamesData);
    const history: GameRecord[] = [];

    for (const gameNumber of latestGames.slice(0, 10)) {
      try {
        const gameData = await this.kv.get(`game:${gameNumber}`);
        if (gameData) {
          history.push(JSON.parse(gameData) as GameRecord);
        }
      } catch (e) {
        console.error(`Failed to get game ${gameNumber}:`, e);
      }
    }

    return history;
  }

  async getGameDetail(gameNumber: string): Promise<GameRecord | null> {
    const gameData = await this.kv.get(`game:${gameNumber}`);
    return gameData ? JSON.parse(gameData) as GameRecord : null;
  }
}
