/**
 * 通知生成与生命周期管理
 *
 * 差异化通知模板：Bucket 暂停 vs 断路器暂停 vs 停止摘要 vs 静默过渡。
 * 成本估算基于用户配置的单价（默认 ¥0.05/次），保守按 70% 退款比例计算。
 */
import type { RetryState } from './types';

// ---------------------------------------------------------------------------
// 通知模板
// ---------------------------------------------------------------------------

/** chrome.notifications.create 所需参数的最小接口 */
export interface NotificationTemplate {
  type: chrome.notifications.TemplateType;
  iconUrl: string;
  title: string;
  message: string;
  buttons: chrome.notifications.ButtonOptions[];
  requireInteraction: boolean;
  silent?: boolean;
}

// ---------------------------------------------------------------------------
// 成本估算
// ---------------------------------------------------------------------------

/** 退款比例：取消激活通常退款 70-100%，保守按 70% 计 */
const REFUND_RATE = 0.7;

/**
 * 计算成本估算文本
 * @param state 当前状态
 * @param remainingAttempts 本轮剩余尝试次数
 */
function buildCostEstimate(state: RetryState, remainingAttempts: number): string {
  const price = state.costPerAttempt || 0.05;
  const hasPrice = state.costPerAttempt !== undefined && state.costPerAttempt > 0;
  const spent = state.totalAttempts * price * (1 - REFUND_RATE);
  const remaining = remainingAttempts * price;
  const total = spent + remaining;
  const marker = hasPrice ? '' : '（估算）';

  return `本轮预计消耗约 ¥${total.toFixed(2)}${marker}。继续将获取新号码并再消耗约 ¥${remaining.toFixed(2)}${marker}（${remainingAttempts} 次）。`;
}

// ---------------------------------------------------------------------------
// 通知构建函数
// ---------------------------------------------------------------------------

/**
 * Bucket 暂停通知
 * 标题: [暂停] 第 N 轮 / 共 M 轮
 */
export function buildBucketPauseNotification(state: RetryState): NotificationTemplate {
  const remainingInBucket = state.bucketSize - state.attemptInBucket;
  return {
    type: 'basic',
    iconUrl: '/icon/128.png',
    title: `[暂停] 第 ${state.currentBucket} 轮 / 共 ${state.maxBuckets} 轮`,
    message: `已尝试 ${state.totalAttempts} 次。本轮 ${state.bucketSize} 次号码均被拒绝。\n${buildCostEstimate(state, remainingInBucket)}`,
    buttons: [
      { title: `继续（再试 ${state.bucketSize} 次）` },
      { title: '停止' },
    ],
    requireInteraction: true,
  };
}

/**
 * 断路器暂停通知
 * 标题: [提前暂停] 检测到异常模式
 */
export function buildCircuitBreakerPauseNotification(
  state: RetryState,
  triggerReason: string,
): NotificationTemplate {
  const remainingInBucket = state.bucketSize - state.attemptInBucket;
  return {
    type: 'basic',
    iconUrl: '/icon/128.png',
    title: '[提前暂停] 检测到异常模式',
    message: `${triggerReason}。继续使用当前国家可能成功率较低。\n${buildCostEstimate(state, remainingInBucket)}`,
    buttons: [
      { title: '继续（忽略此模式）' },
      { title: '停止' },
    ],
    requireInteraction: true,
  };
}

/**
 * 停止摘要通知
 */
export function buildStopSummaryNotification(totalAttempts: number): NotificationTemplate {
  return {
    type: 'basic',
    iconUrl: '/icon/128.png',
    title: '已停止',
    message: `共尝试 ${totalAttempts} 次。`,
    buttons: [],
    requireInteraction: false,
  };
}

/**
 * 成功通知
 */
export function buildSuccessNotification(attempts: number): NotificationTemplate {
  return {
    type: 'basic',
    iconUrl: '/icon/128.png',
    title: '验证码已填入',
    message: `共尝试 ${attempts} 次，验证码已自动填入。`,
    buttons: [],
    requireInteraction: false,
  };
}

/**
 * 静默 Bucket 过渡通知（仅断路器模式）
 * requireInteraction: false，约 3 秒后自动消失
 */
export function buildSilentBucketTransitionNotification(bucketNum: number): NotificationTemplate {
  return {
    type: 'basic',
    iconUrl: '/icon/128.png',
    title: `第 ${bucketNum} 轮完成`,
    message: `第 ${bucketNum} 轮完成，自动继续下一轮...`,
    buttons: [],
    requireInteraction: false,
    silent: true,
  };
}

/**
 * maxRetriesExhausted 通知
 */
export function buildMaxRetriesExhaustedNotification(totalAttempts: number): NotificationTemplate {
  return {
    type: 'basic',
    iconUrl: '/icon/128.png',
    title: '已达到最大尝试次数',
    message: `共尝试 ${totalAttempts} 次，所有轮次已耗尽。请检查网络或更换国家后重试。`,
    buttons: [],
    requireInteraction: false,
  };
}

// ---------------------------------------------------------------------------
// 通知生命周期
// ---------------------------------------------------------------------------

/**
 * 创建通知
 * @returns notificationId
 */
export async function createNotification(template: NotificationTemplate): Promise<string> {
  return new Promise<string>((resolve) => {
    const options: chrome.notifications.NotificationOptions<true> = {
      type: template.type,
      iconUrl: template.iconUrl,
      title: template.title,
      message: template.message,
      buttons: template.buttons.length > 0 ? template.buttons : undefined,
      requireInteraction: template.requireInteraction,
      silent: template.silent,
    };
    chrome.notifications.create('', options, (id) => {
      resolve(id);
    });
  });
}

/**
 * 关闭通知
 */
export async function dismissNotification(notificationId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    chrome.notifications.clear(notificationId, () => {
      resolve();
    });
  });
}
