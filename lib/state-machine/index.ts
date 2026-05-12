/**
 * 状态机模块统一导出
 */
export { RetryPhase } from './types';
export type { RetryState, StateEvent, StateTransition, CircuitBreaker, CircuitBreakerInfo } from './types';
export { RetryStateMachine } from './machine';
export { AsyncLock } from './async-lock';
export { saveState, loadState, recoverState } from './persistence';
export {
  buildBucketPauseNotification,
  buildCircuitBreakerPauseNotification,
  buildStopSummaryNotification,
  buildSuccessNotification,
  buildSilentBucketTransitionNotification,
  buildMaxRetriesExhaustedNotification,
  createNotification,
  dismissNotification,
} from './notifications';
export type { NotificationTemplate } from './notifications';
