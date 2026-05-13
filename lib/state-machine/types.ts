/**
 * 重试状态机类型定义
 *
 * RetryPhase 9 态枚举 + RetryState 运行时状态 + StateEvent 事件联合类型
 * 所有转换采用纯函数式 (RetryState, Event) => RetryState
 */
import type { SmsActivation, TypedError } from '../providers/types';
import type { CircuitBreakerResult, CircuitErrorType } from '../circuit-breaker';

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/** 重试状态机 9 个阶段 */
export enum RetryPhase {
  IDLE = 'IDLE',
  GET_PHONE = 'GET_PHONE',
  FILL_PHONE = 'FILL_PHONE',
  WAIT_CODE = 'WAIT_CODE',
  REJECTED = 'REJECTED',
  DONE = 'DONE',
  BUCKET_EXHAUSTED = 'BUCKET_EXHAUSTED',
  AWAIT_CONFIRM = 'AWAIT_CONFIRM',
  STOPPED = 'STOPPED',
}

// ---------------------------------------------------------------------------
// 断路器接口（F-008 实现前的最小桩接口）
// ---------------------------------------------------------------------------

/** 断路器触发信息 */
export interface CircuitBreakerInfo {
  errorType: string;
  consecutiveCount: number;
  threshold: number;
}

/** 断路器最小接口，F-008 实现时替换 */
export interface CircuitBreaker {
  recordError(errorType: CircuitErrorType): CircuitBreakerResult;
  reset(): void;
}

// ---------------------------------------------------------------------------
// 状态事件
// ---------------------------------------------------------------------------

/** 状态机接收的 12 种事件 */
export type StateEvent =
  | { type: 'start' }
  | { type: 'phoneAcquired'; activation: SmsActivation }
  | { type: 'phoneFailed'; error: TypedError }
  | { type: 'phoneFilled' }
  | { type: 'fillFailed'; error: TypedError }
  | { type: 'codeReceived'; code: string }
  | { type: 'codeTimeout' }
  | { type: 'phoneRejected'; error: TypedError }
  | { type: 'circuitBreakerTrip'; error: TypedError; info: CircuitBreakerInfo }
  | { type: 'userContinue' }
  | { type: 'userStop' }
  | { type: 'maxRetriesExhausted' };

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

/** 状态机运行时状态，每次转换后持久化到 chrome.storage.session */
export interface RetryState {
  phase: RetryPhase;
  /** 本次会话唯一 ID（crypto.randomUUID()） */
  sessionId: string;
  /** 当前 Bucket 轮次，1-based */
  currentBucket: number;
  /** 当前 Bucket 内已尝试次数，0-based */
  attemptInBucket: number;
  /** 全局累计尝试次数 */
  totalAttempts: number;
  /** 最大 Bucket 轮数（默认 3） */
  maxBuckets: number;
  /** 每轮最大尝试次数（默认 10） */
  bucketSize: number;
  /** 当前激活 ID（来自 getNumber 返回值） */
  currentActivationId: string | null;
  /** 当前手机号（含 "+" 前缀的国际格式） */
  currentPhoneNumber: string | null;
  /** 当前激活对应的 HeroSMS 国家 ID（来自配置或 Provider 返回值） */
  currentActivationCountry: string | null;
  /** 最近一次错误 */
  lastError: TypedError | null;
  /** 会话启动时间戳（Date.now()） */
  startedAt: number;
  /** 最近一次状态转换时间戳 */
  lastTransitionAt: number;
  /** 活跃通知 ID（用于 dismiss / 恢复检查） */
  notificationId: string | null;
  /** 已使用的验证码集合（去重） */
  usedCodes: Set<string>;
  /** 已尝试的 SMS key 集合（去重） */
  attemptedSmsKeys: Set<string>;
  /** 是否已完成首次重发 */
  firstResendDone: boolean;
  /** 最近一次重发时间戳 */
  lastResendAt: number;
  /** 暂停模式：同时使用 Bucket + 断路器 / 仅断路器 */
  pauseMode: 'bucket_and_circuit' | 'circuit_only';
  /** 用户配置的预计单价（默认 0.05），用于成本估算 */
  costPerAttempt: number;
  /** 轮询间隔（毫秒），默认 5000 */
  pollInterval: number;
  /** 请求超时（毫秒），默认 120000 */
  requestTimeout: number;
}

// ---------------------------------------------------------------------------
// 转换函数签名
// ---------------------------------------------------------------------------

/** 纯函数式状态转换签名 */
export type StateTransition = (state: RetryState, event: StateEvent) => RetryState;
