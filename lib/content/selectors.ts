/**
 * 选择器策略定义
 *
 * 三层回退链从精确到宽泛逐级降级：
 *   策略 1（data-attr）→ 策略 2（type-attr）→ 策略 3（fuzzy）
 * 每层向后兼容前一层的匹配集——若策略 1 失效，策略 2 仍有高概率命中同一目标。
 */

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

/** 单个选择器策略 */
export interface SelectorStrategy {
  /** 策略标识名，用于缓存 key */
  name: string;
  /** CSS 选择器字符串 */
  selector: string;
  /** 填入方式 */
  fillMethod: 'react' | 'native';
  /** type-attr 策略匹配多个时取第一个 */
  fallbackToFirst?: boolean;
  /** fuzzy 策略的额外校验函数（返回 false 则跳过该元素） */
  validation?: (el: Element) => boolean;
}

// ---------------------------------------------------------------------------
// 手机号选择器链
// ---------------------------------------------------------------------------

export const PHONE_SELECTOR_STRATEGIES: SelectorStrategy[] = [
  // 策略 1: 最精确 — data-testid + type 属性
  {
    name: 'data-attr',
    selector: 'input[type="tel"][data-testid="phone-number-input"]',
    fillMethod: 'react',
  },
  // 策略 2: 通用 — 标准 HTML 属性组合
  {
    name: 'type-attr',
    selector: 'input[type="tel"], input[autocomplete="tel"]',
    fallbackToFirst: true,
    fillMethod: 'react',
  },
  // 策略 3: 最宽泛 — name/id/placeholder 模糊匹配
  {
    name: 'fuzzy',
    selector:
      'input[name*="phone"], input[id*="phone"], input[placeholder*="phone"]',
    fillMethod: 'native',
  },
];

// ---------------------------------------------------------------------------
// 验证码选择器链
// ---------------------------------------------------------------------------

export const CODE_SELECTOR_STRATEGIES: SelectorStrategy[] = [
  // 策略 1: 精确 — data-testid + aria-label
  {
    name: 'data-attr',
    selector:
      'input[data-testid="verification-code-input"], input[aria-label*="verification"]',
    fillMethod: 'react',
  },
  // 策略 2: 模糊 — name/id/placeholder 包含 "code"，或 autocomplete="one-time-code"
  {
    name: 'fuzzy',
    selector:
      'input[name*="code"], input[id*="code"], input[placeholder*="code"], input[autocomplete="one-time-code"]',
    fillMethod: 'react',
  },
  // 策略 3: 兜底 — 非 tel/hidden/submit 的短输入框（maxLength 6-8）
  {
    name: 'any-short-input',
    selector:
      'input:not([type="tel"]):not([type="hidden"]):not([type="submit"])',
    validation: (el: Element) => {
      const maxLen = (el as HTMLInputElement).maxLength;
      return maxLen >= 6 && maxLen <= 8;
    },
    fillMethod: 'native',
  },
];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 使用给定策略查找首个匹配元素
 * fallbackToFirst 为 true 时若匹配多个元素则取第一个；validation 返回 false 则跳过当前元素
 */
export function findElementByStrategy(
  strategy: SelectorStrategy,
): HTMLInputElement | null {
  const elements = document.querySelectorAll(strategy.selector);

  if (elements.length === 0) return null;

  // fallbackToFirst：多匹配时取首个
  if (strategy.fallbackToFirst) {
    return elements[0] as HTMLInputElement;
  }

  // 遍历匹配元素，通过 validation 筛选
  for (const el of elements) {
    if (strategy.validation && !strategy.validation(el)) continue;
    return el as HTMLInputElement;
  }

  return null;
}
