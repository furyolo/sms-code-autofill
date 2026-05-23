// ==UserScript==
// @name         SMS Code Autofill Userscript
// @namespace    sms-code-autofill
// @version      0.1.0
// @description  自动获取并填入 OpenAI 手机验证码
// @match        https://chatgpt.com/
// @match        https://auth.openai.com/*
// @match        https://chatgpt.com/auth/*
// @match        https://chat.openai.com/auth/*
// @run-at       document-idle
// @connect      hero-sms.com
// @connect      *
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.notification
// @grant        GM.registerMenuCommand
// ==/UserScript==

import { detectSmsAutofillRuntime, markSmsAutofillRuntime } from '../lib/content/page-automation';
import { createTampermonkeyPlatformAdapter, registerTampermonkeyMenuCommand } from './tampermonkey-adapter';
import { UserscriptRuntime } from './runtime';

async function main(): Promise<void> {
  const existing = detectSmsAutofillRuntime();
  if (existing && existing !== 'userscript') {
    console.warn('[Userscript] 检测到扩展版已注入，userscript 默认不自动启动');
    return;
  }

  markSmsAutofillRuntime('userscript');
  const runtime = new UserscriptRuntime(createTampermonkeyPlatformAdapter());
  await runtime.init();
  registerTampermonkeyMenuCommand('SMS Code Autofill 设置', () => {
    void runtime.openSettings();
  });
}

void main().catch((error) => {
  console.error('[Userscript] 初始化失败:', error);
});
