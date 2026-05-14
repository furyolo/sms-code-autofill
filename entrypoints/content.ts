/**
 * Content Script 入口
 *
 * 在 auth.openai.com/add-phone 页面注入，负责：
 *   1. 接收 Service Worker 的表单预检、填号、填码指令
 *   2. 调用平台无关的页面自动化模块
 *   3. 将页面反馈转换为 C2B_* 消息
 *
 * Content Script MUST NOT 发起任何 HTTP 请求（受页面 CSP 限制）。
 * 所有 API 调用由 Service Worker 或 userscript 平台适配层代理。
 */

import { defineContentScript } from 'wxt/sandbox';
import type { B2C_Message } from '../lib/content/messages';
import { sendToBackground } from '../lib/content/messages';
import {
  fillCodeAndSubmit,
  fillPhoneAndSubmit,
  markSmsAutofillRuntime,
  preflightPhoneForm,
} from '../lib/content/page-automation';

export default defineContentScript({
  matches: ['https://auth.openai.com/*'],
  runAt: 'document_idle',

  main() {
    markSmsAutofillRuntime('extension');

    sendToBackground({
      type: 'C2B_PAGE_READY',
      tabId: -1,
      url: location.href,
    });

    console.log('[Content] SMS Code Autofill Content Script 已注入');

    chrome.runtime.onMessage.addListener(handleMessage);

    window.addEventListener('beforeunload', () => {
      sendToBackground({ type: 'C2B_PAGE_CLOSED' });
    });
  },
});

function handleMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  const msg = message as B2C_Message;

  switch (msg.type) {
    case 'B2C_PREFLIGHT_FORM':
      preflightPhoneForm().then((result) => {
        sendResponse(result);
      }, (error) => {
        console.error('[Content] preflightPhoneForm 错误:', error);
        sendResponse({ success: false, error: String(error) });
      });
      return true;

    case 'B2C_FILL_PHONE':
      handleFillPhone(msg.phoneNumber, msg.providerCountry ?? null, msg.providerCountryNames ?? null).then((result) => {
        sendResponse(result);
      }, (error) => {
        console.error('[Content] handleFillPhone 错误:', error);
        sendResponse({ success: false, error: String(error) });
      });
      return true;

    case 'B2C_FILL_CODE':
      handleFillCode(msg.code).then((result) => {
        sendResponse(result);
      }, (error) => {
        console.error('[Content] handleFillCode 错误:', error);
        sendResponse({ success: false, error: String(error) });
      });
      return true;

    default:
      return false;
  }
}

async function handleFillPhone(
  phoneNumber: string,
  providerCountry: string | null,
  providerCountryNames: string[] | null,
): Promise<{ success: boolean; error?: string }> {
  const result = await fillPhoneAndSubmit({
    phoneNumber,
    providerCountry,
    providerCountryNames,
  });

  if (result.success) {
    sendToBackground({ type: 'C2B_PHONE_FILLED', success: true });
    return result;
  }

  const reason = result.error === 'PHONE_REJECTED_BY_OPENAI'
    ? 'PHONE_REJECTED_BY_OPENAI'
    : 'FORM_STRUCTURE_CHANGED';
  sendToBackground({ type: 'C2B_PHONE_REJECTED', reason });
  return result;
}

async function handleFillCode(code: string): Promise<{ success: boolean; error?: string }> {
  const result = await fillCodeAndSubmit(code);
  if (result.success) {
    sendToBackground({ type: 'C2B_CODE_DETECTED', code });
  }
  return result;
}
