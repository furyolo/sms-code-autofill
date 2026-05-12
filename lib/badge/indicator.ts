/**
 * Badge 更新模块 — 单一入口 updateBadge(state)
 *
 * 所有 Badge 更新必须通过此函数，禁止其他模块直接调用 chrome.action.setBadgeText。
 * 优先级逻辑内嵌在 computeBadgeState 中：
 *   ERROR > AWAIT_CONFIRM > SUCCESS > WAIT_CODE > RETRYING > IDLE/STOPPED
 *
 * 6 种视觉状态：
 *   IDLE         — 无 Badge
 *   RETRYING     — 橙色数字（attemptInBucket + 1）
 *   WAIT_CODE    — 蓝/橙/红倒计时（>30s 蓝、10-30s 橙、<10s 红）
 *   AWAIT_CONFIRM — 红色 "!"
 *   SUCCESS      — 绿色 "✓"
 *   STOPPED      — 清除 Badge
 *
 * 4 字符硬上限：>99 → '99+'，>30 → '30+'
 */
import type { RetryState } from '../state-machine/types';
import { RetryPhase } from '../state-machine/types';
import { BADGE_COLORS } from './colors';

// ---------------------------------------------------------------------------
// computeBadgeState — 核心状态计算
// ---------------------------------------------------------------------------

/**
 * 根据 RetryState 计算 Badge 文本和背景色
 * 优先级逻辑内嵌在 switch 顺序中：
 * IDLE/STOPPED（最低）→ RETRYING/GET_PHONE/FILL_PHONE/REJECTED/BUCKET_EXHAUSTED → WAIT_CODE → DONE → AWAIT_CONFIRM（高）
 * 注意：switch 中 AWAIT_CONFIRM 和 DONE 在 WAIT_CODE 之前，因此当这些 phase 存在时
 * 不会进入 WAIT_CODE 分支——优先级由 RetryPhase 枚举的 switch case 顺序自然体现
 */
export function computeBadgeState(state: RetryState): {
  badgeText: string;
  badgeColor: readonly number[] | null;
} {
  switch (state.phase) {
    case RetryPhase.IDLE:
    case RetryPhase.STOPPED:
      return { badgeText: '', badgeColor: null };

    case RetryPhase.AWAIT_CONFIRM:
      return { badgeText: '!', badgeColor: BADGE_COLORS.RED };

    case RetryPhase.DONE:
      return { badgeText: '✓', badgeColor: BADGE_COLORS.GREEN };

    case RetryPhase.WAIT_CODE: {
      const remaining = computeRemainingSeconds(state);
      const color =
        remaining > 30
          ? BADGE_COLORS.BLUE
          : remaining > 10
            ? BADGE_COLORS.ORANGE
            : BADGE_COLORS.RED;
      return {
        badgeText: formatBadgeNumber(remaining),
        badgeColor: color,
      };
    }

    // RETRYING: GET_PHONE, FILL_PHONE, REJECTED, BUCKET_EXHAUSTED
    default:
      return {
        badgeText: formatBadgeNumber(state.attemptInBucket + 1),
        badgeColor: BADGE_COLORS.ORANGE,
      };
  }
}

// ---------------------------------------------------------------------------
// formatBadgeNumber — 4 字符硬上限
// ---------------------------------------------------------------------------

/**
 * 格式化 Badge 数字文本，确保不超过 4 字符
 * - n > 99  → '99+'（适用于倒计时 >99s 场景）
 * - n > 30  → '30+'（适用于重试计数，实际流程上限 30 次）
 * - 否则     → String(n)
 */
export function formatBadgeNumber(n: number): string {
  if (n > 99) return '99+';
  if (n > 30) return '30+';
  return String(n);
}

// ---------------------------------------------------------------------------
// updateBadge — 单一入口
// ---------------------------------------------------------------------------

/**
 * 更新扩展 Badge 的文本和背景色
 * 所有 Badge 变更必须通过此函数，禁止直接调用 chrome.action.setBadgeText
 * 调用方：状态机 transition()、SW 恢复 recover()
 */
export async function updateBadge(state: RetryState): Promise<void> {
  const { badgeText, badgeColor } = computeBadgeState(state);

  try {
    await chrome.action.setBadgeText({ text: badgeText });
    if (badgeColor) {
      await chrome.action.setBadgeBackgroundColor({
        color: badgeColor as [number, number, number, number],
      });
    }
  } catch {
    // Badge API 在非扩展上下文或权限不足时可能不可用
  }
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/**
 * 计算 WAIT_CODE 阶段剩余秒数
 * remaining = ceil((requestTimeout - elapsed) / 1000)，最小值 0
 */
function computeRemainingSeconds(state: RetryState): number {
  const elapsed = Date.now() - state.startedAt;
  const remaining = Math.ceil((state.requestTimeout - elapsed) / 1000);
  return Math.max(0, remaining);
}
