import type { Env } from '@/types';

export const getConstants = (env: Env) => ({
  BETTING_DURATION_MS: parseInt(env.BETTING_DURATION_MS || '30000'),
  AUTO_GAME_INTERVAL_MS: parseInt(env.AUTO_GAME_INTERVAL_MS || '10000'),
  DICE_ROLL_TIMEOUT_MS: parseInt(env.DICE_ROLL_TIMEOUT_MS || '10000'),
  DICE_ROLL_MAX_RETRIES: parseInt(env.DICE_ROLL_MAX_RETRIES || '2'),
  DICE_ANIMATION_WAIT_MS: parseInt(env.DICE_ANIMATION_WAIT_MS || '4000'),
  DICE_RESULT_DELAY_MS: parseInt(env.DICE_RESULT_DELAY_MS || '1000'),
  CARD_DEAL_DELAY_MS: parseInt(env.CARD_DEAL_DELAY_MS || '500'),
  MESSAGE_DELAY_MS: parseInt(env.MESSAGE_DELAY_MS || '2000'),
  GLOBAL_PROCESS_TIMEOUT_MS: parseInt(env.GLOBAL_PROCESS_TIMEOUT_MS || '90000'),
  CLEANUP_DELAY_MS: parseInt(env.CLEANUP_DELAY_MS || '30000'),
});

export type Constants = ReturnType<typeof getConstants>;
