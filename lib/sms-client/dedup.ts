/**
 * 验证码去重工具
 *
 * 使用 SHA256(code + '_' + smsKey) 前 16 位十六进制作为去重 key，
 * 防止同一 code+smsKey 组合的验证码被重复填入。
 * 基于 RetryState.usedCodes / attemptedSmsKeys 集合做匹配检查。
 */
import type { RetryState } from '../state-machine/types';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** SHA256 哈希前 16 位十六进制，用于去重 key */
async function sha256Short(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 计算验证码去重 key
 * @param code 验证码字符串
 * @param smsKey SMS 事件 key（如来自 getStatusV2 的 sms_key 字段）
 * @returns SHA256(code + '_' + smsKey) 前 16 位十六进制
 */
export async function computeDedupKey(code: string, smsKey: string): Promise<string> {
  return sha256Short(`${code}_${smsKey}`);
}

/**
 * 检查验证码是否已使用（去重判断）
 *
 * 检查两个维度：
 * 1. 验证码本身是否已在 usedCodes 中
 * 2. code+smsKey 的哈希是否已在 attemptedSmsKeys 中
 *
 * @param code 验证码字符串
 * @param smsKey SMS 事件 key（可选，来自 getStatusV2）
 * @param state 当前 RetryState，包含去重集合
 * @returns true = 已使用需跳过，false = 未使用可接受
 */
export async function isCodeDuplicate(
  code: string,
  smsKey: string,
  state: RetryState,
): Promise<boolean> {
  // 直接 code 匹配
  if (state.usedCodes.has(code)) {
    return true;
  }

  // smsKey 去重匹配
  if (smsKey && state.attemptedSmsKeys.has(smsKey)) {
    return true;
  }

  // code+smsKey 组合哈希去重
  if (smsKey) {
    const dedupKey = await computeDedupKey(code, smsKey);
    if (state.attemptedSmsKeys.has(dedupKey)) {
      return true;
    }
  }

  return false;
}
