/**
 * SMS 验证码轮询客户端模块
 *
 * 统一导出所有 polling、策略、去重、重发相关的函数和类型。
 * 使用 chrome.alarms 单次 + 递归重新调度模式。
 */
export {
  ALARM_PREFIX,
  startPolling,
  stopPolling,
  clearAllPollAlarms,
  handleAlarm,
  FIRST_RESEND_DELAY_MS,
  RESEND_INTERVAL_MS,
} from './poller';
export type { PollerCallbacks, PollerDependencies } from './poller';

export { pollForCode, type SmsPollingProvider } from './strategies';

export { computeDedupKey, isCodeDuplicate } from './dedup';

export { tryResendSms, type ResendCapableProvider } from './resend';
