/**
 * Service Worker 入口
 *
 * 注册 Provider、设置消息监听、初始化存储默认值。
 */
import { defineBackground } from 'wxt/sandbox';
import { HeroSmsProvider, ProviderRegistry } from '../lib/providers';
import type { ProviderConfig } from '../lib/providers';

export default defineBackground(() => {
  // 注册 HeroSMS Provider
  ProviderRegistry.register(
    'herosms',
    (config: ProviderConfig) => new HeroSmsProvider(config.apiKey, config)
  );

  // 骨架消息监听（后续功能填充具体处理逻辑）
  chrome.runtime.onMessage.addListener(
    (_message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
      sendResponse({ status: 'ok' });
      return true; // 保持异步响应通道
    }
  );
});
