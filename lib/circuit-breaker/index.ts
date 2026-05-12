/**
 * 电路断路器模块统一导出
 *
 * 提供 CircuitBreaker 类、错误分类映射 classifyError、
 * CircuitErrorType 枚举及所有类型定义
 */
export { CircuitBreaker, classifyError } from './breaker';
export { CircuitErrorType, DEFAULT_CIRCUIT_CONFIG } from './types';
export type {
  BreakerState,
  CircuitConfig,
  CircuitBreakerState,
  CircuitBreakerResult,
  ErrorCounter,
} from './types';
