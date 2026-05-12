/**
 * 电路断路器实现
 *
 * 三态模型：CLOSED → OPEN → HALF_OPEN → CLOSED
 * - CLOSED: 正常计数，同类错误连续达到阈值 → OPEN
 * - OPEN: 已触发断路，等待用户确认（无基于时间的自动恢复）
 * - HALF_OPEN: 用户确认后的一次探测机会，成功→CLOSED，失败→OPEN
 *
 * 核心规则：
 * 1. 6 种错误类型独立计数，互不干扰
 * 2. 差异化阈值（VOIP=2, AlreadyUsed=2, Invalid=2, RateLimit=4, Timeout=5, Unknown=3）
 * 3. HALF_OPEN 状态下任何失败立即回到 OPEN（不等阈值）
 * 4. 同 Bucket 内同类型仅触发一次（避免重复打断）
 * 5. 无自动恢复——必须用户显式确认继续
 */
import type { TypedError } from '../providers/types';
import type {
  BreakerState,
  CircuitBreakerResult,
  CircuitBreakerState,
  CircuitConfig,
  ErrorCounter,
} from './types';
import { CircuitErrorType, DEFAULT_CIRCUIT_CONFIG } from './types';

// ---------------------------------------------------------------------------
// 错误分类映射
// ---------------------------------------------------------------------------

/** 中文类型标签（供通知文案使用） */
const ERROR_LABELS: Record<CircuitErrorType, string> = {
  VOIP_REJECTED: 'VoIP 号码',
  ALREADY_USED: '已被注册的号码',
  RATE_LIMITED: '频率限制',
  INVALID_NUMBER: '无效号码',
  PROVIDER_TIMEOUT: '服务超时',
  UNKNOWN_REJECT: '被拒绝的号码',
};

/** 中文建议文本（可选，部分类型可能无建议） */
const ERROR_SUGGESTIONS: Partial<Record<CircuitErrorType, string>> = {
  VOIP_REJECTED: '建议切换国家或等待一段时间后再试',
  ALREADY_USED: '建议更换国家后重试',
  RATE_LIMITED: '建议等待 5 分钟后再试',
  PROVIDER_TIMEOUT: '建议检查网络或 HeroSMS 服务状态',
};

/**
 * 将 TypedError 映射到 CircuitErrorType
 *
 * 通过关键词匹配 Provider 错误消息进行分类。
 * 若 HeroSMS 改变消息格式，映射将退回 UNKNOWN_REJECT 兜底。
 * 映射维护集中在此函数内，不分散到其他模块。
 */
export function classifyError(error: TypedError): CircuitErrorType {
  const msg = error.message.toLowerCase();

  // 1. VoIP / 虚拟号码
  if (msg.includes('voip') || msg.includes('virtual')) {
    return CircuitErrorType.VOIP_REJECTED;
  }

  // 2. 号码已被注册/使用
  if (msg.includes('already') || msg.includes('registered') || msg.includes('used')) {
    return CircuitErrorType.ALREADY_USED;
  }

  // 3. 频率限制
  if (msg.includes('rate') || msg.includes('limit') || msg.includes('too many')) {
    return CircuitErrorType.RATE_LIMITED;
  }

  // 4. 无效号码格式
  if (msg.includes('invalid') || msg.includes('format')) {
    return CircuitErrorType.INVALID_NUMBER;
  }

  // 5. API 超时（需 category === 'API' 且消息含 timeout/5）
  if (error.category === 'API' && (msg.includes('timeout') || msg.includes('5'))) {
    return CircuitErrorType.PROVIDER_TIMEOUT;
  }

  // 6. 默认未分类
  return CircuitErrorType.UNKNOWN_REJECT;
}

// ---------------------------------------------------------------------------
// CircuitBreaker 类
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private state: CircuitBreakerState;
  private config: CircuitConfig;

  constructor(config: CircuitConfig = DEFAULT_CIRCUIT_CONFIG) {
    this.config = config;
    this.state = this.createInitialState();
  }

  // -------------------------------------------------------------------------
  // 公开方法
  // -------------------------------------------------------------------------

  /**
   * 记录一次错误，返回是否触发断路
   *
   * 三态转换逻辑：
   * - HALF_OPEN → 任何失败立刻 → OPEN（不等阈值）
   * - CLOSED + consecutiveCount >= threshold → OPEN
   * - 同 Bucket 内同类型已触发 → tripped=false（仅触发一次）
   */
  recordError(errorType: CircuitErrorType): CircuitBreakerResult {
    // 断路器关闭时始终返回未触发
    if (!this.config.enabled) {
      return {
        tripped: false,
        errorType,
        consecutiveCount: 0,
      };
    }

    const counter = this.ensureCounter(errorType);
    counter.consecutiveCount += 1;

    const threshold = this.config.thresholds[errorType] ?? this.config.defaultThreshold;

    // HALF_OPEN 状态下任何失败立即断路（不等阈值累积）
    if (this.state.globalState === 'HALF_OPEN') {
      counter.tripped = true;
      counter.trippedInBucket = true;
      this.state.globalState = 'OPEN';
      return {
        tripped: true,
        errorType,
        consecutiveCount: counter.consecutiveCount,
        message: this.buildMessage(errorType, counter.consecutiveCount),
      };
    }

    // 同 Bucket 内已触发 → 不再返回 tripped（同一错误类型仅触发一次）
    if (counter.trippedInBucket) {
      return {
        tripped: false,
        errorType,
        consecutiveCount: counter.consecutiveCount,
      };
    }

    // CLOSED 状态：检查是否达到阈值 → 触发断路
    if (counter.consecutiveCount >= threshold) {
      counter.tripped = true;
      counter.trippedInBucket = true;
      this.state.globalState = 'OPEN';
      return {
        tripped: true,
        errorType,
        consecutiveCount: counter.consecutiveCount,
        message: this.buildMessage(errorType, counter.consecutiveCount),
      };
    }

    // 未达阈值，正常返回
    return {
      tripped: false,
      errorType,
      consecutiveCount: counter.consecutiveCount,
    };
  }

  /**
   * 一次完整激活成功后重置所有计数器
   *
   * 调用时机：状态机 DONE 分支（成功获取到验证码）
   * 行为：所有计数器归零，globalState → CLOSED
   */
  recordSuccess(): void {
    this.state = this.createInitialState();
  }

  /**
   * 用户确认继续后重置触发标记
   *
   * 调用时机：AWAIT_CONFIRM + userContinue 分支
   * 行为：清除所有 tripped/trippedInBucket 标记，globalState → HALF_OPEN
   * 注意：consecutiveCount 不清零（跨 Bucket 保留），以便 HALF_OPEN 后首错立即感知
   */
  reset(): void {
    for (const counter of Object.values(this.state.counters)) {
      counter.tripped = false;
      counter.trippedInBucket = false;
    }
    this.state.globalState = 'HALF_OPEN';
  }

  /** 检查指定错误类型是否已触发 */
  isTripped(type: CircuitErrorType): boolean {
    if (!this.config.enabled) return false;
    return this.state.counters[type]?.tripped ?? false;
  }

  /** 获取当前状态快照（用于持久化到 chrome.storage.session） */
  getSnapshot(): CircuitBreakerState {
    // 深拷贝确保外部修改不影响内部状态
    return {
      globalState: this.state.globalState,
      counters: { ...this.state.counters },
    };
  }

  /**
   * 生成用户可读的触发原因文本
   *
   * 格式："{中文标签} {count} 次。{建议}"
   * 示例："VoIP 号码 2 次。建议切换国家或等待一段时间后再试"
   */
  buildMessage(type: CircuitErrorType, count: number): string {
    const label = ERROR_LABELS[type] || '同类错误';
    const suggestion = ERROR_SUGGESTIONS[type] ? ` ${ERROR_SUGGESTIONS[type]}` : '';
    return `连续 ${count} 次被识别为${label}。${suggestion}`.trim();
  }

  // -------------------------------------------------------------------------
  // 内部方法
  // -------------------------------------------------------------------------

  /** 创建初始状态（所有计数器归零，globalState=CLOSED） */
  private createInitialState(): CircuitBreakerState {
    const counters = {} as Record<CircuitErrorType, ErrorCounter>;
    const types: CircuitErrorType[] = [
      CircuitErrorType.VOIP_REJECTED,
      CircuitErrorType.ALREADY_USED,
      CircuitErrorType.RATE_LIMITED,
      CircuitErrorType.INVALID_NUMBER,
      CircuitErrorType.PROVIDER_TIMEOUT,
      CircuitErrorType.UNKNOWN_REJECT,
    ];
    for (const type of types) {
      counters[type] = {
        type,
        consecutiveCount: 0,
        tripped: false,
        trippedInBucket: false,
      };
    }
    return {
      counters,
      globalState: 'CLOSED' as BreakerState,
    };
  }

  /** 获取或创建指定类型的计数器 */
  private ensureCounter(type: CircuitErrorType): ErrorCounter {
    let counter = this.state.counters[type];
    if (!counter) {
      counter = {
        type,
        consecutiveCount: 0,
        tripped: false,
        trippedInBucket: false,
      };
      this.state.counters[type] = counter;
    }
    return counter;
  }
}
