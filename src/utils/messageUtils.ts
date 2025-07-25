import { type GameData, type GameRecord, BetType, type UserBets } from '@/types';

export function formatBetSummary(game: GameData): string {
  const allUserBets = Object.values(game.bets);
  const betSummary = allUserBets.reduce((acc, userBets) => {
    if (userBets.banker) acc[BetType.Banker] = (acc[BetType.Banker] || 0) + userBets.banker;
    if (userBets.player) acc[BetType.Player] = (acc[BetType.Player] || 0) + userBets.player;
    if (userBets.tie) acc[BetType.Tie] = (acc[BetType.Tie] || 0) + userBets.tie;
    return acc;
  }, {} as Record<BetType, number>);

  const totalAmount = Object.values(betSummary).reduce((sum, amount) => sum + (amount || 0), 0);

  let message = `📋 **第 ${game.gameNumber} 局下注汇总**\n\n`;
  message += `👥 参与人数: ${allUserBets.length}\n`;
  message += `💰 总下注: ${totalAmount} 点\n\n`;
  message += `📊 **各项下注:**\n`;
  message += `🏦 庄家: ${betSummary[BetType.Banker] || 0} 点\n`;
  message += `👤 闲家: ${betSummary[BetType.Player] || 0} 点\n`;
  message += `🤝 和局: ${betSummary[BetType.Tie] || 0} 点\n\n`;
  message += `🎲 准备开牌...`;
  return message;
}

export interface GameResultOptions {
  isAutoGameEnabled?: boolean;
  nextGameDelaySeconds?: number;  // 下一局开始的延迟秒数
  totalGamesInSession?: number;   // 本次会话总游戏数
}

export function formatGameResult(game: GameData, options?: GameResultOptions): string {
  const winnerText = {
    [BetType.Banker]: '🏦 庄家胜！',
    [BetType.Player]: '👤 闲家胜！',
    [BetType.Tie]: '🤝 和局！'
  };

  let message = `🎯 **第 ${game.gameNumber} 局开牌结果**\n\n`;
  message += `🏦 庄家最终点数: ${game.result.banker} 点\n`;
  message += `👤 闲家最终点数: ${game.result.player} 点\n\n`;
  message += `🏆 **${winnerText[game.result.winner!]}**\n\n`;

  const winners: string[] = [];
  const losers: string[] = [];
  let totalWinAmount = 0;
  let totalLossAmount = 0;

  Object.entries(game.bets).forEach(([userId, userBets]) => {
    // 显示用户名和ID
    const userName = userBets.userName || 'Unknown';
    const displayName = `${userName} (${userId})`;

    let userWinAmount = 0;
    let userLossAmount = 0;

    // 计算每个用户的输赢
    Object.entries(userBets).forEach(([betType, amount]) => {
      if (betType !== 'userName' && typeof amount === 'number') {
        if (betType === game.result.winner) {
          // 获胜
          const winAmount = betType === BetType.Tie ? amount * 8 : amount;
          userWinAmount += winAmount;
          totalWinAmount += winAmount;
        } else {
          // 失败
          userLossAmount += amount;
          totalLossAmount += amount;
        }
      }
    });

    const netAmount = userWinAmount - userLossAmount;
    if (netAmount > 0) {
      winners.push(`${displayName}: +${netAmount}`);
    } else if (netAmount < 0) {
      losers.push(`${displayName}: ${netAmount}`);
    } else {
      losers.push(`${displayName}: ±0`);
    }
  });

  if (winners.length > 0) {
    message += `✅ **获胜者:**\n${winners.join('\n')}\n\n`;
  }
  if (losers.length > 0) {
    message += `❌ **失败者:**\n${losers.join('\n')}\n\n`;
  }

  // 添加本局统计信息
  if (Object.keys(game.bets).length > 0) {
    message += `📊 **本局统计:**\n`;
    message += `💰 总赔付: ${totalWinAmount} 点\n`;
    message += `💸 总收取: ${totalLossAmount} 点\n`;
    message += `📈 庄家盈亏: ${totalLossAmount - totalWinAmount > 0 ? '+' : ''}${totalLossAmount - totalWinAmount} 点\n\n`;
  }

  // 动态游戏状态提示
  const isAutoEnabled = options?.isAutoGameEnabled;
  const delaySeconds = options?.nextGameDelaySeconds || 10;

  if (isAutoEnabled === true) {
    message += `🤖 **自动游戏模式进行中**\n`;
    message += `⏰ ${delaySeconds}秒后自动开始下一局\n`;
    message += `🛑 使用 /stopauto 关闭自动模式\n`;

    if (options?.totalGamesInSession) {
      message += `📊 本次已完成 ${options.totalGamesInSession} 局游戏`;
    }
  } else if (isAutoEnabled === false) {
    message += `🎮 **手动游戏模式**\n`;
    message += `💡 使用 /newgame 开始新游戏\n`;
    message += `🤖 使用 /autogame 开启自动模式`;
  } else {
    // 兼容旧版本调用
    message += `🎮 **游戏结束**\n`;
    message += `💡 使用 /newgame 继续游戏`;
  }

  return message;
}

export function formatGameHistory(history: GameRecord[]): string {
  let message = `📊 **最近10局游戏记录**\n\n`;

  history.forEach((record, index) => {
    const winnerText = {
      [BetType.Banker]: '🏦庄',
      [BetType.Player]: '👤闲',
      [BetType.Tie]: '🤝和'
    };

    const date = new Date(record.endTime);
    const timeStr = date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    message += `${index + 1}. **${record.gameNumber}**\n`;
    message += `   ${timeStr} | ${winnerText[record.result.winner!]} | ${record.result.banker}-${record.result.player} | ${record.totalBets}人\n\n`;
  });

  message += `💡 使用 /gameinfo <游戏编号> 查看详情`;
  return message;
}

export function formatGameInfo(game: GameRecord): string {
  const winnerText = {
    [BetType.Banker]: '🏦 庄家胜',
    [BetType.Player]: '👤 闲家胜',
    [BetType.Tie]: '🤝 和局'
  };

  const startTime = new Date(game.startTime).toLocaleString('zh-CN');
  const endTime = new Date(game.endTime).toLocaleString('zh-CN');
  const duration = Math.floor((game.endTime - game.startTime) / 1000);

  let message = `🎯 **游戏详情 - ${game.gameNumber}**\n\n`;
  message += `📅 开始时间: ${startTime}\n`;
  message += `⏰ 结束时间: ${endTime}\n`;
  message += `⏱️ 游戏时长: ${duration}秒\n\n`;

  message += `🎲 **开牌结果:**\n`;
  message += `🏦 庄家: ${game.cards.banker.join(' + ')} = ${game.result.banker}点\n`;
  message += `👤 闲家: ${game.cards.player.join(' + ')} = ${game.result.player}点\n`;
  message += `🏆 **${winnerText[game.result.winner!]}**\n\n`;

  if (game.totalBets > 0) {
    message += `💰 **下注情况:**\n`;
    message += `👥 参与人数: ${game.totalBets}\n`;
    message += `💵 总下注额: ${game.totalAmount}点\n\n`;

    // 更新下注汇总计算，不显示具体用户信息
    const allUserBets = Object.values(game.bets);
    const betSummary = allUserBets.reduce((acc, userBets) => {
      if (userBets.banker) acc[BetType.Banker] = (acc[BetType.Banker] || 0) + userBets.banker;
      if (userBets.player) acc[BetType.Player] = (acc[BetType.Player] || 0) + userBets.player;
      if (userBets.tie) acc[BetType.Tie] = (acc[BetType.Tie] || 0) + userBets.tie;
      return acc;
    }, {} as Record<BetType, number>);

    message += `📊 **分类下注:**\n`;
    message += `🏦 庄家: ${betSummary[BetType.Banker] || 0}点\n`;
    message += `👤 闲家: ${betSummary[BetType.Player] || 0}点\n`;
    message += `🤝 和局: ${betSummary[BetType.Tie] || 0}点\n\n`;

    // 可选：显示匿名化的参与者信息
    if (allUserBets.length > 0) {
      message += `👤 **参与者:** `;
      const anonymizedUsers = Object.keys(game.bets).map((userId, index) => {
        return `用户${userId.slice(-4)}`;
      });
      message += anonymizedUsers.join(', ');
    }
  } else {
    message += `😔 **无人下注**`;
  }

  return message;
}
