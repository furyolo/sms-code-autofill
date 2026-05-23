/**
 * OpenAI 注册页自动化能力
 *
 * 该模块只处理邮箱注册、邮箱验证码和资料页 DOM 操作。短信手机号流程继续由
 * page-automation.ts 负责，避免把两个阶段耦合在一起。
 */
import { fillReactInput, fillNativeInput } from './filler';

export type RegistrationPageKind =
  | 'home'
  | 'email'
  | 'email_otp'
  | 'about_you'
  | 'add_phone'
  | 'complete'
  | 'unknown';

export interface IdentityProfile {
  firstName: string;
  lastName: string;
  age: number;
}

export interface RegistrationAutomationResult {
  success: boolean;
  error?: string;
}

export interface SignupEntryState {
  state: 'entry_home' | 'email_entry' | 'phone_entry' | 'password_page' | 'unknown';
  signupTrigger: HTMLElement | null;
  switchToEmailTrigger: HTMLElement | null;
  switchToPhoneTrigger: HTMLElement | null;
  moreOptionsTrigger: HTMLElement | null;
  emailInput: HTMLInputElement | null;
  phoneInput: HTMLInputElement | null;
  passwordInput: HTMLInputElement | null;
  continueButton: HTMLElement | null;
  url: string;
}

const EMAIL_INPUT_SELECTORS = [
  'input[type="email"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[type="text"]',
];

const NAME_INPUT_SELECTORS = [
  'input[name*="first" i]',
  'input[id*="first" i]',
  'input[autocomplete="given-name"]',
  'input[name*="last" i]',
  'input[id*="last" i]',
  'input[autocomplete="family-name"]',
  'input[name*="name" i]',
  'input[id*="name" i]',
  'input[autocomplete="name"]',
  'input[type="text"]',
];

const AGE_INPUT_SELECTORS = [
  'input[name="age"]',
  'input[id*="age" i]',
  'input[name*="birthday" i]',
  'input[id*="birthday" i]',
  'input[type="number"]',
];

const SIGNUP_ENTRY_TRIGGER_PATTERN = /免费注册|立即注册|注册|無料でサインアップ|サインアップ|新規登録|登録する|登録|アカウントを作成|アカウント作成|sign\s*up|register|create\s*account|create\s+account/i;
const SIGNUP_SWITCH_TO_EMAIL_PATTERN = /继续使用(?:电子邮件地址|邮箱)登录|改用(?:电子邮件地址|邮箱)登录|continue\s+using\s+(?:an?\s+)?email(?:\s+address)?|continue\s+with\s+email|use\s+(?:an?\s+)?email(?:\s+address)?(?:\s+instead)?|sign\s*(?:in|up)\s+with\s+email/i;
const SIGNUP_SWITCH_TO_PHONE_PATTERN = /继续使用(?:手机|手机号|电话)(?:号码)?登录|改用(?:手机|手机号|电话)(?:号码)?登录|continue\s+(?:with|using)\s+(?:a\s+)?phone(?:\s+number)?|use\s+(?:a\s+)?phone(?:\s+number)?(?:\s+instead)?|sign\s*(?:in|up)\s+with\s+(?:a\s+)?phone/i;
const SIGNUP_MORE_OPTIONS_PATTERN = /更多(?:选项|登录方式|方式)|其他(?:登录方式|选项|方式)|显示更多|その他|他の(?:ログイン)?方法|別の(?:ログイン)?方法|もっと見る|オプション|more\s+(?:login\s+|sign[-\s]*in\s+)?options|other\s+(?:login\s+|sign[-\s]*in\s+)?(?:options|ways)|show\s+more/i;
const SIGNUP_CONTINUE_PATTERN = /continue|next|submit|继续|下一步|続行|続ける|次へ|送信/i;

/** 根据 URL 和可见输入框粗略识别当前注册阶段。 */
export function detectRegistrationPageKind(): RegistrationPageKind {
  const url = location.href;
  if (/\/add-phone\b/i.test(url)) return 'add_phone';
  if (/about-you|signup\/profile|create-account\/profile/i.test(url) || findProfileNameInput()) return 'about_you';
  if (/email-verification|email-otp/i.test(url) || findEmailOtpInput()) return 'email_otp';
  if (findEmailInput()) return 'email';
  if (/^https:\/\/chatgpt\.com\/?(\?.*)?$/i.test(url)) return 'home';
  if (/chatgpt\.com/i.test(url) && !/\/auth\//i.test(url)) return 'complete';
  return 'unknown';
}

/** 填入注册邮箱并提交。 */
export async function fillSignupEmailAndSubmit(email: string): Promise<RegistrationAutomationResult> {
  const input = findEmailInput();
  if (!input) return { success: false, error: 'EMAIL_INPUT_NOT_FOUND' };

  fillInput(input, email);
  await sleep(500);
  if (!clickFormSubmitForInput(input)) {
    return { success: false, error: 'EMAIL_SUBMIT_BUTTON_NOT_FOUND' };
  }
  return { success: true };
}

/** 在 ChatGPT 首页点击注册入口。 */
export async function clickChatGptSignupEntry(): Promise<RegistrationAutomationResult> {
  const candidate = findSignupEntry();
  if (!candidate) return { success: false, error: 'SIGNUP_ENTRY_NOT_FOUND' };
  dispatchUserClick(candidate);
  return { success: true };
}

export async function waitForSignupEntryState(options: { timeout?: number; autoOpenEntry?: boolean } = {}): Promise<SignupEntryState> {
  const timeout = options.timeout ?? 15000;
  const autoOpenEntry = options.autoOpenEntry ?? false;
  const start = Date.now();
  let clickedSignupEntry = false;
  let clickedSwitchToEmail = false;

  while (Date.now() - start < timeout) {
    const snapshot = inspectSignupEntryState();
    if (snapshot.state === 'email_entry' || snapshot.state === 'password_page') {
      return snapshot;
    }

    if (snapshot.state === 'phone_entry' && autoOpenEntry && snapshot.switchToEmailTrigger && !clickedSwitchToEmail) {
      clickedSwitchToEmail = true;
      dispatchUserClick(snapshot.switchToEmailTrigger);
      await sleep(800);
      continue;
    }

    if (snapshot.state === 'entry_home' && autoOpenEntry && snapshot.signupTrigger && !clickedSignupEntry) {
      clickedSignupEntry = true;
      dispatchUserClick(snapshot.signupTrigger);
      await sleep(1000);
      continue;
    }

    await sleep(250);
  }

  return inspectSignupEntryState();
}

/** 填入邮箱验证码并提交，兼容单输入框和 6 位分格输入框。 */
export async function fillEmailCodeAndSubmit(code: string): Promise<RegistrationAutomationResult> {
  const normalized = code.trim();
  if (!normalized) return { success: false, error: 'EMAIL_CODE_EMPTY' };

  let submitAnchor: HTMLInputElement | null = null;
  const splitInputs = await waitForSplitOtpInputs(normalized.length, 20000);
  if (splitInputs.length >= normalized.length) {
    splitInputs.slice(0, normalized.length).forEach((input, index) => fillInput(input, normalized[index]));
    submitAnchor = splitInputs[0] ?? null;
  } else {
    const input = await waitForEmailOtpInput(20000);
    if (!input) return { success: false, error: 'EMAIL_CODE_INPUT_NOT_FOUND' };
    fillInput(input, normalized);
    submitAnchor = input;
  }

  await sleep(500);
  if (!submitAnchor || !clickFormSubmitForInput(submitAnchor)) {
    return { success: false, error: 'EMAIL_CODE_SUBMIT_BUTTON_NOT_FOUND' };
  }
  return { success: true };
}

/** 填入姓名与年龄并提交 about-you 页面。 */
export async function fillProfileAndSubmit(profile: IdentityProfile): Promise<RegistrationAutomationResult> {
  const nameInput = await waitForProfileNameInput(12000);
  if (!nameInput) return { success: false, error: 'PROFILE_NAME_INPUT_NOT_FOUND' };
  fillProfileName(profile);

  if (!fillBirthdayDateField(profile.age)) {
    const ageInput = findAgeInput();
    if (ageInput) {
    const value = ageInput.name.toLowerCase().includes('birthday')
      ? birthdayFromAge(profile.age)
      : String(profile.age);
      fillInput(ageInput, value);
    }
  }

  tickVisibleCheckboxes();
  await sleep(500);
  if (!clickFormSubmitForInput(nameInput)) {
    return { success: false, error: 'PROFILE_SUBMIT_BUTTON_NOT_FOUND' };
  }
  return { success: true };
}

export function waitForRegistrationPageChange(
  previous: RegistrationPageKind,
  timeoutMs: number = 20000,
): Promise<RegistrationPageKind> {
  return new Promise((resolve) => {
    const existing = detectRegistrationPageKind();
    if (existing !== previous && existing !== 'unknown') {
      resolve(existing);
      return;
    }

    let settled = false;
    const finish = (kind: RegistrationPageKind) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timeoutId);
      resolve(kind);
    };

    const observer = new MutationObserver(() => {
      const kind = detectRegistrationPageKind();
      if (kind !== previous && kind !== 'unknown') finish(kind);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const timeoutId = setTimeout(() => finish(detectRegistrationPageKind()), timeoutMs);
  });
}

function findEmailInput(): HTMLInputElement | null {
  return findVisibleInput(EMAIL_INPUT_SELECTORS, (input) => {
    const text = inputDescriptor(input);
    return input.type === 'email' || /email|mail|邮箱|郵箱/i.test(text);
  });
}

function findEmailOtpInput(): HTMLInputElement | null {
  if (/about-you|signup\/profile|create-account\/profile/i.test(location.href)) return null;
  return findVisibleInput(
    [
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
      'input[name*="code" i]',
      'input[id*="code" i]',
      'input[aria-label*="code" i]',
      'input[type="text"]',
      'input[type="number"]',
      'input[type="tel"]',
    ],
    (input) => {
      if (input.type === 'email' || input.type === 'password') return false;
      const descriptor = inputDescriptor(input);
      if (/age|birthday|birth|年龄|生日|name|姓名|全名/i.test(descriptor)) return false;
      return true;
    },
  );
}

async function waitForEmailOtpInput(timeoutMs: number): Promise<HTMLInputElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const input = findEmailOtpInput();
    if (input) return input;
    await sleep(250);
  }
  return findEmailOtpInput();
}

function findSplitOtpInputs(length: number): HTMLInputElement[] {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"], input[autocomplete="one-time-code"], input[type="tel"], input[type="number"]'),
  ).filter(isVisibleInput);
  return inputs.length >= length ? inputs : [];
}

async function waitForSplitOtpInputs(length: number, timeoutMs: number): Promise<HTMLInputElement[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inputs = findSplitOtpInputs(length);
    if (inputs.length >= length) return inputs;
    if (findEmailOtpInput()) return [];
    await sleep(250);
  }
  return findSplitOtpInputs(length);
}

function findProfileNameInput(): HTMLInputElement | null {
  return findVisibleInput(NAME_INPUT_SELECTORS, (input) => {
    if (input.type === 'email' || input.type === 'password' || input.type === 'tel') return false;
    return /name|full.?name|first|given|last|family|姓名|名字|名|姓/i.test(inputDescriptor(input));
  });
}

async function waitForProfileNameInput(timeoutMs: number): Promise<HTMLInputElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const input = findProfileNameInput();
    if (input) return input;
    await sleep(250);
  }
  return findProfileNameInput();
}

function fillProfileName(profile: IdentityProfile): void {
  const firstNameInput = findVisibleInput(
    ['input[name*="first" i]', 'input[id*="first" i]', 'input[autocomplete="given-name"]'],
    (input) => input.type !== 'email' && input.type !== 'password',
  );
  const lastNameInput = findVisibleInput(
    ['input[name*="last" i]', 'input[id*="last" i]', 'input[autocomplete="family-name"]'],
    (input) => input.type !== 'email' && input.type !== 'password',
  );
  if (firstNameInput && lastNameInput) {
    fillInput(firstNameInput, profile.firstName);
    fillInput(lastNameInput, profile.lastName);
    return;
  }

  const fullNameInput = findProfileNameInput();
  if (fullNameInput) fillInput(fullNameInput, `${profile.firstName} ${profile.lastName}`);
}

function findSignupEntry(): HTMLElement | null {
  const selectors = ['a', 'button', '[role="link"]', '[role="button"]'];

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const match = elements.find((element) => {
      if (!isVisibleInputLike(element)) return false;
      const text = visibleElementText(element);
      return SIGNUP_ENTRY_TRIGGER_PATTERN.test(text);
    });
    if (match) return match;
  }

  const links = Array.from(document.querySelectorAll<HTMLElement>('a[href]'));
  const hrefMatch = links.find((element) => {
    const href = element.getAttribute('href') || '';
    return /signup|register|create-account|auth/i.test(href);
  });
  return hrefMatch ?? null;
}

function findAgeInput(): HTMLInputElement | null {
  return findVisibleInput(AGE_INPUT_SELECTORS, (input) => {
    if (input.type === 'email' || input.type === 'password' || input.type === 'tel') return false;
    return /age|birthday|birth|年龄|生日/i.test(inputDescriptor(input));
  });
}

function fillBirthdayDateField(age: number): boolean {
  const birthday = birthdayPartsFromAge(age);
  const yearSegment = findDateSegment('year');
  const monthSegment = findDateSegment('month');
  const daySegment = findDateSegment('day');
  if (!yearSegment || !monthSegment || !daySegment) return false;

  fillEditableSegment(yearSegment, birthday.year);
  fillEditableSegment(monthSegment, birthday.month);
  fillEditableSegment(daySegment, birthday.day);

  const hiddenBirthday = document.querySelector<HTMLInputElement>('input[name="birthday"]');
  if (hiddenBirthday) fillInput(hiddenBirthday, `${birthday.year}-${birthday.month}-${birthday.day}`);
  return true;
}

function findDateSegment(type: 'year' | 'month' | 'day'): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[role="spinbutton"][contenteditable="true"][data-type="${type}"]`,
  );
}

function fillEditableSegment(element: HTMLElement, value: string): void {
  element.focus();
  document.getSelection()?.selectAllChildren(element);
  element.textContent = value;
  element.setAttribute('aria-valuetext', value);
  element.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data: value,
    inputType: 'insertText',
  }));
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    data: value,
    inputType: 'insertText',
  }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.blur();
}

function findSignupUseEmailTrigger(): HTMLElement | null {
  return findActionTrigger(SIGNUP_SWITCH_TO_EMAIL_PATTERN, /email|邮箱|電子メール|メール/i);
}

function findSignupUsePhoneTrigger(): HTMLElement | null {
  return findActionTrigger(SIGNUP_SWITCH_TO_PHONE_PATTERN, /phone|手机|電話|携帯/i);
}

function findSignupMoreOptionsTrigger(): HTMLElement | null {
  return findActionTrigger(SIGNUP_MORE_OPTIONS_PATTERN, null, (element) => {
    const expanded = String(element.getAttribute('aria-expanded') || '').trim().toLowerCase();
    const state = String(element.getAttribute('data-state') || '').trim().toLowerCase();
    return expanded !== 'true' && state !== 'open';
  });
}

function getSignupEmailContinueButton({ allowDisabled = false } = {}): HTMLElement | null {
  const direct = document.querySelector('button[type="submit"], input[type="submit"]') as HTMLElement | null;
  if (direct && isVisibleInputLike(direct) && (allowDisabled || isActionEnabledLike(direct))) {
    return direct;
  }
  return findActionTrigger(SIGNUP_CONTINUE_PATTERN, null, allowDisabled ? undefined : (element) => isActionEnabledLike(element));
}

function clickFormSubmitForInput(input: HTMLInputElement): boolean {
  const form = input.closest('form');
  if (form) {
    const submit = Array.from(form.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"]'))
      .find((element) => isVisibleInputLike(element) && isActionEnabledLike(element));
    if (submit) {
      dispatchUserClick(submit);
      return true;
    }
  }

  const continueButton = getSignupEmailContinueButton();
  if (continueButton && !isThirdPartyAuthButton(continueButton)) {
    dispatchUserClick(continueButton);
    return true;
  }
  return false;
}

function inspectSignupEntryState(): SignupEntryState {
  const emailInput = findSignupEmailInput();
  const phoneInput = findSignupPhoneInput();
  const passwordInput = findSignupPasswordInput();
  const switchToEmailTrigger = findSignupUseEmailTrigger();
  const switchToPhoneTrigger = findSignupUsePhoneTrigger();
  const moreOptionsTrigger = findSignupMoreOptionsTrigger();
  const signupTrigger = findSignupEntry();
  const continueButton = getSignupEmailContinueButton({ allowDisabled: true });

  let state: SignupEntryState['state'] = 'unknown';
  if (emailInput) {
    state = 'email_entry';
  } else if (phoneInput) {
    state = 'phone_entry';
  } else if (passwordInput) {
    state = 'password_page';
  } else if (signupTrigger || switchToEmailTrigger || switchToPhoneTrigger || moreOptionsTrigger) {
    state = 'entry_home';
  }

  return {
    state,
    signupTrigger,
    switchToEmailTrigger,
    switchToPhoneTrigger,
    moreOptionsTrigger,
    emailInput,
    phoneInput,
    passwordInput,
    continueButton,
    url: location.href,
  };
}

function findVisibleInput(
  selectors: string[],
  validate: (input: HTMLInputElement) => boolean = () => true,
): HTMLInputElement | null {
  for (const selector of selectors) {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(selector));
    const match = inputs.find((input) => isVisibleInput(input) && validate(input));
    if (match) return match;
  }
  return null;
}

function findSignupEmailInput(): HTMLInputElement | null {
  return findVisibleInput(EMAIL_INPUT_SELECTORS, (input) => {
    const text = inputDescriptor(input);
    return input.type === 'email' || /email|mail|邮箱|郵箱/i.test(text);
  });
}

function findSignupPhoneInput(): HTMLInputElement | null {
  return findVisibleInput(
    [
      'input[type="tel"]:not([maxlength="6"])',
      'input[name*="phone" i]',
      'input[id*="phone" i]',
      'input[autocomplete="tel"]',
      'input[placeholder*="phone" i]',
      'input[placeholder*="手机"]',
      'input[placeholder*="電話"]',
      'input[placeholder*="携帯"]',
      'input[aria-label*="phone" i]',
      'input[aria-label*="手机"]',
      'input[aria-label*="電話"]',
      'input[aria-label*="携帯"]',
    ],
    (input) => input.type === 'tel' || /phone|tel|手机|电话|電話|携帯/i.test(inputDescriptor(input)),
  );
}

function findSignupPasswordInput(): HTMLInputElement | null {
  return findVisibleInput(
    [
      'input[type="password"]',
      'input[autocomplete="current-password"]',
      'input[autocomplete="new-password"]',
      'input[name*="password" i]',
      'input[id*="password" i]',
    ],
    (input) => input.type === 'password' || /password|密码|パスワード/i.test(inputDescriptor(input)),
  );
}

function findActionTrigger(
  textPattern: RegExp,
  extraPattern: RegExp | null = null,
  additionalFilter?: (element: HTMLElement) => boolean,
): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('a, button, [role="button"], [role="link"], input[type="button"], input[type="submit"]');
  return Array.from(candidates).find((element) => {
    if (!isVisibleInputLike(element)) return false;
    if (!isActionEnabledLike(element)) return false;
    if (additionalFilter && !additionalFilter(element)) return false;
    const text = visibleElementText(element);
    if (!textPattern.test(text)) return false;
    if (extraPattern && !extraPattern.test(text)) return false;
    return true;
  }) || null;
}

function fillInput(input: HTMLInputElement, value: string): void {
  if (Object.keys(input).some((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'))) {
    fillReactInput(input, value);
    return;
  }
  fillNativeInput(input, value);
}

function isVisibleInput(input: HTMLInputElement): boolean {
  return input.offsetParent !== null && !input.disabled && input.type !== 'hidden';
}

function isVisibleInputLike(element: HTMLElement): boolean {
  return element.offsetParent !== null || element.getClientRects().length > 0;
}

function isActionEnabledLike(element: HTMLElement): boolean {
  return (!('disabled' in element) || !(element as HTMLButtonElement).disabled)
    && element.getAttribute('aria-disabled') !== 'true';
}

function isThirdPartyAuthButton(element: HTMLElement): boolean {
  return /google|apple|microsoft|github|sso|谷歌|账户|账号/i.test(visibleElementText(element));
}

function inputDescriptor(input: HTMLInputElement): string {
  return [
    input.name,
    input.id,
    input.placeholder,
    input.autocomplete,
    input.getAttribute('aria-label'),
    input.getAttribute('title'),
    input.closest('label')?.textContent,
  ].join(' ');
}

function visibleElementText(element: HTMLElement): string {
  return [
    element.textContent,
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('data-testid'),
    element.getAttribute('href'),
  ].join(' ');
}

function tickVisibleCheckboxes(): void {
  for (const checkbox of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (!isVisibleInput(checkbox) || checkbox.checked) continue;
    dispatchUserClick(checkbox);
  }
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

function birthdayFromAge(age: number): string {
  const birthday = birthdayPartsFromAge(age);
  return `${birthday.year}-${birthday.month}-${birthday.day}`;
}

function birthdayPartsFromAge(age: number): { year: string; month: string; day: string } {
  const currentYear = new Date().getFullYear();
  const month = randomInt(1, 12);
  const day = randomInt(1, daysInMonth(currentYear - age, month));
  return {
    year: String(currentYear - age),
    month: String(month).padStart(2, '0'),
    day: String(day).padStart(2, '0'),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
