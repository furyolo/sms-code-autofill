import { h } from 'preact';
import htm from 'htm';
import { useState, useEffect, useCallback } from 'preact/hooks';

const html = htm.bind(h);

// ---------------------------------------------------------------------------
// 类型定义
// PopupPhase: 5 种交互状态（IDLE / RUNNING / AWAIT_CONFIRM / ERROR / DONE）
// ---------------------------------------------------------------------------

/** 5 种交互状态枚举，从 9 种 RetryPhase 归并 */
type PopupPhase = 'IDLE' | 'RUNNING' | 'AWAIT_CONFIRM' | 'ERROR' | 'DONE';

/** 运行时 Popup 展示状态 */
interface PopupState {
  originalPhase: string;
  statusText: string;
  dotColor: string;
  toggleOn: boolean;
}

/** chrome.storage.session 中 retry_state 的反序列化形状（部分字段） */
interface RetryStateData {
  phase: string;
  attemptInBucket: number;
  bucketSize: number;
  totalAttempts: number;
  lastError?: { code?: string; message?: string } | null;
}

// ---------------------------------------------------------------------------
// RetryPhase → PopupPhase 映射
// ---------------------------------------------------------------------------

/**
 * 将 9 种 RetryPhase 归并为 5 种 PopupPhase
 */
function retryPhaseToPopupPhase(rp: string): PopupPhase {
  switch (rp) {
    case 'IDLE':
    case 'STOPPED':
      return 'IDLE';
    case 'GET_PHONE':
    case 'FILL_PHONE':
    case 'WAIT_CODE':
    case 'REJECTED':
      return 'RUNNING';
    case 'BUCKET_EXHAUSTED':
    case 'AWAIT_CONFIRM':
      return 'AWAIT_CONFIRM';
    case 'DONE':
      return 'DONE';
    default:
      return 'ERROR';
  }
}

// ---------------------------------------------------------------------------
// 状态推导辅助
// ---------------------------------------------------------------------------

/** 根据原始数据计算 StatusDot 颜色 */
function getStatusDotColor(phase: string): string {
  switch (phase) {
    case 'IDLE':
    case 'STOPPED':
      return '#71717a'; // gray
    case 'GET_PHONE':
    case 'FILL_PHONE':
    case 'WAIT_CODE':
      return '#3b82f6'; // blue
    case 'REJECTED':
      return '#f97316'; // orange
    case 'BUCKET_EXHAUSTED':
    case 'AWAIT_CONFIRM':
      return '#ef4444'; // red
    case 'DONE':
      return '#22c55e'; // green
    default:
      return '#ef4444'; // red (error default)
  }
}

/** 根据原始状态推导 StatusText 动态文本 */
function getStatusText(raw: RetryStateData): string {
  const { phase, attemptInBucket, bucketSize, totalAttempts, lastError } = raw;

  switch (phase) {
    case 'IDLE':
      return '就绪';
    case 'GET_PHONE':
    case 'FILL_PHONE':
      return '获取号码中...';
    case 'WAIT_CODE':
      return '等待验证码...';
    case 'REJECTED':
      return lastError?.message
        ? `重试中 (${attemptInBucket}/${bucketSize})：${lastError.message}`
        : `重试中 (${attemptInBucket}/${bucketSize})`;
    case 'BUCKET_EXHAUSTED':
    case 'AWAIT_CONFIRM':
      return lastError?.message ? `等待确认：${lastError.message}` : '等待确认';
    case 'DONE':
      return `验证码已填入`;
    case 'STOPPED':
      if (lastError?.code === 'TARGET_PAGE_MISSING') {
        return lastError.message || '等待目标页面...';
      }
      return lastError?.message ? `已停止：${lastError.message}` : '已停止';
    default:
      return lastError?.message || '未知错误';
  }
}

/** 判断 Toggle 是否应为 ON */
function isToggleOn(phase: string): boolean {
  switch (phase) {
    case 'GET_PHONE':
    case 'FILL_PHONE':
    case 'WAIT_CODE':
    case 'REJECTED':
    case 'BUCKET_EXHAUSTED':
    case 'AWAIT_CONFIRM':
      return true;
    default:
      return false;
  }
}

function shouldKeepToggleOn(raw: RetryStateData): boolean {
  return isToggleOn(raw.phase) || raw.lastError?.code === 'TARGET_PAGE_MISSING';
}

/** 判断当前是否需要用户在 Popup 中确认继续或停止 */
function needsUserConfirmation(phase: string): boolean {
  return phase === 'AWAIT_CONFIRM' || phase === 'BUCKET_EXHAUSTED';
}

/** 从原始 retry_state 数据计算 PopupState */
function computePopupState(raw: RetryStateData | null): PopupState {
  if (!raw) {
    return {
      originalPhase: 'IDLE',
      statusText: '就绪',
      dotColor: '#71717a',
      toggleOn: false,
    };
  }

  const phase = raw.phase || 'IDLE';
  return {
    originalPhase: phase,
    statusText: getStatusText(raw),
    dotColor: getStatusDotColor(phase),
    toggleOn: shouldKeepToggleOn(raw),
  };
}

// ---------------------------------------------------------------------------
// 主组件 PopupDashboard
// ---------------------------------------------------------------------------

export default function App() {
  const [popupState, setPopupState] = useState<PopupState>({
    originalPhase: 'IDLE',
    statusText: '加载中...',
    dotColor: '#71717a',
    toggleOn: false,
  });

  // 初始终身读取 + 注册 storage 监听
  useEffect(() => {
    let mounted = true;

    // 初始读取
    const init = async () => {
      try {
        const result = await chrome.storage.session.get('retry_state');
        const raw = result['retry_state'] as RetryStateData | undefined;
        if (mounted) {
          setPopupState(computePopupState(raw ?? null));
        }
      } catch {
        if (mounted) {
          setPopupState(computePopupState(null));
        }
      }
    };

    init();

    // storage.session.onChanged 监听（session 区单参数回调）
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
    ) => {
      if (changes['retry_state']) {
        const raw = changes['retry_state'].newValue as RetryStateData | undefined;
        if (mounted) {
          setPopupState(computePopupState(raw ?? null));
        }
      }
    };

    chrome.storage.session.onChanged.addListener(listener);

    return () => {
      mounted = false;
      chrome.storage.session.onChanged.removeListener(listener);
    };
  }, []);

  // Toggle 点击处理
  const handleToggle = useCallback(() => {
    const newEnabled = !popupState.toggleOn;
    chrome.runtime.sendMessage({
      type: 'POPUP_TOGGLE',
      enabled: newEnabled,
    }).catch((err) => {
      console.warn('[Popup] Toggle 消息发送失败:', err);
    });
  }, [popupState.toggleOn]);

  // 等待确认时的继续 / 停止处理
  const handleConfirm = useCallback((action: 'continue' | 'stop') => {
    chrome.runtime.sendMessage({
      type: 'POPUP_CONFIRM',
      action,
    }).catch((err) => {
      console.warn('[Popup] 确认消息发送失败:', err);
    });
  }, []);

  // 齿轮跳转 Options
  const handleOpenOptions = useCallback(() => {
    chrome.runtime.openOptionsPage();
  }, []);

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  const gearIcon = html`
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  `;

  return html`
    <div class="popup-container">
      <!-- Header: AppTitle + GearButton -->
      <div class="popup-header">
        <span class="popup-app-title">SMS Autofill</span>
        <button
          class="popup-gear-btn"
          onClick=${handleOpenOptions}
          title="设置"
          type="button"
        >
          ${gearIcon}
        </button>
      </div>

      <!-- MainControl: Toggle 开关 -->
      <div class="popup-control-area">
        <button
          class=${`popup-toggle ${popupState.toggleOn ? 'popup-toggle--on' : ''}`}
          role="switch"
          aria-checked=${popupState.toggleOn}
          onClick=${handleToggle}
          type="button"
        >
          <span class="popup-toggle__knob" />
        </button>
      </div>

      <!-- StatusBar: StatusDot + StatusText -->
      <div class="popup-status-bar">
        <span
          class="popup-status-dot"
          style=${{ background: popupState.dotColor }}
        />
        <span class="popup-status-text">${popupState.statusText}</span>
      </div>

      ${needsUserConfirmation(popupState.originalPhase) && html`
        <div class="popup-confirm-actions">
          <button
            class="popup-confirm-btn popup-confirm-btn--primary"
            onClick=${() => handleConfirm('continue')}
            type="button"
          >
            继续
          </button>
          <button
            class="popup-confirm-btn"
            onClick=${() => handleConfirm('stop')}
            type="button"
          >
            停止
          </button>
        </div>
      `}
    </div>
  `;
}
