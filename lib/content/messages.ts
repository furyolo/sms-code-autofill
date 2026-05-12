/**
 * Content Script 消息协议
 *
 * C2B_* = Content → Background
 * B2C_* = Background → Content
 * Content Script MUST NOT 发起任何 HTTP 请求——所有 API 调用由 Service Worker 代理。
 */

// ---------------------------------------------------------------------------
// Content → Background 消息类型
// ---------------------------------------------------------------------------

/** Content Script 发送到 Service Worker 的消息联合类型 */
export type C2B_Message =
  | { type: 'C2B_PAGE_READY'; tabId: number; url: string }
  | { type: 'C2B_PHONE_FILLED'; success: boolean; error?: string }
  | { type: 'C2B_CODE_DETECTED'; code: string }
  | { type: 'C2B_PAGE_CLOSED' };

// ---------------------------------------------------------------------------
// Background → Content 消息类型
// ---------------------------------------------------------------------------

/** Service Worker 发送到 Content Script 的消息联合类型 */
export type B2C_Message =
  | { type: 'B2C_FILL_PHONE'; phoneNumber: string }
  | { type: 'B2C_FILL_CODE'; code: string }
  | { type: 'B2C_STATUS_UPDATE'; phase: string; detail: string };

// ---------------------------------------------------------------------------
// 发送辅助
// ---------------------------------------------------------------------------

/** 向 Service Worker 发送 C2B 消息（不等待响应） */
export function sendToBackground(message: C2B_Message): void {
  chrome.runtime.sendMessage(message).catch((err: Error) => {
    // SW 可能未就绪，静默忽略
    console.warn('[Content] sendToBackground 失败:', err.message);
  });
}
