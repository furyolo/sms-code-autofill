/**
 * 验证码轮询管理模块
 *
 * 基于 chrome.alarms 的单次 + 递归重新调度模式（替代 setInterval）。
 * 每次 alarm 触发后不自动重复，由 handler 根据状态机 phase 决定是否重新调度。
 *
 * 核心流程：
 *   startPolling → alarm 触发 → handleAlarm → 超时检查 → 重发检查
 *     → pollForCode → 有码: transition(codeReceived)
 *                    → 无码: updateBadge + startPolling（递归重新调度）
 *
 * 轮询策略降级：getStatusV2 (JSON) → getStatus (V1 文本) → getActiveActivations
 * 超时事件: codeTimeout，触发后进入重试循环
 *
 * alarm name 约定: poll_{activationId}，便于统一管理和 SW 恢复时识别。
 */
import type { RetryState } from '../state-machine/types';
import { RetryPhase } from '../state-machine/types';
import { pollForCode, type SmsPollingProvider } from './strategies';
import { tryResendSms, FIRST_RESEND_DELAY_MS, RESEND_INTERVAL_MS, type ResendCapableProvider } from './resend';

// 重新导出重发常量: FIRST_RESEND_DELAY_MS=90000 (90s 首次重发), RESEND_INTERVAL_MS=30000 (30s 后续重发间隔)
export { FIRST_RESEND_DELAY_MS, RESEND_INTERVAL_MS } from './resend';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 所有轮询 alarm 的统一前缀 */
export const ALARM_PREFIX = 'poll_';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** handleAlarm 所需的回调函数集 */
export interface PollerCallbacks {
  /** 验证码到达时的回调 */
  onCodeReceived: (code: string) => Promise<void>;
  /** 轮询超时时的回调 */
  onCodeTimeout: () => Promise<void>;
  /** 更新 Badge 倒计时显示 */
  updateBadgeCountdown: (remaining: number) => Promise<void>;
}

/** handleAlarm 需要的依赖项 */
export interface PollerDependencies {
  /** 当前 RetryState */
  state: RetryState;
  /** 支持轮询和重发的 Provider 实例 */
  provider: SmsPollingProvider & ResendCapableProvider;
  /** 状态机回调 */
  callbacks: PollerCallbacks;
}

// ---------------------------------------------------------------------------
// Alarm 管理
// ---------------------------------------------------------------------------

/**
 * 启动轮询 alarm
 *
 * 创建单次 alarm（非 periodInMinutes 模式），在 intervalMs 后触发一次。
 * 触发后的重新调度由 handleAlarm 递归完成。
 *
 * @param activationId 当前激活 ID，作为 alarm name 后缀
 * @param intervalMs 轮询间隔毫秒数（默认 5000）
 */
export async function startPolling(activationId: string, intervalMs: number): Promise<void> {
  const alarmName = `${ALARM_PREFIX}${activationId}`;
  await chrome.alarms.create(alarmName, {
    when: Date.now() + intervalMs,
  });
}

/**
 * 停止单个轮询 alarm
 * @param activationId 对应激活 ID
 */
export async function stopPolling(activationId: string): Promise<void> {
  const alarmName = `${ALARM_PREFIX}${activationId}`;
  try {
    await chrome.alarms.clear(alarmName);
  } catch {
    // 忽略 alarm 已被清除的情况
  }
}

/**
 * 清除所有轮询 alarm（poll_ 前缀）
 * 用于 SW 启动恢复时清理残留 alarm，防止历史 alarm 触发误操作。
 */
export async function clearAllPollAlarms(): Promise<void> {
  try {
    const alarms = await chrome.alarms.getAll();
    for (const alarm of alarms) {
      if (alarm.name.startsWith(ALARM_PREFIX)) {
        await chrome.alarms.clear(alarm.name);
      }
    }
  } catch {
    // 忽略 alarm API 错误
  }
}

// ---------------------------------------------------------------------------
// Alarm 监听器
// ---------------------------------------------------------------------------

/**
 * 处理轮询 alarm 触发事件
 *
 * 核心逻辑：
 * 1. 解析 alarm name 提取 activationId
 * 2. 安全检查：phase 须为 WAIT_CODE，activationId 须匹配
 * 3. 超时检查：elapsed >= requestTimeout → onCodeTimeout
 * 4. SMS 重发检查：按 90s/30s 节奏触发
 * 5. 执行 pollForCode 三层轮询
 * 6. 有验证码 → stopPolling + onCodeReceived
 * 7. 无验证码 → updateBadgeCountdown + startPolling 重新调度
 *
 * @param alarm chrome.alarms.onAlarm 触发时传入的 alarm 对象
 * @param deps 当前状态、Provider 实例、回调函数
 */
export async function handleAlarm(
  alarm: chrome.alarms.Alarm,
  deps: PollerDependencies,
): Promise<void> {
  // 仅处理 poll_ 前缀的 alarm
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const activationId = alarm.name.slice(ALARM_PREFIX.length);
  const { state, provider, callbacks } = deps;

  // 安全检查：确认当前 phase 仍是 WAIT_CODE
  if (state.phase !== RetryPhase.WAIT_CODE) {
    await stopPolling(activationId);
    return;
  }

  // 安全检查：确认 activationId 匹配
  if (state.currentActivationId !== activationId) {
    await stopPolling(activationId);
    return;
  }

  // 超时检查
  const elapsed = Date.now() - state.startedAt;
  if (elapsed >= state.requestTimeout) {
    await stopPolling(activationId);
    await callbacks.onCodeTimeout();
    return;
  }

  // SMS 重发检查
  const resendResult = await tryResendSms(state, activationId, elapsed, provider);
  if (resendResult.firstResendDone !== state.firstResendDone) {
    // 标记已更新（调用方负责持久化，这里仅通过回调告知）
    state.firstResendDone = resendResult.firstResendDone;
    state.lastResendAt = resendResult.lastResendAt;
  }

  // 执行轮询
  const code = await pollForCode(activationId, provider, state);
  if (code) {
    // 验证码到达
    await stopPolling(activationId);
    await callbacks.onCodeReceived(code);
  } else {
    // 无验证码，更新 Badge 倒计时并重新调度
    const remaining = Math.ceil((state.requestTimeout - elapsed) / 1000);
    await callbacks.updateBadgeCountdown(remaining);
    await startPolling(activationId, state.pollInterval);
  }
}
