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

/** storage.local 中的配置 key */
const CONFIG_KEYS = [
  'hero_sms.api_key',
  'hero_sms.country',
  'hero_sms.service',
  'hero_sms.max_price',
  'retry.bucket_size',
  'retry.max_buckets',
  'polling.interval',
  'polling.timeout',
  'circuit.enabled',
  'circuit.threshold_voip',
  'circuit.threshold_timeout',
  'pause_mode',
];

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
  private destroying = false;

  constructor(provider: BaseSmsProvider, circuitBreaker: CircuitBreaker | null = null) {
    this.provider = provider;
    this.circuitBreaker = circuitBreaker;
    this.lock = new AsyncLock();
    this.service = 'dr';
    this.country = '187';
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
   * 读取配置 → 初始化状态 → 进入 GET_PHONE
   */
  async start(): Promise<void> {
    if (this.state.phase !== RetryPhase.IDLE && this.state.phase !== RetryPhase.STOPPED) {
      console.warn('[StateMachine] 状态机已在运行中，忽略重复 start');
      return;
    }

    // 读取配置
    const config = await chrome.storage.local.get(CONFIG_KEYS);

    // 检查 API Key
    const apiKey = config['hero_sms.api_key'] || '';
    if (!apiKey.trim()) {
      console.warn('[StateMachine] 未配置 API Key，无法启动');
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
   * 处理通知按钮点击
   */
  async handleNotificationButton(notificationId: string, buttonIndex: number): Promise<void> {
    if (notificationId !== this.state.notificationId) return;

    if (buttonIndex === 0) {
      // 继续
      await this.transition({ type: 'userContinue' });
    } else {
      // 停止
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
        };

      case 'phoneAcquired':
        return {
          ...base,
          phase: RetryPhase.FILL_PHONE,
          currentActivationId: event.activation.activationId,
          currentPhoneNumber: event.activation.phoneNumber,
          totalAttempts: state.totalAttempts + 1,
          attemptInBucket: state.attemptInBucket + 1,
          lastError: null,
        };

      case 'phoneFailed':
        return {
          ...base,
          phase: RetryPhase.REJECTED,
          lastError: event.error,
          totalAttempts: state.totalAttempts + 1,
        };

      case 'phoneFilled':
        return {
          ...base,
          phase: RetryPhase.WAIT_CODE,
          startedAt: Date.now(),
        };

      case 'fillFailed':
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
          attemptInBucket: state.attemptInBucket + 1,
          totalAttempts: state.totalAttempts + 1,
        };

      case 'phoneRejected':
        return {
          ...base,
          phase: RetryPhase.REJECTED,
          lastError: event.error,
          attemptInBucket: state.attemptInBucket + 1,
          totalAttempts: state.totalAttempts + 1,
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
      await this.transition({ type: 'phoneAcquired', activation });
    } catch (error) {
      this.lock.release();
      const typedError =
        error instanceof TypedError
          ? error
          : new TypedError('PROVIDER', 'UNKNOWN', String(error), true);
      console.warn('[StateMachine] getNumber 失败:', typedError.code, typedError.message);

      // 不可恢复错误直接停止
      if (!typedError.recoverable) {
        console.warn('[StateMachine] 不可恢复错误，停止:', typedError.code);
        await this.transition({ type: 'maxRetriesExhausted' });
        return;
      }

      await this.transition({ type: 'phoneFailed', error: typedError });
    }
  }

  /** FILL_PHONE: 向 Content Script 发送填号指令 */
  private async handleFillPhone(state: RetryState): Promise<void> {
    // 发送 B2C_FILL_PHONE 到 Content Script
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'B2C_FILL_PHONE',
          phoneNumber: state.currentPhoneNumber,
        });
      }
    } catch {
      // Content Script 可能未注入，静默忽略
    }

    // 自动推进到 WAIT_CODE（Content Script 未实现时兼容）
    await this.transition({ type: 'phoneFilled' });
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
      await saveState(state);
    }

    const error =
      'error' in event
        ? (event as { error: TypedError }).error
        : new TypedError('PROVIDER', 'UNKNOWN', '未知错误', true);

    // 检查断路器
    if (this.circuitBreaker) {
      const result = this.circuitBreaker.recordError(error);
      if (result.tripped && result.info) {
        console.log('[StateMachine] 断路器触发:', result.info);
        await this.transition({
          type: 'circuitBreakerTrip',
          error,
          info: result.info,
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
        state.phase = RetryPhase.GET_PHONE;
        await saveState(state);
        await this.handleGetPhone(state, { type: 'start' });
        return;
      }
    }

    // 正常重试：延迟 1s 后进入 GET_PHONE
    await this.delay(RETRY_DELAY_MS);

    // 记录 lastError 供 Popup 显示
    state.lastError = error;
    await saveState(state);

    // 进入 GET_PHONE
    state.phase = RetryPhase.GET_PHONE;
    await saveState(state);
    await updateBadge(state);
    await this.handleGetPhone(state, { type: 'start' });
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
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

    // 取消当前激活（如果仍有）
    if (state.currentActivationId) {
      try {
        await this.provider.cancel(state.currentActivationId);
      } catch {
        // 忽略
      }
      state.currentActivationId = null;
      state.currentPhoneNumber = null;
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

  /** 设置 flow_enabled 标记（供 Popup 读取） */
  private async setFlowEnabled(enabled: boolean): Promise<void> {
    await chrome.storage.session.set({ flow_enabled: enabled });
  }

  /** 异步延迟 */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
