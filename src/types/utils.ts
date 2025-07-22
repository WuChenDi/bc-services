/**
 * 工具和辅助类型
 */

/** 睡眠函数类型 */
export type SleepFunction = (ms: number) => Promise<void>;

/** 格式化选项 */
export interface FormatOptions {
  /** 语言环境 */
  locale?: string;
  /** 时区 */
  timezone?: string;
  /** 日期格式 */
  dateFormat?: string;
  /** 时间格式 */
  timeFormat?: string;
}

/** 消息格式化选项 */
export interface MessageFormatOptions {
  /** 最大长度 */
  maxLength?: number;
  /** 截断符号 */
  truncateSymbol?: string;
  /** 是否转义Markdown */
  escapeMarkdown?: boolean;
}

/** 缓存项 */
export interface CacheItem<T = any> {
  /** 缓存的数据 */
  data: T;
  /** 创建时间戳 */
  timestamp: number;
  /** 过期时间戳（可选） */
  expires?: number;
}

/** 重试选项 */
export interface RetryOptions {
  /** 最大重试次数 */
  maxRetries: number;
  /** 基础延迟时间(毫秒) */
  baseDelay: number;
  /** 最大延迟时间(毫秒) */
  maxDelay?: number;
  /** 退避因子 */
  backoffFactor?: number;
}

/** 验证结果 */
export interface ValidationResult {
  /** 是否有效 */
  valid: boolean;
  /** 单个错误信息 */
  error?: string;
  /** 多个错误信息 */
  errors?: string[];
}

/** 工具函数接口 */
export interface UtilityFunctions {
  /** 睡眠函数 */
  sleep: SleepFunction;
  /** 计算百家乐点数 */
  calculatePoints: (cards: number[]) => number;
  /** 格式化下注汇总 */
  formatBetSummary: (game: any) => string;
  /** 格式化游戏结果 */
  formatGameResult: (game: any, options?: any) => string;
  /** 格式化游戏历史 */
  formatGameHistory: (history: any[]) => string;
  /** 格式化游戏信息 */
  formatGameInfo: (game: any) => string;
}

/** 时间相关工具类型 */
export interface TimeUtils {
  /** 格式化时长 */
  formatDuration: (ms: number) => string;
  /** 格式化时间戳 */
  formatTimestamp: (timestamp: number, format?: string) => string;
  /** 获取相对时间 */
  getRelativeTime: (timestamp: number) => string;
}

/** 数据验证工具类型 */
export interface ValidationUtils {
  /** 验证游戏编号格式 */
  isValidGameNumber: (gameNumber: string) => boolean;
  /** 验证下注金额 */
  isValidBetAmount: (amount: number) => boolean;
  /** 验证聊天ID */
  isValidChatId: (chatId: string) => boolean;
  /** 验证用户ID */
  isValidUserId: (userId: string) => boolean;
}

/** 字符串处理工具类型 */
export interface StringUtils {
  /** 转义Markdown字符 */
  escapeMarkdown: (text: string) => string;
  /** 截断文本 */
  truncateText: (text: string, maxLength: number, suffix?: string) => string;
  /** 生成随机字符串 */
  generateRandomString: (length: number) => string;
}

/** 数学计算工具类型 */
export interface MathUtils {
  /** 计算百分比 */
  calculatePercentage: (part: number, total: number) => number;
  /** 计算平均值 */
  calculateAverage: (numbers: number[]) => number;
  /** 获取随机整数 */
  getRandomInt: (min: number, max: number) => number;
}

/** 错误处理工具类型 */
export interface ErrorUtils {
  /** 格式化错误信息 */
  formatError: (error: unknown) => string;
  /** 判断是否为重试错误 */
  isRetryableError: (error: unknown) => boolean;
  /** 创建错误响应 */
  createErrorResponse: (message: string, code?: string) => { success: false; error: string; code?: string };
}

/** 对象处理工具类型 */
export interface ObjectUtils {
  /** 深拷贝对象 */
  deepClone: <T>(obj: T) => T;
  /** 合并对象 */
  mergeObjects: <T>(...objects: Partial<T>[]) => T;
  /** 选择对象属性 */
  pick: <T, K extends keyof T>(obj: T, keys: K[]) => Pick<T, K>;
  /** 排除对象属性 */
  omit: <T, K extends keyof T>(obj: T, keys: K[]) => Omit<T, K>;
}

/** 数组处理工具类型 */
export interface ArrayUtils {
  /** 数组去重 */
  unique: <T>(array: T[]) => T[];
  /** 数组分组 */
  groupBy: <T, K extends string | number | symbol>(array: T[], key: (item: T) => K) => Record<K, T[]>;
  /** 数组分块 */
  chunk: <T>(array: T[], size: number) => T[][];
  /** 随机打乱数组 */
  shuffle: <T>(array: T[]) => T[];
}

/** 类型守卫工具 */
export interface TypeGuards {
  /** 是否为字符串 */
  isString: (value: unknown) => value is string;
  /** 是否为数字 */
  isNumber: (value: unknown) => value is number;
  /** 是否为布尔值 */
  isBoolean: (value: unknown) => value is boolean;
  /** 是否为对象 */
  isObject: (value: unknown) => value is Record<string, unknown>;
  /** 是否为数组 */
  isArray: (value: unknown) => value is unknown[];
  /** 是否为null或undefined */
  isNullish: (value: unknown) => value is null | undefined;
}

/** 异步工具类型 */
export interface AsyncUtils {
  /** 延迟执行 */
  delay: (ms: number) => Promise<void>;
  /** 超时Promise */
  timeout: <T>(promise: Promise<T>, ms: number) => Promise<T>;
  /** 重试执行 */
  retry: <T>(fn: () => Promise<T>, options: RetryOptions) => Promise<T>;
  /** 批量执行 */
  batchExecute: <T, R>(items: T[], fn: (item: T) => Promise<R>, batchSize?: number) => Promise<R[]>;
}
