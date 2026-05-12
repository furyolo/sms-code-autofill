/**
 * 恢复锚定信号
 *
 * 用户从 AWAIT_CONFIRM 点击"继续"后，Badge 在 500ms 内完成 2 次切换：
 *   '' (清除) → 红色背景 → 数字 + 橙色背景
 *
 * 视觉信号：短暂闪烁告知用户"自动化重新开始了"
 * - 第 1 次：setBadgeText('') → 100ms delay
 * - 第 2 次：setBadgeBackgroundColor(RED) → 200ms delay
 * - 最终态：setBadgeText(formatBadgeNumber(attemptInBucket+1)) + setBadgeBackgroundColor(ORANGE)
 */
import type { RetryState } from '../state-machine/types';
import { BADGE_COLORS } from './colors';
import { formatBadgeNumber } from './indicator';

/** Promise-based 延迟 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发送恢复锚定信号
 * 500ms 内 2 次 Badge 切换，最终定位到当前重试计数 + 橙色
 * 仅在 userContinue (AWAIT_CONFIRM → GET_PHONE) 时调用
 */
export async function sendRecoverySignal(state: RetryState): Promise<void> {
  try {
    // 第 1 次切换：清除 Badge 文本（"!" → ""）
    await chrome.action.setBadgeText({ text: '' });
    await sleep(100);

    // 第 2 次切换：设置红色背景（暗示刚刚离开暂停状态）
    await chrome.action.setBadgeBackgroundColor({
      color: BADGE_COLORS.RED as [number, number, number, number],
    });
    await sleep(200);

    // 最终态：显示当前重试次数 + 橙色背景
    const text = formatBadgeNumber(state.attemptInBucket + 1);
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({
      color: BADGE_COLORS.ORANGE as [number, number, number, number],
    });
  } catch {
    // Badge API 可能不可用，静默忽略
  }
}
