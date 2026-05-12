/**
 * Badge 闪烁管理
 *
 * AWAIT_CONFIRM 状态下红色背景脉冲闪烁（1-2Hz），吸引用户注意。
 * 使用 chrome.alarms 驱动（非 setInterval，避免 SW 休眠丢失）。
 * - Chrome：RED ↔ DIMRED 交替，每 ~1s 切换一次
 * - Firefox：Badge 动态更新支持有限 → 静态降级（isFirefox() 返回 true 时跳过闪烁）
 * - WCAG 2.2.2 合规：闪烁频率 <= 3Hz，60 秒后自动降级为静态
 */
import { BADGE_COLORS } from './colors';

/** 闪烁 alarm 名称 */
const BLINK_ALARM = 'badge_blink';

/** 当前闪烁相位（true=亮/RED, false=暗/DIMRED） */
let blinkState = false;

/** 闪烁已执行次数（每 ~1s 递增），超过 60 后自动停止 */
let blinkElapsed = 0;

/**
 * 检测是否为 Firefox 浏览器
 * Firefox 对 Badge 动态更新支持有限，频繁调用 setBadgeBackgroundColor
 * 可能导致渲染延迟或掉落，因此跳过闪烁逻辑
 */
export function isFirefox(): boolean {
  // typeof browser 为 Firefox 的 WebExtensions polyfill 特征
  // navigator.userAgent 作为后备检测
  if (typeof (globalThis as Record<string, unknown>).browser !== 'undefined') return true;
  return /Firefox/i.test(navigator.userAgent);
}

/**
 * 启动 Badge 闪烁
 * - Firefox 上直接返回（静态降级）
 * - 创建 chrome.alarms，periodInMinutes=1/60（约 1 秒间隔，~1Hz）
 * - 重置 blinkState 和 blinkElapsed
 */
export async function startBadgeBlink(): Promise<void> {
  if (isFirefox()) return;

  blinkState = false;
  blinkElapsed = 0;

  await chrome.alarms.create(BLINK_ALARM, {
    periodInMinutes: 1 / 60, // ~1 秒
  });
}

/**
 * 停止 Badge 闪烁
 * - 清除 badge_blink alarm
 * - 重置状态变量
 */
export async function stopBadgeBlink(): Promise<void> {
  await chrome.alarms.clear(BLINK_ALARM);
  blinkState = false;
  blinkElapsed = 0;
}

/**
 * 闪烁 handler，每次 badge_blink alarm 触发时调用
 * 切换背景色 RED ↔ DIMRED，不修改 Badge 文本
 * 60 次（约 60s）后自动调用 stopBadgeBlink() 静态降级
 */
export async function handleBlinkAlarm(): Promise<void> {
  blinkState = !blinkState;
  const color = blinkState ? BADGE_COLORS.RED : BADGE_COLORS.DIMRED;

  try {
    await chrome.action.setBadgeBackgroundColor({ color: color as [number, number, number, number] });
  } catch {
    // Badge API 可能不可用
  }

  blinkElapsed++;
  if (blinkElapsed > 60) {
    await stopBadgeBlink();
  }
}
