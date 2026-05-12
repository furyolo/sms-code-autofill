/**
 * HeroSMS Provider 实现
 *
 * 基于参考项目 any-auto-register 的 HeroSmsProvider (Python) 完整 TypeScript 化。
 * API 端点: https://hero-sms.com/stubs/handler_api.php
 *
 * 关键差异（浏览器适配）:
 * - threading.Lock → 单线程无需锁（JS 单线程 + async/await 非抢占）
 * - 文件缓存 → chrome.storage.session（异步读写）
 * - requests.get → fetch（Service Worker 中不受 CORS 限制）
 * - 阻塞轮询 → 单次查询（轮询由上层 chrome.alarms 驱动）
 */
import {
  SmsActivation,
  TypedError,
  HeroCache,
  SmsCandidate,
  ProviderConfig,
} from './types';
import { BaseSmsProvider } from './base-provider';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
const DEFAULT_SERVICE = 'dr';
const DEFAULT_COUNTRY = '187';
const CACHE_KEY = 'hero_cache';
const CACHE_TTL = 20 * 60 * 1000; // 20 分钟（毫秒）
const MAX_REUSE = 3;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** SHA256 哈希前 16 位十六进制，用于缓存身份校验 */
async function sha256Short(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/** SMS 事件键（SHA256），用于验证码去重 */
async function smsEventKey(
  activationId: string,
  code: string,
  eventFields?: Record<string, string>
): Promise<string> {
  const identity: Record<string, string> = { activation_id: activationId, code };
  if (eventFields) {
    if (eventFields['time']) identity['time'] = eventFields['time'];
    if (eventFields['text']) identity['text'] = eventFields['text'];
  }
  const raw = JSON.stringify(identity, Object.keys(identity).sort());
  return sha256Short(raw);
}

// ---------------------------------------------------------------------------
// HeroSmsProvider
// ---------------------------------------------------------------------------

export class HeroSmsProvider extends BaseSmsProvider {
  static readonly BASE_URL = BASE_URL;
  autoReportSuccessOnCode = false;

  private apiKey: string;
  private defaultService: string;
  private defaultCountry: string;
  private maxPrice: number;
  private proxy: string | null;
  private reusePhoneToMax: boolean;
  private phoneSuccessMax: number;
  private resendCallback: (() => void) | null = null;
  private currentActivation: SmsActivation | null = null;
  private lastCodeResult: SmsCandidate | null = null;

  constructor(
    apiKey: string,
    config: ProviderConfig
  );
  constructor(
    apiKey: string,
    config: ProviderConfig,
    _unused?: unknown
  );
  constructor(
    apiKey: string,
    configOrService?: ProviderConfig | string,
    _deprecatedCountry?: string,
    _deprecatedMaxPrice?: number,
    _deprecatedProxy?: string | null,
    _deprecatedReuse?: boolean,
    _deprecatedPhoneSuccessMax?: number
  ) {
    super();

    // 支持两种构造方式：
    // 1. new HeroSmsProvider(apiKey, ProviderConfig) —— 推荐（通过 Registry）
    // 2. new HeroSmsProvider(apiKey, service, country, maxPrice, proxy, ...) —— 向后兼容
    let config: ProviderConfig;
    if (typeof configOrService === 'object' && configOrService !== null) {
      config = configOrService as ProviderConfig;
    } else {
      config = {
        apiKey,
        service: (configOrService as string) || DEFAULT_SERVICE,
        country: _deprecatedCountry || DEFAULT_COUNTRY,
        maxPrice: _deprecatedMaxPrice ?? -1,
        proxy: _deprecatedProxy || undefined,
      };
    }

    this.apiKey = (config.apiKey || '').trim();
    this.defaultService = (config.service || DEFAULT_SERVICE).trim();
    this.defaultCountry = (config.country || DEFAULT_COUNTRY).trim();
    this.maxPrice = typeof config.maxPrice === 'number' ? config.maxPrice : -1;
    this.proxy = config.proxy?.trim() || null;
    this.reusePhoneToMax = true;
    this.phoneSuccessMax = MAX_REUSE;
  }

  // -------------------------------------------------------------------------
  // 核心抽象方法实现
  // -------------------------------------------------------------------------

  /** 租用手机号：getNumberV2 → V1 降级，含缓存复用逻辑 */
  async getNumber(service: string, country?: string): Promise<SmsActivation> {
    const svc = service || this.defaultService;
    const ctry = country || this.defaultCountry;

    // 检查号码缓存
    if (this.reusePhoneToMax) {
      const cached = await this._loadCache(svc, ctry);
      if (cached) {
        this.currentActivation = {
          activationId: cached.activation_id,
          phoneNumber: cached.phone_number,
          country: ctry,
          metadata: { reused: true, useCount: cached.use_count },
        };
        return this.currentActivation;
      }
    }

    // 获取新号码
    const numberInfo = await this._requestNumberRaw(svc, ctry);
    const activationId = numberInfo.activationId || '';
    const phone = HeroSmsProvider._formatPhone(numberInfo);

    if (!activationId || !phone.replace('+', '').trim()) {
      throw new TypedError('PROVIDER', 'INVALID_PHONE', '返回的号码信息不完整', true);
    }

    // 保存缓存
    const identity = await this._cacheIdentity(svc, ctry);
    const cache: HeroCache = {
      ...identity,
      activation_id: activationId,
      phone_number: phone,
      acquired_at: Date.now(),
      use_count: 0,
      used_codes: [],
      attempted_sms_keys: [],
      reuse_stopped: false,
    };
    await this._saveCache(cache);

    this.currentActivation = {
      activationId,
      phoneNumber: phone,
      country: ctry,
      metadata: { reused: false, numberInfo },
    };
    return this.currentActivation;
  }

  /**
   * 获取验证码（单次查询 + SHA256 去重）
   * 降级链：getStatusV2 → getStatus → getActiveActivations
   */
  async getCode(activationId: string, _timeout?: number): Promise<string> {
    const cache = await this._getCache();
    const usedCodes = cache ? new Set(cache.used_codes) : new Set<string>();
    const attemptedSmsKeys = cache ? new Set(cache.attempted_sms_keys) : new Set<string>();

    // 降级链查询
    let candidate: SmsCandidate | null = null;

    // 策略 1: getStatusV2
    try {
      const v2Result = await this.getStatusV2(activationId);
      if (v2Result.status === 'ok' && v2Result.code) {
        candidate = v2Result;
      }
    } catch {
      // 降级到 V1
    }

    // 策略 2: getStatus V1
    if (!candidate) {
      try {
        const v1Result = await this.getStatus(activationId);
        if (v1Result.status === 'ok' && v1Result.code) {
          candidate = {
            status: 'ok',
            code: v1Result.code,
            source: 'getStatus',
          };
        }
      } catch {
        // 降级到 active list
      }
    }

    // 策略 3: getActiveActivations
    if (!candidate) {
      try {
        const activeList = await this.getActiveActivations();
        for (const item of activeList) {
          if (String(item.activationId) === String(activationId)) {
            const rawCode = item.smsCode;
            if (typeof rawCode === 'string' && rawCode && rawCode !== 'null' && rawCode !== 'None') {
              candidate = {
                status: 'ok',
                code: rawCode,
                source: 'getActiveActivations',
                sms_text: typeof item.smsText === 'string' ? item.smsText : undefined,
                sms_time:
                  typeof item.dateTime === 'string' ? item.dateTime
                  : typeof item.date === 'string' ? item.date
                  : typeof item.smsDate === 'string' ? item.smsDate
                  : typeof item.smsTime === 'string' ? item.smsTime
                  : undefined,
              };
              break;
            }
          }
        }
      } catch {
        // 全部失败，返回空
      }
    }

    // 去重检查
    if (candidate && candidate.code) {
      const code = candidate.code;
      const smsKey = candidate.sms_key || await smsEventKey(
        activationId,
        code,
        candidate.sms_time || candidate.sms_text
          ? { time: candidate.sms_time || '', text: candidate.sms_text || '' }
          : undefined
      );

      // 已尝试过的 key 或 code（不允许同码复用）→ 跳过
      const allowSameCode = candidate.allow_same_code || false;
      if (smsKey && attemptedSmsKeys.has(smsKey)) {
        return '';
      }
      if (usedCodes.has(code) && !allowSameCode) {
        return '';
      }

      // 记录使用
      if (cache) {
        if (code) usedCodes.add(code);
        if (smsKey) attemptedSmsKeys.add(smsKey);
        cache.used_codes = Array.from(usedCodes);
        cache.attempted_sms_keys = Array.from(attemptedSmsKeys);
        await this._saveCache(cache);
      }

      this.lastCodeResult = candidate;
      return code;
    }

    return '';
  }

  /** 取消激活：cancelActivation → 降级 setStatus(8) */
  async cancel(activationId: string): Promise<boolean> {
    try {
      const result = await this.cancelActivation(activationId);
      return result;
    } finally {
      // 清理关联的缓存
      const cache = await this._getCache();
      if (cache && cache.activation_id === activationId) {
        await this._clearCache();
      }
    }
  }

  /** 报告成功：增加 use_count，达到上限后 finishActivation */
  async reportSuccess(activationId: string): Promise<boolean> {
    const cache = await this._getCache();
    if (cache && cache.activation_id === activationId) {
      cache.use_count += 1;

      let shouldFinish = false;

      if (!this.reusePhoneToMax) {
        cache.reuse_stopped = true;
        cache.stop_reason = 'reuse disabled';
        shouldFinish = true;
      } else if (this.phoneSuccessMax > 0 && cache.use_count >= this.phoneSuccessMax) {
        cache.reuse_stopped = true;
        cache.stop_reason = `success max reached (${this.phoneSuccessMax})`;
        shouldFinish = true;
      } else {
        const remaining = CACHE_TTL - (Date.now() - cache.acquired_at);
        if (remaining <= 30000) {
          cache.reuse_stopped = true;
          cache.stop_reason = 'phone lifetime nearly expired';
          shouldFinish = true;
        }
      }

      await this._saveCache(cache);

      if (shouldFinish) {
        await this._clearCache();
        await this.finishActivation(activationId);
      }
      return true;
    }

    return await this.finishActivation(activationId);
  }

  // -------------------------------------------------------------------------
  // 可选 hook 覆盖
  // -------------------------------------------------------------------------

  setResendCallback(callback: (() => void) | null): void {
    this.resendCallback = callback;
  }

  markCodeFailed(activationId: string, reason?: string): void {
    if (this.resendCallback) {
      try {
        this.resendCallback();
      } catch {
        // 忽略回调异常
      }
    }
    this.requestResendSms(activationId).catch(() => {});
  }

  markSendFailed(activationId: string, reason?: string): void {
    const reasonText = (reason || '').toLowerCase();
    if (
      reasonText.includes('limit') ||
      reasonText.includes('already') ||
      reasonText.includes('too many') ||
      reasonText.includes('exceeded') ||
      reasonText.includes('maximum')
    ) {
      this._stopReuse('phone limit reached');
    } else {
      this._stopReuse(reason || 'phone rejected');
    }
  }

  markSendSucceeded(_activationId: string): void {
    // HeroSMS 标记发送成功（setStatus 1）
  }

  async getReuseInfo(): Promise<Record<string, unknown>> {
    const cache = await this._getCache();
    if (!cache) {
      return { alive: false };
    }
    const remaining = Math.max(
      0,
      CACHE_TTL - (Date.now() - cache.acquired_at)
    );
    return {
      alive: remaining > 0 && !cache.reuse_stopped,
      phone_number: cache.phone_number,
      use_count: cache.use_count,
      remaining_seconds: Math.floor(remaining / 1000),
      reuse_stopped: cache.reuse_stopped,
      stop_reason: cache.stop_reason || '',
    };
  }

  // -------------------------------------------------------------------------
  // 公开辅助方法
  // -------------------------------------------------------------------------

  /** 获取账户余额 */
  async getBalance(): Promise<number> {
    const text = await this._requestText({ action: 'getBalance' });
    if (text.startsWith('ACCESS_BALANCE:')) {
      return parseFloat(text.split(':')[1]);
    }
    throw new TypedError('API', 'BALANCE_PARSE', `获取余额失败: ${text}`, true);
  }

  /** getStatusV2：JSON 响应，提取 code/sms/call 通道 */
  async getStatusV2(activationId: string): Promise<SmsCandidate> {
    const text = await this._requestText({ action: 'getStatusV2', id: activationId }, false);

    // 尝试 JSON 解析
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return this._parseStatusText(text);
    }

    if (typeof data === 'string') {
      return this._parseStatusText(data);
    }

    if (typeof data !== 'object' || data === null) {
      return { status: 'unknown', raw: data };
    }

    const obj = data as Record<string, unknown>;
    const rawStatus = obj.status;

    // 尝试解析 status 文本
    if (typeof rawStatus === 'string') {
      const parsed = this._parseStatusText(rawStatus);
      if (parsed.status !== 'unknown') return parsed;
    }

    // 遍历 sms/call 通道提取 code
    for (const channel of ['sms', 'call']) {
      const item = obj[channel];
      if (typeof item === 'object' && item !== null) {
        const channelData = item as Record<string, unknown>;
        const code = String(channelData.code || '').trim();
        if (code && code !== 'null' && code !== 'None') {
          const eventFields: Record<string, string> = {
            channel,
          };
          if (channelData.dateTime) eventFields['time'] = String(channelData.dateTime);
          if (channelData.text) eventFields['text'] = String(channelData.text);
          if (channelData.from) eventFields['from'] = String(channelData.from);
          if (channelData.url) eventFields['url'] = String(channelData.url);
          const smsKey = await smsEventKey(activationId, code, eventFields);

          return {
            status: 'ok',
            code,
            source: `getStatusV2.${channel}`,
            sms_key: smsKey,
            sms_time: eventFields['time'],
            sms_text: eventFields['text'],
          };
        }
      }
    }

    return { status: 'wait_code', raw: data };
  }

  /** getStatus V1：纯文本响应 */
  async getStatus(activationId: string): Promise<SmsCandidate> {
    const text = await this._requestText({ action: 'getStatus', id: activationId });
    return this._parseStatusText(text);
  }

  /** getActiveActivations：获取活跃激活列表 */
  async getActiveActivations(start: number = 0, limit: number = 20): Promise<Array<Record<string, unknown>>> {
    const text = await this._requestText({ action: 'getActiveActivations', start: String(start), limit: String(limit) });
    try {
      const data = JSON.parse(text);
      if (typeof data === 'object' && data !== null && 'data' in data) {
        return Array.isArray((data as Record<string, unknown>).data)
          ? (data as Record<string, unknown>).data as Array<Record<string, unknown>>
          : [];
      }
      return [];
    } catch {
      return [];
    }
  }

  /** 取消激活（API 专用接口） */
  async cancelActivation(activationId: string): Promise<boolean> {
    try {
      const resp = await this._request({ action: 'cancelActivation', id: activationId });
      if (resp.status === 204) return true;
      const text = await resp.text();
      return text.includes('ACCESS_CANCEL');
    } catch {
      try {
        const text = await this._requestText({ action: 'setStatus', id: activationId, status: '8' });
        return text.includes('ACCESS_CANCEL');
      } catch {
        return false;
      }
    }
  }

  /** 完成激活（标记为成功使用） */
  async finishActivation(activationId: string): Promise<boolean> {
    try {
      const resp = await this._request({ action: 'finishActivation', id: activationId });
      if (resp.status === 200 || resp.status === 204) return true;
      const text = await resp.text();
      return text.includes('ACCESS');
    } catch {
      try {
        const text = await this._requestText({ action: 'setStatus', id: activationId, status: '6' });
        return text.includes('ACCESS');
      } catch {
        return false;
      }
    }
  }

  /** 设置激活状态 */
  async setStatus(activationId: string, status: number): Promise<string> {
    return this._requestText({
      action: 'setStatus',
      id: activationId,
      status: String(status),
    });
  }

  /** 请求重发短信 */
  async requestResendSms(activationId: string): Promise<boolean> {
    try {
      await this.setStatus(activationId, 3);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 内部方法：API 请求
  // -------------------------------------------------------------------------

  /** 原始 fetch 请求，返回 Response */
  private async _request(
    params: Record<string, string>,
    timeout: number = 30
  ): Promise<Response> {
    const url = new URL(BASE_URL);
    const searchParams = new URLSearchParams();
    searchParams.set('api_key', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, value);
    }
    url.search = searchParams.toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
      });

      if (!response.ok && response.status >= 500) {
        throw new TypedError(
          'API',
          `HTTP_${response.status}`,
          `服务器错误: ${response.status}`,
          true,
          10000
        );
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof TypedError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new TypedError('NETWORK', 'TIMEOUT', '请求超时', true, 5000);
      }
      throw new TypedError(
        'NETWORK',
        'NETWORK_ERROR',
        `网络错误: ${String(error)}`,
        true,
        5000
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 请求并返回文本，自动检查已知错误 */
  private async _requestText(
    params: Record<string, string>,
    checkError: boolean = true
  ): Promise<string> {
    const resp = await this._request(params);
    const text = await resp.text();
    if (checkError) {
      this._checkError(text);
    }
    return text.trim();
  }

  /** 检查响应文本中的已知错误模式，抛出 TypedError */
  private _checkError(text: string): void {
    const upper = text.toUpperCase();
    if (upper.includes('NO_BALANCE')) {
      throw new TypedError('BALANCE', 'NO_BALANCE', '余额不足，请充值', /* recoverable */ false);
    }
    if (upper.includes('BAD_KEY')) {
      throw new TypedError('AUTH', 'BAD_KEY', 'API Key 无效', false);
    }
    if (upper.includes('ERROR_SQL')) {
      throw new TypedError('API', 'ERROR_SQL', '服务器内部错误', true, 10000);
    }
  }

  // -------------------------------------------------------------------------
  // 内部方法：号码获取
  // -------------------------------------------------------------------------

  /** 获取号码原始数据：getNumberV2 → V1 降级 */
  private async _requestNumberRaw(
    service: string,
    country: string
  ): Promise<{
    activationId?: string;
    phoneNumber: string;
    countryPhoneCode?: string;
    activationCost?: number;
  }> {
    const common: Record<string, string> = {
      action: 'getNumberV2',
      service,
      country,
      maxPrice: String(this.maxPrice > 0 ? this.maxPrice : 1),
    };

    // 尝试 V2
    let v2Error = '';
    try {
      const text = await this._requestText({ ...common }, true);
      try {
        const data = JSON.parse(text);
        if (data.activationId) {
          return data;
        }
      } catch {
        // Not JSON, fall through
      }
      v2Error = text.slice(0, 200);
    } catch (error: unknown) {
      if (error instanceof TypedError && error.code === 'NO_BALANCE') {
        throw error; // NO_BALANCE 直接抛出，不降级
      }
      v2Error = error instanceof Error ? error.message : String(error);
    }

    // V2 返回 NO_NUMBERS 且 maxPrice 受限时，尝试用用户配置的上限重试
    if (
      v2Error.includes('NO_NUMBERS') &&
      this.maxPrice > 0
    ) {
      try {
        const retryParams = { ...common };
        // 用实际价格 3 倍为上限（参考项目逻辑）
        retryParams.maxPrice = String(this.maxPrice);
        const text = await this._requestText(retryParams, true);
        try {
          const data = JSON.parse(text);
          if (data.activationId) {
            return data;
          }
        } catch {
          // Not JSON, fall through
        }
        v2Error = text.slice(0, 200);
      } catch (error: unknown) {
        if (error instanceof TypedError && error.code === 'NO_BALANCE') {
          throw error;
        }
        v2Error = error instanceof Error ? error.message : String(error);
      }
    }

    // V1 降级：action=getNumber
    try {
      const v1Params: Record<string, string> = {
        action: 'getNumber',
        service,
        country,
      };
      const text = await this._requestText(v1Params, true);
      if (text.startsWith('ACCESS_NUMBER:')) {
        const parts = text.split(':');
        if (parts.length >= 3) {
          return {
            activationId: parts[1],
            phoneNumber: parts[2],
            countryPhoneCode: '',
            activationCost: undefined,
          };
        }
      }
      throw new Error(text.slice(0, 200));
    } catch (error: unknown) {
      if (error instanceof TypedError && error.code === 'NO_BALANCE') {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('NO_NUMBERS')) {
        throw new TypedError('PROVIDER', 'NO_NUMBERS', '当前无可用号码', true, 30000);
      }
      throw new TypedError(
        'PROVIDER',
        'GET_NUMBER_FAILED',
        `获取号码失败: V2=${v2Error}; V1=${msg}`,
        true,
        30000
      );
    }
  }

  // -------------------------------------------------------------------------
  // 内部方法：解析
  // -------------------------------------------------------------------------

  /** 解析 V1 getStatus 纯文本响应 */
  private _parseStatusText(text: string): SmsCandidate {
    const trimmed = text.trim();
    if (trimmed === 'STATUS_WAIT_CODE') {
      return { status: 'wait_code' };
    }
    if (trimmed === 'STATUS_CANCEL') {
      return { status: 'cancel' };
    }
    if (trimmed.startsWith('STATUS_OK:')) {
      return { status: 'ok', code: trimmed.split(':')[1] };
    }
    if (trimmed.startsWith('STATUS_WAIT_RETRY')) {
      return { status: 'wait_retry', raw: trimmed };
    }
    if (trimmed === 'STATUS_WAIT_RESEND') {
      return { status: 'wait_resend' };
    }
    return { status: 'unknown', raw: trimmed };
  }

  // -------------------------------------------------------------------------
  // 内部方法：号码格式化
  // -------------------------------------------------------------------------

  /** 格式化手机号：始终添加 "+" 前缀，尊重 countryPhoneCode */
  static _formatPhone(numberInfo: {
    phoneNumber: string;
    countryPhoneCode?: string;
  }): string {
    const raw = (numberInfo.phoneNumber || '').trim();
    const countryPhoneCode = (numberInfo.countryPhoneCode || '').trim();

    if (raw.startsWith('+')) return raw;
    if (countryPhoneCode && raw.startsWith(countryPhoneCode)) return `+${raw}`;
    if (countryPhoneCode) return `+${countryPhoneCode}${raw}`;
    return `+${raw}`;
  }

  // -------------------------------------------------------------------------
  // 内部方法：缓存管理
  // -------------------------------------------------------------------------

  /** 计算缓存身份标识 */
  private async _cacheIdentity(
    service: string,
    country: string
  ): Promise<{ api_key_hash: string; service: string; country: string }> {
    return {
      api_key_hash: await sha256Short(this.apiKey),
      service,
      country,
    };
  }

  /** 从 chrome.storage.session 加载缓存 */
  private async _loadCache(
    service: string,
    country: string
  ): Promise<HeroCache | null> {
    const stored = await chrome.storage.session.get(CACHE_KEY);
    const cache = stored[CACHE_KEY] as HeroCache | undefined;
    if (!cache) return null;

    // 校验身份
    const identity = await this._cacheIdentity(service, country);
    if (
      cache.api_key_hash !== identity.api_key_hash ||
      cache.service !== service ||
      cache.country !== country
    ) {
      return null;
    }

    // 检查 TTL
    const elapsed = Date.now() - cache.acquired_at;
    if (elapsed >= CACHE_TTL || cache.reuse_stopped) {
      await this._clearCache();
      return null;
    }

    // 检查复用上限
    if (this.phoneSuccessMax > 0 && cache.use_count >= this.phoneSuccessMax) {
      cache.reuse_stopped = true;
      cache.stop_reason = `success max reached (${this.phoneSuccessMax})`;
      await this._saveCache(cache);
      return null;
    }

    return cache;
  }

  /** 保存缓存到 chrome.storage.session */
  private async _saveCache(cache: HeroCache): Promise<void> {
    await chrome.storage.session.set({ [CACHE_KEY]: cache });
  }

  /** 清除缓存 */
  private async _clearCache(): Promise<void> {
    await chrome.storage.session.remove(CACHE_KEY);
  }

  /** 获取当前缓存（不做校验） */
  private async _getCache(): Promise<HeroCache | null> {
    const stored = await chrome.storage.session.get(CACHE_KEY);
    return (stored[CACHE_KEY] as HeroCache) || null;
  }

  /** 停止号码复用 */
  private async _stopReuse(reason: string): Promise<void> {
    const cache = await this._getCache();
    if (!cache) return;
    cache.reuse_stopped = true;
    cache.stop_reason = reason;
    await this._saveCache(cache);
  }
}
