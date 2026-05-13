/**
 * Content Script 入口
 *
 * 在 auth.openai.com/add-phone 页面注入，负责：
 *   1. 检测手机号和验证码输入框（三层选择器回退链）
 *   2. 使用 React fiber（__reactFiber$ 前缀 key + native setter）填入
 *   3. 填入后 MutationObserver 检测验证码输入框 / 自动点击提交按钮
 *   4. 与 Service Worker 通过类型化消息协议通信
 *
 * Content Script MUST NOT 发起任何 HTTP 请求（受页面 CSP 限制）。
 * 所有 API 调用由 Service Worker 代理。
 *
 * 选择器缓存仅保存在当前 Content Script 内存中，避免暴露 chrome.storage.session。
 */

import { defineContentScript } from 'wxt/sandbox';
import type { B2C_Message } from '../lib/content/messages';
import { sendToBackground } from '../lib/content/messages';
import {
  fillPhoneInput,
  fillCodeInput,
  fillReactInput,
  fillNativeInput,
  getPhoneInput,
  getCodeInput,
} from '../lib/content/filler';
import type { SelectorStrategy } from '../lib/content/selectors';
import {
  waitForCodeInput,
  findAndClickSubmitButton,
} from '../lib/content/observer';

export default defineContentScript({
  matches: ['https://auth.openai.com/*'],
  runAt: 'document_idle',

  main() {
    // 初始化：通知 Service Worker 页面已就绪
    sendToBackground({
      type: 'C2B_PAGE_READY',
      tabId: -1, // Background 从 sender.tab.id 获取真实 tabId
      url: location.href,
    });

    console.log('[Content] SMS Code Autofill Content Script 已注入');

    // 注册消息监听
    chrome.runtime.onMessage.addListener(handleMessage);

    // 页面关闭 / 导航离开 → 通知 SW 取消当前激活
    window.addEventListener('beforeunload', () => {
      sendToBackground({ type: 'C2B_PAGE_CLOSED' });
    });
  },
});

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------

/**
 * 处理来自 Service Worker 的 B2C 消息
 * 返回 true 保持消息通道开放以支持异步响应
 */
function handleMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  const msg = message as B2C_Message;

  switch (msg.type) {
    case 'B2C_PREFLIGHT_FORM':
      preflightPhoneForm(msg.providerCountry ?? null, msg.providerCountryNames ?? null).then((result) => {
        sendResponse(result);
      }, (error) => {
        console.error('[Content] preflightPhoneForm 错误:', error);
        sendResponse({ success: false, error: String(error) });
      });
      return true; // 异步响应

    case 'B2C_FILL_PHONE':
      handleFillPhone(msg.phoneNumber, msg.providerCountry ?? null, msg.providerCountryNames ?? null).then((result) => {
        sendResponse(result);
      }, (error) => {
        console.error('[Content] handleFillPhone 错误:', error);
        sendResponse({ success: false, error: String(error) });
      });
      return true; // 异步响应

    case 'B2C_FILL_CODE':
      handleFillCode(msg.code).then((result) => {
        sendResponse(result);
      }, (error) => {
        console.error('[Content] handleFillCode 错误:', error);
        sendResponse({ success: false, error: String(error) });
      });
      return true; // 异步响应

    default:
      return false; // 不需要异步响应
  }
}

// ---------------------------------------------------------------------------
// 填入处理
// ---------------------------------------------------------------------------

/** 在获取号码前检查页面是否具备国家选择和手机号输入能力，避免先消耗 HeroSMS 号码 */
async function preflightPhoneForm(
  _providerCountry: string | null,
  _providerCountryNames: string[] | null,
): Promise<{ success: boolean; error?: string }> {
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

/**
 * 处理手机号填入指令
 * 先选国家 → 再填号码 → 点击提交 → 等待页面反馈
 * 一次只获取一个号码，根据页面反馈决定是否换号重试
 */
async function handleFillPhone(
  phoneNumber: string,
  providerCountry: string | null,
  providerCountryNames: string[] | null,
): Promise<{ success: boolean; error?: string }> {
  console.log('[Content] B2C_FILL_PHONE:', phoneNumber, 'providerCountry:', providerCountry);

  // 0. 解析国际号码，拆分国家代码和本地号码
  const parsed = parseInternationalNumber(phoneNumber);
  console.log('[Content] 解析号码:', parsed);
  const countryTarget = resolveCountryTarget(providerCountry, parsed?.countryCode ?? null, providerCountryNames);

  // 1. 选择国家（找不到下拉框 = 页面结构变更 = 不可恢复，直接停止）
  if (countryTarget) {
    const trigger = findCountryDropdownTrigger();
    if (!trigger) {
      console.warn('[Content] 未找到国家下拉框——页面结构可能已变更');
      sendToBackground({ type: 'C2B_PHONE_REJECTED', reason: 'FORM_STRUCTURE_CHANGED' });
      return { success: false, error: 'FORM_STRUCTURE_CHANGED' };
    }
    const countrySelected = await selectCountryFromTrigger(trigger, countryTarget);
    if (!countrySelected) {
      console.warn('[Content] 未找到目标国家选项——页面结构或国家列表可能已变更');
      sendToBackground({ type: 'C2B_PHONE_REJECTED', reason: 'FORM_STRUCTURE_CHANGED' });
      return { success: false, error: 'FORM_STRUCTURE_CHANGED' };
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  // 2. 填入本地号码（找不到输入框 = 页面结构变更 = 不可恢复，直接停止）
  const numberToFill = parsed ? parsed.localNumber : phoneNumber;
  const filled = await fillPhoneInput(numberToFill);
  if (!filled) {
    console.warn('[Content] 未找到手机号输入框——页面结构可能已变更');
    sendToBackground({ type: 'C2B_PHONE_REJECTED', reason: 'FORM_STRUCTURE_CHANGED' });
    return { success: false, error: 'FORM_STRUCTURE_CHANGED' };
  }

  // 2. 等待 1s 让 React 处理填入的值，然后点击提交按钮
  await new Promise((r) => setTimeout(r, 1000));
  markExistingRejectionElements();
  const clicked = findAndClickSubmitButton();
  console.log('[Content] 提交按钮点击结果:', clicked);

  // 3. 等待页面反馈（最多 12s）：验证码输入框 = 成功 / 新出现的拒绝文案 = 失败
  const result = await waitForPageResponse(12000, Date.now());

  if (result === 'code_input') {
    console.log('[Content] 号码被接受，验证码输入框已出现');
    sendToBackground({ type: 'C2B_PHONE_FILLED', success: true });
    return { success: true };
  }

  if (result === 'rejected') {
    console.log('[Content] 号码被拒绝，页面显示了错误信息');
    sendToBackground({ type: 'C2B_PHONE_REJECTED', reason: 'PHONE_REJECTED_BY_OPENAI' });
    return { success: false, error: 'PHONE_REJECTED_BY_OPENAI' };
  }

  // 超时——页面没有明确反馈，保守地报告为已填入（可能页面行为不同）
  console.log('[Content] 等待超时，页面无明确反馈');
  sendToBackground({ type: 'C2B_PHONE_FILLED', success: true });
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

/**
 * 等待页面响应：验证码输入框出现（成功）或错误文案出现（拒绝）
 * @param timeoutMs 最长等待时间
 * @returns 'code_input' | 'rejected' | 'timeout'
 */
function waitForPageResponse(timeoutMs: number, startedAt: number): Promise<'code_input' | 'rejected' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve('timeout');
    }, timeoutMs);

    const observer = new MutationObserver((mutations) => {
      // 先检查验证码输入框
      const codeInput = document.querySelector(
        'input[autocomplete="one-time-code"], input[type="text"][maxlength="6"], input[aria-label*="code" i], input[placeholder*="code" i], input[placeholder*="验证码" i]',
      );
      if (codeInput && (codeInput as HTMLElement).offsetParent !== null) {
        clearTimeout(timer);
        observer.disconnect();
        resolve('code_input');
        return;
      }

      // 再检查提交后新出现或新变化的拒绝文案，避免把页面残留旧错误当成本次号码失败。
      const rejection = findFreshRejectionElement(startedAt, mutations);
      if (rejection) {
        clearTimeout(timer);
        observer.disconnect();
        resolve('rejected');
        return;
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

/** 查找提交后新出现或文本刚变化的拒绝提示元素 */
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
    if (!seenAtRaw) {
      element.dataset.smsAutofillSeenAt = String(now);
      element.dataset.smsAutofillRejectionText = text;
      return now >= startedAt ? element : null;
    }

    if (text !== previousText) {
      element.dataset.smsAutofillSeenAt = String(now);
      element.dataset.smsAutofillRejectionText = text;
      return now >= startedAt ? element : null;
    }

    if (changedInThisBatch || Number(seenAtRaw) >= startedAt) {
      element.dataset.smsAutofillSeenAt = String(now);
      element.dataset.smsAutofillRejectionText = text;
      return element;
    }
  }

  return null;
}

/** 给提交前已经存在的拒绝提示做标记，避免提交后误读为本次失败 */
function markExistingRejectionElements(): void {
  const candidates = document.querySelectorAll('li, [role="alert"], [aria-live], .error, [class*="error"]');
  const now = Date.now();
  for (const el of candidates) {
    const element = el as HTMLElement;
    const text = element.innerText || element.textContent || '';
    if (!REJECTION_KEYWORDS.some((kw) => text.includes(kw))) continue;

    element.dataset.smsAutofillSeenAt = String(now);
    element.dataset.smsAutofillRejectionText = text;
  }
}

/**
 * 处理验证码填入指令
 */
async function handleFillCode(
  code: string,
): Promise<{ success: boolean; error?: string }> {
  console.log('[Content] B2C_FILL_CODE:', code);

  const filled = await fillCodeInput(code);
  if (!filled) {
    return { success: false, error: 'SELECTOR_NOT_FOUND' };
  }

  // 等待 React 受控输入状态落地后再提交验证码，避免按钮点击早于页面 state 更新。
  await new Promise((r) => setTimeout(r, 500));
  const clicked = findAndClickSubmitButton();
  console.log('[Content] 验证码提交按钮点击结果:', clicked);

  sendToBackground({ type: 'C2B_CODE_DETECTED', code });
  return { success: true };
}

// ---------------------------------------------------------------------------
// 国家选择
// ---------------------------------------------------------------------------

interface CountryTarget {
  isoCode: string;
  dialCode: string;
  names: string[];
}

/** HeroSMS 国家 ID → OpenAI 国家选择目标，优先使用配置国家，避免仅凭电话区号误判。 */
const HERO_COUNTRY_TO_TARGET: Record<string, CountryTarget> = {
  '187': { isoCode: 'US', dialCode: '1', names: ['United States', '美国'] },
  '16': { isoCode: 'GB', dialCode: '44', names: ['United Kingdom', '英国'] },
  '36': { isoCode: 'CA', dialCode: '1', names: ['Canada', '加拿大'] },
  '175': { isoCode: 'AU', dialCode: '61', names: ['Australia', '澳大利亚'] },
  '22': { isoCode: 'IN', dialCode: '91', names: ['India', '印度'] },
  '0': { isoCode: 'RU', dialCode: '7', names: ['Russia', '俄罗斯'] },
  '6': { isoCode: 'ID', dialCode: '62', names: ['Indonesia', '印度尼西亚'] },
  '4': { isoCode: 'PH', dialCode: '63', names: ['Philippines', '菲律宾'] },
  '52': { isoCode: 'TH', dialCode: '66', names: ['Thailand', '泰国'] },
  '73': { isoCode: 'BR', dialCode: '55', names: ['Brazil', '巴西'] },
};

/** 国际拨号码 → OpenAI 国家选择目标（覆盖 HeroSMS 常用国家） */
const DIAL_CODE_TO_COUNTRY: Record<string, CountryTarget> = {
  '1': { isoCode: 'US', dialCode: '1', names: ['United States', '美国'] },
  '7': { isoCode: 'RU', dialCode: '7', names: ['Russia', '俄罗斯'] },
  '44': { isoCode: 'GB', dialCode: '44', names: ['United Kingdom', '英国'] },
  '36': { isoCode: 'HU', dialCode: '36', names: ['Hungary', '匈牙利'] },
  '27': { isoCode: 'ZA', dialCode: '27', names: ['South Africa', '南非'] },
  '26': { isoCode: 'ZM', dialCode: '26', names: ['Zambia', '赞比亚'] },
  '52': { isoCode: 'MX', dialCode: '52', names: ['Mexico', '墨西哥'] },
  '55': { isoCode: 'BR', dialCode: '55', names: ['Brazil', '巴西'] },
  '61': { isoCode: 'AU', dialCode: '61', names: ['Australia', '澳大利亚'] },
  '63': { isoCode: 'PH', dialCode: '63', names: ['Philippines', '菲律宾'] },
  '66': { isoCode: 'TH', dialCode: '66', names: ['Thailand', '泰国'] },
  '73': { isoCode: 'RU', dialCode: '73', names: ['Russia', '俄罗斯'] },
  '86': { isoCode: 'CN', dialCode: '86', names: ['China', '中国'] },
  '91': { isoCode: 'IN', dialCode: '91', names: ['India', '印度'] },
  '62': { isoCode: 'ID', dialCode: '62', names: ['Indonesia', '印度尼西亚'] },
  '84': { isoCode: 'VN', dialCode: '84', names: ['Vietnam', '越南'] },
  '234': { isoCode: 'NG', dialCode: '234', names: ['Nigeria', '尼日利亚'] },
  '380': { isoCode: 'UA', dialCode: '380', names: ['Ukraine', '乌克兰'] },
  '971': { isoCode: 'AE', dialCode: '971', names: ['United Arab Emirates', '阿拉伯联合酋长国'] },
  '20': { isoCode: 'EG', dialCode: '20', names: ['Egypt', '埃及'] },
  '972': { isoCode: 'IL', dialCode: '972', names: ['Israel', '以色列'] },
  '60': { isoCode: 'MY', dialCode: '60', names: ['Malaysia', '马来西亚'] },
  '92': { isoCode: 'PK', dialCode: '92', names: ['Pakistan', '巴基斯坦'] },
  '966': { isoCode: 'SA', dialCode: '966', names: ['Saudi Arabia', '沙特阿拉伯'] },
  '90': { isoCode: 'TR', dialCode: '90', names: ['Turkey', '土耳其'] },
};

/** 解析国际号码格式：+12345678901 → { countryCode: '1', localNumber: '2345678901' } */
function parseInternationalNumber(phone: string): { countryCode: string; localNumber: string } | null {
  if (!phone.startsWith('+')) return null;
  // 尝试从最长到最短匹配国家代码（因为有些代码是 1 位，有些 3 位）
  for (const len of [3, 2, 1]) {
    const code = phone.slice(1, 1 + len);
    if (DIAL_CODE_TO_COUNTRY[code]) {
      return { countryCode: code, localNumber: phone.slice(1 + len) };
    }
  }
  // 无匹配时回退：去掉 + 和第一个空格前的部分
  const parts = phone.slice(1).split(/[\s-]/);
  if (parts.length >= 2) {
    return { countryCode: parts[0], localNumber: parts.slice(1).join('') };
  }
  return null;
}

/** 配置国家名称优先，其次才使用静态 ID / 号码区号兜底，避免 HeroSMS ID 映射过期后选错国家。 */
function resolveCountryTarget(
  providerCountry: string | null,
  dialCode: string | null,
  providerCountryNames: string[] | null,
): CountryTarget | null {
  const names = normalizeCountryNames(providerCountryNames);
  if (names.length > 0) {
    return { isoCode: '', dialCode: '', names };
  }
  if (providerCountry && HERO_COUNTRY_TO_TARGET[providerCountry]) {
    return HERO_COUNTRY_TO_TARGET[providerCountry];
  }
  if (dialCode && DIAL_CODE_TO_COUNTRY[dialCode]) {
    return DIAL_CODE_TO_COUNTRY[dialCode];
  }
  return null;
}

/** 清理 HeroSMS 国家名，去掉“物理/虚拟”等供应商标记，便于和页面国家列表匹配。 */
function normalizeCountryNames(names: string[] | null): string[] {
  if (!names) return [];
  const normalized = new Set<string>();
  for (const rawName of names) {
    const name = normalizeCountryText(rawName)
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s*（[^）]*）\s*/g, ' ')
      .trim();
    if (name) normalized.add(name);
  }
  return Array.from(normalized);
}

/** 统一国家名文本，处理大小写、重音符、常见地区简称和繁简差异。 */
function normalizeCountryText(value: string): string {
  const alias: Record<string, string> = {
    usa: 'united states',
    us: 'united states',
    'u s a': 'united states',
    'u s': 'united states',
    uae: 'united arab emirates',
    'great britain': 'united kingdom',
    uk: 'united kingdom',
    'czech republic': 'czechia',
    czech: 'czechia',
    'ivory coast': "cote d'ivoire",
    'dr congo': 'congo kinshasa',
    'democratic republic of congo': 'congo kinshasa',
    macao: 'macao',
    macau: 'macao',
    swaziland: 'eswatini',
  };
  const simplified = value
    .replace(/[國国]/g, '国')
    .replace(/[亞亚]/g, '亚')
    .replace(/[爾尔]/g, '尔')
    .replace(/[馬马]/g, '马')
    .replace(/[島岛]/g, '岛')
    .replace(/[蘭兰]/g, '兰')
    .replace(/[濟济]/g, '济')
    .replace(/[維维]/g, '维')
    .replace(/[貝贝]/g, '贝')
    .replace(/[魯鲁]/g, '鲁')
    .replace(/[爾尔]/g, '尔');
  const normalized = simplified
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[()（）]/g, ' ')
    .replace(/[’']/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u4e00-\u9fa5']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return alias[normalized] || normalized;
}

/**
 * 在已知触发器上选择国家
 * @returns 是否成功选中目标国家
 */
async function selectCountryFromTrigger(trigger: HTMLElement, target: CountryTarget): Promise<boolean> {
  console.log('[Content] 尝试选择国家:', target.names[0]);

  const pageTarget = resolveTargetFromPageOptions(target) || target;

  if (isCountryAlreadySelected(trigger, pageTarget)) {
    console.log('[Content] 目标国家已选中:', pageTarget.names[0]);
    return true;
  }

  if (selectNativeCountryOption(pageTarget)) {
    await new Promise((r) => setTimeout(r, 300));
    if (isCountryAlreadySelected(trigger, pageTarget)) {
      console.log('[Content] 已通过原生 select 选择国家:', pageTarget.names[0]);
      return true;
    }
  }

  dispatchUserClick(trigger);
  await new Promise((r) => setTimeout(r, 500));

  const options = await waitForCountryOptions(pageTarget, 1500);
  for (const option of options) {
    const clickableOption = resolveClickableCountryOption(option);
    dispatchUserClick(clickableOption);
    await new Promise((r) => setTimeout(r, 500));
    if (isCountryAlreadySelected(trigger, pageTarget)) {
      console.log('[Content] 已选择国家:', pageTarget.names[0]);
      return true;
    }
  }

  console.warn('[Content] 未找到国家选项:', pageTarget.names[0], pageTarget);
  document.body.click();
  return false;
}

/** 从页面自己的隐藏 select 反解目标国家，消除 HeroSMS ID 与页面 ISO 映射错位隐患。 */
function resolveTargetFromPageOptions(target: CountryTarget): CountryTarget | null {
  const options = getCountrySelectOptions();
  if (options.length === 0) return target.isoCode ? target : null;

  if (target.isoCode) {
    const exact = options.find((option) => option.value.toUpperCase() === target.isoCode.toUpperCase());
    if (exact) return optionToCountryTarget(exact, target);
  }

  const wantedNames = target.names.map(normalizeCountryText).filter(Boolean);
  const matched = findBestCountryOption(options, wantedNames);
  if (!matched) {
    console.warn('[Content] 未能从页面国家列表反解目标国家:', {
      targetNames: target.names,
      pageOptions: options.slice(0, 20).map((option) => `${option.value}:${option.textContent?.trim()}`),
    });
  }
  return matched ? optionToCountryTarget(matched, target) : target;
}

function getCountrySelectOptions(): HTMLOptionElement[] {
  const options: HTMLOptionElement[] = [];
  for (const select of document.querySelectorAll('select')) {
    for (const option of Array.from(select.options)) {
      if (!option.value || !option.textContent?.trim()) continue;
      options.push(option);
    }
  }
  return options;
}

function optionToCountryTarget(option: HTMLOptionElement, source: CountryTarget): CountryTarget {
  const names = Array.from(new Set([
    option.textContent?.trim() || '',
    ...getIsoDisplayNames(option.value),
    ...source.names,
  ].filter(Boolean)));
  return {
    isoCode: option.value,
    dialCode: source.dialCode,
    names,
  };
}

function buildOptionNameCandidates(option: HTMLOptionElement): string[] {
  return [
    option.textContent || '',
    option.label || '',
    ...getIsoDisplayNames(option.value),
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
        if (score > (best?.score ?? 0)) {
          best = { option, score };
        }
      }
    }
  }

  return best?.option ?? null;
}

function getIsoDisplayNames(isoCode: string): string[] {
  if (!/^[A-Z]{2}$/i.test(isoCode)) return [];
  const upper = isoCode.toUpperCase();
  const names: string[] = [];
  for (const locale of ['en', 'zh-CN']) {
    try {
      const displayName = new Intl.DisplayNames([locale], { type: 'region' }).of(upper);
      if (displayName) names.push(displayName);
    } catch {
      // Intl.DisplayNames 在极少数环境不可用时，继续使用页面 option 文本。
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

  // 中文只允许完整片段匹配，例如“印度尼西亚 (+62)”可匹配“印度尼西亚”，但“印度尼西亚”不会匹配“印度”。
  if (hasCjk(left) || hasCjk(right)) {
    if (isDelimitedPhraseMatch(left, right)) return 60;
    if (isDelimitedPhraseMatch(right, left)) return 50;
    return 0;
  }

  if (isDelimitedPhraseMatch(left, right)) return 60;
  if (isDelimitedPhraseMatch(right, left)) return 50;
  return 0;
}

function hasCjk(value: string): boolean {
  return /[\u4e00-\u9fa5]/.test(value);
}

function isDelimitedPhraseMatch(haystack: string, needle: string): boolean {
  if (hasCjk(needle)) {
    return haystack.split(' ').includes(needle);
  }
  if (needle.length < 4 || needle.split(' ').length < 2) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^| )${escaped}( |$)`).test(haystack);
}

/** 模拟用户点击事件序列，React Aria 控件比原生 click 更依赖 pointer/mouse 事件。 */
function dispatchUserClick(element: HTMLElement): void {
  element.focus();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const) {
    const eventInit = { bubbles: true, cancelable: true, view: window };
    const event = type.startsWith('pointer') && typeof PointerEvent !== 'undefined'
      ? new PointerEvent(type, { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, eventInit);
    element.dispatchEvent(event);
  }
}

/** 优先尝试 React Aria 隐藏的原生 select，适配页面内 option[value="US"] 这类结构。 */
function selectNativeCountryOption(target: CountryTarget): boolean {
  if (!target.isoCode) return false;

  const selects = document.querySelectorAll('select');
  for (const select of selects) {
    const option = select.querySelector(`option[value="${target.isoCode}"]`);
    if (!option) continue;

    select.value = target.isoCode;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  return false;
}

/** 查找国家下拉触发器 */
function findCountryDropdownTrigger(): HTMLElement | null {
  const ariaSelectButton = document.querySelector(
    '.react-aria-Select button[aria-haspopup="listbox"], button[aria-haspopup="listbox"]',
  );
  if (ariaSelectButton) return ariaSelectButton as HTMLElement;

  const selectors = [
    '[aria-label*="country" i]',
    '[aria-label*="国家" i]',
    '[data-testid*="country" i]',
    'button[type="button"]',
  ];

  for (const sel of selectors) {
    const elements = document.querySelectorAll(sel);
    for (const el of elements) {
      const text = (el as HTMLElement).textContent?.toLowerCase() || '';
      // 国家触发器通常显示“美国 (+1)”或 “United States (+1)”。
      if (/\(\+\d+\)/.test(text) || text.includes('country') || text.includes('国家')) {
        return el as HTMLElement;
      }
    }
  }

  // 回退：表单区域内第一个可见的 role="combobox" 或看起来像下拉的元素
  const form = document.querySelector('form');
  if (form) {
    const combobox = form.querySelector('[role="combobox"], [role="listbox"]');
    if (combobox) return combobox as HTMLElement;
  }

  return null;
}

/** 在下拉列表中查找国家选项候选。 */
function findCountryOptions(target: CountryTarget): HTMLElement[] {
  const names = target.names.map(normalizeCountryText).filter(Boolean);
  const result: HTMLElement[] = [];

  const candidates = document.querySelectorAll(
    '[role="option"], li, div[class*="option"], div[class*="item"], button[class*="option"]',
  );

  for (const el of candidates) {
    const text = normalizeCountryText((el as HTMLElement).textContent || '');
    if (names.some((name) => namesMatch(text, name))) {
      result.push(el as HTMLElement);
    }
  }

  // 回退：全页面搜索含国家名的可点击元素。
  const all = document.querySelectorAll('div, li, span, button');
  for (const el of all) {
    const text = normalizeCountryText((el as HTMLElement).textContent || '');
    if (names.some((name) => namesMatch(text, name))) {
      const rect = el.getBoundingClientRect();
      // 只考虑可见的、在下拉区域内的元素
      if (rect.width > 0 && rect.height > 0 && rect.height < 60) {
        result.push(el as HTMLElement);
      }
    }
  }

  return Array.from(new Set(result));
}

/** 等待 React Aria Portal 渲染国家选项 */
async function waitForCountryOptions(target: CountryTarget, timeoutMs: number): Promise<HTMLElement[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const options = findCountryOptions(target);
    if (options.length > 0) return options;
    await new Promise((r) => setTimeout(r, 100));
  }
  return findCountryOptions(target);
}

/** 把内部文本节点提升到真正可点击的 React Aria option 容器。 */
function resolveClickableCountryOption(option: HTMLElement): HTMLElement {
  return (
    option.closest('[role="option"]') ||
    option.closest('[data-key]') ||
    option.closest('[data-rac]') ||
    option
  ) as HTMLElement;
}

/** 判断当前触发器是否已经选中目标国家 */
function isCountryAlreadySelected(trigger: HTMLElement, target: CountryTarget): boolean {
  const text = normalizeCountryText(trigger.textContent || '');
  const hasName = target.names
    .map(normalizeCountryText)
    .some((name) => namesMatch(text, name));
  if (!target.dialCode) return hasName;

  const rawText = trigger.textContent || '';
  const hasDialCode = rawText.includes(`+${target.dialCode}`) || rawText.includes(`(${target.dialCode})`);
  return hasName && hasDialCode;
}
