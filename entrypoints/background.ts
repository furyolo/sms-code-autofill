/**
 * Service Worker 入口
 *
 * 注册 Provider、创建状态机、设置消息监听、初始化存储默认值。
 * 状态机是整个扩展的核心协调者，所有组件通过 storage.session 同步状态。
 */
import { defineBackground } from 'wxt/sandbox';
import { HeroSmsProvider, ProviderRegistry } from '../lib/providers';
import type { ProviderConfig } from '../lib/providers';
import { RetryStateMachine } from '../lib/state-machine';

// ---------------------------------------------------------------------------
// Provider 注册
// ---------------------------------------------------------------------------

ProviderRegistry.register(
  'herosms',
  (config: ProviderConfig) => new HeroSmsProvider(config.apiKey, config),
);

// ---------------------------------------------------------------------------
// 状态机创建（初始 Provider 为占位，start 时从 storage 读取 apiKey 重建）
// ---------------------------------------------------------------------------

const dummyProvider = new HeroSmsProvider('', {
  apiKey: '',
  service: 'dr',
  country: '187',
});

let machine = new RetryStateMachine(dummyProvider);

// ---------------------------------------------------------------------------
// chrome.runtime.onMessage 消息路由
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    const msg = message as Record<string, unknown>;

    // 处理消息分发
    handleMessage(msg)
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        console.error('[Background] 消息处理错误:', error);
        sendResponse({ status: 'error', message: String(error) });
      });

    return true; // 保持异步响应通道
  },
);

/** 消息分发逻辑 */
async function handleMessage(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (msg.type) {
    case 'POPUP_TOGGLE': {
      const enabled = Boolean(msg.enabled);
      console.log('[Background] POPUP_TOGGLE:', enabled);
      if (enabled) {
        await machine.start();
      } else {
        await machine.stop();
      }
      return { status: 'ok', phase: machine.currentState.phase };
    }

    case 'GET_STATE': {
      return {
        status: 'ok',
        phase: machine.currentState.phase,
        totalAttempts: machine.currentState.totalAttempts,
        currentBucket: machine.currentState.currentBucket,
        maxBuckets: machine.currentState.maxBuckets,
        attemptInBucket: machine.currentState.attemptInBucket,
        bucketSize: machine.currentState.bucketSize,
        currentPhoneNumber: machine.currentState.currentPhoneNumber,
        lastError: machine.currentState.lastError
          ? {
              code: machine.currentState.lastError.code,
              message: machine.currentState.lastError.message,
            }
          : null,
        sessionId: machine.currentState.sessionId,
      };
    }

    case 'TEST_CONNECTION': {
      // 从 storage 读取 API Key 进行测试连接
      try {
        const config = await chrome.storage.local.get(['hero_sms.api_key']);
        const apiKey = (config['hero_sms.api_key'] as string) || '';
        const { handleTestConnection } = await import('../lib/handlers/test-connection');
        return await handleTestConnection(apiKey);
      } catch {
        return { status: 'error', message: '测试连接处理器加载失败' };
      }
    }

    default:
      return { status: 'ok' };
  }
}

// ---------------------------------------------------------------------------
// chrome.notifications.onButtonClicked — 通知按钮事件转发到状态机
// ---------------------------------------------------------------------------

chrome.notifications.onButtonClicked.addListener(
  (notificationId: string, buttonIndex: number) => {
    console.log('[Background] 通知按钮点击:', notificationId, buttonIndex);
    machine.handleNotificationButton(notificationId, buttonIndex).catch((err) => {
      console.error('[Background] 通知按钮处理错误:', err);
    });
  },
);

// ---------------------------------------------------------------------------
// chrome.alarms.onAlarm — 验证码轮询转发到状态机
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm: chrome.alarms.Alarm) => {
  machine.handleAlarm(alarm).catch((err) => {
    console.error('[Background] Alarm 处理错误:', err);
  });
});

// ---------------------------------------------------------------------------
// chrome.runtime.onStartup / onInstalled — Service Worker 恢复
// ---------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(() => {
  console.log('[Background] Service Worker 启动，恢复状态...');
  machine.recover().catch((err) => {
    console.error('[Background] 状态恢复错误:', err);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Background] 扩展已安装/更新');
  machine.recover().catch((err) => {
    console.error('[Background] 状态恢复错误:', err);
  });
});

export default defineBackground(() => {
  // WXT defineBackground 生命周期钩子
  // Provider 注册、监听器注册已在模块顶层完成
  console.log('[Background] SMS Code Autofill Service Worker 已就绪');
});
