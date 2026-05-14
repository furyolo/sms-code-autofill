/**
 * 状态持久化与恢复
 *
 * 每次状态转换后即时写入 chrome.storage.session，防止 SW 休眠丢失。
 * SW 恢复时根据 phase 重建 alarm 或通知。
 */
import { RetryPhase, RetryState } from './types';

/** storage.session 中的 key */
const STATE_KEY = 'retry_state';

/** 序列化后的 RetryState（Sets → Arrays） */
export interface SerializedRetryState {
  phase: string;
  sessionId: string;
  currentBucket: number;
  attemptInBucket: number;
  totalAttempts: number;
  maxBuckets: number;
  bucketSize: number;
  currentActivationId: string | null;
  currentPhoneNumber: string | null;
  currentActivationCountry: string | null;
  lastError: Record<string, unknown> | null;
  startedAt: number;
  lastTransitionAt: number;
  notificationId: string | null;
  usedCodes: string[];
  attemptedSmsKeys: string[];
  firstResendDone: boolean;
  lastResendAt: number;
  pauseMode: string;
  costPerAttempt: number;
  pollInterval: number;
  requestTimeout: number;
}

/**
 * 将 RetryState 序列化并持久化到 chrome.storage.session
 * Sets 转换为 Arrays 以便 JSON 序列化
 */
export function serializeRetryState(state: RetryState): SerializedRetryState {
  return {
    phase: state.phase,
    sessionId: state.sessionId,
    currentBucket: state.currentBucket,
    attemptInBucket: state.attemptInBucket,
    totalAttempts: state.totalAttempts,
    maxBuckets: state.maxBuckets,
    bucketSize: state.bucketSize,
    currentActivationId: state.currentActivationId,
    currentPhoneNumber: state.currentPhoneNumber,
    currentActivationCountry: state.currentActivationCountry,
    lastError: state.lastError
      ? {
          name: state.lastError.name,
          category: state.lastError.category,
          code: state.lastError.code,
          message: state.lastError.message,
          recoverable: state.lastError.recoverable,
          retryAfterMs: state.lastError.retryAfterMs,
        }
      : null,
    startedAt: state.startedAt,
    lastTransitionAt: state.lastTransitionAt,
    notificationId: state.notificationId,
    usedCodes: Array.from(state.usedCodes),
    attemptedSmsKeys: Array.from(state.attemptedSmsKeys),
    firstResendDone: state.firstResendDone,
    lastResendAt: state.lastResendAt,
    pauseMode: state.pauseMode,
    costPerAttempt: state.costPerAttempt,
    pollInterval: state.pollInterval,
    requestTimeout: state.requestTimeout,
  };
}

/**
 * 将 RetryState 序列化并持久化到 chrome.storage.session
 * Sets 转换为 Arrays 以便 JSON 序列化
 */
export async function saveState(state: RetryState): Promise<void> {
  const serialized = serializeRetryState(state);
  await chrome.storage.session.set({ [STATE_KEY]: serialized });
}

export function deserializeRetryState(raw: SerializedRetryState): RetryState {
  return {
    phase: raw.phase as RetryPhase,
    sessionId: raw.sessionId,
    currentBucket: raw.currentBucket,
    attemptInBucket: raw.attemptInBucket,
    totalAttempts: raw.totalAttempts,
    maxBuckets: raw.maxBuckets,
    bucketSize: raw.bucketSize,
    currentActivationId: raw.currentActivationId,
    currentPhoneNumber: raw.currentPhoneNumber,
    currentActivationCountry: raw.currentActivationCountry ?? null,
    lastError: raw.lastError
      ? ({
          name: raw.lastError.name || 'TypedError',
          category: raw.lastError.category,
          code: raw.lastError.code,
          message: raw.lastError.message,
          recoverable: raw.lastError.recoverable,
          retryAfterMs: raw.lastError.retryAfterMs,
        } as RetryState['lastError'])
      : null,
    startedAt: raw.startedAt,
    lastTransitionAt: raw.lastTransitionAt,
    notificationId: raw.notificationId,
    usedCodes: new Set(raw.usedCodes || []),
    attemptedSmsKeys: new Set(raw.attemptedSmsKeys || []),
    firstResendDone: raw.firstResendDone,
    lastResendAt: raw.lastResendAt,
    pauseMode: raw.pauseMode as RetryState['pauseMode'],
    costPerAttempt: raw.costPerAttempt,
    pollInterval: raw.pollInterval,
    requestTimeout: raw.requestTimeout,
  };
}

/**
 * 从 chrome.storage.session 加载并反序列化 RetryState
 * Arrays 还原为 Sets
 */
export async function loadState(): Promise<RetryState | null> {
  try {
    const result = await chrome.storage.session.get(STATE_KEY);
    const raw = result[STATE_KEY] as SerializedRetryState | undefined;
    if (!raw) return null;

    return deserializeRetryState(raw);
  } catch {
    console.warn('[Persistence] 加载状态失败，返回 null');
    return null;
  }
}

/**
 * Service Worker 恢复逻辑
 *
 * - WAIT_CODE: 重新注册 poll alarm
 * - AWAIT_CONFIRM: 保持暂停，用户可通过 Popup 或通知按钮继续/停止
 * - 其他 phase: 无动作（保持现状）
 *
 * @param state 恢复后的状态
 * @param onTransition 当需要自动转换状态时的回调（如 AWAIT_CONFIRM 无通知 → STOPPED）
 */
export async function recoverState(
  state: RetryState,
  onTransition?: (event: { type: 'userStop' }) => Promise<void>,
): Promise<void> {
  switch (state.phase) {
    case RetryPhase.WAIT_CODE:
      // SW 休眠后 alarm 已丢失，需重新注册
      if (state.currentActivationId) {
        // 注意：此处仅标记需要恢复，实际 alarm 注册由 machine 层处理
        console.log('[Persistence] 检测到 WAIT_CODE 状态，需要恢复 poll alarm');
      }
      break;

    case RetryPhase.AWAIT_CONFIRM:
      // Popup 已提供继续/停止入口，系统通知只作为附加提醒；通知被系统清理时不应自动停止流程。
      console.log('[Persistence] 恢复 AWAIT_CONFIRM，等待用户在 Popup 或通知中确认');
      break;

    default:
      // IDLE / DONE / STOPPED / 其他 — 无需恢复
      break;
  }
}
