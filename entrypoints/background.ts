/**
 * Service Worker 入口
 *
 * 注册 Provider、创建状态机、设置消息监听、初始化存储默认值。
 * 状态机是整个扩展的核心协调者，所有组件通过 storage.session 同步状态。
 */
import { defineBackground } from 'wxt/sandbox';
import { HeroSmsProvider, ProviderRegistry } from '../lib/providers';
import type { ProviderConfig } from '../lib/providers';
import { RetryPhase, RetryStateMachine } from '../lib/state-machine';
import { handleBlinkAlarm } from '../lib/badge';
import { TypedError } from '../lib/providers/types';
import { CircuitBreaker, DEFAULT_CIRCUIT_CONFIG } from '../lib/circuit-breaker';
import type { CircuitErrorType } from '../lib/circuit-breaker';

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

let machine = new RetryStateMachine(dummyProvider, new CircuitBreaker({
  ...DEFAULT_CIRCUIT_CONFIG,
}));

/** Content Script 上报的页面结构错误，换号无法恢复，必须保留错误码交给状态机停止流程 */
const FORM_ERROR_CODES = new Set([
  'FORM_STRUCTURE_CHANGED',
  'SELECTOR_NOT_FOUND',
  'COUNTRY_DROPDOWN_NOT_FOUND',
  'PHONE_INPUT_NOT_FOUND',
  'CONTENT_SCRIPT_UNAVAILABLE',
]);

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

    case 'POPUP_CONFIRM': {
      const action = msg.action === 'continue' ? 'continue' : 'stop';
      console.log('[Background] POPUP_CONFIRM:', action);
      await machine.handleUserConfirmation(action);
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
          ? { code: machine.currentState.lastError.code, message: machine.currentState.lastError.message }
          : null,
        sessionId: machine.currentState.sessionId,
      };
    }

    case 'TEST_CONNECTION': {
      try {
        const msgApiKey = (msg.apiKey as string) || '';
        const config = await chrome.storage.local.get(['hero_sms.api_key']);
        const apiKey = msgApiKey || (config['hero_sms.api_key'] as string) || '';
        const { handleTestConnection } = await import('../lib/handlers/test-connection');
        return await handleTestConnection(apiKey, {
          country: typeof msg.country === 'string' ? msg.country : undefined,
          service: typeof msg.service === 'string' ? msg.service : undefined,
          maxPrice: typeof msg.maxPrice === 'number' ? msg.maxPrice : undefined,
        });
      } catch {
        return { status: 'error', message: '测试连接处理器加载失败' };
      }
    }

    // Content Script 反馈：手机号已填入
    case 'C2B_PHONE_FILLED': {
      if (!isAcceptingFillFeedback()) {
        console.log('[Background] 忽略非填号阶段的手机号填入反馈:', machine.currentState.phase);
        return { status: 'ignored' };
      }
      const success = Boolean(msg.success);
      if (success) {
        machine.transition({ type: 'phoneFilled' }).catch((e) => console.warn('[Background] phoneFilled 转换失败:', e));
      } else {
        const err = new TypedError('PROVIDER', 'FILL_FAILED', String(msg.error || '填入失败'), true);
        machine.transition({ type: 'fillFailed', error: err }).catch((e) => console.warn('[Background] fillFailed 转换失败:', e));
      }
      return { status: 'ok' };
    }

    // Content Script 反馈：手机号被 OpenAI 拒绝
    case 'C2B_PHONE_REJECTED': {
      if (!isAcceptingFillFeedback()) {
        console.log('[Background] 忽略非填号阶段的手机号拒绝反馈:', machine.currentState.phase);
        return { status: 'ignored' };
      }
      const err = createPhoneRejectedError(msg.reason);
      machine.transition({ type: 'phoneRejected', error: err }).catch((e) => console.warn('[Background] phoneRejected 转换失败:', e));
      return { status: 'ok' };
    }

    // Content Script 反馈：验证码检测到（仅记录，状态机轮询 HeroSMS 获取验证码）
    case 'C2B_CODE_DETECTED':
      return { status: 'ok' };

    // Content Script 反馈：页面就绪 → 若 flow 已启用则自动启动
    case 'C2B_PAGE_READY':
      machine.onPageReady().catch((e) => console.warn('[Background] onPageReady 错误:', e));
      return { status: 'ok' };

    case 'C2B_PAGE_CLOSED':
      machine.stop().catch((e) => console.warn('[Background] stop 失败:', e));
      return { status: 'ok' };

    default:
      return { status: 'ok' };
  }
}

/** 将 Content Script 的拒绝原因转换为状态机可识别的错误码 */
function createPhoneRejectedError(reasonValue: unknown): TypedError {
  const reason = String(reasonValue || '号码被目标网站拒绝');
  const code = FORM_ERROR_CODES.has(reason) ? reason : 'PHONE_REJECTED';
  const message = reason === 'PHONE_REJECTED_BY_OPENAI'
    ? '无法向此电话号码发送验证码。请稍后重试或使用其他号码。'
    : reason;
  return new TypedError('PROVIDER', code, message, true);
}

/** Content Script 的填号结果只允许在 FILL_PHONE 阶段驱动状态机 */
function isAcceptingFillFeedback(): boolean {
  return machine.currentState.phase === RetryPhase.FILL_PHONE;
}

/** 使用最新配置重建断路器，避免连续拒号时无保护地消耗号码 */
async function recoverMachine(): Promise<void> {
  const config = await chrome.storage.local.get([
    'circuit.enabled',
    'circuit.threshold_voip',
    'circuit.threshold_timeout',
  ]);
  const circuitBreaker = new CircuitBreaker({
    ...DEFAULT_CIRCUIT_CONFIG,
    enabled: config['circuit.enabled'] !== false,
    thresholds: {
      ...DEFAULT_CIRCUIT_CONFIG.thresholds,
      ['VOIP_REJECTED' as CircuitErrorType]: Number(config['circuit.threshold_voip'] ?? 2),
      ['PROVIDER_TIMEOUT' as CircuitErrorType]: Number(config['circuit.threshold_timeout'] ?? 5),
    },
  });
  machine = new RetryStateMachine(dummyProvider, circuitBreaker);
  await machine.recover();
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
  // Badge 闪烁 alarm —— 独立处理
  if (alarm.name === 'badge_blink') {
    handleBlinkAlarm().catch((err) => {
      console.error('[Background] Badge 闪烁错误:', err);
    });
    return;
  }

  // 填入超时 alarm —— Content Script 无响应时兜底
  if (alarm.name.startsWith('fill_timeout_')) {
    console.warn('[Background] 填入超时——Content Script 未反馈，自动推进');
    machine.handleFillTimeout().catch((err) => {
      console.error('[Background] 填入超时处理错误:', err);
    });
    return;
  }

  // 验证码轮询 alarm —— 转发到状态机
  machine.handleAlarm(alarm).catch((err) => {
    console.error('[Background] Alarm 处理错误:', err);
  });
});

// ---------------------------------------------------------------------------
// chrome.runtime.onStartup / onInstalled — Service Worker 恢复
// ---------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(() => {
  console.log('[Background] Service Worker 启动，恢复状态...');
  recoverMachine().catch((err) => {
    console.error('[Background] 状态恢复错误:', err);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Background] 扩展已安装/更新');
  recoverMachine().catch((err) => {
    console.error('[Background] 状态恢复错误:', err);
  });
});

export default defineBackground(() => {
  // WXT defineBackground 生命周期钩子
  // Provider 注册、监听器注册已在模块顶层完成
  console.log('[Background] SMS Code Autofill Service Worker 已就绪');
  recoverMachine().catch((err) => {
    console.error('[Background] 状态恢复错误:', err);
  });
});
