/**
 * 服务相关类型
 */
import type { Bot } from 'grammy';
import type { Env, Constants } from './env';
import type { Result, BaseStats, HealthStatus } from './base';
import type { ServiceContainer } from '@/services';

// ===== 服务容器相关 =====

/** 服务上下文 - 包含所有服务需要的共享资源 */
export interface ServiceContext {
  /** 环境变量 */
  env: Env;
  /** Telegram Bot 实例 */
  bot: Bot;
  /** Durable Object 状态 (可选) */
  state?: DurableObjectState;
  /** 配置常量 */
  constants: Constants;
  /** 当前游戏ID */
  gameId?: string;
  /** 当前聊天ID */
  chatId?: string;
  /** 当前用户ID */
  userId?: string;
}

/** 服务构造函数类型 */
export type ServiceConstructor<T = any> = new (container: ServiceContainer) => T;

/** 服务生命周期接口 */
export interface ServiceLifecycle {
  /** 服务初始化 */
  initialize?(): Promise<void> | void;
  /** 上下文更新处理 */
  updateContext?(newContext: ServiceContext): void;
  /** 服务清理 */
  cleanup?(): Promise<void> | void;
}

/** 服务健康检查接口 */
export interface ServiceHealth {
  /** 获取健康状态 */
  getHealth(): ServiceHealthStatus;
}

/** 服务健康状态 */
export interface ServiceHealthStatus extends HealthStatus {
  /** 服务名称 */
  serviceName: string;
}

/** 服务配置 */
export interface ServiceConfig {
  /** 服务名称 */
  name: string;
  /** 是否启用调试模式 */
  debug?: boolean;
  /** 其他配置项 */
  [key: string]: any;
}

// ===== Bot 服务相关 =====

/** Bot API 操作结果 */
export interface BotApiResult<T = any> {
  /** 操作是否成功 */
  success: boolean;
  /** 返回的数据 */
  data?: T;
  /** 错误信息 */
  error?: string;
  /** 是否可重试 */
  retryable?: boolean;
}

/** 消息发送选项 */
export interface SendMessageOptions {
  /** 解析模式 */
  parseMode?: 'Markdown' | 'HTML';
  /** 是否禁用网页预览 */
  disableWebPagePreview?: boolean;
  /** 是否禁用通知 */
  disableNotification?: boolean;
  /** 回复的消息ID */
  replyToMessageId?: number;
  /** 是否允许无回复发送 */
  allowSendingWithoutReply?: boolean;
}

/** Bot服务统计信息 */
export interface BotServiceStats extends BaseStats {
  /** 已发送消息数 */
  messagesSent: number;
  /** 已接收消息数 */
  messagesReceived: number;
  /** 已投掷骰子数 */
  diceRolled: number;
  /** API调用次数 */
  apiCalls: number;
  /** 错误次数 */
  errors: number;
  /** 运行时间(毫秒) */
  uptime: number;
  /** 最后活动时间戳 */
  lastActivity: number;
}

// ===== 存储服务相关 =====

/** 存储操作结果 */
export interface StorageResult<T = any> extends Result<T> {}

/** 存储统计信息 */
export interface StorageStats extends BaseStats {
  /** 已保存游戏记录数 */
  gameRecordsSaved: number;
  /** 已检索游戏记录数 */
  gameRecordsRetrieved: number;
  /** 已检索游戏历史数 */
  gameHistoriesRetrieved: number;
  /** 错误次数 */
  errors: number;
  /** 总操作次数 */
  totalOperations: number;
  /** 最后操作时间戳 */
  lastOperationTime: number;
}

// ===== 消息队列服务相关 =====

/** 消息类型枚举 */
export enum MessageType {
  /** 文本消息 */
  TEXT = 'text',
  /** 骰子消息 */
  DICE = 'dice'
}

/** 队列中的消息基础接口 */
export interface QueuedMessage {
  /** 消息唯一ID */
  id: string;
  /** 聊天ID */
  chatId: string;
  /** 消息内容 */
  content: string;
  /** 解析模式 */
  parseMode?: 'Markdown' | 'HTML';
  /** 消息类型 */
  type: MessageType;
  /** 严格的序列号控制 */
  sequenceId: number;
  /** 重试次数 */
  retries?: number;
  /** 创建时间戳 */
  timestamp: number;
  /** 是否阻塞后续消息 */
  isBlocking?: boolean;
  /** 优先级 (数字越小优先级越高) */
  priority?: number;
}

/** 骰子消息接口 */
export interface DiceMessage extends QueuedMessage {
  /** 消息类型 - 骰子 */
  type: MessageType.DICE;
  /** 玩家类型 (banker/player) */
  playerType: string;
  /** 牌的索引 */
  cardIndex: number;
  /** 骰子结果回调 */
  onDiceResult?: (value: number) => Promise<void> | void;
  /** 骰子表情符号 */
  emoji?: string;
}

/** 文本消息接口 */
export interface TextMessage extends QueuedMessage {
  /** 消息类型 - 文本 */
  type: MessageType.TEXT;
  /** 是否禁用网页预览 */
  disableWebPagePreview?: boolean;
  /** 是否禁用通知 */
  disableNotification?: boolean;
  /** 回复消息ID */
  replyToMessageId?: number;
}

/** 消息处理结果 */
export interface MessageProcessResult {
  /** 是否成功 */
  success: boolean;
  /** 消息ID */
  messageId?: string;
  /** Telegram 消息ID */
  telegramMessageId?: number;
  /** 错误信息 */
  error?: string;
  /** 是否可重试 */
  retryable?: boolean;
  /** 处理耗时(毫秒) */
  duration?: number;
}

/** 队列状态信息 */
export interface QueueStatus {
  /** 队列长度 */
  queueLength: number;
  /** 是否正在处理 */
  processing: boolean;
  /** 当前序列号 */
  currentSequence: number;
  /** 当前游戏ID */
  currentGame: string | null;
  /** 处理中的消息数 */
  processingCount: number;
  /** 阻塞消息数 */
  blockingCount: number;
}

/** 消息队列统计信息 */
export interface MessageQueueStats {
  /** 总处理消息数 */
  totalProcessed: number;
  /** 成功消息数 */
  successfulMessages: number;
  /** 失败消息数 */
  failedMessages: number;
  /** 文本消息数 */
  textMessages: number;
  /** 骰子消息数 */
  diceMessages: number;
  /** 重试消息数 */
  retriedMessages: number;
  /** 平均处理时间(毫秒) */
  averageProcessingTime: number;
  /** 队列最大长度 */
  maxQueueLength: number;
  /** 最后处理时间 */
  lastProcessedTime: number;
  /** 错误率 */
  errorRate: number;
}

/** 消息队列配置 */
export interface MessageQueueConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试间隔基数(毫秒) */
  retryBaseDelay: number;
  /** 消息间隔时间(毫秒) */
  messageInterval: number;
  /** 骰子动画等待时间(毫秒) */
  diceAnimationWait: number;
  /** 骰子结果延迟时间(毫秒) */
  diceResultDelay: number;
  /** 队列超时时间(毫秒) */
  queueTimeout: number;
  /** 是否启用优先级处理 */
  enablePriority: boolean;
  /** 最大队列长度 */
  maxQueueLength: number;
}

/** 消息过滤器接口 */
export interface MessageFilter {
  /** 过滤器名称 */
  name: string;
  /** 过滤条件 */
  predicate: (message: QueuedMessage) => boolean;
  /** 过滤动作 */
  action: 'allow' | 'block' | 'priority';
  /** 优先级调整 (仅当 action 为 'priority' 时有效) */
  priorityAdjustment?: number;
}

/** 消息中间件接口 */
export interface MessageMiddleware {
  /** 中间件名称 */
  name: string;
  /** 消息预处理 */
  preProcess?: (message: QueuedMessage) => Promise<QueuedMessage> | QueuedMessage;
  /** 消息后处理 */
  postProcess?: (message: QueuedMessage, result: MessageProcessResult) => Promise<void> | void;
  /** 错误处理 */
  onError?: (message: QueuedMessage, error: any) => Promise<void> | void;
}

/** 等待消息完成的选项 */
export interface WaitForMessageOptions {
  /** 超时时间(毫秒) */
  timeout?: number;
  /** 检查间隔(毫秒) */
  checkInterval?: number;
  /** 是否在超时时抛出异常 */
  throwOnTimeout?: boolean;
}

// ===== 定时器服务相关 =====

/** 定时器类型枚举 */
export enum TimerType {
  /** 倒计时定时器 */
  COUNTDOWN = 'countdown',
  /** 自动处理定时器 */
  AUTO_PROCESS = 'auto_process',
  /** 下一局游戏定时器 */
  NEXT_GAME = 'next_game',
  /** 清理定时器 */
  CLEANUP = 'cleanup',
  /** 提醒定时器 */
  REMINDER = 'reminder'
}

/** 定时器状态枚举 */
export enum TimerStatus {
  /** 等待中 */
  PENDING = 'pending',
  /** 运行中 */
  RUNNING = 'running',
  /** 已完成 */
  COMPLETED = 'completed',
  /** 已取消 */
  CANCELLED = 'cancelled',
  /** 已失败 */
  FAILED = 'failed'
}

/** 定时器接口 */
export interface GameTimer {
  /** 定时器唯一ID */
  id: string;
  /** 定时器类型 */
  type: TimerType;
  /** 定时器名称 */
  name: string;
  /** 游戏ID */
  gameId?: string;
  /** 聊天ID */
  chatId?: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 执行时间戳 */
  executeAt: number;
  /** 延迟时间(毫秒) */
  delay: number;
  /** 定时器状态 */
  status: TimerStatus;
  /** 执行回调函数 */
  callback: () => Promise<void> | void;
  /** 浏览器定时器ID */
  timerId?: number;
  /** 当前重试次数 */
  retries?: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 错误信息 */
  error?: string;
  /** 完成时间戳 */
  completedAt?: number;
}

/** 定时器统计信息 */
export interface TimerStats {
  /** 总创建定时器数 */
  totalCreated: number;
  /** 总完成定时器数 */
  totalCompleted: number;
  /** 总取消定时器数 */
  totalCancelled: number;
  /** 总失败定时器数 */
  totalFailed: number;
  /** 当前活跃定时器数 */
  activeTimers: number;
  /** 平均延迟时间(毫秒) */
  averageDelay: number;
  /** 平均执行时间(毫秒) */
  averageExecutionTime: number;
  /** 运行时间最长的定时器ID */
  longestRunningTimer?: string;
  /** 等待时间最长的定时器ID */
  oldestPendingTimer?: string;
}

// ===== 日志服务相关 =====

/** 日志级别枚举 */
export enum LogLevel {
  /** 调试级别 */
  DEBUG = 'DEBUG',
  /** 信息级别 */
  INFO = 'INFO',
  /** 警告级别 */
  WARN = 'WARN',
  /** 错误级别 */
  ERROR = 'ERROR'
}

/** 日志上下文 */
export interface LogContext {
  /** 游戏ID */
  gameId?: string;
  /** 聊天ID */
  chatId?: string;
  /** 用户ID */
  userId?: string;
  /** 组件名称 */
  component?: string;
  /** 操作名称 */
  operation?: string;
  /** 其他自定义字段 */
  [key: string]: any;
}

/** 性能计时器接口 */
export interface PerformanceTimer {
  /** 结束计时并返回耗时(毫秒) */
  end(additionalData?: any): number;
}

/** 日志条目 */
export interface LogEntry {
  /** 时间戳 */
  timestamp: number;
  /** 日志级别 */
  level: LogLevel;
  /** 日志消息 */
  message: string;
  /** 日志上下文 */
  context?: LogContext;
  /** 附加数据 */
  data?: any;
  /** 游戏ID */
  gameId?: string;
  /** 聊天ID */
  chatId?: string;
  /** 组件名称 */
  component?: string;
}

/** 日志配置 */
export interface LoggerConfig {
  /** 最小日志级别 */
  minLevel: LogLevel;
  /** 是否启用彩色输出 */
  colorEnabled: boolean;
  /** 是否包含时间戳 */
  includeTimestamp: boolean;
  /** 是否启用性能监控 */
  performanceEnabled: boolean;
  /** 日志格式 */
  format: 'simple' | 'json' | 'detailed';
}

/** 日志统计信息 */
export interface LoggerStats {
  /** 总日志数 */
  totalLogs: number;
  /** 按级别分类的日志数 */
  logsByLevel: Record<LogLevel, number>;
  /** 最后日志时间 */
  lastLogTime: number;
  /** 性能计时器数量 */
  performanceTimers: number;
  /** 活跃计时器数量 */
  activeTimers: number;
}

// ===== 骰子服务相关 =====

/** 骰子投掷结果 */
export interface DiceResult {
  /** 是否成功 */
  success: boolean;
  /** 骰子值 (1-6) */
  value?: number;
  /** 是否使用了备用值 */
  usedFallback?: boolean;
  /** 错误信息 */
  error?: string;
  /** 投掷耗时(毫秒) */
  duration?: number;
}

/** 骰子统计信息 */
export interface DiceStats {
  /** 总投掷次数 */
  totalRolls: number;
  /** 成功次数 */
  successfulRolls: number;
  /** 失败次数 */
  failedRolls: number;
  /** 使用备用值次数 */
  fallbackUsed: number;
  /** 平均投掷时间(毫秒) */
  averageRollTime: number;
  /** 各点数分布 */
  valueDistribution: Record<1 | 2 | 3 | 4 | 5 | 6, number>;
  /** 最后投掷时间 */
  lastRollTime: number;
  /** 成功率 */
  successRate: number;
}

/** 骰子服务配置 */
export interface DiceConfig {
  /** 骰子动画等待时间(毫秒) */
  animationWaitMs: number;
  /** 结果延迟时间(毫秒) */
  resultDelayMs: number;
  /** 投掷超时时间(毫秒) */
  rollTimeoutMs: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 默认骰子表情 */
  defaultEmoji: string;
}

// ===== 游戏服务相关 =====

/** 游戏服务配置 */
export interface GameServiceConfig {
  /** 下注时间(毫秒) */
  bettingDurationMs: number;
  /** 自动游戏间隔(毫秒) */
  autoGameIntervalMs: number;
  /** 全局处理超时(毫秒) */
  globalProcessTimeoutMs: number;
  /** 清理延迟(毫秒) */
  cleanupDelayMs: number;
  /** 最大下注金额 */
  maxBetAmount: number;
  /** 最大用户总下注 */
  maxUserTotalBet: number;
}

// ===== 存储服务相关（补充） =====

/** 存储服务配置 */
export interface StorageConfig {
  /** 游戏历史记录保留数量 */
  maxGameHistoryCount: number;
  /** 缓存过期时间(毫秒) */
  cacheExpirationMs: number;
  /** 是否启用本地缓存 */
  enableCache: boolean;
}

// ===== 定时器服务相关（补充） =====

/** 定时器服务配置 */
export interface TimerServiceConfig {
  /** 默认最大重试次数 */
  defaultMaxRetries: number;
  /** 重试延迟基数(毫秒) */
  retryBaseDelay: number;
  /** 定时器清理间隔(毫秒) */
  cleanupInterval: number;
  /** 最大定时器数量 */
  maxTimers: number;
  /** 定时器超时时间(毫秒) */
  timerTimeout: number;
}
