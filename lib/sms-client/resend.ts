/**
 * SMS 重发逻辑
 *
 * 在轮询过程中按特定节奏请求上游重发 SMS：
 * - 首次重发：进入 WAIT_CODE 90 秒后（FIRST_RESEND_DELAY_MS）
 * - 后续重发：每 30 秒一次（RESEND_INTERVAL_MS）
 *
 * 使用 firstResendDone 标记防止重复首次重发，
 * lastResendAt 时间戳控制后续重发间隔。
 */
import type { BaseSmsProvider } from '../providers/base-provider';
import type { RetryState } from '../state-machine/types';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 首次重发延迟：90 秒 */
export const FIRST_RESEND_DELAY_MS = 90_000;

/** 后续重发间隔：30 秒 */
export const RESEND_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * SMS 重发请求接口
 * 任何支持 requestResendSms(activationId) → boolean 的 Provider 均可使用
 */
export interface ResendCapableProvider extends BaseSmsProvider {
  requestResendSms(activationId: string): Promise<boolean>;
}

/**
 * 尝试 SMS 重发
 *
 * 检查当前经过时间是否触发重发条件：
 * 1. 未完成首次重发且 elapsed >= FIRST_RESEND_DELAY_MS → 执行首次重发
 * 2. 已完成首次重发且距上次重发 >= RESEND_INTERVAL_MS → 执行后续重发
 *
 * 返回更新后的标记值（firstResendDone, lastResendAt），调用方负责持久化。
 *
 * @param state 当前 RetryState
 * @param activationId 当前激活 ID
 * @param elapsed 自进入 WAIT_CODE 以来的经过毫秒数
 * @param provider 支持重发的 Provider 实例
 * @returns 更新后的 { firstResendDone, lastResendAt }
 */
export async function tryResendSms(
  state: RetryState,
  activationId: string,
  elapsed: number,
  provider: ResendCapableProvider,
): Promise<{ firstResendDone: boolean; lastResendAt: number }> {
  let firstResendDone = state.firstResendDone;
  let lastResendAt = state.lastResendAt;

  // 首次重发：未完成且达到 90 秒阈值
  if (!firstResendDone && elapsed >= FIRST_RESEND_DELAY_MS) {
    try {
      await provider.requestResendSms(activationId);
      firstResendDone = true;
      lastResendAt = Date.now();
    } catch {
      // 重发请求失败不阻塞轮询流程
      console.warn('[SMS Resend] 首次重发请求失败');
    }
  }

  // 后续重发：已完成首次且距上次 >= 30 秒
  if (firstResendDone && lastResendAt > 0) {
    const sinceLastResend = Date.now() - lastResendAt;
    if (sinceLastResend >= RESEND_INTERVAL_MS) {
      try {
        await provider.requestResendSms(activationId);
        lastResendAt = Date.now();
      } catch {
        console.warn('[SMS Resend] 后续重发请求失败');
      }
    }
  }

  return { firstResendDone, lastResendAt };
}
