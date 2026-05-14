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
} from './types';

function parseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export class ChromeStorageAdapter implements StorageAdapter {
  constructor(private readonly area: chrome.storage.StorageArea) {}

  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    return await this.area.get(keys ?? null);
  }

  async set(values: Record<string, unknown>): Promise<void> {
    await this.area.set(values);
  }

  async remove(keys: string | string[]): Promise<void> {
    await this.area.remove(keys);
  }
}

export class FetchHttpClient implements HttpClient {
  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    const controller = options.timeoutMs ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;

    try {
      const response = await fetch(options.url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body ?? undefined,
        signal: controller?.signal,
      });
      const rawText = await response.text();
      const body = (options.responseType === 'json' && rawText
        ? JSON.parse(rawText)
        : rawText) as T;

      return {
        status: response.status,
        statusText: response.statusText,
        finalUrl: response.url,
        headers: parseHeaders(response.headers),
        body,
        rawText,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

interface ChromeTimerEntry {
  timeoutId: ReturnType<typeof setTimeout>;
  callback: () => void | Promise<void>;
}

export class ChromeTimerAdapter implements TimerAdapter {
  private readonly entries = new Map<string, ChromeTimerEntry>();

  async schedule(name: string, delayMs: number, callback: () => void | Promise<void>): Promise<TimerHandle> {
    await this.clear(name);
    const timeoutId = setTimeout(() => {
      this.entries.delete(name);
      void callback();
    }, delayMs);
    this.entries.set(name, { timeoutId, callback });
    return { id: name };
  }

  async clear(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    this.entries.delete(name);
  }

  async clearByPrefix(prefix: string): Promise<void> {
    const names = Array.from(this.entries.keys()).filter((name) => name.startsWith(prefix));
    await Promise.all(names.map((name) => this.clear(name)));
  }
}

export class ChromeNotificationAdapter implements NotificationAdapter {
  async notify(options: NotificationOptions): Promise<string | null> {
    try {
      await chrome.notifications.create(options.id ?? '', {
        type: 'basic',
        iconUrl: '/icon/128.png',
        title: options.title,
        message: options.message,
        requireInteraction: options.requireInteraction,
      });
      return options.id ?? null;
    } catch {
      return null;
    }
  }
}

export class ChromeRuntimeSignalAdapter implements RuntimeSignalAdapter {
  async setBadge(text: string, color?: [number, number, number, number]): Promise<void> {
    try {
      await chrome.action.setBadgeText({ text });
      if (color) {
        await chrome.action.setBadgeBackgroundColor({ color });
      }
    } catch {
      // Badge 是非关键状态信号，调用失败不阻断业务流程。
    }
  }

  async clearBadge(): Promise<void> {
    await this.setBadge('');
  }
}

export function createChromePlatformAdapter(): PlatformAdapter {
  return {
    localStorage: new ChromeStorageAdapter(chrome.storage.local),
    sessionStorage: new ChromeStorageAdapter(chrome.storage.session),
    http: new FetchHttpClient(),
    timer: new ChromeTimerAdapter(),
    notification: new ChromeNotificationAdapter(),
    runtimeSignal: new ChromeRuntimeSignalAdapter(),
  };
}
