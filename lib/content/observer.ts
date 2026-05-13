/**
 * MutationObserver 辅助：验证码输入框检测 + 提交按钮点击
 *
 * 填入手机号后，OpenAI 页面可能：
 *   1. 自动路由切换到验证码输入步骤（React SPA）→ MutationObserver 检测到 code input
 *   2. 需要手动点击提交按钮 → 检测失败后自动查找并点击
 *
 * 3 秒等待窗口基于 OpenAI 典型响应延迟（1-2s）+ 1s 缓冲。
 */

import {
  type SelectorStrategy,
  CODE_SELECTOR_STRATEGIES,
  findElementByStrategy,
} from './selectors';
import { getCodeInput } from './filler';

// ---------------------------------------------------------------------------
// MutationObserver：检测验证码输入框出现
// ---------------------------------------------------------------------------

/**
 * 使用 MutationObserver 等待验证码输入框出现
 * @param timeoutMs 超时时间（毫秒），默认 3000
 * @returns 验证码输入框元素，超时返回 null
 */
export function waitForCodeInput(
  timeoutMs: number = 3000,
): Promise<HTMLInputElement | null> {
  return new Promise((resolve) => {
    // 先同步检查一次：可能元素已经存在
    const existing = tryFindCodeInput();
    if (existing) {
      resolve(existing);
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout>;
    let resolved = false;

    const observer = new MutationObserver(() => {
      if (resolved) return;
      const el = tryFindCodeInput();
      if (el) {
        resolved = true;
        observer.disconnect();
        clearTimeout(timeoutId);
        resolve(el);
      }
    });

    // 监测整个 document.body 的子树变化
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // 超时兜底
    timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

/** 尝试通过所有选择器策略查找验证码输入框（同步） */
function tryFindCodeInput(): HTMLInputElement | null {
  for (const strategy of CODE_SELECTOR_STRATEGIES) {
    const el = findElementByStrategy(strategy);
    if (el) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 提交按钮查找与点击
// ---------------------------------------------------------------------------

/**
 * 查找并点击提交按钮
 * 三层策略：
 *   1. 文本匹配 "Continue" / "继续" / "Submit" / "Send code" / "Next"
 *   2. type="submit" 的 button
 *   3. 最后一个可见 button
 * @returns 是否找到并点击了按钮
 */
export function findAndClickSubmitButton(): boolean {
  // 策略 1: 文本匹配
  const texts = ['Continue', '继续', 'Submit', 'Send code', 'Next'];
  for (const text of texts) {
    const btn = findButtonByText(text);
    if (btn) {
      clickButton(btn);
      return true;
    }
  }

  // 策略 2: type="submit"
  const submitBtn = document.querySelector(
    'button[type="submit"]',
  ) as HTMLButtonElement | null;
  if (submitBtn) {
    clickButton(submitBtn);
    return true;
  }

  // 策略 3: 最后一个可见 button
  const buttons = Array.from(document.querySelectorAll('button')).filter(
    (b) => (b as HTMLElement).offsetParent !== null,
  );
  if (buttons.length > 0) {
    clickButton(buttons[buttons.length - 1] as HTMLButtonElement);
    return true;
  }

  console.warn('[Content] 未找到提交按钮');
  return false;
}

/** 通过按钮文本查找（大小写不敏感） */
function findButtonByText(
  text: string,
): HTMLButtonElement | null {
  const lower = text.toLowerCase();
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    if (btn.textContent?.toLowerCase().includes(lower)) {
      return btn as HTMLButtonElement;
    }
  }
  return null;
}

/** 安全点击按钮 */
function clickButton(btn: HTMLButtonElement): void {
  console.log(
    `[Content] 点击提交按钮: "${btn.textContent?.trim().slice(0, 30)}"`,
  );
  btn.click();
}
