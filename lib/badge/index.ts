/**
 * lib/badge — Badge 状态指示模块
 *
 * 统一导出：updateBadge（单一入口）、computeBadgeState、formatBadgeNumber
 * 闪烁管理：startBadgeBlink、stopBadgeBlink、handleBlinkAlarm
 * 恢复信号：sendRecoverySignal
 * 颜色常量：BADGE_COLORS
 */
export { BADGE_COLORS } from './colors';
export { updateBadge, computeBadgeState, formatBadgeNumber } from './indicator';
export { startBadgeBlink, stopBadgeBlink, handleBlinkAlarm, isFirefox } from './blink';
export { sendRecoverySignal } from './recovery-signal';
