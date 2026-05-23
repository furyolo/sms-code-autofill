/**
 * 页面自动化能力
 *
 * 该模块只负责 OpenAI 手机验证页的 DOM 操作，不直接发送 runtime 消息。
 * 扩展 Content Script 与 Tampermonkey userscript 都可以复用这些函数。
 */
import {
  fillPhoneInput,
  fillCodeInput,
  getPhoneInput,
} from './filler';
import {
  waitForCodeInput,
  findAndClickSubmitButton,
} from './observer';

export interface PhoneFillOptions {
  phoneNumber: string;
  providerCountry: string | null;
  providerCountryNames: string[] | null;
}

export interface AutomationResult {
  success: boolean;
  error?: string;
}

interface CountryTarget {
  isoCode: string;
  dialCode: string;
  names: string[];
}

const RUNTIME_MARK_KEY = '__smsCodeAutofillRuntime';

export function markSmsAutofillRuntime(source: 'extension' | 'userscript'): void {
  Object.defineProperty(window, RUNTIME_MARK_KEY, {
    value: source,
    configurable: true,
  });
}

export function detectSmsAutofillRuntime(): 'extension' | 'userscript' | null {
  const value = (window as unknown as Record<string, unknown>)[RUNTIME_MARK_KEY];
  return value === 'extension' || value === 'userscript' ? value : null;
}

/** 在获取号码前检查页面是否具备国家选择和手机号输入能力，避免先消耗 HeroSMS 号码 */
export async function preflightPhoneForm(): Promise<AutomationResult> {
  const trigger = findCountryDropdownTrigger();
  if (!trigger) {
    console.warn('[Content] 预检失败：未找到国家下拉框');
    return { success: false, error: 'COUNTRY_DROPDOWN_NOT_FOUND' };
  }

  const phoneInput = await getPhoneInput();
  if (!phoneInput) {
    console.warn('[Content] 预检失败：未找到手机号输入框');
    return { success: false, error: 'PHONE_INPUT_NOT_FOUND' };
  }

  return { success: true };
}

/** 选择国家、填入手机号、点击提交并等待页面反馈 */
export async function fillPhoneAndSubmit(options: PhoneFillOptions): Promise<AutomationResult> {
  const { phoneNumber, providerCountry, providerCountryNames } = options;
  console.log('[Content] fillPhoneAndSubmit:', phoneNumber, 'providerCountry:', providerCountry);

  const parsed = parseInternationalNumber(phoneNumber);
  console.log('[Content] 解析号码:', parsed);
  const countryTarget = resolveCountryTarget(providerCountry, parsed?.countryCode ?? null, providerCountryNames);

  if (countryTarget) {
    const trigger = findCountryDropdownTrigger();
    if (!trigger) {
      console.warn('[Content] 未找到国家下拉框——页面结构可能已变更');
      return { success: false, error: 'FORM_STRUCTURE_CHANGED' };
    }
    const countrySelected = await selectCountryFromTrigger(trigger, countryTarget);
    if (!countrySelected) {
      console.warn('[Content] 未找到目标国家选项——页面结构或国家列表可能已变更');
      return { success: false, error: 'FORM_STRUCTURE_CHANGED' };
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  const numberToFill = parsed ? parsed.localNumber : phoneNumber;
  const filled = await fillPhoneInput(numberToFill);
  if (!filled) {
    console.warn('[Content] 未找到手机号输入框——页面结构可能已变更');
    return { success: false, error: 'FORM_STRUCTURE_CHANGED' };
  }

  await new Promise((r) => setTimeout(r, 1000));
  markExistingRejectionElements();
  const clicked = findAndClickSubmitButton();
  console.log('[Content] 提交按钮点击结果:', clicked);

  const result = await waitForPageResponse(12000, Date.now());

  if (result === 'code_input') {
    console.log('[Content] 号码被接受，验证码输入框已出现');
    return { success: true };
  }

  if (result === 'rejected') {
    console.log('[Content] 号码被拒绝，页面显示了错误信息');
    return { success: false, error: 'PHONE_REJECTED_BY_OPENAI' };
  }

  console.log('[Content] 等待超时，页面无明确反馈');
  return { success: true };
}

/** 填入验证码并点击提交按钮 */
export async function fillCodeAndSubmit(code: string): Promise<AutomationResult> {
  console.log('[Content] fillCodeAndSubmit:', code);

  const appeared = await waitForCodeInput(15000);
  if (!appeared) {
    console.warn('[Content] 等待验证码输入框超时');
  }

  const filled = await fillCodeInput(code);
  if (!filled) {
    console.warn('[Content] 未找到验证码输入框');
    return { success: false, error: 'CODE_INPUT_NOT_FOUND' };
  }

  await new Promise((r) => setTimeout(r, 800));
  const clicked = findAndClickSubmitButton();
  console.log('[Content] 验证码提交按钮点击结果:', clicked);

  return { success: true };
}

/** OpenAI 拒绝手机号的常见错误文案关键词 */
const REJECTION_KEYWORDS = [
  'not supported',
  'not available',
  'VOIP',
  'VoIP',
  'virtual',
  'already used',
  'too many',
  'invalid',
  '无法用于',
  '不支持',
  '已使用',
  '已达上限',
  '无效',
  '虚拟',
  '无法向此电话号码发送验证码',
  '使用其他号码',
  'something went wrong',
  'try again',
  '请重试',
  '出错了',
];

function waitForPageResponse(timeoutMs: number, startedAt: number): Promise<'code_input' | 'rejected' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve('timeout');
    }, timeoutMs);

    const observer = new MutationObserver((mutations) => {
      const codeInput = document.querySelector(
        'input[autocomplete="one-time-code"], input[type="text"][maxlength="6"], input[aria-label*="code" i], input[placeholder*="code" i], input[placeholder*="验证码" i]',
      );
      if (codeInput && (codeInput as HTMLElement).offsetParent !== null) {
        clearTimeout(timer);
        observer.disconnect();
        resolve('code_input');
        return;
      }

      const rejection = findFreshRejectionElement(startedAt, mutations);
      if (rejection) {
        clearTimeout(timer);
        observer.disconnect();
        resolve('rejected');
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

function findFreshRejectionElement(startedAt: number, mutations: MutationRecord[]): HTMLElement | null {
  const candidates = document.querySelectorAll('li, [role="alert"], [aria-live], .error, [class*="error"]');
  for (const el of candidates) {
    const element = el as HTMLElement;
    const text = element.innerText || element.textContent || '';
    if (!REJECTION_KEYWORDS.some((kw) => text.includes(kw))) continue;

    const seenAtRaw = element.dataset.smsAutofillSeenAt;
    const previousText = element.dataset.smsAutofillRejectionText || '';
    const now = Date.now();
    const changedInThisBatch = mutations.some((mutation) => {
      const target = mutation.target;
      return target === element || element.contains(target);
    });

    if (!seenAtRaw || Number(seenAtRaw) >= startedAt || previousText !== text || changedInThisBatch) {
      element.dataset.smsAutofillSeenAt = String(now);
      element.dataset.smsAutofillRejectionText = text;
      return element;
    }
  }
  return null;
}

function markExistingRejectionElements(): void {
  const candidates = document.querySelectorAll('li, [role="alert"], [aria-live], .error, [class*="error"]');
  const now = Date.now();
  for (const el of candidates) {
    const element = el as HTMLElement;
    const text = element.innerText || element.textContent || '';
    if (!REJECTION_KEYWORDS.some((kw) => text.includes(kw))) continue;
    element.dataset.smsAutofillSeenAt = String(now - 1);
    element.dataset.smsAutofillRejectionText = text;
  }
}

const HERO_COUNTRY_TO_TARGET: Record<string, CountryTarget> = {
  '187': { isoCode: 'US', dialCode: '1', names: ['United States', '美国'] },
  '12': { isoCode: 'US', dialCode: '1', names: ['United States', 'USA', '美国'] },
  '16': { isoCode: 'GB', dialCode: '44', names: ['United Kingdom', '英国'] },
  '36': { isoCode: 'CA', dialCode: '1', names: ['Canada', '加拿大'] },
  '73': { isoCode: 'BR', dialCode: '55', names: ['Brazil', '巴西'] },
  '3': { isoCode: 'CN', dialCode: '86', names: ['China', '中国'] },
  '6': { isoCode: 'ID', dialCode: '62', names: ['Indonesia', '印度尼西亚'] },
  '4': { isoCode: 'PH', dialCode: '63', names: ['Philippines', '菲律宾'] },
  '14': { isoCode: 'HK', dialCode: '852', names: ['Hong Kong', '香港'] },
  '22': { isoCode: 'IN', dialCode: '91', names: ['India', '印度'] },
  '10': { isoCode: 'VN', dialCode: '84', names: ['Vietnam', '越南'] },
  '7': { isoCode: 'MY', dialCode: '60', names: ['Malaysia', '马来西亚'] },
};

const DIAL_CODE_TO_COUNTRY: Record<string, CountryTarget> = {
  '1': { isoCode: 'US', dialCode: '1', names: ['United States', '美国', 'Canada', '加拿大'] },
  '44': { isoCode: 'GB', dialCode: '44', names: ['United Kingdom', '英国'] },
  '55': { isoCode: 'BR', dialCode: '55', names: ['Brazil', '巴西'] },
  '86': { isoCode: 'CN', dialCode: '86', names: ['China', '中国'] },
  '852': { isoCode: 'HK', dialCode: '852', names: ['Hong Kong', '香港'] },
  '62': { isoCode: 'ID', dialCode: '62', names: ['Indonesia', '印度尼西亚'] },
  '63': { isoCode: 'PH', dialCode: '63', names: ['Philippines', '菲律宾'] },
  '91': { isoCode: 'IN', dialCode: '91', names: ['India', '印度'] },
  '84': { isoCode: 'VN', dialCode: '84', names: ['Vietnam', '越南'] },
  '60': { isoCode: 'MY', dialCode: '60', names: ['Malaysia', '马来西亚'] },
};

function parseInternationalNumber(phone: string): { countryCode: string; localNumber: string } | null {
  if (!phone.startsWith('+')) return null;
  for (let len = 4; len >= 1; len--) {
    const code = phone.slice(1, 1 + len);
    if (DIAL_CODE_TO_COUNTRY[code]) {
      return { countryCode: code, localNumber: phone.slice(1 + len).replace(/\D/g, '') };
    }
  }
  const parts = phone.slice(1).split(/[\s-]/);
  if (parts.length >= 2) {
    return { countryCode: parts[0], localNumber: parts.slice(1).join('').replace(/\D/g, '') };
  }
  return null;
}

function resolveCountryTarget(
  providerCountry: string | null,
  parsedDialCode: string | null,
  providerCountryNames: string[] | null,
): CountryTarget | null {
  const names = normalizeCountryNames(providerCountryNames);
  const providerTarget = providerCountry ? HERO_COUNTRY_TO_TARGET[providerCountry] : null;
  const dialTarget = parsedDialCode ? DIAL_CODE_TO_COUNTRY[parsedDialCode] : null;
  const base = providerTarget || dialTarget;
  if (!base && names.length === 0) return null;
  if (!base) {
    return { isoCode: '', dialCode: parsedDialCode || '', names };
  }
  return {
    ...base,
    names: Array.from(new Set([...names, ...base.names])),
  };
}

function normalizeCountryNames(names: string[] | null): string[] {
  if (!names) return [];
  const normalized = new Set<string>();
  for (const rawName of names) {
    const name = normalizeCountryText(rawName)
      .replace(/\bid\s*\d+\b/g, '')
      .replace(/\b\d+\b/g, '')
      .trim();
    if (name) normalized.add(name);
  }
  return Array.from(normalized);
}

function normalizeCountryText(value: string): string {
  const alias: Record<string, string> = {
    usa: 'united states',
    'u s a': 'united states',
    'u.s.a': 'united states',
    us: 'united states',
    uk: 'united kingdom',
    'great britain': 'united kingdom',
    russian: 'russia',
    'viet nam': 'vietnam',
  };

  const simplified = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s()+-]/gu, ' ')
    .replace(/\+\d+/g, ' ')
    .replace(/\(\d+\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const normalized = alias[simplified] || simplified;
  return normalized
    .replace(/^the\s+/, '')
    .replace(/\s+\(\s*\)$/, '')
    .trim();
}

async function selectCountryFromTrigger(trigger: HTMLElement, target: CountryTarget): Promise<boolean> {
  const pageTarget = resolveTargetFromPageOptions(target) || target;
  if (isCountryAlreadySelected(trigger, pageTarget)) {
    return true;
  }
  if (selectNativeCountryOption(pageTarget)) {
    return true;
  }
  dispatchUserClick(trigger);
  const options = await waitForCountryOptions(pageTarget, 1500);
  for (const option of options) {
    const clickableOption = resolveClickableCountryOption(option);
    dispatchUserClick(clickableOption);
    await new Promise((r) => setTimeout(r, 300));
    if (isCountryAlreadySelected(trigger, pageTarget) || selectNativeCountryOption(pageTarget)) {
      return true;
    }
    return true;
  }
  return false;
}

function resolveTargetFromPageOptions(target: CountryTarget): CountryTarget | null {
  const options = getCountrySelectOptions();
  if (options.length === 0) return null;

  if (target.isoCode) {
    const exact = options.find((option) => option.value.toUpperCase() === target.isoCode.toUpperCase());
    if (exact) return optionToCountryTarget(exact, target);
  }

  const wantedNames = target.names.map(normalizeCountryText).filter(Boolean);
  const matched = findBestCountryOption(options, wantedNames);
  if (matched) return optionToCountryTarget(matched, target);

  const displayNames = getIsoDisplayNames(target.isoCode).map(normalizeCountryText);
  const displayMatched = findBestCountryOption(options, displayNames);
  return displayMatched ? optionToCountryTarget(displayMatched, target) : null;
}

function getCountrySelectOptions(): HTMLOptionElement[] {
  const options: HTMLOptionElement[] = [];
  for (const select of document.querySelectorAll('select')) {
    for (const option of Array.from(select.options)) {
      if (option.value || option.textContent) options.push(option);
    }
  }
  return options;
}

function optionToCountryTarget(option: HTMLOptionElement, source: CountryTarget): CountryTarget {
  const names = Array.from(new Set([
    ...source.names,
    option.textContent || '',
    option.label || '',
    option.value || '',
  ].map(normalizeCountryText).filter(Boolean)));

  return {
    isoCode: option.value || source.isoCode,
    dialCode: source.dialCode,
    names,
  };
}

function buildOptionNameCandidates(option: HTMLOptionElement): string[] {
  return [
    option.textContent || '',
    option.label || '',
    option.value || '',
  ].map(normalizeCountryText).filter(Boolean);
}

function findBestCountryOption(
  options: HTMLOptionElement[],
  wantedNames: string[],
): HTMLOptionElement | null {
  let best: { option: HTMLOptionElement; score: number } | null = null;
  for (const option of options) {
    const candidates = buildOptionNameCandidates(option);
    for (const candidate of candidates) {
      for (const wanted of wantedNames) {
        const score = countryNameMatchScore(candidate, wanted);
        if (score > 0 && (!best || score > best.score)) {
          best = { option, score };
        }
      }
    }
  }
  return best?.option ?? null;
}

function getIsoDisplayNames(isoCode: string): string[] {
  if (!isoCode) return [];
  const upper = isoCode.toUpperCase();
  const names: string[] = [];
  for (const locale of ['en', 'zh']) {
    try {
      const displayName = new Intl.DisplayNames([locale], { type: 'region' }).of(upper);
      if (displayName) names.push(displayName);
    } catch {
      // Intl.DisplayNames 在极旧浏览器中可能不可用。
    }
  }
  return names;
}

function namesMatch(left: string, right: string): boolean {
  return countryNameMatchScore(left, right) > 0;
}

function countryNameMatchScore(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) >= 4 ? 80 : 0;
  }
  if (hasCjk(left) || hasCjk(right)) return 0;
  if (isDelimitedPhraseMatch(left, right) || isDelimitedPhraseMatch(right, left)) {
    return 60;
  }
  return 0;
}

function hasCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function isDelimitedPhraseMatch(haystack: string, needle: string): boolean {
  if (!needle || needle.length < 4) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(haystack);
}

function dispatchUserClick(element: HTMLElement): void {
  element.focus();
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    const eventInit = { bubbles: true, cancelable: true };
    const event = type.startsWith('pointer') && typeof PointerEvent !== 'undefined'
      ? new PointerEvent(type, eventInit)
      : new MouseEvent(type, eventInit);
    element.dispatchEvent(event);
  }
}

function selectNativeCountryOption(target: CountryTarget): boolean {
  if (!target.isoCode) return false;
  const selects = document.querySelectorAll('select');
  for (const select of selects) {
    const option = select.querySelector(`option[value="${target.isoCode}"]`);
    if (option) {
      select.value = target.isoCode;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  }
  return false;
}

function findCountryDropdownTrigger(): HTMLElement | null {
  const ariaSelectButton = document.querySelector(
    'button[aria-haspopup="listbox"], button[aria-expanded], [role="combobox"]',
  );
  if (ariaSelectButton) return ariaSelectButton as HTMLElement;

  const selectors = [
    'button',
    '[role="button"]',
    '[data-testid*="country" i]',
    '[aria-label*="country" i]',
    '[aria-label*="国家" i]',
  ];
  for (const sel of selectors) {
    const elements = document.querySelectorAll(sel);
    for (const el of elements) {
      const text = (el as HTMLElement).textContent?.toLowerCase() || '';
      if (text.includes('country') || text.includes('国家') || text.includes('+')) {
        return el as HTMLElement;
      }
    }
  }

  const form = document.querySelector('form');
  if (form) {
    const combobox = form.querySelector('[role="combobox"], [role="listbox"]');
    if (combobox) return combobox as HTMLElement;
  }

  return null;
}

function findCountryOptions(target: CountryTarget): HTMLElement[] {
  const names = target.names.map(normalizeCountryText).filter(Boolean);
  const result: HTMLElement[] = [];

  const candidates = document.querySelectorAll(
    '[role="option"], [cmdk-item], li, button, div[aria-selected]',
  );
  for (const el of candidates) {
    const text = normalizeCountryText((el as HTMLElement).textContent || '');
    if (names.some((name) => namesMatch(text, name))) {
      result.push(el as HTMLElement);
    }
  }

  if (result.length === 0) {
    const all = document.querySelectorAll('div, li, span, button');
    for (const el of all) {
      const text = normalizeCountryText((el as HTMLElement).textContent || '');
      if (names.some((name) => namesMatch(text, name))) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          result.push(el as HTMLElement);
        }
      }
    }
  }

  return result;
}

async function waitForCountryOptions(target: CountryTarget, timeoutMs: number): Promise<HTMLElement[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const options = findCountryOptions(target);
    if (options.length > 0) return options;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

function resolveClickableCountryOption(option: HTMLElement): HTMLElement {
  const clickable = option.closest('button, [role="option"], [cmdk-item], li') as HTMLElement | null;
  return clickable || option;
}

function isCountryAlreadySelected(trigger: HTMLElement, target: CountryTarget): boolean {
  const text = normalizeCountryText(trigger.textContent || '');
  const hasName = target.names
    .map(normalizeCountryText)
    .some((name) => namesMatch(text, name));
  const rawText = trigger.textContent || '';
  const hasDialCode = rawText.includes(`+${target.dialCode}`) || rawText.includes(`(${target.dialCode})`);
  return hasName || hasDialCode;
}
