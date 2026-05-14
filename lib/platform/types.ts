/**
 * 平台能力抽象
 *
 * 浏览器扩展与 Tampermonkey userscript 在存储、网络请求、定时器和通知上
 * 使用不同 API。业务模块只依赖这些接口，避免直接绑定 chrome 或 GM 全局对象。
 */

export type StorageAreaName = 'local' | 'session';

export interface StorageAdapter {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface HttpRequestOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | FormData | URLSearchParams | null;
  responseType?: 'text' | 'json';
  timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  statusText: string;
  finalUrl: string;
  headers: Record<string, string>;
  body: T;
  rawText: string;
}

export interface HttpClient {
  request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>>;
}

export interface TimerHandle {
  id: string;
}

export interface TimerAdapter {
  schedule(name: string, delayMs: number, callback: () => void | Promise<void>): Promise<TimerHandle>;
  clear(name: string): Promise<void>;
  clearByPrefix(prefix: string): Promise<void>;
}

export interface NotificationOptions {
  id?: string;
  title: string;
  message: string;
  requireInteraction?: boolean;
}

export interface NotificationAdapter {
  notify(options: NotificationOptions): Promise<string | null>;
}

export interface RuntimeSignalAdapter {
  setBadge?(text: string, color?: [number, number, number, number]): Promise<void>;
  clearBadge?(): Promise<void>;
}

export interface PlatformAdapter {
  localStorage: StorageAdapter;
  sessionStorage: StorageAdapter;
  http: HttpClient;
  timer: TimerAdapter;
  notification: NotificationAdapter;
  runtimeSignal: RuntimeSignalAdapter;
}
