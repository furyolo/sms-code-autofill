import type {
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
  NotificationAdapter,
  NotificationOptions,
  PlatformAdapter,
  RuntimeSignalAdapter,
  StorageAdapter,
  TimerAdapter,
  TimerHandle,
} from '../lib/platform';

interface GmXmlHttpResponse {
  status: number;
  statusText: string;
  finalUrl?: string;
  responseHeaders?: string;
  responseText: string;
  response?: unknown;
}

interface GmXmlHttpRequest {
  abort(): void;
}

declare const GM: {
  getValue?<T>(key: string, defaultValue?: T): Promise<T>;
  setValue?(key: string, value: unknown): Promise<void>;
  deleteValue?(key: string): Promise<void>;
  xmlHttpRequest?(details: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    data?: string | FormData | URLSearchParams;
    timeout?: number;
    responseType?: string;
    onload: (response: GmXmlHttpResponse) => void;
    onerror: (error: unknown) => void;
    ontimeout: () => void;
  }): GmXmlHttpRequest;
  notification?(details: {
    title: string;
    text: string;
    timeout?: number;
    silent?: boolean;
  }): Promise<void> | void;
  registerMenuCommand?(name: string, callback: () => void): void;
};

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
declare function GM_xmlhttpRequest(details: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: string | FormData | URLSearchParams;
  timeout?: number;
  responseType?: string;
  onload: (response: GmXmlHttpResponse) => void;
  onerror: (error: unknown) => void;
  ontimeout: () => void;
}): GmXmlHttpRequest;
declare function GM_notification(details: {
  title: string;
  text: string;
  timeout?: number;
  silent?: boolean;
}): void;
declare function GM_registerMenuCommand(name: string, callback: () => void): void;

function parseResponseHeaders(raw = ''): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

export class TampermonkeyStorageAdapter implements StorageAdapter {
  constructor(private readonly prefix: string) {}

  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (!keys) return {};
    if (typeof keys === 'string') {
      return { [keys]: await this.read(keys, undefined) };
    }
    if (Array.isArray(keys)) {
      const entries = await Promise.all(keys.map(async (key) => [key, await this.read(key, undefined)]));
      return Object.fromEntries(entries);
    }

    const entries = await Promise.all(
      Object.entries(keys).map(async ([key, defaultValue]) => [key, await this.read(key, defaultValue)]),
    );
    return Object.fromEntries(entries);
  }

  async set(values: Record<string, unknown>): Promise<void> {
    await Promise.all(Object.entries(values).map(([key, value]) => this.write(key, value)));
  }

  async remove(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    await Promise.all(list.map((key) => this.delete(key)));
  }

  private storageKey(key: string): string {
    return `${this.prefix}.${key}`;
  }

  private async read(key: string, defaultValue: unknown): Promise<unknown> {
    const storageKey = this.storageKey(key);
    if (GM.getValue) return await GM.getValue(storageKey, defaultValue);
    return typeof GM_getValue === 'function' ? GM_getValue(storageKey, defaultValue) : defaultValue;
  }

  private async write(key: string, value: unknown): Promise<void> {
    const storageKey = this.storageKey(key);
    if (GM.setValue) {
      await GM.setValue(storageKey, value);
      return;
    }
    GM_setValue(storageKey, value);
  }

  private async delete(key: string): Promise<void> {
    const storageKey = this.storageKey(key);
    if (GM.deleteValue) {
      await GM.deleteValue(storageKey);
      return;
    }
    GM_deleteValue(storageKey);
  }
}

export class TampermonkeyHttpClient implements HttpClient {
  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    return await new Promise<HttpResponse<T>>((resolve, reject) => {
      const request = GM.xmlHttpRequest ?? GM_xmlhttpRequest;
      request({
        method: options.method ?? 'GET',
        url: options.url,
        headers: options.headers,
        data: options.body ?? undefined,
        timeout: options.timeoutMs,
        responseType: options.responseType === 'json' ? 'json' : 'text',
        onload: (response) => {
          const rawText = response.responseText ?? String(response.response ?? '');
          const body = (options.responseType === 'json'
            ? response.response ?? (rawText ? JSON.parse(rawText) : null)
            : rawText) as T;
          resolve({
            status: response.status,
            statusText: response.statusText,
            finalUrl: response.finalUrl ?? options.url,
            headers: parseResponseHeaders(response.responseHeaders),
            body,
            rawText,
          });
        },
        onerror: reject,
        ontimeout: () => reject(new DOMException('请求超时', 'AbortError')),
      });
    });
  }
}

export class TampermonkeyTimerAdapter implements TimerAdapter {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  async schedule(name: string, delayMs: number, callback: () => void | Promise<void>): Promise<TimerHandle> {
    await this.clear(name);
    const timeoutId = setTimeout(() => {
      this.timers.delete(name);
      void callback();
    }, delayMs);
    this.timers.set(name, timeoutId);
    return { id: name };
  }

  async clear(name: string): Promise<void> {
    const timeoutId = this.timers.get(name);
    if (!timeoutId) return;
    clearTimeout(timeoutId);
    this.timers.delete(name);
  }

  async clearByPrefix(prefix: string): Promise<void> {
    const names = Array.from(this.timers.keys()).filter((name) => name.startsWith(prefix));
    await Promise.all(names.map((name) => this.clear(name)));
  }
}

export class TampermonkeyNotificationAdapter implements NotificationAdapter {
  async notify(options: NotificationOptions): Promise<string | null> {
    try {
      const details = {
        title: options.title,
        text: options.message,
        timeout: options.requireInteraction ? undefined : 5000,
        silent: false,
      };
      if (GM.notification) {
        await GM.notification(details);
      } else {
        GM_notification(details);
      }
      return options.id ?? null;
    } catch {
      return null;
    }
  }
}

class NoopRuntimeSignalAdapter implements RuntimeSignalAdapter {}

export function registerTampermonkeyMenuCommand(name: string, callback: () => void): void {
  const register = GM.registerMenuCommand ?? GM_registerMenuCommand;
  if (typeof register === 'function') {
    register(name, callback);
  }
}

export function createTampermonkeyPlatformAdapter(): PlatformAdapter {
  return {
    localStorage: new TampermonkeyStorageAdapter('local'),
    sessionStorage: new TampermonkeyStorageAdapter('session'),
    http: new TampermonkeyHttpClient(),
    timer: new TampermonkeyTimerAdapter(),
    notification: new TampermonkeyNotificationAdapter(),
    runtimeSignal: new NoopRuntimeSignalAdapter(),
  };
}
