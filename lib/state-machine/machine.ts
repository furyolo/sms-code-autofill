/**
 * 重试状态机——扩展的核心协调者
 *
 * 管理从号码获取到验证码填入的完整生命周期。
 * 纯函数式转换 (RetryState, Event) → RetryState，每次转换即时持久化。
 * Bucket(10)×3 轮分组重试，暂停关卡自动 cancelActivation + 通知确认。
 */
import type { BaseSmsProvider } from '../providers/base-provider';
import type { ProviderConfig } from '../providers/types';
import { ProviderRegistry } from '../providers/registry';
import { TypedError } from '../providers/types';
import {
  RetryPhase,
  RetryState,
  StateEvent,
  CircuitBreaker,
} from './types';
import { AsyncLock } from './async-lock';
import {
  buildBucketPauseNotification,
  buildCircuitBreakerPauseNotification,
  buildStopSummaryNotification,
  buildSuccessNotification,
  buildSilentBucketTransitionNotification,
  createNotification,
  dismissNotification,
} from './notifications';
import { saveState, loadState, recoverState } from './persistence';
import {
  updateBadge,
  startBadgeBlink,
  stopBadgeBlink,
  sendRecoverySignal,
} from '../badge';
import { CircuitErrorType, classifyError } from '../circuit-breaker';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 重试前延迟（避免 API 冲击） */
const RETRY_DELAY_MS = 1000;

/** DONE 后自动恢复到 IDLE 的延迟 */
const DONE_IDLE_DELAY_MS = 5000;

/** STOPPED 后自动恢复到 IDLE 的延迟 */
const STOPPED_IDLE_DELAY_MS = 3000;

/** 静默通知自动消失延迟 */
const SILENT_NOTIFICATION_DELAY_MS = 3000;

/** 恢复锚定信号 Badge 切换间隔 */
const ANCHOR_BLINK_INTERVAL_MS = 250;

/** poll alarm 名前缀 */
const POLL_ALARM_PREFIX = 'poll_';
/** 填入超时 alarm 名前缀 */
const FILL_TIMEOUT_PREFIX = 'fill_timeout_';
/** Content Script 填入反馈最大等待时间 */
const FILL_TIMEOUT_MS = 15000;

/** storage.local 中的配置 key */
const CONFIG_KEYS = [
  'hero_sms.api_key',
  'hero_sms.country',
  'hero_sms.service',
  'hero_sms.max_price',
  'hero_sms.auto_country',
  'hero_sms.auto_country_min_stock',
  'hero_sms.auto_country_max_price',
  'hero_sms.reuse_phone_to_max',
  'hero_sms.phone_extra_max',
  'retry.bucket_size',
  'retry.max_buckets',
  'polling.interval',
  'polling.timeout',
  'circuit.enabled',
  'circuit.threshold_voip',
  'circuit.threshold_timeout',
  'pause_mode',
];

/** HeroSMS 国家列表缓存有效期，避免每次重试都请求国家元数据。 */
const HERO_COUNTRIES_CACHE_TTL_MS = 60 * 60 * 1000;
const HERO_COUNTRIES_URL = 'https://hero-sms.com/stubs/handler_api.php?action=getCountries';

interface HeroCountryInfo {
  id: string;
  eng?: string;
  chn?: string;
}

let heroCountriesCache: { expiresAt: number; countries: Map<string, HeroCountryInfo> } | null = null;

/** HeroSMS 与 OpenAI 国家列表名称不一致的常用别名。 */
const HERO_COUNTRY_TO_TARGET_NAMES: Record<string, string[]> = {
  '187': ['United States', 'USA', '美国'],
  '16': ['United Kingdom', '英国', '英格兰'],
  '22': ['India', '印度'],
  '175': ['Australia', '澳大利亚'],
  '27': ['Ivory Coast', "Cote d'Ivoire", '科特迪瓦', '象牙海岸'],
  '18': ['DR Congo', 'Congo', '刚果（金）', '刚果'],
  '63': ['Czech Republic', 'Czech', '捷克', '捷克共和国'],
  '78': ['France', '法国', '法國'],
  '95': ['United Arab Emirates', 'UAE', '阿拉伯联合酋长国'],
  '128': ['Georgia', '格鲁吉亚', '佐治亚'],
};

// ---------------------------------------------------------------------------
// RetryStateMachine
// ---------------------------------------------------------------------------

export class RetryStateMachine {
  private provider: BaseSmsProvider;
  private circuitBreaker: CircuitBreaker | null;
  private state: RetryState;
  private lock: AsyncLock;
  private service: string;
  private country: string;
  private countryNames: string[] | null;
  private destroying = false;

  constructor(provider: BaseSmsProvider, circuitBreaker: CircuitBreaker | null = null) {
    this.provider = provider;
    this.circuitBreaker = circuitBreaker;
    this.lock = new AsyncLock();
    this.service = 'dr';
    this.country = '187';
    this.countryNames = null;
    this.state = this.createInitialState();
  }

  // -------------------------------------------------------------------------
  // 公开 API
  // -------------------------------------------------------------------------

  /** 获取当前状态快照（只读） */
  get currentState(): Readonly<RetryState> {
    return this.state;
  }

  /**
   * 启动状态机
   * 先检查是否在目标页面，不在则仅设置 flow_enabled 标记，等待 Content Script 触发
   */
  async start(): Promise<void> {
    if (this.state.phase !== RetryPhase.IDLE && this.state.phase !== RetryPhase.STOPPED) {
      console.warn('[StateMachine] 状态机已在运行中，忽略重复 start');
      return;
    }

    // 检查是否在目标页面
    const onTargetPage = await this.isOnTargetPage();
    if (!onTargetPage) {
      console.log('[StateMachine] 不在目标页面，等待用户导航到 auth.openai.com/add-phone');
      await this.setFlowEnabled(true);
      await this.writeStoppedState(
        new TypedError('PROVIDER', 'TARGET_PAGE_MISSING', '未找到 OpenAI 手机号页面，已等待目标页面就绪', true)
      );
      return;
    }

    await this.doStart();
  }

  /**
   * Content Script 检测到目标页面时调用
   * 若 flow_enabled 为 true，自动启动
   */
  async onPageReady(): Promise<void> {
    const enabled = await this.isFlowEnabled();
    if (!enabled) {
      console.log('[StateMachine] 页面就绪但 flow 未启用，等待用户开启');
      return;
    }
    if (this.state.phase !== RetryPhase.IDLE && this.state.phase !== RetryPhase.STOPPED) {
      console.log('[StateMachine] 已在运行中，忽略 pageReady');
      return;
    }
    if (!(await this.isOnTargetPage())) {
      console.log('[StateMachine] auth.openai.com 页面就绪，但还不是手机号页面，继续等待');
      return;
    }
    console.log('[StateMachine] 页面就绪 + flow 已启用，自动启动');
    await this.doStart();
  }

  /** 实际启动逻辑 */
  private async doStart(): Promise<void> {
    // 读取配置
    const config = await chrome.storage.local.get(CONFIG_KEYS);

    // 检查 API Key
    const apiKey = config['hero_sms.api_key'] || '';
    if (!apiKey.trim()) {
      console.warn('[StateMachine] 未配置 API Key，无法启动');
      await this.setFlowEnabled(false);
      await this.writeStoppedState(new TypedError('AUTH', 'API_KEY_MISSING', '未配置 HeroSMS API Key，无法启动', false));
      return;
    }

    this.service = config['hero_sms.service'] || 'dr';
    this.country = config['hero_sms.country'] || '187';

    // 重新创建 provider（确保使用最新 API Key）
    try {
      const providerConfig: ProviderConfig = {
        apiKey,
        country: this.country,
        service: this.service,
        maxPrice: config['hero_sms.max_price'] ?? -1,
        reusePhoneToMax: config['hero_sms.reuse_phone_to_max'] === true,
        phoneSuccessMax: config['hero_sms.phone_extra_max'] ?? 3,
      };
      this.provider = ProviderRegistry.create('herosms', providerConfig);
    } catch {
      console.warn('[StateMachine] 创建 Provider 失败，使用已有实例');
    }

    const bucketSize = config['retry.bucket_size'] || 10;
    const maxBuckets = config['retry.max_buckets'] || 3;
    const pollIntervalSec = config['polling.interval'] || 5;
    const requestTimeoutSec = config['polling.timeout'] || 120;
    const pauseMode = config['pause_mode'] === 'circuit_only' ? 'circuit_only' : 'bucket_and_circuit';

    this.state = {
      phase: RetryPhase.IDLE,
      sessionId: crypto.randomUUID(),
      currentBucket: 1,
      attemptInBucket: 0,
      totalAttempts: 0,
      maxBuckets,
      bucketSize,
      currentActivationId: null,
      currentPhoneNumber: null,
      currentActivationCountry: null,
      lastError: null,
      startedAt: Date.now(),
      lastTransitionAt: Date.now(),
      notificationId: null,
      usedCodes: new Set(),
      attemptedSmsKeys: new Set(),
      firstResendDone: false,
      lastResendAt: 0,
      pauseMode,
      costPerAttempt: 0.05,
      pollInterval: pollIntervalSec * 1000,
      requestTimeout: requestTimeoutSec * 1000,
    };

    await saveState(this.state);
    await this.setFlowEnabled(true);
    console.log('[StateMachine] 启动，sessionId:', this.state.sessionId);

    await this.transition({ type: 'start' });
  }

  /**
   * 停止状态机
   */
  async stop(): Promise<void> {
    // 始终清除 flow_enabled 标记
    await this.setFlowEnabled(false);

    if (
      this.state.phase === RetryPhase.IDLE ||
      this.state.phase === RetryPhase.STOPPED
    ) {
      return;
    }

    console.log('[StateMachine] 用户请求停止');
    await this.transition({ type: 'userStop' });
  }

  /**
   * 处理状态转换事件
   * 1. 纯函数计算新状态
   * 2. 保存到 storage.session
   * 3. 执行副作用
   * 4. 更新 Badge
   */
  async transition(event: StateEvent): Promise<RetryState> {
    const prevPhase = this.state.phase;

    // 1. 纯函数转换
    const computed = this.pureTransition(this.state, event);
    this.state = computed;

    // 2. 持久化
    await saveState(this.state);

    console.log(
      `[StateMachine] ${prevPhase} --(${event.type})--> ${computed.phase}`,
      `bucket=${computed.currentBucket}/${computed.maxBuckets} attempt=${computed.attemptInBucket}/${computed.bucketSize} total=${computed.totalAttempts}`,
    );

    // 3. 闪烁管理：进入 AWAIT_CONFIRM 时启动，离开时停止
    if (computed.phase === RetryPhase.AWAIT_CONFIRM && prevPhase !== RetryPhase.AWAIT_CONFIRM) {
      await startBadgeBlink();
    }
    if (prevPhase === RetryPhase.AWAIT_CONFIRM && computed.phase !== RetryPhase.AWAIT_CONFIRM) {
      await stopBadgeBlink();
    }

    // 4. 执行副作用（根据新 phase）
    await this.executeSideEffects(this.state, event);

    // 5. 恢复锚定信号：userContinue 时 500ms 内 2 次 Badge 切换
    if (event.type === 'userContinue') {
      await sendRecoverySignal(this.state);
    }

    // 6. 更新 Badge
    await updateBadge(this.state);

    return this.state;
  }

  /**
   * Content Script 填入超时兜底处理
   * 当 Content Script 15s 内无反馈时，保守地假定填入成功继续流程
   */
  async handleFillTimeout(): Promise<void> {
    if (this.state.phase !== RetryPhase.FILL_PHONE) return;
    console.warn('[StateMachine] 填入超时，自动推进到 WAIT_CODE');
    await this.clearFillTimeoutAlarm();
    await this.transition({ type: 'phoneFilled' });
  }

  /**
   * 处理通知按钮点击
   */
  async handleNotificationButton(notificationId: string, buttonIndex: number): Promise<void> {
    if (notificationId !== this.state.notificationId) return;

    await this.handleUserConfirmation(buttonIndex === 0 ? 'continue' : 'stop');
  }

  /**
   * 处理用户确认操作（通知按钮或 Popup 按钮）
   */
  async handleUserConfirmation(action: 'continue' | 'stop'): Promise<void> {
    if (
      this.state.phase !== RetryPhase.AWAIT_CONFIRM &&
      this.state.phase !== RetryPhase.BUCKET_EXHAUSTED
    ) {
      return;
    }

    if (this.state.notificationId) {
      try {
        await dismissNotification(this.state.notificationId);
      } catch {
        // 通知关闭失败不影响状态转换
      }
      this.state.notificationId = null;
      await saveState(this.state);
    }

    if (action === 'continue') {
      await this.transition({ type: 'userContinue' });
    } else {
      await this.transition({ type: 'userStop' });
    }
  }

  /**
   * 处理 chrome.alarms 轮询
   */
  async handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
    if (!alarm.name.startsWith(POLL_ALARM_PREFIX)) return;

    const activationId = alarm.name.slice(POLL_ALARM_PREFIX.length);
    if (
      this.state.phase !== RetryPhase.WAIT_CODE ||
      this.state.currentActivationId !== activationId
    ) {
      return;
    }

    // 检查超时
    const elapsed = Date.now() - this.state.startedAt;
    if (elapsed >= this.state.requestTimeout) {
      console.log('[StateMachine] WAIT_CODE 超时');
      await this.transition({ type: 'codeTimeout' });
      return;
    }

    // 轮询验证码
    try {
      const code = await this.provider.getCode(activationId);
      if (code) {
        console.log('[StateMachine] 收到验证码:', code);
        await this.transition({ type: 'codeReceived', code });
        return;
      }
    } catch (error) {
      console.warn('[StateMachine] getCode 错误:', error);
      // 单次轮询失败不中断，继续等待
    }

    // 未完成，重新调度 poll alarm
    await this.schedulePoll(activationId);
  }

  /**
   * SW 恢复入口
   */
  async recover(): Promise<void> {
    const saved = await loadState();
    if (!saved) return;

    this.state = saved;
    console.log('[StateMachine] 恢复状态:', saved.phase);

    await recoverState(this.state, async (event) => {
      await this.transition(event);
    });

    // 恢复 Badge
    await updateBadge(this.state);
  }

  /** 销毁状态机，清理资源 */
  async destroy(): Promise<void> {
    this.destroying = true;
    this.lock.release();
    await this.clearPollAlarm();
  }

  // -------------------------------------------------------------------------
  // 纯函数转换（无副作用）
  // StateTransition = (RetryState, StateEvent) => RetryState
  // -------------------------------------------------------------------------

  private pureTransition(state: RetryState, event: StateEvent): RetryState {
    const base = { ...state, lastTransitionAt: Date.now() };

    switch (event.type) {
      case 'start':
        return {
          ...base,
          phase: RetryPhase.GET_PHONE,
          startedAt: Date.now(),
          currentBucket: 1,
          attemptInBucket: 0,
          totalAttempts: 0,
          lastError: null,
          currentActivationId: null,
          currentPhoneNumber: null,
          currentActivationCountry: null,
        };

      case 'phoneAcquired':
        return {
          ...base,
          phase: RetryPhase.FILL_PHONE,
          currentActivationId: event.activation.activationId,
          currentPhoneNumber: event.activation.phoneNumber,
          currentActivationCountry: event.activation.country || this.country,
          totalAttempts: state.totalAttempts + 1,
          attemptInBucket: state.attemptInBucket + 1,
          lastError: null,
        };

      case 'phoneFailed':
        return {
          ...base,
          phase: RetryPhase.REJECTED,
          lastError: event.error,
          attemptInBucket: state.attemptInBucket + 1,
          totalAttempts: state.totalAttempts + 1,
        };

      case 'phoneFilled':
        return {
          ...base,
          phase: RetryPhase.WAIT_CODE,
          startedAt: Date.now(),
        };

      case 'fillFailed':
        // SELECTOR_NOT_FOUND 等页面预检 / 结构性错误不可恢复——换号无意义，直接停止
        if (
          event.error &&
          this.isUnrecoverableFormError(event.error.code)
        ) {
          return {
            ...base,
            phase: RetryPhase.STOPPED,
            lastError: event.error,
          };
        }
        return {
          ...base,
          phase: RetryPhase.REJECTED,
          lastError: event.error,
        };

      case 'codeReceived': {
        const updatedCodes = new Set(state.usedCodes);
        updatedCodes.add(event.code);
        return {
          ...base,
          phase: RetryPhase.DONE,
          usedCodes: updatedCodes,
          lastError: null,
        };
      }

      case 'codeTimeout':
        return {
          ...base,
          phase: RetryPhase.REJECTED,
          lastError: new TypedError('PROVIDER', 'CODE_TIMEOUT', '等待验证码超时', true),
        };

      case 'phoneRejected':
        // FORM_STRUCTURE_CHANGED 等页面结构错误不可恢复——换号无意义，直接停止
        if (event.error && this.isUnrecoverableFormError(event.error.code)) {
          return {
            ...base,
            phase: RetryPhase.STOPPED,
            lastError: event.error,
          };
        }
        return {
          ...base,
          phase: RetryPhase.REJECTED,
          lastError: event.error,
        };

      case 'circuitBreakerTrip':
        return {
          ...base,
          phase: RetryPhase.BUCKET_EXHAUSTED,
          lastError: event.error,
        };

      case 'userContinue':
        return {
          ...base,
          phase: RetryPhase.GET_PHONE,
          currentBucket: state.currentBucket + 1,
          attemptInBucket: 0,
          lastError: null,
          notificationId: null,
        };

      case 'userStop':
        return {
          ...base,
          phase: RetryPhase.STOPPED,
        };

      case 'maxRetriesExhausted':
        return {
          ...base,
          phase: RetryPhase.STOPPED,
          lastError: new TypedError('PROVIDER', 'MAX_RETRIES', '已达到最大重试次数', false),
        };

      default:
        console.warn('[StateMachine] 未知事件类型:', (event as StateEvent).type);
        return base;
    }
  }

  // -------------------------------------------------------------------------
  // 副作用执行
  // -------------------------------------------------------------------------

  private async executeSideEffects(state: RetryState, event: StateEvent): Promise<void> {
    // 离开 FILL_PHONE 时清除填入超时 alarm
    if (state.phase !== RetryPhase.FILL_PHONE) {
      await this.clearFillTimeoutAlarm();
    }

    switch (state.phase) {
      case RetryPhase.GET_PHONE:
        await this.handleGetPhone(state, event);
        break;

      case RetryPhase.FILL_PHONE:
        await this.handleFillPhone(state);
        break;

      case RetryPhase.WAIT_CODE:
        await this.handleWaitCode(state);
        break;

      case RetryPhase.REJECTED:
        await this.handleRejected(state, event);
        break;

      case RetryPhase.DONE:
        await this.handleDone(state);
        break;

      case RetryPhase.BUCKET_EXHAUSTED:
        await this.handleBucketExhausted(state, event);
        break;

      case RetryPhase.AWAIT_CONFIRM:
        // 等待用户交互，无自动副作用
        break;

      case RetryPhase.STOPPED:
        await this.handleStopped(state, event);
        break;

      default:
        break;
    }
  }

  /** GET_PHONE: 调用 provider.getNumber() */
  private async handleGetPhone(_state: RetryState, event: StateEvent): Promise<void> {
    // 仅从 IDLE→GET_PHONE 或 AWAIT_CONFIRM→GET_PHONE 时获取号码
    // 避免 REJECTED→GET_PHONE 经过此处分叉时重复调用
    // 检查事件来源以确定是否需要获取号码
    const needsGetNumber =
      event.type === 'start' ||
      event.type === 'userContinue';

    if (!needsGetNumber) return;

    const runtimeConfigReady = await this.refreshRuntimeProviderConfig();
    if (!runtimeConfigReady) {
      await this.transition({
        type: 'phoneFailed',
        error: new TypedError('AUTH', 'API_KEY_MISSING', '未配置 HeroSMS API Key，无法获取号码', false),
      });
      return;
    }

    const preflight = await this.preflightPhoneForm();
    if (!preflight.ok) {
      await this.transition({
        type: 'fillFailed',
        error: new TypedError('PROVIDER', preflight.errorCode, preflight.message, false),
      });
      return;
    }

    // 并发锁
    const acquired = await this.lock.acquire();
    if (!acquired) {
      console.warn('[StateMachine] getNumber 锁获取超时');
      await this.transition({
        type: 'phoneFailed',
        error: new TypedError('NETWORK', 'LOCK_TIMEOUT', '获取号码锁超时', true, 5000),
      });
      return;
    }

    try {
      const activation = await this.provider.getNumber(this.service, this.country);
      this.lock.release();
      if (!(await this.isFlowActive())) {
        console.log('[StateMachine] getNumber 返回时流程已停止，丢弃号码');
        try {
          await this.provider.cancel(activation.activationId);
        } catch {
          console.warn('[StateMachine] 停止后取消新号码失败（忽略）');
        }
        return;
      }
      await this.transition({ type: 'phoneAcquired', activation });
    } catch (error) {
      this.lock.release();
      if (!(await this.isFlowActive())) {
        console.log('[StateMachine] getNumber 失败时流程已停止，忽略错误');
        return;
      }
      const typedError =
        error instanceof TypedError
          ? error
          : new TypedError('PROVIDER', 'UNKNOWN', String(error), true);
      console.warn('[StateMachine] getNumber 失败:', typedError.code, typedError.message);

      // 不可恢复错误直接停止
      if (!typedError.recoverable) {
        console.warn('[StateMachine] 不可恢复错误，停止:', typedError.code);
        await this.transition({ type: 'phoneFailed', error: typedError });
        return;
      }

      await this.transition({ type: 'phoneFailed', error: typedError });
    }
  }

  /** FILL_PHONE: 向 Content Script 发送填号指令 */
  private async handleFillPhone(state: RetryState): Promise<void> {
    // 发送 B2C_FILL_PHONE 到 Content Script
    let contentScriptAlive = false;
    try {
      const tab = await this.findTargetTab();
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'B2C_FILL_PHONE',
          phoneNumber: state.currentPhoneNumber,
          providerCountry: state.currentActivationCountry || this.country,
          providerCountryNames: this.countryNames,
        });
        contentScriptAlive = true;
      }
    } catch {
      console.warn('[StateMachine] Content Script 未注入或通信失败');
    }

    if (contentScriptAlive) {
      // 等待 Content Script 反馈（phoneFilled / fillFailed / phoneRejected）
      // 设置 15s 兜底超时：若 Content Script 无响应，自动按填入成功处理
      const fillTimeoutMs = FILL_TIMEOUT_MS;
      const alarmName = `fill_timeout_${state.sessionId}`;
      chrome.alarms.create(alarmName, { delayInMinutes: fillTimeoutMs / 60000 });
    } else {
      // Content Script 不可用时无法填号，继续等待验证码只会消耗号码，直接停止并暴露原因。
      console.warn('[StateMachine] Content Script 不可用，无法填入手机号');
      await this.transition({
        type: 'fillFailed',
        error: new TypedError('PROVIDER', 'CONTENT_SCRIPT_UNAVAILABLE', '页面未准备好：Content Script 未注入或目标页面不可用', false),
      });
    }
  }

  /** 获取号码前预检目标页面，确认页面具备国家切换和手机号输入能力 */
  private async preflightPhoneForm(): Promise<{ ok: true } | { ok: false; errorCode: string; message: string }> {
    try {
      const tab = await this.findTargetTab();
      if (!tab?.id) {
        return { ok: false, errorCode: 'FORM_STRUCTURE_CHANGED', message: '未找到目标页面标签页' };
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'B2C_PREFLIGHT_FORM',
        providerCountry: this.country,
        providerCountryNames: this.countryNames,
      });
      if (response && (response as { success?: boolean }).success === true) {
        return { ok: true };
      }

      const error = String((response as { error?: string } | undefined)?.error || 'FORM_STRUCTURE_CHANGED');
      return { ok: false, errorCode: error, message: this.describePreflightError(error) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, errorCode: 'CONTENT_SCRIPT_UNAVAILABLE', message: `Content Script 未注入或目标页面不可用：${message}` };
    }
  }

  /** 将 Content Script 预检错误转成可直接展示的原因。 */
  private describePreflightError(errorCode: string): string {
    switch (errorCode) {
      case 'COUNTRY_DROPDOWN_NOT_FOUND':
        return '页面未准备好：未找到国家下拉框';
      case 'PHONE_INPUT_NOT_FOUND':
        return '页面未准备好：未找到手机号输入框';
      case 'FORM_STRUCTURE_CHANGED':
        return '页面未准备好：表单结构已变化';
      case 'CONTENT_SCRIPT_UNAVAILABLE':
        return '页面未准备好：Content Script 未注入或目标页面不可用';
      default:
        return `页面未准备好：${errorCode}`;
    }
  }

  /** 页面结构 / 注入类错误靠换号无法恢复，应停止并让用户看到真实原因。 */
  private isUnrecoverableFormError(errorCode: string): boolean {
    return [
      'SELECTOR_NOT_FOUND',
      'FORM_STRUCTURE_CHANGED',
      'COUNTRY_DROPDOWN_NOT_FOUND',
      'PHONE_INPUT_NOT_FOUND',
      'CONTENT_SCRIPT_UNAVAILABLE',
    ].includes(errorCode);
  }

  /** 每次取号前刷新运行态 Provider 配置，确保 Options 中修改的国家立即参与页面预检。 */
  private async refreshRuntimeProviderConfig(): Promise<boolean> {
    const config = await chrome.storage.local.get(CONFIG_KEYS);
    const apiKey = String(config['hero_sms.api_key'] || '');
    if (!apiKey.trim()) {
      console.warn('[StateMachine] 未配置 API Key，无法刷新 Provider 配置');
      return false;
    }

    this.service = String(config['hero_sms.service'] || 'dr');
    this.country = String(config['hero_sms.country'] || '187');
    this.countryNames = await this.resolveHeroCountryNames(this.country);

    const providerConfig: ProviderConfig = {
      apiKey,
      country: this.country,
      service: this.service,
      maxPrice: Number(config['hero_sms.max_price'] ?? -1),
      reusePhoneToMax: config['hero_sms.reuse_phone_to_max'] === true,
      phoneSuccessMax: Number(config['hero_sms.phone_extra_max'] ?? 3),
    };
    this.provider = ProviderRegistry.create('herosms', providerConfig);

    console.log('[StateMachine] 已刷新运行态 Provider 配置:', {
      service: this.service,
      country: this.country,
      countryNames: this.countryNames,
    });
    return true;
  }

  /** 按 HeroSMS 国家 ID 解析国家名称，供 Content Script 匹配页面国家下拉项。 */
  private async resolveHeroCountryNames(country: string): Promise<string[] | null> {
    try {
      const countries = await this.loadHeroCountries();
      const info = countries.get(country);
      const aliasNames = HERO_COUNTRY_TO_TARGET_NAMES[country] || [];
      if (!info) {
        console.warn('[StateMachine] 未找到 HeroSMS 国家元数据:', country);
        return aliasNames.length > 0 ? aliasNames : null;
      }

      const names = [info.eng, info.chn, ...aliasNames]
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map((name) => name.trim());
      return names.length > 0 ? Array.from(new Set(names)) : null;
    } catch (error) {
      console.warn('[StateMachine] 获取 HeroSMS 国家元数据失败:', error);
      return HERO_COUNTRY_TO_TARGET_NAMES[country] || null;
    }
  }

  /** 加载并缓存 HeroSMS 国家列表。 */
  private async loadHeroCountries(): Promise<Map<string, HeroCountryInfo>> {
    if (heroCountriesCache && heroCountriesCache.expiresAt > Date.now()) {
      return heroCountriesCache.countries;
    }

    const response = await fetch(HERO_COUNTRIES_URL, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      throw new Error(`HeroSMS getCountries HTTP ${response.status}`);
    }

    const data = await response.json();
    const countries = new Map<string, HeroCountryInfo>();

    const appendCountry = (key: string, value: unknown) => {
      if (typeof value !== 'object' || value === null) return;
      const item = value as Record<string, unknown>;
      const id = String(item.id ?? key);
      if (!id) return;
      countries.set(id, {
        id,
        eng: typeof item.eng === 'string' ? item.eng : undefined,
        chn: typeof item.chn === 'string' ? item.chn : undefined,
      });
    };

    if (Array.isArray(data)) {
      data.forEach((item, index) => appendCountry(String(index), item));
    } else if (typeof data === 'object' && data !== null) {
      Object.entries(data as Record<string, unknown>)
        .filter(([key]) => !['status', 'message', 'data', 'error'].includes(key))
        .forEach(([key, value]) => appendCountry(key, value));
    }

    heroCountriesCache = {
      expiresAt: Date.now() + HERO_COUNTRIES_CACHE_TTL_MS,
      countries,
    };
    return countries;
  }

  /** WAIT_CODE: 注册 poll alarm */
  private async handleWaitCode(state: RetryState): Promise<void> {
    await this.clearPollAlarm();
    if (state.currentActivationId) {
      await this.schedulePoll(state.currentActivationId);
    }
  }

  /** REJECTED: 决策逻辑 */
  private async handleRejected(state: RetryState, event: StateEvent): Promise<void> {
    // 取消当前激活
    if (state.currentActivationId) {
      try {
        await this.provider.cancel(state.currentActivationId);
      } catch {
        console.warn('[StateMachine] cancelActivation 失败（忽略）');
      }
      // 清空引用
      state.currentActivationId = null;
      state.currentPhoneNumber = null;
      state.currentActivationCountry = null;
      await saveState(state);
    }

    if (!(await this.isFlowActive())) {
      console.log('[StateMachine] 拒绝处理期间流程已停止，取消后续重试决策');
      return;
    }

    const error =
      'error' in event
        ? (event as { error: TypedError }).error
        : new TypedError('PROVIDER', 'UNKNOWN', '未知错误', true);

    // 普通页面拒号应继续换号直到当前 Bucket 耗尽；断路器只保留给明确可分类的系统性问题。
    if (this.circuitBreaker && this.shouldUseCircuitBreaker(error)) {
      const errorType = classifyError(error);
      const result = this.circuitBreaker.recordError(errorType);
      if (result.tripped) {
        const info = {
          errorType: result.errorType,
          consecutiveCount: result.consecutiveCount,
          threshold: result.consecutiveCount,
        };
        console.log('[StateMachine] 断路器触发:', info);
        await this.transition({
          type: 'circuitBreakerTrip',
          error,
          info,
        });
        return;
      }
    }

    // 检查 Bucket 耗尽
    if (state.pauseMode === 'bucket_and_circuit') {
      if (state.attemptInBucket >= state.bucketSize) {
        if (state.currentBucket >= state.maxBuckets) {
          console.log('[StateMachine] 所有轮次耗尽');
          await this.transition({ type: 'maxRetriesExhausted' });
          return;
        }

        // → BUCKET_EXHAUSTED
        // 直接修改 phase 并触发 BUCKET_EXHAUSTED 副作用
        state.phase = RetryPhase.BUCKET_EXHAUSTED;
        await saveState(state);
        await this.executeSideEffects(state, event);
        return;
      }
    } else {
      // circuit_only: 静默过渡
      if (state.attemptInBucket >= state.bucketSize) {
        if (state.currentBucket >= state.maxBuckets) {
          console.log('[StateMachine] 所有轮次耗尽（仅断路器模式）');
          await this.transition({ type: 'maxRetriesExhausted' });
          return;
        }

        // 静默进入下一轮
        state.currentBucket += 1;
        state.attemptInBucket = 0;
        await saveState(state);

        // 发送静默通知
        try {
          const template = buildSilentBucketTransitionNotification(state.currentBucket - 1);
          const notifId = await createNotification(template);
          setTimeout(() => {
            dismissNotification(notifId).catch(() => {});
          }, SILENT_NOTIFICATION_DELAY_MS);
        } catch {
          // 通知非关键
        }

        // 直接进入 GET_PHONE
        if (!(await this.isFlowActive())) return;
        state.phase = RetryPhase.GET_PHONE;
        await saveState(state);
        await this.handleGetPhone(state, { type: 'start' });
        return;
      }
    }

    // 正常重试：延迟 1s 后进入 GET_PHONE
    await this.delay(RETRY_DELAY_MS);
    if (!(await this.isFlowActive())) {
      console.log('[StateMachine] 重试延迟期间流程已停止，取消后续获取号码');
      return;
    }

    // 记录 lastError 供 Popup 显示
    state.lastError = error;
    await saveState(state);

    // 进入 GET_PHONE
    state.phase = RetryPhase.GET_PHONE;
    await saveState(state);
    await updateBadge(state);
    await this.handleGetPhone(state, { type: 'start' });
  }

  /** 断路器只保护明确可分类的系统性拒号，普通无法发送验证码交给 Bucket 重试。 */
  private shouldUseCircuitBreaker(error: TypedError): boolean {
    if (error.code !== 'PHONE_REJECTED') return false;
    const errorType = classifyError(error);
    return errorType !== CircuitErrorType.UNKNOWN_REJECT;
  }

  /** DONE: 报告成功 + 清理 + 自动恢复 IDLE */
  private async handleDone(state: RetryState): Promise<void> {
    // 清除 alarm
    await this.clearPollAlarm();

    // 报告成功
    if (state.currentActivationId) {
      try {
        await this.provider.reportSuccess(state.currentActivationId);
      } catch {
        console.warn('[StateMachine] reportSuccess 失败（忽略）');
      }
    }

    // 发送验证码到 Content Script
    const lastCode = state.usedCodes.size > 0 ? Array.from(state.usedCodes).pop()! : '';
    if (lastCode) {
      try {
        const tab = await this.findTargetTab();
        if (tab?.id) {
          await chrome.tabs.sendMessage(tab.id, {
            type: 'B2C_FILL_CODE',
            code: lastCode,
          });
        }
      } catch {
        // Content Script 可能未注入
      }
    }

    // 断路器重置
    if (this.circuitBreaker) {
      this.circuitBreaker.reset();
    }

    // 成功通知
    try {
      const template = buildSuccessNotification(state.totalAttempts);
      await createNotification(template);
    } catch {
      // 通知非关键
    }

    // 5s 后自动恢复 IDLE
    setTimeout(async () => {
      if (this.destroying) return;
      await this.resetToIdle();
    }, DONE_IDLE_DELAY_MS);
  }

  /** BUCKET_EXHAUSTED: cancelActivation + 通知 → AWAIT_CONFIRM */
  private async handleBucketExhausted(state: RetryState, event: StateEvent): Promise<void> {
    // 取消当前激活
    if (state.currentActivationId) {
      try {
        await this.provider.cancel(state.currentActivationId);
      } catch {
        console.warn('[StateMachine] cancelActivation 失败（忽略）');
      }
      state.currentActivationId = null;
      state.currentPhoneNumber = null;
      await saveState(state);
    }

    // 生成差异化通知
    let template;
    if (event.type === 'circuitBreakerTrip') {
      const info = (event as { info: { errorType: string; consecutiveCount: number } }).info;
      const triggerReason = `连续 ${info.consecutiveCount} 次被识别为 ${info.errorType} 号码`;
      template = buildCircuitBreakerPauseNotification(state, triggerReason);
    } else {
      template = buildBucketPauseNotification(state);
    }

    try {
      const notificationId = await createNotification(template);
      state.notificationId = notificationId;
      state.phase = RetryPhase.AWAIT_CONFIRM;
      await saveState(state);
      await updateBadge(state);
      console.log('[StateMachine] BUCKET_EXHAUSTED → AWAIT_CONFIRM, notificationId:', notificationId);
    } catch {
      // 通知创建失败，降级为继续
      console.warn('[StateMachine] 通知创建失败，自动继续');
      state.notificationId = null;
      await this.transition({ type: 'userContinue' });
    }
  }

  /** STOPPED: 摘要通知 + 清理 + 自动恢复 IDLE */
  private async handleStopped(state: RetryState, event: StateEvent): Promise<void> {
    // 清除 alarm
    await this.clearPollAlarm();
    await this.clearFillTimeoutAlarm();

    // 取消当前激活（如果仍有）
    if (state.currentActivationId) {
      try {
        await this.provider.cancel(state.currentActivationId);
      } catch {
        // 忽略
      }
      state.currentActivationId = null;
      state.currentPhoneNumber = null;
      state.currentActivationCountry = null;
    }

    // 关闭活跃通知
    if (state.notificationId) {
      try {
        await dismissNotification(state.notificationId);
      } catch {
        // 忽略
      }
      state.notificationId = null;
    }

    // 断路器重置
    if (this.circuitBreaker) {
      this.circuitBreaker.reset();
    }

    // 摘要通知
    if (event.type === 'maxRetriesExhausted') {
      try {
        chrome.notifications.create('', {
          type: 'basic',
          iconUrl: '/icon/128.png',
          title: '已达到最大尝试次数',
          message: `共尝试 ${state.totalAttempts} 次，所有轮次已耗尽。请检查网络或更换国家后重试。`,
        });
      } catch {
        // 通知非关键
      }
    } else {
      try {
        const template = buildStopSummaryNotification(state.totalAttempts);
        await createNotification(template);
      } catch {
        // 通知非关键
      }
    }

    // 释放锁
    this.lock.release();

    // 设置 flow_enabled = false
    await this.setFlowEnabled(false);

    // 3s 后自动恢复 IDLE
    setTimeout(async () => {
      if (this.destroying) return;
      await this.resetToIdle();
    }, STOPPED_IDLE_DELAY_MS);
  }

  // -------------------------------------------------------------------------
  // 内部辅助方法
  // -------------------------------------------------------------------------

  private createInitialState(): RetryState {
    return {
      phase: RetryPhase.IDLE,
      sessionId: '',
      currentBucket: 1,
      attemptInBucket: 0,
      totalAttempts: 0,
      maxBuckets: 3,
      bucketSize: 10,
      currentActivationId: null,
      currentPhoneNumber: null,
      currentActivationCountry: null,
      lastError: null,
      startedAt: 0,
      lastTransitionAt: 0,
      notificationId: null,
      usedCodes: new Set(),
      attemptedSmsKeys: new Set(),
      firstResendDone: false,
      lastResendAt: 0,
      pauseMode: 'bucket_and_circuit',
      costPerAttempt: 0.05,
      pollInterval: 5000,
      requestTimeout: 120000,
    };
  }

  /** 重置到 IDLE */
  private async resetToIdle(): Promise<void> {
    if (this.destroying) return;
    const oldTotal = this.state.totalAttempts;
    this.state = this.createInitialState();
    this.state.lastTransitionAt = Date.now();
    await saveState(this.state);
    try { await chrome.action.setBadgeText({ text: '' }); } catch { /* 忽略 */ }
    console.log('[StateMachine] 恢复 IDLE，本次共尝试:', oldTotal, '次');
  }

  /** 写入可见的停止状态，避免启动前置条件失败时 Popup 只显示旧状态。 */
  private async writeStoppedState(error: TypedError): Promise<void> {
    this.state = {
      ...this.createInitialState(),
      phase: RetryPhase.STOPPED,
      sessionId: crypto.randomUUID(),
      lastError: error,
      lastTransitionAt: Date.now(),
    };
    await saveState(this.state);
    await updateBadge(this.state);
  }

  /** 调度单次 poll alarm */
  private async schedulePoll(activationId: string): Promise<void> {
    const alarmName = `${POLL_ALARM_PREFIX}${activationId}`;
    await chrome.alarms.create(alarmName, {
      when: Date.now() + this.state.pollInterval,
    });
  }

  /** 清除所有 poll alarm */
  private async clearPollAlarm(): Promise<void> {
    try {
      const all = await chrome.alarms.getAll();
      for (const alarm of all) {
        if (alarm.name.startsWith(POLL_ALARM_PREFIX)) {
          await chrome.alarms.clear(alarm.name);
        }
      }
    } catch {
      // 忽略 alarm API 错误
    }
  }

  /** 清除填入超时 alarm */
  private async clearFillTimeoutAlarm(): Promise<void> {
    try {
      const all = await chrome.alarms.getAll();
      for (const alarm of all) {
        if (alarm.name.startsWith(FILL_TIMEOUT_PREFIX)) {
          await chrome.alarms.clear(alarm.name);
        }
      }
    } catch {
      // 忽略 alarm API 错误
    }
  }

  /** 设置 flow_enabled 标记（供 Popup 读取） */
  /** 设置 flow_enabled 标记（供 Popup 和 Content Script 读取） */
  private async setFlowEnabled(enabled: boolean): Promise<void> {
    await chrome.storage.session.set({ flow_enabled: enabled });
  }

  /** 读取 flow_enabled 标记 */
  private async isFlowEnabled(): Promise<boolean> {
    const data = await chrome.storage.session.get('flow_enabled');
    return data.flow_enabled === true;
  }

  /** 检查当前异步副作用是否仍属于有效运行流程 */
  private async isFlowActive(): Promise<boolean> {
    if (!(await this.isFlowEnabled())) return false;
    return this.state.phase !== RetryPhase.STOPPED && this.state.phase !== RetryPhase.IDLE;
  }

  /** 检查是否存在 OpenAI 手机号页面 */
  private async isOnTargetPage(): Promise<boolean> {
    try {
      return !!(await this.findTargetTab());
    } catch {
      return false;
    }
  }

  /** 查找真正的 OpenAI 手机号页面，避免 Popup 打开时误向其他 active tab 发消息。 */
  private async findTargetTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({ url: 'https://auth.openai.com/*' });
    return tabs.find((tab) => this.isTargetPhonePage(tab.url)) || null;
  }

  /** 用页面 URL 判断是否为手机号添加 / 验证页，避免路径硬编码过窄导致 Content Script 不可用。 */
  private isTargetPhonePage(url: string | undefined): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'auth.openai.com') return false;
      const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();
      return normalized.includes('add-phone') || normalized.includes('phone');
    } catch {
      return false;
    }
  }

  /** 异步延迟 */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
