/**
 * 接码服务基类
 *
 * 完整复刻参考项目 any-auto-register 的 BaseSmsProvider 接口体系。
 * getNumber / getCode / cancel 为强制抽象方法，
 * reportSuccess / markCodeFailed / markSendFailed / markSendSucceeded 为可选语义增强。
 */
import { SmsActivation } from './types';

export abstract class BaseSmsProvider {
  /** 收到验证码后是否自动调用 reportSuccess（HeroSMS 为 false） */
  autoReportSuccessOnCode = true;

  /**
   * 租用手机号
   * @param service 服务代码（如 "dr" 表示 OpenAI）
   * @param country 国家代码（如 "187" 表示美国），可选，默认使用配置值
   */
  abstract getNumber(service: string, country?: string): Promise<SmsActivation>;

  /**
   * 获取短信验证码
   * @param activationId 激活 ID
   * @param timeout 超时秒数，默认 120
   */
  abstract getCode(activationId: string, timeout?: number): Promise<string>;

  /**
   * 取消/释放激活
   * @param activationId 激活 ID
   * @returns 是否取消成功
   */
  abstract cancel(activationId: string): Promise<boolean>;

  /**
   * 报告验证码使用成功（可选实现）
   * HeroSMS：增加 use_count，达到上限后 finishActivation
   */
  async reportSuccess(_activationId: string): Promise<boolean> {
    return true;
  }

  /**
   * 设置重发回调（可选 hook）
   * HeroSMS 用于在 getCode 等待超时后请求上游重发
   */
  setResendCallback(_callback: (() => void) | null): void {
    // 默认空实现
  }

  /**
   * 标记验证码失败（可选 hook）
   * 目标服务拒绝了收到的验证码时调用
   */
  markCodeFailed(_activationId: string, _reason?: string): void {
    // 默认空实现
  }

  /**
   * 标记发送失败（可选 hook）
   * 目标服务拒绝了租用的手机号时调用
   */
  markSendFailed(_activationId: string, _reason?: string): void {
    // 默认空实现
  }

  /**
   * 标记发送成功（可选 hook）
   * 目标服务接受了租用的手机号时调用
   */
  markSendSucceeded(_activationId: string): void {
    // 默认空实现
  }

  /**
   * 获取 Provider 特有的重用状态信息（可选 hook）
   * 用于任务调度判断是否可复用已有激活
   */
  async getReuseInfo(): Promise<Record<string, unknown>> {
    return {};
  }
}
