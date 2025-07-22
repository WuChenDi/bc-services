/**
 * 基础类型和通用接口
 */

/** 通用响应结果 */
export interface Result<T = any> {
  /** 操作是否成功 */
  success: boolean;
  /** 返回的数据 */
  data?: T;
  /** 错误信息 */
  error?: string;
  /** 附加消息 */
  message?: string;
}

/** 通用API响应 */
export interface ApiResponse {
  /** 操作是否成功 */
  success: boolean;
  /** 成功消息 */
  message?: string;
  /** 错误信息 */
  error?: string;
}

/** 分页参数 */
export interface PaginationParams {
  /** 页码（从1开始） */
  page?: number;
  /** 每页数量 */
  limit?: number;
  /** 偏移量 */
  offset?: number;
}

/** 分页响应 */
export interface PaginatedResult<T> extends Result<T[]> {
  /** 分页信息 */
  pagination?: {
    /** 当前页码 */
    page: number;
    /** 每页数量 */
    limit: number;
    /** 总记录数 */
    total: number;
    /** 总页数 */
    totalPages: number;
  };
}

/** 时间戳类型（毫秒） */
export type Timestamp = number;

/** 唯一标识符类型 */
export type ID = string;

/** 健康检查状态 */
export interface HealthStatus {
  /** 是否健康 */
  healthy: boolean;
  /** 状态消息 */
  message?: string;
  /** 最后检查时间戳 */
  lastCheck: number;
  /** 详细信息 */
  details?: Record<string, any>;
}

/** 统计信息基础接口 */
export interface BaseStats {
  /** 总数量 */
  total: number;
  /** 成功数量 */
  successful: number;
  /** 失败数量 */
  failed: number;
  /** 最后活动时间戳 */
  lastActivity: number;
}
