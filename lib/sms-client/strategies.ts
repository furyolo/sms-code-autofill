/**
 * 三层轮询策略
 *
 * 降级链：getStatusV2（JSON API） → getStatus（V1 纯文本） → getActiveActivations（遍历活跃列表）
 * 每层策略包裹 try-catch，解析失败不抛异常而是返回 null 触发下一层降级。
 * pollForCode 主函数顺次调用，任一成功即返回，全部失败返回 null。
 */
import type { BaseSmsProvider } from '../providers/base-provider';
import type { SmsCandidate } from '../providers/types';
import type { RetryState } from '../state-machine/types';
import { isCodeDuplicate } from './dedup';

// ---------------------------------------------------------------------------
// 轮询用 Provider 接口（包含 HeroSMS 特有轮询方法）
// ---------------------------------------------------------------------------

/** 轮询模块需要的 Provider 扩展方法 */
export interface SmsPollingProvider extends BaseSmsProvider {
  getStatusV2(activationId: string): Promise<SmsCandidate>;
  getStatus(activationId: string): Promise<SmsCandidate>;
  getActiveActivations(start?: number, limit?: number): Promise<Array<Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// 策略函数
// ---------------------------------------------------------------------------

/**
 * 策略 1：getStatusV2（JSON API）
 * 调用 HeroSMS 的 getStatusV2，尝试从 JSON 响应中提取验证码。
 * 解析失败 / status !== 'ok' / code 不存在 → 返回 null 触发降级。
 */
async function pollStrategyV2(
  activationId: string,
  provider: SmsPollingProvider,
): Promise<SmsCandidate | null> {
  try {
    const result = await provider.getStatusV2(activationId);

    // 上游取消，不做进一步处理
    if (result.status === 'cancel') {
      return { status: 'cancel' };
    }

    if (result.status === 'ok' && result.code) {
      return result;
    }

    return null;
  } catch {
    // V2 失败，静默降级
    return null;
  }
}

/**
 * 策略 2：getStatus（V1 纯文本协议）
 * 调用 HeroSMS 的 getStatus，解析纯文本响应 STATUS_OK:id:code。
 * 解析失败 → 返回 null 触发降级。
 */
async function pollStrategyV1(
  activationId: string,
  provider: SmsPollingProvider,
): Promise<SmsCandidate | null> {
  try {
    const result = await provider.getStatus(activationId);

    if (result.status === 'cancel') {
      return { status: 'cancel' };
    }

    if (result.status === 'ok' && result.code) {
      return { status: 'ok', code: result.code };
    }

    return null;
  } catch {
    // V1 失败，静默降级
    return null;
  }
}

/**
 * 策略 3：getActiveActivations（遍历活跃列表）
 * 查询所有活跃激活，遍历查找匹配 activationId 的项。
 * 作为最后一层兜底，应对 V2/V1 同时不可用的极端情况。
 */
async function pollStrategyActiveActivations(
  activationId: string,
  provider: SmsPollingProvider,
): Promise<SmsCandidate | null> {
  try {
    const activeList = await provider.getActiveActivations();
    for (const item of activeList) {
      if (String(item.activationId || item.id || '') === String(activationId)) {
        const rawCode = item.smsCode || item.sms_code || item.code;
        if (typeof rawCode === 'string' && rawCode && rawCode !== 'null' && rawCode !== 'None') {
          return {
            status: 'ok',
            code: rawCode,
            sms_text: typeof item.smsText === 'string' ? item.smsText : undefined,
            sms_time:
              typeof item.dateTime === 'string' ? item.dateTime
              : typeof item.date === 'string' ? item.date
              : typeof item.smsDate === 'string' ? item.smsDate
              : typeof item.smsTime === 'string' ? item.smsTime
              : undefined,
          };
        }
      }
    }
    return null;
  } catch {
    // 全部策略失败
    return null;
  }
}

// ---------------------------------------------------------------------------
// 主轮询函数
// ---------------------------------------------------------------------------

/**
 * 执行一次完整的验证码轮询
 *
 * 降级链：getStatusV2 → getStatus(V1) → getActiveActivations
 * 任何一层返回有效验证码后立即进行去重检查：
 * - 若未重复 → 返回 code
 * - 若已重复 → 返回 null（等待下一次轮询）
 * 全部失败 → 返回 null
 *
 * @param activationId 当前激活 ID
 * @param provider 支持轮询的 Provider 实例
 * @param state 当前 RetryState（用于去重判断）
 * @returns 未重复的有效验证码字符串，或 null
 */
export async function pollForCode(
  activationId: string,
  provider: SmsPollingProvider,
  state: RetryState,
): Promise<string | null> {
  // 策略 1: getStatusV2（JSON 格式，含 SMS + Call channel）
  const v2Result = await pollStrategyV2(activationId, provider);
  if (v2Result) {
    if (v2Result.status === 'cancel') return null;
    if (v2Result.status === 'ok' && v2Result.code) {
      const smsKey = v2Result.sms_key || '';
      const isDup = await isCodeDuplicate(v2Result.code, smsKey, state);
      if (!isDup) return v2Result.code;
    }
  }

  // 策略 2: getStatus（V1 纯文本协议）
  const v1Result = await pollStrategyV1(activationId, provider);
  if (v1Result) {
    if (v1Result.status === 'cancel') return null;
    if (v1Result.status === 'ok' && v1Result.code) {
      const isDup = await isCodeDuplicate(v1Result.code, '', state);
      if (!isDup) return v1Result.code;
    }
  }

  // 策略 3: getActiveActivations（遍历活跃列表）
  const activeResult = await pollStrategyActiveActivations(activationId, provider);
  if (activeResult) {
    if (activeResult.status === 'cancel') return null;
    if (activeResult.status === 'ok' && activeResult.code) {
      const isDup = await isCodeDuplicate(activeResult.code, '', state);
      if (!isDup) return activeResult.code;
    }
  }

  return null;
}
