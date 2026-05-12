/**
 * 短信接码服务类型定义
 */

/** 一次手机号租用会话 */
export interface SmsActivation {
  activationId: string;
  /** 含 "+" 前缀的国际格式号码 */
  phoneNumber: string;
  country: string;
  metadata: Record<string, unknown>;
}

/** 统一错误类型，状态机和上层模块基于此做分类决策 */
export class TypedError extends Error {
  category: 'API' | 'PROVIDER' | 'NETWORK' | 'BALANCE' | 'AUTH';
  code: string;
  recoverable: boolean;
  retryAfterMs?: number;

  constructor(
    category: 'API' | 'PROVIDER' | 'NETWORK' | 'BALANCE' | 'AUTH',
    code: string,
    message: string,
    recoverable: boolean,
    retryAfterMs?: number
  ) {
    super(message);
    this.name = 'TypedError';
    this.category = category;
    this.code = code;
    this.recoverable = recoverable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Provider 配置，从 chrome.storage.local 读取 */
export interface ProviderConfig {
  apiKey: string;
  country?: string;
  service?: string;
  maxPrice?: number;
  proxy?: string;
}

/** 号码缓存结构，存储于 chrome.storage.session */
export interface HeroCache {
  activation_id: string;
  phone_number: string;
  acquired_at: number;
  use_count: number;
  used_codes: string[];
  attempted_sms_keys: string[];
  reuse_stopped: boolean;
  /** 缓存身份校验：SHA256(apiKey) 前 16 位 */
  api_key_hash: string;
  service: string;
  country: string;
  stop_reason?: string;
}

/** getStatusV2 / getActiveActivations 返回的 SMS 候选 */
export interface SmsCandidate {
  status: string;
  code?: string;
  source?: string;
  sms_key?: string;
  sms_time?: string;
  sms_text?: string;
  allow_same_code?: boolean;
  raw?: unknown;
}
