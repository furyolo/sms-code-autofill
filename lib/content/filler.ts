/**
 * 表单填入函数
 *
 * React 受控组件填入方案：
 *   1. Native setter — 通过 Object.getOwnPropertyDescriptor 获取原生 value setter，
 *      绕过 React 对 input.value 的劫持
 *   2. Event dispatch — 触发 input/change/blur 事件序列，让 React 合成事件系统
 *      捕获变更并更新内部 state
 *   3. React fiber — 检测 __reactFiber$ 前缀 key 以确认 React 上下文；
 *      若前缀不存在自动降级到 fillNativeInput
 *
 * 所有 fiber 访问包裹在 try-catch 中，任何异常自动降级不阻断流程。
 */

import {
  type SelectorStrategy,
  PHONE_SELECTOR_STRATEGIES,
  CODE_SELECTOR_STRATEGIES,
  findElementByStrategy,
} from './selectors';

interface SelectorCacheEntry {
  phoneStrategy?: string;
  codeStrategy?: string;
}

/** Content Script 无法默认访问 chrome.storage.session，选择器缓存仅保留在当前页面会话内。 */
const selectorCache: SelectorCacheEntry = {};

// ---------------------------------------------------------------------------
// React 合成事件注入
// ---------------------------------------------------------------------------

/**
 * 通过 React fiber + native setter + event dispatch 填入输入框
 * 若 React fiber key 不存在则自动降级到 fillNativeInput
 */
export function fillReactInput(
  element: HTMLInputElement,
  value: string,
): void {
  try {
    // 检测 React fiber 内部引用（React 16-18 稳定前缀）
    const reactKey = Object.keys(element).find(
      (k) =>
        k.startsWith('__reactFiber$') ||
        k.startsWith('__reactInternalInstance$'),
    );

    // 获取原生 value setter，绕过 React 对 value 属性的劫持
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;

    if (!nativeSetter) {
      // 极度边缘情况：setter 不可用，降级到直接赋值
      element.value = value;
    } else {
      nativeSetter.call(element, value);
    }

    // 触发 React 合成事件序列，模拟真实用户输入
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

    // fiber 存在但无额外操作——native setter + event dispatch 已足够
    // 保留 reactKey 检测用于日志和未来扩展
    if (reactKey) {
      console.debug('[Content] React fiber 检测成功，已注入合成事件');
    }
  } catch {
    // 任何异常降级到原生填入，不阻断流程
    console.warn('[Content] fillReactInput 异常，降级到 fillNativeInput');
    fillNativeInput(element, value);
  }
}

/**
 * 原生 DOM 填入（降级方案，无需 React fiber）
 */
export function fillNativeInput(
  element: HTMLInputElement,
  value: string,
): void {
  element.focus();

  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(element, value);
  } else {
    element.value = value;
  }

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.blur();
}

// ---------------------------------------------------------------------------
// 选择器缓存
// ---------------------------------------------------------------------------

/** 从当前 Content Script 内存读取选择器缓存 */
function getCachedStrategy(
  kind: 'phoneStrategy' | 'codeStrategy',
  strategies: SelectorStrategy[],
): SelectorStrategy | null {
  const cachedName = selectorCache[kind];
  if (!cachedName) return null;

  const strategy = strategies.find((s) => s.name === cachedName);
  if (!strategy) return null;

  // 验证缓存策略仍有效
  const el = findElementByStrategy(strategy);
  if (el) return strategy;

  return null; // 缓存失效
}

/** 将成功匹配的策略名写入当前 Content Script 内存 */
function cacheStrategy(
  kind: 'phoneStrategy' | 'codeStrategy',
  name: string,
): void {
  selectorCache[kind] = name;
}

// ---------------------------------------------------------------------------
// 元素查找（含缓存回退逻辑）
// ---------------------------------------------------------------------------

/**
 * 查找手机号输入框
 * 优先使用缓存策略 → 缓存失效则按三层回退链依序探测 → 缓存成功策略
 */
export async function getPhoneInput(): Promise<{
  element: HTMLInputElement;
  strategy: SelectorStrategy;
} | null> {
  // 1. 尝试缓存策略
  const cached = getCachedStrategy(
    'phoneStrategy',
    PHONE_SELECTOR_STRATEGIES,
  );
  if (cached) {
    const el = findElementByStrategy(cached);
    if (el) return { element: el, strategy: cached };
  }

  // 2. 重新探测全链
  for (const strategy of PHONE_SELECTOR_STRATEGIES) {
    const el = findElementByStrategy(strategy);
    if (el) {
      cacheStrategy('phoneStrategy', strategy.name);
      return { element: el, strategy };
    }
  }

  return null;
}

/**
 * 查找验证码输入框
 * 优先使用缓存策略 → 缓存失效则按三层回退链依序探测 → 缓存成功策略
 */
export async function getCodeInput(): Promise<{
  element: HTMLInputElement;
  strategy: SelectorStrategy;
} | null> {
  // 1. 尝试缓存策略
  const cached = getCachedStrategy(
    'codeStrategy',
    CODE_SELECTOR_STRATEGIES,
  );
  if (cached) {
    const el = findElementByStrategy(cached);
    if (el) return { element: el, strategy: cached };
  }

  // 2. 重新探测全链
  for (const strategy of CODE_SELECTOR_STRATEGIES) {
    const el = findElementByStrategy(strategy);
    if (el) {
      cacheStrategy('codeStrategy', strategy.name);
      return { element: el, strategy };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 填入入口（供 content.ts 调用）
// ---------------------------------------------------------------------------

/**
 * 填入手机号
 * @returns 填入成功返回 true，选择器全部失效返回 false
 */
export async function fillPhoneInput(phoneNumber: string): Promise<boolean> {
  if (!phoneNumber) {
    console.warn('[Content] fillPhoneInput: phoneNumber 为空');
    return false;
  }

  const result = await getPhoneInput();
  if (!result) {
    console.warn('[Content] 未找到手机号输入框（所有策略均失效）');
    return false;
  }

  const { element, strategy } = result;
  console.log(
    `[Content] 手机号输入框: <${element.tagName.toLowerCase()}> 策略=${strategy.name} fillMethod=${strategy.fillMethod}`,
  );

  if (strategy.fillMethod === 'react') {
    fillReactInput(element, phoneNumber);
  } else {
    fillNativeInput(element, phoneNumber);
  }

  return true;
}

/**
 * 填入验证码
 * @returns 填入成功返回 true，选择器全部失效返回 false
 */
export async function fillCodeInput(code: string): Promise<boolean> {
  if (!code) {
    console.warn('[Content] fillCodeInput: code 为空');
    return false;
  }

  const result = await getCodeInput();
  if (!result) {
    console.warn('[Content] 未找到验证码输入框（所有策略均失效）');
    return false;
  }

  const { element, strategy } = result;
  console.log(
    `[Content] 验证码输入框: <${element.tagName.toLowerCase()}> 策略=${strategy.name} fillMethod=${strategy.fillMethod}`,
  );

  if (strategy.fillMethod === 'react') {
    fillReactInput(element, code);
  } else {
    fillNativeInput(element, code);
  }

  return true;
}
