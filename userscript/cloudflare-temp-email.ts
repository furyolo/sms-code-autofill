import type { HttpClient } from '../lib/platform';

export interface CloudflareTempEmailConfig {
  baseUrl: string;
  adminAuth: string;
  domain: string;
  pollInterval: number;
  requestTimeout: number;
}

export interface CloudflareTempEmailAccount {
  email: string;
  localPart: string;
  domain: string;
}

export interface WaitForEmailCodeOptions {
  beforeIds?: Set<string>;
}

interface NormalizedMailMessage {
  id: string;
  address: string;
  subject: string;
  bodyPreview: string;
  rawText: string;
}

const DEFAULT_MAIL_PAGE_SIZE = 20;

export class CloudflareTempEmailProvider {
  constructor(
    private readonly http: HttpClient,
    private readonly config: CloudflareTempEmailConfig,
  ) {}

  async createEmail(localPart: string): Promise<CloudflareTempEmailAccount> {
    const normalizedLocalPart = normalizeEmailLocalPart(localPart);
    if (!normalizedLocalPart) throw new Error('邮箱名前缀为空');
    const domain = normalizeDomain(this.config.domain);
    if (!domain) throw new Error('Cloudflare Temp Email 域名未配置');

    const email = `${normalizedLocalPart}@${domain}`;
    const response = await this.requestJson('/admin/new_address', {
      method: 'POST',
      body: JSON.stringify({
        enablePrefix: true,
        enableRandomSubdomain: false,
        name: normalizedLocalPart,
        domain,
      }),
      json: true,
    }).catch(() => this.requestJson('/api/address', {
      method: 'POST',
      body: JSON.stringify({ name: normalizedLocalPart, localPart: normalizedLocalPart, email, domain }),
      json: true,
    }));

    const resolvedEmail = normalizeEmailAddress(getEmailAddressFromResponse(response)) || email;
    return {
      email: resolvedEmail,
      localPart: resolvedEmail.split('@')[0] || normalizedLocalPart,
      domain: resolvedEmail.split('@')[1] || domain,
    };
  }

  async waitForCode(
    email: string,
    excludeCodes: Set<string> = new Set(),
    options: WaitForEmailCodeOptions = {},
  ): Promise<string | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.config.requestTimeout) {
      const messages = await this.listMessages(email);
      const code = pickVerificationCode(messages, excludeCodes, options);
      if (code) return code;
      logMailPollSnapshot(messages, options);
      await sleep(this.config.pollInterval);
    }
    return null;
  }

  async getCurrentIds(email: string): Promise<Set<string>> {
    const messages = await this.listMessages(email);
    return new Set(messages.map((message) => message.id).filter((id) => id.length > 0));
  }

  private async listMessages(email: string): Promise<NormalizedMailMessage[]> {
    const normalized = normalizeEmailAddress(email);
    const paths = [
      `/admin/mails?limit=${DEFAULT_MAIL_PAGE_SIZE}&offset=0&address=${encodeURIComponent(normalized)}`,
      `/api/mail?address=${encodeURIComponent(normalized)}&limit=${DEFAULT_MAIL_PAGE_SIZE}`,
      `/api/messages?address=${encodeURIComponent(normalized)}&limit=${DEFAULT_MAIL_PAGE_SIZE}`,
      `/api/mails?address=${encodeURIComponent(normalized)}&limit=${DEFAULT_MAIL_PAGE_SIZE}`,
    ];

    let lastError: unknown = null;
    for (const path of paths) {
      try {
        const payload = await this.requestJson(path);
        return normalizeMailMessages(payload).filter((message) => !message.address || message.address === normalized);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Cloudflare Temp Email 邮件列表请求失败');
  }

  private async requestJson(path: string, options: { method?: string; body?: string; json?: boolean } = {}): Promise<unknown> {
    const url = joinUrl(this.config.baseUrl, path);
    if (!url) throw new Error('Cloudflare Temp Email Base URL 未配置');
    const response = await this.http.request<unknown>({
      method: options.method ?? 'GET',
      url,
      headers: buildHeaders(this.config, { json: options.json }),
      body: options.body ?? null,
      responseType: 'json',
      timeoutMs: 12000,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Cloudflare Temp Email HTTP ${response.status}`);
    }
    return response.body;
  }
}

export function normalizeEmailLocalPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 48);
}

export function normalizeBaseUrl(value: string): string {
  const source = value.trim();
  if (!source) return '';
  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(source) ? source : `https://${source}`;
  try {
    const parsed = new URL(candidate);
    parsed.hash = '';
    parsed.search = '';
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path}`;
  } catch {
    return '';
  }
}

export function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^@+/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : '';
}

function buildHeaders(config: CloudflareTempEmailConfig, options: { json?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.adminAuth.trim()) headers['x-admin-auth'] = config.adminAuth.trim();
  if (options.json) headers['Content-Type'] = 'application/json';
  return headers;
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  if (!normalizedBase) return '';
  return `${normalizedBase}${path.startsWith('/') ? '' : '/'}${path}`;
}

function normalizeEmailAddress(value: string): string {
  const source = String(value || '').trim();
  const bracketMatch = source.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const directMatch = source.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return String(bracketMatch?.[1] || directMatch?.[0] || '').trim().toLowerCase();
}

function getEmailAddressFromResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const raw = payload as Record<string, unknown>;
  const nested = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : {};
  return String(raw.address || raw.email || nested.address || nested.email || '');
}

function normalizeMailMessages(payload: unknown): NormalizedMailMessage[] {
  return getMailRows(payload).map(normalizeMailMessage).filter((item): item is NormalizedMailMessage => item !== null);
}

function getMailRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const rowKeys = ['data', 'items', 'messages', 'mails', 'results', 'result', 'rows', 'list', 'hydra:member'];
  const queue: unknown[] = [payload];
  const seen = new Set<unknown>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const raw = current as Record<string, unknown>;
    for (const key of rowKeys) {
      const candidate = raw[key];
      if (Array.isArray(candidate)) return candidate;
      if (candidate && typeof candidate === 'object') queue.push(candidate);
    }
  }
  return [];
}

function normalizeMailMessage(row: unknown): NormalizedMailMessage | null {
  if (!row || typeof row !== 'object') return null;
  const raw = row as Record<string, unknown>;
  const subject = firstString([raw.subject, raw.title]);
  const rawText = firstString([
    raw.raw,
    raw.source,
    raw.mime,
    raw.body,
    raw.content,
    raw.html,
    raw.text,
    raw.text_content,
    raw.textContent,
    raw.message,
    raw.bodyPreview,
    raw.snippet,
    raw.preview,
  ]);
  const bodyPreview = stripHtmlTags(firstString([
    raw.bodyPreview,
    raw.snippet,
    raw.text,
    raw.text_content,
    raw.textContent,
    raw.preview,
    raw.body,
    raw.content,
    raw.html,
    raw.raw,
    raw.source,
    raw.mime,
    raw.message,
  ]));
  return {
    id: firstString([raw.id, raw._id, raw.mail_id, raw.mailId, raw.message_id, raw.messageId, raw.msgid]),
    address: normalizeEmailAddress(firstString([raw.address, raw.mail_address, raw.mailAddress, raw.email, raw.recipient, raw.to])),
    subject,
    bodyPreview,
    rawText,
  };
}

function pickVerificationCode(
  messages: NormalizedMailMessage[],
  excludeCodes: Set<string>,
  options: WaitForEmailCodeOptions = {},
): string | null {
  const sorted = [...messages].reverse();
  for (const message of sorted) {
    if (options.beforeIds?.has(message.id)) continue;
    const code = extractVerificationCode(message);
    if (code && !excludeCodes.has(code)) return code;
  }
  return null;
}

function logMailPollSnapshot(messages: NormalizedMailMessage[], options: WaitForEmailCodeOptions = {}): void {
  const sample = messages.slice(0, 3).map((message) => ({
    id: message.id,
    subject: message.subject.slice(0, 80),
    hasCode: Boolean(extractVerificationCode(message)),
    baseline: Boolean(options.beforeIds?.has(message.id)),
  }));
  console.debug('[Userscript] Cloudflare Temp Email poll', {
    count: messages.length,
    beforeIds: options.beforeIds?.size || 0,
    sample,
  });
}

function extractVerificationCode(message: NormalizedMailMessage): string {
  const spanMatch = message.rawText.match(/<span[^>]*>\s*(\d{6})\s*<\/span>/i);
  const text = sanitizeMailSearchText(`${message.subject} ${message.bodyPreview} ${message.rawText}`);
  const match = spanMatch
    ?? text.match(/(?:code|验证码|verification)[^\d]{0,40}(\d{6})/i)
    ?? text.match(/(?<!#)(?<!\d)(\d{6})(?!\d)/);
  return match?.[1] ?? '';
}

function sanitizeMailSearchText(value: string): string {
  const bodyStart = value.indexOf('\r\n\r\n');
  const body = bodyStart >= 0 ? value.slice(bodyStart) : value;
  return stripHtmlTags(body)
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '')
    .replace(/m=\+\d+\.\d+/g, '')
    .replace(/\bt=\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    if (value === undefined || value === null || typeof value === 'object') continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
