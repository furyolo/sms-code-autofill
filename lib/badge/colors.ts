/**
 * Badge 颜色常量
 *
 * chrome.action.setBadgeBackgroundColor 接受 {color: [R,G,B,A]} 整数数组
 * 颜色语义遵循 F-006 规范：
 *   BLUE   — 倒计时 >30s，平静等待
 *   ORANGE — 重试计数 / 倒计时 10-30s，注意/紧迫
 *   RED    — 暂停(AWAIT_CONFIRM) / 倒计时 <10s，危险/停止
 *   GREEN  — 成功(DONE)
 *   DIMRED — 闪烁暗态(RED 的暗化版本)
 */
export const BADGE_COLORS = {
  /** 倒计时 >30s — #2196F3 */
  BLUE: [33, 150, 243, 255] as const,
  /** 重试计数 / 倒计时 10-30s — #f97316 */
  ORANGE: [249, 115, 22, 255] as const,
  /** 暂停 / 倒计时 <10s — #ef4444 */
  RED: [239, 68, 68, 255] as const,
  /** 成功 — #22c55e */
  GREEN: [34, 197, 94, 255] as const,
  /** 闪烁暗态 — #991b1b */
  DIMRED: [153, 27, 27, 255] as const,
} as const;
