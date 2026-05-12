/**
 * 电路断路器类型定义
 *
 * CircuitErrorType 6 种错误分类 + 三态模型 (CLOSED/OPEN/HALF_OPEN) +
 * 差异化阈值配置 + 独立计数器
 *
 * 参考 Martin Fowler Circuit Breaker 模式，适配浏览器扩展的特定需求：
 * - 无基于时间的自动恢复（余额消耗必须用户显式确认）
 * - HALF_OPEN 仅有一次探测机会，失败立即回到 OPEN
 */
import type { TypedError } from '../providers/types';

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/** 断路器识别的 6 种错误类型，各类型独立计数 */
export enum CircuitErrorType {
  VOIP_REJECTED = 'VOIP_REJECTED',
  ALREADY_USED = 'ALREADY_USED',
  RATE_LIMITED = 'RATE_LIMITED',
  INVALID_NUMBER = 'INVALID_NUMBER',
  PROVIDER_TIMEOUT = 'PROVIDER_TIMEOUT',
  UNKNOWN_REJECT = 'UNKNOWN_REJECT',
}

// ---------------------------------------------------------------------------
// 断路器三态模型
// ---------------------------------------------------------------------------

/** 断路器三态：CLOSED(正常计数) → OPEN(已触发) → HALF_OPEN(探测机会) → CLOSED */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

/** 单类错误的计数追踪 */
export interface ErrorCounter {
  type: CircuitErrorType;
  consecutiveCount: number;
  tripped: boolean;
  trippedInBucket: boolean;
}

/** 断路器完整状态快照（可持久化到 chrome.storage.session） */
export interface CircuitBreakerState {
  counters: Record<CircuitErrorType, ErrorCounter>;
  globalState: BreakerState;
}

/** 断路器配置 */
export interface CircuitConfig {
  enabled: boolean;
  defaultThreshold: number;
  thresholds: Partial<Record<CircuitErrorType, number>>;
}

/** recordError 返回值 */
export interface CircuitBreakerResult {
  tripped: boolean;
  errorType: CircuitErrorType;
  consecutiveCount: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

/**
 * 差异化阈值默认值
 *
 * VoIP/ALREADY_USED/INVALID = 2: 号码池质量问题，2 次足以判断系统性问题
 * RATE_LIMITED = 4: OpenAI 频率限制通常是临时的，更高容忍度
 * PROVIDER_TIMEOUT = 5: API 临时故障可能自行恢复，最高容忍度
 * UNKNOWN_REJECT = 3: 未分类错误的一致性较低，3 次确认后暂停
 */
export const DEFAULT_CIRCUIT_CONFIG: CircuitConfig = {
  enabled: true,
  defaultThreshold: 3,
  thresholds: {
    [CircuitErrorType.VOIP_REJECTED]: 2,
    [CircuitErrorType.ALREADY_USED]: 2,
    [CircuitErrorType.INVALID_NUMBER]: 2,
    [CircuitErrorType.RATE_LIMITED]: 4,
    [CircuitErrorType.PROVIDER_TIMEOUT]: 5,
    [CircuitErrorType.UNKNOWN_REJECT]: 3,
  },
};
