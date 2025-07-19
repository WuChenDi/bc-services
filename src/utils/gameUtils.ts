export function calculatePoints(cards: number[]): number {
  return cards.reduce((sum, card) => sum + card, 0) % 10;
}
