/**
 * Content Script 入口
 *
 * 在 auth.openai.com/add-phone 页面注入，负责：
 *   1. 检测手机号和验证码输入框（三层选择器回退链）
 *   2. 使用 React fiber（__reactFiber$ 前缀 key + native setter）填入
 *   3. 填入后 MutationObserver 检测验证码输入框 / 自动点击提交按钮
 *   4. 与 Service Worker 通过类型化消息协议通信
 *
 * Content Script MUST NOT 发起任何 HTTP 请求（受页面 CSP 限制）。
 * 所有 API 调用由 Service Worker 代理。
 *
 * 选择器缓存存储于 chrome.storage.session key: selector_cache
 */

import { defineContentScript } from 'wxt/sandbox';
import type { B2C_Message } from '../lib/content/messages';
import { sendToBackground } from '../lib/content/messages';
import {
  fillPhoneInput,
  fillCodeInput,
  fillReactInput,
  fillNativeInput,
  getPhoneInput,
  getCodeInput,
} from '../lib/content/filler';
import type { SelectorStrategy } from '../lib/content/selectors';
import {
  waitForCodeInput,
  findAndClickSubmitButton,
} from '../lib/content/observer';

export default defineContentScript({
  matches: ['https://auth.openai.com/add-phone*'],
  runAt: 'document_idle',

  main() {
    // 初始化：通知 Service Worker 页面已就绪
    sendToBackground({
      type: 'C2B_PAGE_READY',
      tabId: -1, // Background 从 sender.tab.id 获取真实 tabId
      url: location.href,
    });

    console.log('[Content] SMS Code Autofill Content Script 已注入');

    // 注册消息监听
    chrome.runtime.onMessage.addListener(handleMessage);

    // 页面关闭 / 导航离开 → 通知 SW 取消当前激活
    window.addEventListener('beforeunload', () => {
      sendToBackground({ type: 'C2B_PAGE_CLOSED' });
    });
  },
});

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------

/**
 * 处理来自 Service Worker 的 B2C 消息
 * 返回 true 保持消息通道开放以支持异步响应
 */
function handleMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  const msg = message as B2C_Message;

  switch (msg.type) {
    case 'B2C_FILL_PHONE':
      handleFillPhone(msg.phoneNumber).then((result) => {
        sendResponse(result);
      }, (error) => {
        console.error('[Content] handleFillPhone 错误:', error);
        sendResponse({ success: false, error: String(error) });
      });
      return true; // 异步响应

    case 'B2C_FILL_CODE':
      handleFillCode(msg.code).then((result) => {
        sendResponse(result);
      }, (error) => {
        console.error('[Content] handleFillCode 错误:', error);
        sendResponse({ success: false, error: String(error) });
      });
      return true; // 异步响应

    default:
      return false; // 不需要异步响应
  }
}

// ---------------------------------------------------------------------------
// 填入处理
// ---------------------------------------------------------------------------

/**
 * 处理手机号填入指令
 * 填入 → 等 3s 检测验证码输入框 → 找到则报告成功 → 未找到则点击提交按钮
 */
async function handleFillPhone(
  phoneNumber: string,
): Promise<{ success: boolean; error?: string }> {
  console.log('[Content] B2C_FILL_PHONE:', phoneNumber);

  // 1. 填入手机号
  const filled = await fillPhoneInput(phoneNumber);
  if (!filled) {
    sendToBackground({
      type: 'C2B_PHONE_FILLED',
      success: false,
      error: 'SELECTOR_NOT_FOUND',
    });
    return { success: false, error: 'SELECTOR_NOT_FOUND' };
  }

  // 2. 等待验证码输入框出现（3s MutationObserver）
  const codeInput = await waitForCodeInput(3000);

  if (codeInput) {
    // 验证码输入框已自动出现（React SPA 路由切换）
    console.log('[Content] 检测到验证码输入框，无需点击提交按钮');
    sendToBackground({ type: 'C2B_PHONE_FILLED', success: true });
    return { success: true };
  }

  // 3. 未检测到验证码输入框 → 自动点击提交按钮
  console.log('[Content] 3s 内未检测到验证码输入框，尝试点击提交按钮');
  findAndClickSubmitButton();

  // 无论按钮是否存在，均上报成功（页面可能已自动提交）
  sendToBackground({ type: 'C2B_PHONE_FILLED', success: true });
  return { success: true };
}

/**
 * 处理验证码填入指令
 */
async function handleFillCode(
  code: string,
): Promise<{ success: boolean; error?: string }> {
  console.log('[Content] B2C_FILL_CODE:', code);

  const filled = await fillCodeInput(code);
  if (!filled) {
    return { success: false, error: 'SELECTOR_NOT_FOUND' };
  }

  sendToBackground({ type: 'C2B_CODE_DETECTED', code });
  return { success: true };
}
